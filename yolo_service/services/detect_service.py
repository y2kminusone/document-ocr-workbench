from __future__ import annotations

import io
import os
import cv2
import time
import logging
from typing import Any, Dict, List, Optional

import numpy as np
from PIL import Image

from ..utils import crop_image, pil_to_base64
from .model_loader import get_model, load_model

logger = logging.getLogger("yolo")


def detect_image(image_bytes: bytes, rotation: Optional[str], file_id: Optional[str] = None) -> Dict[str, Any]:
    total_start = time.time()
    
    logger.info(f"[YOLO] Detection 시작 - file_id: {file_id}, rotation: {rotation}")
    
    # 모델 로드
    model = get_model()
    logger.info(f"[YOLO] 모델 로드 완료")

    # 이미지 로드
    load_start = time.time()
    image = Image.open(io.BytesIO(image_bytes))
    logger.info(f"[YOLO] 이미지 로드 완료 - 크기: {image.size}, 소요시간: {time.time()-load_start:.2f}초")
    
    # 회전 처리
    if rotation == "cw":
        rotate_start = time.time()
        image = image.rotate(-90, expand=True)
        logger.info(f"[YOLO] 이미지 회전 완료 - 소요시간: {time.time()-rotate_start:.2f}초")
    
    # RGB 변환
    if image.mode != "RGB":
        convert_start = time.time()
        image = image.convert("RGB")
        logger.info(f"[YOLO] RGB 변환 완료 - 소요시간: {time.time()-convert_start:.2f}초")
    
    img_array = np.array(image)
    logger.info(f"[YOLO] numpy 배열 변환 완료 - shape: {img_array.shape}")

    # YOLO 추론
    inference_start = time.time()
    try:
        results = model(img_array, verbose=False)
    except Exception as exc:
        try:
            results = model.predict(img_array, verbose=False)
        except Exception as exc2:
            raise RuntimeError(f"YOLO detection 실패: {exc2}. 원본 오류: {exc}")
    
    inference_time = time.time() - inference_start
    logger.info(f"[YOLO] YOLO 추론 완료 - 소요시간: {inference_time:.2f}초")
    
    # 결과 처리
    process_start = time.time()
    chemical_crops: List[str] = []
    table_crops: List[str] = []
    title_crops: List[str] = []
    detections: List[Dict[str, Any]] = []

    if not isinstance(results, list):
        results = [results]

    total_boxes = 0
    for result in results:
        if result.boxes is None or len(result.boxes) == 0:
            continue

        boxes = result.boxes
        total_boxes += len(boxes)
        
        for box in boxes:
            try:
                x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
                confidence = float(box.conf[0].cpu().numpy())
                class_id = int(box.cls[0].cpu().numpy())
                class_name = model.names[class_id]

                crop_img = crop_image(img_array, [x1, y1, x2, y2])
                crop_pil = Image.fromarray(crop_img)

                if class_name == "chemical":
                    chemical_crops.append(pil_to_base64(crop_pil))
                elif class_name == "table":
                    table_crops.append(pil_to_base64(crop_pil))
                elif class_name == "title":
                    title_crops.append(pil_to_base64(crop_pil))

                detections.append(
                    {
                        "class": class_name,
                        "class_id": class_id,
                        "confidence": confidence,
                        "bbox": [float(x1), float(y1), float(x2), float(y2)],
                    }
                )
            except Exception as exc:
                logger.warning(f"[YOLO] Detection 박스 처리 중 오류: {exc}")
                continue
    
    logger.info(f"[YOLO] 결과 처리 완료 - 총 박스: {total_boxes}, chemical: {len(chemical_crops)}, table: {len(table_crops)}, title: {len(title_crops)}, 소요시간: {time.time()-process_start:.2f}초")

    # YOLO detection 이미지 저장
    yolo_image_path = None
    if file_id and detections:
        save_start = time.time()
        yolo_image_path = save_yolo_detection_image(img_array, detections, file_id)
        logger.info(f"[YOLO] Detection 이미지 저장 완료 - 경로: {yolo_image_path}, 소요시간: {time.time()-save_start:.2f}초")

    total_time = time.time() - total_start
    logger.info(f"[YOLO] Detection 완료 - 총 소요시간: {total_time:.2f}초")

    return {
        "success": True,
        "chemical_crops": chemical_crops,
        "table_crops": table_crops,
        "title_crops": title_crops,
        "chemical": chemical_crops,  # API 서비스 호환성을 위한 별칭
        "table": table_crops,  # API 서비스 호환성을 위한 별칭
        "title": title_crops,  # API 서비스 호환성을 위한 별칭
        "detections": detections,
        "original_image": pil_to_base64(image),
        "image_size": list(image.size),
        "yolo_image_path": yolo_image_path,
    }


def save_yolo_detection_image(img_array: np.ndarray, detections: List[Dict[str, Any]], file_id: str) -> Optional[str]:
    """
    YOLO detection 결과를 이미지로 저장
    
    Args:
        img_array: 원본 이미지 배열
        detections: detection 결과 리스트
        file_id: 파일 ID
    
    Returns:
        저장된 이미지 경로 또는 None
    """
    try:
        # 이미지 복사
        img_with_boxes = img_array.copy()
        
        # detection bbox 그리기
        for det in detections:
            x1, y1, x2, y2 = det['bbox']
            class_name = det['class']
            confidence = det['confidence']
            
            # 클래스별 색상 지정
            if class_name == "chemical":
                color = (0, 255, 0)  # 녹색
            elif class_name == "table":
                color = (255, 0, 0)  # 빨간색
            elif class_name == "title":
                color = (0, 0, 255)  # 파란색
            else:
                color = (128, 128, 128)  # 회색
            
            # bbox 그리기
            cv2.rectangle(img_with_boxes, (int(x1), int(y1)), (int(x2), int(y2)), color, 2)
            
            # 클래스 이름과 confidence 표시
            label = f"{class_name} {confidence:.2f}"
            cv2.putText(img_with_boxes, label, (int(x1), int(y1) - 10),
                       cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)
        
        # 저장 경로 생성 (현재 작업 디렉토리 기준)
        storage_path = os.path.join(os.getcwd(), "storage_web", "derived")
        os.makedirs(storage_path, exist_ok=True)
        
        output_path = os.path.join(storage_path, f"{file_id}_yolo.jpg")
        
        # 이미지 저장
        cv2.imwrite(output_path, cv2.cvtColor(img_with_boxes, cv2.COLOR_RGB2BGR))
        
        logger.info(f"[YOLO] Detection 이미지 저장: {output_path}")
        return output_path
        
    except Exception as exc:
        logger.error(f"[YOLO] Detection 이미지 저장 실패: {exc}")
        return None


def ensure_model_loaded() -> None:
    load_model()
