"""Ingest: take an uploaded file apart into logical pages without ever touching the original.

Responsibilities:

* validate type, size and page count against the configured limits;
* recognise password-protected and corrupted files and report them as such, with a message a ward
  clerk can act on;
* render each page once at the configured DPI, and record the *source* colour depth — a 1-bit page
  is anti-aliased back to grey by any renderer, so bitonal storage can only be seen here;
* read the printed page label — the `(22)`-style number pre-printed on these case-sheet forms — which
  the completeness checker later uses to spot sequence gaps.

The uploaded bytes are stored once and never modified. Renders and thumbnails are separate objects.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

import cv2
import numpy as np

from app.config import settings


class IngestRejected(Exception):
    """The file cannot be processed and the user needs to know why."""

    def __init__(self, reason_code: str, message: str) -> None:
        super().__init__(message)
        self.reason_code = reason_code
        self.message = message


@dataclass
class RenderedPage:
    index: int                      # 0-based position in the source file
    image: np.ndarray               # BGR
    source_bits_per_component: int | None = None
    source_width: int | None = None
    source_height: int | None = None
    printed_label: str | None = None
    notes: list[str] = field(default_factory=list)


def validate_upload(filename: str, byte_size: int) -> str:
    ext = Path(filename).suffix.lower().lstrip(".")
    if ext not in settings.allowed_ext_set:
        raise IngestRejected(
            "unsupported_type",
            f"'{Path(filename).name}' is a .{ext or 'unknown'} file. Accepted types are: "
            + ", ".join(sorted(settings.allowed_ext_set))
            + ".",
        )
    if byte_size > settings.max_upload_mb * 1024 * 1024:
        raise IngestRejected(
            "too_large",
            f"'{Path(filename).name}' is {byte_size / (1024*1024):.0f} MB. The limit is "
            f"{settings.max_upload_mb} MB — ask an administrator to raise it in Settings if this is "
            "a normal size for your scanner.",
        )
    if byte_size == 0:
        raise IngestRejected("empty", f"'{Path(filename).name}' is empty.")
    return ext


_LABEL_RE = re.compile(r"^\(?\s*(\d{1,3})\s*\)?$")


def _read_printed_label(image: np.ndarray) -> str | None:
    """Read the pre-printed page number from the top corners, when one is legible.

    This uses Tesseract when it happens to be installed; it is an optional convenience, and its
    absence simply means sequence-gap checking falls back to upload order. It is never used to
    decide quality.
    """
    try:
        import shutil
        import subprocess
        import tempfile

        if not shutil.which("tesseract"):
            return None
        h, w = image.shape[:2]
        strips = [
            image[0 : int(h * 0.09), int(w * 0.80) : w],
            image[0 : int(h * 0.09), 0 : int(w * 0.20)],
        ]
        for strip in strips:
            if strip.size == 0:
                continue
            with tempfile.TemporaryDirectory() as td:
                p = Path(td) / "s.png"
                cv2.imwrite(str(p), strip)
                out = subprocess.run(
                    ["tesseract", str(p), "stdout", "--psm", "7", "-c", "tessedit_char_whitelist=0123456789()"],
                    capture_output=True,
                    text=True,
                    timeout=15,
                )
            for token in out.stdout.split():
                m = _LABEL_RE.match(token.strip())
                if m:
                    return f"({m.group(1)})"
    except Exception:
        return None
    return None


def _pixmap_to_bgr(pix) -> np.ndarray:  # noqa: ANN001 - pymupdf type
    buf = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
    if pix.n == 4:
        return cv2.cvtColor(buf, cv2.COLOR_RGBA2BGR)
    if pix.n == 3:
        return cv2.cvtColor(buf, cv2.COLOR_RGB2BGR)
    return cv2.cvtColor(buf, cv2.COLOR_GRAY2BGR)


def iter_pdf(path: str, dpi: int, read_labels: bool = True) -> Iterator[RenderedPage]:
    import pymupdf

    try:
        doc = pymupdf.open(path)
    except Exception as exc:
        raise IngestRejected("corrupted", f"The PDF could not be opened: {type(exc).__name__}.") from exc

    try:
        if doc.needs_pass:
            raise IngestRejected(
                "password_protected",
                "This PDF is password-protected. Remove the password and upload it again — the "
                "system deliberately does not attempt to break document passwords.",
            )
        if doc.page_count == 0:
            raise IngestRejected("corrupted", "The PDF contains no pages.")
        if doc.page_count > settings.max_pages_per_document:
            raise IngestRejected(
                "too_many_pages",
                f"The PDF has {doc.page_count} pages; the configured limit is "
                f"{settings.max_pages_per_document}.",
            )

        for i in range(doc.page_count):
            notes: list[str] = []
            bpc: int | None = None
            sw = sh = None
            try:
                images = doc[i].get_images(full=True)
                if len(images) == 1:
                    info = doc.extract_image(images[0][0])
                    bpc = int(info.get("bpc", 8) or 8)
                    sw, sh = info.get("width"), info.get("height")
                elif len(images) > 1:
                    notes.append(f"{len(images)} embedded images on this page")
            except Exception:
                notes.append("could not inspect embedded image metadata")

            try:
                pix = doc[i].get_pixmap(dpi=dpi)
                img = _pixmap_to_bgr(pix)
            except Exception as exc:
                # One bad page must not lose the other thirty-four.
                yield RenderedPage(index=i, image=np.zeros((1, 1, 3), np.uint8), notes=[f"render failed: {type(exc).__name__}"])
                continue

            yield RenderedPage(
                index=i,
                image=img,
                source_bits_per_component=bpc,
                source_width=sw,
                source_height=sh,
                printed_label=_read_printed_label(img) if read_labels else None,
                notes=notes,
            )
    finally:
        doc.close()


def iter_tiff(path: str, read_labels: bool = True) -> Iterator[RenderedPage]:
    from PIL import Image, ImageSequence

    try:
        im = Image.open(path)
    except Exception as exc:
        raise IngestRejected("corrupted", f"The TIFF could not be opened: {type(exc).__name__}.") from exc

    count = getattr(im, "n_frames", 1)
    if count > settings.max_pages_per_document:
        raise IngestRejected(
            "too_many_pages",
            f"The TIFF has {count} pages; the configured limit is {settings.max_pages_per_document}.",
        )

    for i, frame in enumerate(ImageSequence.Iterator(im)):
        bpc = 1 if frame.mode == "1" else 8
        rgb = frame.convert("RGB")
        arr = cv2.cvtColor(np.array(rgb), cv2.COLOR_RGB2BGR)
        yield RenderedPage(
            index=i,
            image=arr,
            source_bits_per_component=bpc,
            source_width=frame.width,
            source_height=frame.height,
            printed_label=_read_printed_label(arr) if read_labels else None,
        )


def iter_image(path: str, read_labels: bool = True) -> Iterator[RenderedPage]:
    from PIL import Image

    try:
        im = Image.open(path)
        im.load()
    except Exception as exc:
        raise IngestRejected("corrupted", f"The image could not be opened: {type(exc).__name__}.") from exc
    bpc = 1 if im.mode == "1" else 8
    arr = cv2.cvtColor(np.array(im.convert("RGB")), cv2.COLOR_RGB2BGR)
    yield RenderedPage(
        index=0,
        image=arr,
        source_bits_per_component=bpc,
        source_width=im.width,
        source_height=im.height,
        printed_label=_read_printed_label(arr) if read_labels else None,
    )


def iter_pages(path: str, filename: str, dpi: int | None = None, read_labels: bool = True) -> Iterator[RenderedPage]:
    ext = Path(filename).suffix.lower().lstrip(".")
    dpi = dpi or settings.render_dpi
    if ext == "pdf":
        yield from iter_pdf(path, dpi, read_labels)
    elif ext in ("tif", "tiff"):
        yield from iter_tiff(path, read_labels)
    else:
        yield from iter_image(path, read_labels)


def encode_png(image: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", image)
    if not ok:
        raise RuntimeError("failed to encode PNG")
    return buf.tobytes()


def encode_jpeg(image: np.ndarray, quality: int = 88) -> bytes:
    ok, buf = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        raise RuntimeError("failed to encode JPEG")
    return buf.tobytes()


def make_thumbnail(image: np.ndarray, max_px: int | None = None) -> np.ndarray:
    max_px = max_px or settings.thumb_max_px
    h, w = image.shape[:2]
    scale = min(1.0, max_px / max(h, w, 1))
    if scale >= 1.0:
        return image
    return cv2.resize(image, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA)


def make_preview(image: np.ndarray, max_px: int | None = None) -> np.ndarray:
    """A bounded-size copy for the viewer. The original render is kept untouched alongside it."""
    max_px = max_px or settings.preview_max_px
    h, w = image.shape[:2]
    scale = min(1.0, max_px / max(h, w, 1))
    if scale >= 1.0:
        return image
    return cv2.resize(image, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA)


def bytes_to_image(data: bytes) -> np.ndarray | None:
    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    return img


def sniff_stream_mime(filename: str) -> str:
    ext = Path(filename).suffix.lower().lstrip(".")
    return {
        "pdf": "application/pdf",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "png": "image/png",
        "tif": "image/tiff",
        "tiff": "image/tiff",
        "webp": "image/webp",
    }.get(ext, "application/octet-stream")


def probe_container(path: str, filename: str) -> tuple[int, list[str]]:
    """Count pages and collect any warnings, without rendering. Used at upload time so the user gets
    an immediate, accurate rejection rather than a failure ten minutes into a batch."""
    ext = Path(filename).suffix.lower().lstrip(".")
    warnings: list[str] = []
    if ext == "pdf":
        import pymupdf

        try:
            doc = pymupdf.open(path)
        except Exception as exc:
            raise IngestRejected("corrupted", f"The PDF could not be opened: {type(exc).__name__}.") from exc
        try:
            if doc.needs_pass:
                raise IngestRejected(
                    "password_protected",
                    "This PDF is password-protected. Remove the password and upload it again.",
                )
            count = doc.page_count
        finally:
            doc.close()
    elif ext in ("tif", "tiff"):
        from PIL import Image

        try:
            im = Image.open(path)
            count = getattr(im, "n_frames", 1)
        except Exception as exc:
            raise IngestRejected("corrupted", f"The TIFF could not be opened: {type(exc).__name__}.") from exc
    else:
        from PIL import Image

        try:
            im = Image.open(path)
            im.verify()
            count = 1
        except Exception as exc:
            raise IngestRejected("corrupted", f"The image could not be opened: {type(exc).__name__}.") from exc

    if count == 0:
        raise IngestRejected("corrupted", "The file contains no pages.")
    if count > settings.max_pages_per_document:
        raise IngestRejected(
            "too_many_pages",
            f"The file has {count} pages; the configured limit is {settings.max_pages_per_document}.",
        )
    return count, warnings


def load_bytes(path: str) -> bytes:
    return Path(path).read_bytes()


def image_to_upload_bytes(image: np.ndarray) -> tuple[bytes, str]:
    """Encode a page for a provider call. PNG keeps thin strokes intact, which matters for faint
    handwriting; the size penalty over JPEG is acceptable at one page per request."""
    return encode_png(image), "image/png"


def open_stream(data: bytes) -> io.BytesIO:
    return io.BytesIO(data)
