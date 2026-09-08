"""
VLM Configuration Pattern Implementation
VLM 모델 설정을 중앙화하고 영속성을 제공하는 설정 패턴 구현
"""
import os
import json
import logging
from pathlib import Path
from typing import Dict, Any, Optional
from datetime import datetime

logger = logging.getLogger(__name__)


class VLMConfig:
    """VLM 설정 관리 클래스"""
    
    def __init__(self, config_dir: Optional[Path] = None):
        """
        VLMConfig 초기화
        
        Args:
            config_dir: 설정 파일 저장 디렉토리 (기본값: 프로젝트 루트)
        """
        if config_dir is None:
            # 프로젝트 루트 디렉토리 찾기
            current_file = Path(__file__)
            project_root = current_file.parent.parent
            config_dir = project_root / "config"
        
        self.config_dir = Path(config_dir)
        self.config_dir.mkdir(parents=True, exist_ok=True)
        
        self.config_file = self.config_dir / "vlm_config.json"
        
        # 기본 설정
        self.default_config = {
            "current_model": os.getenv("VLM_CURRENT_MODEL", "LLM-27B"),
            "fallback_model": os.getenv("VLM_FALLBACK_MODEL", "LLM-122B"),
            "base_url": os.getenv("VLM_BASE_URL", "http://127.0.0.1:8000/v1"),
            "api_key": os.getenv("VLM_API_KEY", "not-configured"),
            "available_models": {
                "LLM-27B": {
                    "name": "LLM-27B",
                    "speed": "fast",
                    "accuracy": "medium",
                    "timeout": 180,
                    "description": "빠른 처리 속도, 중간 정확도"
                },
                "LLM-122B": {
                    "name": "LLM-122B",
                    "speed": "slow",
                    "accuracy": "high",
                    "timeout": 300,
                    "description": "높은 정확도, 느린 처리 속도"
                }
            },
            "last_updated": None,
            "change_history": []
        }
        
        # 설정 로드
        self.config = self._load_config()
    
    def _load_config(self) -> Dict[str, Any]:
        """설정 파일에서 설정 로드"""
        if not self.config_file.exists():
            logger.info(f"VLM 설정 파일이 없습니다. 기본 설정을 사용합니다: {self.config_file}")
            return self.default_config.copy()
        
        try:
            with open(self.config_file, 'r', encoding='utf-8') as f:
                loaded_config = json.load(f)
            
            # 로드된 설정과 기본 설정 병합 (새로운 필드 추가 지원)
            merged_config = self.default_config.copy()
            merged_config.update(loaded_config)
            
            logger.info(f"VLM 설정 로드 완료: {self.config_file}")
            return merged_config
            
        except Exception as e:
            logger.error(f"VLM 설정 로드 실패: {e}, 기본 설정 사용")
            return self.default_config.copy()
    
    def _save_config(self) -> bool:
        """설정을 파일에 저장"""
        try:
            self.config["last_updated"] = datetime.now().isoformat()
            
            with open(self.config_file, 'w', encoding='utf-8') as f:
                json.dump(self.config, f, indent=2, ensure_ascii=False)
            
            logger.info(f"VLM 설정 저장 완료: {self.config_file}")
            return True
            
        except Exception as e:
            logger.error(f"VLM 설정 저장 실패: {e}")
            return False
    
    def get_current_model(self) -> str:
        """현재 선택된 모델 이름 반환"""
        return self.config.get("current_model", "LLM-27B")
    
    def get_fallback_model(self) -> str:
        """폴백 모델 이름 반환"""
        return self.config.get("fallback_model", "LLM-122B")
    
    def get_base_url(self) -> str:
        """VLM API 기본 URL 반환"""
        return self.config.get("base_url", "http://127.0.0.1:8000/v1")
    
    def get_api_key(self) -> str:
        """VLM API 키 반환"""
        return self.config.get("api_key", "")
    
    def get_available_models(self) -> Dict[str, Dict[str, Any]]:
        """사용 가능한 모델 목록 반환"""
        return self.config.get("available_models", {})
    
    def get_model_info(self, model_name: str) -> Optional[Dict[str, Any]]:
        """특정 모델의 정보 반환"""
        models = self.get_available_models()
        return models.get(model_name)
    
    def set_current_model(self, model_name: str) -> bool:
        """
        현재 모델 설정
        
        Args:
            model_name: 설정할 모델 이름
            
        Returns:
            성공 여부
        """
        available_models = self.get_available_models()
        
        if model_name not in available_models:
            logger.error(f"잘못된 모델 이름: {model_name}")
            return False
        
        old_model = self.get_current_model()
        
        # 변경 이력 기록
        history_entry = {
            "timestamp": datetime.now().isoformat(),
            "from_model": old_model,
            "to_model": model_name,
            "user": "system"  # 추후 사용자 인증 시 실제 사용자 정보로 대체
        }
        
        self.config["current_model"] = model_name
        self.config["change_history"].append(history_entry)
        
        # 이력 최대 100개로 제한
        if len(self.config["change_history"]) > 100:
            self.config["change_history"] = self.config["change_history"][-100:]
        
        success = self._save_config()
        
        if success:
            logger.info(f"VLM 모델 변경: {old_model} -> {model_name}")
        
        return success
    
    def get_change_history(self, limit: int = 10) -> list:
        """
        모델 변경 이력 반환
        
        Args:
            limit: 반환할 이력 개수
            
        Returns:
            변경 이력 리스트
        """
        history = self.config.get("change_history", [])
        return history[-limit:] if history else []
    
    def reset_to_default(self) -> bool:
        """기본 설정으로 초기화"""
        self.config = self.default_config.copy()
        return self._save_config()
    
    def update_model_config(self, model_name: str, model_config: Dict[str, Any]) -> bool:
        """
        특정 모델의 설정 업데이트
        
        Args:
            model_name: 모델 이름
            model_config: 업데이트할 모델 설정
            
        Returns:
            성공 여부
        """
        available_models = self.get_available_models()
        
        if model_name not in available_models:
            logger.error(f"존재하지 않는 모델: {model_name}")
            return False
        
        # 모델 설정 업데이트
        available_models[model_name].update(model_config)
        self.config["available_models"] = available_models
        
        return self._save_config()
    
    def get_config_summary(self) -> Dict[str, Any]:
        """설정 요약 정보 반환"""
        return {
            "current_model": self.get_current_model(),
            "fallback_model": self.get_fallback_model(),
            "available_models": list(self.get_available_models().keys()),
            "last_updated": self.config.get("last_updated"),
            "total_changes": len(self.config.get("change_history", []))
        }


# 전역 VLM 설정 인스턴스
_vlm_config_instance: Optional[VLMConfig] = None


def get_vlm_config() -> VLMConfig:
    """전역 VLM 설정 인스턴스 반환 (싱글톤 패턴)"""
    global _vlm_config_instance
    
    if _vlm_config_instance is None:
        _vlm_config_instance = VLMConfig()
    
    return _vlm_config_instance