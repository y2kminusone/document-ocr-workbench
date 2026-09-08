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

export function initDragAndDrop(kind) {
  const tableEl = getTableDom(kind);
  if (!tableEl) return;

  // 기존 이벤트 리스너 제거 (중복 방지)
  const cleanup = () => {
    tableEl.removeEventListener("dragstart", handleDragStart);
    tableEl.removeEventListener("dragend", handleDragEnd);
    tableEl.removeEventListener("dragover", handleDragOver);
    tableEl.removeEventListener("dragleave", handleDragLeave);
    tableEl.removeEventListener("drop", handleDrop);
  };

  const handleDragStart = (e) => {
    const row = e.target.closest("tr");
    if (!row) return;
    row.classList.add("dragging");
    e.dataTransfer.setData("text/plain", row.getAttribute("data-row"));
    e.dataTransfer.effectAllowed = "move";
    const dragImg = document.createElement("div");
    dragImg.style.cssText = "position: absolute; opacity: 0;";
    document.body.appendChild(dragImg);
    e.dataTransfer.setDragImage(dragImg, 0, 0);
    setTimeout(() => document.body.removeChild(dragImg), 0);
  };

  const handleDragEnd = (e) => {
    const row = e.target.closest("tr");
    row?.classList.remove("dragging");
    document
      .querySelectorAll("tr.drag-over-top, tr.drag-over-bottom")
      .forEach((el) => el.classList.remove("drag-over-top", "drag-over-bottom"));
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    const row = e.target.closest("tr");
    if (!row) return;
    e.dataTransfer.dropEffect = "move";
    const rect = row.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (e.clientY < midpoint) {
      row.classList.add("drag-over-top");
      row.classList.remove("drag-over-bottom");
    } else {
      row.classList.add("drag-over-bottom");
      row.classList.remove("drag-over-top");
    }
  };

  const handleDragLeave = (e) => {
    const row = e.target.closest("tr");
    row?.classList.remove("drag-over-top", "drag-over-bottom");
  };

  const handleDrop = (e) => {
    e.preventDefault();
    const targetRow = e.target.closest("tr");
    if (!targetRow) return;

    const sourceIndex = parseInt(e.dataTransfer.getData("text/plain"), 10);
    const targetIndex = parseInt(targetRow.getAttribute("data-row"), 10);

    if (sourceIndex === targetIndex) return;

    const rows = getTableRowsFromDom(kind);
    if (!Array.isArray(rows)) return;

    if (sourceIndex >= rows.length || targetIndex >= rows.length) return;

    const rect = targetRow.getBoundingClientRect();
    const insertAfter = e.clientY >= rect.top + rect.height / 2;
    const insertIndex = insertAfter ? targetIndex + 1 : targetIndex;

    const [movedRow] = rows.splice(sourceIndex, 1);
    rows.splice(insertIndex, 0, movedRow);

    rerender(kind, rows, getActiveEditor(kind).columns);
    setSelection(kind, insertIndex, getActiveEditor(kind).selectedCol);

    if (kind === "ocr" && state.currentResult) {
      state.currentResult.table = [...rows];
    }

    targetRow.classList.remove("drag-over-top", "drag-over-bottom");
  };

  // 기존 이벤트 리스너 제거 후 새로 추가
  cleanup();
  tableEl.addEventListener("dragstart", handleDragStart);
  tableEl.addEventListener("dragend", handleDragEnd);
  tableEl.addEventListener("dragover", handleDragOver);
  tableEl.addEventListener("dragleave", handleDragLeave);
  tableEl.addEventListener("drop", handleDrop);
}

function updateRowCountHint(tableEl, rowCount) {
  const count = Number.isFinite(rowCount) ? rowCount : 0;
  if (tableEl?.id === "resultTable") {
    const hint = $("ocrRowCountHint");
    if (hint) hint.textContent = `총 ${count}행`;
    return;
  }
  if (tableEl?.id === "dbTableDataTable") {
    const hint = $("dbRowCountHint");
    if (hint) hint.textContent = `총 ${count}행`;
  }
}

