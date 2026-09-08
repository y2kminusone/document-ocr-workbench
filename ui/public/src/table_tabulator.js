import { $ } from "./dom.js";
import { state } from "./state.js";
import { escapeHtml } from "./ui_utils.js";

const BLANK_TEXT_MARKERS = new Set(["-", "--", "n/a"]);

export function hasMeaningfulValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value !== "string") return true;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return !BLANK_TEXT_MARKERS.has(trimmed.toLowerCase());
}

export function computeColumnsFromRows(rows, preferred = []) {
  const base =
    Array.isArray(preferred) && preferred.length
      ? preferred
      : rows && rows.length
        ? Object.keys(rows[0] || {})
        : [];
  const cols = [...base];
  const seen = new Set(cols);
  for (const r of rows || []) {
    const obj = r || {};
    for (const k of Object.keys(obj)) {
      if (!seen.has(k)) {
        seen.add(k);
        cols.push(k);
      }
    }
  }
  return cols;
}

// Tabulator 인스턴스 관리
const tabulatorInstances = {
  ocr: null,
  db: null
};

// 선택 상태 관리
const selectionState = {
  ocr: { row: null, col: null, selectedRows: new Set() },
  db: { row: null, col: null, selectedRows: new Set() }
};

// 다중 선택 모드 상태
const multiSelectState = {
  ocr: { lastSelectedRow: null, isShiftSelecting: false },
  db: { lastSelectedRow: null, isShiftSelecting: false }
};

// 선택 상태 초기화 함수
function initializeSelectionState(kind) {
  if (!selectionState[kind]) {
    selectionState[kind] = {
      row: null,
      col: null,
      selectedRows: new Set()
    };
  }
  if (!selectionState[kind].selectedRows) {
    selectionState[kind].selectedRows = new Set();
  }
  if (!multiSelectState[kind]) {
    multiSelectState[kind] = {
      lastSelectedRow: null,
      isShiftSelecting: false
    };
  }
}

// 초기화 실행
initializeSelectionState('ocr');
initializeSelectionState('db');

const lastFocusedCellPosition = {
  ocr: null,
  db: null
};

// Undo 스택 관리
const undoStacks = {
  ocr: [],
  db: []
};

const rowClipboard = {
  ocr: null,
  db: null
};

const headerClipboard = {
  ocr: null,
  db: null
};

const lastMoveRowAction = {
  ocr: { dir: 0, at: 0 },
  db: { dir: 0, at: 0 }
};

const lastKeyboardNavAction = {
  ocr: { key: "", at: 0 },
  db: { key: "", at: 0 }
};

let activeHeaderRenameSession = null;

const UNDO_STACK_LIMIT = 10;
const KEYBOARD_NAV_DEDUPE_MS = 35;
const DEFAULT_CHEM_COLUMNS = ["C", "Si", "Mn", "P", "S", "Ni", "Cr", "Mo"];
const MATERIAL_COLUMNS = ["DWG No", "Discription", "CMTR No", "Heat No"];
const TEST_REPORT_COLUMNS = ["Heat No", ...DEFAULT_CHEM_COLUMNS];
const DATA_COLUMN_DEFAULT_MIN_WIDTH = 96;
const DATA_COLUMN_COMPACT_MIN_WIDTH = 24;
const DRAG_HANDLE_COLUMN_WIDTH = 40;
const ROW_NUMBER_COLUMN_WIDTH = 30;
const TABLE_WIDTH_BUFFER = 8;

function getDataColumns(kind) {
  return (state.tableEdit[kind]?.columns || [])
    .map((col) => String(col || "").trim())
    .filter((col) => col && !["row_number", "drag_handle"].includes(col));
}

function projectRowsToColumns(rows, columns = [], options = {}) {
  const { keepAllWhenNoColumns = true } = options;
  const cleanColumns = (columns || [])
    .map((col) => String(col || "").trim())
    .filter((col) => col && !["row_number", "drag_handle"].includes(col));

  return (rows || []).map((row) => {
    // ✅ 안전한 데이터 정규화
    let normalizedRow;
    
    if (!row) {
      normalizedRow = {};
    } else if (typeof row === 'object' && !Array.isArray(row)) {
      normalizedRow = row;
    } else {
      // 문자열, 배열, 기타 타입 → 빈 객체로 변환
      console.warn('[projectRowsToColumns] 유효하지 않은 행 데이터를 정규화:', 
                   `type=${typeof row}, value=`, row);
      normalizedRow = {};
    }
    
    const { row_number, drag_handle, ...rest } = normalizedRow;
    if (!cleanColumns.length) return keepAllWhenNoColumns ? rest : {};

    const projected = {};
    for (const col of cleanColumns) {
      // ✅ Tabulator가 .을 중첩 속성으로 인식하지 않도록 처리
      // Tabulator는 컬럼명에 .이 있으면 중첩 속성으로 처리하므로
      // 원본 컬럼명을 그대로 사용하고, Tabulator 설정에서 fieldFormatter를 사용해야 함
      projected[col] = rest[col] ?? "";
    }
    return projected;
  });
}

export async function commitActiveHeaderRename(kind = null) {
  const session = activeHeaderRenameSession;
  if (!session) return null;
  if (kind && session.kind !== kind) return null;
  return session.finish(true, "save");
}

function getAdaptiveDataColumnMinWidth(kind, columnCount) {
  if (!columnCount) return DATA_COLUMN_DEFAULT_MIN_WIDTH;

  const tableId = kind === "ocr" ? "resultTable" : "dbTableDataTable";
  const tableEl = $(tableId);
  const wrapEl = tableEl?.closest?.(".tableWrap") || tableEl?.parentElement;
  const tableWidth = Math.floor(wrapEl?.clientWidth || tableEl?.clientWidth || 0);
  if (!tableWidth) return DATA_COLUMN_DEFAULT_MIN_WIDTH;

  const fixedWidth = DRAG_HANDLE_COLUMN_WIDTH + ROW_NUMBER_COLUMN_WIDTH + TABLE_WIDTH_BUFFER;
  const availableWidth = Math.max(DATA_COLUMN_COMPACT_MIN_WIDTH, tableWidth - fixedWidth);
  const fitWidth = Math.floor(availableWidth / columnCount);

  return Math.max(
    DATA_COLUMN_COMPACT_MIN_WIDTH,
    Math.min(DATA_COLUMN_DEFAULT_MIN_WIDTH, fitWidth)
  );
}

function setOcrBulkColumnSelected(col, selected) {
  if (!col) return;

  if (selected) state.ocrBulkDelete.selectedColumnIds.add(col);
  else state.ocrBulkDelete.selectedColumnIds.delete(col);

  const tabulator = tabulatorInstances.ocr;
  const checkbox = tabulator
    ?.getColumn?.(col)
    ?.getElement?.()
    ?.querySelector?.(".col-delete-checkbox");
  if (checkbox) checkbox.checked = !!selected;

  syncOcrBulkDeleteUi();
}

function toggleOcrBulkColumnSelected(col) {
  setOcrBulkColumnSelected(col, !state.ocrBulkDelete.selectedColumnIds.has(col));
}

function setOcrRowBulkSelected(rowIndex, selected) {
  const key = String(rowIndex);
  if (!Number.isFinite(Number(rowIndex))) return;

  if (selected) state.ocrRowBulkDelete.selectedRowIds.add(key);
  else state.ocrRowBulkDelete.selectedRowIds.delete(key);

  const row = tabulatorInstances.ocr?.getRows?.()[Number(rowIndex)];
  row?.getElement?.()?.classList.toggle("row-delete-selected", !!selected);

  const checkbox = row
    ?.getCell?.("row_number")
    ?.getElement?.()
    ?.querySelector?.(".row-delete-checkbox");
  if (checkbox) checkbox.checked = !!selected;

  syncOcrRowBulkDeleteUi();
}

function toggleOcrRowBulkSelected(rowIndex) {
  const key = String(rowIndex);
  setOcrRowBulkSelected(rowIndex, !state.ocrRowBulkDelete.selectedRowIds.has(key));
}

function syncEditedTableState(kind, reason = "table_edit", save = false) {
  const table = getTabulatorData(kind);
  const currentColumns = getDataColumns(kind);
  const columns = currentColumns.length ? currentColumns : computeColumnsFromRows(table, []);

  state.tableEdit[kind].columns = columns;
  if (kind === "ocr" && state.currentResult) {
    state.currentResult.table = table;
    state.currentResult.columns = columns;
  } else if (kind === "db") {
    state.db.docRows = table;
  }

  updateRowCountHint(kind, table.length);
  if (save) requestOcrAutoSave(reason);
  return { table, columns };
}

function requestOcrAutoSave(reason) {
  if (typeof window === "undefined" || !state.selectedFileId || !state.currentResult) return;
  setTimeout(() => {
    const runSave = window.saveEdits
      ? Promise.resolve(window.saveEdits({ silent: true, reason }))
      : import("./table_edit_fix.js").then((mod) => mod.saveEdits({ silent: true, reason }));

    runSave.catch((err) => {
      console.warn(`[Tabulator] auto save failed (${reason}):`, err);
    });
  }, 0);
}

function focusTabulatorCell(kind, rowIndex, colName) {
  const tabulator = tabulatorInstances[kind];
  if (!tabulator || rowIndex === null || rowIndex === undefined || !colName) return false;

  const row = tabulator.getRows()[Number(rowIndex)];
  const cell = row?.getCell?.(colName);
  const el = cell?.getElement?.();
  if (!el) return false;

  if (selectionState[kind].row !== Number(rowIndex) || selectionState[kind].col !== colName) {
    setSelection(kind, rowIndex, colName);
  }
  rememberFocusedCellPosition(kind, rowIndex, colName, row);
  el.tabIndex = -1;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}

function rememberFocusedCellPosition(kind, rowIndex, colName, rowComponent = null) {
  const normalizedRow = Number(rowIndex);
  if (!Number.isFinite(normalizedRow) || normalizedRow < 0 || !colName) return;
  lastFocusedCellPosition[kind] = {
    row: normalizedRow,
    col: colName,
    rowComponent,
    rowElement: rowComponent?.getElement?.() || null
  };
}

function getTabulatorDataColumnComponents(kind) {
  const tabulator = tabulatorInstances[kind];
  if (!tabulator) return [];

  return tabulator.getColumns().filter((column) => {
    const field = column.getField?.();
    return field && !["row_number", "drag_handle"].includes(field);
  });
}

function focusTabulatorHeader(kind, colName) {
  const tabulator = tabulatorInstances[kind];
  const headerEl = tabulator?.getColumn?.(colName)?.getElement?.();
  if (!headerEl) return false;

  headerEl.tabIndex = -1;
  headerEl.focus({ preventScroll: true });
  headerEl.scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}

function getHeaderColumnName(kind, target) {
  const headerEl = target?.closest?.(".tabulator-col");
  if (!headerEl) return null;

  const directField = headerEl.getAttribute("tabulator-field");
  if (directField && !["row_number", "drag_handle"].includes(directField)) {
    return directField;
  }

  for (const column of getTabulatorDataColumnComponents(kind)) {
    const columnEl = column.getElement?.();
    if (columnEl && (columnEl === headerEl || columnEl.contains(headerEl) || headerEl.contains(columnEl))) {
      return column.getField?.();
    }
  }
  return null;
}

/**
 * # 헤더의 header-selected 클래스 제거
 * @param {string} kind - 테이블 종류
 */
function clearHeaderSelected(kind) {
  const tabulator = tabulatorInstances[kind];
  if (!tabulator) return;
  
  const rowNumberColumn = tabulator.getColumn("row_number");
  if (rowNumberColumn) {
    const headerEl = rowNumberColumn.getElement();
    if (headerEl) {
      headerEl.classList.remove("header-selected");
      // 강제로 스타일 제거
      headerEl.style.removeProperty("background");
      headerEl.style.removeProperty("box-shadow");
    }
  }
}

function getCellPositionFromTarget(kind, target) {
  const cellEl = target?.closest?.(".tabulator-cell");
  if (!cellEl) return null;

  const field = cellEl.getAttribute("tabulator-field");
  if (!field || ["row_number", "drag_handle"].includes(field)) return null;

  const rowEl = cellEl.closest(".tabulator-row");
  const tabulator = tabulatorInstances[kind];
  const rowComponent = tabulator?.getRows?.().find((row) => row.getElement?.() === rowEl) || null;
  const rowIndex = rowComponent ? tabulator.getRows().indexOf(rowComponent) : -1;
  if (rowIndex < 0) return null;

  return {
    row: rowIndex,
    col: field,
    rowComponent,
    rowElement: rowEl
  };
}

function getRowIndexFromPosition(rows, position) {
  if (!rows?.length || !position) return -1;

  if (position.rowComponent) {
    const componentIndex = rows.indexOf(position.rowComponent);
    if (componentIndex >= 0) return componentIndex;
  }

  if (position.rowElement) {
    const elementIndex = rows.findIndex((row) => row.getElement?.() === position.rowElement);
    if (elementIndex >= 0) return elementIndex;
  }

  const numericIndex = Number(position.row);
  return Number.isFinite(numericIndex) ? numericIndex : -1;
}

function getFocusedCellPosition(kind) {
  const active = document.activeElement;
  return getCellPositionFromTarget(kind, active);
}

function shouldMoveFromEditor(active, key) {
  if (!active || !["INPUT", "TEXTAREA"].includes(active.tagName)) return true;
  if (!active.closest?.(".tabulator-cell")) return false;
  if (active.tagName === "TEXTAREA" && (key === "ArrowUp" || key === "ArrowDown")) return false;
  if (key === "ArrowLeft" || key === "ArrowRight") {
    let start = 0;
    let end = 0;
    let valueLength = 0;
    try {
      start = Number(active.selectionStart ?? 0);
      end = Number(active.selectionEnd ?? start);
      valueLength = String(active.value ?? "").length;
    } catch (_) {
      return false;
    }

    if (start !== end) return false;
    if (key === "ArrowLeft") return start <= 0;
    return end >= valueLength;
  }

  return ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key);
}

function commitActiveCellEditor(active) {
  if (!active || !["INPUT", "TEXTAREA"].includes(active.tagName)) return false;
  if (!active.closest?.(".tabulator-cell")) return false;
  active.blur();
  return true;
}

function isTextEditingElement(element) {
  if (!element) return false;
  return ["INPUT", "TEXTAREA"].includes(element.tagName) || element.isContentEditable;
}

function focusTabulatorCellAfterEdit(kind, rowIndex, colName, wasEditing) {
  const run = () => focusTabulatorCell(kind, rowIndex, colName);
  if (wasEditing) {
    setTimeout(run, 0);
  } else {
    run();
  }
}

