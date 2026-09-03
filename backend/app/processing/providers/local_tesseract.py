"""Local OCR via Tesseract, for deployments that must not send pages to a cloud service.

Honest capability statement, which the UI shows verbatim on the Settings page:

* Printed English and printed Hindi are usable if the corresponding traineddata is installed
  (``tesseract-ocr-eng``, ``tesseract-ocr-hin``).
* **Handwriting is not supported.** Tesseract is a printed-text engine. This provider therefore
  never claims a handwriting result: it declares no handwriting languages at all, so the router
  will not route handwriting work to it, and a deployment with no other provider reports
  handwriting as ``unconfigured`` rather than "none detected".

That distinction is the whole point of keeping this provider deliberately limited.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

from app.processing.providers.base import Line, OcrPage, OcrProvider, ProviderError, ProviderUnconfigured

_NS = {"x": "http://www.w3.org/1999/xhtml"}


class LocalTesseractProvider(OcrProvider):
    name = "local_tesseract"
    supports_quality_scores = False
    handwriting_languages: set[str] = set()          # deliberately empty — see module docstring
    print_languages = {"en", "hi"}

    def _binary(self) -> str | None:
        return shutil.which("tesseract")

    def _langs_installed(self) -> set[str]:
        exe = self._binary()
        if not exe:
            return set()
        try:
            out = subprocess.run([exe, "--list-langs"], capture_output=True, text=True, timeout=20)
            return {ln.strip() for ln in out.stdout.splitlines()[1:] if ln.strip()}
        except Exception:
            return set()

    def analyse_page(self, image_bytes: bytes, mime: str, language_hints: list[str] | None = None) -> OcrPage:
        exe = self._binary()
        if not exe:
            raise ProviderUnconfigured("Tesseract is not installed in this environment.")

        installed = self._langs_installed()
        wanted = []
        for h in language_hints or []:
            code = h.split(":")[0].split("-")[0].lower()
            wanted.append({"en": "eng", "hi": "hin"}.get(code, code))
        langs = [lang for lang in wanted if lang in installed] or (["eng"] if "eng" in installed else [])
        if not langs:
            raise ProviderUnconfigured(
                "No usable Tesseract language data installed (need at least 'eng'; 'hin' for Hindi)."
            )

        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / "page.img"
            src.write_bytes(image_bytes)
            try:
                proc = subprocess.run(
                    [exe, str(src), str(Path(td) / "out"), "-l", "+".join(langs), "--psm", "3", "hocr"],
                    capture_output=True,
                    timeout=180,
                )
            except subprocess.TimeoutExpired as exc:
                raise ProviderError("Tesseract timed out") from exc
            if proc.returncode != 0:
                raise ProviderError(f"Tesseract exited {proc.returncode}")
            hocr = (Path(td) / "out.hocr").read_text(encoding="utf-8", errors="replace")

        return self._parse_hocr(hocr, "+".join(langs))

    @staticmethod
    def _bbox(title: str) -> list[list[float]]:
        for part in title.split(";"):
            part = part.strip()
            if part.startswith("bbox "):
                x0, y0, x1, y1 = (float(v) for v in part.split()[1:5])
                return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
        return []

    def _parse_hocr(self, hocr: str, langs: str) -> OcrPage:
        try:
            root = ElementTree.fromstring(hocr)
        except ElementTree.ParseError as exc:
            raise ProviderError("Tesseract produced unparseable hOCR") from exc

        page_el = root.find(".//x:div[@class='ocr_page']", _NS)
        w = h = 0
        if page_el is not None:
            box = self._bbox(page_el.get("title", ""))
            if box:
                w, h = int(box[1][0]), int(box[2][1])

        lines: list[Line] = []
        texts: list[str] = []
        for el in root.findall(".//x:span[@class='ocr_line']", _NS):
            text = "".join(el.itertext()).strip()
            if not text:
                continue
            texts.append(text)
            lines.append(Line(text=text, polygon=self._bbox(el.get("title", "")), is_handwritten=None))

        return OcrPage(
            width=w,
            height=h,
            lines=lines,
            full_text="\n".join(texts),
            languages=langs.split("+"),
            model_version=f"tesseract:{langs}",
            provider=self.name,
        )

    def health(self) -> dict[str, Any]:
        exe = self._binary()
        if not exe:
            return {"provider": self.name, "configured": False, "reason": "tesseract binary not found"}
        langs = self._langs_installed()
        return {
            "provider": self.name,
            "configured": bool(langs),
            "reachable": True,
            "languages": sorted(langs),
            "handwriting": False,
            "note": "Printed text only. Handwriting is not supported by this provider.",
        }
