import { $ } from "./dom.js";
import { api } from "./api.js";
import { state } from "./state.js";
import {
  commitActiveHeaderRename,
  computeColumnsFromRows,
  getTabulatorData,
  getTabulatorInstance,
} from "./table_tabulator.js";

/**
 * 테이블 편집 기능 버그 수정 모듈
 * 
 * 주요 수정사항:
 * 1. commitActiveEdit() 함수로 편집 중인 셀 값 확정
 * 2. 저장 락(save lock)으로 동시 저장 방지
 * 3. TH 저장 트리거를 blur 기반으로 변경
 * 4. localStorage 백업 시스템
 * 5. 직렬화 함수에 검증 로직 추가
 * 6. 저장 시점 디버깅 로그
 */

// ============================================================================
// 1. 저장 락 (Save Lock) 시스템
// ============================================================================

/**
 * 저장 락 상태 관리
 */
const saveLockState = {
  saveInFlight: false,    // 저장이 진행 중인지
  pendingSave: false,     // 대기 중인 저장이 있는지
  pendingOptions: null,   // 대기 중인 저장 옵션
};

// ============================================================================
// 1.1 DB 저장 디바운스 시스템
// ============================================================================

/**
 * DB 저장 디바운스 상태 관리
 */
const dbSaveDebounceState = {
  timer: null,            // 디바운스 타이머
  pendingData: null,      // 대기 중인 DB 저장 데이터
  fileId: null,           // 대기 중인 파일 ID
  DEBOUNCE_MS: 2000       // 디바운스 대기 시간 (2초)
};

/**
 * DB 저장 디바운스 함수
 * @param {string} fileId - 파일 ID
 * @param {Object} dbPayload - DB 저장 페이로드
 */
function debouncedDbSave(fileId, dbPayload) {
  // 기존 타이머 취소
  if (dbSaveDebounceState.timer) {
    clearTimeout(dbSaveDebounceState.timer);
  }
  
  // 새로운 데이터 저장
  dbSaveDebounceState.fileId = fileId;
  dbSaveDebounceState.pendingData = dbPayload;
  
  console.log(`[DbDebounce] DB 저장 디바운스 대기 시작 (${dbSaveDebounceState.DEBOUNCE_MS}ms)`);
  
  // 디바운스 타이머 설정
  dbSaveDebounceState.timer = setTimeout(async () => {
    try {
      const currentFileId = dbSaveDebounceState.fileId;
      const currentPayload = dbSaveDebounceState.pendingData;
      
      if (!currentFileId || !currentPayload) {
        console.warn("[DbDebounce] 저장할 데이터가 없습니다.");
        return;
      }
      
      console.log(`[DbDebounce] DB 저장 실행: ${currentFileId}`);
      
      await api(`/api/files/${currentFileId}/save_to_db`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(currentPayload)
      });
      
      console.log("[DbDebounce] DB files 테이블 저장 완료 (result 컬럼 포함)");
      
      // 메모리 상태 업데이트
      if (state.selectedFileId) {
        state.fileDbCache[state.selectedFileId] = { 
          exists: true, 
          checkedAt: Date.now(), 
          checkedDone: true, 
          inflight: false 
        };
      }
      
      // 작업 캐시 업데이트
      if (state.selectedJobId) {
        const jobCached = state.jobsDbCache[state.selectedJobId] || {};
        state.jobsDbCache[state.selectedJobId] = { 
          ...jobCached, 
          hasDbFiles: true, 
          checkedAt: Date.now(), 
          inflight: false 
        };
      }
      
      // ✅ 주의: "(DB 존재)" 표시는 DB 저장 버튼 또는 Ctrl+S로 save_to_db API를 호출해서
      // 실제 저장이 일어난 대상에 대해서만 보이게 함 (디바운스 저장에서는 표시하지 않음)
      
    } catch (dbError) {
      console.warn("[DbDebounce] DB files 테이블 저장 실패:", dbError);
    } finally {
      // 상태 초기화
      dbSaveDebounceState.timer = null;
      dbSaveDebounceState.pendingData = null;
      dbSaveDebounceState.fileId = null;
    }
  }, dbSaveDebounceState.DEBOUNCE_MS);
}

