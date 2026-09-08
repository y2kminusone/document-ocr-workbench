from __future__ import annotations

from typing import Optional

from core.ocr_processor import OCRProcessor

_processor: Optional[OCRProcessor] = None


def get_processor() -> OCRProcessor:
    global _processor
    if _processor is None:
        _processor = OCRProcessor()
    return _processor
