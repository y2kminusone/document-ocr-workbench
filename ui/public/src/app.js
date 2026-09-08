//import * as api from "./api.js";
import {
  cancelSelectedJob,
  retrySelectedJob,
  markJobAsDone,
  markFileAsDone,
  applySelectedFileOverride,
  uploadImages,
  uploadPdf,
  saveToDb,
  showHealth,
  loadDbDocs,
  initDbScreen,
  loadDbHistory,
  saveDbRow,
  deleteDbRow,
  deleteDbTable,
  loadDbConfig,
  saveDbConfig,
  setTab,
  initTabs,
  refreshJobs,
  refreshJobDetail,
  updateJobDetailFromPayload,
  requireApiBase,
  startJobsEvents,
  startSystemLogsEvents,
  refreshSystemLogs
} from "./api.js";
import { initTableEditFix, saveEdits } from "./table_edit_fix.js";
import { initClassification } from "./classification.js";
import { $ } from "./dom.js";
import { state } from "./state.js";
import {
  addOrInsertColumn,
  addDefaultChemColumns,
  addMaterialColumns,
  addTestReportColumns,
  addRow,
  addTempColumn,
  applySelectionHighlight,
  collectEditableTableFrom,
  collectTable,
  computeColumnsFromRows,
  copyAllTableToClipboard,
  deleteColumn,
  deleteColumns,
  deleteRow,
  deleteRows,
  getActiveEditor,
  getTableDom,
  getTableRowsFromDom,
  moveColumn,
  moveRow,
  normalizeTableData,
  renderEditableTableTo,
  renderTable,
  renameColumn,
  rerender,
  setSelection,
  undoDelete,
  updateInsertPosOptions,
  updateRowIndices,
  enterOcrBulkDeleteMode,
  exitOcrBulkDeleteMode,
  enterOcrRowBulkDeleteMode,
  exitOcrRowBulkDeleteMode,
} from "./table_tabulator.js";
import {
  applyPreviewRotationFromState,
  clearFileInput,
  normalizeRotation,
  openImagePopup,
} from "./ui_utils.js";

const JOBS_UI_STORAGE_KEY = "ocr_ui_jobs_ui_state";
const FILE_LIST_SCROLL_STORAGE_KEY = "ocr_ui_file_list_scroll_top";

function loadSidebarState() {
  try {
    const raw = localStorage.getItem(JOBS_UI_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved && typeof saved === "object") {
      state.jobsUi = {
        ...state.jobsUi,
        status: saved.status || state.jobsUi.status || "all",
        q: saved.q || "",
        fileView: saved.fileView || state.jobsUi.fileView || "all",
        fileQ: saved.fileQ || "",
      };
    }
  } catch (e) {
    console.warn("Failed to load sidebar state:", e);
  }
}

function saveSidebarState() {
  try {
    localStorage.setItem(JOBS_UI_STORAGE_KEY, JSON.stringify(state.jobsUi || {}));
  } catch (e) {
    console.warn("Failed to save sidebar state:", e);
  }
}

function saveFileListScroll() {
  const filesContainer = $("files");
  if (!filesContainer) return;
  try {
    localStorage.setItem(FILE_LIST_SCROLL_STORAGE_KEY, String(filesContainer.scrollTop || 0));
  } catch (_) {}
}

function restoreFileListScroll(preferSelected = true) {
  const filesContainer = $("files");
  if (!filesContainer) return;

  requestAnimationFrame(() => {
    const active = state.selectedFileId
      ? filesContainer.querySelector(`[data-file="${CSS.escape(state.selectedFileId)}"]`)
      : null;
    if (preferSelected && active) {
      active.scrollIntoView({ behavior: "auto", block: "nearest" });
      return;
    }

    const saved = Number(localStorage.getItem(FILE_LIST_SCROLL_STORAGE_KEY) || 0);
    if (Number.isFinite(saved) && saved >= 0) {
      filesContainer.scrollTop = saved;
    }
  });
}

function openDbModal(open) {
  const m = $("dbModal");
  if (!m) return;
  m.setAttribute("aria-hidden", open ? "false" : "true");
}

function openOcrBulkDeleteModal(open) {
  const m = $("ocrBulkDeleteModal");
  if (!m) return;
  m.setAttribute("aria-hidden", open ? "false" : "true");
  state.ocrBulkDelete.isConfirmModalOpen = !!open;
  
  // ✅ 모달이 열릴 때 삭제 실행 버튼에 자동 포커스
  if (open) {
    const submitBtn = $("ocrBulkDeleteModalSubmit");
    if (submitBtn) {
      setTimeout(() => submitBtn.focus(), 100);
    }
  }
}

function openOcrRowBulkDeleteModal(open) {
  const m = $("ocrRowBulkDeleteModal");
  if (!m) return;
  m.setAttribute("aria-hidden", open ? "false" : "true");
  state.ocrRowBulkDelete.isConfirmModalOpen = !!open;
  
  // ✅ 모달이 열릴 때 삭제 실행 버튼에 자동 포커스
  if (open) {
    const submitBtn = $("ocrRowBulkDeleteModalSubmit");
    if (submitBtn) {
      setTimeout(() => submitBtn.focus(), 100);
    }
  }
}

const THEME_STORAGE_KEY = "ocr_ui_theme";

function getSystemTheme() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(mode = "system") {
  const root = document.documentElement;
  const resolved = mode === "system" ? getSystemTheme() : mode;
  root.setAttribute("data-theme", resolved);
  root.setAttribute("data-theme-mode", mode);
}

function initTheme() {
  const saved = (localStorage.getItem(THEME_STORAGE_KEY) || "system").toLowerCase();
  const mode = ["light", "dark", "system"].includes(saved) ? saved : "system";
  applyTheme(mode);

  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  if (media) {
    media.addEventListener("change", () => {
      const activeMode = document.documentElement.getAttribute("data-theme-mode") || "system";
      if (activeMode === "system") applyTheme("system");
    });
  }
}