export function renderTableTo(tableEl, rows, cols) {
  if (!tableEl) return;
  const isOcrTable = tableEl.id === "resultTable";
  const bulkDeleteState = state.ocrBulkDelete || {};
  const isDeleteMode = isOcrTable && bulkDeleteState.isMode === true;
  const selectedColumnIds = bulkDeleteState.selectedColumnIds instanceof Set
    ? bulkDeleteState.selectedColumnIds
    : new Set();
  const rowBulkDeleteState = state.ocrRowBulkDelete || {};
  const isRowDeleteMode = isOcrTable && rowBulkDeleteState.isMode === true;
  const selectedRowIds = rowBulkDeleteState.selectedRowIds instanceof Set
    ? rowBulkDeleteState.selectedRowIds
    : new Set();
  const rowCount = Array.isArray(rows) ? rows.length : 0;
  updateRowCountHint(tableEl, rowCount);

  if (!rows || !rows.length) {
    tableEl.innerHTML =
      '<tbody><tr><td class="muted">테이블 데이터가 없습니다.</td></tr></tbody>';
    return;
  }
  const thead = `<thead><tr>
    <th class="drag-handle-header"></th>
    <th class="row-index-header">#</th>
    ${cols
      .map((c) => {
        const colLabel = escapeHtml(c);
        if (!isDeleteMode) {
          return `<th data-col="${colLabel}" title="더블클릭하여 열 이름 편집">${colLabel}</th>`;
        }
        const checked = selectedColumnIds.has(c) ? "checked" : "";
        return `<th data-col="${colLabel}" title="삭제할 열 선택">
            <label class="col-delete-check-wrap" aria-label="${colLabel} 삭제 선택">
              <input type="checkbox" class="col-delete-checkbox" data-col="${colLabel}" ${checked} />
              <span>${colLabel}</span>
            </label>
          </th>`;
      })
      .join("")}
  </tr></thead>`;
  const tbody = `<tbody>
  ${rows
    .map((r, idx) => {
      return `<tr data-row="${idx}" draggable="true">
        <td class="drag-handle-cell"><div class="drag-handle">⋮⋮</div></td>
        <td class="row-index-cell">${
          isRowDeleteMode
            ? `<label class="row-delete-check-wrap" aria-label="${idx + 1}행 삭제 선택"><input type="checkbox" class="row-delete-checkbox" data-row="${idx}" ${selectedRowIds.has(String(idx)) ? "checked" : ""} /><span>${idx + 1}</span></label>`
            : `${idx + 1}`
        }</td>
        ${cols
          .map((c) => {
            const v = r?.[c];
            const display = v === null || v === undefined ? "" : String(v);
            return `<td contenteditable="true" data-col="${escapeHtml(c)}">${escapeHtml(display)}</td>`;
          })
          .join("")}
      </tr>`;
    })
    .join("")}
  </tbody>`;
  tableEl.innerHTML = thead + tbody;
}

export function getActiveEditor(kind) {
  return state.tableEdit[kind];
}

const UNDO_STACK_LIMIT = 10;

function getUndoStack(kind) {
  const ed = getActiveEditor(kind);
  if (!Array.isArray(ed.undoStack)) ed.undoStack = [];
  return ed.undoStack;
}

function pushUndo(kind, entry) {
  const stack = getUndoStack(kind);
  stack.push(entry);
  if (stack.length > UNDO_STACK_LIMIT) {
    stack.shift();
  }
}

function updateStoredTableData(kind, rows, cols) {
  if (kind === "ocr" && state.currentResult) {
    state.currentResult.table = rows.map((r) => ({ ...(r || {}) }));
    if (Array.isArray(cols)) {
      state.currentResult.columns = [...cols];
    }
  } else if (kind === "db") {
    state.db.docRows = rows.map((r) => ({ ...(r || {}) }));
  }
}

export function setSelection(kind, row, col) {
  const ed = getActiveEditor(kind);
  ed.selectedRow = row;
  ed.selectedCol = col;
  applySelectionHighlight(kind);
}