function redrawTabulatorLayout(tabulator) {
  if (!tabulator?.redraw) return;
  tabulator.redraw(true);
  if (typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => {
    tabulator.redraw(true);
  });
}

function isDuplicateKeyboardNav(kind, key) {
  const now = typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
  const last = lastKeyboardNavAction[kind];
  if (last?.key === key && now - last.at < KEYBOARD_NAV_DEDUPE_MS) return true;
  lastKeyboardNavAction[kind] = { key, at: now };
  return false;
}

function promptRenameColumn(kind, oldName) {
  if (!oldName || ["row_number", "drag_handle"].includes(oldName)) return;
  if (kind === "ocr" && state.ocrBulkDelete?.isMode) return;

  const tabulator = tabulatorInstances[kind];
  const headerEl = tabulator?.getColumn?.(oldName)?.getElement?.();
  const titleEl = headerEl?.querySelector?.(".tabulator-col-title") || headerEl;
  if (!headerEl || !titleEl) return;

  const existingInput = headerEl.__ocrHeaderRenameInput;
  if (existingInput) {
    existingInput.focus();
    existingInput.select();
    return;
  }

  const input = document.createElement("input");
  input.type = "text";
  input.className = "tabulator-header-rename-input";
  input.value = oldName;
  input.setAttribute("aria-label", "열 이름 수정");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");

  let done = false;
  let session = null;

  const restoreHeader = () => {
    if (activeHeaderRenameSession === session) {
      activeHeaderRenameSession = null;
    }
    delete headerEl.__ocrHeaderRenameInput;
    titleEl.textContent = oldName;
    focusTabulatorHeader(kind, oldName);
    return oldName;
  };

  const showDuplicateNameState = () => {
    input.classList.add("is-invalid");
    input.setAttribute("aria-invalid", "true");
    input.title = "이미 존재하는 열 이름입니다.";
  };

  const clearDuplicateNameState = () => {
    input.classList.remove("is-invalid");
    input.removeAttribute("aria-invalid");
    input.removeAttribute("title");
  };

  const finish = async (commit, source = "manual") => {
    if (done) return null;

    if (!commit) {
      done = true;
      return restoreHeader();
    }

    const newName = String(input.value || "").trim();
    if (!newName || newName === oldName) {
      done = true;
      return restoreHeader();
    }

    const columns = getDataColumns(kind);
    if (columns.includes(newName)) {
      showDuplicateNameState();
      if (source === "blur" || source === "save") {
        done = true;
        return restoreHeader();
      }
      return null;
    }
    if (columns.includes(newName)) {
      alert("이미 존재하는 열 이름입니다.");
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
      return null;
    }

    clearDuplicateNameState();
    done = true;
    input.disabled = true;
    await renameColumn(kind, oldName, newName);
    if (activeHeaderRenameSession === session) {
      activeHeaderRenameSession = null;
    }
    delete headerEl.__ocrHeaderRenameInput;
    focusTabulatorHeader(kind, newName);
    return newName;
  };

  const finishAndMove = async (dir) => {
    const finalName = await finish(true, "nav");
    if (!finalName) return;

    const columns = getDataColumns(kind);
    const index = columns.indexOf(finalName);
    const nextName = columns[index + dir];
    if (!nextName) return;

    setSelection(kind, -1, nextName);
    focusTabulatorHeader(kind, nextName);
    promptRenameColumn(kind, nextName);
  };

  const finishAndMoveVertical = async (dir) => {
    const finalName = await finish(true, "nav");
    if (!finalName) return;

    const rows = tabulator?.getRows?.() || [];
    if (dir > 0 && rows.length) {
      setSelection(kind, 0, finalName);
      focusTabulatorCell(kind, 0, finalName);
      return;
    }

    setSelection(kind, -1, finalName);
    focusTabulatorHeader(kind, finalName);
  };

  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("dblclick", (e) => e.stopPropagation());
  input.addEventListener("input", clearDuplicateNameState);
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      void finish(true, "enter");
    } else if (e.key === "Escape") {
      e.preventDefault();
      void finish(false);
    } else if (e.key === "Tab") {
      e.preventDefault();
      void finishAndMove(e.shiftKey ? -1 : 1);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      void finishAndMoveVertical(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const start = Number(input.selectionStart ?? 0);
      const end = Number(input.selectionEnd ?? 0);
      const valueLength = String(input.value ?? "").length;
      const hasSelection = start !== end;
      const shouldMoveLeft = e.key === "ArrowLeft" && !hasSelection && start === 0;
      const shouldMoveRight = e.key === "ArrowRight" && !hasSelection && end === valueLength;
      if (shouldMoveLeft || shouldMoveRight) {
        e.preventDefault();
        void finishAndMove(shouldMoveLeft ? -1 : 1);
      }
    }
  });
  input.addEventListener("blur", () => {
    void finish(true, "blur");
  });

  headerEl.__ocrHeaderRenameInput = input;
  session = { kind, input, finish };
  activeHeaderRenameSession = session;
  titleEl.textContent = "";
  titleEl.append(input);

  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function bindTabulatorHeaderRename(kind) {
  const tabulator = tabulatorInstances[kind];
  if (!tabulator) return;

  for (const column of getTabulatorDataColumnComponents(kind)) {
    const field = column.getField?.();
    const headerEl = column.getElement?.();
    if (!field || !headerEl || headerEl.__ocrHeaderRenameBound) continue;

    headerEl.__ocrHeaderRenameBound = true;
    headerEl.title = "더블클릭하여 열 이름 수정";
    headerEl.addEventListener("dblclick", (e) => {
      if (e.target?.closest?.(".tabulator-col-resize-handle")) return;
      if (state.ocrBulkDelete?.isMode && kind === "ocr") return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      setSelection(kind, -1, field);
      focusTabulatorHeader(kind, field);
      promptRenameColumn(kind, field);
    }, true);
  }
}

function bindTabulatorKeyboardNav(kind, tableEl) {
  if (!tableEl || tableEl.__ocrTabulatorKeyboardNavBound) return;
  tableEl.__ocrTabulatorKeyboardNavBound = true;
  tableEl.tabIndex = 0;

  // 테이블 밖 클릭 시 선택 해제 (blur 이벤트 사용)
  tableEl.addEventListener("blur", (e) => {
    // 포커스가 테이블 내부로 이동한 것이면 무시
    if (e.relatedTarget && tableEl.contains(e.relatedTarget)) {
      return;
    }
    // 포커스가 버튼으로 이동한 경우 선택 상태 유지 (열 이동 버튼 등)
    if (e.relatedTarget && (e.relatedTarget.tagName === "BUTTON" || e.relatedTarget.closest("button"))) {
      return;
    }
    // 테이블 밖으로 포커스가 이동했으면 선택 해제
    setSelection(kind, null, null);
    
    // # 헤더의 header-selected 클래스 제거
    clearHeaderSelected(kind);
  }, true);

  tableEl.addEventListener("click", (e) => {
    if (e.target?.closest?.(".tabulator-col-resize-handle")) return;
    if (e.target?.closest?.("input, textarea, button, label")) return;

    const headerCol = getHeaderColumnName(kind, e.target);
    if (headerCol) {
      // # 헤더의 header-selected 클래스 제거
      clearHeaderSelected(kind);
      
      setSelection(kind, -1, headerCol);
      focusTabulatorHeader(kind, headerCol);
      if (e.detail >= 2) {
        e.preventDefault();
        e.stopPropagation();
        tableEl.__ocrSuppressNextHeaderDblClick = true;
        promptRenameColumn(kind, headerCol);
      }
    }
  }, true);

  tableEl.addEventListener("dblclick", (e) => {
    if (e.target?.closest?.(".tabulator-col-resize-handle")) return;
    if (e.target?.closest?.("input, textarea, button")) return;

    const headerCol = getHeaderColumnName(kind, e.target);
    if (!headerCol) return;
    if (tableEl.__ocrSuppressNextHeaderDblClick) {
      tableEl.__ocrSuppressNextHeaderDblClick = false;
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    setSelection(kind, -1, headerCol);
    focusTabulatorHeader(kind, headerCol);
    promptRenameColumn(kind, headerCol);
  }, true);

  tableEl.addEventListener("keydown", (e) => {
    console.log(`[Tabulator Keydown Handler] kind=${kind}, key=${e.key}, keyCode=${e.keyCode}, ctrlKey=${e.ctrlKey}, shiftKey=${e.shiftKey}, altKey=${e.altKey}, metaKey=${e.metaKey}`);
    console.log(`[Tabulator Keydown Handler] activeElement=${document.activeElement?.tagName}, activeElement.className=${document.activeElement?.className}`);
    console.log(`[Tabulator Keydown Handler] selectionState=${JSON.stringify(selectionState[kind])}`);
    
    const isCopyShortcut = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && String(e.key).toLowerCase() === "c";
    const isPasteShortcut = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && String(e.key).toLowerCase() === "v";
    console.log(`[Tabulator Keydown Handler] isCopyShortcut=${isCopyShortcut}, isPasteShortcut=${isPasteShortcut}`);
    
    if (isCopyShortcut || isPasteShortcut) {
      console.log(`[Tabulator Keydown Handler] Copy/Paste shortcut detected`);
      if (isTextEditingElement(document.activeElement)) {
        console.log(`[Tabulator Keydown Handler] Text editing element active, skipping copy/paste`);
        return;
      }
      
      // 헤더 복사/붙여넣기 체크 (row < 0이면 헤더 선택 상태)
      const isHeaderSelected = selectionState[kind].row === null || selectionState[kind].row < 0;
      
      if (isHeaderSelected) {
        console.log(`[Tabulator Keydown Handler] Header selected, executing header copy/paste`);
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();
        if (isCopyShortcut) {
          console.log(`[Tabulator Keydown Handler] Executing copySelectedHeader`);
          copySelectedHeader(kind);
        } else {
          console.log(`[Tabulator Keydown Handler] Executing pasteCopiedHeader`);
          pasteCopiedHeader(kind).catch((err) => console.warn("헤더 붙여넣기 실패:", err));
        }
        return;
      }
      
      // 행 복사/붙여넣기
      if (selectionState[kind].row === null || selectionState[kind].row < 0) {
        console.log(`[Tabulator Keydown Handler] No row selected, skipping copy/paste`);
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      if (isCopyShortcut) {
        console.log(`[Tabulator Keydown Handler] Executing copySelectedRow`);
        copySelectedRow(kind);
      } else {
        console.log(`[Tabulator Keydown Handler] Executing pasteCopiedRow`);
        pasteCopiedRow(kind).catch((err) => console.warn("행 붙여넣기 실패:", err));
      }
      return;
    }

    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "F2", "Enter"].includes(e.key)) {
      console.log(`[Tabulator Keydown Handler] Key not handled: ${e.key}`);
      return;
    }
    if (e.isComposing) {
      console.log(`[Tabulator Keydown Handler] Composition in progress, skipping`);
      return;
    }
    if (e.__ocrTabulatorKeyboardHandled) {
      console.log(`[Tabulator Keydown Handler] Event already handled, skipping`);
      return;
    }

    const active = document.activeElement;
    console.log(`[Tabulator Keydown Handler] shouldMoveFromEditor=${shouldMoveFromEditor(active, e.key)}`);
    if (!shouldMoveFromEditor(active, e.key)) {
      console.log(`[Tabulator Keydown Handler] Cannot move from editor, skipping`);
      return;
    }

    const tabulator = tabulatorInstances[kind];
    if (!tabulator) {
      console.log(`[Tabulator Keydown Handler] No tabulator instance, skipping`);
      return;
    }

    const rows = tabulator.getRows();
    const cols = getDataColumns(kind);
    console.log(`[Tabulator Keydown Handler] rows.length=${rows.length}, cols.length=${cols.length}`);
    if (!rows.length || !cols.length) {
      console.log(`[Tabulator Keydown Handler] No rows or columns, skipping`);
      return;
    }
    if (isDuplicateKeyboardNav(kind, e.key)) {
      console.log(`[Tabulator Keydown Handler] Duplicate keyboard navigation detected, skipping`);
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      return;
    }
    e.__ocrTabulatorKeyboardHandled = true;

    const targetCell = getCellPositionFromTarget(kind, e.target) || getCellPositionFromTarget(kind, active);
    console.log(`[Tabulator Keydown Handler] targetCell=${targetCell ? `{row: ${targetCell.row}, col: ${targetCell.col}}` : 'null'}`);
    let { row, col } = selectionState[kind];
    if (targetCell) {
      row = targetCell.row;
      col = targetCell.col;
    }

    const headerCol = getHeaderColumnName(kind, e.target) || getHeaderColumnName(kind, active);
    console.log(`[Tabulator Keydown Handler] headerCol=${headerCol}, row=${row}, col=${col}`);
    
    if (headerCol || row < 0) {
      console.log(`[Tabulator Keydown Handler] Header navigation mode`);
      let colIndex = cols.indexOf(headerCol || col);
      if (colIndex < 0) colIndex = 0;
      console.log(`[Tabulator Keydown Handler] colIndex=${colIndex}`);

      if (e.key === "F2" || e.key === "Enter") {
        console.log(`[Tabulator Keydown Handler] F2/Enter on header - starting rename`);
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();
        const nextCol = cols[colIndex];
        setSelection(kind, -1, nextCol);
        focusTabulatorHeader(kind, nextCol);
        promptRenameColumn(kind, nextCol);
        return;
      }

      if (e.key === "ArrowDown") {
        console.log(`[Tabulator Keydown Handler] ArrowDown on header - moving to first row`);
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();
        const wasEditing = commitActiveCellEditor(active);
        setSelection(kind, 0, cols[colIndex]);
        focusTabulatorCellAfterEdit(kind, 0, cols[colIndex], wasEditing);
        return;
      }

      if (e.key === "ArrowLeft") colIndex = Math.max(0, colIndex - 1);
      if (e.key === "ArrowRight") colIndex = Math.min(cols.length - 1, colIndex + 1);
      console.log(`[Tabulator Keydown Handler] Header navigation - new colIndex=${colIndex}`);

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      setSelection(kind, -1, cols[colIndex]);
      focusTabulatorHeader(kind, cols[colIndex]);
      return;
    }

    console.log(`[Tabulator Keydown Handler] Cell navigation mode`);
    let nextRow = row === null || row === undefined || row < 0 ? 0 : Number(row);
    let colIndex = col ? cols.indexOf(col) : 0;
    if (colIndex < 0) colIndex = 0;
    console.log(`[Tabulator Keydown Handler] Initial: nextRow=${nextRow}, colIndex=${colIndex}`);

    if (e.key === "ArrowUp" && nextRow <= 0) {
      console.log(`[Tabulator Keydown Handler] ArrowUp at top - moving to header`);
      const nextCol = cols[colIndex];
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      commitActiveCellEditor(active);
      setSelection(kind, -1, nextCol);
      focusTabulatorHeader(kind, nextCol);
      promptRenameColumn(kind, nextCol);
      return;
    }

    if (e.key === "ArrowUp") {
      nextRow -= 1;
      console.log(`[Tabulator Keydown Handler] ArrowUp - nextRow=${nextRow}`);
    } else if (e.key === "ArrowDown") {
      nextRow = Math.min(rows.length - 1, nextRow + 1);
      console.log(`[Tabulator Keydown Handler] ArrowDown - nextRow=${nextRow}`);
    } else if (e.key === "ArrowLeft") {
      if (colIndex > 0) {
        colIndex -= 1;
        console.log(`[Tabulator Keydown Handler] ArrowLeft - colIndex=${colIndex}`);
      } else if (nextRow > 0) {
        nextRow -= 1;
        colIndex = cols.length - 1;
        console.log(`[Tabulator Keydown Handler] ArrowLeft - wrapped to previous row: nextRow=${nextRow}, colIndex=${colIndex}`);
      }
    } else if (e.key === "ArrowRight") {
      if (colIndex < cols.length - 1) {
        colIndex += 1;
        console.log(`[Tabulator Keydown Handler] ArrowRight - colIndex=${colIndex}`);
      } else if (nextRow < rows.length - 1) {
        nextRow += 1;
        colIndex = 0;
        console.log(`[Tabulator Keydown Handler] ArrowRight - wrapped to next row: nextRow=${nextRow}, colIndex=${colIndex}`);
      }
    }

    const nextCol = cols[colIndex];
    console.log(`[Tabulator Keydown Handler] Final: nextRow=${nextRow}, nextCol=${nextCol}`);
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
    const wasEditing = commitActiveCellEditor(active);
    setSelection(kind, nextRow, nextCol);
    focusTabulatorCellAfterEdit(kind, nextRow, nextCol, wasEditing);
  }, true);
}

