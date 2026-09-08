from __future__ import annotations

from fastapi import APIRouter

from .. import config

router = APIRouter()


@router.get("/api/health")
async def api_health():
    return {
        "status": "ok",
        "yolo": config.YOLO_SERVER_URL,
        "ocr": config.OCR_SERVER_URL,
        "doc_filter": config.DOC_FILTER_SERVER_URL,
        "storage": str(config.STORAGE_DIR),
    }
