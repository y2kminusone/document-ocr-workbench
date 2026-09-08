from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Optional
import logging

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from .. import config
from ..services.detect_service import detect_image, ensure_model_loaded
from ..services.model_loader import get_model

router = APIRouter()
logger = logging.getLogger("yolo")


@asynccontextmanager
async def lifespan(app):
    ensure_model_loaded()
    yield


@router.get("/")
async def root():
    model = get_model()
    return {
        "status": "running",
        "model_path": config.MODEL_PATH,
        "model_loaded": model is not None,
        "classes": model.names if model else None,
    }


@router.get("/health")
async def health_check():
    model = get_model()
    return {"status": "healthy", "model_loaded": model is not None}


@router.post("/detect")
async def detect_and_crop(file: UploadFile = File(...), rotation: Optional[str] = None, file_id: Optional[str] = None):
    logger.info(f"[CONTROLLER] /detect 요청 수신 - file: {file.filename}, rotation: {rotation}, file_id: {file_id}")
    try:
        image_bytes = await file.read()
        logger.info(f"[CONTROLLER] 이미지 읽기 완료 - 크기: {len(image_bytes)} bytes")
        result = detect_image(image_bytes, rotation, file_id)
        logger.info(f"[CONTROLLER] Detection 완료 - 결과 반환")
        return JSONResponse(content=result)
    except Exception as exc:
        logger.error(f"[CONTROLLER] Detection 중 오류 발생: {str(exc)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"처리 중 오류 발생: {str(exc)}")


@router.post("/detect_simple")
async def detect_simple(file: UploadFile = File(...)):
    return await detect_and_crop(file, rotation=None)