/**
 * Tabulator 테이블 초기화
 * @param {string} kind - 테이블 종류 ("ocr" 또는 "db")
 * @param {Array} data - 테이블 데이터
 * @param {Array} columns - 열 정의
 * @param {Object} options - 추가 옵션
 * @returns {Object} Tabulator 인스턴스
 */
export function initTabulator(kind, data = [], columns = [], options = {}) {
  const tableId = kind === "ocr" ? "resultTable" : "dbTableDataTable";
  const tableEl = $(tableId);
  
  if (!tableEl) {
    console.error(`테이블 요소를 찾을 수 없습니다: ${tableId}`);
    return null;
  }

  if (document.activeElement && tableEl.contains(document.activeElement)) {
    document.activeElement.blur();
  }
  lastFocusedCellPosition[kind] = null;
  lastKeyboardNavAction[kind] = { key: "", at: 0 };

  // 기존 인스턴스가 있으면 파괴
  if (tabulatorInstances[kind]) {
    tabulatorInstances[kind].destroy();
    tabulatorInstances[kind] = null;
  }

  // 열 삭제 모드 상태 확인
  const bulkDeleteState = kind === "ocr" ? state.ocrBulkDelete : null;
  const rowBulkDeleteState = kind === "ocr" ? state.ocrRowBulkDelete : null;
  const isDeleteMode = bulkDeleteState?.isMode === true;
  const isRowDeleteMode = rowBulkDeleteState?.isMode === true;

  // 기본 옵션
  const defaultOptions = {
    data: data,
    columns: buildColumns(kind, columns, isDeleteMode, isRowDeleteMode),
    layout: "fitColumns",
    resizableColumns: true,
    resizableColumnFit: true,
    resizableRows: true,
    movableRows: true,
    movableColumns: true,
    keybindings: false,
    selectableRows: true,  // ✅ 다중 행 선택 활성화
    selectableRowsRange: true,  // ✅ 범위 선택 활성화
    selectableRowsClickArea: "row",  // ✅ 행 클릭 시 선택
    // ✅ Tabulator가 .을 중첩 속성으로 인식하지 않도록 설정
    nestedFieldSeparator: false,
    
    // 행 포맷터(행 번호 표시)
    rowFormatter: function(row) {
      const rowData = row.getData();
      const table = row.getTable();
      const rows = table.getRows();
      const index = rows.indexOf(row);
      
      // 행 번호 및 체크박스
      const rowNumberCell = row.getCell("row_number");
      if (rowNumberCell) {
        if (isRowDeleteMode) {
          const rowIdx = index;
          const isChecked = rowBulkDeleteState.selectedRowIds.has(String(rowIdx));
          row.getElement()?.classList.toggle("row-delete-selected", isChecked);
          rowNumberCell.getElement().innerHTML = `
            <label class="row-delete-check-wrap" aria-label="${rowIdx + 1}행 삭제 선택">
              <input type="checkbox" class="row-delete-checkbox" data-row="${rowIdx}" ${isChecked ? "checked" : ""} />
              <span class="row-delete-index">${rowIdx + 1}</span>
            </label>
          `;
        } else {
          row.getElement()?.classList.remove("row-delete-selected");
          rowNumberCell.getElement().innerHTML = `<span>${index + 1}</span>`;
        }
      }
    },
    
    // 셀 편집 이벤트
    cellEdited: function(cell) {
      console.log(`[Tabulator] 셀 편집됨(${kind}):`, cell.getField(), cell.getValue());
      
      // 상태 업데이트
      if (kind === "ocr" && state.currentResult) {
        state.currentResult.table = getTabulatorData(kind);
      } else if (kind === "db") {
        state.db.docRows = getTabulatorData(kind);
      }
      
      // 자동 저장 요청
      if (typeof window.saveEdits === 'function' && kind === "ocr") {
        window.saveEdits({ silent: true, reason: "cell_edit" }).catch(err => {
          console.warn("셀 편집 자동 저장 실패:", err);
        });
      }
    },
    
    // 행 이동 이벤트 (버튼으로 이동할 때)
    rowMoved: function(row) {
      console.log(`[Tabulator] 행 이동됨(${kind}):`, row.getData());
      
      const table = row.getTable();
      if (table) {
        const rows = table.getRows();
        const movedRowIndex = rows.indexOf(row);
        
        console.log(`[Tabulator] 이동된 행 인덱스: ${movedRowIndex}`);
        
        // ✅ 모든 행의 row_number를 현재 인덱스 + 1로 업데이트
        rows.forEach((rowComponent, index) => {
          const currentData = rowComponent.getData();
          const newRowNumber = index + 1;
          
          // row_number 업데이트
          rowComponent.update({ row_number: newRowNumber });
          
          console.log(`[Tabulator] 행 ${index}: row_number ${currentData.row_number} -> ${newRowNumber}`);
        });
        
        // ✅ 모든 행의 rowFormatter를 다시 실행하여 행 번호 표시 업데이트
        rows.forEach((rowComponent, index) => {
          rowComponent.reformat();
        });
        
        console.log(`[Tabulator] 행 번호 업데이트 완료 (${kind})`);
      }
      
      // 상태 업데이트
      if (kind === "ocr" && state.currentResult) {
        state.currentResult.table = getTabulatorData(kind);
      } else if (kind === "db") {
        state.db.docRows = getTabulatorData(kind);
      }
    },
    
    // ✅ 드래그 앤 드롭 완료 이벤트 (드래그 핸들로 이동할 때)
    movableRowsSendingStop: function(fromRow, toRow, toTable) {
      console.log(`[Tabulator] 드래그 앤 드롭 완료(${kind}):`, fromRow.getData(), "->", toRow?.getData());
      
      const table = fromRow.getTable();
      if (table) {
        console.log(`[Tabulator] 드래그 후 모든 행 번호 재할당 시작 (${kind})`);
        const rows = table.getRows();
        console.log(`[Tabulator] 총 ${rows.length}개 행 발견`);
        
        // ✅ 모든 행의 row_number를 현재 인덱스 + 1로 업데이트
        rows.forEach((rowComponent, index) => {
          const currentData = rowComponent.getData();
          const newRowNumber = index + 1;
          
          // row_number 업데이트
          rowComponent.update({ row_number: newRowNumber });
          
          console.log(`[Tabulator] 드래그 후 행 ${index}: row_number ${currentData.row_number} -> ${newRowNumber}`);
        });
        
        // ✅ 모든 행의 rowFormatter를 다시 실행하여 행 번호 표시 업데이트
        rows.forEach((rowComponent, index) => {
          rowComponent.reformat();
        });
        
        console.log(`[Tabulator] 드래그 후 행 번호 업데이트 완료 (${kind})`);
      }
      
      // 상태 업데이트
      if (kind === "ocr" && state.currentResult) {
        state.currentResult.table = getTabulatorData(kind);
      } else if (kind === "db") {
        state.db.docRows = getTabulatorData(kind);
      }
    },
    
    // 열 이동 이벤트
    columnMoved: function(column, columns) {
      console.log(`[Tabulator] 열 이동됨(${kind}):`, column.getField());
      
      // 열 순서 업데이트
      const newColumns = columns.map(col => col.getField()).filter(col => col !== "row_number" && col !== "drag_handle");
      if (kind === "ocr" && state.currentResult) {
        state.currentResult.columns = newColumns;
      }
      state.tableEdit[kind].columns = newColumns;
    },
    
    // 데이터 로드 완료 이벤트
    dataLoaded: function(data) {
      console.log(`[Tabulator] 데이터 로드 완료 (${kind}):`, data.length, "행");
      updateRowCountHint(kind, data.length);
    },
    
    // 행 클릭 이벤트
    rowClick: function(e, row) {
      console.log(`[rowClick] kind=${kind}, ctrlKey=${e.ctrlKey}, shiftKey=${e.shiftKey}, metaKey=${e.metaKey}`);
      
      if (e.__ocrCellSelectionHandled) return;

      const rowData = row.getData();
      const table = row.getTable();
      const rows = table.getRows();
      const index = rows.indexOf(row);

      if (kind === "ocr" && isRowDeleteMode) {
        if (!e.__ocrRowBulkHandled) toggleOcrRowBulkSelected(index);
        return;
      }

      lastFocusedCellPosition[kind] = null;
      
      // Ctrl+click: 다중 선택 모드
      // Shift+click: 범위 선택 모드
      const isMultiSelect = e.ctrlKey || e.metaKey;
      const isRangeSelect = e.shiftKey;
      
      console.log(`[rowClick] isMultiSelect=${isMultiSelect}, isRangeSelect=${isRangeSelect}, index=${index}`);
      
      // ✅ Tabulator 기본 선택 기능 사용 - 직접 구현 제거
      // Tabulator가 자동으로 Ctrl+Click과 Shift+Click을 처리함
      
      setSelection(kind, index, selectionState[kind].col, isMultiSelect, isRangeSelect);
      
      // # 헤더의 header-selected 클래스 제거 (즉시 실행 및 지연 실행)
      clearHeaderSelected(kind);
      setTimeout(() => clearHeaderSelected(kind), 0);
      
      // DB 테이블에서 선택된 ID 저장
      if (kind === "db" && rowData.id) {
        state.db.selectedRowId = rowData.id;
        const detailTitle = $("dbDetailTitle");
        if (detailTitle) {
          detailTitle.textContent = `${state.db.selectedDocKey || ""} 쨌 row_id=${state.db.selectedRowId}`.trim();
        }
      }
    },
    
    // 셀 클릭 이벤트
    cellClick: function(e, cell) {
      console.log(`[cellClick] kind=${kind}, ctrlKey=${e.ctrlKey}, shiftKey=${e.shiftKey}, metaKey=${e.metaKey}`);
      
      const field = cell.getField();
      if (field === "row_number" || field === "drag_handle") return;
      
      const row = cell.getRow();
      const table = row.getTable();
      const rows = table.getRows();
      const index = rows.indexOf(row);

      if (kind === "ocr" && isRowDeleteMode) {
        e.__ocrRowBulkHandled = true;
        e.preventDefault();
        e.stopPropagation();
        toggleOcrRowBulkSelected(index);
        return;
      }
      
      // # 헤더의 header-selected 클래스 제거 (즉시 실행 및 지연 실행)
      clearHeaderSelected(kind);
      setTimeout(() => clearHeaderSelected(kind), 0);
      
      // Ctrl+click: 다중 선택 모드
      // Shift+click: 범위 선택 모드
      const isMultiSelect = e.ctrlKey || e.metaKey;
      const isRangeSelect = e.shiftKey;
      
      console.log(`[cellClick] isMultiSelect=${isMultiSelect}, isRangeSelect=${isRangeSelect}, index=${index}, field=${field}`);
      
      // ✅ Tabulator 기본 선택 기능 사용 - 직접 구현 제거
      // Tabulator가 자동으로 Ctrl+Click과 Shift+Click을 처리함
      
      setSelection(kind, index, field, isMultiSelect, isRangeSelect);
      rememberFocusedCellPosition(kind, index, field, row);
      const el = cell.getElement();
      if (el) {
        el.tabIndex = -1;
        el.focus({ preventScroll: true });
      }
      
      // ✅ 이벤트 전파 방지를 마지막에 처리
      e.__ocrCellSelectionHandled = true;
    },
  };

  // 사용자 옵션 병합
  const mergedOptions = { ...defaultOptions, ...options };

  // Tabulator 생성
  try {
    const tabulator = new Tabulator(tableEl, mergedOptions);
    tabulatorInstances[kind] = tabulator;
    bindTabulatorKeyboardNav(kind, tableEl);
    bindTabulatorHeaderRename(kind);

    const initialCol = columns.includes(selectionState[kind].col)
      ? selectionState[kind].col
      : columns[0] || null;
    const previousRow = Number(selectionState[kind].row);
    const initialRow = data.length
      ? (Number.isFinite(previousRow) && previousRow >= 0 && previousRow < data.length ? previousRow : 0)
      : null;
    setSelection(kind, initialRow, initialCol);
    
    // 열 정의 저장
    state.tableEdit[kind].columns = columns;
    
    console.log(`[Tabulator] 테이블 초기화 완료 (${kind})`);
    return tabulator;
  } catch (error) {
    console.error(`[Tabulator] 테이블 초기화 실패 (${kind}):`, error);
    return null;
  }
}

/**
 * 열 정의 빌드
 * @param {string} kind - 테이블 종류
 * @param {Array} columns - 열 이름 배열
 * @param {boolean} isDeleteMode - 열 삭제 모드
 * @param {boolean} isRowDeleteMode - 행 삭제 모드
 * @returns {Array} Tabulator 열 정의
 */
