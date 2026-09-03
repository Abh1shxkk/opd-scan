"""Run the quality engine over a folder of PDFs/images and print a per-page table.

Used to tune thresholds against real material before deployment. It does not touch the database
and does not send anything to a provider.

    python -m tools.calibrate /path/to/pdfs --dpi 150 --csv out.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.processing.quality.metrics import measure  # noqa: E402
from app.processing.quality.rules import judge  # noqa: E402


def iter_pages(path: Path, dpi: int):
    if path.suffix.lower() == ".pdf":
        import pymupdf

        doc = pymupdf.open(path)
        for i in range(doc.page_count):
            pix = doc[i].get_pixmap(dpi=dpi)
            buf = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
            if pix.n == 4:
                img = cv2.cvtColor(buf, cv2.COLOR_RGBA2BGR)
            elif pix.n == 3:
                img = cv2.cvtColor(buf, cv2.COLOR_RGB2BGR)
            else:
                img = cv2.cvtColor(buf, cv2.COLOR_GRAY2BGR)
            yield i + 1, img
        doc.close()
    else:
        img = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if img is not None:
            yield 1, img


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("--dpi", type=int, default=150)
    ap.add_argument("--csv", default="")
    ap.add_argument("--json", default="")
    args = ap.parse_args()

    root = Path(args.target)
    files = sorted(root.glob("*.pdf")) if root.is_dir() else [root]

    rows = []
    t0 = time.time()
    for f in files:
        for pno, img in iter_pages(f, args.dpi):
            t1 = time.time()
            m = measure(img)
            j = judge(m)
            dt = time.time() - t1
            codes = ",".join(sorted({x.code for x in j.findings}))
            rows.append(
                {
                    "file": f.name,
                    "page": pno,
                    "class": j.overall,
                    "score": j.score,
                    "defects": codes,
                    "profile": m.capture_profile,
                    "colour": m.colour_mode,
                    "spread": int(m.likely_spread),
                    "ink%": round(m.ink_coverage * 100, 3),
                    "textink%": round(m.text_ink_coverage * 100, 3),
                    "contrast": round(m.ink_paper_contrast, 1),
                    "sharp": round(m.stroke_sharpness, 4),
                    "tenengrad": round(m.tenengrad, 1),
                    "luma": round(m.median_luma, 1),
                    "noise": round(m.noise_sigma, 2),
                    "skew": round(m.skew_deg, 2),
                    "rot": m.rotation_deg,
                    "texth": round(m.est_text_height_px, 1),
                    "secs": round(dt, 3),
                }
            )
            print(
                f"{f.name[:26]:26} p{pno:>3} {j.overall:>10} {j.score:>5.2f} "
                f"{m.capture_profile:>7} {m.colour_mode:>7} ink{m.ink_coverage*100:6.2f}% "
                f"ct{m.ink_paper_contrast:5.0f} sh{m.stroke_sharpness:6.3f} lum{m.median_luma:5.0f} "
                f"nz{m.noise_sigma:5.1f} sk{m.skew_deg:+5.1f} {codes}"
            )

    total = time.time() - t0
    print(f"\n{len(rows)} pages in {total:.1f}s  ({total / max(len(rows),1):.2f} s/page)")

    from collections import Counter

    print("classes:", dict(Counter(r["class"] for r in rows)))
    dc: Counter = Counter()
    for r in rows:
        for c in filter(None, r["defects"].split(",")):
            dc[c] += 1
    print("defects:", dict(dc))

    if args.csv:
        with open(args.csv, "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
    if args.json:
        Path(args.json).write_text(json.dumps(rows, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