export function applySelectionHighlight(kind) {
  const tableEl = kind === "ocr" ? $("resultTable") : $("dbTableDataTable");
  if (!tableEl) return;
  const ed = getActiveEditor(kind);
  const rowSel = ed.selectedRow;
  const colSel = ed.selectedCol;
  [...tableEl.querySelectorAll("tr.selRow")].forEach((n) => n.classList.remove("selRow"));
  [...tableEl.querySelectorAll("th.selCol, td.selCol")].forEach((n) => n.classList.remove("selCol"));
  if (rowSel !== null && rowSel !== undefined) {
    const tr = tableEl.querySelector(`tbody tr[data-row="${rowSel}"]`);
    if (tr) tr.classList.add("selRow");
  }
  // 컬럼 선택 강조 – 공란("")인 경우에도 올바르게 동작하도록 처리
  if (colSel !== null && colSel !== undefined) {
    const headerSelector = colSel === "" ? `thead th[data-col=""]` : `thead th[data-col="${CSS.escape(colSel)}"]`;
    const cellSelector = colSel === "" ? `tbody td[data-col=""]` : `tbody td[data-col="${CSS.escape(colSel)}"]`;
    [...tableEl.querySelectorAll(headerSelector)].forEach((n) => n.classList.add("selCol"));
    [...tableEl.querySelectorAll(cellSelector)].forEach((n) => n.classList.add("selCol"));
  }
}

export function updateInsertPosOptions(kind) {
  const ed = getActiveEditor(kind);
  const sel = kind === "ocr" ? $("ocrInsertPos") : $("dbInsertPos");
  if (!sel) return;
  const cols = ed.columns || [];
  sel.innerHTML =
    `<option value="-1">맨앞</option>` +
    cols.map((c, idx) => `<option value="${idx}">${escapeHtml(c)} 뒤</option>`).join("") +
    `<option value="${cols.length}">맨뒤</option>`;
  sel.value = String(cols.length);
}

export function getTableDom(kind) {
  return kind === "ocr" ? $("resultTable") : $("dbTableDataTable");
}

export function getTableRowsFromDom(kind) {
  return collectEditableTableFrom(getTableDom(kind));
}

export function rerender(kind, rows, cols) {
  const ed = getActiveEditor(kind);
  ed.columns = cols;

  const tableEl = getTableDom(kind);
  renderTableTo(tableEl, rows, cols);
  initDragAndDrop(kind);
  updateInsertPosOptions(kind);

  if (ed.selectedRow !== null) {
    setSelection(kind, ed.selectedRow, ed.selectedCol);
  }
}

export function ensureRowsHaveColumns(rows, cols) {
  return (rows || []).map((r) => {
    const obj = r && typeof r === "object" ? { ...r } : {};
    for (const c of cols) if (!(c in obj)) obj[c] = "";
    return obj;
  });
}

export function addRow(kind) {
  const ed = getActiveEditor(kind);
  const cols = ed.columns || [];
  let rows = getTableRowsFromDom(kind);
  if (!cols.length) {
    alert("먼저 열을 추가하세요.");
    return;
  }
  rows = ensureRowsHaveColumns(rows, cols);
  const newRow = {};
  for (const c of cols) newRow[c] = "";

  const insertIndex = ed.selectedRow !== null ? ed.selectedRow + 1 : rows.length;
  rows.splice(insertIndex, 0, newRow);

  rerender(kind, rows, cols);
  setSelection(kind, insertIndex, ed.selectedCol || cols[0]);
}

export function moveRow(kind, dir) {
  const ed = getActiveEditor(kind);
  const row = ed.selectedRow;
  if (row === null || row === undefined) return alert("이동할 행을 먼저 선택하세요.");
  const rows = getTableRowsFromDom(kind);
  const i = Number(row);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= rows.length) return;

  [rows[i], rows[j]] = [rows[j], rows[i]];
  rerender(kind, rows, ed.columns || []);
  setSelection(kind, j, ed.selectedCol);
}