function buildColumns(kind, columns, isDeleteMode, isRowDeleteMode) {
  const resultColumns = [];
  const dataColumnMinWidth = getAdaptiveDataColumnMinWidth(kind, columns.length);
  
  // 드래그 핸들 열
  resultColumns.push({
    title: "",
    field: "drag_handle",
    width: DRAG_HANDLE_COLUMN_WIDTH,
    frozen: true,
    headerSort: false,
    resizable: false,
    formatter: function() {
      return '<div class="drag-handle" data-drag-handle="true">⋮⋮</div>';
    },
    cellClick: function(e, cell) {
      e.stopPropagation();
    }
  });
  
  // 행 번호 열
  resultColumns.push({
    title: "#",
    field: "row_number",
    width: ROW_NUMBER_COLUMN_WIDTH,
    frozen: true,
    headerSort: false,
    resizable: false,
    headerClick: function(e, column) {
      e.stopPropagation();
      // # 헤더 클릭 시 헤더 선택 상태로 설정
      setSelection(kind, -1, null);
      const headerEl = column.getElement();
      if (headerEl) {
        headerEl.tabIndex = -1;
        headerEl.focus({ preventScroll: true });
        // 헤더 선택 시각적 효과 추가
        headerEl.classList.add("header-selected");
      }
    },
    cellClick: function(e, cell) {
      if (kind === "ocr" && isRowDeleteMode) {
        e.__ocrRowBulkHandled = true;
        e.stopPropagation();
        const row = cell.getRow();
        const index = row.getTable().getRows().indexOf(row);
        const checkbox = e.target?.closest?.(".row-delete-checkbox");
        if (checkbox) setOcrRowBulkSelected(index, checkbox.checked);
        else {
          e.preventDefault();
          toggleOcrRowBulkSelected(index);
        }
        return;
      }
      e.__ocrCellSelectionHandled = true;
      e.stopPropagation();
      const row = cell.getRow();
      const index = row.getTable().getRows().indexOf(row);
      const cols = getDataColumns(kind);
      setSelection(kind, index, selectionState[kind].col || cols[0] || null);
      const el = cell.getElement();
      if (el) {
        el.tabIndex = -1;
        el.focus({ preventScroll: true });
      }
    }
  });
  
  // 데이터 열
  for (const col of columns) {
    if (isDeleteMode) {
      // 열 삭제 모드: 체크박스 사용
      const bulkDeleteState = state.ocrBulkDelete;
      const isChecked = bulkDeleteState.selectedColumnIds.has(col);
      
      resultColumns.push({
        title: `
          <label class="col-delete-check-wrap" aria-label="${escapeHtml(col)} 열 삭제 선택">
            <input type="checkbox" class="col-delete-checkbox" data-col="${escapeHtml(col)}" ${isChecked ? "checked" : ""} />
            <span>${escapeHtml(col)}</span>
          </label>
        `,
        field: col,
        editor: !isDeleteMode ? "input" : false,
        minWidth: dataColumnMinWidth,
        widthGrow: 1,
        widthShrink: 1,
        headerSort: false,
        headerClick: function(e, column) {
          e.stopPropagation();

          const checkbox = e.target?.closest?.(".col-delete-checkbox");
          if (checkbox) {
            setOcrBulkColumnSelected(col, checkbox.checked);
            return;
          }

          e.preventDefault();
          const selected = !state.ocrBulkDelete.selectedColumnIds.has(col);
          setOcrBulkColumnSelected(col, selected);
          const headerCheckbox = column?.getElement?.()?.querySelector?.(".col-delete-checkbox");
          if (headerCheckbox) headerCheckbox.checked = selected;
        },
        cellClick: function(e, cell) {
          if (isDeleteMode) {
            e.preventDefault();
            e.stopPropagation();
            toggleOcrBulkColumnSelected(col);
          }
        }
      });
    } else {
      // 일반 모드
      resultColumns.push({
        title: col,
        field: col,
        editor: "input",
        headerTooltip: "더블클릭하여 열 이름 수정",
        minWidth: dataColumnMinWidth,
        widthGrow: 1,
        widthShrink: 1,
        resizable: true,
        headerSort: false,
        headerClick: function(e) {
          e.stopPropagation();
          // 열 헤더 클릭 시 행 선택 상태를 유지하면서 열 선택
          setSelection(kind, selectionState[kind].row ?? -1, col);
          focusTabulatorHeader(kind, col);
        },
        headerDblClick: function(e) {
          e.preventDefault();
          e.stopPropagation();
          setSelection(kind, -1, col);
          focusTabulatorHeader(kind, col);
          promptRenameColumn(kind, col);
        },
        cellClick: function(e, cell) {
          // # 헤더의 header-selected 클래스 제거
          clearHeaderSelected(kind);
        }
      });
    }
  }
  
  return resultColumns;
}

/**
 * Tabulator 데이터 업데이트
 * @param {string} kind - 테이블 종류 ("ocr" 또는 "db")
 * @param {Array} data - 새 데이터
 */
export function updateTabulatorData(kind, data) {
  const tabulator = tabulatorInstances[kind];
  if (!tabulator) {
    console.warn(`[Tabulator] 인스턴스가 없습니다 (${kind})`);
    return;
  }
  
  try {
    tabulator.setData(data);
    console.log(`[Tabulator] 데이터 업데이트 완료 (${kind}):`, data.length, "행");
    updateRowCountHint(kind, data.length);
  } catch (error) {
    console.error(`[Tabulator] 데이터 업데이트 실패 (${kind}):`, error);
  }
}

/**
 * Tabulator에서 데이터 가져오기
 * @param {string} kind - 테이블 종류 ("ocr" 또는 "db")
 * @returns {Array} 테이블 데이터
 */
export function getTabulatorData(kind) {
  const tabulator = tabulatorInstances[kind];
  if (!tabulator) {
    console.warn(`[Tabulator] 인스턴스가 없습니다 (${kind})`);
    return [];
  }
  
  try {
    const hasColumnState = Array.isArray(state.tableEdit[kind]?.columns);
    return projectRowsToColumns(tabulator.getData(), getDataColumns(kind), {
      keepAllWhenNoColumns: !hasColumnState
    });
  } catch (error) {
    console.error(`[Tabulator] 데이터 가져오기 실패 (${kind}):`, error);
    return [];
  }
}

/**
 * Tabulator 열 업데이트
 * @param {string} kind - 테이블 종류 ("ocr" 또는 "db")
 * @param {Array} columns - 새 열 정의
 */
export function updateTabulatorColumns(kind, columns) {
  const tabulator = tabulatorInstances[kind];
  if (!tabulator) {
    console.warn(`[Tabulator] 인스턴스가 없습니다 (${kind})`);
    return;
  }
  
  try {
    const bulkDeleteState = kind === "ocr" ? state.ocrBulkDelete : null;
    const rowBulkDeleteState = kind === "ocr" ? state.ocrRowBulkDelete : null;
    const isDeleteMode = bulkDeleteState?.isMode === true;
    const isRowDeleteMode = rowBulkDeleteState?.isMode === true;
    
    const newColumns = buildColumns(kind, columns, isDeleteMode, isRowDeleteMode);
    tabulator.setColumns(newColumns);
    redrawTabulatorLayout(tabulator);
    bindTabulatorHeaderRename(kind);
    
    state.tableEdit[kind].columns = columns;
    console.log(`[Tabulator] 열 업데이트 완료 (${kind}):`, columns.length, "개");
  } catch (error) {
    console.error(`[Tabulator] 열 업데이트 실패 (${kind}):`, error);
  }
}

/**
 * Tabulator 인스턴스 가져오기
 * @param {string} kind - 테이블 종류 ("ocr" 또는 "db")
 * @returns {Object|null} Tabulator 인스턴스
 */
export function getTabulatorInstance(kind) {
  return tabulatorInstances[kind] || null;
}

/**
 * Tabulator 열 추가 (안정화 버전 - setColumns 사용)
 * @param {string} kind - 테이블 종류 ("ocr" 또는 "db")
 * @param {string} columnName - 열 이름
 * @param {number} position - 추가할 위치 (기본: 맨 뒤)
 */
export function addTabulatorColumn(kind, columnName, position = -1) {
  let tabulator = tabulatorInstances[kind];
  
  // ✅ 인스턴스가 없으면 새로 생성
  if (!tabulator) {
    console.log(`[Tabulator] 인스턴스가 없어서 새로 생성 (${kind})`);
    
    // 빈 데이터와 새 열로 초기화
    const emptyRow = { [columnName]: "" };
    const columns = [columnName];
    
    // 상태 업데이트
    state.tableEdit[kind].columns = columns;
    if (kind === "ocr" && state.currentResult) {
      state.currentResult.table = [emptyRow];
      state.currentResult.columns = columns;
    } else if (kind === "db") {
      state.db.docRows = [emptyRow];
    }
    
    // Tabulator 인스턴스 생성
    initTabulator(kind, [emptyRow], columns);
    updateRowCountHint(kind, 1);
    setSelection(kind, 0, columnName);
    
    console.log(`[Tabulator] 인스턴스 생성 및 열 추가 완료 (${kind}):`, columnName);
    return;
  }

  try {
    const columns = [...(state.tableEdit[kind].columns || [])];
    if (columns.includes(columnName)) {
      alert("이미 존재하는 열 이름입니다.");
      return;
    }

    const insertAt = position === -1
      ? columns.length
      : Math.max(0, Math.min(Number(position) || 0, columns.length));
    
    // ✅ 상태 업데이트 (올바른 위치에 열 추가)
    columns.splice(insertAt, 0, columnName);
    state.tableEdit[kind].columns = columns;

    // ✅ 안정화: 기존 데이터에 새 열 추가
    const currentData = getTabulatorData(kind);
    const newData = currentData.map(row => ({
      ...row,
      [columnName]: ""
    }));
    
    // ✅ 테이블이 비어있으면 빈 행 추가
    if (newData.length === 0) {
      const emptyRow = {};
      for (const col of columns) {
        emptyRow[col] = "";
      }
      newData.push(emptyRow);
    }
    
    // ✅ 안정화: replaceTabulatorColumnsAndData 사용 (동기식, 순서 보장)
    replaceTabulatorColumnsAndData(kind, newData, columns, "add_column", kind === "ocr");
    
    // ✅ 선택 상태 업데이트
    setSelection(kind, selectionState[kind].row ?? 0, columnName);
    
    console.log(`[Tabulator] 열 추가 완료 (${kind}):`, columnName, `위치: ${insertAt}`);
  } catch (error) {
    console.error(`[Tabulator] 열 추가 실패 (${kind}):`, error);
  }
}

/*
// ============================================================================
// 이전 버전의 addTabulatorColumn 함수 (주석 처리됨)
// ============================================================================
export function addTabulatorColumn(kind, columnName, position = -1) {
  let tabulator = tabulatorInstances[kind];
  
  // ✅ 인스턴스가 없으면 새로 생성
  if (!tabulator) {
    console.log(`[Tabulator] 인스턴스가 없어서 새로 생성 (${kind})`);
    
    // 빈 데이터와 새 열로 초기화
    const emptyRow = { [columnName]: "" };
    const columns = [columnName];
    
    // 상태 업데이트
    state.tableEdit[kind].columns = columns;
    if (kind === "ocr" && state.currentResult) {
      state.currentResult.table = [emptyRow];
      state.currentResult.columns = columns;
    } else if (kind === "db") {
      state.db.docRows = [emptyRow];
    }
    
    // Tabulator 인스턴스 생성
    initTabulator(kind, [emptyRow], columns);
    updateRowCountHint(kind, 1);
    setSelection(kind, 0, columnName);
    
    console.log(`[Tabulator] 인스턴스 생성 및 열 추가 완료 (${kind}):`, columnName);
    return;
  }

  try {
    const columns = [...(state.tableEdit[kind].columns || [])];
    if (columns.includes(columnName)) {
      alert("이미 존재하는 열 이름입니다.");
      return;
    }

    const insertAt = position === -1
      ? columns.length
      : Math.max(0, Math.min(Number(position) || 0, columns.length));
    columns.splice(insertAt, 0, columnName);
    state.tableEdit[kind].columns = columns;

    let data = getTabulatorData(kind).map((row) => ({ ...row, [columnName]: row[columnName] ?? "" }));
    
    // ✅ 테이블이 비어있으면 빈 행을 하나 추가해서 테이블이 보이도록 함
    if (!data.length) {
      const emptyRow = {};
      for (const col of columns) {
        emptyRow[col] = "";
      }
      data = [emptyRow];
    }
    
    // ✅ replaceTabulatorColumnsAndData 사용하여 데이터와 열을 동시에 업데이트
    replaceTabulatorColumnsAndData(kind, data, columns, "add_column", kind === "ocr");
    
    console.log(`[Tabulator] 열 추가 완료 (${kind}):`, columnName);
  } catch (error) {
    console.error(`[Tabulator] 열 추가 실패 (${kind}):`, error);
  }
}
// ============================================================================
*/

async function replaceTabulatorColumnsAndData(kind, rows, columns, reason, save = false) {
  const tabulator = tabulatorInstances[kind];
  if (!tabulator) return { rows: [], columns: [] };

  const cleanColumns = (columns || [])
    .map((col) => String(col || "").trim())
    .filter((col) => col && !["row_number", "drag_handle"].includes(col));
  const cleanRows = projectRowsToColumns(rows || [], cleanColumns, { keepAllWhenNoColumns: false });

  const bulkDeleteState = kind === "ocr" ? state.ocrBulkDelete : null;
  const rowBulkDeleteState = kind === "ocr" ? state.ocrRowBulkDelete : null;
  const isDeleteMode = bulkDeleteState?.isMode === true;
  const isRowDeleteMode = rowBulkDeleteState?.isMode === true;

  state.tableEdit[kind].columns = cleanColumns;
  
  // ✅ 즉시 UI 업데이트를 위해 순차적 실행 및 강제 리렌더링
  await Promise.resolve(tabulator.setColumns(buildColumns(kind, cleanColumns, isDeleteMode, isRowDeleteMode)));
  await Promise.resolve(tabulator.setData(cleanRows));
  
  // ✅ 즉시 레이아웃 다시 그리기 (requestAnimationFrame 제거)
  redrawTabulatorLayout(tabulator);
  bindTabulatorHeaderRename(kind);
  
  // ✅ 추가적인 리렌더링 보장
  tabulator.redraw(true);
  
  updateRowCountHint(kind, cleanRows.length);
  syncEditedTableState(kind, reason, save);

  return { rows: cleanRows, columns: cleanColumns };
}

