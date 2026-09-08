from __future__ import annotations

import io
import time
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from PIL import Image

try:
    import fitz  # type: ignore
except Exception as exc:
    fitz = None
    _fitz_import_error = exc

from .. import config
from ..services.model_state import ModelState
from ..utils.image_utils import pil_to_base64_png
from ..utils.pdf_utils import render_pdf_page_to_pil

router = APIRouter()
STATE = ModelState()


@asynccontextmanager
async def lifespan(app):
    try:
        STATE.load()
    except Exception:
        pass
    yield


@router.get("/health")
async def health():
    return {
        "status": "healthy",
        "service": "document-filter",
        "model_loaded": STATE.model is not None,
        "device": str(STATE.device),
        "model_path": config.MODEL_PATH,
        "pdf_backend": "pymupdf" if fitz is not None else "missing",
    }


@router.post("/filter_pdf")
async def filter_pdf(
    file: UploadFile = File(...),
    return_images: bool = True,
    dpi: int = 300,
    max_pages: Optional[int] = None,
):
    if fitz is None:
        raise HTTPException(status_code=500, detail=f"PyMuPDF(fitz) import 실패: {_fitz_import_error}")

    filename = file.filename or "unknown.pdf"
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="PDF 파일만 지원합니다.")

    try:
        pdf_bytes = await file.read()
        if not pdf_bytes:
            raise ValueError("빈 PDF 입니다.")

        t0 = time.time()
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        total_pages = doc.page_count
        if max_pages is not None:
            total_to_process = max(0, min(int(max_pages), total_pages))
        else:
            total_to_process = total_pages

        interest_items: List[Dict[str, Any]] = []
        processed = 0

        for page_index in range(total_to_process):
            processed += 1
            img = render_pdf_page_to_pil(doc, page_index=page_index, dpi=int(dpi))
            pred = STATE.infer_pil(img)
            if pred["is_interest"]:
                item: Dict[str, Any] = {
                    "page_index": page_index,
                    "doc_index": pred["doc_index"],
                    "label": pred["label"],
                    "score": pred["score"],
                }
                if return_images:
                    item["image_base64"] = pil_to_base64_png(img)
                interest_items.append(item)

        elapsed = time.time() - t0
        return JSONResponse(
            content={
                "success": True,
                "filename": filename,
                "total_pages": total_pages,
                "processed_pages": processed,
                "interest_pages": len(interest_items),
                "items": interest_items,
                "elapsed_sec": round(elapsed, 3),
            }
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"PDF 처리 중 오류: {exc}")


@router.post("/filter_image")
async def filter_image(
    file: UploadFile = File(...),
    return_image: bool = False,
):
    try:
        raw = await file.read()
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        pred = STATE.infer_pil(img)
        out: Dict[str, Any] = {"success": True, "filename": file.filename, **pred}
        if return_image:
            out["image_base64"] = pil_to_base64_png(img)
        return out
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"이미지 처리 중 오류: {exc}")
