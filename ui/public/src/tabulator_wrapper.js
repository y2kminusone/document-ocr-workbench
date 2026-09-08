import { $ } from "./dom.js";
import { state } from "./state.js";

/**
 * Tabulator 테이블 래퍼 모듈
 * 
 * Tabulator.js 라이브러리를 프로젝트에 통합하기 위한 래퍼 함수들
 */

// Tabulator 인스턴스 저장소
const tabulatorInstances = {
  ocr: null,
  db: null
};

/**
 * Tabulator 테이블 초기화
 * @param {string} kind - 테이블 종류 ("ocr" 또는 "db")
 * @param {Array} data - 테이블 데이터
 * @param {Array} columns - 컬럼 정의
 * @param {Object} options - 추가 옵션
 * @returns {Object} Tabulator 인스턴스
 */
export function initTabulator(kind, data = [], columns = [], options = {}) {
  const tableId = kind === "ocr" ? "#resultTable" : "#dbTableDataTable";
  const tableEl = $(tableId.replace("#", ""));
  
  if (!tableEl) {
    console.error(`테이블 요소를 찾을 수 없습니다: ${tableId}`);
    return null;
  }

  // 기존 인스턴스가 있으면 파괴
  if (tabulatorInstances[kind]) {
    tabulatorInstances[kind].destroy();
    tabulatorInstances[kind] = null;
  }

  // 기본 옵션
  const defaultOptions = {
    data: data,
    columns: columns.map(col => ({
      title: col,
      field: col,
      editor: "input", // 셀 편집 가능
      headerFilter: "input", // 헤더 필터링
      resizable: true, // 컬럼 크기 조절 가능
    })),
    layout: "fitColumns",
    height: "100%",
    resizableColumns: true,
    movableRows: true,
    selectable: 1,
    pagination: "local",
    paginationSize: 20,
    paginationSizeSelector: [10, 20, 50, 100],
    
    // 셀 편집 이벤트
    cellEdited: function(cell) {
      console.log(`[Tabulator] 셀 편집됨 (${kind}):`, cell.getField(), cell.getValue());
      
      // 상태 업데이트
      if (kind === "ocr" && state.currentResult) {
        state.currentResult.table = getTabulatorData(kind);
      } else if (kind === "db") {
        state.db.docRows = getTabulatorData(kind);
      }
      
      // 저장 로직 호출 (table_edit_fix.js의 saveEdits 함수)
      if (typeof window.saveEdits === 'function' && kind === "ocr") {
        window.saveEdits({ silent: true, reason: "cell_edit" }).catch(err => {
          console.warn("셀 편집 후 저장 실패:", err);
        });
      }
    },
    
    // 행 이동 이벤트
    rowMoved: function(row) {
      console.log(`[Tabulator] 행 이동됨 (${kind}):`, row.getData());
      
      // 상태 업데이트
      if (kind === "ocr" && state.currentResult) {
        state.currentResult.table = getTabulatorData(kind);
      } else if (kind === "db") {
        state.db.docRows = getTabulatorData(kind);
      }
    },
    
    // 컬럼 이동 이벤트
    columnMoved: function(column, columns) {
      console.log(`[Tabulator] 컬럼 이동됨 (${kind}):`, column.getField());
      
      // 컬럼 순서 업데이트
      const newColumns = columns.map(col => col.getField());
      if (kind === "ocr" && state.currentResult) {
        state.currentResult.columns = newColumns;
      }
    },
    
    // 데이터 로딩 완료 이벤트
    dataLoaded: function(data) {
      console.log(`[Tabulator] 데이터 로딩 완료 (${kind}):`, data.length, "행");
    },
  };

  // 사용자 정의 옵션 병합
  const mergedOptions = { ...defaultOptions, ...options };

  // Tabulator 생성
  try {
    const tabulator = new Tabulator(tableEl, mergedOptions);
    tabulatorInstances[kind] = tabulator;
    
    console.log(`[Tabulator] 테이블 초기화 완료 (${kind})`);
    return tabulator;
  } catch (error) {
    console.error(`[Tabulator] 테이블 초기화 실패 (${kind}):`, error);
    return null;
  }
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
    return tabulator.getData();
  } catch (error) {
    console.error(`[Tabulator] 데이터 가져오기 실패 (${kind}):`, error);
    return [];
  }
}

/**
 * Tabulator 컬럼 업데이트
 * @param {string} kind - 테이블 종류 ("ocr" 또는 "db")
 * @param {Array} columns - 새 컬럼 정의
 */
