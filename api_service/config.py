from __future__ import annotations

import os
from pathlib import Path

API_HOST = os.getenv("API_HOST", "127.0.0.1")
API_PORT = int(os.getenv("API_PORT", "8010"))

YOLO_SERVER_URL = os.getenv("YOLO_SERVER_URL", "http://localhost:8011")
OCR_SERVER_URL = os.getenv("OCR_SERVER_URL", "http://localhost:8012")
DOC_FILTER_SERVER_URL = os.getenv("DOC_FILTER_SERVER_URL", "http://localhost:8013")

PDF_OCR_WORKERS = max(1, int(os.getenv("PDF_OCR_WORKERS", "2")))

BASE_DIR = Path(__file__).resolve().parent.parent
STORAGE_DIR = Path(os.getenv("STORAGE_DIR", str(BASE_DIR / "storage_web"))).resolve()

UPLOADS_DIR = STORAGE_DIR / "uploads"
PDFS_DIR = STORAGE_DIR / "pdfs"
DERIVED_DIR = STORAGE_DIR / "derived"
RESULTS_DIR = STORAGE_DIR / "results"
INDEX_DIR = STORAGE_DIR / "index"
JOBS_MANIFEST_PATH = INDEX_DIR / "jobs.json"
FILES_MANIFEST_PATH = INDEX_DIR / "files.json"


def ensure_dirs() -> None:
    for path in [UPLOADS_DIR, PDFS_DIR, DERIVED_DIR, RESULTS_DIR, INDEX_DIR]:
        path.mkdir(parents=True, exist_ok=True)
