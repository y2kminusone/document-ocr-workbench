from __future__ import annotations

from PIL import Image


def render_pdf_page_to_pil(doc, page_index: int, dpi: int = 300) -> Image.Image:
    import fitz  # type: ignore

    page = doc.load_page(page_index)
    zoom = max(1, int(dpi)) / 72.0
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
