from __future__ import annotations

from typing import Any, Dict, Optional


class AppError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        detail: Optional[Any] = None,
        stage: Optional[str] = None,
        retryable: bool = False,
        status_code: int = 500,
    ) -> None:
        super().__init__(message)
        self.code = str(code or "APP_ERROR")
        self.message = str(message or "application error")
        self.detail = detail
        self.stage = stage
        self.retryable = bool(retryable)
        self.status_code = int(status_code)

    def to_dict(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "error_code": self.code,
            "message": self.message,
            "stage": self.stage,
            "retryable": self.retryable,
        }
        if self.detail is not None:
            payload["detail"] = self.detail
        return payload


class ExternalDependencyError(AppError):
    def __init__(self, code: str, message: str, *, detail: Optional[Any] = None, stage: Optional[str] = None, retryable: bool = True):
        super().__init__(code, message, detail=detail, stage=stage, retryable=retryable, status_code=502)


class ValidationAppError(AppError):
    def __init__(self, code: str, message: str, *, detail: Optional[Any] = None, stage: Optional[str] = None):
        super().__init__(code, message, detail=detail, stage=stage, retryable=False, status_code=422)


class NotFoundAppError(AppError):
    def __init__(self, code: str, message: str, *, detail: Optional[Any] = None, stage: Optional[str] = None):
        super().__init__(code, message, detail=detail, stage=stage, retryable=False, status_code=404)


class ConflictAppError(AppError):
    def __init__(self, code: str, message: str, *, detail: Optional[Any] = None, stage: Optional[str] = None):
        super().__init__(code, message, detail=detail, stage=stage, retryable=False, status_code=409)


class DocFilterError(ExternalDependencyError):
    def __init__(self, message: str, *, detail: Optional[Any] = None, retryable: bool = True):
        super().__init__("DOC_FILTER_ERROR", message, detail=detail, stage="doc_filter", retryable=retryable)


class YoloError(ExternalDependencyError):
    def __init__(self, message: str, *, detail: Optional[Any] = None, retryable: bool = True):
        super().__init__("YOLO_ERROR", message, detail=detail, stage="yolo", retryable=retryable)


class OcrError(ExternalDependencyError):
    def __init__(self, message: str, *, detail: Optional[Any] = None, retryable: bool = True):
        super().__init__("OCR_ERROR", message, detail=detail, stage="ocr", retryable=retryable)


class OverrideValidationError(ValidationAppError):
    def __init__(self, message: str, *, detail: Optional[Any] = None):
        super().__init__("OVERRIDE_VALIDATION_ERROR", message, detail=detail, stage="override")


class VirtualPageMaterializationError(AppError):
    def __init__(self, message: str, *, detail: Optional[Any] = None, retryable: bool = False):
        super().__init__("VIRTUAL_PAGE_MATERIALIZATION_ERROR", message, detail=detail, stage="override", retryable=retryable, status_code=500)


class ResultPersistError(AppError):
    def __init__(self, message: str, *, detail: Optional[Any] = None, retryable: bool = True):
        super().__init__("RESULT_PERSIST_ERROR", message, detail=detail, stage="persist", retryable=retryable, status_code=500)


class JobPageStateError(ConflictAppError):
    def __init__(self, message: str, *, detail: Optional[Any] = None):
        super().__init__("JOB_PAGE_STATE_ERROR", message, detail=detail, stage="job_page")
