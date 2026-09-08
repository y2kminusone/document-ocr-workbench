from __future__ import annotations

import base64
import io
from typing import List

import numpy as np
from PIL import Image


def pil_to_base64(image: Image.Image) -> str:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    img_str = base64.b64encode(buf.getvalue()).decode()
    return f"data:image/png;base64,{img_str}"


def crop_image(image: np.ndarray, bbox: List[float]) -> np.ndarray:
    x1, y1, x2, y2 = map(int, bbox)
    x1 = max(0, min(x1, image.shape[1]))
    y1 = max(0, min(y1, image.shape[0]))
    x2 = max(0, min(x2, image.shape[1]))
    y2 = max(0, min(y2, image.shape[0]))

    if x1 > x2:
        x1, x2 = x2, x1
    if y1 > y2:
        y1, y2 = y2, y1

    return image[y1:y2, x1:x2]
