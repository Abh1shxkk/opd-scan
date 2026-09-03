"""Extraction of the diagnosis that is already written in the record.

This module is deliberately conservative. It is a *transcriber*, not a clinician:

* It only returns text that sits against a diagnosis label on the page. It never derives a
  diagnosis from symptoms, investigations, medicines or a procedure name.
* It never completes an illegible word. If the transcription is not confidently readable the entry
  is returned with status ``unreadable`` and the region, so a human reads the image instead.
* It never adds an ICD code. A code is carried only when one is literally written on the page, and
  it is stored verbatim, including a malformed one.
* It never expands an abbreviation. Recognised ambiguous abbreviations are *flagged* so the reviewer
  can see there is something to check, and the text is left exactly as written.
* Clinical qualifiers are preserved and reported as a separate field. A suspected, provisional,
  differential, ruled-out, negated or historical diagnosis is never promoted to a confirmed current
  one — including when the qualifier comes from the label ("Provisional Diagnosis") rather than the
  text.
* Multiple diagnoses stay separate, each with its own anchor, region and status. Conflicting entries
  on different pages are all kept; nothing is reconciled automatically.

``raw_text`` is the immutable transcription. ``cleaned_text`` only ever differs from it by
whitespace and stripped label punctuation — the transformation is listed in ``cleaning_applied`` so
it can be audited.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from app.processing.providers.base import Line, OcrPage

EXTRACTOR_VERSION = "diagnosis-extractor/1.0.0"

# Labels seen on the sample forms, including the misspelling printed on the ENT sheet.
ANCHORS: list[tuple[str, str]] = [
    (r"final\s+diagnos[ie]s", "final"),
    (r"provisional\s+diagnos[ie]s", "provisional"),
    (r"pre[\s\-]*op(?:erative)?\s+diagnos[ie]s", "provisional"),
    (r"post[\s\-]*op(?:erative)?\s+diagnos[ie]s", "final"),
    (r"discharge\s+diagnos[ie]s", "final"),
    (r"differential\s+diagnos[ie]s", "differential"),
    (r"provisional\s*/\s*final\s+diagnos[ie]s", "unspecified"),
    (r"diagnos[ie]s", "unspecified"),
    (r"deagnosis", "unspecified"),          # printed this way on the ENT examination sheet
    (r"impression", "unspecified"),
]

ICD_LABELS = [
    r"international\s+code\s+of\s+disease",
    r"\bi\.?\s?c\.?\s?d\.?\b",
]

# Qualifier cues found *inside* the value text. Matched case-insensitively on word boundaries.
QUALIFIER_PATTERNS: list[tuple[str, str]] = [
    (r"\br/?o\b|\brule[d]?\s+out\b", "ruled_out"),
    (r"\bk/?c/?o\b|\bknown\s+case\s+of\b|\bh/?o\b|\bpast\s+history\b|\bs/?p\b|\bstatus\s+post\b", "past_history"),
    (r"\bd/?d\b|\bdifferential\b", "differential"),
    (r"\bsusp(?:ected|icion)?\b|\?\s*\w", "suspected"),
    (r"\bprovisional\b", "provisional"),
    (r"\bno\s+evidence\s+of\b|\bnot\s+\w+\b|\bnegative\s+for\b|\bruled\s+out\b", "negated"),
    (r"\bconfirmed\b|\bfinal\b", "final"),
]

# Abbreviations that are genuinely ambiguous in Indian hospital notes. They are FLAGGED, never
# expanded — several of these have more than one common reading.
AMBIGUOUS_ABBREVIATIONS = {
    "AUB", "TAH", "BSO", "LSCS", "PID", "COPD", "CVA", "MI", "DM", "HTN", "TB", "AKI", "CKD",
    "CA", "RTA", "ARDS", "UTI", "IHD", "CLD", "SOB", "GTCS", "OA", "RA", "PT", "AV", "IUD",
}

_MULTI_SPLIT = re.compile(r"\s*(?:;|\band\b|\+|/{2,}|,\s*(?=[A-Z]))\s*")

STATUS_PENDING = "extracted_pending_review"
STATUS_NOT_FOUND = "not_found"
STATUS_UNREADABLE = "unreadable"
STATUS_UNCERTAIN = "uncertain"
STATUS_FAILED = "processing_failed"


@dataclass
class DiagnosisCandidate:
    status: str
    anchor_label: str
    raw_text: str
    cleaned_text: str
    qualifier: str
    icd_code_verbatim: str | None
    region: dict[str, int] | None
    confidence: float | None
    is_handwritten: bool
    cleaning_applied: list[str] = field(default_factory=list)
    ambiguous_abbreviations: list[str] = field(default_factory=list)
    note: str = ""

    def to_json(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "anchor_label": self.anchor_label,
            "raw_text": self.raw_text,
            "cleaned_text": self.cleaned_text,
            "qualifier": self.qualifier,
            "icd_code_verbatim": self.icd_code_verbatim,
            "region": self.region,
            "confidence": self.confidence,
            "is_handwritten": self.is_handwritten,
            "cleaning_applied": self.cleaning_applied,
            "ambiguous_abbreviations": self.ambiguous_abbreviations,
            "note": self.note,
        }


def _bbox(poly: list[list[float]]) -> dict[str, int] | None:
    if not poly:
        return None
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    return {"x": int(min(xs)), "y": int(min(ys)), "w": int(max(xs) - min(xs)), "h": int(max(ys) - min(ys))}


def _union(regions: list[dict[str, int] | None]) -> dict[str, int] | None:
    rs = [r for r in regions if r]
    if not rs:
        return None
    x0 = min(r["x"] for r in rs)
    y0 = min(r["y"] for r in rs)
    x1 = max(r["x"] + r["w"] for r in rs)
    y1 = max(r["y"] + r["h"] for r in rs)
    return {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}


def _clean(raw: str) -> tuple[str, list[str]]:
    """Presentation-only tidying. Every transformation is named so it can be audited.

    Nothing here changes clinical meaning: no expansion, no spelling correction, no reordering.
    """
    applied: list[str] = []
    text = raw
    if text != text.strip():
        applied.append("trimmed surrounding whitespace")
        text = text.strip()
    collapsed = re.sub(r"[ \t]{2,}", " ", text)
    if collapsed != text:
        applied.append("collapsed repeated spaces")
        text = collapsed
    stripped = re.sub(r"^[\s:.\-–—]+", "", text)
    if stripped != text:
        applied.append("removed leading label punctuation")
        text = stripped
    joined = re.sub(r"\s*\n\s*", " ", text)
    if joined != text:
        applied.append("joined wrapped lines")
        text = joined
    return text, applied


def _qualifier_from_text(text: str, label_qualifier: str) -> str:
    low = text.lower()
    for pattern, qualifier in QUALIFIER_PATTERNS:
        if re.search(pattern, low):
            # A qualifier written in the text always wins over one implied by the label: a line
            # reading "r/o TB" under a "Final Diagnosis" heading is still a rule-out.
            return qualifier
    return label_qualifier


def _legibility(text: str, confidence: float | None) -> tuple[bool, str]:
    """Decide whether a transcription is readable enough to present as text.

    Returns (is_readable, reason). Nothing is repaired; an unreadable entry keeps its raw text so a
    reviewer can compare it against the image, and is labelled as unreadable.
    """
    stripped = text.strip()
    if len(stripped) < 2:
        return False, "transcription too short to be meaningful"
    letters = sum(1 for ch in stripped if ch.isalpha())
    if letters / max(len(stripped), 1) < 0.45:
        return False, "transcription is mostly non-alphabetic characters"
    if confidence is not None and confidence < 0.35:
        return False, f"provider confidence {confidence:.2f} below the legibility floor"
    return True, ""


def _find_ambiguous(text: str) -> list[str]:
    tokens = set(re.findall(r"\b[A-Z][A-Z/]{1,6}\b", text))
    return sorted({t.replace("/", "") for t in tokens} & AMBIGUOUS_ABBREVIATIONS)


def _line_bottom(line: Line) -> float:
    return max((p[1] for p in line.polygon), default=0.0)


def _line_top(line: Line) -> float:
    return min((p[1] for p in line.polygon), default=0.0)


def _line_right(line: Line) -> float:
    return max((p[0] for p in line.polygon), default=0.0)


def extract(page: OcrPage, max_continuation_lines: int = 3) -> list[DiagnosisCandidate]:
    """Find every diagnosis entry on one page.

    Returns an empty list when the page carries no diagnosis label at all; the caller records that
    as ``not_found`` for the page, which is a different thing from ``processing_failed``.
    """
    lines = [ln for ln in page.lines if (ln.text or "").strip()]
    if not lines:
        return []

    lines = sorted(lines, key=lambda ln: (_line_top(ln), min((p[0] for p in ln.polygon), default=0.0)))
    heights = [max(1.0, _line_bottom(ln) - _line_top(ln)) for ln in lines]
    med_h = sorted(heights)[len(heights) // 2] if heights else 12.0

    # ICD codes are collected first so a code written on the following row can be attached to the
    # diagnosis above it — but only when one is actually present.
    icd_by_position: list[tuple[float, str]] = []
    for ln in lines:
        text = ln.text or ""
        for pattern in ICD_LABELS:
            m = re.search(pattern, text, re.IGNORECASE)
            if m:
                after = text[m.end() :]
                code = re.search(r"[A-Z]{1,2}\s?[-–]?\s?\d{1,3}(?:\.\d{1,3})?", after)
                if code:
                    icd_by_position.append((_line_top(ln), code.group(0).strip()))
                break

    results: list[DiagnosisCandidate] = []
    used: set[int] = set()

    for i, ln in enumerate(lines):
        if i in used:
            continue
        text = ln.text or ""
        matched: tuple[re.Match[str], str] | None = None
        for pattern, label_qualifier in ANCHORS:
            m = re.search(pattern, text, re.IGNORECASE)
            if m:
                matched = (m, label_qualifier)
                break
        if not matched:
            continue
        m, label_qualifier = matched
        anchor_label = text[m.start() : m.end()].strip()

        # Value on the same line, after the label.
        value_parts = [text[m.end() :]]
        regions = [_bbox(ln.polygon)]
        confidences = [ln.confidence] if ln.confidence is not None else []
        handwritten = bool(ln.is_handwritten)
        used.add(i)

        inline = re.sub(r"^[\s:.\-–—]+", "", value_parts[0]).strip()

        # If the label line carries nothing after it, the value is on the following line(s) —
        # which is how the discharge summary block on the admission slip is laid out.
        if len(inline) < 2:
            taken = 0
            for j in range(i + 1, min(i + 1 + max_continuation_lines, len(lines))):
                nxt = lines[j]
                if _line_top(nxt) - _line_bottom(ln) > med_h * 2.5:
                    break
                nxt_text = (nxt.text or "").strip()
                if not nxt_text:
                    break
                if any(re.search(p, nxt_text, re.IGNORECASE) for p, _ in ANCHORS):
                    break
                if any(re.search(p, nxt_text, re.IGNORECASE) for p in ICD_LABELS):
                    break
                value_parts.append("\n" + nxt_text)
                regions.append(_bbox(nxt.polygon))
                if nxt.confidence is not None:
                    confidences.append(nxt.confidence)
                handwritten = handwritten or bool(nxt.is_handwritten)
                used.add(j)
                taken += 1
            if taken == 0:
                results.append(
                    DiagnosisCandidate(
                        status=STATUS_NOT_FOUND,
                        anchor_label=anchor_label,
                        raw_text="",
                        cleaned_text="",
                        qualifier=label_qualifier,
                        icd_code_verbatim=None,
                        region=_bbox(ln.polygon),
                        confidence=ln.confidence,
                        is_handwritten=handwritten,
                        note="A diagnosis label is present on the page but no value was read next to it.",
                    )
                )
                continue

        raw_value = "".join(value_parts)
        raw_value = re.sub(r"^[\s:.\-–—]+", "", raw_value)
        region = _union(regions)
        conf = min(confidences) if confidences else None

        # Attach an ICD code only if one appears on the page close below this entry.
        icd = None
        if region:
            for y, code in icd_by_position:
                if region["y"] - med_h <= y <= region["y"] + region["h"] + med_h * 3:
                    icd = code
                    break

        # Several diagnoses on one line stay separate entries, each keeping the same anchor,
        # region and source. They are never merged into a single string.
        pieces = [p.strip() for p in _MULTI_SPLIT.split(raw_value) if len(p.strip()) >= 2]
        if not pieces:
            pieces = [raw_value]

        for piece in pieces:
            cleaned, applied = _clean(piece)
            readable, reason = _legibility(cleaned, conf)
            qualifier = _qualifier_from_text(cleaned, label_qualifier)
            ambiguous = _find_ambiguous(cleaned)

            if not readable:
                status = STATUS_UNREADABLE
                note = f"Not transcribed with confidence: {reason}. Read the highlighted region on the image."
            elif conf is not None and conf < 0.6:
                status = STATUS_UNCERTAIN
                note = f"Low provider confidence ({conf:.2f}). Confirm against the image before use."
            elif handwritten:
                status = STATUS_PENDING
                note = "Handwritten source — confirm the transcription against the image."
            else:
                status = STATUS_PENDING
                note = ""

            if ambiguous:
                note = (note + " " if note else "") + (
                    "Contains abbreviations that were left exactly as written and not expanded: "
                    + ", ".join(ambiguous)
                    + "."
                )

            results.append(
                DiagnosisCandidate(
                    status=status,
                    anchor_label=anchor_label,
                    raw_text=piece,
                    cleaned_text=cleaned if readable else "",
                    qualifier=qualifier,
                    icd_code_verbatim=icd,
                    region=region,
                    confidence=conf,
                    is_handwritten=handwritten,
                    cleaning_applied=applied,
                    ambiguous_abbreviations=ambiguous,
                    note=note.strip(),
                )
            )

    return results
