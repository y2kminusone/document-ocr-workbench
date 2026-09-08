from __future__ import annotations

import uvicorn
import os

from core.logging import init_logging
from .app import create_app


def main() -> None:
    log_config = init_logging("ocr", use_rotation=False)
    uvicorn.run(
        "ocr_service.app:create_app",  # import string 형태로 변경
        host="127.0.0.1",
        port=int(os.getenv("PORT", 8012)),
        workers=1,  # 워커 수를 1로 설정 (race condition 방지)
        reload=False,
        log_level=None,
        log_config=log_config,
        factory=True,  # factory 모드 활성화
    )


if __name__ == "__main__":
    main()

