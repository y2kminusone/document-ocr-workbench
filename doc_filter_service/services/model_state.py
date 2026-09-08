from __future__ import annotations

from typing import Any, Dict, Optional

import os

import torch
from torch import nn
from torchvision import models, transforms
from PIL import Image

from .. import config


class ModelState:
    def __init__(self) -> None:
        gpu_id = int(os.getenv("DOC_FILTER_GPU_ID", "0"))

        if torch.cuda.is_available():
            if gpu_id >= torch.cuda.device_count():
                print(
                    f"[WARNING] GPU {gpu_id}가 없습니다. 사용 가능한 GPU 수: {torch.cuda.device_count()}, GPU 0 사용"
                )
                gpu_id = 0
            self.device: torch.device = torch.device(f"cuda:{gpu_id}")
            print(f"[INFO] GPU 사용: {self.device} (GPU {gpu_id}/{torch.cuda.device_count()})")
        else:
            self.device = torch.device("cpu")
            print("[WARNING] CUDA를 사용할 수 없습니다. CPU 모드로 실행됩니다.")

        self.model: Optional[torch.nn.Module] = None
        self.transform = transforms.Compose(
            [
                transforms.Resize((256, 256)),
                transforms.ToTensor(),
                transforms.Normalize(mean=[0.48235, 0.45882, 0.40784], std=[0.229, 0.224, 0.225]),
            ]
        )

    def load(self) -> None:
        if self.model is not None:
            return

        if not os.path.exists(config.MODEL_PATH):
            raise FileNotFoundError(f"모델 체크포인트를 찾을 수 없습니다: {config.MODEL_PATH}")

        model = models.resnet50(weights=None)
        model.fc = nn.Linear(2048, 4)

        checkpoint = torch.load(config.MODEL_PATH, map_location=self.device)
        state_dict = {k.replace("module.", ""): v for k, v in checkpoint.items()}
        model.load_state_dict(state_dict)

        model.to(self.device)
        model.eval()
        self.model = model
        print(f"[INFO] 모델 로드 완료: {config.MODEL_PATH} (device: {self.device})")

    @torch.no_grad()
    def infer_pil(self, image: Image.Image) -> Dict[str, Any]:
        if self.model is None:
            self.load()
        assert self.model is not None

        img = image.convert("RGB")
        img_tensor = self.transform(img).unsqueeze(0).to(self.device)
        outputs = self.model(img_tensor)
        probs = torch.softmax(outputs, dim=1)[0]
        idx = int(torch.argmax(probs).cpu().item())
        score = float(probs[idx].cpu().item())
        return {
            "doc_index": idx,
            "label": config.LABEL1_CLS_DICT.get(idx, str(idx)),
            "score": score,
            "is_interest": idx in config.INTEREST_CLASS_INDICES,
        }