/**
 * 저장 락이 해제될 때까지 대기
 * @returns {Promise<void>}
 */
async function waitForSaveLock() {
  while (saveLockState.saveInFlight) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/**
 * 저장 락 획득
 */
function acquireSaveLock() {
  saveLockState.saveInFlight = true;
  saveLockState.pendingSave = false;
  saveLockState.pendingOptions = null;
}

/**
 * 저장 락 해제 및 대기 중인 저장 실행
 */
function releaseSaveLock() {
  saveLockState.saveInFlight = false;
  
  // 대기 중인 저장이 있으면 실행
  if (saveLockState.pendingSave && saveLockState.pendingOptions) {
    const options = saveLockState.pendingOptions;
    saveLockState.pendingSave = false;
    saveLockState.pendingOptions = null;
    
    // 다음 틱에 실행하여 재귀 방지
    setTimeout(() => {
      saveEditsWithLock(options).catch(err => {
        console.warn("대기 중인 저장 실패:", err);
      });
    }, 0);
  }
}

/**
 * 저장 락을 적용한 저장 함수
 * @param {Object} options - 저장 옵션
 * @returns {Promise<void>}
 */
async function saveEditsWithLock(options = {}) {
  // 이미 저장 중이면 대기열에 추가
  if (saveLockState.saveInFlight) {
    console.log(`[SaveLock] 저장 중이므로 대기열에 추가 (reason: ${options.reason})`);
    saveLockState.pendingSave = true;
    saveLockState.pendingOptions = options;
    return;
  }
  
  // 락 획득
  acquireSaveLock();
  
  try {
    // 편집 중인 셀 값 확정
    commitActiveEdit();
    
    // 저장 실행
    await performSave(options);
  } finally {
    // 락 해제
    releaseSaveLock();
  }
}

// ============================================================================
// 2. commitActiveEdit() 함수
// ============================================================================

/**
 * 현재 편집 중인 셀의 값을 확정
 * 
 * - document.activeElement가 contenteditable이면 compositionend 이벤트 강제 dispatch
 * - blur() 호출하여 값 확정
 * - 모든 저장 트리거의 가장 첫 단계에서 호출
 */
function commitActiveEdit() {
  const activeElement = document.activeElement;
  
  if (!activeElement) return;
  
  const isContentEditable = activeElement.isContentEditable;
  
  if (!isContentEditable) return;
  
  console.log("[commitActiveEdit] 편집 중인 요소 확정:", {
    tagName: activeElement.tagName,
    className: activeElement.className,
    textContent: activeElement.textContent?.substring(0, 50)
  });
  
  // IME composition이 진행 중이면 강제 종료
  if (activeElement.getAttribute('data-composing') === 'true') {
    console.log("[commitActiveEdit] IME composition 강제 종료");
    const compositionEndEvent = new CompositionEvent('compositionend', {
      bubbles: true,
      cancelable: true,
      data: activeElement.textContent
    });
    activeElement.dispatchEvent(compositionEndEvent);
    activeElement.removeAttribute('data-composing');
  }
  
  // blur 호출하여 값 확정
  activeElement.blur();
  
  console.log("[commitActiveEdit] 편집 확정 완료");
}

// ============================================================================
// 3. localStorage 백업 시스템
// ============================================================================

const BACKUP_KEY_PREFIX = 'backup:';
const BACKUP_DEBOUNCE_MS = 500;

let backupDebounceTimer = null;

/**
 * localStorage에 테이블 상태 백업
 * @param {string} fileId - 파일 ID
 * @param {Object} data - 백업할 데이터
 */
function backupTableState(fileId, data) {
  if (!fileId) return;
  
  // 기존 타이머 취소
  if (backupDebounceTimer) {
    clearTimeout(backupDebounceTimer);
  }
  
  // 디바운스
  backupDebounceTimer = setTimeout(() => {
    try {
      const backupKey = `${BACKUP_KEY_PREFIX}${fileId}`;
      const backupData = {
        ...data,
        timestamp: Date.now(),
        backupTime: new Date().toISOString()
      };
      
      localStorage.setItem(backupKey, JSON.stringify(backupData));
      console.log(`[Backup] 백업 완료: ${fileId}`, {
        timestamp: backupData.timestamp,
        rows: data.table?.length || 0,
        columns: data.columns?.length || 0
      });
    } catch (e) {
      console.warn("[Backup] 백업 실패:", e);
    }
  }, BACKUP_DEBOUNCE_MS);
}

/**
 * localStorage에서 백업된 상태 로드
 * @param {string} fileId - 파일 ID
 * @param {number} serverTimestamp - 서버 데이터 타임스탬프
 * @returns {Object|null} 백업된 데이터 또는 null
 */
function loadBackupState(fileId, serverTimestamp) {
  if (!fileId) return null;
  
  try {
    const backupKey = `${BACKUP_KEY_PREFIX}${fileId}`;
    const backupJson = localStorage.getItem(backupKey);
    
    if (!backupJson) return null;
    
    const backupData = JSON.parse(backupJson);
    
    // 백업이 너무 오래되었으면 무시 (24시간)
    if (Date.now() - backupData.timestamp > 86400000) {
      localStorage.removeItem(backupKey);
      return null;
    }
    
    return backupData;
  } catch (e) {
    console.warn("[Backup] 백업 로드 실패:", e);
    return null;
  }
}

/**
 * 백업 삭제
 * @param {string} fileId - 파일 ID
 */
function clearBackup(fileId) {
  if (!fileId) return;
  
  try {
    const backupKey = `${BACKUP_KEY_PREFIX}${fileId}`;
    localStorage.removeItem(backupKey);
    console.log(`[Backup] 백업 삭제: ${fileId}`);
  } catch (e) {
    console.warn("[Backup] 백업 삭제 실패:", e);
  }
}

/**
 * 백업 복원 여부 확인
 * @param {string} fileId - 파일 ID
 * @param {number} serverTimestamp - 서버 데이터 타임스탬프
 * @returns {Promise<boolean>} 복원 여부
 */
async function checkAndRestoreBackup(fileId, serverTimestamp) {
  const backup = loadBackupState(fileId, serverTimestamp);
  
  if (!backup) return false;
  
  // 백업이 서버 데이터보다 최신이면 복원 확인
  if (backup.timestamp > serverTimestamp) {
    const backupTime = new Date(backup.timestamp).toLocaleString('ko-KR');
    const message = `백업된 편집 내용이 있습니다.\n\n백업 시간: ${backupTime}\n\n백업을 복원하시겠습니까?`;
    
    if (confirm(message)) {
      return true;
    } else {
      // 복원하지 않으면 백업 삭제
      clearBackup(fileId);
      return false;
    }
  }
  
  return false;
}

// ============================================================================
// 4. 직렬화 함수에 검증 로직 추가
// ============================================================================

/**
 * 테이블 데이터 검증
 * @param {Object} data - 검증할 데이터
 * @returns {Object} 검증 결과 { valid: boolean, errors: string[] }
 */
function validateTableData(data) {
  const errors = [];
  
  if (!data) {
    errors.push("데이터가 없습니다.");
    return { valid: false, errors };
  }
  
  const { table, columns } = data;
  
  // 테이블 검증
  if (!Array.isArray(table)) {
    errors.push("table이 배열이 아닙니다.");
  } else {
    // 각 행의 셀 수와 컬럼 수 일치 확인
    table.forEach((row, idx) => {
      if (!row || typeof row !== 'object') {
        errors.push(`행 ${idx}: 객체가 아닙니다.`);
        return;
      }
      
      const rowKeys = Object.keys(row);
      const missingColumns = columns.filter(col => !rowKeys.includes(col));
      
      if (missingColumns.length > 0) {
        errors.push(`행 ${idx}: 누락된 컬럼 - ${missingColumns.join(', ')}`);
      }
    });
  }
  
  // 컬럼 검증
  if (!Array.isArray(columns)) {
    errors.push("columns가 배열이 아닙니다.");
  } else {
    // 중복 컬럼 확인
    const seen = new Set();
    columns.forEach((col, idx) => {
      if (!col || typeof col !== 'string') {
        errors.push(`컬럼 ${idx}: 문자열이 아닙니다.`);
        return;
      }
      
      if (seen.has(col)) {
        errors.push(`컬럼 ${idx}: 중복된 컬럼 이름 - ${col}`);
      }
      seen.add(col);
    });
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * DOM에서 테이블 데이터 수집 (검증 포함)
 * @param {HTMLElement} tableEl - 테이블 요소
 * @returns {Object} 수집된 데이터
 */
function collectTableWithValidation(tableEl) {
  if (!tableEl) {
    console.warn("[Validation] 테이블 요소가 없습니다.");
    return { table: [], columns: [] };
  }

  const kind = tableEl.id === "resultTable" ? "ocr" : tableEl.id === "dbTableDataTable" ? "db" : null;
  if (kind && getTabulatorInstance(kind)) {
    const table = getTabulatorData(kind);
    const preferredColumns = (state.tableEdit[kind]?.columns || []).filter(Boolean);
    const columns = (preferredColumns.length ? preferredColumns : computeColumnsFromRows(table, []))
      .map((col) => String(col || "").trim())
      .filter((col) => col && !["row_number", "drag_handle"].includes(col));

    const validation = validateTableData({ table, columns });
    if (!validation.valid) {
      console.warn("[Validation] Tabulator table validation failed:", validation.errors);
    } else {
      console.log("[Validation] Tabulator table validation passed");
    }

    return { table, columns };
  }
  
  // 기존 collectTable 함수 사용
  const table = collectTableFromDom(tableEl);
  const columns = getColumnsFromDom(tableEl);
  
  // 검증
  const validation = validateTableData({ table, columns });
  
  if (!validation.valid) {
    console.warn("[Validation] 테이블 데이터 검증 실패:", validation.errors);
  } else {
    console.log("[Validation] 테이블 데이터 검증 성공");
  }
  
  return { table, columns };
}

/**
 * DOM에서 테이블 데이터 수집
 * @param {HTMLElement} tableEl - 테이블 요소
 * @returns {Array} 테이블 데이터
 */
function collectTableFromDom(tableEl) {
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

/**
 * DOM에서 컬럼 데이터 수집
 * @param {HTMLElement} tableEl - 테이블 요소
 * @returns {Array} 컬럼 데이터
 */
function getColumnsFromDom(tableEl) {
  const cols = [...(tableEl?.querySelectorAll("thead th[data-col]") || [])]
    .map((th) => th.getAttribute("data-col"))
    .map((col) => (col || "").trim())
    .filter(Boolean);
  
  return cols;
}

// ============================================================================
// 5. 저장 시점 디버깅 로그
// ============================================================================

/**
 * 저장 시점 디버깅 로그 출력
 * @param {string} trigger - 저장 트리거 이름
 * @param {Object} data - 저장할 데이터
 */
function logSavePoint(trigger, data) {
  const activeElement = document.activeElement;
  const isEditing = activeElement && activeElement.isContentEditable;
  
  console.group(`[SavePoint] ${trigger}`);
  console.log("활성 요소:", {
    tagName: activeElement?.tagName,
    className: activeElement?.className,
    isContentEditable: isEditing,
    textContent: activeElement?.textContent?.substring(0, 50)
  });
  console.log("편집 중:", isEditing);
  console.log("컬럼 수:", data.columns?.length || 0);
  console.log("행 수:", data.table?.length || 0);
  console.log("모든 TH의 textContent:");
  console.table(data.columns?.map(col => ({ column: col, textContent: col })) || []);
  console.groupEnd();
}

// ============================================================================
// 6. 저장 함수 (수정됨)
// ============================================================================

/**
 * 저장 실행 (내부 함수)
 * @param {Object} options - 저장 옵션
 * @returns {Promise<void>}
 */
async function performSave(options = {}) {
  const { silent = false, reason = "manual" } = options;
  
  if (!state.selectedFileId) {
    if (!silent) {
      throw new Error("파일을 선택해주세요.");
    }
    return;
  }
  
  if (!state.currentResult) {
    console.warn("[performSave] state.currentResult가 없습니다. 저장을 건너뜁니다.");
    return;
  }
  
  const fileId = state.selectedFileId;
  const tableEl = $("resultTable");

  await commitActiveHeaderRename("ocr");
  
  // DOM에서 데이터 수집 (검증 포함)
  const { table, columns } = collectTableWithValidation(tableEl);
  
  // 디버깅 로그
  logSavePoint(reason, { table, columns });
  
  // 상태 업데이트 (안전하게 처리)
  if (state.currentResult) {
    state.currentResult.table = table;
    state.currentResult.columns = columns;
  } else {
    console.warn("[performSave] state.currentResult가 null입니다. 상태 업데이트를 건너뜁니다.");
  }
  
  const payload = {
    title: $("titleInput").value.trim(),
    table,
    columns,
  };
  
  try {
    // ✅ 서버 메모리에 저장 (기존 방식)
    await api(`/api/files/${fileId}/result`, {
      method: "POST",
      headers: { "Content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    
    // 저장 성공 후 백업 삭제
    clearBackup(fileId);
    
    if (!silent) {
      $("tableHint").textContent = "저장 완료";
      setTimeout(() => $("tableHint").textContent = "편집 내용이 자동 저장됩니다.", 1000);
    }
  } catch (e) {
    if (!silent) {
      throw e;
    }
  }
}

/**
 * 저장 함수 (공개 API)
 * @param {Object} options - 저장 옵션
 * @returns {Promise<void>}
 */
export async function saveEdits(options = {}) {
  return saveEditsWithLock(options);
}

if (typeof window !== "undefined") {
  window.saveEdits = saveEdits;
}

// ============================================================================
// 7. TH 저장 트리거 변경 (focusin 기반, 편집 모드 유지)
// ============================================================================

/**
 * TH 요소에 focusin 기반 저장 이벤트 리스너 추가
 * @param {HTMLElement} tableEl - 테이블 요소
 * @param {string} kind - 테이블 종류 ("ocr" 또는 "db")
 */
function setupThBlurSave(tableEl, kind) {
  if (!tableEl) return;
  
  // focusin 이벤트 리스너 추가 (새로운 TH에 focus가 들어올 때 이전 TH 저장)
  tableEl.addEventListener("focusin", (e) => {
    const th = e.target.closest("thead th[data-col]");
    
    if (!th) return;
    
    // OCR 테이블에서만 저장
    if (kind === "ocr" && state.selectedFileId && state.currentResult) {
      console.log("[ThBlurSave] TH focusin 감지, 저장 트리거");
      
      // 편집 모드 유지를 위해 commitActiveEdit() 호출하지 않고 직접 저장
      // saveEditsWithLock은 내부에서 commitActiveEdit()를 호출하므로
      // performSave()를 직접 호출하여 편집 모드 유지
      performSave({ silent: true, reason: "th_focusin" }).catch(err => {
        console.warn("TH focusin 저장 실패:", err);
      });
    }
  });
}

// ============================================================================
// 8. 입력 이벤트 리스너 (백업용)
// ============================================================================

/**
 * 테이블 입력 이벤트 리스너 설정 (백업용)
 * @param {HTMLElement} tableEl - 테이블 요소
 */
function setupInputBackup(tableEl) {
  if (!tableEl) return;
  
  // contenteditable 요소에서 input 이벤트 감지
  tableEl.addEventListener("input", (e) => {
    const target = e.target;
    
    if (!target.isContentEditable) return;
    
    // 파일 ID가 있으면 백업
    if (state.selectedFileId) {
      const tableEl = $("resultTable");
      const { table, columns } = collectTableWithValidation(tableEl);
      
      backupTableState(state.selectedFileId, { table, columns });
    }
  }, true);
}

// ============================================================================
// 9. 초기화 함수
// ============================================================================

/**
 * 테이블 편집 수정 기능 초기화
 * @param {string} kind - 테이블 종류 ("ocr" 또는 "db")
 */
export function initTableEditFix(kind) {
  const tableEl = kind === "ocr" ? $("resultTable") : $("dbTableDataTable");
  
  if (!tableEl) return;
  
  // TH blur 저장 설정
  setupThBlurSave(tableEl, kind);
  
  // 입력 백업 설정 (OCR만)
  if (kind === "ocr") {
    setupInputBackup(tableEl);
  }
  
  console.log(`[TableEditFix] 초기화 완료: ${kind}`);
}

// ============================================================================
// 10. 내보내기
// ============================================================================

export {
  commitActiveEdit,
  backupTableState,
  loadBackupState,
  clearBackup,
  checkAndRestoreBackup,
  validateTableData,
  collectTableWithValidation,
  logSavePoint,
  saveLockState
};