export function deleteRow(kind) {
  const ed = getActiveEditor(kind);
  const row = ed.selectedRow;
  let rows = getTableRowsFromDom(kind);
  if (!rows.length) return;
  const idx = row !== null && row !== undefined ? Number(row) : rows.length - 1;
  if (idx < 0 || idx >= rows.length) return;
  const removedRow = rows[idx];
  pushUndo(kind, {type: "row", index: idx, row: removedRow, selectedCol: ed.selectedCol});

  rows.splice(idx, 1);
  rerender(kind, rows, ed.columns || []);
  updateStoredTableData(kind, rows, ed.columns || []);
  setSelection(kind, rows.length ? Math.min(idx, rows.length - 1) : null, ed.selectedCol);
}

export function deleteRows(kind, rowIndexes = []) {
  const uniqIndexes = [...new Set((rowIndexes || []).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x >= 0))]
    .sort((a, b) => a - b);
  if (!uniqIndexes.length) return { deletedCount: 0, skipped: [] };

  const ed = getActiveEditor(kind);
  const rowsBefore = getTableRowsFromDom(kind);
  if (!Array.isArray(rowsBefore) || !rowsBefore.length) return { deletedCount: 0, skipped: uniqIndexes };

  const validIndexes = uniqIndexes.filter((idx) => idx < rowsBefore.length);
  if (!validIndexes.length) return { deletedCount: 0, skipped: uniqIndexes };

  const removedRows = validIndexes.map((idx) => ({ index: idx, row: rowsBefore[idx] }));
  const removeSet = new Set(validIndexes);
  const rows = rowsBefore.filter((_, idx) => !removeSet.has(idx));

  pushUndo(kind, {
    type: "rows",
    removedRows,
    selectedCol: ed.selectedCol,
  });

  rerender(kind, rows, ed.columns || []);
  updateStoredTableData(kind, rows, ed.columns || []);
  setSelection(kind, rows.length ? Math.min(validIndexes[0], rows.length - 1) : null, ed.selectedCol);

  return {
    deletedCount: validIndexes.length,
    skipped: uniqIndexes.filter((idx) => !removeSet.has(idx)),
  };
}

export function addOrInsertColumn(kind, mode) {
  const nameEl = kind === "ocr" ? $("ocrNewColName") : $("dbNewColName");
  const posEl = kind === "ocr" ? $("ocrInsertPos") : $("dbInsertPos");
  const raw = (nameEl?.value || "").trim();
  if (!raw) return alert("열 이름을 입력하세요.");
  const ed = getActiveEditor(kind);
  let cols = [...(ed.columns || [])];
  if (cols.includes(raw)) return alert("이미 존재하는 열 이름입니다.");

  let insertAt = cols.length;
  if (mode === "insert" && posEl) {
    const v = Number(posEl.value);
    if (v === -1) insertAt = 0;
    else if (v >= 0 && v <= cols.length) insertAt = v + 1;
    else insertAt = cols.length;
  }
  cols.splice(insertAt, 0, raw);

  let rows = getTableRowsFromDom(kind);
  if (!rows.length) rows = [{}];
  rows = ensureRowsHaveColumns(rows, cols);
  rerender(kind, rows, cols);
  if (nameEl) nameEl.value = "";
  setSelection(kind, ed.selectedRow ?? 0, raw);
}

export function deleteColumn(kind) {
  const ed = getActiveEditor(kind);
  let col = ed.selectedCol;
  let colsBefore = [...(ed.columns || [])];
  if (!colsBefore.length) {
    const tableEl = getTableDom(kind);
    colsBefore = [...(tableEl?.querySelectorAll("thead th[data-col]") || [])].map((th) =>
      th.getAttribute("data-col")
    );
    ed.columns = colsBefore.filter((c) => c);
  }
  if (!col || !colsBefore.includes(col)) {
    if (!colsBefore.length) return alert("삭제할 열이 없습니다.");
    col = colsBefore[colsBefore.length - 1];
  }
  const colIndex = colsBefore.indexOf(col);
  let cols = colsBefore.filter((c) => c !== col);
  let rows = getTableRowsFromDom(kind);
  const deletedValues = rows.map((r) => (r || {})[col] ?? "");
  pushUndo(kind, {
    type: "column",
    index: colIndex,
    col,
    values: deletedValues,
    selectedRow: ed.selectedRow,
  });
  rows = (rows || []).map((r) => {
    const obj = { ...(r || {}) };
    delete obj[col];
    return obj;
  });
  rerender(kind, rows, cols);
  updateStoredTableData(kind, rows, cols);
  setSelection(kind, ed.selectedRow, cols[0] || null);
}

