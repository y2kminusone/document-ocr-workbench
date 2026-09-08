"""
VLM Manager - Strategy + Config Pattern 통합 관리
VLM 모델의 런타임 스위칭과 설정 관리를 통합하는 매니저 클래스
"""
import logging
from typing import Dict, Any, Optional
from .vlm_strategy import VLMStrategy, VLMFactory
from .vlm_config import VLMConfig, get_vlm_config

logger = logging.getLogger(__name__)


class VLMManager:
    """VLM 관리자 - Strategy + Config Pattern 통합"""
    
    def __init__(self, config: Optional[VLMConfig] = None):
        """
        VLMManager 초기화
        
        Args:
            config: VLMConfig 인스턴스 (None이면 자동 생성)
        """
        self.config = config or get_vlm_config()
        self._strategy: Optional[VLMStrategy] = None
        self._initialize_strategy()
    
    def _initialize_strategy(self):
        """현재 설정에 따른 전략 초기화"""
        current_model = self.config.get_current_model()
        base_url = self.config.get_base_url()
        api_key = self.config.get_api_key()
        
        self._strategy = VLMFactory.create_strategy(current_model, base_url, api_key)
        logger.info(f"VLM 전략 초기화 완료: {current_model}")
    
    def call_vlm(self, image_url: str, prompt: str) -> str:
        """
        VLM API 호출
        
        Args:
            image_url: 이미지 URL
            prompt: 프롬프트
            
        Returns:
            VLM 응답 텍스트
        """
        if self._strategy is None:
            raise RuntimeError("VLM 전략이 초기화되지 않았습니다.")
        
        try:
            return self._strategy.call(image_url, prompt)
        except Exception as e:
            logger.error(f"VLM 호출 실패: {e}")
            # 폴백 모델로 시도
            fallback_model = self.config.get_fallback_model()
            if fallback_model != self.config.get_current_model():
                logger.info(f"폴백 모델로 시도: {fallback_model}")
                self.switch_model(fallback_model, silent=True)
                return self._strategy.call(image_url, prompt)
            raise
    
    def switch_model(self, model_name: str, silent: bool = False) -> bool:
        """
        VLM 모델 스위칭
        
        Args:
            model_name: 전환할 모델 이름
            silent: True면 설정 파일에 저장하지 않음
            
        Returns:
            성공 여부
        """
        available_models = self.config.get_available_models()
        
        if model_name not in available_models:
            logger.error(f"잘못된 모델 이름: {model_name}")
            return False
        
        old_model = self._strategy.get_name() if self._strategy else "None"
        
        # 새로운 전략 생성
        base_url = self.config.get_base_url()
        api_key = self.config.get_api_key()
        new_strategy = VLMFactory.create_strategy(model_name, base_url, api_key)
        
        # 전략 교체
        self._strategy = new_strategy
        
        # 설정 업데이트 (silent가 아니면)
        if not silent:
            success = self.config.set_current_model(model_name)
            if success:
                logger.info(f"VLM 모델 스위칭 완료: {old_model} -> {model_name}")
            else:
                logger.warning(f"VLM 모델 스위칭 성공 but 설정 저장 실패: {old_model} -> {model_name}")
            return success
        else:
            logger.info(f"VLM 모델 스위칭 (silent): {old_model} -> {model_name}")
            return True
    
    def get_current_model(self) -> str:
        """현재 모델 이름 반환"""
        return self._strategy.get_name() if self._strategy else "None"
    
    def get_available_models(self) -> Dict[str, Dict[str, Any]]:
        """사용 가능한 모델 목록 반환"""
        return self.config.get_available_models()
    
    def get_model_info(self, model_name: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """
        모델 정보 반환
        
        Args:
            model_name: 모델 이름 (None이면 현재 모델)
            
        Returns:
            모델 정보
        """
        if model_name is None:
            model_name = self.get_current_model()
        
        return self.config.get_model_info(model_name)
    
    def get_config_summary(self) -> Dict[str, Any]:
        """설정 요약 정보 반환"""
        summary = self.config.get_config_summary()
        summary["current_strategy"] = self.get_current_model()
        return summary
    
    def get_change_history(self, limit: int = 10) -> list:
        """모델 변경 이력 반환"""
        return self.config.get_change_history(limit)
    
    def reset_to_default(self) -> bool:
        """기본 설정으로 초기화"""
        success = self.config.reset_to_default()
        if success:
            self._initialize_strategy()
        return success
    
    def update_model_config(self, model_name: str, model_config: Dict[str, Any]) -> bool:
        """
        특정 모델의 설정 업데이트
        
        Args:
            model_name: 모델 이름
            model_config: 업데이트할 모델 설정
            
        Returns:
            성공 여부
        """
        success = self.config.update_model_config(model_name, model_config)
        
        # 현재 모델의 설정이 변경되었으면 전략 재초기화
        if success and model_name == self.get_current_model():
            self._initialize_strategy()
        
        return success


# 전역 VLM 매니저 인스턴스
_vlm_manager_instance: Optional[VLMManager] = None


def get_vlm_manager() -> VLMManager:
    """전역 VLM 매니저 인스턴스 반환 (싱글톤 패턴)"""
    global _vlm_manager_instance
    
    if _vlm_manager_instance is None:
        _vlm_manager_instance = VLMManager()
    
    return _vlm_manager_instance