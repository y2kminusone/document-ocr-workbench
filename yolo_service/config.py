from __future__ import annotations

import os

MODEL_PATH = os.getenv(
    "YOLO_MODEL_PATH",
    "models/document-regions.pt",
)
