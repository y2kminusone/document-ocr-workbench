from __future__ import annotations

import os
from typing import Optional

from ultralytics import YOLO

from .. import config

_det_model: Optional[YOLO] = None


def find_model_file(model_path: str) -> Optional[str]:
    if os.path.exists(model_path) and os.path.isfile(model_path):
        return model_path

    return None


def load_model() -> YOLO:
    global _det_model
    if _det_model is None:
        print(f"[INIT] YOLO 모델 로딩 중: {config.MODEL_PATH}")
        print(f"[DEBUG] 현재 작업 디렉토리: {os.getcwd()}")
        print(f"[DEBUG] 절대 경로 존재 여부: {os.path.exists(config.MODEL_PATH)}")

        actual_path = find_model_file(config.MODEL_PATH)
        if actual_path is None:
            print("[ERROR] 모델 파일을 찾을 수 없습니다.")
            print(f"[ERROR] 시도한 경로: {config.MODEL_PATH}")
            print(f"[ERROR] 현재 작업 디렉토리: {os.getcwd()}")

            dir_path = os.path.dirname(config.MODEL_PATH)
            if os.path.exists(dir_path):
                print(f"[INFO] 디렉토리는 존재합니다: {dir_path}")
                print(f"[INFO] 디렉토리 내용:")
                try:
                    for item in os.listdir(dir_path):
                        print(f"  - {item}")
                except PermissionError:
                    print("  [권한 오류로 디렉토리 내용을 읽을 수 없습니다]")
            else:
                print(f"[ERROR] 디렉토리도 존재하지 않습니다: {dir_path}")
            raise FileNotFoundError(f"모델 파일을 찾을 수 없습니다: {config.MODEL_PATH}")

        model_path_to_load = actual_path
        print(f"[INIT] 모델 파일 경로: {model_path_to_load}")

        try:
            _det_model = YOLO(model_path_to_load, task="detect")
            print("[INIT] 모델 로딩 완료 (task='detect' 명시)")
        except Exception as exc:
            print(f"[WARN] task='detect' 지정 실패, 기본 방식으로 시도: {exc}")
            _det_model = YOLO(model_path_to_load)
            print("[INIT] 모델 로딩 완료 (기본 방식)")

        print(f"[INIT] 모델 타입: {type(_det_model)}")
        if hasattr(_det_model, "names"):
            print(f"[INIT] 탐지 클래스: {_det_model.names}")
            print(f"[INIT] 클래스 개수: {len(_det_model.names)}")
        else:
            print("[WARN] 모델 클래스 정보를 가져올 수 없습니다")

    return _det_model


def get_model() -> YOLO:
    if _det_model is None:
        return load_model()
    return _det_model
