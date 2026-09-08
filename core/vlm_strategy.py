"""
VLM Strategy Pattern Implementation
런타임에 VLM 모델을 교체 가능한 전략 패턴 구현
"""
from abc import ABC, abstractmethod
from typing import Dict, Any
import logging
import time
import threading
from openai import OpenAI

logger = logging.getLogger(__name__)


class VLMStrategy(ABC):
    """VLM 전략 인터페이스"""
    
    @abstractmethod
    def call(self, image_url: str, prompt: str) -> str:
        """VLM API 호출"""
        pass
    
    @abstractmethod
    def get_model_info(self) -> Dict[str, Any]:
        """모델 정보 반환"""
        pass
    
    @abstractmethod
    def get_name(self) -> str:
        """모델 이름 반환"""
        pass


class VLM27BStrategy(VLMStrategy):
    """LLM-27B 전략 구현"""
    
    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url
        self.api_key = api_key
        self.model_name = "LLM-27B"
        self.timeout = 180  # 3분
    
    def call(self, image_url: str, prompt: str) -> str:
        """LLM-27B API 호출"""
        return self._call_vlm_api(image_url, prompt, self.model_name)
    
    def _call_vlm_api(self, image_url: str, prompt: str, model: str) -> str:
        """VLM API 호출 공통 로직"""
        start_time = time.time()
        first_chunk_time = None
        chunk_count = 0
        timeout_occurred = False
        first_chunks = []
        last_chunks = []
        
        def timeout_handler():
            nonlocal timeout_occurred
            timeout_occurred = True
            elapsed = time.time() - start_time
            logger.error(f"[VLM][{model}] 타임아웃 발생: {elapsed:.2f}초, 청크 수: {chunk_count}")
        
        timer = threading.Timer(self.timeout, timeout_handler)
        timer.start()
        
        try:
            logger.info(f"[VLM][{model}] 요청 시작")
            client = OpenAI(base_url=self.base_url, api_key=self.api_key)
            completion = client.chat.completions.create(
                model=model,
                messages=[{
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": image_url}},
                        {"type": "text", "text": prompt}
                    ]
                }],
                temperature=0.000001,
                top_p=0.1,
                stream=True
            )
            
            response_text = ""
            for chunk in completion:
                if timeout_occurred:
                    break
                    
                if chunk.choices[0].delta.content:
                    chunk_content = chunk.choices[0].delta.content
                    
                    if first_chunk_time is None:
                        first_chunk_time = time.time()
                        first_chunk_latency = first_chunk_time - start_time
                        logger.info(f"[VLM][{model}] 첫 번째 청크 도착: {first_chunk_latency:.2f}초")
                    
                    if len(first_chunks) < 3:
                        first_chunks.append(chunk_content)
                    else:
                        last_chunks.append(chunk_content)
                        if len(last_chunks) > 3:
                            last_chunks.pop(0)
                    
                    response_text += chunk_content
                    chunk_count += 1
                    
                    if chunk_count % 10 == 0:
                        elapsed = time.time() - start_time
                        logger.info(f"[VLM][{model}] 진행 중: {elapsed:.2f}초, 청크 수: {chunk_count}")
            
            timer.cancel()
            
            if not timeout_occurred:
                total_time = time.time() - start_time
                logger.info(f"[VLM][{model}] 완료: 총 {total_time:.2f}초, 청크 수: {chunk_count}")
            
            return response_text.strip()
        except Exception as e:
            timer.cancel()
            elapsed = time.time() - start_time
            logger.error(f"[VLM][{model}] 에러 발생: {elapsed:.2f}초, 청크 수: {chunk_count}, 에러: {e}")
            raise
    
    def get_model_info(self) -> Dict[str, Any]:
        return {
            "name": self.model_name,
            "speed": "fast",
            "accuracy": "medium",
            "timeout": self.timeout,
            "description": "빠른 처리 속도, 중간 정확도"
        }
    
    def get_name(self) -> str:
        return self.model_name