function bindUi() {
  // 사이드바 리사이저 초기화 (OCR 처리 페이지)
  const initSidebarResizer = () => {
    const resizer = $("sidebarResizer");
    const layout = $("screenOcr");
    if (!resizer || !layout) return;

    const SIDEBAR_MIN_WIDTH = 280;
    const SIDEBAR_MAX_WIDTH = 600;
    const STORAGE_KEY = "ocr_sidebar_width";

    // 저장된 너비 불러오기
    const savedWidth = localStorage.getItem(STORAGE_KEY);
    if (savedWidth) {
      const width = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Number(savedWidth)));
      layout.style.setProperty("--sidebar-width", `${width}px`);
    }

    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    resizer.addEventListener("mousedown", (e) => {
      isResizing = true;
      startX = e.clientX;
      startWidth = resizer.parentElement.offsetWidth;
      resizer.classList.add("resizing");
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!isResizing) return;
      const dx = e.clientX - startX;
      const newWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, startWidth + dx));
      layout.style.setProperty("--sidebar-width", `${newWidth}px`);
    });

    document.addEventListener("mouseup", () => {
      if (!isResizing) return;
      isResizing = false;
      resizer.classList.remove("resizing");
      
      // 현재 너비 저장
      const currentWidth = resizer.parentElement.offsetWidth;
      localStorage.setItem(STORAGE_KEY, String(currentWidth));
    });
  };

  initSidebarResizer();

  // 사이드바 리사이저 초기화 (분류 페이지)
  const initClassificationSidebarResizer = () => {
    const resizer = $("classificationSidebarResizer");
    const layout = $("screenClassification");
    if (!resizer || !layout) return;

    const SIDEBAR_MIN_WIDTH = 280;
    const SIDEBAR_MAX_WIDTH = 600;
    const STORAGE_KEY = "classification_sidebar_width";

    // 저장된 너비 불러오기
    const savedWidth = localStorage.getItem(STORAGE_KEY);
    if (savedWidth) {
      const width = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Number(savedWidth)));
      layout.style.setProperty("--sidebar-width", `${width}px`);
    }

    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    resizer.addEventListener("mousedown", (e) => {
      isResizing = true;
      startX = e.clientX;
      startWidth = resizer.parentElement.offsetWidth;
      resizer.classList.add("resizing");
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!isResizing) return;
      const dx = e.clientX - startX;
      const newWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, startWidth + dx));
      layout.style.setProperty("--sidebar-width", `${newWidth}px`);
    });

    document.addEventListener("mouseup", () => {
      if (!isResizing) return;
      isResizing = false;
      resizer.classList.remove("resizing");
      
      // 현재 너비 저장
      const currentWidth = resizer.parentElement.offsetWidth;
      localStorage.setItem(STORAGE_KEY, String(currentWidth));
    });
  };

  initClassificationSidebarResizer();

  const composingByTable = { ocr: false, db: false };

  const getCellCaretState = (cell) => {
    if (!cell) return { atStart: false, atEnd: false, collapsed: false };
    const sel = window.getSelection?.();
    if (!sel || sel.rangeCount === 0) return { atStart: false, atEnd: false, collapsed: false };
    const range = sel.getRangeAt(0);
    if (!cell.contains(range.startContainer) || !cell.contains(range.endContainer)) {
      return { atStart: false, atEnd: false, collapsed: false };
    }
    if (!range.collapsed) return { atStart: false, atEnd: false, collapsed: false };

    const startRange = document.createRange();
    startRange.selectNodeContents(cell);
    startRange.setEnd(range.startContainer, range.startOffset);
    const atStart = (startRange.toString() || "").length === 0;

    const endRange = document.createRange();
    endRange.selectNodeContents(cell);
    endRange.setStart(range.endContainer, range.endOffset);
    const atEnd = (endRange.toString() || "").length === 0;
    return { atStart, atEnd, collapsed: true };
  };

  const focusEditableCell = (cell, place = "end") => {
    if (!cell) return;
    cell.focus();
    const sel = window.getSelection?.();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(cell);
    range.collapse(place !== "end");
    sel.removeAllRanges();
    sel.addRange(range);
  };

  const bindEditableTableArrowNav = (tableEl, kind) => {
    if (!tableEl) return;
    const findEditableCell = (target) => {
      if (!target) return null;
      const base = target.nodeType === Node.TEXT_NODE ? target.parentElement : target;
      const td = base?.closest?.("td[data-col][contenteditable]");
      return td && tableEl.contains(td) ? td : null;
    };

    const findHeaderCell = (target) => {
      if (!target) return null;
      const base = target.nodeType === Node.TEXT_NODE ? target.parentElement : target;
      const th = base?.closest?.("th[data-col]");
      return th && tableEl.contains(th) ? th : null;
    };

    // TH 요소에 tabindex 속성 추가하여 focus 가능하게 만듦
    const makeHeaderFocusable = () => {
      const headers = tableEl.querySelectorAll("thead th[data-col]");
      headers.forEach(th => {
        if (!th.hasAttribute("tabindex")) {
          th.setAttribute("tabindex", "-1");
        }
      });
    };

    tableEl.addEventListener("compositionstart", () => {
      composingByTable[kind] = true;
    });
    tableEl.addEventListener("compositionend", () => {
      composingByTable[kind] = false;
    });

    tableEl.addEventListener("keydown", (e) => {
      console.log(`[App.js Keydown Handler] kind=${kind}, key=${e.key}, target.tagName=${e.target.tagName}, target.className=${e.target.className}`);
      console.log(`[App.js Keydown Handler] tableEl.classList.contains("tabulator")=${tableEl.classList?.contains("tabulator")}`);
      
      if (tableEl.classList?.contains("tabulator")) {
        console.log(`[App.js Keydown Handler] Tabulator table detected, skipping app.js handler`);
        return;
      }

      // TD 셀에서의 방향키 이동
      const td = findEditableCell(e.target);
      console.log(`[App.js Keydown Handler] td element found: ${td ? 'yes' : 'no'}`);
      
      if (td) {
        console.log(`[App.js Keydown Handler] TD cell navigation mode`);
        if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
          console.log(`[App.js Keydown Handler] Key not handled: ${e.key}`);
          return;
        }
        if (e.isComposing || composingByTable[kind]) {
          console.log(`[App.js Keydown Handler] Composition in progress, skipping`);
          return;
        }

        const tr = td.closest("tr[data-row]");
        const currentRow = tr ? Number(tr.getAttribute("data-row")) : NaN;
        if (!Number.isFinite(currentRow)) return;

        const cols = getActiveEditor(kind).columns || [];
        const currentCol = td.getAttribute("data-col");
        const currentColIndex = cols.indexOf(currentCol);
        if (currentColIndex < 0) return;

        let nextRow = currentRow;
        let nextColIndex = currentColIndex;

        if (e.key === "ArrowUp") {
          if (currentRow === 0) {
            // 첫 번째 행에서 ↑를 누르면 컬럼 헤더로 이동
            e.preventDefault();
            e.stopPropagation(); // 파일 이동 이벤트 방지
            td.blur();
            // 공란("")인 경우 CSS.escape() 대신 직접 속성 선택자 사용
            const th = tableEl.querySelector(`thead th[data-col="${currentCol === "" ? "" : CSS.escape(currentCol)}"]`);
            if (th) {
              makeHeaderFocusable();
              // 편집 모드로 진입하고 커서를 맨 왼쪽에 위치
              th.contentEditable = "true";
              th.focus();
              setSelection(kind, -1, currentCol);
              
              // 커서를 텍스트 맨 왼쪽에 위치
              const sel = window.getSelection?.();
              if (sel) {
                const range = document.createRange();
                range.selectNodeContents(th);
                range.collapse(true); // true = 시작점으로 collapse (맨 왼쪽)
                sel.removeAllRanges();
                sel.addRange(range);
              }
            }
            return;
          }
          nextRow = currentRow - 1;
        } else if (e.key === "ArrowDown") {
          const totalRows = tableEl.querySelectorAll("tbody tr[data-row]").length;
          if (currentRow >= totalRows - 1) return;
          nextRow = currentRow + 1;
        } else {
          const caret = getCellCaretState(td);
          if (!caret.collapsed) return;
          if (e.key === "ArrowLeft") {
            if (!caret.atStart || currentColIndex === 0) return;
            nextColIndex = currentColIndex - 1;
          } else if (e.key === "ArrowRight") {
            if (!caret.atEnd || currentColIndex >= cols.length - 1) return;
            nextColIndex = currentColIndex + 1;
          }
        }

        e.preventDefault();
        td.blur();

        const nextCol = cols[nextColIndex];
        setSelection(kind, nextRow, nextCol);
        // 공란("")인 경우 CSS.escape() 대신 직접 속성 선택자 사용
        const nextCell = tableEl.querySelector(
          `tbody tr[data-row="${nextRow}"] td[data-col="${nextCol === "" ? "" : CSS.escape(nextCol)}"]`
        );
        focusEditableCell(nextCell, e.key === "ArrowLeft" ? "end" : "start");
        return;
      }

      // TH(컬럼 헤더)에서의 방향키 이동
      const th = findHeaderCell(e.target);
      if (th) {
        if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
        if (e.isComposing || composingByTable[kind]) return;

        const cols = getActiveEditor(kind).columns || [];
        const currentCol = th.getAttribute("data-col");
        // DOM에서 현재 TH의 실제 위치를 기반으로 인덱스 계산 (공란 열이 여러 개인 경우에도 정확하게 동작)
        const allHeaders = [...tableEl.querySelectorAll("thead th[data-col]")];
        const currentColIndex = allHeaders.indexOf(th);
        if (currentColIndex < 0) return;

        let nextColIndex = currentColIndex;

        if (e.key === "ArrowDown") {
          // ↓를 누르면 현재 컬럼의 첫 번째 행으로 이동
          e.preventDefault();
          e.stopPropagation(); // 파일 이동 이벤트 방지
          th.blur();
          // 현재 TH와 같은 위치에 있는 TD 찾기 (공란 열이 여러 개인 경우에도 정확하게 동작)
          const firstTd = tableEl.querySelector(`tbody tr[data-row="0"] td[data-col="${currentCol === "" ? "" : CSS.escape(currentCol)}"]`);
          if (firstTd) {
            setSelection(kind, 0, currentCol);
            focusEditableCell(firstTd, "start");
          }
          return;
        } else if (e.key === "ArrowLeft") {
          // 현재 커서 위치 확인 (TD와 동일한 로직)
          const caret = getCellCaretState(th);
          if (!caret.collapsed) return;
          if (!caret.atStart || currentColIndex === 0) return;
          nextColIndex = currentColIndex - 1;
        } else if (e.key === "ArrowRight") {
          // 현재 커서 위치 확인 (TD와 동일한 로직)
          const caret = getCellCaretState(th);
          if (!caret.collapsed) return;
          if (!caret.atEnd || currentColIndex >= cols.length - 1) return;
          nextColIndex = currentColIndex + 1;
        } else {
          // ↑를 누르면 TH에서 빠져나와 파일 리스트로 이동 가능하게 함
          e.preventDefault();
          e.stopPropagation(); // 파일 이동 이벤트 방지
          th.blur();
          return;
        }

        e.preventDefault();
        e.stopPropagation(); // 파일 이동 이벤트 방지
        th.blur();

        // DOM에서 직접 다음 TH 찾기 (공란 열이 여러 개인 경우에도 정확하게 동작)
        const nextTh = allHeaders[nextColIndex];
        if (nextTh) {
          const nextCol = nextTh.getAttribute("data-col");
          makeHeaderFocusable();
          // TH로 이동 후 즉시 편집 모드로 진입
          nextTh.contentEditable = "true";
          setSelection(kind, -1, nextCol);
          
          // focus 후 전체 텍스트 선택 (focus가 먼저 되어야 함)
          nextTh.focus();
          
          // ✅ 전체 텍스트 선택 (방향키로 이동할 때도 전체 선택 상태로)
          const sel = window.getSelection?.();
          if (sel) {
            const range = document.createRange();
            range.selectNodeContents(nextTh);
            sel.removeAllRanges();
            sel.addRange(range);
          }
        }
      }
    });

    // 테이블이 렌더링될 때마다 헤더에 tabindex 추가
    const observer = new MutationObserver(() => {
      makeHeaderFocusable();
    });
    observer.observe(tableEl, { childList: true, subtree: true });
    makeHeaderFocusable();
  };

  const onClick = (id, handler) => {
    const el = $(id);
    if (el) el.addEventListener("click", handler);
    return el;
  };

  const themeModeSelect = $("themeModeSelect");
  if (themeModeSelect) {
    const currentMode = document.documentElement.getAttribute("data-theme-mode") || "system";
    themeModeSelect.value = currentMode;
    themeModeSelect.addEventListener("change", () => {
      const mode = (themeModeSelect.value || "system").toLowerCase();
      applyTheme(mode);
      localStorage.setItem(THEME_STORAGE_KEY, mode);
    });
  }

  const tClassification = $("tabClassification");
  const tOcr = $("tabOcr");
  const tDb = $("tabDb");
  if (tClassification) tClassification.addEventListener("click", () => setTab("classification"));
  if (tOcr) tOcr.addEventListener("click", () => setTab("ocr"));
  if (tDb) tDb.addEventListener("click", () => setTab("db"));

  onClick("btnUploadImages", () => uploadImages().catch((e) => alert(e.message)));
  onClick("btnUploadPdf", () => uploadPdf().catch((e) => alert(e.message)));
  onClick("btnSaveEdits", () => saveEdits().catch((e) => alert(e.message)));
  onClick("btnSaveDb", () => saveToDb().catch((e) => alert(e.message)));
  onClick("btnApplyFileOverride", () => applySelectedFileOverride(false).catch((e) => alert(e.message)));
  onClick("btnReprocessWithOverride", () => applySelectedFileOverride(true).catch((e) => alert(e.message)));
  onClick("btnCancelJob", () => cancelSelectedJob().catch((e) => alert(e.message)));
  onClick("btnRetryJob", () => retrySelectedJob().catch((e) => alert(e.message)));
  onClick("btnMarkJobDone", () => {
    // 파일이 선택되어 있으면 파일만 완료, 아니면 작업 전체 완료
    if (state.selectedFileId) {
      markFileAsDone(state.selectedFileId).catch((e) => alert(e.message));
    } else {
      markJobAsDone().catch((e) => alert(e.message));
    }
  });

  // Upload selection cancel
  onClick("btnClearImage", () => clearFileInput("imageFiles"));
  onClick("btnClearPdf", () => clearFileInput("pdfFile"));

  // Upload kind toggle (image vs pdf)
  const imageCard = $("uploadImageCard");
  const pdfCard = $("uploadPdfCard");
  const uploadKindRadios = [...document.querySelectorAll('input[name="uploadKind"]')];
  function getUploadKind() {
    const checked = uploadKindRadios.find((r) => r && r.checked);
    return (checked?.value || "image").toLowerCase();
  }
  function applyUploadKind() {
    const kind = getUploadKind();
    if (kind === "pdf") {
      if (imageCard) imageCard.classList.add("hidden");
      if (pdfCard) pdfCard.classList.remove("hidden");
    } else {
      if (pdfCard) pdfCard.classList.add("hidden");
      if (imageCard) imageCard.classList.remove("hidden");
    }
  }
  if (uploadKindRadios.length) {
    uploadKindRadios.forEach((r) => r.addEventListener("change", applyUploadKind));
  }
  applyUploadKind();

  onClick("btnHealth", () => showHealth());
  onClick("btnDbConfig", async () => {
    await loadDbConfig().catch((e) => alert(e.message));
    openDbModal(true);
  });
  onClick("btnSaveDbConfig", () => saveDbConfig());

  const handleDbReload = async () => {
    state.db.offset = 0;
    const select = $("dbTableSelect");
    if (!select || !select.value) {
      await initDbScreen().catch((e) => alert(e.message));
      return;
    }
    loadDbDocs().catch((e) => alert(e.message));
  };

  document.addEventListener("change", (e) => {
    const target = e.target;
    if (target && target.id === "dbTableSelect") {
      state.db.offset = 0;
      state.db.selectedRowId = null;
      state.db.selectedDocKey = null;
      state.db.historyOffset = 0;
      state.db.historySelectedVersionId = null;
      loadDbDocs().catch((err) => alert(err.message));
      loadDbHistory("", { resetOffset: true }).catch(() => {});
    }
  });

  document.addEventListener("click", (e) => {
    const target = e.target;
    if (target && target.id === "btnDbReload") {
      handleDbReload().catch((err) => alert(err.message));
    }
  });

  const btnHistoryReload = $("btnDbHistoryReload");
  if (btnHistoryReload) {
    btnHistoryReload.addEventListener("click", () => {
      state.db.historyOffset = 0;
      loadDbHistory(state.db.selectedDocKey || "", { resetOffset: true }).catch((e) => alert(e.message));
    });
  }

  const btnHistoryPrev = $("btnDbHistoryPrev");
  if (btnHistoryPrev) {
    btnHistoryPrev.addEventListener("click", () => {
      state.db.historyOffset = Math.max(0, state.db.historyOffset - state.db.historyLimit);
      loadDbHistory(state.db.selectedDocKey || "").catch((e) => alert(e.message));
    });
  }

  const btnHistoryNext = $("btnDbHistoryNext");
  if (btnHistoryNext) {
    btnHistoryNext.addEventListener("click", () => {
      if (!state.db.historyHasMore) return;
      state.db.historyOffset += state.db.historyLimit;
      loadDbHistory(state.db.selectedDocKey || "").catch((e) => alert(e.message));
    });
  }

  const btnReload = $("btnDbReload");
  const btnPrev = $("btnDbPrev");
  if (btnPrev) btnPrev.addEventListener("click", () => { state.db.offset = Math.max(0, state.db.offset - state.db.limit); loadDbDocs().catch((e) => alert(e.message)); });
  const btnNext = $("btnDbNext");
  if (btnNext) btnNext.addEventListener("click", () => { if (state.db.offset + state.db.limit < state.db.total) state.db.offset += state.db.limit; loadDbDocs().catch((e) => alert(e.message)); });
  const btnSaveRow = $("btnDbSaveRow");
  if (btnSaveRow) btnSaveRow.addEventListener("click", () => saveDbRow().catch((e) => alert(e.message)));
  const btnDeleteRow = $("btnDbDeleteRow");
  if (btnDeleteRow) btnDeleteRow.addEventListener("click", () => deleteDbRow().catch((e) => alert(e.message)));
  const btnDeleteTable = $("btnDbDeleteTable");
  if (btnDeleteTable) btnDeleteTable.addEventListener("click", () => deleteDbTable().catch((e) => alert(e.message)));
  if (!btnReload) {
    console.warn("DB 화면 요소가 없습니다. db_layout.html 포함 여부를 확인해주세요.");
  }

  const dbTable = $("dbTableDataTable");
  if (dbTable) {
    bindEditableTableArrowNav(dbTable, "db");
    dbTable.addEventListener("click", (e) => {
      const t = e.target;
      if (!t) return;
      if (t.tagName === "TH") {
        setSelection("db", state.tableEdit.db.selectedRow, t.getAttribute("data-col"));
      }
      if (t.tagName === "TD") {
        const tr = t.closest("tr[data-row]");
        const row = tr ? Number(tr.getAttribute("data-row")) : null;
        const rIdx = Number.isFinite(row) ? row : null;
        setSelection("db", rIdx, t.getAttribute("data-col"));
        // 현재 문서에서 선택된 행 id를 매핑해서 저장/삭제가 가능하게 한다.
        if (rIdx !== null && Array.isArray(state.db.docRows) && state.db.docRows[rIdx]) {
          state.db.selectedRowId = state.db.docRows[rIdx].id;
          $("dbDetailTitle").textContent = `${state.db.selectedDocKey || ""} · row_id=${state.db.selectedRowId}`.trim();
        }
      }
    });
  }

  const ocrTable = $("resultTable");
  if (ocrTable) {
    bindEditableTableArrowNav(ocrTable, "ocr");
    ocrTable.addEventListener("click", (e) => {
      const t = e.target;
      if (!t) return;
      if (t.classList?.contains("col-delete-checkbox")) {
        const col = t.getAttribute("data-col");
        if (!col) return;
        if (t.checked) state.ocrBulkDelete.selectedColumnIds.add(col);
        else state.ocrBulkDelete.selectedColumnIds.delete(col);
        syncOcrBulkDeleteUi();
        return;
      }
      if (t.classList?.contains("row-delete-checkbox")) {
        const row = t.getAttribute("data-row");
        if (row === null) return;
        if (t.checked) state.ocrRowBulkDelete.selectedRowIds.add(String(row));
        else state.ocrRowBulkDelete.selectedRowIds.delete(String(row));
        syncOcrRowBulkDeleteUi();
        return;
      }
      if (t.tagName === "TH") {
        if (state.ocrBulkDelete.isMode) return;
        setSelection("ocr", state.tableEdit.ocr.selectedRow, t.getAttribute("data-col"));
      }
      if (t.tagName === "TD") {
        const tr = t.closest("tr[data-row]");
        const row = tr ? Number(tr.getAttribute("data-row")) : null;
        setSelection("ocr", Number.isFinite(row) ? row : null, t.getAttribute("data-col"));
      }
    });
    // 열 헤더 편집 기능: 더블클릭으로 편집 시작
    ocrTable.addEventListener("dblclick", (e) => {
      const t = e.target;
      if (state.ocrBulkDelete.isMode) return;
      if (t && t.tagName === "TH" && t.hasAttribute("data-col")) {
        const colName = t.getAttribute("data-col");
        const oldName = colName;
        t.contentEditable = "true";
        t.focus();
        
        // 전체 텍스트 선택
        const sel = window.getSelection?.();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(t);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        
        // 편집 종료 시 처리
        const finishEdit = () => {
          t.contentEditable = "false";
          const newName = (t.textContent || "").trim();
          if (newName && newName !== oldName) {
            renameColumn("ocr", oldName, newName);
          } else {
            t.textContent = oldName; // 취소 시 원래 이름으로 복원
          }
        };
        t.addEventListener("blur", finishEdit, { once: true });
        t.addEventListener("keydown", (ke) => {
          if (ke.key === "Enter") {
            ke.preventDefault();
            t.blur();
          } else if (ke.key === "Escape") {
            ke.preventDefault();
            t.textContent = oldName;
            t.blur();
          }
        }, { once: true });
      }
    });
  }

  // 이미지 미리보기 클릭 시 새 창에 크게 보기
  const previewImg = $("previewImg");
  if (previewImg) {
    previewImg.style.cursor = "pointer";
    previewImg.addEventListener("click", () => {
      const imgUrl = previewImg.dataset.imageUrl || previewImg.src;
      if (imgUrl) {
        // 미리보기에서 적용된 회전값까지 동일하게 적용해서 새 창에 표시
        // (rot: cw|ccw|180|"")
        const rot = previewImg.dataset.rot || "";
        
        // 팝업 창 참조 저장 (자동 업데이트용)
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
        
        // 팝업 창이 이미 열려있으면 닫고 다시 열기
        if (state.popupWindow && !state.popupWindow.closed) {
          state.popupWindow.close();
        }
        
        // 새 팝업 창 열기 (회전값 포함)
        const url = new URL("popup.html", window.location.href);
        url.searchParams.set("src", imgUrl);
        if (rot) url.searchParams.set("rot", rot);
        
        state.popupWindow = window.open(url.toString(), 'image_popup', popupFeatures);
      }
    });
  }
  
  // ContentGrid 토글 기능
  const btnToggleContentGrid = $("btnToggleContentGrid");
  const contentGrid = $("contentGrid");
  const contentGridToggleIcon = $("contentGridToggleIcon");
  const contentGridToggleText = $("contentGridToggleText");
  
  // 저장된 상태 불러오기
  const CONTENT_GRID_COLLAPSED_KEY = "ocr_ui_content_grid_collapsed";
  let isContentGridCollapsed = localStorage.getItem(CONTENT_GRID_COLLAPSED_KEY) === "true";
  
  // 초기 상태 적용
  if (isContentGridCollapsed && contentGrid) {
    contentGrid.classList.add("collapsed");
    if (contentGridToggleIcon) contentGridToggleIcon.textContent = "▶";
    if (contentGridToggleText) contentGridToggleText.textContent = "미리보기/편집 보기";
  }
  
  // 토글 버튼 이벤트
  if (btnToggleContentGrid) {
    btnToggleContentGrid.addEventListener("click", () => {
      isContentGridCollapsed = !isContentGridCollapsed;
      
      if (contentGrid) {
        contentGrid.classList.toggle("collapsed", isContentGridCollapsed);
      }
      
      if (contentGridToggleIcon) {
        contentGridToggleIcon.textContent = isContentGridCollapsed ? "▶" : "▼";
      }
      
      if (contentGridToggleText) {
        contentGridToggleText.textContent = isContentGridCollapsed ? "미리보기/편집 보기" : "미리보기/편집 숨기기";
      }
      
      // 상태 저장
      localStorage.setItem(CONTENT_GRID_COLLAPSED_KEY, String(isContentGridCollapsed));
    });
  }
  
  // 팝업 창이 닫혔는지 주기적으로 확인
  setInterval(() => {
    if (state.popupWindow && state.popupWindow.closed) {
      state.popupWindow = null;
    }
  }, 1000);

  const syncOcrBulkDeleteUi = () => {
    const bulk = state.ocrBulkDelete;
    const startBtn = $("ocrBulkDeleteStart");
    const actions = $("ocrBulkDeleteActions");
    const countHint = $("ocrBulkDeleteCount");
    const confirmBtn = $("ocrBulkDeleteConfirm");
    const selectAllBtn = $("ocrBulkDeleteSelectAll");

    const selectedCount = bulk.selectedColumnIds.size;
    const columns = getActiveEditor("ocr").columns || [];
    const allSelected = columns.length > 0 && selectedCount === columns.length;

    if (startBtn) {
      startBtn.classList.toggle("hidden", bulk.isMode);
      startBtn.disabled = bulk.isDeleting;
    }
    if (actions) actions.classList.toggle("hidden", !bulk.isMode);
    if (countHint) countHint.textContent = `선택 ${selectedCount}개`;
    if (confirmBtn) confirmBtn.disabled = selectedCount === 0 || bulk.isDeleting;
    if (selectAllBtn) {
      selectAllBtn.textContent = allSelected ? "전체 해제" : "전체 선택";
      selectAllBtn.disabled = columns.length === 0 || bulk.isDeleting;
    }
  };

  const rerenderOcrTableForBulkDelete = () => {
    const cols = getActiveEditor("ocr").columns || [];
    const rows = getTableRowsFromDom("ocr");
    rerender("ocr", rows, cols);
    syncOcrBulkDeleteUi();
  };

  const enterOcrBulkDeleteMode = () => {
    if (state.ocrRowBulkDelete.isMode) exitOcrRowBulkDeleteMode();
    state.ocrBulkDelete.isMode = true;
    state.ocrBulkDelete.selectedColumnIds = new Set();
    rerenderOcrTableForBulkDelete();
  };

  const exitOcrBulkDeleteMode = () => {
    state.ocrBulkDelete.isMode = false;
    state.ocrBulkDelete.isDeleting = false;
    state.ocrBulkDelete.selectedColumnIds = new Set();
    openOcrBulkDeleteModal(false);
    rerenderOcrTableForBulkDelete();
  };

  const syncOcrRowBulkDeleteUi = () => {
    const bulk = state.ocrRowBulkDelete;
    const startBtn = $("ocrRowBulkDeleteStart");
    const actions = $("ocrRowBulkDeleteActions");
    const countHint = $("ocrRowBulkDeleteCount");
    const confirmBtn = $("ocrRowBulkDeleteConfirm");
    const selectAllBtn = $("ocrRowBulkDeleteSelectAll");

    const selectedCount = bulk.selectedRowIds.size;
    // Tabulator 인스턴스가 초기화되지 않은 경우 안전하게 처리
    let totalRows = 0;
    try {
      totalRows = getTableRowsFromDom("ocr").length;
    } catch (e) {
      // Tabulator가 아직 초기화되지 않은 경우
      console.warn("Tabulator 인스턴스가 아직 초기화되지 않음:", e);
    }
    const allSelected = totalRows > 0 && selectedCount === totalRows;

    if (startBtn) {
      startBtn.classList.toggle("hidden", bulk.isMode);
      startBtn.disabled = bulk.isDeleting;
    }
    if (actions) actions.classList.toggle("hidden", !bulk.isMode);
    if (countHint) countHint.textContent = `선택 ${selectedCount}개`;
    if (confirmBtn) confirmBtn.disabled = selectedCount === 0 || bulk.isDeleting;
    if (selectAllBtn) {
      selectAllBtn.textContent = allSelected ? "전체 해제" : "전체 선택";
      selectAllBtn.disabled = totalRows === 0 || bulk.isDeleting;
    }
  };

  const rerenderOcrTableForRowBulkDelete = () => {
    const cols = getActiveEditor("ocr").columns || [];
    const rows = getTableRowsFromDom("ocr");
    rerender("ocr", rows, cols);
    syncOcrRowBulkDeleteUi();
  };

  const enterOcrRowBulkDeleteMode = () => {
    if (state.ocrBulkDelete.isMode) exitOcrBulkDeleteMode();
    state.ocrRowBulkDelete.isMode = true;
    state.ocrRowBulkDelete.selectedRowIds = new Set();
    rerenderOcrTableForRowBulkDelete();
  };

  const exitOcrRowBulkDeleteMode = () => {
    state.ocrRowBulkDelete.isMode = false;
    state.ocrRowBulkDelete.isDeleting = false;
    state.ocrRowBulkDelete.selectedRowIds = new Set();
    openOcrRowBulkDeleteModal(false);
    rerenderOcrTableForRowBulkDelete();
  };

  // OCR table toolbar
  const bindTableToolbar = (kind) => {
    const addRowBtn = $(kind === "ocr" ? "ocrAddRow" : "dbAddRow");
    const delRowBtn = $(kind === "ocr" ? "ocrDelRow" : "dbDelRow");
    const addEndBtn = $(kind === "ocr" ? "ocrAddColEnd" : "dbAddColEnd");
    const addDefaultChemBtn = kind === "ocr" ? $("ocrAddDefaultChemCols") : null;
    const rowUp = $(kind === "ocr" ? "ocrMoveRowUp" : "dbMoveRowUp");
    const rowDown = $(kind === "ocr" ? "ocrMoveRowDown" : "dbMoveRowDown");

    const insBtn = $(kind === "ocr" ? "ocrInsertCol" : "dbInsertCol");
    const delColBtn = $(kind === "ocr" ? "ocrDelCol" : "dbDelCol");
    const leftBtn = $(kind === "ocr" ? "ocrColLeft" : "dbColLeft");
    const rightBtn = $(kind === "ocr" ? "ocrColRight" : "dbColRight");
    const copyAllBtn = $(kind === "ocr" ? "ocrCopyAll" : "dbCopyAll");

    const undoBtn = $(kind === "ocr" ? "ocrUndoDelete" : "dbUndoDelete");

    if (addRowBtn) addRowBtn.addEventListener("click", () => addRow(kind));
    if (delRowBtn) delRowBtn.addEventListener("click", () => deleteRow(kind));
    if (addEndBtn) addEndBtn.addEventListener("click", () => {
      // ✅ 성능 최적화: 열 추가 전 저장을 비동기로 실행하여 UI 차단 방지
      if (kind === "ocr") {
        // await 제거: 저장을 백그라운드에서 비동기로 실행하여 열 추가 속도 향상
        saveEdits({ silent: true, reason: "add_column" }).catch(e => {
          console.warn("열 추가 전 저장 실패:", e);
        });
      }
      if (kind === "ocr") {
        addTempColumn(kind);
      } else {
        addOrInsertColumn(kind, "end");
      }
    });
    
    // 기본열 드롭다운 메뉴 기능
    if (addDefaultChemBtn) {
      const dropdown = $("ocrAddDefaultChemColsDropdown");
      const menu = $("ocrAddDefaultChemColsMenu");
      
      // 버튼 클릭 시 드롭다운 토글
      addDefaultChemBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (menu) {
          menu.classList.toggle("hidden");
        }
      });
      
      // 드롭다운 메뉴 아이템 클릭 처리
      const menuItems = menu?.querySelectorAll(".dropdown-item");
      if (menuItems) {
        menuItems.forEach(item => {
          item.addEventListener("click", async (e) => {
            e.stopPropagation();
            const type = item.getAttribute("data-type");
            
            try {
              await saveEdits({ silent: true, reason: `add_${type}_columns` });
            } catch (err) {
              console.warn("열 추가 전 저장 실패:", err);
            }
            
            // 선택한 타입에 따라 다른 열 추가
            if (type === "material") {
              addMaterialColumns(kind).catch((err) => console.warn("자재일람표 열 추가 실패:", err));
            } else if (type === "test") {
              addTestReportColumns(kind).catch((err) => console.warn("시험성적서 열 추가 실패:", err));
            }
            
            // 메뉴 닫기
            if (menu) {
              menu.classList.add("hidden");
            }
          });
        });
      }
      
      // 다른 곳 클릭 시 드롭다운 닫기
      document.addEventListener("click", (e) => {
        if (dropdown && !dropdown.contains(e.target)) {
          if (menu) {
            menu.classList.add("hidden");
          }
        }
      });
    }

    if (rowUp && rowUp.dataset.rowMoveBound !== "1") {
      rowUp.dataset.rowMoveBound = "1";
      rowUp.addEventListener("click", () => moveRow(kind, -1));
    }
    if (rowDown && rowDown.dataset.rowMoveBound !== "1") {
      rowDown.dataset.rowMoveBound = "1";
      rowDown.addEventListener("click", () => moveRow(kind, +1));
    }

    if (insBtn) insBtn.addEventListener("click", async () => {
      // 열 추가 전에 현재 테이블 상태 저장
      if (kind === "ocr") {
        try {
          await saveEdits({ silent: true, reason: "add_column" });
        } catch (e) {
          console.warn("열 추가 전 저장 실패:", e);
        }
      }
      addOrInsertColumn(kind, "insert");
    });
    if (delColBtn) delColBtn.addEventListener("click", () => {
      deleteColumn(kind).catch((err) => console.warn("열 삭제 실패:", err));
    });
    if (leftBtn) leftBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // 버튼 클릭 후 포커스를 버튼에서 제거하여 열 헤더 포커스 유지
      leftBtn.blur();
      moveColumn(kind, -1);
    });
    if (rightBtn) rightBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // 버튼 클릭 후 포커스를 버튼에서 제거하여 열 헤더 포커스 유지
      rightBtn.blur();
      moveColumn(kind, +1);
    });
    if (copyAllBtn) copyAllBtn.addEventListener("click", () => copyAllTableToClipboard(kind));

    if (undoBtn) undoBtn.addEventListener("click", () => undoDelete(kind));
  };
  bindTableToolbar("ocr");
  bindTableToolbar("db");

  const ocrBulkDeleteStart = $("ocrBulkDeleteStart");
  if (ocrBulkDeleteStart) ocrBulkDeleteStart.addEventListener("click", enterOcrBulkDeleteMode);

  const ocrBulkDeleteCancel = $("ocrBulkDeleteCancel");
  if (ocrBulkDeleteCancel) ocrBulkDeleteCancel.addEventListener("click", exitOcrBulkDeleteMode);

  const ocrBulkDeleteSelectAll = $("ocrBulkDeleteSelectAll");
  if (ocrBulkDeleteSelectAll) {
    ocrBulkDeleteSelectAll.addEventListener("click", () => {
      const cols = getActiveEditor("ocr").columns || [];
      const bulk = state.ocrBulkDelete;
      const allSelected = cols.length > 0 && bulk.selectedColumnIds.size === cols.length;
      bulk.selectedColumnIds = allSelected ? new Set() : new Set(cols);
      rerenderOcrTableForBulkDelete();
    });
  }

  const ocrBulkDeleteConfirm = $("ocrBulkDeleteConfirm");
  if (ocrBulkDeleteConfirm) {
    ocrBulkDeleteConfirm.addEventListener("click", () => {
      const selectedCount = state.ocrBulkDelete.selectedColumnIds.size;
      if (selectedCount < 1) return;
      const textEl = $("ocrBulkDeleteModalText");
      if (textEl) textEl.textContent = `선택한 ${selectedCount}개 열을 삭제하시겠습니까?`;
      openOcrBulkDeleteModal(true);
    });
  }

  const executeBulkDelete = async () => {
    const bulk = state.ocrBulkDelete;
    const selected = [...bulk.selectedColumnIds];
    if (!selected.length) return;
    bulk.isDeleting = true;
    syncOcrBulkDeleteUi();
    const result = await deleteColumns("ocr", selected);
    bulk.isDeleting = false;
    alert(`${result.deletedCount}개 열이 삭제되었습니다.`);
    exitOcrBulkDeleteMode();
  };

  const ocrBulkDeleteModalSubmit = $("ocrBulkDeleteModalSubmit");
  if (ocrBulkDeleteModalSubmit) {
    ocrBulkDeleteModalSubmit.addEventListener("click", () => {
      executeBulkDelete().catch((err) => {
        state.ocrBulkDelete.isDeleting = false;
        syncOcrBulkDeleteUi();
        console.warn("열 벌크 삭제 실패:", err);
      });
    });
    // ✅ Enter 키로 열 삭제 실행
    ocrBulkDeleteModalSubmit.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        executeBulkDelete().catch((err) => {
          state.ocrBulkDelete.isDeleting = false;
          syncOcrBulkDeleteUi();
          console.warn("열 벌크 삭제 실패:", err);
        });
      }
    });
  }
  const ocrBulkDeleteModalCancel = $("ocrBulkDeleteModalCancel");
  if (ocrBulkDeleteModalCancel) ocrBulkDeleteModalCancel.addEventListener("click", () => openOcrBulkDeleteModal(false));
  const ocrBulkDeleteModalClose = $("ocrBulkDeleteModalClose");
  if (ocrBulkDeleteModalClose) ocrBulkDeleteModalClose.addEventListener("click", () => openOcrBulkDeleteModal(false));

  const ocrRowBulkDeleteStart = $("ocrRowBulkDeleteStart");
  if (ocrRowBulkDeleteStart) ocrRowBulkDeleteStart.addEventListener("click", enterOcrRowBulkDeleteMode);

  const ocrRowBulkDeleteCancel = $("ocrRowBulkDeleteCancel");
  if (ocrRowBulkDeleteCancel) ocrRowBulkDeleteCancel.addEventListener("click", exitOcrRowBulkDeleteMode);

  const ocrRowBulkDeleteSelectAll = $("ocrRowBulkDeleteSelectAll");
  if (ocrRowBulkDeleteSelectAll) {
    ocrRowBulkDeleteSelectAll.addEventListener("click", () => {
      const rows = getTableRowsFromDom("ocr");
      const bulk = state.ocrRowBulkDelete;
      const allSelected = rows.length > 0 && bulk.selectedRowIds.size === rows.length;
      bulk.selectedRowIds = allSelected ? new Set() : new Set(rows.map((_, idx) => String(idx)));
      rerenderOcrTableForRowBulkDelete();
    });
  }

  const ocrRowBulkDeleteConfirm = $("ocrRowBulkDeleteConfirm");
  if (ocrRowBulkDeleteConfirm) {
    ocrRowBulkDeleteConfirm.addEventListener("click", () => {
      const selectedCount = state.ocrRowBulkDelete.selectedRowIds.size;
      if (selectedCount < 1) return;
      const textEl = $("ocrRowBulkDeleteModalText");
      if (textEl) textEl.textContent = `선택한 ${selectedCount}개 행을 삭제하시겠습니까?`;
      openOcrRowBulkDeleteModal(true);
    });
  }

  const executeRowBulkDelete = () => {
    const bulk = state.ocrRowBulkDelete;
    const selected = [...bulk.selectedRowIds].map((x) => Number(x));
    if (!selected.length) return;
    bulk.isDeleting = true;
    syncOcrRowBulkDeleteUi();
    const result = deleteRows("ocr", selected);
    bulk.isDeleting = false;
    alert(`${result.deletedCount}개 행이 삭제되었습니다.`);
    exitOcrRowBulkDeleteMode();
  };

  const ocrRowBulkDeleteModalSubmit = $("ocrRowBulkDeleteModalSubmit");
  if (ocrRowBulkDeleteModalSubmit) {
    ocrRowBulkDeleteModalSubmit.addEventListener("click", executeRowBulkDelete);
    // ✅ Enter 키로 행 삭제 실행
    ocrRowBulkDeleteModalSubmit.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        executeRowBulkDelete();
      }
    });
  }
  const ocrRowBulkDeleteModalCancel = $("ocrRowBulkDeleteModalCancel");
  if (ocrRowBulkDeleteModalCancel) ocrRowBulkDeleteModalCancel.addEventListener("click", () => openOcrRowBulkDeleteModal(false));
  const ocrRowBulkDeleteModalClose = $("ocrRowBulkDeleteModalClose");
  if (ocrRowBulkDeleteModalClose) ocrRowBulkDeleteModalClose.addEventListener("click", () => openOcrRowBulkDeleteModal(false));

  syncOcrBulkDeleteUi();
  syncOcrRowBulkDeleteUi();

  const dbModal = $("dbModal");
  if (dbModal) {
    dbModal.addEventListener("click", (e) => {
      const t = e.target;
      if (t && t.getAttribute && t.getAttribute("data-close") === "1") openDbModal(false);
    });
  }
  const ocrBulkDeleteModal = $("ocrBulkDeleteModal");
  if (ocrBulkDeleteModal) {
    ocrBulkDeleteModal.addEventListener("click", (e) => {
      const t = e.target;
      if (t && t.getAttribute && t.getAttribute("data-close") === "1") openOcrBulkDeleteModal(false);
    });
  }
  const ocrRowBulkDeleteModal = $("ocrRowBulkDeleteModal");
  if (ocrRowBulkDeleteModal) {
    ocrRowBulkDeleteModal.addEventListener("click", (e) => {
      const t = e.target;
      if (t && t.getAttribute && t.getAttribute("data-close") === "1") openOcrRowBulkDeleteModal(false);
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      openDbModal(false);
      openOcrBulkDeleteModal(false);
      openOcrRowBulkDeleteModal(false);
    }
  });

  // 작업 목록 필터/검색
  const jobStatusFilter = $("jobStatusFilter");
  if (jobStatusFilter) {
    jobStatusFilter.value = state.jobsUi.status || "all";
    jobStatusFilter.addEventListener("change", () => {
      state.jobsUi.status = (jobStatusFilter.value || "all").toLowerCase();
      saveSidebarState();
      refreshJobs().catch((e) => alert(e.message));
    });
  }

  const fileViewFilter = $("fileViewFilter");
  if (fileViewFilter) {
    fileViewFilter.value = state.jobsUi.fileView || "all";
    fileViewFilter.addEventListener("change", () => {
      const newValue = fileViewFilter.value || "all";
      // 값이 실제로 변경되었을 때만 처리
      if (newValue !== state.jobsUi.fileView) {
        state.jobsUi.fileView = newValue;
        saveSidebarState();
        // 파일 목록 시그니처 초기화하여 강제 렌더링
        state._lastFileListSignature = "";
        state._lastSelectedFileSig = "";
        // 작업이 선택되어 있으면 캐시된 데이터로 파일 목록 다시 렌더링
        if (state.selectedJobId) {
          const cached = state.jobsDbCache[state.selectedJobId];
          if (cached && cached.jobDetail) {
            updateJobDetailFromPayload(cached.jobDetail).catch((e) => alert(e.message));
          } else {
            refreshJobDetail().catch((e) => alert(e.message));
          }
        }
      }
    });
  }

  // Classification page job logs
  const classificationJobLogsDrawer = $("jobLogsDrawer");
  const classificationJobLogsDrawerHeader = $("jobLogsDrawerHeader");
  const btnClassificationLogsToggle = $("btnJobLogsToggle");
  const btnClassificationLogsClose = $("btnJobLogsClose");
  const btnClassificationLogsReset = $("btnJobLogsReset");

  // OCR page job logs
  const ocrJobLogsDrawer = $("ocrJobLogsDrawer");
  const ocrJobLogsDrawerHeader = $("ocrJobLogsDrawerHeader");
  const btnOcrLogsToggle = $("btnOcrJobLogsToggle");
  const btnOcrLogsClose = $("btnOcrJobLogsClose");
  const btnOcrLogsReset = $("btnOcrJobLogsReset");
  const btnOcrLogsScrollBottom = $("btnOcrJobLogsScrollBottom");

  const applyJobLogsRect = (drawer) => {
    if (!drawer) return;
    const rect = state.jobLogsUi?.drawerRect || {};
    drawer.style.width = rect.width ? `${rect.width}px` : "";
    drawer.style.height = rect.height ? `${rect.height}px` : "";
    drawer.style.left = rect.left != null ? `${rect.left}px` : "";
    drawer.style.top = rect.top != null ? `${rect.top}px` : "";
    drawer.style.right = rect.left != null ? "auto" : "24px";
    drawer.style.bottom = rect.top != null ? "auto" : "74px";
  };

  const saveJobLogsRect = (drawer) => {
    if (!drawer) return;
    const r = drawer.getBoundingClientRect();
    state.jobLogsUi.drawerRect = {
      width: Math.round(r.width),
      height: Math.round(r.height),
      left: Math.round(r.left),
      top: Math.round(r.top),
    };
  };

  const resetJobLogsRect = (drawer) => {
    if (!state.jobLogsUi) return;
    state.jobLogsUi.drawerRect = { width: null, height: null, left: null, top: null };
    if (drawer) {
      drawer.style.width = "";
      drawer.style.height = "";
      drawer.style.left = "";
      drawer.style.top = "";
      drawer.style.right = "24px";
      drawer.style.bottom = "74px";
    }
  };

  const applyJobLogsDrawer = (open, drawer, btnToggle) => {
    state.jobLogsUi.open = !!open;
    if (drawer) {
      drawer.classList.toggle("hidden", !open);
      drawer.setAttribute("aria-hidden", open ? "false" : "true");
      if (open) applyJobLogsRect(drawer);
    }
    if (btnToggle) {
      btnToggle.setAttribute("aria-expanded", open ? "true" : "false");
      btnToggle.textContent = open ? "로그 숨기기" : "시스템 로그";
    }
  };

  // Initialize classification page job logs
  applyJobLogsDrawer(state.jobLogsUi?.open === true, classificationJobLogsDrawer, btnClassificationLogsToggle);

  if (btnClassificationLogsToggle) {
    btnClassificationLogsToggle.addEventListener("click", () => {
      applyJobLogsDrawer(!(state.jobLogsUi?.open === true), classificationJobLogsDrawer, btnClassificationLogsToggle);
    });
  }
  if (btnClassificationLogsClose) {
    btnClassificationLogsClose.addEventListener("click", () => applyJobLogsDrawer(false, classificationJobLogsDrawer, btnClassificationLogsToggle));
  }
  if (btnClassificationLogsReset) {
    btnClassificationLogsReset.addEventListener("click", () => resetJobLogsRect(classificationJobLogsDrawer));
  }

  // Initialize OCR page job logs
  applyJobLogsDrawer(state.jobLogsUi?.open === true, ocrJobLogsDrawer, btnOcrLogsToggle);

  if (btnOcrLogsToggle) {
    btnOcrLogsToggle.addEventListener("click", () => {
      applyJobLogsDrawer(!(state.jobLogsUi?.open === true), ocrJobLogsDrawer, btnOcrLogsToggle);
    });
  }
  if (btnOcrLogsClose) {
    btnOcrLogsClose.addEventListener("click", () => applyJobLogsDrawer(false, ocrJobLogsDrawer, btnOcrLogsToggle));
  }
  if (btnOcrLogsReset) {
    btnOcrLogsReset.addEventListener("click", () => resetJobLogsRect(ocrJobLogsDrawer));
  }

  // Classification page drawer drag functionality
  if (classificationJobLogsDrawerHeader && classificationJobLogsDrawer) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    classificationJobLogsDrawerHeader.addEventListener("mousedown", (e) => {
      const target = e.target;
      if (target && (target.closest("button") || target.closest("a") || target.closest("input"))) return;
      const rect = classificationJobLogsDrawer.getBoundingClientRect();
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      classificationJobLogsDrawer.classList.add("dragging");
      classificationJobLogsDrawer.style.right = "auto";
      classificationJobLogsDrawer.style.bottom = "auto";
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const nextLeft = Math.max(8, Math.min(window.innerWidth - 120, startLeft + dx));
      const nextTop = Math.max(8, Math.min(window.innerHeight - 80, startTop + dy));
      classificationJobLogsDrawer.style.left = `${nextLeft}px`;
      classificationJobLogsDrawer.style.top = `${nextTop}px`;
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      classificationJobLogsDrawer.classList.remove("dragging");
      saveJobLogsRect(classificationJobLogsDrawer);
    });

    const persistRectByResize = () => {
      if (state.jobLogsUi?.open === true) saveJobLogsRect(classificationJobLogsDrawer);
    };
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => persistRectByResize());
      ro.observe(classificationJobLogsDrawer);
    }
  }

  // OCR page drawer drag functionality
  if (ocrJobLogsDrawerHeader && ocrJobLogsDrawer) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    ocrJobLogsDrawerHeader.addEventListener("mousedown", (e) => {
      const target = e.target;
      if (target && (target.closest("button") || target.closest("a") || target.closest("input"))) return;
      const rect = ocrJobLogsDrawer.getBoundingClientRect();
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      ocrJobLogsDrawer.classList.add("dragging");
      ocrJobLogsDrawer.style.right = "auto";
      ocrJobLogsDrawer.style.bottom = "auto";
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const nextLeft = Math.max(8, Math.min(window.innerWidth - 120, startLeft + dx));
      const nextTop = Math.max(8, Math.min(window.innerHeight - 80, startTop + dy));
      ocrJobLogsDrawer.style.left = `${nextLeft}px`;
      ocrJobLogsDrawer.style.top = `${nextTop}px`;
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      ocrJobLogsDrawer.classList.remove("dragging");
      saveJobLogsRect(ocrJobLogsDrawer);
    });

    const persistRectByResize = () => {
      if (state.jobLogsUi?.open === true) saveJobLogsRect(ocrJobLogsDrawer);
    };
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => persistRectByResize());
      ro.observe(ocrJobLogsDrawer);
    }
  }

  // Classification page logs scroll
  const classificationJobLogs = $("jobLogs");
  if (classificationJobLogs) {
    classificationJobLogs.addEventListener("scroll", () => {
      const nearBottom = classificationJobLogs.scrollHeight - (classificationJobLogs.scrollTop + classificationJobLogs.clientHeight) < 16;
      state.jobLogsUi.autoScroll = nearBottom;
    });
  }

  // OCR page logs scroll
  const ocrJobLogs = $("ocrJobLogs");
  if (ocrJobLogs) {
    ocrJobLogs.addEventListener("scroll", () => {
      const nearBottom = ocrJobLogs.scrollHeight - (ocrJobLogs.scrollTop + ocrJobLogs.clientHeight) < 16;
      state.jobLogsUi.autoScroll = nearBottom;
    });
  }

  if (btnOcrLogsScrollBottom) {
    btnOcrLogsScrollBottom.addEventListener("click", () => {
      const panel = $("ocrJobLogs");
      if (!panel) return;
      panel.scrollTop = panel.scrollHeight;
      state.jobLogsUi.autoScroll = true;
    });
  }

  const jobSearch = $("jobSearch");
  if (jobSearch) {
    jobSearch.value = state.jobsUi.q || "";
    jobSearch.addEventListener("input", () => {
      state.jobsUi.q = jobSearch.value || "";
      saveSidebarState();
      refreshJobs().catch(() => {});
    });
  }

  // 파일 검색
  const fileSearch = $("fileSearch");
  if (fileSearch) {
    fileSearch.value = state.jobsUi.fileQ || "";
    fileSearch.addEventListener("input", () => {
      state.jobsUi.fileQ = fileSearch.value || "";
      saveSidebarState();
      // 파일 목록 시그니처 초기화하여 강제 렌더링
      state._lastFileListSignature = "";
      // 작업이 선택되어 있으면 캐시된 데이터로 파일 목록 다시 렌더링
      if (state.selectedJobId) {
        const cached = state.jobsDbCache[state.selectedJobId];
        if (cached && cached.jobDetail) {
          updateJobDetailFromPayload(cached.jobDetail).catch((e) => alert(e.message));
        } else {
          refreshJobDetail().catch((e) => alert(e.message));
        }
      }
    });
  }

  const filesContainer = $("files");
  if (filesContainer) {
    filesContainer.addEventListener("scroll", saveFileListScroll, { passive: true });
    restoreFileListScroll(false);
  }

  // 처리 파이프라인 모달 기능
  const pipelineModal = $("pipelineModal");
  const btnShowPipeline = $("btnShowPipeline");
  const btnClosePipelineModal = $("btnClosePipelineModal");

  const openPipelineModal = (open) => {
    if (!pipelineModal) return;
    pipelineModal.setAttribute("aria-hidden", open ? "false" : "true");
    pipelineModal.classList.toggle("hidden", !open);
  };

  if (btnShowPipeline) {
    btnShowPipeline.addEventListener("click", () => {
      openPipelineModal(true);
    });
  }

  if (btnClosePipelineModal) {
    btnClosePipelineModal.addEventListener("click", () => {
      openPipelineModal(false);
    });
  }

  if (pipelineModal) {
    pipelineModal.addEventListener("click", (e) => {
      const t = e.target;
      if (t && t.getAttribute && t.getAttribute("data-close") === "1") {
        openPipelineModal(false);
      }
    });
  }

  // Ctrl+S 단축키: DB 저장
  document.addEventListener("keydown", (e) => {
    // Ctrl+S 또는 Cmd+S 단축키 처리
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault(); // 브라우저 기본 저장 동작 방지
      
      // DB 저장 버튼과 동일한 기능 실행
      saveToDb().catch((err) => alert(err.message));
    }
  });

  // OCR 처리 페이지 단축키: 방향키로 파일 리스트 이동
  document.addEventListener("keydown", (e) => {
    // OCR 처리 페이지가 활성화되어 있을 때만
    const ocrScreen = $("screenOcr");
    if (!ocrScreen || ocrScreen.classList.contains("hidden")) return;

    // 입력 필드에서는 단축키 무시
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
    
    // 테이블 내부에서는 파일 네비게이션 무시 (Tabulator 테이블만)
    const resultTable = $("resultTable");
    if (resultTable && resultTable.classList.contains("tabulator") && resultTable.contains(e.target)) {
      return;
    }

    // 방향키로 파일 리스트 네비게이션 (분류 탭과 동일한 로직)
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      navigateToFileList(e.key);
    }
  });

  // 이전/다음 작업으로 이동하는 함수
  async function navigateToJob(direction) {
    const jobsContainer = $("jobs");
    if (!jobsContainer) return;

    const jobItems = [...jobsContainer.querySelectorAll("[data-job]")];
    if (jobItems.length === 0) return;

    const currentIndex = jobItems.findIndex(item => item.getAttribute("data-job") === state.selectedJobId);
    
    let nextIndex;
    if (direction === -1) {
      // 이전 작업
      nextIndex = currentIndex <= 0 ? jobItems.length - 1 : currentIndex - 1;
    } else {
      // 다음 작업
      nextIndex = currentIndex >= jobItems.length - 1 ? 0 : currentIndex + 1;
    }

    const nextJobId = jobItems[nextIndex].getAttribute("data-job");
    if (nextJobId && nextJobId !== state.selectedJobId) {
      await selectJob(nextJobId);
    }
  }

  // ✅ 성능 최적화: 캐싱된 import로 방향키 이동 속도 개선
  let cachedSaveEdits = null;
  let cachedSelectFile = null;

  // 파일 리스트에서 방향키로 이동하는 함수 (분류 탭의 goToPrevPage/goToNextPage 로직 활용)
  async function navigateToFileList(key) {
    const filesContainer = $("files");
    if (!filesContainer) return;

    const fileItems = [...filesContainer.querySelectorAll("[data-file]")];
    if (fileItems.length === 0) return;

    const currentIndex = fileItems.findIndex(item => item.getAttribute("data-file") === state.selectedFileId);
    
    let nextIndex;
    if (key === "ArrowUp") {
      // 이전 파일 (분류 탭의 goToPrevPage와 동일)
      if (currentIndex <= 0) return; // 첫 번째 파일에서는 이동하지 않음
      nextIndex = currentIndex - 1;
    } else if (key === "ArrowDown") {
      // 다음 파일 (분류 탭의 goToNextPage와 동일)
      if (currentIndex >= fileItems.length - 1) return; // 마지막 파일에서는 이동하지 않음
      nextIndex = currentIndex + 1;
    } else {
      return;
    }

    const nextFileId = fileItems[nextIndex].getAttribute("data-file");
    if (nextFileId && nextFileId !== state.selectedFileId) {
      // ✅ 파일 전환 전 저장 (안전하게 await 사용)
      try {
        if (!cachedSaveEdits) {
          cachedSaveEdits = await import("./table_edit_fix.js");
        }
        if (state.selectedFileId && state.currentResult) {
          await cachedSaveEdits.saveEdits({ silent: true, reason: "arrow_navigation" });
        }
      } catch (e) {
        console.warn("방향키 이동 전 저장 실패:", e);
      }
      
      // ✅ 성능 최적화: 캐싱된 import 사용
      if (!cachedSelectFile) {
        cachedSelectFile = await import("./api.js");
      }
      await cachedSelectFile.selectFile(nextFileId);
      
      // ✅ 성능 최적화: 즉시 스크롤 (requestAnimationFrame 제거)
      const currentFilesContainer = $("files");
      if (!currentFilesContainer) return;
      
      // 파일 ID로 찾기 (인덱스 대신)
      const updatedFileItems = [...currentFilesContainer.querySelectorAll("[data-file]")];
      const updatedNextFileItem = updatedFileItems.find(item => 
        item.getAttribute("data-file") === nextFileId
      );
      
      if (updatedNextFileItem) {
        updatedNextFileItem.scrollIntoView({ behavior: "auto", block: "nearest" });
        updatedNextFileItem.focus({ preventScroll: true });
        saveFileListScroll();
      }
    }
  }
}