export function deleteColumns(kind, columnNames = []) {
  const uniqColumns = [...new Set((columnNames || []).filter((c) => c))];
  if (!uniqColumns.length) return { deletedCount: 0, skipped: [] };

  const ed = getActiveEditor(kind);
  const colsBefore = [...(ed.columns || [])];
  if (!colsBefore.length) return { deletedCount: 0, skipped: uniqColumns };

  const targets = uniqColumns.filter((c) => colsBefore.includes(c));
  if (!targets.length) return { deletedCount: 0, skipped: uniqColumns };

  const rowsBefore = getTableRowsFromDom(kind);
  const targetSet = new Set(targets);
  const removedColumns = targets.map((col) => ({
    col,
    index: colsBefore.indexOf(col),
    values: rowsBefore.map((r) => (r || {})[col] ?? ""),
  }));

  const rows = (rowsBefore || []).map((r) => {
    const obj = { ...(r || {}) };
    targets.forEach((col) => {
      if (col in obj) delete obj[col];
    });
    return obj;
  });

  const cols = colsBefore.filter((c) => !targetSet.has(c));
  pushUndo(kind, {
    type: "columns",
    removedColumns,
    selectedRow: ed.selectedRow,
  });

  rerender(kind, rows, cols);
  updateStoredTableData(kind, rows, cols);
  const nextSelectedCol = cols.includes(ed.selectedCol) ? ed.selectedCol : cols[0] || null;
  setSelection(kind, ed.selectedRow, nextSelectedCol);

  return {
    deletedCount: targets.length,
    skipped: uniqColumns.filter((c) => !targetSet.has(c)),
  };
}


export function undoDelete(kind) {
  const ed = getActiveEditor(kind);
  const stack = getUndoStack(kind);
  const entry = stack.pop();
  if (!entry) {
    alert("복구할 삭제 기록이 없습니다.");
    return;
  }

  if (entry.type === "row") {
    let rows = getTableRowsFromDom(kind);
    const insertAt = Math.max(0, Math.min(entry.index, rows.length));
    rows.splice(insertAt, 0, entry.row);
    rows = ensureRowsHaveColumns(rows, ed.columns || []);
    rerender(kind, rows, ed.columns || []);
    updateStoredTableData(kind, rows, ed.columns || []);
    setSelection(kind, insertAt, entry.selectedCol ?? ed.selectedCol);
    return;
  }

  if (entry.type === "rows") {
    let rows = getTableRowsFromDom(kind);
    const restores = [...(entry.removedRows || [])].sort((a, b) => a.index - b.index);
    for (const restore of restores) {
      const insertAt = Math.max(0, Math.min(Number(restore.index) || 0, rows.length));
      rows.splice(insertAt, 0, restore.row || {});
    }
    rows = ensureRowsHaveColumns(rows, ed.columns || []);
    rerender(kind, rows, ed.columns || []);
    updateStoredTableData(kind, rows, ed.columns || []);
    const firstIndex = restores.length ? restores[0].index : null;
    setSelection(kind, firstIndex !== null ? firstIndex : ed.selectedRow, entry.selectedCol ?? ed.selectedCol);
    return;
  }

  if (entry.type === "column") {
    const cols = [...(ed.columns || [])];
    if (cols.includes(entry.col)) {
      stack.push(entry);
      alert("이미 존재하는 열 이름입니다. 삭제 복구를 취소합니다.");
      return;
    }
    const insertAt = Math.max(0, Math.min(entry.index, cols.length));
    cols.splice(insertAt, 0, entry.col);
    let rows = getTableRowsFromDom(kind);
    rows = ensureRowsHaveColumns(rows, cols).map((r, idx) => {
      const obj = { ...(r || {}) };
      obj[entry.col] = entry.values?.[idx] ?? "";
      return obj;
    });
    rerender(kind, rows, cols);
    updateStoredTableData(kind, rows, cols);
    setSelection(kind, ed.selectedRow ?? null, entry.col);
    return;
  }

  if (entry.type === "columns") {
    const cols = [...(ed.columns || [])];
    const restores = [...(entry.removedColumns || [])].sort((a, b) => a.index - b.index);
    let rows = getTableRowsFromDom(kind);

    for (const restore of restores) {
      if (!restore?.col || cols.includes(restore.col)) continue;
      const insertAt = Math.max(0, Math.min(Number(restore.index) || 0, cols.length));
      cols.splice(insertAt, 0, restore.col);
      rows = ensureRowsHaveColumns(rows, cols).map((r, idx) => {
        const obj = { ...(r || {}) };
        obj[restore.col] = restore.values?.[idx] ?? "";
        return obj;
      });
    }

    rerender(kind, rows, cols);
    updateStoredTableData(kind, rows, cols);
    setSelection(kind, entry.selectedRow ?? ed.selectedRow ?? null, cols[0] || null);
  }
}