function addTabulatorColumnLegacy(kind, columnName, position = -1) {
  const tabulator = tabulatorInstances[kind];
  if (!tabulator) {
    console.warn(`[Tabulator] 인스턴스가 없습니다 (${kind})`);
    return;
  }
  
  try {
    const columns = [...(state.tableEdit[kind].columns || [])];
    if (columns.includes(columnName)) {
      alert("이미 존재하는 열 이름입니다.");
      return;
    }
    
    const insertAt = position === -1
      ? columns.length
      : Math.max(0, Math.min(Number(position) || 0, columns.length));
    columns.splice(insertAt, 0, columnName);
    if (false) {
      // row_number와 drag_handle를 제외하고 위치 계산
      tabulator.addColumn(columnDef, false, position + 2);
    }
    
    // 열 목록 업데이트
    const legacyColumns = state.tableEdit[kind].columns || [];
    if (position === -1) {
      columns.push(columnName);
    } else {
      columns.splice(position, 0, columnName);
    }
    state.tableEdit[kind].columns = columns;
    updateTabulatorData(kind, getTabulatorData(kind).map((row) => ({ ...row, [columnName]: row[columnName] ?? "" })));
    syncEditedTableState(kind, "add_column", kind === "ocr");
    
    console.log(`[Tabulator] 열 추가 완료 (${kind}):`, columnName);
  } catch (error) {
    console.error(`[Tabulator] 열 추가 실패 (${kind}):`, error);
  }
}

/**
 * Tabulator 열 삭제
 * @param {string} kind - 테이블 종류 ("ocr" 또는 "db")
 * @param {string} columnName - 삭제할 열 이름
 */
export async function deleteTabulatorColumn(kind, columnName) {
  const tabulator = tabulatorInstances[kind];
  if (!tabulator) {
    console.warn(`[Tabulator] 인스턴스가 없습니다 (${kind})`);
    return;
  }
  
  try {
    const column = tabulator.getColumn(columnName);
    if (column) {
      const columns = (state.tableEdit[kind].columns || []).filter((col) => col !== columnName);
      const data = tabulator.getRows().map((rowComponent) => rowComponent.getData()).map((row) => {
        const nextRow = { ...row };
        delete nextRow[columnName];
        delete nextRow.row_number;
        delete nextRow.drag_handle;
        return nextRow;
      });

      await replaceTabulatorColumnsAndData(kind, data, columns, "delete_column", kind === "ocr");
      
      console.log(`[Tabulator] 열 삭제 완료 (${kind}):`, columnName);
    } else {
      console.warn(`[Tabulator] 열을 찾을 수 없습니다 (${kind}):`, columnName);
    }
  } catch (error) {
    console.error(`[Tabulator] 열 삭제 실패 (${kind}):`, error);
  }
}

/**
 * Tabulator 행 추가 (호환성을 위한 별칭)
 * @param {string} kind - 테이블 종류 ("ocr" 또는 "db")
 */
export function addTabulatorRow(kind) {
  addRow(kind);
}

/**
 * 다중 행 선택 초기화
 * @param {string} kind - 테이블 종류
 */
function clearMultiRowSelection(kind) {
  selectionState[kind].selectedRows.clear();
  multiSelectState[kind].lastSelectedRow = null;
  
  const tabulator = tabulatorInstances[kind];
  if (tabulator) {
    const rows = tabulator.getRows();
    rows.forEach(row => {
      row.getElement()?.classList.remove("tabulator-selected-multi");
    });
  }
}


/**
 * Tabulator 여러 행 삭제 (호환성을 위한 별칭)
 * @param {string} kind - 테이블 종류
 * @param {Array} rowIndexes - 삭제할 행 인덱스 배열
 * @returns {Object} 삭제 결과
 */
export function deleteTabulatorRows(kind, rowIndexes = []) {
  return deleteRows(kind, rowIndexes);
}

/**
 * Tabulator 테이블 파괴
 * @param {string} kind - 테이블 종류 ("ocr" 또는 "db")
 */
export function destroyTabulator(kind) {
  const tabulator = tabulatorInstances[kind];
  if (!tabulator) return;
  
  try {
    tabulator.destroy();
    tabulatorInstances[kind] = null;
    console.log(`[Tabulator] 테이블 파괴 완료 (${kind})`);
  } catch (error) {
    console.error(`[Tabulator] 테이블 파괴 실패 (${kind}):`, error);
  }
}

/**
 * Tabulator 테이블 초기화 여부 확인
 * @param {string} kind - 테이블 종류 ("ocr" 또는 "db")
 * @returns {boolean} 초기화 여부
 */
export function isTabulatorInitialized(kind) {
  return tabulatorInstances[kind] !== null;
}

/**
 * 다중 행 선택 처리 (Ctrl+click)
 * @param {string} kind - 테이블 종류
 * @param {number} rowIndex - 행 인덱스
 */
function handleMultiRowSelection(kind, rowIndex) {
  const rowKey = String(rowIndex);
  
  if (selectionState[kind].selectedRows.has(rowKey)) {
    // 이미 선택된 행이면 선택 해제
    selectionState[kind].selectedRows.delete(rowKey);
  } else {
    // 선택되지 않은 행이면 선택 추가
    selectionState[kind].selectedRows.add(rowKey);
  }
  
  // 마지막 선택된 행 업데이트
  multiSelectState[kind].lastSelectedRow = rowIndex;
  
  // 선택 상태 업데이트
  selectionState[kind].row = rowIndex;
  
  // 시각적 업데이트
  applyMultiRowSelectionHighlight(kind);
  updateSelHint(kind);
}

/**
 * 범위 행 선택 처리 (Shift+click)
 * @param {string} kind - 테이블 종류
 * @param {number} rowIndex - 행 인덱스
 */
function handleRangeRowSelection(kind, rowIndex) {
  const tabulator = tabulatorInstances[kind];
  if (!tabulator) return;
  
  const rows = tabulator.getRows();
  if (!rows.length) return;
  
  const lastSelected = multiSelectState[kind].lastSelectedRow;
  
  if (lastSelected === null) {
    // 마지막 선택된 행이 없으면 현재 행만 선택
    selectionState[kind].selectedRows.clear();
    selectionState[kind].selectedRows.add(String(rowIndex));
    multiSelectState[kind].lastSelectedRow = rowIndex;
  } else {
    // 마지막 선택된 행부터 현재 행까지 범위 선택
    const startRow = Math.min(lastSelected, rowIndex);
    const endRow = Math.max(lastSelected, rowIndex);
    
    selectionState[kind].selectedRows.clear();
    for (let i = startRow; i <= endRow; i++) {
      if (i >= 0 && i < rows.length) {
        selectionState[kind].selectedRows.add(String(i));
      }
    }
  }
  
  // 선택 상태 업데이트
  selectionState[kind].row = rowIndex;
  
  // 시각적 업데이트
  applyMultiRowSelectionHighlight(kind);
  updateSelHint(kind);
}

/**
 * 다중 행 선택 하이라이트 적용
 * @param {string} kind - 테이블 종류
 */
function applyMultiRowSelectionHighlight(kind) {
  const tabulator = tabulatorInstances[kind];
  if (!tabulator) return;
  
  const rows = tabulator.getRows();
  
  // 모든 행의 선택 상태 초기화
  rows.forEach(row => {
    row.getElement()?.classList.remove("tabulator-selected-multi");
  });
  
  // 선택된 행 하이라이트
  selectionState[kind].selectedRows.forEach(rowKey => {
    const rowIndex = Number(rowKey);
    if (rowIndex >= 0 && rowIndex < rows.length) {
      rows[rowIndex].getElement()?.classList.add("tabulator-selected-multi");
    }
  });
}

/**
 * 선택 상태 설정
 * @param {string} kind - 테이블 종류
 * @param {number|null} row - 행 인덱스
 * @param {string|null} col - 열 이름
 * @param {boolean} isMultiSelect - 다중 선택 모드 여부
 * @param {boolean} isRangeSelect - 범위 선택 모드 여부
 */
export function setSelection(kind, row, col, isMultiSelect = false, isRangeSelect = false) {
  const normalizedRow = row === null || row === undefined || row === ""
    ? null
    : Number(row);
  
  // 다중 선택 모드 처리
  if (isMultiSelect && normalizedRow !== null && normalizedRow >= 0) {
    handleMultiRowSelection(kind, normalizedRow);
    if (state.tableEdit?.[kind]) {
      state.tableEdit[kind].selectedRow = selectionState[kind].row;
      state.tableEdit[kind].selectedCol = col || null;
    }
    return;
  }
  
  // 범위 선택 모드 처리
  if (isRangeSelect && normalizedRow !== null && normalizedRow >= 0) {
    handleRangeRowSelection(kind, normalizedRow);
    if (state.tableEdit?.[kind]) {
      state.tableEdit[kind].selectedRow = selectionState[kind].row;
      state.tableEdit[kind].selectedCol = col || null;
    }
    return;
  }
  
  // 일반 선택 모드 (다중 선택 초기화)
  if (!isMultiSelect && !isRangeSelect) {
    clearMultiRowSelection(kind);
  }
  
  // 선택 상태 업데이트 (selectedRows는 유지)
  selectionState[kind].row = Number.isFinite(normalizedRow) ? normalizedRow : null;
  selectionState[kind].col = col || null;
  
  if (state.tableEdit?.[kind]) {
    state.tableEdit[kind].selectedRow = selectionState[kind].row;
    state.tableEdit[kind].selectedCol = selectionState[kind].col;
  }
  
  if (selectionState[kind].row === null || selectionState[kind].row < 0 || !selectionState[kind].col) {
    lastFocusedCellPosition[kind] = null;
  }
  
  applySelectionHighlight(kind);
  updateSelHint(kind);
}


/**
 * 선택 하이라이트 적용
 * @param {string} kind - 테이블 종류
 */
export function applySelectionHighlight(kind) {
  const tabulator = tabulatorInstances[kind];
  if (!tabulator) return;
  
  // ✅ 테이블이 초기화되었는지 확인
  if (!tabulator.initialized) {
    console.log(`[applySelectionHighlight] 테이블이 아직 초기화되지 않음 (${kind})`);
    return;
  }
  
  const { row, col } = selectionState[kind];
  
  // 기존 선택 해제
  try {
    tabulator.deselectRow();
  } catch (e) {
    console.warn(`[applySelectionHighlight] deselectRow 실패 (${kind}):`, e);
  }
  
  // 행 선택
  if (row !== null && row !== undefined && row >= 0) {
    const rows = tabulator.getRows();
    if (rows[row]) {
      rows[row].select();
    }
  }
}

/**
 * 선택 힌트 업데이트
 * @param {string} kind - 테이블 종류
 */
export function updateSelHint(kind) {
  const el = kind === "ocr" ? $("ocrSelHint") : $("dbSelHint");
  if (!el) return;
  
  const { row, col } = selectionState[kind];
  const hasRow = row !== null && row !== undefined && row >= 0;
  if (!hasRow && !col) {
    el.textContent = "";
  } else {
    el.textContent = `선택: ${hasRow ? `행${Number(row) + 1}` : ""}${
      hasRow && col ? " · " : ""
    }${col ? `열${col}` : ""}`;
  }
}

/**
 * 행 개수 힌트 업데이트
 * @param {string} kind - 테이블 종류
 * @param {number} rowCount - 행 개수
 */
function updateRowCountHint(kind, rowCount) {
  const count = Number.isFinite(rowCount) ? rowCount : 0;
  if (kind === "ocr") {
    const hint = $("ocrRowCountHint");
    if (hint) hint.textContent = `총${count}행`;
  } else {
    const hint = $("dbRowCountHint");
    if (hint) hint.textContent = `총${count}행`;
  }
}

/**
 * OCR 열 대량 삭제 UI 동기화
 */
function syncOcrBulkDeleteUi() {
  const bulk = state.ocrBulkDelete;
  const startBtn = $("ocrBulkDeleteStart");
  const actions = $("ocrBulkDeleteActions");
  const countHint = $("ocrBulkDeleteCount");
  const confirmBtn = $("ocrBulkDeleteConfirm");
  const selectAllBtn = $("ocrBulkDeleteSelectAll");

  const selectedCount = bulk.selectedColumnIds.size;
  const columns = state.tableEdit.ocr.columns || [];
  const allSelected = columns.length > 0 && selectedCount === columns.length;

  if (startBtn) {
    startBtn.classList.toggle("hidden", bulk.isMode);
    startBtn.disabled = bulk.isDeleting;
  }
  if (actions) actions.classList.toggle("hidden", !bulk.isMode);
  if (countHint) countHint.textContent = `선택 ${selectedCount}개`;
  if (confirmBtn) confirmBtn.disabled = selectedCount === 0 || bulk.isDeleting;
  if (selectAllBtn) {
    selectAllBtn.textContent = allSelected ? "모두 해제" : "모두 선택";
    selectAllBtn.disabled = columns.length === 0 || bulk.isDeleting;
  }
}

/**
 * OCR 행 대량 삭제 UI 동기화
 */
function syncOcrRowBulkDeleteUi() {
  const bulk = state.ocrRowBulkDelete;
  const startBtn = $("ocrRowBulkDeleteStart");
  const actions = $("ocrRowBulkDeleteActions");
  const countHint = $("ocrRowBulkDeleteCount");
  const confirmBtn = $("ocrRowBulkDeleteConfirm");
  const selectAllBtn = $("ocrRowBulkDeleteSelectAll");

  const selectedCount = bulk.selectedRowIds.size;
  const totalRows = getTabulatorData("ocr").length;
  const allSelected = totalRows > 0 && selectedCount === totalRows;

  if (startBtn) {
    startBtn.classList.toggle("hidden", bulk.isMode);
    startBtn.disabled = bulk.isDeleting;
  }
  if (actions) actions.classList.toggle("hidden", !bulk.isMode);
  if (countHint) countHint.textContent = `선택 ${selectedCount}개`;
  if (confirmBtn) confirmBtn.disabled = selectedCount === 0 || bulk.isDeleting;
  if (selectAllBtn) {
    selectAllBtn.textContent = allSelected ? "모두 해제" : "모두 선택";
    selectAllBtn.disabled = totalRows === 0 || bulk.isDeleting;
  }
}

/**
 * OCR 열 대량 삭제 모드 진입
 */
export function enterOcrBulkDeleteMode() {
  if (state.ocrRowBulkDelete.isMode) exitOcrRowBulkDeleteMode();
  state.ocrBulkDelete.isMode = true;
  state.ocrBulkDelete.selectedColumnIds = new Set();
  
  const tabulator = tabulatorInstances.ocr;
  if (tabulator) {
    const columns = state.tableEdit.ocr.columns || [];
    updateTabulatorColumns("ocr", columns);
  }
  
  syncOcrBulkDeleteUi();
}

/**
 * OCR 열 대량 삭제 모드 종료
 */