export function updateTabulatorColumns(kind, columns) {
  const tabulator = tabulatorInstances[kind];
  if (!tabulator) {
    console.warn(`[Tabulator] 인스턴스가 없습니다 (${kind})`);
    return;
  }
  
  try {
    const newColumns = columns.map(col => ({
      title: col,
      field: col,
      editor: "input",
      headerFilter: "input",
      resizable: true,
    }));
    
    tabulator.setColumns(newColumns);
    console.log(`[Tabulator] 컬럼 업데이트 완료 (${kind}):`, columns.length, "개");
  } catch (error) {
    console.error(`[Tabulator] 컬럼 업데이트 실패 (${kind}):`, error);
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
 * Tabulator 테이블 파괴
 * @param {string} kind - 테이블 종류 ("ocr" 또는 "db")
 */
export function destroyTabulator(kind) {
  const tabulator = tabulatorInstances[kind];
  if (!tabulator) {
    console.warn(`[Tabulator] 인스턴스가 없습니다 (${kind})`);
    return;
  }
  
  try {
    tabulator.destroy();
    tabulatorInstances[kind] = null;
    console.log(`[Tabulator] 테이블 파괴 완료 (${kind})`);
  } catch (error) {
    console.error(`[Tabulator] 테이블 파괴 실패 (${kind}):`, error);
  }
}

/**
 * Tabulator 행 추가
 * @param {string} kind - 테이블 종류 ("ocr" 또는 "db")
 * @param {Object} rowData - 추가할 행 데이터
 * @param {boolean} addToTop - 맨 위에 추가할지 여부
 */
export function addTabulatorRow(kind, rowData = {}, addToTop = false) {
  const tabulator = tabulatorInstances[kind];
  if (!tabulator) {
    console.warn(`[Tabulator] 인스턴스가 없습니다 (${kind})`);
    return;
  }
  
  try {
    tabulator.addRow(rowData, addToTop);
    console.log(`[Tabulator] 행 추가 완료 (${kind})`);
  } catch (error) {
    console.error(`[Tabulator] 행 추가 실패 (${kind}):`, error);
  }
}

/**
 * Tabulator 행 삭제
 * @param {string} kind - 테이블 종류 ("ocr" 또는 "db")
 * @param {Array} rowIds - 삭제할 행 ID 배열
 */
export function deleteTabulatorRows(kind, rowIds = []) {
  const tabulator = tabulatorInstances[kind];
  if (!tabulator) {
    console.warn(`[Tabulator] 인스턴스가 없습니다 (${kind})`);
    return;
  }
  
  try {
    tabulator.deleteRow(rowIds);
    console.log(`[Tabulator] 행 삭제 완료 (${kind}):`, rowIds.length, "개");
  } catch (error) {
    console.error(`[Tabulator] 행 삭제 실패 (${kind}):`, error);
  }
}

/**
 * Tabulator 컬럼 추가
 * @param {string} kind - 테이블 종류 ("ocr" 또는 "db")
 * @param {string} columnName - 컬럼 이름
 * @param {number} position - 추가할 위치 (기본: 맨 뒤)
 */
export function addTabulatorColumn(kind, columnName, position = -1) {
  const tabulator = tabulatorInstances[kind];
  if (!tabulator) {
    console.warn(`[Tabulator] 인스턴스가 없습니다 (${kind})`);
    return;
  }
  
  try {
    const columnDef = {
      title: columnName,
      field: columnName,
      editor: "input",
      headerFilter: "input",
      resizable: true,
    };
    
    if (position === -1) {
      tabulator.addColumn(columnDef);
    } else {
      tabulator.addColumn(columnDef, false, position);
    }
    
    console.log(`[Tabulator] 컬럼 추가 완료 (${kind}):`, columnName);
  } catch (error) {
    console.error(`[Tabulator] 컬럼 추가 실패 (${kind}):`, error);
  }
}

/**
 * Tabulator 컬럼 삭제
 * @param {string} kind - 테이블 종류 ("ocr" 또는 "db")
 * @param {string} columnName - 삭제할 컬럼 이름
 */
export function deleteTabulatorColumn(kind, columnName) {
  const tabulator = tabulatorInstances[kind];
  if (!tabulator) {
    console.warn(`[Tabulator] 인스턴스가 없습니다 (${kind})`);
    return;
  }
  
  try {
    const column = tabulator.getColumn(columnName);
    if (column) {
      column.delete();
      console.log(`[Tabulator] 컬럼 삭제 완료 (${kind}):`, columnName);
    } else {
      console.warn(`[Tabulator] 컬럼을 찾을 수 없습니다 (${kind}):`, columnName);
    }
  } catch (error) {
    console.error(`[Tabulator] 컬럼 삭제 실패 (${kind}):`, error);
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

// 전역 노출 (디버깅용)
if (typeof window !== "undefined") {
  window.TabulatorWrapper = {
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
    isTabulatorInitialized,
  };
}