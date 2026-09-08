from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from ..models.schemas import ProcessCropsRequest, YOLOResultRequest
from ..services.processor_service import get_processor

router = APIRouter()


def _redact_image_urls(text: str) -> str:
    redacted = re.sub(r"data:image/[^;]+;base64,[A-Za-z0-9+/=]+", "<redacted:data-url-base64>", str(text or ""))
    redacted = re.sub(
        r"(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{200,}={0,2}(?![A-Za-z0-9+/=])",
        "<redacted:base64>",
        redacted,
    )
    redacted = re.sub(r"https?://\S+", "<redacted:url>", redacted)
    return redacted


@router.get("/")
async def root():
    return {"status": "running", "service": "OCR Processor Server", "version": "1.0.0"}


@router.get("/health")
async def health_check():
    return {"status": "healthy"}


@router.post("/process_crops")
async def process_crops(request: ProcessCropsRequest):
    try:
        processor = get_processor()
        result = processor.process_crops(
            chemical_crops=request.chemical_crops,
            table_crops=request.table_crops,
            original_image_base64=request.original_image,
            image_name=request.image_name,
        )
        return JSONResponse(content={"success": True, **result})
    except Exception as exc:
        error_msg = _redact_image_urls(f"OCR 처리 중 오류 발생: {str(exc)}")
        print(f"[ERROR] {error_msg}")
        import traceback

        print(_redact_image_urls(traceback.format_exc()))
        raise HTTPException(status_code=500, detail=error_msg)


@router.post("/process_from_yolo")
async def process_from_yolo(request: YOLOResultRequest):
    try:
        yolo_result = request.yolo_result
        chemical_crops = yolo_result.get("chemical_crops", [])
        table_crops = yolo_result.get("table_crops", [])
        original_image = yolo_result.get("original_image", "")

        if not original_image:
            raise ValueError("원본 이미지가 YOLO 결과에 없습니다.")

        processor = get_processor()
        result = processor.process_crops(
            chemical_crops=chemical_crops,
            table_crops=table_crops,
            original_image_base64=original_image,
            image_name=request.image_name,
        )

        return JSONResponse(content={"success": True, **result})
    except Exception as exc:
        error_msg = _redact_image_urls(f"OCR 처리 중 오류 발생: {str(exc)}")
        print(f"[ERROR] {error_msg}")
        import traceback

        print(_redact_image_urls(traceback.format_exc()))
        raise HTTPException(status_code=500, detail=error_msg)
