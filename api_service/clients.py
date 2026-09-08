from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Optional

import requests

from . import config
import time
import logging

logger = logging.getLogger(__name__)

def call_yolo_detect(image_path: Path, rotation: Optional[str], file_id: Optional[str] = None) -> Dict[str, Any]:
    """
    YOLO 서버에 이미지를 전송하여 탐지 결과를 반환
    
    Args:
        image_path: 이미지 파일 경로
        rotation: 이미지 회전 정보 (None, 'cw', 'ccw')
        file_id: 파일 ID (YOLO detection 이미지 저장용)
    
    Returns:
        YOLO 탐지 결과
    
    Raises:
        requests.exceptions.Timeout: YOLO 처리 타임아웃
        requests.exceptions.HTTPError: HTTP 에러
    """
    logger.info(f"[YOLO] YOLO 서버 호출 시작 - image_path: {image_path.name}, rotation: {rotation}, file_id: {file_id}")
    
    start_time = time.time()
    
    try:
        with image_path.open("rb") as f:
            files = {"file": (image_path.name, f, "application/octet-stream")}
            params: Dict[str, Any] = {}
            if rotation:
                params["rotation"] = rotation
            if file_id:
                params["file_id"] = file_id
            
            resp = requests.post(
                f"{config.YOLO_SERVER_URL}/detect",
                files=files,
                params=params,
                timeout=600,  # 300초 → 600초(10분)으로 증가
            )
        
        elapsed = time.time() - start_time
        logger.info(f"[YOLO] YOLO 서버 호출 성공 - image_path: {image_path.name}, "
                    f"소요시간: {elapsed:.2f}초, status: {resp.status_code}")
        
        resp.raise_for_status()
        result = resp.json()
        
        logger.info(f"[YOLO] YOLO 결과 수신 완료 - image_path: {image_path.name}, "
                    f"탐지된 영역: chemical={len(result.get('chemical', []))}, "
                    f"table={len(result.get('table', []))}")
        
        return result
        
    except requests.exceptions.Timeout as e:
        elapsed = time.time() - start_time
        logger.error(f"[YOLO] YOLO 서버 타임아웃 - image_path: {image_path.name}, "
                     f"소요시간: {elapsed:.2f}초, 에러: {str(e)}")
        raise
        
    except requests.exceptions.HTTPError as e:
        elapsed = time.time() - start_time
        logger.error(f"[YOLO] YOLO 서버 HTTP 에러 - image_path: {image_path.name}, "
                     f"소요시간: {elapsed:.2f}초, status: {e.response.status_code}, "
                     f"에러: {str(e)}")
        raise
        
    except Exception as e:
        elapsed = time.time() - start_time
        logger.error(f"[YOLO] YOLO 서버 호출 실패 - image_path: {image_path.name}, "
                     f"소요시간: {elapsed:.2f}초, 에러: {str(e)}")
        raise