export function moveColumn(kind, dir) {
  const ed = getActiveEditor(kind);
  const col = ed.selectedCol;
  if (!col) return alert("이동할 열을 먼저 선택하세요. (표에서 셀/헤더 클릭)");
  const cols = [...(ed.columns || [])];
  const i = cols.indexOf(col);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= cols.length) return;
  [cols[i], cols[j]] = [cols[j], cols[i]];
  const rows = ensureRowsHaveColumns(getTableRowsFromDom(kind), cols);
  rerender(kind, rows, cols);
  setSelection(kind, ed.selectedRow, col);
}

export async function renameColumn(kind, oldName, newName) {
  const ed = getActiveEditor(kind);
  let cols = [...(ed.columns || [])];
  const idx = cols.indexOf(oldName);
  if (idx < 0) return;
  if (cols.includes(newName)) {
    alert("이미 존재하는 열 이름입니다.");
    return;
  }
  cols[idx] = newName;
  let rows = getTableRowsFromDom(kind);
  rows = (rows || []).map((r) => {
    const obj = { ...(r || {}) };
    if (oldName in obj) {
      obj[newName] = obj[oldName];
      delete obj[oldName];
    }
    return obj;
  });
  rerender(kind, rows, cols);
  setSelection(kind, ed.selectedRow, newName);
  if (kind === "ocr" && state.currentResult) {
    state.currentResult.columns = cols;
  }
  
  // ✅ 열 이름 수정 후 자동 저장 (OCR 화면에서만)
  if (kind === "ocr") {
    try {
      const { saveEdits } = await import("./api.js");
      await saveEdits({ silent: true, reason: "rename_column" });
    } catch (e) {
      console.warn("열 이름 수정 후 자동 저장 실패:", e);
    }
  }
}

function makeTempColName(existingCols) {
  // 기존 열 이름 중 col1, col2, col3... 형식의 것들 찾기
  const colNumbers = existingCols
    .filter(c => c && c.startsWith('col'))
    .map(c => {
      const num = parseInt(c.substring(3), 10);
      return isNaN(num) ? 0 : num;
    });
  
  // 가장 큰 번호 찾기 (없으면 0)
  const maxNum = colNumbers.length > 0 ? Math.max(...colNumbers) : 0;
  
  // 다음 번호로 새 이름 생성
  return `col${maxNum + 1}`;
}

export function saveTableEditCache(kind, fileId) {
  if (!fileId) return;
  const ed = getActiveEditor(kind);
  const rows = getTableRowsFromDom(kind);
  const cacheKey = `${kind}_${fileId}`;
  
  state.tableEditCache[cacheKey] = {
    rows: rows.map(r => ({ ...(r || {}) })),
    columns: [...(ed.columns || [])],
    selectedRow: ed.selectedRow,
    selectedCol: ed.selectedCol,
    timestamp: Date.now()
  };
}

export function loadTableEditCache(kind, fileId) {
  if (!fileId) return null;
  const cacheKey = `${kind}_${fileId}`;
  const cached = state.tableEditCache[cacheKey];
  
  if (!cached) return null;
  
  // 캐시가 너무 오래되었으면 무시 (1시간)
  if (Date.now() - cached.timestamp > 3600000) {
    delete state.tableEditCache[cacheKey];
    return null;
  }
  
  return cached;
}

