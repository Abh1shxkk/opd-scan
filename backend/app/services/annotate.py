"""Burn overlays onto a copy of a page render.

Three hard rules, because a mislabelled scan in a case file is a clinical hazard:

1. **The input array is never mutated.** The caller usually holds the only decoded copy of the
   original render; we draw on a copy and hand the copy back.
2. **An annotated page is never confusable with the original.** Every annotated image carries a
   burnt-in "ANNOTATED — not the original scan" caption and a coloured frame. Annotated bytes are
   also stored and served under their own paths (``annotated/`` in exports) and are never written
   back over ``storage_key_render``.
3. **Labels stay readable on any page.** Scanned paper ranges from blown-out white to almost black,
   so every label is drawn on a filled chip in its layer colour with the text colour chosen from
   that chip's luminance — never as bare text over the scan.

Coordinates are in ORIGINAL render pixels, exactly as stored (``{x,y,w,h}`` for regions,
``[[x,y], ...]`` for polygons), so overlays land where the viewer's own scaled boxes land.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping, Sequence

import cv2
import numpy as np

from app.processing.ingest import encode_png

# ------------------------------------------------------------------ constants

#: Layer names accepted in ``show``. Matches ``?show=quality,handwriting,diagnosis``.
LAYER_QUALITY = "quality"
LAYER_HANDWRITING = "handwriting"
LAYER_DIAGNOSIS = "diagnosis"
ALL_LAYERS = frozenset({LAYER_QUALITY, LAYER_HANDWRITING, LAYER_DIAGNOSIS})

#: One colour per layer (BGR). Chosen to stay distinguishable from each other, from ink, and from
#: the orange "annotated" frame — and to remain distinguishable in greyscale print, where they
#: differ in luminance as well as hue.
COLOURS: dict[str, tuple[int, int, int]] = {
    LAYER_QUALITY: (40, 40, 220),        # red      — scan defects
    LAYER_HANDWRITING: (220, 130, 20),   # blue     — handwriting regions
    LAYER_DIAGNOSIS: (40, 165, 60),      # green    — diagnosis text regions
}

#: The frame and caption colour. Deliberately not one of the layer colours.
MARK_COLOUR = (0, 120, 255)  # orange (BGR)

#: Outline weight by severity. A high-severity defect is visibly heavier than a low one, so the
#: page can be triaged from a thumbnail.
_SEVERITY_WEIGHT = {"low": 1.0, "medium": 1.8, "high": 3.0}

CAPTION = "ANNOTATED - not the original scan"

_FONT = cv2.FONT_HERSHEY_SIMPLEX


# ------------------------------------------------------------------- helpers


def _get(obj: Any, *names: str, default: Any = None) -> Any:
    """Read a field from either a mapping or an ORM object.

    Callers pass ORM rows (the API route) or plain dicts (the ZIP exporter, which works from the
    already-flattened export rows). Both are supported so neither has to convert first.
    """
    for name in names:
        if isinstance(obj, Mapping):
            if name in obj and obj[name] is not None:
                return obj[name]
        else:
            value = getattr(obj, name, None)
            if value is not None:
                return value
    return default


def _enum_value(value: Any) -> Any:
    return value.value if hasattr(value, "value") else value


def _scale(image: np.ndarray) -> float:
    """A drawing scale so a 600-dpi page is not annotated with hairlines and 6-pixel type."""
    h, w = image.shape[:2]
    return max(0.7, min(4.0, min(h, w) / 900.0))


def _text_colour(bgr: Sequence[int]) -> tuple[int, int, int]:
    """Black or white, whichever survives on this chip colour."""
    b, g, r = (float(c) for c in bgr[:3])
    luma = 0.114 * b + 0.587 * g + 0.299 * r
    return (0, 0, 0) if luma > 140 else (255, 255, 255)


def _rect_from(region: Any) -> tuple[int, int, int, int] | None:
    """Accept ``{x,y,w,h}`` in any of the spellings the models use; ignore anything else."""
    if not isinstance(region, Mapping):
        return None
    try:
        x = int(round(float(region["x"])))
        y = int(round(float(region["y"])))
        w = int(round(float(region["w"])))
        h = int(round(float(region["h"])))
    except (KeyError, TypeError, ValueError):
        return None
    if w <= 0 or h <= 0:
        return None
    return x, y, w, h


def _polygon_from(points: Any) -> np.ndarray | None:
    """``[[x, y], ...]`` → an int32 contour, or None if it is not a usable polygon."""
    if not isinstance(points, (list, tuple)) or len(points) < 3:
        return None
    out: list[list[int]] = []
    for point in points:
        if not isinstance(point, (list, tuple)) or len(point) < 2:
            return None
        try:
            out.append([int(round(float(point[0]))), int(round(float(point[1])))])
        except (TypeError, ValueError):
            return None
    return np.array(out, dtype=np.int32)


def _draw_chip(
    image: np.ndarray,
    text: str,
    origin: tuple[int, int],
    colour: Sequence[int],
    scale: float,
    *,
    anchor_bottom: bool = False,
) -> tuple[int, int]:
    """Draw ``text`` on a filled chip in ``colour``. Returns the chip's (width, height).

    The chip is what makes the label legible on a dark photo and on blank white paper alike. It is
    clamped into the image so a label on a box at the very edge is not drawn off-canvas.
    """
    font_scale = 0.45 * scale
    thickness = max(1, int(round(1.1 * scale)))
    (tw, th), baseline = cv2.getTextSize(text, _FONT, font_scale, thickness)
    pad = max(3, int(round(3 * scale)))
    cw, ch = tw + 2 * pad, th + baseline + 2 * pad

    x, y = origin
    if anchor_bottom:
        y -= ch
    h, w = image.shape[:2]
    x = max(0, min(x, w - cw)) if cw <= w else 0
    y = max(0, min(y, h - ch)) if ch <= h else 0

    cv2.rectangle(image, (x, y), (x + cw, y + ch), tuple(int(c) for c in colour), -1)
    cv2.putText(
        image,
        text,
        (x + pad, y + ch - pad - baseline // 2),
        _FONT,
        font_scale,
        _text_colour(colour),
        thickness,
        cv2.LINE_AA,
    )
    return cw, ch


def _draw_caption(image: np.ndarray, scale: float) -> None:
    """Burn the "this is not the original" caption into the top-left corner, plus a frame.

    Two independent markers on purpose: a caption can be cropped off, a frame cannot be missed, and
    together they make it hard for an annotated copy to be filed as a scan.
    """
    h, w = image.shape[:2]
    border = max(3, int(round(3 * scale)))
    cv2.rectangle(image, (0, 0), (w - 1, h - 1), MARK_COLOUR, border * 2)
    _draw_chip(image, CAPTION, (border, border), MARK_COLOUR, scale * 1.15)


def _draw_legend(
    image: np.ndarray, entries: Sequence[tuple[str, tuple[int, int, int]]], scale: float
) -> None:
    """A legend box in the top-right corner: which colour means what, and the AI caveat."""
    if not entries:
        return
    font_scale = 0.45 * scale
    thickness = max(1, int(round(1.1 * scale)))
    pad = max(4, int(round(5 * scale)))
    swatch = max(8, int(round(11 * scale)))
    gap = max(3, int(round(4 * scale)))

    caveat = "AI findings - not clinically confirmed"
    lines = [text for text, _ in entries] + [caveat]
    sizes = [cv2.getTextSize(t, _FONT, font_scale, thickness)[0] for t in lines]
    row_h = max(s[1] for s in sizes) + gap
    box_w = swatch + gap + max(s[0] for s in sizes) + 2 * pad
    box_h = row_h * len(lines) + 2 * pad

    h, w = image.shape[:2]
    x0 = max(0, w - box_w - pad)
    y0 = pad

    # A translucent white panel: readable over ink without hiding the page underneath it.
    panel = image[y0 : y0 + box_h, x0 : x0 + box_w]
    if panel.size:
        cv2.addWeighted(panel, 0.25, np.full_like(panel, 255), 0.75, 0, panel)
        cv2.rectangle(image, (x0, y0), (x0 + box_w, y0 + box_h), (90, 90, 90), max(1, int(scale)))

        y = y0 + pad
        for i, text in enumerate(lines):
            th = sizes[i][1]
            if i < len(entries):
                colour = entries[i][1]
                cv2.rectangle(
                    image,
                    (x0 + pad, y + (row_h - swatch) // 2),
                    (x0 + pad + swatch, y + (row_h - swatch) // 2 + swatch),
                    colour,
                    -1,
                )
            cv2.putText(
                image,
                text,
                (x0 + pad + swatch + gap, y + th),
                _FONT,
                font_scale,
                (30, 30, 30),
                thickness,
                cv2.LINE_AA,
            )
            y += row_h


# ---------------------------------------------------------------------- API


def annotate_page(
    image_bgr: np.ndarray,
    quality_findings: Iterable[Any] | None = None,
    handwriting_regions: Iterable[Any] | None = None,
    diagnosis_regions: Iterable[Any] | None = None,
    show: set[str] | frozenset[str] | None = None,
) -> np.ndarray:
    """Return a NEW image with the requested overlay layers drawn on it.

    ``image_bgr``            the decoded original render. Never modified.
    ``quality_findings``     rows/dicts with ``defect_code``, ``severity`` and an optional
                             ``region``/``region_json`` of ``{x,y,w,h}``.
    ``handwriting_regions``  rows/dicts with ``category`` and ``polygon``/``polygon_json``.
    ``diagnosis_regions``    rows/dicts with ``anchor_label``/``status`` and a ``region``.
    ``show``                 which layers to draw; defaults to all three.

    Findings without a region are still reported — they are listed in the legend area as
    page-level findings rather than being silently dropped, because "no box" must not read as
    "no problem".
    """
    if image_bgr is None or getattr(image_bgr, "size", 0) == 0:
        raise ValueError("annotate_page needs a decoded image")

    # Copy first, and only then touch anything. Greyscale renders are promoted to BGR so the
    # overlay colours survive.
    canvas = image_bgr.copy()
    if canvas.ndim == 2:
        canvas = cv2.cvtColor(canvas, cv2.COLOR_GRAY2BGR)
    elif canvas.shape[2] == 4:
        canvas = cv2.cvtColor(canvas, cv2.COLOR_BGRA2BGR)
    if canvas.dtype != np.uint8:
        canvas = np.clip(canvas, 0, 255).astype(np.uint8)

    layers = set(show) if show else set(ALL_LAYERS)
    scale = _scale(canvas)
    legend: list[tuple[str, tuple[int, int, int]]] = []
    unplaced: list[str] = []

    # ---------------------------------------------------------- quality
    if LAYER_QUALITY in layers:
        colour = COLOURS[LAYER_QUALITY]
        drawn = 0
        for finding in quality_findings or []:
            code = str(_get(finding, "defect_code", "code", default="defect"))
            severity = str(_enum_value(_get(finding, "severity", default="medium")))
            rect = _rect_from(_get(finding, "region", "region_json"))
            if rect is None:
                unplaced.append(f"{code} ({severity})")
                continue
            x, y, w, h = rect
            weight = max(1, int(round(_SEVERITY_WEIGHT.get(severity, 1.8) * scale)))
            cv2.rectangle(canvas, (x, y), (x + w, y + h), colour, weight)
            _draw_chip(canvas, f"{code} - {severity}", (x, y), colour, scale, anchor_bottom=True)
            drawn += 1
        total = drawn + len(unplaced)
        if total:
            legend.append((f"Scan defects ({total})", colour))

    # ------------------------------------------------------ handwriting
    if LAYER_HANDWRITING in layers:
        colour = COLOURS[LAYER_HANDWRITING]
        count = 0
        for region in handwriting_regions or []:
            polygon = _polygon_from(_get(region, "polygon", "polygon_json"))
            category = str(_enum_value(_get(region, "category", default="uncertain")))
            if polygon is None:
                # Some providers only give a box; fall back rather than dropping the region.
                rect = _rect_from(_get(region, "region", "region_json"))
                if rect is None:
                    continue
                x, y, w, h = rect
                polygon = np.array([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], dtype=np.int32)
            # Polygons, not bounding boxes: a handwritten margin note is rarely rectangular and a
            # box around it would claim territory the model never actually flagged.
            cv2.polylines(canvas, [polygon], True, colour, max(1, int(round(1.8 * scale))), cv2.LINE_AA)
            top_left = polygon.min(axis=0)
            _draw_chip(
                canvas, category, (int(top_left[0]), int(top_left[1])), colour, scale, anchor_bottom=True
            )
            count += 1
        if count:
            legend.append((f"Handwriting ({count})", colour))

    # -------------------------------------------------------- diagnosis
    if LAYER_DIAGNOSIS in layers:
        colour = COLOURS[LAYER_DIAGNOSIS]
        count = 0
        for extraction in diagnosis_regions or []:
            rect = _rect_from(_get(extraction, "region", "region_json"))
            if rect is None:
                continue
            x, y, w, h = rect
            cv2.rectangle(canvas, (x, y), (x + w, y + h), colour, max(1, int(round(2.0 * scale))))
            label = str(_get(extraction, "anchor_label", default="") or "diagnosis")
            status = str(_enum_value(_get(extraction, "status", default="")))
            _draw_chip(
                canvas,
                f"{label} [{status}]" if status else label,
                (x, y),
                colour,
                scale,
                anchor_bottom=True,
            )
            count += 1
        if count:
            legend.append((f"Diagnosis ({count})", colour))

    if unplaced:
        # Page-level findings have no coordinates (dark exposure, bitonal storage, ...). They are
        # named in the legend so the annotated image is not read as "these boxes are everything".
        shown = ", ".join(unplaced[:3]) + (" ..." if len(unplaced) > 3 else "")
        legend.append((f"Page-level: {shown}", COLOURS[LAYER_QUALITY]))

    _draw_legend(canvas, legend, scale)
    _draw_caption(canvas, scale)  # last, so nothing is ever drawn over the marking
    return canvas


def annotated_bytes(
    image_bgr: np.ndarray,
    quality_findings: Iterable[Any] | None = None,
    handwriting_regions: Iterable[Any] | None = None,
    diagnosis_regions: Iterable[Any] | None = None,
    show: set[str] | frozenset[str] | None = None,
) -> bytes:
    """PNG bytes of the annotated page. PNG, not JPEG: overlay edges must stay crisp."""
    return encode_png(
        annotate_page(image_bgr, quality_findings, handwriting_regions, diagnosis_regions, show)
    )


def parse_show(value: str | None) -> set[str]:
    """Parse ``?show=quality,handwriting`` into a layer set; empty/absent means all layers."""
    if not value:
        return set(ALL_LAYERS)
    wanted = {part.strip().lower() for part in value.split(",") if part.strip()}
    layers = wanted & ALL_LAYERS
    return layers or set(ALL_LAYERS)
