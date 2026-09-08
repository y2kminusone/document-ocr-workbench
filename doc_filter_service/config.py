from __future__ import annotations

import os

MODEL_PATH = os.getenv(
    "DOC_CLS_MODEL_PATH",
    "models/document-classifier.pth",
)

LABEL1_CLS_DICT = {0: "int_ver", 1: "int_hori", 2: "no_int_ver", 3: "no_int_hori"}
INTEREST_CLASS_INDICES = {0, 1}

os.environ.setdefault("TORCH_HOME", os.getenv("TORCH_HOME", "models"))