async function init() {
  initTheme();
  loadSidebarState();
  bindUi();

  // 테이블 편집 수정 기능 초기화
  initTableEditFix("ocr");
  initTableEditFix("db");

  try {
    requireApiBase();
  } catch (e) {
    return;
  }

  // 초기화 시 기본 탭(분류)만 보이도록 설정
  // HTML partials에 이미 hidden 클래스가 있으므로 바로 실행 가능
  initTabs();

  // 저장된 탭 상태 불러오기 (없으면 분류 탭을 기본으로 사용)
  const savedTab = localStorage.getItem("ocr_ui_active_tab") || "classification";
  setTab(savedTab);

  // 분류 페이지 초기화
  initClassification().catch((e) => console.error("분류 페이지 초기화 실패:", e));

  // 시스템 로그는 작업 목록 로딩 실패와 무관하게 즉시 시작한다.
  startSystemLogsEvents();
  refreshSystemLogs().catch(() => {});

  // 초기 로딩 시 바로 작업 목록 로드 (모든 탭에서 작업 목록이 보이도록)
  await refreshJobs();
  startJobsEvents();
  
  // 저장된 상태 복원
  setTimeout(async () => {
    try {
      // 1. DB 관리 화면 상태 복원
      const savedDbDocKey = localStorage.getItem("ocr_ui_selected_db_doc_key");
      if (savedDbDocKey) {
        const { selectDbDoc } = await import("./api.js");
        await selectDbDoc(savedDbDocKey);
      }
      
      // 2. 분류 탭 상태 복원
      const savedClassificationJobId = localStorage.getItem("ocr_ui_classification_job_id");
      const savedClassificationPageIndex = localStorage.getItem("ocr_ui_classification_page_index");
      
      if (savedClassificationJobId) {
        const { selectJob: selectClassificationJob } = await import("./classification.js");
        await selectClassificationJob(savedClassificationJobId);
        
        // 저장된 페이지 인덱스가 있으면 해당 페이지 로드
        if (savedClassificationPageIndex) {
          const pageIndex = parseInt(savedClassificationPageIndex, 10);
          if (!isNaN(pageIndex) && pageIndex >= 0) {
            const { loadPage } = await import("./classification.js");
            loadPage(pageIndex);
          }
        }
      }
      
      // 3. OCR 탭 상태 복원
      const savedJobId = localStorage.getItem("ocr_ui_selected_job_id");
      const savedFileId = localStorage.getItem("ocr_ui_selected_file_id");
      
      if (savedJobId) {
        // 저장된 작업 ID로 작업 선택
        const { selectJob } = await import("./api.js");
        await selectJob(savedJobId);
        
        // 저장된 파일 ID가 있으면 파일도 선택
        if (savedFileId) {
          const { selectFile } = await import("./api.js");
          await selectFile(savedFileId);
        }
      }
    } catch (e) {
      console.error("저장된 상태 복원 실패:", e);
    }
  }, 200);
  
  // ==================== VLM 디자인 패턴 관련 코드 주석 처리 ====================
  // // 4. VLM 매니저 초기화
  // setTimeout(async () => {
  //   try {
  //     console.log("VLM Manager 초기화 시작...");
  //     const vlmModule = await import("./vlm.js");
  //     if (vlmModule && vlmModule.VLMManager) {
  //       window.vlmManager = new vlmModule.VLMManager();
  //       console.log("VLM Manager 초기화 완료:", window.vlmManager);
  //     } else {
  //       console.warn("VLM Manager 클래스를 찾을 수 없습니다.");
  //     }
  //   } catch (e) {
  //     console.error("VLM Manager 초기화 실패:", e);
  //   }
  // }, 500);
  // ============================================================
}

// async function init() {
//   bindUi();
//   try {
//     requireApiBase();
//   } catch (e) {
//     return;
//   }
//   await refreshJobs();
//   if (state.jobsPollTimer) clearInterval(state.jobsPollTimer);
//   state.jobsPollTimer = setInterval(() => refreshJobs().catch(() => {}), 1500);
// }

init().catch((e) => alert(e.message));
