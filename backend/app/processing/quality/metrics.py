"""Image-processing measurements for scan quality.

Everything in this module runs on the **original rendered page, before any enhancement**.
No measurement here uses OCR confidence or DPI metadata; those are corroborating signals handled
elsewhere.

Measurement is split from judgement (``rules.py``) so thresholds can be retuned per site without
touching the maths.

Design notes earned from calibrating against real hospital case files:

* The samples mix flatbed scans of loose sheets with overhead photographs of an open bound file
  on a dark desk. Every measurement therefore works inside an explicit *document mask* rather than
  over the whole frame, or the desk background poisons it.
* Glare cannot be an absolute brightness test on a white page — plain paper is already ~250. It is
  measured against the page's own estimated illumination field.
* Cut-off cannot be "ink is near the frame edge" — on a flatbed scan the form's own border rule sits
  there. The real signal is: ink runs to the frame edge **and** the paper edge is not visible on that
  side, i.e. the sheet continues past the scan area.
* Rotation cannot be measured with morphology alone — ruled tables generate as much vertical energy
  as text does horizontal. A projection-profile variance comparison is used instead, after long
  straight rules are removed.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Any

import cv2
import numpy as np

ENGINE_VERSION = "quality-engine/1.1.0"

# Analysis runs at a bounded working size so a 6500x4800 bitonal PNG and a 1700x2200 flatbed scan
# are measured on comparable footing.
WORK_MAX_DIM = 1600


@dataclass
class Region:
    """Axis-aligned region in ORIGINAL image pixel coordinates."""

    x: int
    y: int
    w: int
    h: int

    def as_dict(self) -> dict[str, int]:
        return {"x": int(self.x), "y": int(self.y), "w": int(self.w), "h": int(self.h)}


@dataclass
class PageMetrics:
    width: int = 0
    height: int = 0
    aspect: float = 0.0
    orientation: str = "portrait"

    # colour / encoding
    unique_levels: int = 0
    is_bitonal: bool = False          # set from the SOURCE image at ingest when known
    is_greyscale: bool = False
    colour_mode: str = "colour"
    source_bits_per_component: int | None = None

    # capture geometry
    capture_profile: str = "unknown"
    doc_area_fraction: float = 1.0
    doc_touches_border: dict[str, bool] = field(default_factory=dict)
    paper_edge_visible: dict[str, bool] = field(default_factory=dict)
    background_dark_fraction: float = 0.0
    likely_spread: bool = False
    spread_split_x: int | None = None

    # exposure / contrast
    paper_level: float = 255.0
    ink_level: float = 0.0
    ink_paper_contrast: float = 255.0
    median_luma: float = 255.0
    p05: float = 0.0
    p95: float = 255.0
    dynamic_range: float = 255.0
    illumination_ratio: float = 1.0
    shadow_area_fraction: float = 0.0
    glare_area_fraction: float = 0.0

    # sharpness / noise
    laplacian_var: float = 0.0
    tenengrad: float = 0.0
    stroke_sharpness: float = 0.0     # normalised edge slope; resolution independent
    noise_sigma: float = 0.0
    snr: float = 0.0

    # content
    ink_coverage: float = 0.0
    text_ink_coverage: float = 0.0   # after long ruled lines are removed — the writing itself
    text_component_count: int = 0
    est_text_height_px: float = 0.0
    est_dpi: float | None = None

    # text geometry
    skew_deg: float = 0.0
    rotation_deg: int = 0
    rotation_confidence: float = 0.0

    # localisation
    worst_tile: Region | None = None
    worst_tile_contrast: float | None = None
    low_contrast_tiles: int = 0
    tile_count: int = 0
    glare_regions: list[Region] = field(default_factory=list)
    shadow_regions: list[Region] = field(default_factory=list)
    cutoff_regions: list[Region] = field(default_factory=list)
    cutoff_edges: list[str] = field(default_factory=list)

    error: str | None = None

    def to_json(self) -> dict[str, Any]:
        d = asdict(self)
        d["worst_tile"] = self.worst_tile.as_dict() if self.worst_tile else None
        for key in ("glare_regions", "shadow_regions", "cutoff_regions"):
            d[key] = [r.as_dict() if isinstance(r, Region) else r for r in getattr(self, key)]
        return d


# ---------------------------------------------------------------- helpers


def _work_image(gray: np.ndarray) -> tuple[np.ndarray, float]:
    h, w = gray.shape[:2]
    scale = min(1.0, WORK_MAX_DIM / max(h, w))
    if scale < 1.0:
        return cv2.resize(gray, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA), scale
    return gray, 1.0


def _illumination_field(work: np.ndarray) -> np.ndarray:
    """Estimate the paper's own brightness at every point, with ink removed.

    A morphological closing with a kernel wider than any stroke wipes the writing out and leaves
    the lighting. This is what glare and shadow are then measured against — not an absolute value.
    """
    k = max(15, (min(work.shape[:2]) // 20) | 1)
    closed = cv2.morphologyEx(work, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    return cv2.GaussianBlur(closed, (0, 0), k / 4.0)


def _document_mask(work: np.ndarray, illum: np.ndarray) -> tuple[np.ndarray, float, dict[str, bool], dict[str, bool]]:
    """Separate the sheet from a photographic background.

    Background is defined as *dark area connected to the frame border*: the desk around a
    photographed file, or the black band left when a scanner lid is open. Interior dark ink is
    never treated as background because it does not reach the border.

    Note this thresholds the RAW image, not the illumination field. The field is built with a
    wide morphological closing, which brightens a narrow dark border out of existence — an early
    version of this function used it and reported every photographed page as a flatbed scan.
    """
    h, w = work.shape[:2]
    smooth = cv2.medianBlur(work, 5)
    paper = float(np.percentile(smooth, 85))
    dark_cut = max(50.0, paper * 0.45)
    dark = (smooth < dark_cut).astype(np.uint8) * 255
    dark = cv2.morphologyEx(dark, cv2.MORPH_OPEN, np.ones((7, 7), np.uint8))
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, np.ones((11, 11), np.uint8))

    # Flood from the border to keep only background-connected darkness.
    ff = dark.copy()
    mask = np.zeros((h + 2, w + 2), np.uint8)
    seeds: list[tuple[int, int]] = []
    step = max(1, w // 40)
    for x in range(0, w, step):
        seeds += [(x, 0), (x, h - 1)]
    step = max(1, h // 40)
    for y in range(0, h, step):
        seeds += [(0, y), (w - 1, y)]
    background = np.zeros((h, w), np.uint8)
    for sx, sy in seeds:
        if ff[sy, sx] == 255 and background[sy, sx] == 0:
            cv2.floodFill(ff, mask, (sx, sy), 128)
    background[ff == 128] = 255

    doc = cv2.bitwise_not(background)
    doc = cv2.morphologyEx(doc, cv2.MORPH_OPEN, np.ones((7, 7), np.uint8))
    frac = float(np.count_nonzero(doc)) / float(h * w)
    if frac < 0.15:  # background detection clearly failed; fall back to the whole frame
        doc = np.full((h, w), 255, np.uint8)
        frac = 1.0

    edge = max(2, int(min(h, w) * 0.004))
    touches, visible = {}, {}
    strips = {
        "top": doc[0:edge, :],
        "bottom": doc[h - edge : h, :],
        "left": doc[:, 0:edge],
        "right": doc[:, w - edge : w],
    }
    for name, strip in strips.items():
        cover = float(np.count_nonzero(strip)) / float(strip.size)
        touches[name] = cover > 0.5
        # The paper edge is "visible" on this side when a meaningful slice of the border strip is
        # background rather than paper — i.e. we can see where the sheet stops.
        visible[name] = cover < 0.85

    return doc, frac, touches, visible


def _ink_mask(work: np.ndarray, doc_mask: np.ndarray, illum: np.ndarray) -> np.ndarray:
    """Ink = pixels meaningfully darker than the local paper brightness.

    Working from the illumination field rather than a global threshold is what keeps the shaded
    half of a photographed spread from being flooded or erased.
    """
    diff = cv2.subtract(illum, work)
    _, ink = cv2.threshold(diff, 18, 255, cv2.THRESH_BINARY)
    ink = cv2.bitwise_and(ink, doc_mask)
    ink = cv2.medianBlur(ink, 3)
    return ink


def _remove_rules(ink: np.ndarray) -> np.ndarray:
    """Strip long straight table rules so they do not dominate orientation measurements."""
    h, w = ink.shape[:2]
    hl = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(20, w // 12), 1)))
    vl = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(20, h // 12))))
    rules = cv2.dilate(cv2.bitwise_or(hl, vl), np.ones((3, 3), np.uint8))
    return cv2.bitwise_and(ink, cv2.bitwise_not(rules))


def _estimate_noise(work: np.ndarray, doc_mask: np.ndarray) -> float:
    """Immerkaer sigma, measured only on flat (non-edge) paper so ink does not inflate it."""
    h, w = work.shape[:2]
    if h < 8 or w < 8:
        return 0.0
    m = np.array([[1, -2, 1], [-2, 4, -2], [1, -2, 1]], dtype=np.float32)
    conv = np.abs(cv2.filter2D(work.astype(np.float32), -1, m))
    edges = cv2.dilate(cv2.Canny(work, 40, 120), np.ones((5, 5), np.uint8))
    flat = (doc_mask > 127) & (edges == 0)
    if flat.sum() < 500:
        return 0.0
    vals = conv[flat]
    return float(np.mean(vals) * math.sqrt(0.5 * math.pi) / 6.0)


def _stroke_sharpness(work: np.ndarray, ink: np.ndarray) -> float:
    """Resolution-independent sharpness: gradient magnitude at ink edges, normalised by the
    local ink/paper amplitude. A crisp stroke transitions over 1–2 px whatever the DPI; a
    defocused photograph spreads the same amplitude over many pixels."""
    if int(np.count_nonzero(ink)) < 300:
        return 0.0
    border = cv2.morphologyEx(ink, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8))
    ys, xs = np.nonzero(border)
    if ys.size < 200:
        return 0.0
    if ys.size > 20000:
        idx = np.random.default_rng(0).choice(ys.size, 20000, replace=False)
        ys, xs = ys[idx], xs[idx]
    gx = cv2.Sobel(work, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(work, cv2.CV_32F, 0, 1, ksize=3)
    grad = np.sqrt(gx * gx + gy * gy)[ys, xs]
    paper = float(np.percentile(work[ink == 0], 60)) if np.count_nonzero(ink == 0) else 255.0
    inkv = float(np.mean(work[ink > 0]))
    amp = max(1.0, paper - inkv)
    return float(np.mean(grad) / amp)


def _illumination_stats(
    illum: np.ndarray, doc_mask: np.ndarray, inv_scale: float
) -> tuple[float, float, float, list[Region], list[Region]]:
    small = cv2.resize(illum, (48, 48), interpolation=cv2.INTER_AREA).astype(np.float32)
    msk = cv2.resize(doc_mask, (48, 48), interpolation=cv2.INTER_AREA)
    valid = msk > 200
    if valid.sum() < 40:
        return 1.0, 0.0, 0.0, [], []
    vals = small[valid]
    paper_med = float(np.median(vals))
    lo, hi = float(np.percentile(vals, 5)), float(np.percentile(vals, 95))
    ratio = (hi + 1e-6) / (max(lo, 1.0))

    # Glare is measured against the page's own paper level, not against 255. A single very large
    # bright region is then dropped: on a photographed spread, a white sheet next to a coloured
    # form looks "blown out" relative to the page median and would otherwise be reported as glare
    # on every such page. Real glare is a specular patch, not half the frame.
    glare_cells = valid & (small >= 250) & (small > paper_med + 10)
    if glare_cells.any():
        gm = glare_cells.astype(np.uint8)
        cn, lbl, cstats, _ = cv2.connectedComponentsWithStats(gm, connectivity=8)
        limit = 0.20 * float(valid.sum())
        for i in range(1, cn):
            if cstats[i, cv2.CC_STAT_AREA] > limit:
                glare_cells &= lbl != i
    shadow_cells = valid & (small < paper_med * 0.70)
    glare_frac = float(glare_cells.sum()) / float(valid.sum())
    shadow_frac = float(shadow_cells.sum()) / float(valid.sum())

    sy = (illum.shape[0] / 48.0) * inv_scale
    sx = (illum.shape[1] / 48.0) * inv_scale

    def _regions(cells: np.ndarray) -> list[Region]:
        out: list[Region] = []
        m = cells.astype(np.uint8) * 255
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
        cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in sorted(cnts, key=cv2.contourArea, reverse=True)[:3]:
            if cv2.contourArea(c) < 4:
                continue
            x, y, w, h = cv2.boundingRect(c)
            out.append(Region(int(x * sx), int(y * sy), int(w * sx), int(h * sy)))
        return out

    return ratio, shadow_frac, glare_frac, _regions(shadow_cells), _regions(glare_cells)


def _text_geometry(text_ink: np.ndarray) -> tuple[int, float, float]:
    n, _, stats, _ = cv2.connectedComponentsWithStats(text_ink, connectivity=8)
    heights: list[int] = []
    kept = 0
    for i in range(1, n):
        x, y, w, h, a = stats[i]
        if a < 10 or h < 4 or h > text_ink.shape[0] * 0.25 or w > text_ink.shape[1] * 0.5:
            continue
        heights.append(int(h))
        kept += 1
    med_h = float(np.median(heights)) if heights else 0.0

    skew = 0.0
    if kept >= 25 and med_h > 0:
        k = max(9, int(med_h * 4) | 1)
        lines = cv2.morphologyEx(
            text_ink, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (k, 3))
        )
        cnts, _ = cv2.findContours(lines, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        angles: list[float] = []
        weights: list[float] = []
        for c in cnts:
            (_, _), (w, h), ang = cv2.minAreaRect(c)
            if w < h:
                w, h = h, w
                ang += 90
            if h <= 0 or w / max(h, 1.0) < 4 or w < med_h * 6:
                continue
            a = ang
            while a > 45:
                a -= 90
            while a < -45:
                a += 90
            angles.append(a)
            weights.append(w)
        if len(angles) >= 6:
            order = np.argsort(angles)
            a_sorted = np.array(angles)[order]
            w_sorted = np.array(weights)[order]
            cum = np.cumsum(w_sorted)
            skew = float(a_sorted[int(np.searchsorted(cum, cum[-1] / 2.0))])
    return kept, med_h, skew


def _rotation_guess(text_ink: np.ndarray, med_h: float) -> tuple[int, float]:
    """0 vs 90, from the direction in which glyphs neighbour each other.

    Characters within a word sit side by side along the writing direction, and the gap between
    lines is always larger than the gap between characters. So the vector from each glyph to its
    nearest neighbour points along the text — horizontally for an upright page, vertically for a
    page turned on its side. This holds for Latin and for Devanagari alike.

    A projection-profile version of this test was tried first and had to be replaced: on a
    photographed two-page spread, the two pages and the gutter corrupt both profiles, and it
    scored genuinely rotated pages *lower* than upright ones.

    Telling 0 from 180 requires reading the glyphs and is deliberately left to OCR.
    """
    if med_h <= 0:
        return 0, 0.0

    # Signal 1 — text-line energy. Close the ink along each axis and measure how much line-like
    # structure results. Upright prose closes into long horizontal lines and little else.
    k = max(5, int(med_h * 2.5))
    line_scores: dict[int, float] = {}
    for horiz, kernel in ((True, (k, 1)), (False, (1, k))):
        closed = cv2.morphologyEx(text_ink, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, kernel))
        cn, _cl, cst, _cc = cv2.connectedComponentsWithStats(closed, connectivity=8)
        total = 0.0
        for i in range(1, cn):
            _x, _y, cw, ch, _a = cst[i]
            length, thick = (cw, ch) if horiz else (ch, cw)
            if thick > 0 and length / max(thick, 1) >= 4 and length > med_h * 6:
                total += float(length)
        line_scores[0 if horiz else 90] = total
    ls_total = line_scores[0] + line_scores[90]
    line_guess = 0 if line_scores[0] >= line_scores[90] else 90
    line_conf = abs(line_scores[0] - line_scores[90]) / ls_total if ls_total > 0 else 0.0

    # Signal 2 — nearest-neighbour direction between glyphs.
    n, _labels, stats, cents = cv2.connectedComponentsWithStats(text_ink, connectivity=8)
    pts = []
    for i in range(1, n):
        _x, _y, cw, ch, a = stats[i]
        if a < max(10, med_h * 0.8):
            continue
        if not (med_h * 0.45 <= ch <= med_h * 3.0):
            continue
        if cw > med_h * 8:
            continue
        pts.append(cents[i])
    if len(pts) < 80:
        return line_guess, (line_conf if line_guess == 90 else 0.0)
    p = np.asarray(pts, dtype=np.float32)
    if p.shape[0] > 1500:
        p = p[np.random.default_rng(0).choice(p.shape[0], 1500, replace=False)]

    d2 = ((p[:, None, :] - p[None, :, :]) ** 2).sum(axis=2)
    np.fill_diagonal(d2, np.inf)
    nn = np.argmin(d2, axis=1)
    # Ignore neighbours further away than a couple of line heights — those are not same-word pairs.
    keep = d2[np.arange(p.shape[0]), nn] < (med_h * 3.0) ** 2
    if keep.sum() < 40:
        return line_guess, (line_conf if line_guess == 90 else 0.0)
    delta = np.abs(p[nn][keep] - p[keep])
    horiz = int((delta[:, 0] > delta[:, 1]).sum())
    vert = int((delta[:, 1] >= delta[:, 0]).sum())
    total = horiz + vert
    nn_guess = 0 if horiz >= vert else 90
    nn_conf = abs(horiz - vert) / total if total else 0.0

    # The two signals must agree before the page is called rotated at all. Where they disagree the
    # page is reported as upright with zero confidence, and orientation is left to OCR — which is
    # the only thing that can also tell 0 from 180.
    if nn_guess != line_guess:
        return 0, 0.0
    return nn_guess, max(nn_conf, line_conf)


def _tiles(
    work: np.ndarray, doc_mask: np.ndarray, ink: np.ndarray, illum: np.ndarray, inv_scale: float
) -> tuple[int, int, Region | None, float | None]:
    rows, cols = 6, 6
    h, w = work.shape[:2]
    th, tw = h // rows, w // cols
    if th < 12 or tw < 12:
        return 0, 0, None, None
    worst_val: float | None = None
    worst: Region | None = None
    low = 0
    counted = 0
    for r in range(rows):
        for c in range(cols):
            y0, x0 = r * th, c * tw
            tile = work[y0 : y0 + th, x0 : x0 + tw]
            mk = doc_mask[y0 : y0 + th, x0 : x0 + tw]
            ik = ink[y0 : y0 + th, x0 : x0 + tw]
            il = illum[y0 : y0 + th, x0 : x0 + tw]
            if np.count_nonzero(mk) < 0.5 * mk.size:
                continue
            ink_px = int(np.count_nonzero(ik))
            if ink_px < max(40, int(0.002 * ik.size)):
                continue  # empty area: absence of ink is not evidence of poor contrast
            counted += 1
            paper = float(np.median(il[mk > 127]))
            ink_lvl = float(np.mean(tile[ik > 0]))
            contrast = paper - ink_lvl
            if worst_val is None or contrast < worst_val:
                worst_val = contrast
                worst = Region(int(x0 * inv_scale), int(y0 * inv_scale), int(tw * inv_scale), int(th * inv_scale))
            if contrast < 28:
                low += 1
    return low, counted, worst, worst_val


def _spread(work: np.ndarray, doc_mask: np.ndarray) -> tuple[bool, int | None]:
    h, w = work.shape[:2]
    if w < h * 1.15:
        return False, None
    # Column means over document pixels only. A column that lies entirely in the background has no
    # document pixels at all, so it is filled from the page median rather than producing a NaN.
    inside = doc_mask > 127
    counts = inside.sum(axis=0).astype(np.float32)
    sums = np.where(inside, work, 0).sum(axis=0).astype(np.float32)
    valid = counts > 0
    if not valid.any():
        return False, None
    prof = np.full(w, float(np.median(sums[valid] / counts[valid])), dtype=np.float32)
    prof[valid] = sums[valid] / counts[valid]
    prof = cv2.GaussianBlur(prof.reshape(1, -1), (0, 0), 6).ravel()
    lo, hi = int(w * 0.32), int(w * 0.68)
    band = prof[lo:hi]
    if band.size == 0:
        return False, None
    idx = int(np.argmin(band)) + lo
    depth = float(np.median(prof) - prof[idx])
    return (depth > 22.0), (idx if depth > 22.0 else None)


def _cutoff(
    text_ink: np.ndarray,
    doc_mask: np.ndarray,
    visible: dict[str, bool],
    med_text_h: float,
    inv_scale: float,
) -> tuple[list[str], list[Region]]:
    """Suspected cut-off, from truncated writing rather than proximity to the edge.

    Getting this right is mostly a matter of what *not* to count:

    * A form's own border rule sits on the edge of nearly every scan. Long straight rules are
      removed before this function is called, so they contribute nothing.
    * On a photographed page the sheet's own edge is often visible against the desk. If it is,
      nothing was cropped on that side however close the writing comes.
    * Ink merely being near the edge is not evidence. What is evidence is *several separate
      writing components abutting the frame*, which is what a sliced line of text looks like.

    The finding this produces is always phrased as a suspicion: the system cannot see outside the
    image and does not claim to.
    """
    h, w = text_ink.shape[:2]
    band = max(2, int(min(h, w) * 0.006))
    if med_text_h <= 0:
        med_text_h = max(4.0, min(h, w) * 0.01)

    # Only components that look like writing count. Specks, dust and the dark frame left by a
    # scanner lid are all excluded by the size and shape gates below.
    lo_h, hi_h = med_text_h * 0.5, med_text_h * 3.5
    min_area = max(15.0, med_text_h * med_text_h * 0.4)

    n, _labels, stats, _ = cv2.connectedComponentsWithStats(text_ink, connectivity=8)
    edges: list[str] = []
    regions: list[Region] = []
    hits: dict[str, list[tuple[int, int, int, int]]] = {"top": [], "bottom": [], "left": [], "right": []}

    for i in range(1, n):
        x, y, cw, ch, a = stats[i]
        if a < min_area or not (lo_h <= ch <= hi_h) or cw < med_text_h * 0.4:
            continue
        if cw > w * 0.35 or ch > h * 0.35:
            continue
        if y <= band:
            hits["top"].append((x, y, cw, ch))
        if y + ch >= h - band:
            hits["bottom"].append((x, y, cw, ch))
        if x <= band:
            hits["left"].append((x, y, cw, ch))
        if x + cw >= w - band:
            hits["right"].append((x, y, cw, ch))

    for name, comps in hits.items():
        if visible.get(name, False):
            continue  # the sheet's own edge is visible on this side — nothing was cropped
        if len(comps) < 4:
            continue
        along_horizontal = name in ("top", "bottom")
        pos = [c[0] for c in comps] if along_horizontal else [c[1] for c in comps]
        span = (max(pos) - min(pos)) / float(w if along_horizontal else h)
        if span < 0.15:
            continue  # a local cluster, not a sliced line of writing running along the edge
        xs = [c[0] for c in comps]
        ys = [c[1] for c in comps]
        x2 = [c[0] + c[2] for c in comps]
        y2 = [c[1] + c[3] for c in comps]
        edges.append(name)
        regions.append(
            Region(
                int(min(xs) * inv_scale),
                int(min(ys) * inv_scale),
                int(max(1, (max(x2) - min(xs))) * inv_scale),
                int(max(1, (max(y2) - min(ys))) * inv_scale),
            )
        )
    return edges, regions


# ---------------------------------------------------------------- entry point


def measure(image_bgr: np.ndarray, source_bits_per_component: int | None = None) -> PageMetrics:
    """Measure one page.

    ``image_bgr`` must be the ORIGINAL render, not an enhanced copy.
    ``source_bits_per_component`` should be passed through from the container (PDF image object,
    TIFF tag). Rendering a 1-bit image anti-aliases it back to grey, so bitonal storage can only be
    detected from the source, never from the render.
    """
    m = PageMetrics(source_bits_per_component=source_bits_per_component)
    if image_bgr is None or getattr(image_bgr, "size", 0) == 0:
        m.error = "empty image"
        return m

    try:
        if image_bgr.ndim == 3 and image_bgr.shape[2] >= 3:
            gray = cv2.cvtColor(image_bgr[:, :, :3], cv2.COLOR_BGR2GRAY)
            b, g, r = cv2.split(image_bgr[:, :, :3])
            m.is_greyscale = bool(np.array_equal(b, g) and np.array_equal(g, r))
        else:
            gray = image_bgr if image_bgr.ndim == 2 else image_bgr[:, :, 0]
            m.is_greyscale = True

        m.height, m.width = gray.shape[:2]
        m.aspect = m.width / max(m.height, 1)
        m.orientation = "landscape" if m.width > m.height else "portrait"

        sub = gray[:: max(1, gray.shape[0] // 400), :: max(1, gray.shape[1] // 400)]
        m.unique_levels = int(np.unique(sub).size)
        m.is_bitonal = (source_bits_per_component == 1) or m.unique_levels <= 3
        m.colour_mode = "bitonal" if m.is_bitonal else ("grey" if m.is_greyscale else "colour")

        work, scale = _work_image(gray)
        inv_scale = 1.0 / scale if scale else 1.0

        illum = _illumination_field(work)
        doc_mask, doc_frac, touches, visible = _document_mask(work, illum)
        m.doc_area_fraction = doc_frac
        m.background_dark_fraction = 1.0 - doc_frac
        m.doc_touches_border = touches
        m.paper_edge_visible = visible

        inside = doc_mask > 127
        vals = work[inside] if inside.sum() > 100 else work.ravel()
        m.median_luma = float(np.median(vals))
        m.p05 = float(np.percentile(vals, 5))
        m.p95 = float(np.percentile(vals, 95))
        m.dynamic_range = m.p95 - m.p05

        ink = _ink_mask(work, doc_mask, illum)
        ink_px = int(np.count_nonzero(ink))
        denom = max(int(np.count_nonzero(doc_mask)), 1)
        m.ink_coverage = ink_px / denom
        m.paper_level = float(np.median(illum[inside])) if inside.sum() > 100 else 255.0
        m.ink_level = float(np.mean(work[ink > 0])) if ink_px > 50 else m.paper_level
        m.ink_paper_contrast = max(0.0, m.paper_level - m.ink_level)

        m.laplacian_var = float(cv2.Laplacian(work, cv2.CV_64F).var())
        gx = cv2.Sobel(work, cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(work, cv2.CV_32F, 0, 1, ksize=3)
        m.tenengrad = float(np.mean(gx * gx + gy * gy))
        m.stroke_sharpness = _stroke_sharpness(work, ink)
        m.noise_sigma = _estimate_noise(work, doc_mask)
        m.snr = float(m.ink_paper_contrast / (m.noise_sigma + 1e-6))

        ratio, shadow_frac, glare_frac, shadow_r, glare_r = _illumination_stats(illum, doc_mask, inv_scale)
        m.illumination_ratio = ratio
        m.shadow_area_fraction = shadow_frac
        m.glare_area_fraction = glare_frac
        m.shadow_regions = shadow_r
        m.glare_regions = glare_r

        text_ink = _remove_rules(ink)
        m.text_ink_coverage = float(np.count_nonzero(text_ink)) / denom
        count, med_h, skew = _text_geometry(text_ink)
        m.text_component_count = count
        m.est_text_height_px = med_h * inv_scale
        m.skew_deg = skew
        rot, rot_conf = _rotation_guess(text_ink, med_h)
        m.rotation_deg = rot
        m.rotation_confidence = rot_conf
        m.est_dpi = float(m.est_text_height_px * 9.0) if m.est_text_height_px > 2 else None

        low, counted, worst, worst_val = _tiles(work, doc_mask, ink, illum, inv_scale)
        m.low_contrast_tiles = low
        m.tile_count = counted
        m.worst_tile = worst
        m.worst_tile_contrast = worst_val

        spread, split = _spread(work, doc_mask)
        m.likely_spread = spread
        m.spread_split_x = int(split * inv_scale) if split is not None else None

        # A camera capture betrays itself in several ways at once: visible desk around the sheet,
        # an open spread with a gutter, or a lighting gradient no platen would produce. A flatbed
        # scan has none of them. This label is informational — no defect depends on it.
        m.capture_profile = (
            "photo"
            if (m.background_dark_fraction > 0.05 or m.likely_spread or m.illumination_ratio > 1.6)
            else "flatbed"
        )

        m.cutoff_edges, m.cutoff_regions = _cutoff(text_ink, doc_mask, visible, med_h, inv_scale)
    except Exception as exc:  # measurement must never silently succeed
        m.error = f"{type(exc).__name__}: {exc}"
    return m
