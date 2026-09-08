"""Run from repository root: python -m examples.review_history
All values are invented; this demonstrates review history, not OCR inference.
"""
import json
from core.ocr_db import build_cell_diffs

before = [{"row_index": 0, "C": "0.12", "Mn": "1.02"}]
after = [{"C": "0.15", "Mn": "1.02"}]
print(json.dumps(build_cell_diffs(before, after), ensure_ascii=False, indent=2))