export function clearTableEditCache(kind, fileId) {
  if (!fileId) return;
  const cacheKey = `${kind}_${fileId}`;
  delete state.tableEditCache[cacheKey];
}

export function addTempColumn(kind) {
  const ed = getActiveEditor(kind);
  
  // 열 추가 전에 현재 상태 저장
  if (kind === "ocr" && state.selectedFileId) {
    saveTableEditCache(kind, state.selectedFileId);
  }
  
  let cols = [...(ed.columns || [])];
  const name = makeTempColName(cols);

  let insertAt = cols.length;
  if (ed.selectedCol) {
    const idx = cols.indexOf(ed.selectedCol);
    if (idx >= 0) {
      insertAt = idx + 1;
    }
  }
  cols.splice(insertAt, 0, name);

  let rows = getTableRowsFromDom(kind);
  if (!rows.length) rows = [{}];
  rows = ensureRowsHaveColumns(rows, cols);
  rerender(kind, rows, cols);
  setSelection(kind, ed.selectedRow ?? 0, name);
  
  // 열 추가 후 상태 다시 저장
  if (kind === "ocr" && state.selectedFileId) {
    saveTableEditCache(kind, state.selectedFileId);
  }
  
  // ✅ 캐시 업데이트: 열 추가 후 최신 상태를 캐시에 저장
  if (kind === "ocr" && state.selectedFileId) {
    const updatedRows = getTableRowsFromDom(kind);
    saveTableEditCache(kind, state.selectedFileId);
  }
}

export function updateRowIndices(kind) {
  const tableEl = kind === "ocr" ? $("resultTable") : $("dbTableDataTable");
  const rows = Array.from(tableEl.querySelectorAll("tbody tr"));
  const ed = getActiveEditor(kind);
  const cols = ed.columns || [];
  const newRows = rows.map((tr) => {
    const rowData = {};
    cols.forEach((col) => {
      const cell = tr.querySelector(`td[data-col="${CSS.escape(col)}"]`);
      rowData[col] = cell ? cell.textContent : "";
    });
    return rowData;
  });

  if (kind === "ocr" && state.currentResult) {
    state.currentResult.table = newRows;
  } else if (kind === "db") {
    state.db.docRows = newRows;
  }

  const selectedRow = ed.selectedRow;
  const selectedCol = ed.selectedCol;
  rerender(kind, newRows, cols);
  setSelection(kind, selectedRow, selectedCol);
}

export function handleRowDrag(kind, dataTransfer) {
  const { rowElement, dragY } = dataTransfer;
  const tbody = rowElement.parentElement;
  const rows = Array.from(tbody.children).filter((tr) => tr !== rowElement);

  for (let i = 0; i < rows.length; i++) {
    const rect = rows[i].getBoundingClientRect();
    const middleY = rect.top + rect.height / 2;

    if (dragY < middleY) {
      tbody.insertBefore(rowElement, rows[i]);
      return;
    }
  }

  tbody.appendChild(rowElement);
}

export function finalizeRowDrag(kind, dataTransfer) {
  const { rowElement } = dataTransfer;
  const tbody = rowElement.parentElement;
  const ed = getActiveEditor(kind);

  const newRows = Array.from(tbody.children).map((tr) => {
    const dataIndex = tr.getAttribute("data-row");
    return ed.rows[dataIndex];
  });

  ed.rows = newRows;
  rerender(kind, newRows, ed.columns);
}

export function renderTable(rows, preferredColumns = []) {
  const table = $("resultTable");
  if (!rows || !rows.length) {
    table.innerHTML =
      '<tbody><tr><td class="muted">테이블 데이터가 없습니다.</td></tr></tbody>';
    return;
  }

  const cols = computeColumnsFromRows(rows, preferredColumns);
  state.tableEdit.ocr.columns = cols;
  if (state.currentResult) state.currentResult.columns = cols;
  renderTableTo(table, ensureRowsHaveColumns(rows, cols), cols);
  updateInsertPosOptions("ocr");
  applySelectionHighlight("ocr");
  
  // ✅ localStorage 백업 확인 (table_edit_fix.js에서 제공하는 기능)
  if (typeof window !== "undefined" && window.checkTableBackup) {
    window.checkTableBackup("ocr");
  }
}

