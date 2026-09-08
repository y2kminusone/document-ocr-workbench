import { $ } from "./dom.js";
import { state } from "./state.js";

export function badge(status) {
  const v = String(status ?? "").toLowerCase();
  const cls =
    v === "done"
      ? "ok"
      : v === "error"
        ? "err"
        : v === "processing"
          ? "run"
          : v === "cancelled"
            ? "cancelled"
            : "";
  return `<span class="badge ${cls}">${escapeHtml(status ?? "")}</span>`;
}

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function normalizeRotation(raw) {
  const v = String(raw || "").toLowerCase();
  if (v === "cw" || v === "90") return "cw";
  if (v === "ccw" || v === "-90") return "ccw";
  if (v === "180") return "180";
  return "";
}

export function openImagePopup(imgUrl, rot) {
  const r = normalizeRotation(rot);
  const url = new URL("popup.html", window.location.href);
  url.searchParams.set("src", imgUrl || "");
  if (r) url.searchParams.set("rot", r);

  // 팝업 창 옵션 설정
  const popupFeatures = [
    'width=1200',
    'height=800',
    'resizable=yes',
    'scrollbars=yes',
    'status=no',
    'toolbar=no',
    'menubar=no',
    'location=no'
  ].join(',');

  // "_blank" → 팝업 창으로 열기
  window.open(url.toString(), 'image_popup', popupFeatures);
}

// 팝업 창 이미지 업데이트
export function updatePopupImage(imgUrl, rot) {
  if (!state.popupWindow || state.popupWindow.closed) {
    console.log("Popup window is not available");
    return;
  }
  
  try {
    const r = normalizeRotation(rot);
    // popup.html을 기준으로 새 URL 생성 (현재 팝업 URL이 아님)
    const url = new URL("popup.html", window.location.href);
    url.searchParams.set("src", imgUrl || "");
    if (r) url.searchParams.set("rot", r);
    url.searchParams.delete("deg");  // deg 파라미터 제거 (rot 파라미터가 우선되도록)
    
    console.log("Updating popup image:", url.toString());
    state.popupWindow.location.href = url.toString();
  } catch (e) {
    console.error("Failed to update popup image:", e);
  }
}

export function clearFileInput(id) {
  const input = $(id);
  if (input) input.value = "";
}

export function applyPreviewRotationFromState() {
  const rot = normalizeRotation(state.currentFile?.rotation);
  const img = $("previewImg");
  if (!img) return;
  img.dataset.rot = rot;
}