def call_ocr_from_yolo(yolo_result: Dict[str, Any], image_name: str, max_retries: int = 3, retry_delay: float = 5.0) -> Dict[str, Any]:
    """
    YOLO 결과를 OCR 서버로 전송하여 처리 결과를 반환
    
    Args:
        yolo_result: YOLO 탐지 결과
        image_name: 이미지 파일명
        max_retries: 최대 재시 시도 (기본값: 3)
        retry_delay: 재시 대기 시간 (초, 기본값: 5.0)
    
    Returns:
        OCR 처리 결과
    
    Raises:
        requests.exceptions.Timeout: OCR 처리 타임아웃
        requests.exceptions.HTTPError: HTTP 에러
    """
    # OCR 호출 시작 로그
    logger.info(f"[OCR] OCR 서버 호출 시작 - image_name: {image_name}")
    logger.info(f"[OCR] YOLO 결과 크기 - chemical: {len(yolo_result.get('chemical', []))}, "
                f"table: {len(yolo_result.get('table', []))}")
    
    payload = {"yolo_result": yolo_result, "image_name": image_name}
    
    for attempt in range(max_retries):
        start_time = time.time()
        
        try:
            # 타임아웃을 30분(1800초)으로 증가
            resp = requests.post(
                f"{config.OCR_SERVER_URL}/process_from_yolo",
                json=payload,
                timeout=1800,  # 30분 타아웃
            )
            
            elapsed = time.time() - start_time
            logger.info(f"[OCR] OCR 서버 호출 성공 - image_name: {image_name}, "
                        f"소요시간: {elapsed:.2f}초, status: {resp.status_code}")
            
            resp.raise_for_status()
            result = resp.json()
            
            logger.info(f"[OCR] OCR 결과 수신 완료 - image_name: {image_name}")
            
            return result
            
        except requests.exceptions.Timeout as e:
            elapsed = time.time() - start_time
            if attempt < max_retries - 1:
                logger.warning(f"[OCR] OCR 서버 타임아웃 (시도 {attempt + 1}/{max_retries}) - image_name: {image_name}, "
                            f"소요시간: {elapsed:.2f}초, 에러: {str(e)}")
                logger.info(f"[OCR] {retry_delay}초 후 재시 시도...")
                time.sleep(retry_delay)
            else:
                logger.error(f"[OCR] OCR 서버 최종 실패 - image_name: {image_name}, "
                            f"최종 시도 실패, 소요시간: {elapsed:.2f}초, 에러: {str(e)}")
                raise
        
        except requests.exceptions.HTTPError as e:
            elapsed = time.time() - start_time
            if attempt < max_retries - 1:
                logger.warning(f"[OCR] OCR 서버 HTTP 에러 (시도 {attempt + 1}/{max_retries}) - image_name: {image_name}, "
                            f"소요시간: {elapsed:.2f}초, status: {e.response.status_code}, "
                            f"에러: {str(e)}")
                logger.info(f"[OCR] {retry_delay}초 후 재시 시도...")
                time.sleep(retry_delay)
            else:
                logger.error(f"[OCR] OCR 서버 최종 실패 - image_name: {image_name}, "
                            f"최종 시도 실패, 소요시간: {elapsed:.2f}초, 에러: {str(e)}")
                raise
        
        except Exception as e:
            elapsed = time.time() - start_time
            logger.error(f"[OCR] OCR 서버 호출 실패 - image_name: {image_name}, "
                        f"소요시간: {elapsed:.2f}초, 에러: {str(e)}")
            raise


def call_doc_filter_image(png_bytes: bytes, filename: str) -> Dict[str, Any]:
    """
    문서 필터 서버에 이미지를 전송하여 필터링 결과를 반환
    
    Args:
        png_bytes: 이미지 바이트 데이터
        filename: 파일명
    
    Returns:
        필터링 결과
    
    Raises:
        requests.exceptions.Timeout: 필터링 타임아웃
        requests.exceptions.HTTPError: HTTP 에러
    """
    logger.info(f"[DOC_FILTER] 문서 필터 서버 호출 시작 - filename: {filename}")
    
    start_time = time.time()
    
    try:
        files = {"file": (filename, png_bytes, "image/png")}
        resp = requests.post(
            f"{config.DOC_FILTER_SERVER_URL}/filter_image",
            files=files,
            timeout=300,
        )
        
        elapsed = time.time() - start_time
        logger.info(f"[DOC_FILTER] 문서 필터 서버 호출 성공 - filename: {filename}, "
                    f"소요시간: {elapsed:.2f}초, status: {resp.status_code}")
        
        resp.raise_for_status()
        result = resp.json()
        
        logger.info(f"[DOC_FILTER] 필터링 결과 수신 완료 - filename: {filename}")
        
        return result
        
    except requests.exceptions.Timeout as e:
        elapsed = time.time() - start_time
        logger.error(f"[DOC_FILTER] 문서 필터 서버 타임아웃 - filename: {filename}, "
                     f"소요시간: {elapsed:.2f}초, 에러: {str(e)}")
        raise
        
    except requests.exceptions.HTTPError as e:
        elapsed = time.time() - start_time
        logger.error(f"[DOC_FILTER] 문서 필터 서버 HTTP 에러 - filename: {filename}, "
                     f"소요시간: {elapsed:.2f}초, status: {e.response.status_code}, "
                     f"에러: {str(e)}")
        raise
        
    except Exception as e:
        elapsed = time.time() - start_time
        logger.error(f"[DOC_FILTER] 문서 필터 서버 호출 실패 - filename: {filename}, "
                     f"소요시간: {elapsed:.2f}초, 에러: {str(e)}")
        raise