export function exitOcrBulkDeleteMode() {
  state.ocrBulkDelete.isMode = false;
  state.ocrBulkDelete.isDeleting = false;
  state.ocrBulkDelete.selectedColumnIds = new Set();
  
  const modal = $("ocrBulkDeleteModal");
  if (modal) modal.setAttribute("aria-hidden", "true");
  
  const tabulator = tabulatorInstances.ocr;
  if (tabulator) {
    const columns = state.tableEdit.ocr.columns || [];
    updateTabulatorColumns("ocr", columns);
  }
  
  syncOcrBulkDeleteUi();
}

/**
 * OCR 행 대량 삭제 모드 진입
 */
export function enterOcrRowBulkDeleteMode() {
  if (state.ocrBulkDelete.isMode) exitOcrBulkDeleteMode();
  state.ocrRowBulkDelete.isMode = true;
  state.ocrRowBulkDelete.selectedRowIds = new Set();
  
  const tabulator = tabulatorInstances.ocr;
  if (tabulator) {
    const columns = state.tableEdit.ocr.columns || [];
    updateTabulatorColumns("ocr", columns);
    tabulator.redraw();
  }
  
  syncOcrRowBulkDeleteUi();
}

/**
 * OCR 행 대량 삭제 모드 종료
 */
export function exitOcrRowBulkDeleteMode() {
  state.ocrRowBulkDelete.isMode = false;
  state.ocrRowBulkDelete.isDeleting = false;
  state.ocrRowBulkDelete.selectedRowIds = new Set();
  
  const modal = $("ocrRowBulkDeleteModal");
  if (modal) modal.setAttribute("aria-hidden", "true");
  
  const tabulator = tabulatorInstances.ocr;
  if (tabulator) {
    const columns = state.tableEdit.ocr.columns || [];
    updateTabulatorColumns("ocr", columns);
    tabulator.redraw();
  }
  
  syncOcrRowBulkDeleteUi();
}

/**
 * 행 추가
 * @param {string} kind - 테이블 종류
 */
export function addRow(kind) {
  const ed = state.tableEdit[kind];
  const cols = ed.columns || [];
  
  if (!cols.length) {
    alert("열을 먼저 추가해주세요.");
    return;
  }
  
  const rows = getTabulatorData(kind);
  const insertIndex = selectionState[kind].row !== null ? selectionState[kind].row + 1 : rows.length;
  const newRow = {};
  for (const col of cols) newRow[col] = "";
  rows.splice(Math.max(0, Math.min(insertIndex, rows.length)), 0, newRow);
  
  // ✅ 즉시 UI 업데이트를 위해 Tabulator 인스턴스 직접 사용
  const tabulator = tabulatorInstances[kind];
  if (tabulator) {
    tabulator.setData(rows);
    // ✅ 즉시 레이아웃 다시 그리기
    tabulator.redraw(true);
  }
  
  syncEditedTableState(kind, "add_row", kind === "ocr");
  
  // 선택 상태 업데이트
  setSelection(kind, insertIndex, selectionState[kind].col || cols[0]);
}

/**
 * 행 이동
 * @param {string} kind - 테이블 종류
 * @param {number} dir - 이동 방향 (-1: 위, 1: 아래)
 */
export async function moveRow(kind, dir) {
  const now = typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
  const lastMove = lastMoveRowAction[kind];
  if (lastMove?.dir === dir && now - lastMove.at < 120) return;
  lastMoveRowAction[kind] = { dir, at: now };

  const tabulator = tabulatorInstances[kind];
  if (!tabulator) return;

  const rows = tabulator.getRows();
  const focusedCell = getFocusedCellPosition(kind);
  const effectiveSelection = focusedCell || lastFocusedCellPosition[kind] || selectionState[kind];
  const row = getRowIndexFromPosition(rows, effectiveSelection);
  if (row === null || row === undefined || Number(row) < 0) {
    alert("이동할 행을 먼저 선택해주세요.");
    return;
  }
  
  const i = Number(row);
  const j = i + dir;
  
  if (i < 0 || j < 0 || j >= rows.length) return;
  
  const data = projectRowsToColumns(rows.map((rowComponent) => rowComponent.getData()), getDataColumns(kind), {
    keepAllWhenNoColumns: false
  });
  const [rowData] = data.splice(i, 1);
  data.splice(j, 0, rowData);
  await Promise.resolve(tabulator.setData(data));
  updateRowCountHint(kind, data.length);
  syncEditedTableState(kind, "move_row", kind === "ocr");
  
  setSelection(kind, j, effectiveSelection.col || selectionState[kind].col);
  if (effectiveSelection.col) {
    setTimeout(() => {
      focusTabulatorCell(kind, j, effectiveSelection.col);
    }, 0);
  }
}

/**
 * 행 삭제
 * @param {string} kind - 테이블 종류
 */
export function deleteRow(kind) {
  const { row, col } = selectionState[kind];
  const tabulator = tabulatorInstances[kind];
  if (!tabulator) return;
  
  const rows = tabulator.getRows();
  if (!rows.length) return;
  
  const idx = row !== null && row !== undefined ? Number(row) : rows.length - 1;
  if (idx < 0 || idx >= rows.length) return;
  
  const data = getTabulatorData(kind);
  const removedRow = data[idx];
  
  // Undo 스택에 저장
  pushUndo(kind, { type: "row", index: idx, row: removedRow, selectedCol: col });
  
  data.splice(idx, 1);
  updateTabulatorData(kind, data);
  syncEditedTableState(kind, "delete_row", kind === "ocr");
  
  // 상태 업데이트
  if (kind === "ocr" && state.currentResult) {
    state.currentResult.table = getTabulatorData(kind);
  } else if (kind === "db") {
    state.db.docRows = getTabulatorData(kind);
  }
  
  const newRowCount = data.length;
  setSelection(kind, newRowCount ? Math.min(idx, newRowCount - 1) : null, col);
}

/**
 * 여러 행 삭제
 * @param {string} kind - 테이블 종류
 * @param {Array} rowIndexes - 삭제할 행 인덱스 배열
 * @returns {Object} 삭제 결과
 */
export function deleteRows(kind, rowIndexes = []) {
  const uniqIndexes = [...new Set((rowIndexes || []).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x >= 0))]
    .sort((a, b) => a - b);
  
  if (!uniqIndexes.length) return { deletedCount: 0, skipped: [] };

  const tabulator = tabulatorInstances[kind];
  if (!tabulator) return { deletedCount: 0, skipped: [] };

  const dataBefore = getTabulatorData(kind);
  const rowsBefore = tabulator.getRows();
  if (!rowsBefore.length) return { deletedCount: 0, skipped: uniqIndexes };

  const validIndexes = uniqIndexes.filter((idx) => idx < dataBefore.length);
  if (!validIndexes.length) return { deletedCount: 0, skipped: uniqIndexes };

  const removedRows = validIndexes.map((idx) => ({ index: idx, row: dataBefore[idx] }));
  
  // Undo 스택에 저장
  pushUndo(kind, {
    type: "rows",
    removedRows,
    selectedCol: selectionState[kind].col,
  });

  // 역순으로 삭제하여 인덱스 변화 방지
  for (let i = validIndexes.length - 1; i >= 0; i--) {
    dataBefore.splice(validIndexes[i], 1);
  }
  updateTabulatorData(kind, dataBefore);
  syncEditedTableState(kind, "delete_rows", kind === "ocr");

  // 상태 업데이트
  if (kind === "ocr" && state.currentResult) {
    state.currentResult.table = getTabulatorData(kind);
  } else if (kind === "db") {
    state.db.docRows = getTabulatorData(kind);
  }

  setSelection(kind, dataBefore.length ? Math.min(validIndexes[0], dataBefore.length - 1) : null, selectionState[kind].col);

  return {
    deletedCount: validIndexes.length,
    skipped: uniqIndexes.filter((idx) => !validIndexes.includes(idx)),
  };
}

/**
 * 열 추가 또는 삽입
 * @param {string} kind - 테이블 종류
 * @param {string} mode - "end" 또는 "insert"
 */
export function addOrInsertColumn(kind, mode) {
  const nameEl = kind === "ocr" ? $("ocrNewColName") : $("dbNewColName");
  const posEl = kind === "ocr" ? $("ocrInsertPos") : $("dbInsertPos");
  const raw = (nameEl?.value || "").trim();
  
  if (!raw) {
    alert("열 이름을 입력해주세요.");
    return;
  }
  
  const ed = state.tableEdit[kind];
  let cols = [...(ed.columns || [])];
  
  if (cols.includes(raw)) {
    alert("이미 존재하는 열 이름입니다.");
    return;
  }

  let insertAt = cols.length;
  if (mode === "insert" && posEl) {
    const v = Number(posEl.value);
    if (v === -1) insertAt = 0;
    else if (v >= 0 && v <= cols.length) insertAt = v + 1;
    else insertAt = cols.length;
  }
  
  addTabulatorColumn(kind, raw, insertAt);
  
  if (nameEl) nameEl.value = "";
  setSelection(kind, selectionState[kind].row, raw);
}

/**
 * 임시 열 추가
 * @param {string} kind - 테이블 종류
 */
export function addTempColumn(kind) {
  const ed = state.tableEdit[kind];
  let cols = [...(ed.columns || [])];
  
  // 기존 열 이름 중 col1, col2, col3... 패턴 찾아서 최대 번호 계산
  const colNumbers = cols
    .filter(c => c && c.startsWith('col'))
    .map(c => {
      const num = parseInt(c.substring(3), 10);
      return isNaN(num) ? 0 : num;
    });
  
  // 최대 번호 찾기 (없으면 0)
  const maxNum = colNumbers.length > 0 ? Math.max(...colNumbers) : 0;
  
  // 다음 번호로 열 이름 생성
  const name = `col${maxNum + 1}`;

  let insertAt = cols.length;
  if (selectionState[kind].col) {
    const idx = cols.indexOf(selectionState[kind].col);
    if (idx >= 0) {
      insertAt = idx + 1;
    }
  }
  
  addTabulatorColumn(kind, name, insertAt);
  setSelection(kind, selectionState[kind].row, name);
}

/**
 * 행 복사 (단일 및 다중 행 지원)
 * @param {string} kind - 테이블 종류
 */
export function copySelectedRow(kind) {
  const tabulator = tabulatorInstances[kind];
  if (!tabulator) return false;

  const columns = getDataColumns(kind);
  const rows = tabulator.getRows();
  
  // 다중 선택된 행이 있는지 확인
  if (selectionState[kind].selectedRows.size > 0) {
    // 다중 행 복사
    const selectedRowIndexes = Array.from(selectionState[kind].selectedRows)
      .map(key => Number(key))
      .filter(index => Number.isInteger(index) && index >= 0 && index < rows.length)
      .sort((a, b) => a - b);
    
    if (selectedRowIndexes.length === 0) {
      alert("복사할 행을 선택해주세요.");
      return false;
    }
    
    const selectedRowsData = selectedRowIndexes.map(index => 
      projectRowsToColumns([rows[index].getData()], columns, {
        keepAllWhenNoColumns: false
      })[0] || {}
    );
    
    rowClipboard[kind] = {
      rows: selectedRowsData,
      columns: [...columns],
      isMultiRow: true
    };
    
    console.log(`[Tabulator] 다중 행 복사 완료 (${kind}):`, selectedRowIndexes.length, "개 행");
    alert(`${selectedRowIndexes.length}개 행이 복사되었습니다.`);
    updateSelHint(kind);
    return true;
  }
  
  // 단일 행 복사 (기존 로직)
  const rowIndex = Number(selectionState[kind].row);
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= rows.length) {
    alert("복사할 행을 선택해주세요.");
    return false;
  }

  const rowData = projectRowsToColumns([rows[rowIndex].getData()], columns, {
    keepAllWhenNoColumns: false
  })[0] || {};
  rowClipboard[kind] = {
    row: { ...rowData },
    columns: [...columns],
    isMultiRow: false
  };
  updateSelHint(kind);
  return true;
}


export async function pasteCopiedRow(kind) {
  const clipboard = rowClipboard[kind];
  if (!clipboard) {
    alert("복사된 행이 없습니다.");
    return false;
  }

  const tabulator = tabulatorInstances[kind];
  if (!tabulator) return false;

  const columns = getDataColumns(kind);
  if (!columns.length) return false;

  const rows = projectRowsToColumns(tabulator.getRows().map((row) => row.getData()), columns, {
    keepAllWhenNoColumns: false
  });
  const selectedRow = Number(selectionState[kind].row);
  const insertAt = Number.isInteger(selectedRow) && selectedRow >= 0
    ? Math.min(selectedRow + 1, rows.length)
    : rows.length;
  
  // 다중 행 붙여넣기 처리
  if (clipboard.isMultiRow && clipboard.rows && clipboard.rows.length > 0) {
    console.log(`[Tabulator] 다중 행 붙여넣기 (${kind}):`, clipboard.rows.length, "개 행");
    
    const pastedRows = clipboard.rows.map(clipboardRow => {
      // 대소문자 무시하고 컬럼 매칭을 위한 맵 생성
      const clipboardRowLower = {};
      for (const [key, value] of Object.entries(clipboardRow || {})) {
        clipboardRowLower[key.toLowerCase()] = value;
      }
      
      const pastedRow = {};
      for (const col of columns) {
        // 대소문자 무시하고 매칭 시도
        const matchedValue = clipboardRowLower[col.toLowerCase()];
        pastedRow[col] = matchedValue ?? "";
      }
      return pastedRow;
    });
    
    // 다중 행을 한 번에 삽입
    rows.splice(insertAt, 0, ...pastedRows);
    await Promise.resolve(tabulator.setData(rows));
    updateRowCountHint(kind, rows.length);
    syncEditedTableState(kind, "paste_rows", kind === "ocr");
    
    const nextCol = selectionState[kind].col || columns[0];
    setSelection(kind, insertAt, nextCol);
    focusTabulatorCellAfterEdit(kind, insertAt, nextCol, true);
    
    console.log(`[Tabulator] 다중 행 붙여넣기 완료 (${kind}):`, pastedRows.length, "개 행");
    alert(`${pastedRows.length}개 행이 붙여넣기되었습니다.`);
    return true;
  }
  
  // 단일 행 붙여넣기 처리 (기존 로직)
  if (!clipboard.row) {
    alert("복사된 행이 없습니다.");
    return false;
  }
  
  // 대소문자 무시하고 컬럼 매칭을 위한 맵 생성
  const clipboardRowLower = {};
  for (const [key, value] of Object.entries(clipboard.row || {})) {
    clipboardRowLower[key.toLowerCase()] = value;
  }
  
  const pastedRow = {};
  for (const col of columns) {
    // 대소문자 무시하고 매칭 시도
    const matchedValue = clipboardRowLower[col.toLowerCase()];
    pastedRow[col] = matchedValue ?? "";
  }

  rows.splice(insertAt, 0, pastedRow);
  await Promise.resolve(tabulator.setData(rows));
  updateRowCountHint(kind, rows.length);
  syncEditedTableState(kind, "paste_row", kind === "ocr");
  const nextCol = selectionState[kind].col || columns[0];
  setSelection(kind, insertAt, nextCol);
  focusTabulatorCellAfterEdit(kind, insertAt, nextCol, true);
  return true;
}