export function normalizeTableData(value) {
  if (!Array.isArray(value)) return [];
  if (!value.length) return [];
  if (value.every((x) => x && typeof x === "object" && !Array.isArray(x))) return value;
  return [];
}

export function renderEditableTableTo(tableEl, rows, serverColumns = []) {
  if (!tableEl) return;
  const data = normalizeTableData(rows);
  if (!data.length) {
    tableEl.innerHTML =
      '<tbody><tr><td class="muted">테이블 데이터가 없습니다.</td></tr></tbody>';
    return;
  }

  // 서버에서 받은 컬럼 순서 우선 사용, 없으면 기존 방식 사용
  const preferredColumns = Array.isArray(serverColumns) && serverColumns.length 
    ? serverColumns 
    : state.tableEdit.db.columns || [];
    
  const cols = computeColumnsFromRows(data, preferredColumns).filter((c) => {
    const s = String(c ?? "").trim();
    if (!s) return false;
    if (["id", "created_at"].includes(s.toLowerCase())) return false;
    if (s === "row_index") return false;
    return data.some((row) => {
      const v = row?.[c];
      return hasMeaningfulValue(v)
    });
  });
  state.tableEdit.db.columns = cols;
  renderTableTo(tableEl, ensureRowsHaveColumns(data, cols), cols);
  updateInsertPosOptions("db");
  applySelectionHighlight("db");
}

export function collectEditableTableFrom(tableEl) {
  if (!tableEl) return [];
  const rows = [];
  const trs = [...tableEl.querySelectorAll("tbody tr[data-row]")];
  for (const tr of trs) {
    const obj = {};
    for (const td of [...tr.querySelectorAll("td[data-col]")]) {
      const key = td.getAttribute("data-col");
      if (!key) continue;
      if (String(key).toLowerCase() === "id" || String(key).toLowerCase() === "created_at") continue;
      obj[key] = td.textContent ?? "";
    }
    rows.push(obj);
  }
  return rows;
}

export function collectTable() {
  const table = $("resultTable");
  const rows = [];
  const trs = [...table.querySelectorAll("tbody tr[data-row]")];
  for (const tr of trs) {
    const obj = {};
    for (const td of [...tr.querySelectorAll("td[data-col]")]) {
      const key = td.getAttribute("data-col");
      obj[key] = td.textContent ?? "";
    }
    rows.push(obj);
  }
  return rows;
}

function getCurrentColumns(kind) {
  const ed = getActiveEditor(kind);
  if (Array.isArray(ed.columns) && ed.columns.length) return [...ed.columns];
  const tableEl = getTableDom(kind);
  return [...(tableEl?.querySelectorAll("thead th[data-col]") || [])]
    .map((th) => th.getAttribute("data-col"))
    .filter((c) => c);
}

function toTsvLine(values) {
  return values
    .map((v) => String(v ?? "").replace(/\t/g, " ").replace(/\r?\n/g, " "))
    .join("\t");
}

function copyTextFallback(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "readonly");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  ta.style.pointerEvents = "none";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(ta);
  return ok;
}

export async function copyAllTableToClipboard(kind) {
  const cols = getCurrentColumns(kind);
  const rows = ensureRowsHaveColumns(getTableRowsFromDom(kind), cols);
  const lines = [toTsvLine(cols), ...rows.map((r) => toTsvLine(cols.map((c) => r?.[c] ?? "")))];
  const tsv = lines.join("\n");
  try {
    await navigator.clipboard.writeText(tsv);
    alert("전체 테이블을 복사했습니다.");
    return;
  } catch (_) {
    const ok = copyTextFallback(tsv);
    if (ok) alert("전체 테이블을 복사했습니다.");
    else alert("전체 복사에 실패했습니다.");
  }
}

if (typeof window !== "undefined") {
  window.renderEditableTableTo = renderEditableTableTo;
  window.collectEditableTableFrom = collectEditableTableFrom;
}