"""
VLM Management API Controller
VLM 모델 스위칭 및 설정 관리를 위한 API 엔드포인트
"""
import logging
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException
from typing import Dict, Any, Optional
from pydantic import BaseModel

# 프로젝트 루트 경로를 Python path에 추가
project_root = Path(__file__).parent.parent.parent
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

try:
    from core.vlm_manager import get_vlm_manager
except ImportError as e:
    logging.error(f"Failed to import VLM manager: {e}")
    get_vlm_manager = None

router = APIRouter()
logger = logging.getLogger(__name__)


class SwitchModelRequest(BaseModel):
    """VLM 모델 스위칭 요청 모델"""
    model: str


class UpdateModelConfigRequest(BaseModel):
    """VLM 모델 설정 업데이트 요청 모델"""
    model_name: str
    config: Dict[str, Any]


@router.get("/api/vlm/models")
async def get_available_models():
    """
    사용 가능한 VLM 모델 목록 반환
    
    Returns:
        사용 가능한 모델 목록과 각 모델의 정보
    """
    try:
        if get_vlm_manager is None:
            logger.error("VLM manager is not available")
            raise HTTPException(status_code=503, detail="VLM manager is not available")
        
        vlm_manager = get_vlm_manager()
        models = vlm_manager.get_available_models()
        logger.info(f"Available models: {list(models.keys())}")
        return {"models": models}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get available models: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to get available models: {str(e)}")


@router.get("/api/vlm/current")
async def get_current_model():
    """
    현재 사용 중인 VLM 모델 정보 반환
    
    Returns:
        현재 모델 정보
    """
    try:
        if get_vlm_manager is None:
            logger.error("VLM manager is not available")
            raise HTTPException(status_code=503, detail="VLM manager is not available")
        
        vlm_manager = get_vlm_manager()
        current_model = vlm_manager.get_current_model()
        model_info = vlm_manager.get_model_info(current_model)
        
        logger.info(f"Current model: {current_model}")
        return {
            "current_model": current_model,
            "model_info": model_info
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get current model: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to get current model: {str(e)}")


@router.get("/api/vlm/config")
async def get_vlm_config():
    """
    VLM 설정 요약 정보 반환
    
    Returns:
        VLM 설정 요약
    """
    try:
        vlm_manager = get_vlm_manager()
        config_summary = vlm_manager.get_config_summary()
        return config_summary
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get VLM config: {str(e)}")


@router.get("/api/vlm/history")
async def get_change_history(limit: int = 10):
    """
    VLM 모델 변경 이력 반환
    
    Args:
        limit: 반환할 이력 개수 (기본값: 10)
    
    Returns:
        모델 변경 이력
    """
    try:
        vlm_manager = get_vlm_manager()
        history = vlm_manager.get_change_history(limit)
        return {"history": history}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get change history: {str(e)}")


@router.post("/api/vlm/switch")
async def switch_vlm_model(request: SwitchModelRequest):
    """
    VLM 모델 스위칭
    
    Args:
        request: 모델 스위칭 요청 (model: 모델 이름)
    
    Returns:
        스위칭 결과
    """
    try:
        vlm_manager = get_vlm_manager()
        model_name = request.model
        
        # 모델 이름 유효성 검사
        available_models = vlm_manager.get_available_models()
        if model_name not in available_models:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid model name: {model_name}. Available models: {list(available_models.keys())}"
            )
        
        # 모델 스위칭
        success = vlm_manager.switch_model(model_name)
        
        if success:
            return {
                "status": "success",
                "message": f"VLM model switched to {model_name}",
                "current_model": model_name,
                "previous_model": vlm_manager.get_model_info(model_name)
            }
        else:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to switch VLM model to {model_name}"
            )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to switch VLM model: {str(e)}")


@router.post("/api/vlm/config/update")
async def update_vlm_model_config(request: UpdateModelConfigRequest):
    """
    특정 VLM 모델의 설정 업데이트
    
    Args:
        request: 모델 설정 업데이트 요청
    
    Returns:
        업데이트 결과
    """
    try:
        vlm_manager = get_vlm_manager()
        model_name = request.model_name
        model_config = request.config
        
        # 모델 이름 유효성 검사
        available_models = vlm_manager.get_available_models()
        if model_name not in available_models:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid model name: {model_name}. Available models: {list(available_models.keys())}"
            )
        
        # 모델 설정 업데이트
        success = vlm_manager.update_model_config(model_name, model_config)
        
        if success:
            return {
                "status": "success",
                "message": f"VLM model config updated for {model_name}",
                "model_name": model_name,
                "updated_config": model_config
            }
        else:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to update VLM model config for {model_name}"
            )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update VLM model config: {str(e)}")


@router.post("/api/vlm/reset")
async def reset_vlm_config():
    """
    VLM 설정을 기본값으로 초기화
    
    Returns:
        초기화 결과
    """
    try:
        vlm_manager = get_vlm_manager()
        success = vlm_manager.reset_to_default()
        
        if success:
            return {
                "status": "success",
                "message": "VLM config reset to default",
                "current_model": vlm_manager.get_current_model()
            }
        else:
            raise HTTPException(
                status_code=500,
                detail="Failed to reset VLM config"
            )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to reset VLM config: {str(e)}")


@router.get("/api/vlm/model/{model_name}")
async def get_model_info(model_name: str):
    """
    특정 VLM 모델의 정보 반환
    
    Args:
        model_name: 모델 이름
    
    Returns:
        모델 정보
    """
    try:
        vlm_manager = get_vlm_manager()
        model_info = vlm_manager.get_model_info(model_name)
        
        if model_info is None:
            raise HTTPException(
                status_code=404,
                detail=f"Model not found: {model_name}"
            )
        
        return {
            "model_name": model_name,
            "model_info": model_info
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get model info: {str(e)}")