/**
 * 헤더 복사
 * @param {string} kind - 테이블 종류
 * @returns {boolean} 성공 여부
 */
export function copySelectedHeader(kind) {
  const columns = getDataColumns(kind);
  if (!columns.length) {
    alert("복사할 헤더가 없습니다.");
    return false;
  }

  headerClipboard[kind] = {
    columns: [...columns]
  };
  
  console.log(`[Tabulator] 헤더 복사 완료 (${kind}):`, columns.length, "개");
  return true;
}

/**
 * 헤더 붙여넣기
 * @param {string} kind - 테이블 종류
 * @returns {boolean} 성공 여부
 */
export async function pasteCopiedHeader(kind) {
  const clipboard = headerClipboard[kind];
  if (!clipboard?.columns || !clipboard.columns.length) {
    alert("복사된 헤더가 없습니다.");
    return false;
  }

  const tabulator = tabulatorInstances[kind];
  if (!tabulator) return false;

  const currentColumns = getDataColumns(kind);
  const newColumns = [...clipboard.columns];
  
  // 대소문자 무시하고 중복 체크
  const currentColumnsLower = currentColumns.map(col => col.toLowerCase());
  
  // 중복되지 않은 컬럼만 추가
  const columnsToAdd = newColumns.filter(newCol => 
    !currentColumnsLower.includes(newCol.toLowerCase())
  );
  
  if (columnsToAdd.length === 0) {
    return false;
  }
  
  // 새 컬럼 추가
  const finalColumns = [...currentColumns, ...columnsToAdd];
  state.tableEdit[kind].columns = finalColumns;
  
  // 데이터 업데이트
  const data = tabulator.getData();
  const newData = data.map(row => {
    const newRow = { ...row };
    for (const col of columnsToAdd) {
      newRow[col] = "";
    }
    return newRow;
  });
  
  await Promise.resolve(tabulator.setData(newData));
  updateTabulatorColumns(kind, finalColumns);
  syncEditedTableState(kind, "paste_header", kind === "ocr");
  
  console.log(`[Tabulator] 헤더 붙여넣기 완료 (${kind}):`, columnsToAdd.length, "개 추가됨");
  return true;
}

export async function addDefaultChemColumns(kind) {
  const currentColumns = [...(state.tableEdit[kind]?.columns || [])];
  const missingColumns = DEFAULT_CHEM_COLUMNS.filter((col) => !currentColumns.includes(col));

  if (!missingColumns.length) {
    alert("기본 화학 열이 이미 모두 존재합니다.");
    return;
  }

  const tabulator = tabulatorInstances[kind];
  const sourceRows = tabulator
    ? getTabulatorData(kind)
    : kind === "ocr"
      ? state.currentResult?.table || []
      : state.db?.docRows || [];
  const rows = (sourceRows.length ? sourceRows : [{}]).map((row) => {
    const nextRow = { ...(row || {}) };
    for (const col of missingColumns) {
      if (!(col in nextRow)) nextRow[col] = "";
    }
    return nextRow;
  });
  const nextColumns = [...currentColumns, ...missingColumns];

  if (tabulator) {
    await replaceTabulatorColumnsAndData(kind, rows, nextColumns, "add_default_chem_columns", kind === "ocr");
  } else {
    state.tableEdit[kind].columns = nextColumns;
    if (kind === "ocr") {
      if (!state.currentResult) state.currentResult = { table: rows, columns: nextColumns };
      state.currentResult.table = rows;
      state.currentResult.columns = nextColumns;
      initTabulator("ocr", rows, nextColumns);
    } else {
      state.db.docRows = rows;
      initTabulator("db", rows, nextColumns);
    }
  }

  setSelection(kind, selectionState[kind].row ?? 0, missingColumns[0]);
}

/**
 * 자재일람표 열 추가 (DWG No, Description, CMTR No, Heat No)
 * @param {string} kind - 테이블 종류
 */
export async function addMaterialColumns(kind) {
  const currentColumns = [...(state.tableEdit[kind]?.columns || [])];
  const missingColumns = MATERIAL_COLUMNS.filter((col) => !currentColumns.includes(col));

  if (!missingColumns.length) {
    alert("자재일람표 열이 이미 모두 존재합니다.");
    return;
  }

  const tabulator = tabulatorInstances[kind];
  const sourceRows = tabulator
    ? getTabulatorData(kind)
    : kind === "ocr"
      ? state.currentResult?.table || []
      : state.db?.docRows || [];
  const rows = (sourceRows.length ? sourceRows : [{}]).map((row) => {
    const nextRow = { ...(row || {}) };
    for (const col of missingColumns) {
      if (!(col in nextRow)) nextRow[col] = "";
    }
    return nextRow;
  });
  const nextColumns = [...currentColumns, ...missingColumns];

  if (tabulator) {
    await replaceTabulatorColumnsAndData(kind, rows, nextColumns, "add_material_columns", kind === "ocr");
  } else {
    state.tableEdit[kind].columns = nextColumns;
    if (kind === "ocr") {
      if (!state.currentResult) state.currentResult = { table: rows, columns: nextColumns };
      state.currentResult.table = rows;
      state.currentResult.columns = nextColumns;
      initTabulator("ocr", rows, nextColumns);
    } else {
      state.db.docRows = rows;
      initTabulator("db", rows, nextColumns);
    }
  }

  setSelection(kind, selectionState[kind].row ?? 0, missingColumns[0]);
}

/**
 * 시험성적서 열 추가 (Heat No + 기본 화학 원소)
 * @param {string} kind - 테이블 종류
 */
export async function addTestReportColumns(kind) {
  const currentColumns = [...(state.tableEdit[kind]?.columns || [])];
  const missingColumns = TEST_REPORT_COLUMNS.filter((col) => !currentColumns.includes(col));

  if (!missingColumns.length) {
    alert("시험성적서 열이 이미 모두 존재합니다.");
    return;
  }

  const tabulator = tabulatorInstances[kind];
  const sourceRows = tabulator
    ? getTabulatorData(kind)
    : kind === "ocr"
      ? state.currentResult?.table || []
      : state.db?.docRows || [];
  const rows = (sourceRows.length ? sourceRows : [{}]).map((row) => {
    const nextRow = { ...(row || {}) };
    for (const col of missingColumns) {
      if (!(col in nextRow)) nextRow[col] = "";
    }
    return nextRow;
  });
  
  // Heat No를 맨 앞에 추가
  const heatNoIndex = missingColumns.indexOf("Heat No");
  if (heatNoIndex > 0) {
    missingColumns.splice(heatNoIndex, 1);
    missingColumns.unshift("Heat No");
  }
  
  const nextColumns = [...currentColumns, ...missingColumns];

  if (tabulator) {
    await replaceTabulatorColumnsAndData(kind, rows, nextColumns, "add_test_report_columns", kind === "ocr");
  } else {
    state.tableEdit[kind].columns = nextColumns;
    if (kind === "ocr") {
      if (!state.currentResult) state.currentResult = { table: rows, columns: nextColumns };
      state.currentResult.table = rows;
      state.currentResult.columns = nextColumns;
      initTabulator("ocr", rows, nextColumns);
    } else {
      state.db.docRows = rows;
      initTabulator("db", rows, nextColumns);
    }
  }

  setSelection(kind, selectionState[kind].row ?? 0, "Heat No");
}

export async function deleteColumn(kind) {
  const { row, col } = selectionState[kind];
  let colsBefore = [...(state.tableEdit[kind].columns || [])];
  
  if (!colsBefore.length) {
    alert("삭제할 열이 없습니다.");
    return;
  }
  
  let colToDelete = col;
  if (!colToDelete || !colsBefore.includes(colToDelete)) {
    colToDelete = colsBefore[colsBefore.length - 1];
  }
  
  const colIndex = colsBefore.indexOf(colToDelete);
  
  // 삭제할 값 저장
  const tabulator = tabulatorInstances[kind];
  const deletedValues = tabulator ? tabulator.getData().map(row => row[colToDelete] ?? "") : [];
  
  // Undo 스택에 저장
  pushUndo(kind, {
    type: "column",
    index: colIndex,
    col: colToDelete,
    values: deletedValues,
    selectedRow: row,
  });
  
  await deleteTabulatorColumn(kind, colToDelete);
  
  // 상태 업데이트
  if (kind === "ocr" && state.currentResult) {
    state.currentResult.table = getTabulatorData(kind);
  } else if (kind === "db") {
    state.db.docRows = getTabulatorData(kind);
  }
  
  const newCols = state.tableEdit[kind].columns || [];
  setSelection(kind, row, newCols[0] || null);
}

/**
 * 여러 열 삭제
 * @param {string} kind - 테이블 종류
 * @param {Array} columnNames - 삭제할 열 이름 배열
 * @returns {Object} 삭제 결과
 */
export async function deleteColumns(kind, columnNames = []) {
  const uniqColumns = [...new Set((columnNames || []).filter((c) => c))];
  if (!uniqColumns.length) return { deletedCount: 0, skipped: [] };

  const colsBefore = [...(state.tableEdit[kind].columns || [])];
  if (!colsBefore.length) return { deletedCount: 0, skipped: uniqColumns };

  const targets = uniqColumns.filter((c) => colsBefore.includes(c));
  if (!targets.length) return { deletedCount: 0, skipped: uniqColumns };

  const tabulator = tabulatorInstances[kind];
  if (!tabulator) return { deletedCount: 0, skipped: uniqColumns };
  const rowsBefore = tabulator.getRows().map((rowComponent) => rowComponent.getData());
  
  const removedColumns = targets.map((col) => ({
    col,
    index: colsBefore.indexOf(col),
    values: rowsBefore.map((r) => r?.[col] ?? ""),
  }));

  // Undo 스택에 저장
  pushUndo(kind, {
    type: "columns",
    removedColumns,
    selectedRow: selectionState[kind].row,
  });

  const targetSet = new Set(targets);
  const newCols = colsBefore.filter((col) => !targetSet.has(col));
  const newRows = rowsBefore.map((row) => {
    const nextRow = { ...row };
    delete nextRow.row_number;
    delete nextRow.drag_handle;
    for (const col of targetSet) delete nextRow[col];
    return nextRow;
  });

  await replaceTabulatorColumnsAndData(kind, newRows, newCols, "delete_columns", kind === "ocr");

  // 상태 업데이트
  if (kind === "ocr" && state.currentResult) {
    state.currentResult.table = getTabulatorData(kind);
    state.currentResult.columns = newCols;
  } else if (kind === "db") {
    state.db.docRows = getTabulatorData(kind);
  }

  const nextSelectedCol = newCols.includes(selectionState[kind].col) ? selectionState[kind].col : newCols[0] || null;
  setSelection(kind, selectionState[kind].row, nextSelectedCol);

  return {
    deletedCount: targets.length,
    skipped: uniqColumns.filter((c) => !targets.includes(c)),
  };
}

/**
 * 열 이동
 * @param {string} kind - 테이블 종류
 * @param {number} dir - 이동 방향 (-1: 왼쪽, 1: 오른쪽)
 */
export function moveColumn(kind, dir) {
  const { col } = selectionState[kind];
  if (!col) {
    alert("이동할 열을 먼저 선택해주세요 (헤더 더블클릭)");
    return;
  }
  
  const cols = [...(state.tableEdit[kind].columns || [])];
  const i = cols.indexOf(col);
  const j = i + dir;
  
  if (i < 0 || j < 0 || j >= cols.length) return;
  
  [cols[i], cols[j]] = [cols[j], cols[i]];
  state.tableEdit[kind].columns = cols;
  
  updateTabulatorColumns(kind, cols);
  syncEditedTableState(kind, "move_column", kind === "ocr");
  
  // ✅ 열 이동 후 선택 상태와 포커스 복원
  setTimeout(() => {
    setSelection(kind, selectionState[kind].row, col);
    focusTabulatorHeader(kind, col);
  }, 0);
}

/**
 * 열 이름 변경
 * @param {string} kind - 테이블 종류
 * @param {string} oldName - 기존 이름
 * @param {string} newName - 새 이름
 */
export async function renameColumn(kind, oldName, newName) {
  const ed = state.tableEdit[kind];
  let cols = [...(ed.columns || [])];
  
  const idx = cols.indexOf(oldName);
  if (idx < 0) return;
  
  if (cols.includes(newName)) {
    alert("이미 존재하는 열 이름입니다.");
    return;
  }
  
  cols[idx] = newName;
  state.tableEdit[kind].columns = cols;
  
  // 데이터에서 열 이름 변경
  const tabulator = tabulatorInstances[kind];
  if (tabulator) {
    const data = tabulator.getData();
    const newData = projectRowsToColumns(data.map(row => {
      const newRow = { ...row };
      if (oldName in newRow) {
        newRow[newName] = newRow[oldName];
        delete newRow[oldName];
      }
      return newRow;
    }), cols, { keepAllWhenNoColumns: false });
    
    await Promise.resolve(tabulator.setData(newData));
    updateTabulatorColumns(kind, cols);
  }
  
  setSelection(kind, selectionState[kind].row, newName);
  
  if (kind === "ocr" && state.currentResult) {
    state.currentResult.table = getTabulatorData(kind);
    state.currentResult.columns = cols;
  } else if (kind === "db") {
    state.db.docRows = getTabulatorData(kind);
  }
  
  // 열 이름 변경 후 자동 저장 요청(OCR 테이블에서만)
  if (kind === "ocr") {
    try {
      const { saveEdits } = await import("./table_edit_fix.js");
      await saveEdits({ silent: true, reason: "rename_column" });
    } catch (e) {
      console.warn("열 이름 변경 자동 저장 실패:", e);
    }
  }
}

/**
 * Undo 스택에 항목 추가
 * @param {string} kind - 테이블 종류
 * @param {Object} entry - Undo 항목
 */
function pushUndo(kind, entry) {
  const stack = undoStacks[kind];
  stack.push(entry);
  if (stack.length > UNDO_STACK_LIMIT) {
    stack.shift();
  }
}

/**
 * Undo 실행
 * @param {string} kind - 테이블 종류
 */