class VLM122BStrategy(VLMStrategy):
    """LLM-122B 전략 구현"""
    
    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url
        self.api_key = api_key
        self.model_name = "LLM-122B"
        self.timeout = 300  # 5분
    
    def call(self, image_url: str, prompt: str) -> str:
        """LLM-122B API 호출"""
        return self._call_vlm_api(image_url, prompt, self.model_name)
    
    def _call_vlm_api(self, image_url: str, prompt: str, model: str) -> str:
        """VLM API 호출 공통 로직"""
        start_time = time.time()
        first_chunk_time = None
        chunk_count = 0
        timeout_occurred = False
        first_chunks = []
        last_chunks = []
        
        def timeout_handler():
            nonlocal timeout_occurred
            timeout_occurred = True
            elapsed = time.time() - start_time
            logger.error(f"[VLM][{model}] 타임아웃 발생: {elapsed:.2f}초, 청크 수: {chunk_count}")
        
        timer = threading.Timer(self.timeout, timeout_handler)
        timer.start()
        
        try:
            logger.info(f"[VLM][{model}] 요청 시작")
            client = OpenAI(base_url=self.base_url, api_key=self.api_key)
            completion = client.chat.completions.create(
                model=model,
                messages=[{
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": image_url}},
                        {"type": "text", "text": prompt}
                    ]
                }],
                temperature=0.000001,
                top_p=0.1,
                stream=True
            )
            
            response_text = ""
            for chunk in completion:
                if timeout_occurred:
                    break
                    
                if chunk.choices[0].delta.content:
                    chunk_content = chunk.choices[0].delta.content
                    
                    if first_chunk_time is None:
                        first_chunk_time = time.time()
                        first_chunk_latency = first_chunk_time - start_time
                        logger.info(f"[VLM][{model}] 첫 번째 청크 도착: {first_chunk_latency:.2f}초")
                    
                    if len(first_chunks) < 3:
                        first_chunks.append(chunk_content)
                    else:
                        last_chunks.append(chunk_content)
                        if len(last_chunks) > 3:
                            last_chunks.pop(0)
                    
                    response_text += chunk_content
                    chunk_count += 1
                    
                    if chunk_count % 10 == 0:
                        elapsed = time.time() - start_time
                        logger.info(f"[VLM][{model}] 진행 중: {elapsed:.2f}초, 청크 수: {chunk_count}")
            
            timer.cancel()
            
            if not timeout_occurred:
                total_time = time.time() - start_time
                logger.info(f"[VLM][{model}] 완료: 총 {total_time:.2f}초, 청크 수: {chunk_count}")
            
            return response_text.strip()
        except Exception as e:
            timer.cancel()
            elapsed = time.time() - start_time
            logger.error(f"[VLM][{model}] 에러 발생: {elapsed:.2f}초, 청크 수: {chunk_count}, 에러: {e}")
            raise
    
    def get_model_info(self) -> Dict[str, Any]:
        return {
            "name": self.model_name,
            "speed": "slow",
            "accuracy": "high",
            "timeout": self.timeout,
            "description": "높은 정확도, 느린 처리 속도"
        }
    
    def get_name(self) -> str:
        return self.model_name


class VLMFactory:
    """VLM 전략 팩토리"""
    
    @staticmethod
    def create_strategy(model_name: str, base_url: str, api_key: str) -> VLMStrategy:
        """모델 이름에 따른 전략 생성"""
        strategies = {
            "LLM-27B": VLM27BStrategy(base_url, api_key),
            "LLM-122B": VLM122BStrategy(base_url, api_key)
        }
        
        if model_name not in strategies:
            logger.warning(f"알 수 없는 모델: {model_name}, 기본값 LLM-27B 사용")
            return strategies["LLM-27B"]
        
        return strategies[model_name]
    
    @staticmethod
    def get_available_models() -> Dict[str, Dict[str, Any]]:
        """사용 가능한 모델 목록 반환"""
        return {
            "LLM-27B": {
                "name": "LLM-27B",
                "speed": "fast",
                "accuracy": "medium",
                "description": "빠른 처리 속도, 중간 정확도"
            },
            "LLM-122B": {
                "name": "LLM-122B",
                "speed": "slow",
                "accuracy": "high",
                "description": "높은 정확도, 느린 처리 속도"
            }
        }