export function undoDelete(kind) {
  const stack = undoStacks[kind];
  const entry = stack.pop();
  
  if (!entry) {
    alert("실행 취소할 삭제 작업이 없습니다.");
    return;
  }

  const tabulator = tabulatorInstances[kind];
  if (!tabulator) return;

  if (entry.type === "row") {
    const insertAt = Math.max(0, Math.min(entry.index, tabulator.getRows().length));
    tabulator.addRow(entry.row, false, insertAt);
    
    // 상태 업데이트
    if (kind === "ocr" && state.currentResult) {
      state.currentResult.table = getTabulatorData(kind);
    } else if (kind === "db") {
      state.db.docRows = getTabulatorData(kind);
    }
    
    setSelection(kind, insertAt, entry.selectedCol ?? selectionState[kind].col);
    return;
  }

  if (entry.type === "rows") {
    const restores = [...(entry.removedRows || [])].sort((a, b) => a.index - b.index);
    for (const restore of restores) {
      const insertAt = Math.max(0, Math.min(Number(restore.index) || 0, tabulator.getRows().length));
      tabulator.addRow(restore.row || {}, false, insertAt);
    }
    
    // 상태 업데이트
    if (kind === "ocr" && state.currentResult) {
      state.currentResult.table = getTabulatorData(kind);
    } else if (kind === "db") {
      state.db.docRows = getTabulatorData(kind);
    }
    
    const firstIndex = restores.length ? restores[0].index : null;
    setSelection(kind, firstIndex !== null ? firstIndex : selectionState[kind].row, entry.selectedCol ?? selectionState[kind].col);
    return;
  }

  if (entry.type === "column") {
    const cols = [...(state.tableEdit[kind].columns || [])];
    
    if (cols.includes(entry.col)) {
      stack.push(entry);
      alert("이미 존재하는 열 이름입니다. 삭제 실행 취소를 건너뜁니다.");
      return;
    }
    
    const insertAt = Math.max(0, Math.min(entry.index, cols.length));
    cols.splice(insertAt, 0, entry.col);
    state.tableEdit[kind].columns = cols;
    
    // 데이터 복원
    const data = tabulator.getData();
    const newData = data.map((row, idx) => {
      const newRow = { ...row };
      newRow[entry.col] = entry.values?.[idx] ?? "";
      return newRow;
    });
    
    tabulator.setData(newData);
    updateTabulatorColumns(kind, cols);
    
    // 상태 업데이트
    if (kind === "ocr" && state.currentResult) {
      state.currentResult.table = getTabulatorData(kind);
    } else if (kind === "db") {
      state.db.docRows = getTabulatorData(kind);
    }
    
    setSelection(kind, selectionState[kind].row ?? null, entry.col);
    return;
  }

  if (entry.type === "columns") {
    const cols = [...(state.tableEdit[kind].columns || [])];
    const restores = [...(entry.removedColumns || [])].sort((a, b) => a.index - b.index);
    
    for (const restore of restores) {
      if (!restore?.col || cols.includes(restore.col)) continue;
      
      const insertAt = Math.max(0, Math.min(Number(restore.index) || 0, cols.length));
      cols.splice(insertAt, 0, restore.col);
      
      // 데이터 복원
      const data = tabulator.getData();
      const newData = data.map((row, idx) => {
        const newRow = { ...row };
        newRow[restore.col] = restore.values?.[idx] ?? "";
        return newRow;
      });
      
      tabulator.setData(newData);
    }
    
    state.tableEdit[kind].columns = cols;
    updateTabulatorColumns(kind, cols);
    
    // 상태 업데이트
    if (kind === "ocr" && state.currentResult) {
      state.currentResult.table = getTabulatorData(kind);
    } else if (kind === "db") {
      state.db.docRows = getTabulatorData(kind);
    }
    
    setSelection(kind, entry.selectedRow ?? selectionState[kind].row ?? null, cols[0] || null);
  }
}

/**
 * 전체 테이블을 클립보드에 복사
 * @param {string} kind - 테이블 종류
 */
export async function copyAllTableToClipboard(kind) {
  const tabulator = tabulatorInstances[kind];
  if (!tabulator) return;
  
  const columns = state.tableEdit[kind].columns || [];
  const data = tabulator.getData();
  
  const lines = [columns.join("\t"), ...data.map(row => columns.map(col => row[col] ?? "").join("\t"))];
  const tsv = lines.join("\n");
  
  try {
    await navigator.clipboard.writeText(tsv);
    alert("전체 테이블을 복사했습니다.");
  } catch (_) {
    const ta = document.createElement("textarea");
    ta.value = tsv;
    ta.setAttribute("readonly", "readonly");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    
    if (ok) {
      alert("전체 테이블을 복사했습니다.");
    } else {
      alert("전체 복사에 실패했습니다.");
    }
  }
}

/**
 * 테이블 렌더링 (편집 불가능한 버전 - 단순 표시용)
 * @param {Array} rows - 테이블 데이터
 * @param {Array} preferredColumns - 우선 열 정의
 */
export function renderTable(rows, preferredColumns = []) {
  const data = normalizeTableData(rows);
  const cols = computeColumnsFromRows(data, preferredColumns);

  if (!data.length && !cols.length) {
    destroyTabulator("ocr");
    const table = $("resultTable");
    if (table) {
      table.innerHTML = '<div class="muted">테이블 데이터가 없습니다.</div>';
    }
    updateRowCountHint("ocr", 0);
    return;
  }

  state.tableEdit.ocr.columns = cols;
  
  if (state.currentResult) {
    state.currentResult.columns = cols;
  }
  
  initTabulator("ocr", data, cols);
  updateRowCountHint("ocr", data.length);
  applySelectionHighlight("ocr");
  updateSelHint("ocr");
}

/**
 * 편집 가능한 테이블 렌더링 (편집 가능한 버전 - 단순 표시용)
 * @param {HTMLElement} tableEl - 테이블 요소
 * @param {Array} rows - 테이블 데이터
 * @param {Array} serverColumns - 서버에서 받은 열 정의
 */
export function renderEditableTableTo(tableEl, rows, serverColumns = []) {
  if (!tableEl) return;
  
  const data = normalizeTableData(rows);
  if (!data.length && !(Array.isArray(serverColumns) && serverColumns.length)) {
    const kind = tableEl.id === "resultTable" ? "ocr" : "db";
    destroyTabulator(kind);
    tableEl.innerHTML = '<div class="muted">테이블 데이터가 없습니다.</div>';
    updateRowCountHint(kind, 0);
    return;
  }

  // 서버에서 받은 열 정의 우선 사용, 없으면 기본 정의 사용
  const preferredColumns = Array.isArray(serverColumns) && serverColumns.length 
    ? serverColumns 
    : state.tableEdit.db.columns || [];
    
  const cols = computeColumnsFromRows(data, preferredColumns).filter((c) => {
    const s = String(c ?? "").trim();
    if (!s) return false;
    if (["id", "created_at"].includes(s.toLowerCase())) return false;
    if (s === "row_index") return false;
    if (!data.length) return true;
    return data.some((row) => hasMeaningfulValue(row?.[c]));
  });
  
  state.tableEdit.db.columns = cols;
  
  // DB 테이블 초기화
  initTabulator("db", data, cols);
  updateRowCountHint("db", data.length);
  applySelectionHighlight("db");
  updateSelHint("db");
}

/**
 * 테이블 데이터 정규화
 * @param {*} value - 정규화할 데이터
 * @returns {Array} 정규화된 데이터
 */
export function normalizeTableData(value) {
  if (!Array.isArray(value)) return [];
  if (!value.length) return [];
  if (value.every((x) => x && typeof x === "object" && !Array.isArray(x))) return value;
  return [];
}

/**
 * DOM에서 편집 가능한 테이블 수집 (편집 불가능한 버전 - 단순 표시용)
 * @param {HTMLElement} tableEl - 테이블 요소
 * @returns {Array} 테이블 데이터
 */
export function collectEditableTableFrom(tableEl) {
  return getTabulatorData(tableEl?.id === "resultTable" ? "ocr" : "db");
}

/**
 * 테이블 수집 (편집 불가능한 버전 - 단순 표시용)
 * @returns {Array} 테이블 데이터
 */
export function collectTable() {
  return getTabulatorData("ocr");
}

/**
 * 활성 에디터 상태 가져오기 (편집 불가능한 버전 - 단순 표시용)
 * @param {string} kind - 테이블 종류
 * @returns {Object} 에디터 상태
 */
export function getActiveEditor(kind) {
  return state.tableEdit[kind];
}

/**
 * 테이블 DOM 요소 가져오기 (편집 불가능한 버전 - 단순 표시용)
 * @param {string} kind - 테이블 종류
 * @returns {HTMLElement} 테이블 요소
 */
export function getTableDom(kind) {
  return kind === "ocr" ? $("resultTable") : $("dbTableDataTable");
}

/**
 * DOM에서 테이블 데이터 가져오기 (편집 불가능한 버전 - 단순 표시용)
 * @param {string} kind - 테이블 종류
 * @returns {Array} 테이블 데이터
 */
export function getTableRowsFromDom(kind) {
  return getTabulatorData(kind);
}

/**
 * 삽입 위치 옵션 업데이트 (편집 불가능한 버전 - 단순 표시용)
 * @param {string} kind - 테이블 종류
 */
export function updateInsertPosOptions(kind) {
  const ed = state.tableEdit[kind];
  const sel = kind === "ocr" ? $("ocrInsertPos") : $("dbInsertPos");
  if (!sel) return;
  
  const cols = ed.columns || [];
  sel.innerHTML =
    `<option value="-1">맨 앞</option>` +
    cols.map((c, idx) => `<option value="${idx}">${escapeHtml(c)} 뒤</option>`).join("") +
    `<option value="${cols.length}">맨 뒤</option>`;
  sel.value = String(cols.length);
}

/**
 * 테이블 다시 렌더링 (편집 불가능한 버전 - 단순 표시용)
 * @param {string} kind - 테이블 종류
 * @param {Array} rows - 테이블 데이터
 * @param {Array} cols - 열 정의
 */
export function rerender(kind, rows, cols) {
  state.tableEdit[kind].columns = cols;
  updateTabulatorData(kind, rows);
  updateTabulatorColumns(kind, cols);
  
  if (selectionState[kind].row !== null) {
    setSelection(kind, selectionState[kind].row, selectionState[kind].col);
  }
}

/**
 * 모든 행이 열을 가지도록 보장 (편집 불가능한 버전 - 단순 표시용)
 * @param {Array} rows - 테이블 데이터
 * @param {Array} cols - 열 정의
 * @returns {Array} 보장된 데이터
 */
export function ensureRowsHaveColumns(rows, cols) {
  return (rows || []).map((r) => {
    const obj = r && typeof r === "object" ? { ...r } : {};
    for (const c of cols) if (!(c in obj)) obj[c] = "";
    return obj;
  });
}

/**
 * 행 인덱스 업데이트 (편집 불가능한 버전 - 단순 표시용)
 * @param {string} kind - 테이블 종류
 */
export function updateRowIndices(kind) {
  const tabulator = tabulatorInstances[kind];
  if (!tabulator) return;
  
  const newRows = getTabulatorData(kind);
  
  if (kind === "ocr" && state.currentResult) {
    state.currentResult.table = newRows;
  } else if (kind === "db") {
    state.db.docRows = newRows;
  }

  const { row, col } = selectionState[kind];
  updateTabulatorData(kind, newRows);
  setSelection(kind, row, col);
}

/**
 * 테이블 편집 캐시 저장 (편집 불가능한 버전 - 단순 표시용)
 * @param {string} kind - 테이블 종류
 */
export function saveTableEditCache(kind) {
  try {
    const cacheKey = `table_edit_${kind}_cache`;
    const data = {
      table: getTabulatorData(kind),
      columns: state.tableEdit[kind].columns || [],
      timestamp: Date.now()
    };
    localStorage.setItem(cacheKey, JSON.stringify(data));
    console.log(`[Table Cache] 저장 완료 (${kind})`);
  } catch (e) {
    console.warn(`[Table Cache] 저장 실패 (${kind}):`, e);
  }
}

/**
 * 테이블 편집 캐시 로드 (편집 불가능한 버전 - 단순 표시용)
 * @param {string} kind - 테이블 종류
 * @returns {Object|null} 캐시된 데이터
 */
export function loadTableEditCache(kind) {
  try {
    const cacheKey = `table_edit_${kind}_cache`;
    const cached = localStorage.getItem(cacheKey);
    if (!cached) return null;
    
    const data = JSON.parse(cached);
    
    // 캐시 만료 확인 (1시간 이상 경과 시 만료)
    const oneHour = 60 * 60 * 1000;
    if (Date.now() - data.timestamp > oneHour) {
      console.log(`[Table Cache] 캐시 만료 (${kind})`);
      clearTableEditCache(kind);
      return null;
    }
    
    console.log(`[Table Cache] 로드 완료 (${kind})`);
    return data;
  } catch (e) {
    console.warn(`[Table Cache] 로드 실패 (${kind}):`, e);
    return null;
  }
}

/**
 * 테이블 편집 캐시 삭제 (편집 불가능한 버전 - 단순 표시용)
 * @param {string} kind - 테이블 종류
 */
export function clearTableEditCache(kind) {
  try {
    const cacheKey = `table_edit_${kind}_cache`;
    localStorage.removeItem(cacheKey);
    console.log(`[Table Cache] 삭제 완료 (${kind})`);
  } catch (e) {
    console.warn(`[Table Cache] 삭제 실패 (${kind}):`, e);
  }
}

// 전역 노출 (이전 버전 호환용)
if (typeof window !== "undefined") {
  window.TabulatorTable = {
    initTabulator,
    updateTabulatorData,
    getTabulatorData,
    updateTabulatorColumns,
    getTabulatorInstance,
    destroyTabulator,
    addTabulatorRow,
    deleteTabulatorRows,
    addTabulatorColumn,
    deleteTabulatorColumn,
    addDefaultChemColumns,
    copySelectedRow,
    pasteCopiedRow,
    isTabulatorInitialized,
    setSelection,
    addRow,
    moveRow,
    deleteRow,
    deleteRows,
    addOrInsertColumn,
    addTempColumn,
    addDefaultChemColumns,
    copySelectedRow,
    pasteCopiedRow,
    deleteColumn,
    deleteColumns,
    moveColumn,
    renameColumn,
    undoDelete,
    copyAllTableToClipboard,
    renderTable,
    renderEditableTableTo,
    collectEditableTableFrom,
    collectTable,
    getActiveEditor,
    getTableDom,
    getTableRowsFromDom,
    updateInsertPosOptions,
    rerender,
    ensureRowsHaveColumns,
    updateRowIndices,
    enterOcrBulkDeleteMode,
    exitOcrBulkDeleteMode,
    enterOcrRowBulkDeleteMode,
    exitOcrRowBulkDeleteMode,
  };
}