import { $ } from "./dom.js";
import { state } from "./state.js";
import { badge, escapeHtml, applyPreviewRotationFromState, updatePopupImage, normalizeRotation } from "./ui_utils.js";
import {
  renderTable,
  computeColumnsFromRows,
  collectTable,
  collectEditableTableFrom,
  renderEditableTableTo,
  hasMeaningfulValue,
  saveTableEditCache,
  loadTableEditCache,
  clearTableEditCache,
  destroyTabulator,
} from "./table_tabulator.js";

export const DEFAULT_API_BASE = "http://127.0.0.1:8010";
let systemLogsLastRefreshErrorAt = 0;

function getDefaultOrigin() {
  try {
    const u = new URL(DEFAULT_API_BASE);
    const protocol = u.protocol === "https:" ? "https:" : "http:";
    return { protocol, host: u.hostname };
  } catch (_) {
    return null;
  }
}

function normalizeApiBase(raw) {
  const value = String(raw || "").trim().replace(/\/+$/, "");
  if (!value) return "";

  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }

  const fallback = getDefaultOrigin();
  const protocol = fallback?.protocol || (window?.location?.protocol === "https:" ? "https:" : "http:");
  const host = fallback?.host || window?.location?.hostname || "localhost";

  // 사용자가 localStorage에 저장한 포트 번호(예: "19010")인 경우 포트로 처리
  if (/^\d{2,5}$/.test(value)) {
    return `${protocol}//${host}:${value}`;
  }

  // host:port 형식인 경우 프로토콜을 앞에 붙여 URL로 처리
  if (/^[A-Za-z0-9.-]+:\d{2,5}$/.test(value)) {
    return `${protocol}//${value}`;
  }

  return "";
}

function getDbQuery() {
  return {
    q: ($("dbSearch")?.value || "").trim(),
    table_q: ($("dbTableQ")?.value || "").trim(),
  };
}

function getFileQuery() {
  return {
    q: ($("fileSearch")?.value || "").trim(),
    page_q: ($("filePageQ")?.value || "").trim(),
  };
}

if (typeof window !== "undefined") {
  window.getDbQuery = getDbQuery;
  window.getApiBase = getApiBase;
}

export function getApiBase() {
  const saved = normalizeApiBase(localStorage.getItem("OCR_API_BASE") || "");
  if (saved) {
    try { localStorage.setItem("OCR_API_BASE", saved); } catch (_) {}
    return saved;
  }
  try { localStorage.removeItem("OCR_API_BASE"); } catch (_) {}

  // location.href의 api= 쿼리스트링에서 localStorage에 저장되지 않은 경우 사용
  try {
    const u = new URL(window.location.href);
    const qp = u.searchParams.get("api");
    if (qp) {
      const v = normalizeApiBase(qp);
      if (v) {
        localStorage.setItem("OCR_API_BASE", v);
        return v;
      }
    }
  } catch (_) {}

  const fallback = normalizeApiBase(DEFAULT_API_BASE);
  if (fallback) return fallback;

  return "";
}

export function requireApiBase() {
  const base = getApiBase();
  if (base) return base;

  if (window.location && window.location.protocol === "file:") {
    alert("API 주소가 설정되지 않았습니다.\n\n예: index.html?api=http://127.0.0.1:9010\n\n(또는 localStorage에 OCR_API_BASE 키 저장)");
    throw new Error("API_BASE_REQUIRED");
  }

  return "";
}

// ✅ 성능 최적화: API 요청 디바운싱 캐시
const requestCache = new Map(); // cacheKey -> Promise
const requestTimers = new Map(); // cacheKey -> timerId
const CACHE_TTL = 5000; // 5초 캐시

// ✅ 성능 최적화: 캐시 키 생성 함수
function getCacheKey(path, options) {
  // GET 요청만 캐싱 (POST, PUT, DELETE는 캐싱하지 않음)
  if (options.method && options.method !== "GET") {
    return null;
  }
  
  // ✅ 파일 결과 API는 캐싱하지 않음 (OCR 처리 완료 후 최신 결과를 가져와야 함)
  if (path.includes("/result")) {
    return null;
  }
  
  // 특정 API만 캐싱 (작업 목록, 파일 목록 등)
  const cacheablePaths = [
    "/api/jobs/"
  ];
  
  const isCacheable = cacheablePaths.some(cachePath => path.includes(cachePath));
  if (!isCacheable) {
    return null;
  }
  
  // 캐시 키 생성 (경로 + 메서드)
  return `${options.method || "GET"}:${path}`;
}

// ✅ 성능 최적화: 캐시 정리 함수
function clearCache(cacheKey) {
  if (requestTimers.has(cacheKey)) {
    clearTimeout(requestTimers.get(cacheKey));
    requestTimers.delete(cacheKey);
  }
  requestCache.delete(cacheKey);
}

export async function api(path, opts = {}) {
  const base = requireApiBase();
  const url = base ? `${base}${path}` : path;
  
  // ✅ 성능 최적화: 디바운싱 캐시 확인
  const cacheKey = getCacheKey(path, opts);
  if (cacheKey && requestCache.has(cacheKey)) {
    console.log(`캐시된 API 요청 재사용: ${path}`);
    try {
      return await requestCache.get(cacheKey);
    } catch (error) {
      // 에러 발생 시 캐시 정리
      clearCache(cacheKey);
      throw error;
    }
  }
  
  // 캐시 방지 옵션 추가
  const fetchOptions = {
    ...opts,
    cache: 'no-store',
    headers: {
      ...opts.headers,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    }
  };
  
  // ✅ 성능 최적화: 캐시 가능한 요청이면 Promise 캐싱
  let requestPromise;
  if (cacheKey) {
    requestPromise = fetch(url, fetchOptions).then(async (res) => {
      const contentType = res.headers.get("content-type") || "";
      const body = contentType.includes("application/json") ? await res.json() : await res.text();

      if (!res.ok) {
        const msg =
          typeof body === "object" && body && body.detail
            ? body.detail
            : typeof body === "string"
            ? body
            : JSON.stringify(body);

        const err = new Error(msg);
        err.status = res.status;
        err.body = body;
        throw err;
      }
      return body;
    });
    
    // 캐시 저장
    requestCache.set(cacheKey, requestPromise);
    
    // 캐시 만료 타이머 설정
    const timerId = setTimeout(() => {
      clearCache(cacheKey);
    }, CACHE_TTL);
    requestTimers.set(cacheKey, timerId);
    
    try {
      return await requestPromise;
    } catch (error) {
      // 에러 발생 시 캐시 정리
      clearCache(cacheKey);
      throw error;
    }
  } else {
    // 캐시 불가능한 요청은 기존 방식대로 처리
    const res = await fetch(url, fetchOptions);
    const contentType = res.headers.get("content-type") || "";
    const body = contentType.includes("application/json") ? await res.json() : await res.text();

    if (!res.ok) {
      const msg =
        typeof body === "object" && body && body.detail
          ? body.detail
          : typeof body === "string"
          ? body
          : JSON.stringify(body);

      const err = new Error(msg);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }
}

function closeEventSource(sourceKey) {
  const src = state[sourceKey];
  if (src) {
    src.close();
    state[sourceKey] = null;
  }
}

function getEventSourceUrl(path) {
  const base = requireApiBase();
  return base ? `${base}${path}` : path;
}

function formatLogTime(tsMs) {
  const d = new Date(Number(tsMs) || Date.now());
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const sec = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${sec}`;
}

function formatLogStage(stage) {
  const key = String(stage || "").toUpperCase();
  const labels = {
    UPLOAD: "업로드",
    PROCESS: "처리",
    OCR: "OCR",
    DOC_FILTER: "문서필터",
    COMPLETE: "완료",
    CANCEL: "취소",
    FAIL: "실패",
  };
  return labels[key] || key || "SYSTEM";
}

function normalizeInterestView(value) {
  const v = String(value || "").toLowerCase();
  if (v === "interest") return "interest";
  if (v === "non_interest") return "non_interest";
  return "all";
}

function inferInterest(file) {
  if (!file) return null;
  if (typeof file.is_interest === "boolean") return file.is_interest;
  return null;
}

function getDocIndexLabel(file) {
  if (!file) return null;
  const docIndex = file.doc_index;
  if (docIndex === undefined || docIndex === null) return null;
  
  const labels = {
    0: "int_ver",
    1: "int_hori",
    2: "no_int_ver",
    3: "no_int_hori"
  };
  return labels[docIndex] || String(docIndex);
}

function sortFilesForView(files) {
  const rows = Array.isArray(files) ? [...files] : [];
  rows.sort((a, b) => {
    const aHasPage = Number(a?.page_no || 0) > 0;
    const bHasPage = Number(b?.page_no || 0) > 0;
    if (aHasPage && bHasPage) return Number(a.page_no || 0) - Number(b.page_no || 0);
    if (aHasPage !== bHasPage) return aHasPage ? -1 : 1;
    return Number(a?.created_ms || 0) - Number(b?.created_ms || 0);
  });
  return rows;
}

function renderPipelinePanel(file, result) {
  const panel = $("pipelinePanel");
  if (!panel) return;

  const debug = result?._debug || {};
  const stages = debug?.stages || file?.stage_stats || {};
  const stageNames = [
    ["doc_filter", "DocFilter"],
    ["yolo", "YOLO"],
    ["ocr", "OCR"],
  ];

  const rows = stageNames
    .map(([key, label]) => {
      const s = stages[key];
      if (!s || typeof s !== "object") {
        return `<div class="hint"><b>${label}</b>: N/A</div>`;
      }
      const status = String(s.status || "n/a");
      const ms = Number(s.elapsed_ms || 0);
      const err = s.error ? ` / ${escapeHtml(String(s.error))}` : "";
      return `<div class="hint"><b>${label}</b>: ${escapeHtml(status)} (${ms}ms)${err}</div>`;
    })
    .join("");

  const failedStage = debug?.failed_stage || Object.entries(stages || {}).find(([_, v]) => String(v?.status || "").toLowerCase() === "error")?.[0] || "N/A";
const interest = inferInterest(file);
const docIndexLabel = getDocIndexLabel(file);
const interestTxt = docIndexLabel || (interest === true || interest === 1 ? "관심"
                : interest === false || interest === 0 ? "비관심"
                : "미정");
  const rotation = file?.rotation || "none";
  const totalMs = Number(debug?.pipeline_elapsed_ms || 0);
  const fallbackUsed = debug?.fallback_used === true ? "yes" : debug?.fallback_used === false ? "no" : "N/A";
  const errorCode = debug?.error_code || "N/A";
  const retryable = typeof debug?.retryable === "boolean" ? String(debug.retryable) : "N/A";

  panel.innerHTML = `
    <div class="hint"><b>분류</b>: ${interestTxt}</div>
    <div class="hint"><b>회전</b>: ${escapeHtml(String(rotation))}</div>
    <div class="hint"><b>총 소요</b>: ${Number.isFinite(totalMs) ? `${totalMs}ms` : "N/A"}</div>
    <div class="hint"><b>실패 단계</b>: ${escapeHtml(String(failedStage || "N/A"))}</div>
    <div class="hint"><b>오류 코드</b>: ${escapeHtml(String(errorCode))}</div>
    <div class="hint"><b>재시도 가능</b>: ${escapeHtml(retryable)}</div>
    <div class="hint"><b>Fallback</b>: ${fallbackUsed}</div>
    ${rows || '<div class="hint">단계 데이터가 없습니다.</div>'}
    ${file?.error ? `<div class="hint"><b>오류</b>: ${escapeHtml(String(file.error))}</div>` : ""}
  `;
}


function renderJobLogs(logs) {
  const el = $("jobLogs");
  if (!el) return;
  const rows = Array.isArray(logs) ? logs : [];
  if (!rows.length) {
    el.innerHTML = `<div class="hint" style="padding:6px;">로그가 없습니다.</div>`;
    return;
  }
  el.innerHTML = rows
    .map((row) => {
      const levelRaw = String(row?.level || "INFO").toLowerCase();
      const level = escapeHtml(levelRaw.toUpperCase());
      const stage = escapeHtml(formatLogStage(row?.stage));
      const message = escapeHtml(String(row?.message || ""));
      const time = escapeHtml(formatLogTime(row?.ts_ms));
      return `
        <div class="jobLogItem">
          <span class="jobLogMeta">
            <span class="jobLogTime">${time}</span>
            <span class="jobLogLevel ${levelRaw}">${level}</span>
            <span class="jobLogStage">${stage}</span>
          </span>
          <span class="jobLogMessage">${message}</span>
        </div>
      `;
    })
    .join("");

  if (state.jobLogsUi?.autoScroll !== false) {
    el.scrollTop = el.scrollHeight;
  }
}

export function startJobsEvents() {
  closeEventSource("jobsEventSource");
  if (state.jobsPollTimer) {
    clearInterval(state.jobsPollTimer);
    state.jobsPollTimer = null;
  }
  const url = getEventSourceUrl("/api/jobs/events");
  const es = new EventSource(url);
  state.jobsEventSource = es;
  
  // ✅ 디바운싱 타이머 추가
  let jobsUpdateDebounceTimer = null;
  
  es.addEventListener("jobs", (event) => {
    try {
      const payload = JSON.parse(event.data || "{}");
      
      // ✅ 디바운싱 적용: 500ms 동안 업데이트가 없으면 한 번만 실행
      if (jobsUpdateDebounceTimer) {
        clearTimeout(jobsUpdateDebounceTimer);
      }
      jobsUpdateDebounceTimer = setTimeout(() => {
        refreshJobsFromPayload(payload).catch(() => {});
        jobsUpdateDebounceTimer = null;
      }, 500);
    } catch (_) {}
  });
  es.addEventListener("error", () => {
    closeEventSource("jobsEventSource");
    if (!state.jobsPollTimer) {
      state.jobsPollTimer = setInterval(() => refreshJobs().catch(() => {}), 5000);
    }
    setTimeout(() => startJobsEvents(), 5000);
  });
}

export function stopJobsEvents() {
  closeEventSource("jobsEventSource");
}

export function startJobEvents(jobId) {
  closeEventSource("jobEventSource");
  if (state.jobDetailTimer) {
    clearInterval(state.jobDetailTimer);
    state.jobDetailTimer = null;
  }
  if (!jobId) return;
  const url = getEventSourceUrl(`/api/jobs/${jobId}/events`);
  const es = new EventSource(url);
  state.jobEventSource = es;
  
  // ✅ 디바운싱 타이머 추가
  let jobDetailUpdateDebounceTimer = null;
  
  es.addEventListener("job", (event) => {
    try {
      const payload = JSON.parse(event.data || "{}");
      
      // ✅ 디바운싱 적용: 300ms 동안 업데이트가 없으면 한 번만 실행
      if (jobDetailUpdateDebounceTimer) {
        clearTimeout(jobDetailUpdateDebounceTimer);
      }
      jobDetailUpdateDebounceTimer = setTimeout(() => {
        updateJobDetailFromPayload(payload).catch(() => {});
        jobDetailUpdateDebounceTimer = null;
      }, 300);
    } catch (_) {}
  });
  es.addEventListener("error", () => {
    closeEventSource("jobEventSource");
    if (!state.jobDetailTimer) {
      state.jobDetailTimer = setInterval(refreshJobDetail, 3000);
    }
    setTimeout(() => startJobEvents(jobId), 5000);
  });
}

export function stopJobEvents() {
  closeEventSource("jobEventSource");
}

export async function refreshSystemLogs() {
  const data = await api("/api/system/logs");
  const logs = Array.isArray(data?.logs) ? data.logs : [];
  state.systemLogsRows = logs;
  renderJobLogs(logs);
  const logsHint = $("jobLogsHint");
  if (logsHint) {
    logsHint.textContent = logs.length
      ? `시스템 로그 ${logs.length}개 수신 완료: 최신`
      : "시스템 작업 로그가 아직 없습니다.";
  }
}

function refreshSystemLogsSafe() {
  return refreshSystemLogs().catch(() => {
    const now = Date.now();
    if (now - systemLogsLastRefreshErrorAt < 5000) return;
    systemLogsLastRefreshErrorAt = now;
    const logsHint = $("jobLogsHint");
    if (logsHint) logsHint.textContent = "시스템 로그 조회 실패 (API 연결/서버 상태 확인 필요)";
  });
}

export function startSystemLogsEvents() {
  closeEventSource("systemLogsEventSource");
  if (state.systemLogsReconnectTimer) {
    clearTimeout(state.systemLogsReconnectTimer);
    state.systemLogsReconnectTimer = null;
  }

  const url = getEventSourceUrl("/api/system/logs/events");
  const es = new EventSource(url);
  state.systemLogsEventSource = es;

  es.addEventListener("open", () => {
    state.systemLogsLastEventTs = Date.now();
    const logsHint = $("jobLogsHint");
    if (logsHint) logsHint.textContent = `시스템 로그 실시간 스트림(SSE) (${url})`;
    // 초기 연결 성공 시 즉시 전체 로그 갱신 요청
    refreshSystemLogsSafe();
  });

  es.addEventListener("ping", () => {
    state.systemLogsLastEventTs = Date.now();
  });

  es.addEventListener("logs", (event) => {
    try {
      state.systemLogsLastEventTs = Date.now();
      const payload = JSON.parse(event.data || "{}");
      const logs = Array.isArray(payload?.logs) ? payload.logs : [];
      if (!logs.length) return;
      const prev = Array.isArray(state.systemLogsRows) ? state.systemLogsRows : [];
      state.systemLogsRows = [...prev, ...logs].slice(-300);
      renderJobLogs(state.systemLogsRows);
      const logsHint = $("jobLogsHint");
      if (logsHint) logsHint.textContent = `시스템 로그 수신 중... (+${logs.length})`;
    } catch (_) {}
  });

  es.addEventListener("error", () => {
    const logsHint = $("jobLogsHint");
    if (logsHint) logsHint.textContent = `시스템 로그 실시간 연결 끊김... (${url})`;
    // EventSource의 자동 재연결 기능이 CONNECTING(0) 상태에서 close를 호출하면
    if (es.readyState === EventSource.CLOSED) {
      closeEventSource("systemLogsEventSource");
      if (!state.systemLogsReconnectTimer) {
        state.systemLogsReconnectTimer = setTimeout(() => {
          state.systemLogsReconnectTimer = null;
          startSystemLogsEvents();
        }, 5000);
      }
    }
  });
}

export function stopSystemLogsEvents() {
  closeEventSource("systemLogsEventSource");
  if (state.systemLogsReconnectTimer) {
    clearTimeout(state.systemLogsReconnectTimer);
    state.systemLogsReconnectTimer = null;
  }
  if (state.systemLogsPollTimer) {
    clearInterval(state.systemLogsPollTimer);
    state.systemLogsPollTimer = null;
  }
  if (state.systemLogsHealthTimer) {
    clearInterval(state.systemLogsHealthTimer);
    state.systemLogsHealthTimer = null;
  }
}

export async function refreshJobs() {
  const data = await api("/api/jobs");
  return refreshJobsFromPayload(data);
}

function confirmHardDelete(targetLabel) {
  const first = confirm(`${targetLabel} 전체를 영구 삭제하시겠습니까? 삭제 후 복구 불가합니다.

계속하시겠습니까?`);
  if (!first) return false;
  return confirm(`최종 확인: ${targetLabel} 전체 삭제를 실행하시겠습니까?
작업 내용도 모두 삭제됩니다.`);
}

function renderJobItem(job, hasDbFiles) {
  const active = state.selectedJobId === job.job_id ? "active" : "";
  const total = job.progress?.total ?? 0;
  const done = job.progress?.done ?? 0;
  const jobName = escapeHtml(job.name || job.kind);
  const dbExistsText = hasDbFiles ? '<span style="color:#fca5a5;"> · DB 존재</span>' : '';
  return `
    <div class="item ${active}" data-job="${job.job_id}">
      <div style="min-width:0; flex:1;">
        <div style="display:flex; align-items:center; gap:6px; min-width:0;">
          <div style="flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${jobName}"><b>${jobName}</b></div>
        </div>
        <div class="hint">${escapeHtml(job.job_id.slice(0, 10))} · ${done}/${total}${dbExistsText}</div>
      </div>
      <div style="display:flex; align-items:center; gap:6px;">
        ${badge(job.status)}
        <button class="btn btn-danger btn-mini" type="button" data-job-delete="${job.job_id}" title="작업 전체 삭제">삭제</button>
      </div>
    </div>
  `;
}

function resetOcrRowCountHint() {
  const hint = $("ocrRowCountHint");
  if (hint) hint.textContent = "행 0개";
}

function clearSelectedFileView(message = "파일을 선택해주세요.") {
  state.selectedFileId = null;
  state.selectedVirtualPageNo = null;
  state.currentFile = null;
  state.currentResult = null;
  state.currentResultFileId = null;
  destroyTabulator("ocr");
  $("previewImg").src = "";
  $("previewImg").dataset.imageUrl = "";
  $("resultTable").innerHTML = "";
  resetOcrRowCountHint();
  $("titleInput").value = "";
  const fileInterestSelect = $("fileInterestSelect");
  if (fileInterestSelect) fileInterestSelect.value = "";
  const fileRotationSelect = $("fileRotationSelect");
  if (fileRotationSelect) fileRotationSelect.value = "";
  const btnApplyOverride = $("btnApplyFileOverride");
  if (btnApplyOverride) btnApplyOverride.disabled = true;
  const btnReprocessOverride = $("btnReprocessWithOverride");
  if (btnReprocessOverride) btnReprocessOverride.disabled = true;
  $("btnSaveEdits").disabled = true;
  $("btnSaveDb").disabled = true;
  $("tableHint").textContent = message;
  renderPipelinePanel(null, null);
}

function clearSelectedJobView() {
  state.selectedJobId = null;
  state._lastFileListSignature = "";
  state._lastSelectedFileSig = "";
  stopJobEvents();
  clearSelectedFileView("작업을 선택해주세요.");
  $("files").innerHTML = `<div class="hint">작업을 선택해주세요.</div>`;
  $("jobStatus").textContent = "작업을 선택해주세요.";
  $("jobProgress").textContent = "";
  const fill = $("jobProgressFill");
  if (fill) fill.style.width = "0%";
  const cancelHint = $("jobCancelHint");
  if (cancelHint) cancelHint.textContent = "";
  const btnCancel = $("btnCancelJob");
  if (btnCancel) btnCancel.disabled = true;
  const btnRetry = $("btnRetryJob");
  if (btnRetry) btnRetry.disabled = true;
}

export async function deleteSelectedJob(jobId) {
  if (!jobId) return;
  const ok = confirmHardDelete("작업");
  if (!ok) return;
  await api(`/api/jobs/${jobId}`, { method: "DELETE" });
  delete state.jobsDbCache[jobId];
  if (state.selectedJobId === jobId) {
    clearSelectedJobView();
    // ✅ 삭제된 작업 ID를 localStorage에서도 제거
    try {
      localStorage.removeItem("ocr_ui_selected_job_id");
    } catch (e) {
      console.warn("Failed to remove selected job ID from localStorage:", e);
    }
  }
  await refreshJobs();
}

export async function deleteSelectedFile(fileId) {
  if (!fileId) return;
  
  // 현재 파일 정보 확인
  const currentFile = state.currentFile;
  const isPdfPage = currentFile && currentFile.kind === "pdf_page";
  
  // PDF 페이지인 경우 비관심으로 변경, 아닌 경우 전체 삭제
  if (isPdfPage) {
    const ok = confirm("이 페이지를 비관심으로 변경하시겠습니까?\n\n- OCR 처리가 취소됩니다.\n- DB 데이터가 삭제됩니다.\n- 이미지는 계속 표시됩니다.\n- 상태는 '알았음'으로 변경됩니다.");
    if (!ok) return;
    
    try {
      // 비관심으로 변경 API 호출
      await api(`/api/files/${fileId}/mark_non_interest`, { method: "POST" });
      
      // 캐시 정리
      delete state.fileDbCache[fileId];
      Object.keys(state.jobsDbCache || {}).forEach((k) => delete state.jobsDbCache[k]);
      
      // ✅ 파일 리스트 시그니처 초기화 (강제 리렌더링 보장)
      state._lastFileListSignature = "";
      state._lastSelectedFileSig = "";
      
      // 현재 결과 메모리 정리 (테이블 표시 제거)
      if (state.selectedFileId === fileId) {
        state.currentResult = null;
        state.currentResultFileId = null;
        clearSelectedFileView("페이지가 비관심으로 변경되었습니다.");
      }
      
      // ✅ 항상 작업 상세 갱신 (사이드바 갱신 보장)
      if (state.selectedJobId) {
        await refreshJobDetail().catch(() => {
          if (state.selectedFileId === fileId) clearSelectedFileView("파일을 선택해주세요.");
        });
      }
      
      // ✅ 파일 삭제 후 포커스 복원 (팝업 열려있을 때도 방향키 동작 보장)
      setTimeout(() => {
        const filesContainer = $("files");
        if (filesContainer) {
          // 파일 컨테이너에 포커스를 주어 방향키 이벤트가 정상적으로 동작하도록 함
          filesContainer.focus({ preventScroll: true });
        }
      }, 100);
      
      alert("페이지가 비관심으로 변경되었습니다.");
    } catch (e) {
      alert(`비관심 변경 실패: ${e.message}`);
    }
  } else {
    // 일반 파일은 전체 삭제
    const ok = confirmHardDelete("파일");
    if (!ok) return;
    
    try {
      // 파일 삭제 API 호출 (DB 데이터도 함께 삭제됨)
      await api(`/api/files/${fileId}`, { method: "DELETE" });
      
      // 캐시 정리
      delete state.fileDbCache[fileId];
      Object.keys(state.jobsDbCache || {}).forEach((k) => delete state.jobsDbCache[k]);
      
      // ✅ 파일 리스트 시그니처 초기화 (강제 리렌더링 보장)
      state._lastFileListSignature = "";
      state._lastSelectedFileSig = "";
      
      // 현재 결과 메모리 정리 (테이블 표시 제거)
      if (state.selectedFileId === fileId) {
        state.currentResult = null;
        state.currentResultFileId = null;
        clearSelectedFileView("선택한 파일이 전체 삭제되었습니다.");
      }

      // ✅ 항상 작업 상세 갱신 (사이드바 갱신 보장)
      if (state.selectedJobId) {
        await refreshJobDetail().catch(() => {
          if (state.selectedFileId === fileId) clearSelectedFileView("파일을 선택해주세요.");
        });
      }
      
      // ✅ 파일 삭제 후 포커스 복원 (팝업 열려있을 때도 방향키 동작 보장)
      setTimeout(() => {
        const filesContainer = $("files");
        if (filesContainer) {
          // 파일 컨테이너에 포커스를 주어 방향키 이벤트가 정상적으로 동작하도록 함
          filesContainer.focus({ preventScroll: true });
        }
      }, 100);
      
      alert("파일이 전체 삭제되었습니다. DB 데이터도 함께 삭제되었습니다.");
    } catch (e) {
      alert(`파일 삭제 실패: ${e.message}`);
    }
  }
}

export async function markFileAsDone(fileId) {
  if (!fileId) return;
  
  const ok = confirm("이 파일을 완료 상태로 변경하시겠습니까?\n\n참고: 작업 내용은 변경되지 않습니다.");
  if (!ok) return;
  
  try {
    await api(`/api/files/${fileId}/mark_done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "수동 완료" })
    });
    
    alert("파일이 완료 상태로 변경되었습니다.");
    await refreshJobDetail();
  } catch (e) {
    alert(`변경 실패: ${e.message}`);
  }
}

async function refreshJobsFromPayload(data) {
  const jobsRaw = (data && data.jobs) || [];
  const statusFilter = (state.jobsUi?.status || "all").toLowerCase();
  const q = (state.jobsUi?.q || "").trim().toLowerCase();
  const jobs = (jobsRaw || []).filter((j) => {
    if (!j) return false;
    if (statusFilter !== "all" && String(j.status || "").toLowerCase() !== statusFilter) return false;
    if (!q) return true;
    const hay = `${j.name || j.kind || ""} ${j.kind || ""} ${j.job_id || ""}`.toLowerCase();
    return hay.includes(q);
  });
  const el = $("jobs");
  if (!jobs.length) {
    el.innerHTML = `<div class="hint">현재 진행 중인 작업이 없습니다.</div>`;
    return;
  }

  // ✅ DB 존재 여부 확인 제거 (성능 최적화)
  const jobItems = jobs.map((j) => ({
    html: renderJobItem(j, false),
    jobId: j.job_id,
  }));
  el.innerHTML = jobItems.map((item) => item.html).join("");

  [...el.querySelectorAll("[data-job]")].forEach((node) => {
    node.addEventListener("click", () => selectJob(node.getAttribute("data-job")));
  });
  [...el.querySelectorAll("[data-job-delete]")].forEach((node) => {
    node.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSelectedJob(node.getAttribute("data-job-delete")).catch((err) => alert(err.message));
    });
  });

  return jobs;
}

function updateJobListItem(job) {
  if (!job?.job_id) return;
  const list = $("jobs");
  if (!list) return;
  const node = list.querySelector(`[data-job="${job.job_id}"]`);
  if (!node) return;

  const cached = state.jobsDbCache[job.job_id];
  const hasDbFiles = cached ? cached.hasDbFiles : node.classList.contains("exists-in-db");
  node.outerHTML = renderJobItem(job, hasDbFiles);
  const nextNode = list.querySelector(`[data-job="${job.job_id}"]`);
  if (!nextNode) return;
  nextNode.addEventListener("click", () => selectJob(nextNode.getAttribute("data-job")));
  const deleteBtn = nextNode.querySelector("[data-job-delete]");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSelectedJob(deleteBtn.getAttribute("data-job-delete")).catch((err) => alert(err.message));
    });
  }
}

async function getJobDbStatus(job) {
  const jobId = job?.job_id;
  if (!jobId) return false;
  const status = String(job?.status || "").toLowerCase();
  const total = Number(job?.progress?.total ?? 0);
  const done = Number(job?.progress?.done ?? 0);
  const cached = state.jobsDbCache[jobId];
  const now = Date.now();

  if (cached?.inflight) return cached.hasDbFiles || false;

  // ✅ 캐시가 없거나 30초 이상 지난 경우 항상 DB 조회 (캐시 초기화 후 즉시 반영)
  const shouldRefresh = !cached || (now - (cached.checkedAt || 0) > 30000);
  
  // 완료 상태가 아닌 경우 캐시 사용 (단, 캐시가 없으면 DB 조회)
  if (status !== "done" && done < total) {
    if (shouldRefresh) {
      // 캐시가 없거나 오래된 경우 DB 조회 수행
      state.jobsDbCache[jobId] = {
        ...(cached || {}),
        hasDbFiles: cached?.hasDbFiles || false,
        checkedAt: now,
        checkedDone: cached?.checkedDone,
        inflight: true,
      };
    } else {
      return cached ? cached.hasDbFiles : false;
    }
  }

  // 완료된 작업은 30초마다 DB 존재 여부 확인
  if (cached && !shouldRefresh && cached.checkedDone === done) {
    return cached.hasDbFiles;
  }

  state.jobsDbCache[jobId] = {
    ...(cached || {}),
    hasDbFiles: cached?.hasDbFiles || false,
    checkedAt: now,
    checkedDone: cached?.checkedDone,
    inflight: true,
  };

  let hasDbFiles = false;
  try {
    const jobDetail = await api(`/api/jobs/${jobId}`).catch(() => ({ files: [] }));
    const files = jobDetail.files || [];
    if (files.length > 0) {
      const doneFiles = files.filter((f) => f && f.status === "done" && f.file_id);
      if (doneFiles.length > 0) {
        // 배치 API 사용: 여러 파일의 DB 존재 여부를 한 번에 조회
        const fileIds = doneFiles.slice(0, 3).map((f) => f.file_id);
        const batchResult = await api(`/api/files/check_db_batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(fileIds)  // 배열 형태로 전송
        }).catch(() => ({ results: {} }));
        
        const results = batchResult.results || {};
        hasDbFiles = Object.values(results).some((r) => r.exists);
      }
    }
  } catch (e) {
    // 오류 무시
  }

  state.jobsDbCache[jobId] = {
    hasDbFiles,
    checkedAt: now,
    checkedDone: done,
    inflight: false,
  };
  return hasDbFiles;
}

async function getFileDbStatus(file) {
  const fileId = file?.file_id;
  if (!fileId) return false;
  const cached = state.fileDbCache[fileId];
  if (cached?.inflight) return cached.exists || false;

  // done 상태가 아닌 파일은 DB 조회 시도하지 않음
  if (file?.status !== "done") {
    return cached ? cached.exists : false;
  }

  // 완료된 파일은 캐시된 결과 사용
  if (cached && cached.checkedDone) return cached.exists;

  state.fileDbCache[fileId] = {
    ...(cached || {}),
    exists: cached?.exists || false,
    checkedAt: Date.now(),
    checkedDone: cached?.checkedDone || false,
    inflight: true,
  };

  let exists = false;
  try {
    const checkData = await api(`/api/files/${fileId}/check_db`).catch(() => ({ exists: false }));
    exists = checkData.exists || false;
  } catch (e) {
    // 오류 무시
  }
  state.fileDbCache[fileId] = { exists, checkedAt: Date.now(), checkedDone: true, inflight: false };
  return exists;
}

export async function selectJob(jobId) {
  await autoSaveEdits("job");
  state.selectedJobId = jobId;
  state.selectedFileId = null;
  state.selectedVirtualPageNo = null;
  state.currentResult = null;
  state.currentResultFileId = null;
  $("previewImg").src = "";
  $("resultTable").innerHTML = "";
  resetOcrRowCountHint();
  $("titleInput").value = "";
  $("btnSaveEdits").disabled = true;
  $("btnSaveDb").disabled = true;
  const cancelHint = $("jobCancelHint");
  if (cancelHint) cancelHint.textContent = "";
  const btnCancel = $("btnCancelJob");
  if (btnCancel) btnCancel.disabled = true;
  const btnRetry = $("btnRetryJob");
  if (btnRetry) btnRetry.disabled = true;
  const logsHint = $("jobLogsHint");
  if (logsHint) logsHint.textContent = "시스템 로그를 불러오는 중...";

  const jobsEl = $("jobs");
  if (jobsEl) {
    [...jobsEl.querySelectorAll("[data-job]")].forEach((n) =>
      n.classList.toggle("active", n.getAttribute("data-job") === jobId)
    );
  }

  // 선택된 작업 ID를 localStorage에 저장
  try {
    localStorage.setItem("ocr_ui_selected_job_id", jobId);
  } catch (e) {
    console.warn("Failed to save selected job ID:", e);
  }

  const detail = await refreshJobDetail();
  const files = detail?.files || [];

  if (state.jobDetailTimer) clearInterval(state.jobDetailTimer);
  startJobEvents(jobId);
}

export async function refreshJobDetail() {
  if (!state.selectedJobId) return;
  try {
    const data = await api(`/api/jobs/${state.selectedJobId}`);
    // 작업 상세 데이터를 캐시에 저장
    if (!state.jobsDbCache[state.selectedJobId]) {
      state.jobsDbCache[state.selectedJobId] = {};
    }
    state.jobsDbCache[state.selectedJobId].jobDetail = data;
    await updateJobDetailFromPayload(data);
    return data;
  } catch (e) {
    // ✅ 작업을 찾을 수 없는 경우 (삭제된 작업)
    if (e.status === 404 || (e.body && e.body.error_code === "JOB_NOT_FOUND")) {
      console.warn("Job not found, clearing selection:", state.selectedJobId);
      clearSelectedJobView();
      // ✅ 삭제된 작업 ID를 localStorage에서도 제거
      try {
        localStorage.removeItem("ocr_ui_selected_job_id");
      } catch (err) {
        console.warn("Failed to remove selected job ID from localStorage:", err);
      }
      // ✅ 작업 목록 갱신
      await refreshJobs().catch(() => {});
      return null;
    }
    // 다른 에러는 그대로 던짐
    throw e;
  }
}

export async function updateJobDetailFromPayload(data) {
  if (!data || !data.job) return;
  const job = data.job;
  const files = sortFilesForView(data.files || []);
  
  // ✅ 파일 상태가 "done"으로 변경되었는지 확인 (이전 상태와 비교)
  // currentFile 업데이트 전에 이전 상태 저장
  const previousStatus = state.currentFile?.status;
  const updatedFile = files.find((f) => f && f.file_id === state.selectedFileId);
  const currentStatus = updatedFile?.status;
  const statusChangedToDone = previousStatus !== "done" && currentStatus === "done";
  
  // ✅ SSE 이벤트로 파일 상태가 변경되면 currentFile도 업데이트
  if (updatedFile) {
    state.currentFile = updatedFile;
  }
  
  // ✅ 디바운싱 타이머 추가 (파일 리스트 업데이트 최적화)
  if (!state._jobDetailUpdateDebounceTimer) {
    state._jobDetailUpdateDebounceTimer = null;
  }

  const total = job.progress?.total ?? 0;
  const done = job.progress?.done ?? 0;
  const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;

  $("jobStatus").textContent = `상태: ${job.status}${job.error ? " · " + job.error : ""}`;
  const ocrTotal = job.progress?.ocr_total ?? 0;
  const ocrDone = job.progress?.ocr_done ?? 0;
  $("jobProgress").textContent = total
    ? `${done}/${total}${ocrTotal ? ` · OCR ${ocrDone}/${ocrTotal}` : ""}`
    : "";
  const fill = $("jobProgressFill");
  if (fill) fill.style.width = `${pct}%`;

  const btnCancel = $("btnCancelJob");
  const btnRetry = $("btnRetryJob");
  const btnMarkDone = $("btnMarkJobDone");
  if (btnCancel) {
    const canCancel = job && (job.status === "queued" || job.status === "processing" || job.status === "paused");
    btnCancel.disabled = !canCancel;
  }
  if (btnMarkDone) {
    // 모든 상태에서 완료 가능 (done 상태 제외)
    const canMarkDone = job && job.status !== "done";
    btnMarkDone.disabled = !canMarkDone;
  }
  if (btnRetry) {
    const hasSelectedItem = Boolean(state.selectedFileId) || Number(state.selectedVirtualPageNo || 0) > 0;
    const canRetry = hasSelectedItem || (job && (job.status === "error" || job.status === "cancelled" || job.status === "done"));
    btnRetry.disabled = !canRetry;

    // 선택된 항목에 따라 버튼 텍스트 변경
    if (Number(state.selectedVirtualPageNo || 0) > 0) {
      const pageNo = Number(state.selectedVirtualPageNo || 0);
      btnRetry.textContent = "선택 페이지 재처리";
    } else if (state.selectedFileId) {
      const file = state.currentFile;
      const fileName = file?.original_name || "선택한 파일";
      btnRetry.textContent = "선택 파일 재처리";
    } else {
      btnRetry.textContent = "전체 재처리";
    }
  }

  updateJobListItem(job);

  const list = $("files");
  const fileSignature = files
    .filter((f) => f && f.file_id)
    .map((f) => `${f.file_id}:${f.status}:${f.original_name || ""}`)
    .join("|");
  const selectedFileSig = state.selectedFileId || "";
  const shouldRenderFiles = state._lastFileListSignature !== fileSignature || state._lastSelectedFileSig !== selectedFileSig;

  // ✅ 항상 현재 선택된 파일의 최신 데이터를 currentFile에 업데이트
  // (검색 필터 변경 시 캐시된 데이터로 돌아가는 문제 방지)
  if (state.selectedFileId) {
    const latestFile = files.find((f) => f && f.file_id === state.selectedFileId);
    if (latestFile) {
      state.currentFile = latestFile;
    }
  }

  if (shouldRenderFiles) {
    state._lastFileListSignature = fileSignature;
    state._lastSelectedFileSig = selectedFileSig;
    if (!files.length) {
      list.innerHTML = `<div class="hint">파일이 없습니다.</div>`;
    } else {
      // ✅ 배치 DB 조회 최적화: 재처리 직후 5초 이내면 스킵
      const shouldSkipDbCheck = state._lastReprocessTime && 
                               (Date.now() - state._lastReprocessTime < 5000);
      
      // 배치 API 사용: 모든 파일의 DB 존재 여부를 한 번에 조회
      const doneFiles = files.filter((f) => f && f.file_id && f.status === "done");
      let dbResults = {};
      
      if (doneFiles.length > 0 && !shouldSkipDbCheck) {
        const fileIds = doneFiles.map((f) => f.file_id);
        try {
          const batchResult = await api(`/api/files/check_db_batch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(fileIds)  // 배열 형태로 전송
          });
          dbResults = batchResult.results || {};
        } catch (e) {
          console.warn("배치 DB 조회 실패:", e);
        }
      }
      
      const viewMode = normalizeInterestView(state.jobsUi?.fileView || "all");
      const fileQuery = getFileQuery();
      const filteredFiles = files.filter((f) => {
        if (!f || !f.file_id) return false;
        const interest = inferInterest(f);
        if (viewMode === "interest") return interest === true;
        if (viewMode === "non_interest") return interest === false;
        
        // 파일명 검색
        if (fileQuery.q) {
          const fileName = (f.original_name || "").toLowerCase();
          if (!fileName.includes(fileQuery.q.toLowerCase())) return false;
        }
        
        // 페이지 번호 검색
        if (fileQuery.page_q) {
          const pageNo = Number(f.page_no || 0);
          const searchPageNo = Number(fileQuery.page_q);
          if (pageNo !== searchPageNo) return false;
        }
        
        return true;
      });
      const fileItems = filteredFiles.map((f) => {
        // 캐시된 결과 사용
        const cached = state.fileDbCache[f.file_id];
        const dbExists = (f.status === "done" && dbResults[f.file_id]?.exists) || (cached?.exists && f.status === "done") || false;
        
        const active = (state.selectedFileId === f.file_id || (f.virtual && state.selectedVirtualPageNo === Number(f.page_no || 0))) ? "active" : "";
        const existsClass = dbExists ? "exists-in-db" : "";
        
        // 상태에 따른 스타일 클래스 추가
        let statusClass = "";
        if (f.status === "error") {
          statusClass = "error-status";
        } else if (f.status === "processing") {
          statusClass = "processing-status";
        } else if (f.status === "queued") {
          statusClass = "queued-status";
        }
        
        const fileName = escapeHtml(f.original_name);
        const interest = inferInterest(f);
        const interestBadge =
          interest === true
            ? '<span class="badge ok">관심</span>'
            : interest === false
              ? '<span class="badge">비관심</span>'
              : '<span class="badge">미정</span>';
        
        // 파일명이 길면 앞부분 자르고 뒷부분 표시
        let displayFileName = fileName;
        if (fileName.length > 30) {
          displayFileName = "..." + fileName.slice(-27);
        }
        
        return {
          html: `
              <div class="item ${active} ${existsClass} ${statusClass}" data-file="${f.file_id}" tabindex="0">
                <div style="min-width:0; flex:1;">
                  <div style="display:flex; align-items:center; gap:6px; min-width:0;">
                    <div style="flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${fileName}"><b>${displayFileName}</b></div>
                  </div>
                  <div class="hint" style="display:flex; align-items:center; justify-content:space-between;">
                    <span>${escapeHtml(f.kind)}</span>
                    ${dbExists ? '<span style="color:#fca5a5; font-size:11px; flex-shrink:0;">(DB 존재)</span>' : ""}
                  </div>
                </div>
                <div style="display:flex; align-items:center; gap:6px;">
                  <span class="badge badge-reprocess" data-file-reprocess="${f.file_id}" style="cursor:pointer; background:color-mix(in srgb, var(--primary) 15%, var(--panel)); border-color:color-mix(in srgb, var(--primary) 42%, transparent); color:color-mix(in srgb, var(--primary) 80%, var(--text));">재처리</span>
                  ${interestBadge}
                  ${badge(f.status)}
                  ${f.virtual ? "" : `<button class="btn btn-danger btn-mini" type="button" data-file-delete="${f.file_id}" title="파일 전체 삭제">삭제</button>`}
                </div>
              </div>
            `,
          fileId: f.file_id,
        };
      });
      list.innerHTML = fileItems.map((item) => item.html).join("");
      
      // ✅ 파일 리스트가 렌더링될 때만 이벤트 리스너 등록
      // DOM이 완전히 렌더링된 후에 이벤트 리스너를 등록하여 안정성 확보
      [...list.querySelectorAll("[data-file]")].forEach((node) => {
        // 기존 이벤트 리스너 제거 (중복 등록 방지)
        node.removeEventListener("click", node._fileClickHandler);
        
        // 새로운 이벤트 리스너 생성 및 저장
        node._fileClickHandler = async () => {
          const fileId = node.getAttribute("data-file");
          
          // ✅ 파일 전환 전 저장
          if (fileId !== state.selectedFileId && state.currentResult) {
            try {
              await saveCurrentEdits({ silent: true, reason: "file_click" });
            } catch (e) {
              console.warn("파일 클릭 전 저장 실패:", e);
            }
          }
          
          if (String(fileId || "").startsWith("virtual:")) {
            const parts = String(fileId).split(":");
            await selectVirtualPage(Number(parts[2] || 0));
            return;
          }
          await selectFile(fileId);
        };
        
        node.addEventListener("click", node._fileClickHandler);
      });
      
      // ✅ 재처리 뱃지 클릭 이벤트 추가
      [...list.querySelectorAll("[data-file-reprocess]")].forEach((reprocessBadge) => {
        // 기존 이벤트 리스너 제거 (중복 등록 방지)
        reprocessBadge.removeEventListener("click", reprocessBadge._reprocessHandler);
        
        // 재처리 핸들러 - 비관심이면 자동으로 관심으로 변경 후 재처리
        reprocessBadge._reprocessHandler = async (e) => {
          e.stopPropagation(); // 파일 카드 클릭 이벤트 전파 방지
          
          const fileId = reprocessBadge.getAttribute("data-file-reprocess");
          if (!fileId) return;
          
          try {
            // ✅ 해당 파일을 먼저 선택 (state.currentFile 업데이트)
            await selectFile(fileId);
            
            // ✅ 현재 관심 상태 확인
            const currentInterest = inferInterest(state.currentFile);
            
            // ✅ 비관심 상태이면 자동으로 관심으로 변경
            if (currentInterest === false) {
              const fileInterestSelect = $("fileInterestSelect");
              if (fileInterestSelect) {
                fileInterestSelect.value = "interest";
              }
              
              // 관심 상태 변경 API 호출
              await api(`/api/files/${fileId}/override`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  reprocess: false,
                  is_interest: true
                }),
              });
              
              // state.currentFile 업데이트
              if (state.currentFile) {
                state.currentFile.is_interest = true;
              }
            }
            
            // ✅ 재처리 수행 (현재 관심/회전 상태로)
            await applySelectedFileOverride(true);
            
            // ✅ 재처리 시간 기록 (배치 DB 조회 스킵용)
            state._lastReprocessTime = Date.now();
          } catch (e) {
            console.error("재처리 실패:", e);
            alert(`재처리 실패: ${e.message}`);
          }
        };
        
        reprocessBadge.addEventListener("click", reprocessBadge._reprocessHandler);
      });
      
      // ✅ 관심 뱃지 클릭 이벤트 추가 (토글 기능)
      [...list.querySelectorAll("[data-file] .badge")].forEach((badge) => {
        // "관심" 또는 "비관심" 텍스트를 가진 뱃지만 선택
        const badgeText = badge.textContent.trim();
        if (badgeText !== "관심" && badgeText !== "비관심") return;
        
        // 기존 이벤트 리스너 제거 (중복 등록 방지)
        badge.removeEventListener("click", badge._interestToggleHandler);
        
        // 관심 뱃지 토글 핸들러
        badge._interestToggleHandler = async (e) => {
          e.stopPropagation(); // 파일 카드 클릭 이벤트 전파 방지
          
          const fileNode = badge.closest("[data-file]");
          if (!fileNode) return;
          
          const fileId = fileNode.getAttribute("data-file");
          if (!fileId) return;
          
          try {
            // 캐시된 작업 데이터에서 해당 파일 정보 찾기
            const cached = state.jobsDbCache[state.selectedJobId];
            let file = null;
            
            if (cached && cached.jobDetail) {
              const allFiles = sortFilesForView(cached.jobDetail.files || []);
              file = allFiles.find((f) => f && f.file_id === fileId);
            }
            
            if (!file) {
              alert("파일 정보를 찾을 수 없습니다.");
              return;
            }
            
            // 현재 관심 상태 확인
            const currentInterest = inferInterest(file);
            const newInterest = !currentInterest; // 토글
            
            // ✅ 즉시 뱃지 상태 변경 (UI 피드백)
            const newBadgeText = newInterest ? "관심" : "비관심";
            const newBadgeClass = newInterest ? "ok" : "";
            badge.textContent = newBadgeText;
            badge.className = `badge ${newBadgeClass}`;
            
            // ✅ 메인 콘텐츠의 fileInterestSelect 드롭다운도 업데이트
            const fileInterestSelect = $("fileInterestSelect");
            if (fileInterestSelect) {
              if (newInterest === true) {
                fileInterestSelect.value = "interest";
              } else if (newInterest === false) {
                fileInterestSelect.value = "non_interest";
              } else {
                fileInterestSelect.value = "";
              }
            }
            
            // API 호출하여 관심 상태 변경
            const payload = {
              reprocess: false,
              is_interest: newInterest
            };
            
            await api(`/api/files/${fileId}/override`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
            
            // 작업 상세 갱신 (서버 데이터와 동기화)
            await refreshJobDetail();
          } catch (e) {
            console.error("관심 상태 변경 실패:", e);
            alert(`관심 상태 변경 실패: ${e.message}`);
            
            // 에러 발생 시 원래 상태로 복원
            const originalInterest = inferInterest(file);
            const originalBadgeText = originalInterest ? "관심" : "비관심";
            const originalBadgeClass = originalInterest ? "ok" : "";
            badge.textContent = originalBadgeText;
            badge.className = `badge ${originalBadgeClass}`;
          }
        };
        
        badge.addEventListener("click", badge._interestToggleHandler);
      });
      
      [...list.querySelectorAll("[data-file-delete]")].forEach((node) => {
        // 기존 이벤트 리스너 제거 (중복 등록 방지)
        node.removeEventListener("click", node._fileDeleteHandler);
        
        // 새로운 이벤트 리스너 생성 및 저장
        node._fileDeleteHandler = (e) => {
          e.stopPropagation();
          deleteSelectedFile(node.getAttribute("data-file-delete")).catch((err) => alert(err.message));
        };
        
        node.addEventListener("click", node._fileDeleteHandler);
      });
    }

    requestAnimationFrame(() => {
      const activeNode = state.selectedFileId
        ? list.querySelector(`[data-file="${CSS.escape(state.selectedFileId)}"]`)
        : null;
      if (activeNode) {
        activeNode.scrollIntoView({ behavior: "auto", block: "nearest" });
        return;
      }

      const savedScroll = Number(localStorage.getItem("ocr_ui_file_list_scroll_top") || 0);
      if (Number.isFinite(savedScroll) && savedScroll >= 0) {
        list.scrollTop = savedScroll;
      }
    });
  }

  // ✅ 파일 상태가 "done"으로 변경되었거나, 이미 "done" 상태인데 결과가 없는 경우 결과 로드
  if (state.selectedFileId && state.currentFile?.status === "done") {
    // 상태가 "done"으로 변경되었거나, 결과가 아직 로드되지 않은 경우
    const shouldLoadResult = statusChangedToDone || 
                            (!state.currentResult || state.currentResultFileId !== state.selectedFileId);
    
    if (shouldLoadResult && !state.loadingFileResult) {
      console.log("Loading file result - status changed to done or result not loaded:", state.selectedFileId);
      try {
        // ✅ 직접 result API 호출 (loadSelectedFileResult 함수 사용)
        await loadSelectedFileResult(state.selectedFileId);
      } catch (e) {
        console.error("Failed to load file result:", e);
        // 결과 로드 실패해도 에러를 던지지 않음 (사이드바 업데이트는 계속 진행)
      }
    }
  }
}

async function selectVirtualPage(pageNo) {
  if (!Number(pageNo)) return;
  state.selectedVirtualPageNo = Number(pageNo);
  state.selectedFileId = null;
  state.currentFile = null;
  state.currentResult = null;
  state.currentResultFileId = null;
  $("previewImg").src = "";
  $("previewImg").dataset.imageUrl = "";
  $("resultTable").innerHTML = "";
  resetOcrRowCountHint();
  $("titleInput").value = "";
  const fileInterestSelect = $("fileInterestSelect");
  if (fileInterestSelect) fileInterestSelect.value = "";
  const fileRotationSelect = $("fileRotationSelect");
  if (fileRotationSelect) fileRotationSelect.value = "";
  const btnApplyOverride = $("btnApplyFileOverride");
  if (btnApplyOverride) btnApplyOverride.disabled = false;
  const btnReprocessOverride = $("btnReprocessWithOverride");
  if (btnReprocessOverride) btnReprocessOverride.disabled = false;
  $("btnSaveEdits").disabled = true;
  $("btnSaveDb").disabled = true;
  $("tableHint").textContent = `PDF ${pageNo}페이지를 선택했습니다. 상단에서 관심/회전 값을 적용하거나 재처리할 수 있습니다.`;
  renderPipelinePanel(null, null);
  await refreshJobDetail();
}

export async function cancelSelectedJob() {
  if (!state.selectedJobId) return;
  const ok = confirm("현재 작업을 취소하시겠습니까? (실행 중인 처리는 중단되고 완료된 결과는 유지됩니다. 취소 후 결과를 확인하세요.)");
  if (!ok) return;
  await api(`/api/jobs/${state.selectedJobId}/cancel`, { method: "POST" });
  await refreshJobDetail();
}

export async function retrySelectedJob() {
  if (!state.selectedJobId) return;

  let body = {};
  let confirmMsg = "";

  if (Number(state.selectedVirtualPageNo || 0) > 0) {
    const pageNo = Number(state.selectedVirtualPageNo || 0);
    body = { scope: "page", page_no: pageNo };
    confirmMsg = `선택한 PDF ${pageNo}페이지를 재처리하시겠습니까?`;
  } else if (state.selectedFileId) {
    const file = state.currentFile;
    const fileName = file?.original_name || "선택한 파일";
    body = { scope: "file", file_id: state.selectedFileId };
    confirmMsg = `${fileName}을(를) 재처리하시겠습니까?`;
  } else {
    body = { scope: "job" };
    confirmMsg = "완료된 파일을 포함하여 전체를 재처리하시겠습니까?";
  }

  const ok = confirm(confirmMsg);
  if (!ok) return;

  await api(`/api/jobs/${state.selectedJobId}/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await refreshJobDetail();
}

export async function markJobAsDone() {
  if (!state.selectedJobId) return;
  
  const ok = confirm("이 작업을 완료 상태로 변경하시겠습니까?\n\n참고: 작업 내용은 변경되지 않습니다.");
  if (!ok) return;
  
  try {
    await api(`/api/jobs/${state.selectedJobId}/mark_done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "수동 완료" })
    });
    
    alert("작업이 완료 상태로 변경되었습니다.");
    await refreshJobDetail();
  } catch (e) {
    alert(`변경 실패: ${e.message}`);
  }
}

export function setTab(tab) {
  if (state.ui.tab === "ocr" && tab !== "ocr") {
    autoSaveEdits("tab").catch(() => {});
  }
  state.ui.tab = tab;
  
  // 탭 상태를 localStorage에 저장
  try {
    localStorage.setItem("ocr_ui_active_tab", tab);
  } catch (e) {
    console.warn("Failed to save tab state:", e);
  }
  
  const classification = $("screenClassification");
  const ocr = $("screenOcr");
  const db = $("screenDb");
  const tClassification = $("tabClassification");
  const tOcr = $("tabOcr");
  const tDb = $("tabDb");
  
  // 모든 화면 숨기기
  if (classification) classification.classList.add("hidden");
  if (ocr) ocr.classList.add("hidden");
  if (db) db.classList.add("hidden");
  
  // 모든 탭 비활성화
  if (tClassification) tClassification.classList.remove("active");
  if (tOcr) tOcr.classList.remove("active");
  if (tDb) tDb.classList.remove("active");
  
  // 선택된 탭 활성화
  if (tab === "classification") {
    if (classification) classification.classList.remove("hidden");
    if (tClassification) tClassification.classList.add("active");
    // 분류 페이지 초기화는 classification.js에서 처리
  } else if (tab === "db") {
    if (db) db.classList.remove("hidden");
    if (tDb) tDb.classList.add("active");
    initDbScreen().catch((e) => alert(e.message));
  } else {
    // ocr (기본)
    if (ocr) ocr.classList.remove("hidden");
    if (tOcr) tOcr.classList.add("active");
  }
}

// 초기화 시 기본 탭(OCR)만 보이도록 설정
export function initTabs() {
  const classification = $("screenClassification");
  const ocr = $("screenOcr");
  const db = $("screenDb");
  
  // 분류와 DB 화면은 숨기기
  if (classification) classification.classList.add("hidden");
  if (db) db.classList.add("hidden");
  
  // OCR 화면만 보이기
  if (ocr) ocr.classList.remove("hidden");
}

export async function selectFile(fileId) {
  // ✅ 파일 전환 전에 현재 테이블 상태 저장 (안정성 보장)
  if (fileId !== state.selectedFileId && state.currentResult) {
    try {
      await saveCurrentEdits({ silent: true, reason: "file_change" });
    } catch (e) {
      console.warn("파일 변경 전 자동 저장 실패:", e);
    }
  }
  
  state.selectedFileId = fileId;
  state.selectedVirtualPageNo = null;
  // ✅ currentResult는 새 파일 결과 로드 후에만 null로 설정 (데이터 사라짐 방지)
  // state.currentResult = null;
  // state.currentResultFileId = null;
  
  // ✅ 파일 전환 시 테이블 상태 초기화 (열 이름 번호가 파일 간에 공유되는 문제 해결)
  state.tableEdit.ocr.columns = [];
  state.tableEdit.ocr.selectedRow = null;
  state.tableEdit.ocr.selectedCol = null;
  
  // ✅ 비동기로 Tabulator 파괴 (UI 차단 방지)
  import("./table_tabulator.js").then(({ destroyTabulator }) => {
    destroyTabulator("ocr");
  }).catch((e) => console.warn("Failed to destroy tabulator:", e));
  
  $("btnSaveEdits").disabled = true;
  $("btnSaveDb").disabled = true;
  
  // 선택된 파일 ID를 localStorage에 저장
  try {
    localStorage.setItem("ocr_ui_selected_file_id", fileId);
  } catch (e) {
    console.warn("Failed to save selected file ID:", e);
  }
  
  // 캐시된 작업 데이터에서 파일 정보 가져오기 (불필요한 API 호출 방지)
  const cached = state.jobsDbCache[state.selectedJobId];
  if (cached && cached.jobDetail) {
    const files = sortFilesForView(cached.jobDetail.files || []);
    const foundFile = files.find((f) => f && f.file_id === fileId);
    if (foundFile) {
      state.currentFile = foundFile;
    } else {
      // 캐시에서 파일을 찾지 못하면 서버에서 작업 상세를 다시 가져옴
      console.log("File not found in cache, refreshing job detail...");
      try {
        const jobDetail = await api(`/api/jobs/${state.selectedJobId}`);
        // 캐시 업데이트
        if (!state.jobsDbCache[state.selectedJobId]) {
          state.jobsDbCache[state.selectedJobId] = {};
        }
        state.jobsDbCache[state.selectedJobId].jobDetail = jobDetail;
        
        // 다시 파일 찾기
        const refreshedFiles = sortFilesForView(jobDetail.files || []);
        const refreshedFile = refreshedFiles.find((f) => f && f.file_id === fileId);
        if (refreshedFile) {
          state.currentFile = refreshedFile;
        } else {
          // 서버에서도 찾지 못하면 null로 설정
          state.currentFile = null;
        }
      } catch (e) {
        console.error("Failed to refresh job detail:", e);
        state.currentFile = null;
      }
    }
  }
  
  const file = state.currentFile;
  const fileInterestSelect = $("fileInterestSelect");
  const fileRotationSelect = $("fileRotationSelect");
  const btnApplyOverride = $("btnApplyFileOverride");
  const btnReprocessOverride = $("btnReprocessWithOverride");
  const btnShowPipeline = $("btnShowPipeline");
  if (!file) {
    $("previewImg").src = "";
    $("previewImg").dataset.imageUrl = "";
    $("resultTable").innerHTML = "";
    resetOcrRowCountHint();
    $("titleInput").value = "";
    $("tableHint").textContent = "파일을 선택해주세요.";
    if (fileInterestSelect) fileInterestSelect.value = "";
    if (fileRotationSelect) fileRotationSelect.value = "";
    if (btnApplyOverride) btnApplyOverride.disabled = true;
    if (btnReprocessOverride) btnApplyOverride.disabled = true;
    if (btnShowPipeline) btnShowPipeline.disabled = true;
    renderPipelinePanel(null, null);
    hideYoloImage();
    return;
  }
  if (fileInterestSelect) {
    if (inferInterest(file) === true) fileInterestSelect.value = "interest";
    else if (inferInterest(file) === false) fileInterestSelect.value = "non_interest";
    else fileInterestSelect.value = "";
  }
  if (fileRotationSelect) {
    fileRotationSelect.value = file.rotation || "";
    // 회전 선택값 변경 시 실시간 미리보기 업데이트
    fileRotationSelect.onchange = function() {
      const rotation = this.value;
      const img = $("previewImg");
      if (img) {
        img.dataset.rot = normalizeRotation(rotation);
      }
      // 팝업 창이 열려있으면 팝업 이미지도 업데이트
      const imgUrl = img?.dataset.imageUrl || "";
      if (imgUrl) {
        updatePopupImage(imgUrl, rotation);
      }
    };
  }
  if (btnApplyOverride) btnApplyOverride.disabled = false;
  if (btnReprocessOverride) btnReprocessOverride.disabled = false;
  if (btnShowPipeline) btnShowPipeline.disabled = false;
  
  // 항상 이미지 미리보기 표시 (관심/비관심 상관없이)
  const base = requireApiBase();
  const imgUrl = base ? `${base}/api/files/${fileId}/image` : `/api/files/${fileId}/image`;
  console.log("Loading image:", imgUrl, "for file:", fileId);
  
  // ✅ 이미지 캐시 확인 (이미 로드된 이미지인지 확인)
  const previewImg = $("previewImg");
  if (previewImg.dataset.imageUrl === imgUrl) {
    console.log("Image already loaded, skipping:", imgUrl);
  } else {
    // ✅ 이미지 로드 전에 이전 이미지 초기화 (삭제된 파일의 이미지가 남는 문제 방지)
    previewImg.src = "";
    previewImg.dataset.imageUrl = imgUrl;
    
    // ✅ 이미지 로드 에러 처리 (한 번만 설정)
    if (!previewImg.hasAttribute("data-error-handler-set")) {
      previewImg.setAttribute("data-error-handler-set", "true");
      previewImg.onerror = function() {
        console.error("Failed to load image:", imgUrl);
        console.error("File ID:", fileId);
        console.error("File:", file);
        // ✅ 이미지 로드 실패 시 사용자에게 알림
        $("tableHint").textContent = "이미지 로드 실패. 파일이 삭제되었거나 존재하지 않습니다.";
      };
      
      // 이미지 로드 성공 처리
      previewImg.onload = function() {
        console.log("Image loaded successfully:", imgUrl);
        // ✅ 이미지 로드 성공 시 힌트 초기화
        if ($("tableHint").textContent.includes("이미지 로드 실패")) {
          $("tableHint").textContent = file.status === "done" ? "OCR 결과를 확인하세요." : "처리 중입니다. 완료 후 결과를 확인하세요.";
        }
      };
    }
    
    // ✅ 이미지 로드 (에러 핸들러 설정 후)
    previewImg.src = imgUrl;
  }
  applyPreviewRotationFromState();
  if ($("previewImg").classList.contains("hidden")) {
    $("previewImg").classList.remove("hidden");
  }
  
  // 팝업 창이 열려있으면 이미지 업데이트
  updatePopupImage(imgUrl, file.rotation || "");
  
  loadYoloImage(fileId);
  
  if (file.status === "done") {
    await loadSelectedFileResult(fileId);
  } else if (file.status === "error") {
    // 오류 상태인 경우 이전 결과가 있으면 표시, 없으면 이미지만 표시
    
    // 이전 결과가 있는지 확인
    try {
      const data = await api(`/api/files/${fileId}/result`);
      const result = data.result;
      
      if (result && result.table && result.table.length > 0) {
        // 이전 테이블 데이터가 있으면 표시
        state.currentResult = result;
        state.currentResultFileId = fileId;
        renderTable(result.table, result.columns || []);
        $("titleInput").value = result.title || file.original_name || "";
        $("tableHint").textContent = `처리 실패: ${file.error || "알 수 없는 오류"}\n이전 테이블 데이터를 확인하고 수정 후 저장하세요.`;
        renderPipelinePanel(file, result);
      } else {
        // 이전 테이블 데이터가 없으면 이미지만 표시
        state.currentResult = { table: [], columns: [] };
        state.currentResultFileId = fileId;
        renderTable([], []);
        resetOcrRowCountHint();
        $("titleInput").value = file.original_name || "";
        $("tableHint").textContent = `처리 실패: ${file.error || "알 수 없는 오류"}\n수동으로 테이블 데이터를 입력해주세요.`;
        renderPipelinePanel(file, state.currentResult);
      }
    } catch (e) {
      // 결과 로드 실패 시 이미지만 표시
      state.currentResult = { table: [], columns: [] };
      state.currentResultFileId = fileId;
      renderTable([], []);
      resetOcrRowCountHint();
      $("titleInput").value = file.original_name || "";
      $("tableHint").textContent = `처리 실패: ${file.error || "알 수 없는 오류"}\n수동으로 테이블 데이터를 입력해주세요.`;
      renderPipelinePanel(file, state.currentResult);
    }
    
    $("btnSaveEdits").disabled = false;
    $("btnSaveDb").disabled = false;
  } else {
    // processing, queued 상태
    // 테이블은 비워두지만, 미리보기 이미지와 편집 옵션은 표시
    $("resultTable").innerHTML = "";
    resetOcrRowCountHint();
    $("titleInput").value = file.original_name || "";
    $("tableHint").textContent = "처리 중입니다. 완료 후 결과를 확인하세요.";
    renderPipelinePanel(file, null);
    
    // 편집 버튼 활성화 (처리 중에도 관심/회전 변경 가능)
    $("btnSaveEdits").disabled = true;  // 테이블 편집은 비활성화
    $("btnSaveDb").disabled = true;     // DB 저장은 비활성화
  }
  
  // 파일 리스트의 active 클래스 업데이트
  const filesList = $("files");
  if (filesList) {
    let activeNode = null;
    [...filesList.querySelectorAll("[data-file]")].forEach((node) => {
      const isActive = node.getAttribute("data-file") === fileId;
      node.classList.toggle("active", isActive);
      if (isActive) activeNode = node;
      // focus 제거 (마우스 클릭 후 방향키 이동 시 focus가 남는 문제 해결)
      if (!isActive) {
        node.blur();
      }
    });
    if (activeNode) {
      activeNode.scrollIntoView({ behavior: "auto", block: "nearest" });
      try {
        localStorage.setItem("ocr_ui_file_list_scroll_top", String(filesList.scrollTop || 0));
      } catch (_) {}
    }
  }
}

function loadYoloImage(fileId) {
  const base = requireApiBase();
  const yoloImgUrl = base ? `${base}/api/files/${fileId}/yolo_image` : `/api/files/${fileId}/yolo_image`;
  
  const yoloImg = $("yoloPreviewImg");
  const yoloContainer = $("yoloPreviewContainer");
  
  if (yoloImg && yoloContainer) {
    // ✅ 이미 캐시된 이미지인지 확인
    if (yoloImg.dataset.imageUrl === yoloImgUrl) {
      return;  // 이미 로드된 경우 스킵
    }
    
    yoloImg.dataset.imageUrl = yoloImgUrl;
    yoloImg.src = yoloImgUrl;
    yoloImg.onerror = () => {
      console.log("YOLO detection image not found for file:", fileId);
      yoloContainer.style.display = "none";
    };
    yoloImg.onload = () => {
      console.log("YOLO detection image loaded successfully:", yoloImgUrl);
      yoloContainer.style.display = "block";
    };
  }
}

function hideYoloImage() {
  const yoloContainer = $("yoloPreviewContainer");
  if (yoloContainer) {
    yoloContainer.style.display = "none";
  }
}

function buildOverridePayload(reprocess) {
  const interestSel = $("fileInterestSelect")?.value || "";
  const rotationSel = $("fileRotationSelect")?.value;
  const payload = { reprocess: !!reprocess };
  if (interestSel === "interest") payload.is_interest = true;
  if (interestSel === "non_interest") payload.is_interest = false;
  if (rotationSel !== undefined) payload.rotation = rotationSel;
  return payload;
}

export async function applySelectedFileOverride(reprocess = false) {
  if (!state.selectedJobId) return;
  const payload = buildOverridePayload(reprocess);

  if (state.selectedFileId) {
    await api(`/api/files/${state.selectedFileId}/override`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } else if (Number(state.selectedVirtualPageNo || 0) > 0) {
    const pageNo = Number(state.selectedVirtualPageNo || 0);
    await api(`/api/jobs/${state.selectedJobId}/pages/${pageNo}/override`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } else {
    alert("파일 또는 페이지를 먼저 선택하세요.");
    return;
  }
  await refreshJobDetail();
}

async function loadSelectedFileResult(fileId) {
  if (!fileId) return;
  
  // 파일 변경 시 이전 편집 내용 자동 저장
  if (state.selectedFileId && state.currentResult && state.selectedFileId !== fileId) {
    try {
      await saveCurrentEdits({ silent: true, reason: "file_change" });
    } catch (e) {
      console.warn("파일 변경 전 자동 저장 실패:", e);
    }
  }
  
  state.loadingFileResult = true;
  try {
    const base = requireApiBase();
    const imgUrl = base ? `${base}/api/files/${fileId}/image` : `/api/files/${fileId}/image`;
    $("previewImg").src = imgUrl;
    $("previewImg").dataset.imageUrl = imgUrl;
    applyPreviewRotationFromState();
    if ($("previewImg").classList.contains("hidden")) {
      $("previewImg").classList.remove("hidden");
    }
    
    // 팝업 창이 열려있으면 이미지 업데이트
    updatePopupImage(imgUrl, state.currentFile?.rotation || "");

    // ✅ 먼저 files.json에서 result를 가져와서 docKey 확인
    const data = await api(`/api/files/${fileId}/result`);
    const result = data.result;
    
    if (!result) {
      $("resultTable").innerHTML = "";
      resetOcrRowCountHint();
      $("titleInput").value = "";
      $("tableHint").textContent = "결과가 없습니다. 처리 중이거나 오류가 발생했을 수 있습니다.";
      renderPipelinePanel(state.currentFile, null);
      return;
    }

    // ✅ 올바른 docKey 가져오기
    const docKey = result.title || "";
    
    // ❌ DB 조회 로직 주석처리 (OCR 결과 로드에는 불필요)
    // DB 조회는 DB 화면에서만 사용해야 하며, OCR 결과 표시에는 files.json 데이터만으로 충분함
    /*
    // ✅ 하이브리드 방식: docKey가 있으면 DB에서 데이터 조회 시도
    if (docKey) {
      try {
        const table = state.db.table || "result_table";
        const dbData = await api(`/api/db/${encodeURIComponent(table)}/doc/${encodeURIComponent(docKey)}/rows`);
        
        if (dbData.rows && dbData.rows.length > 0) {
          // ✅ DB에 데이터가 있으면 DB 데이터 사용
          const dbResult = {
            title: docKey,
            table: dbData.rows,
            columns: dbData.columns || [],
            source: "database"  // 데이터 출처 표시
          };
          state.currentResult = dbResult;
          state.currentResultFileId = fileId;
          
          $("titleInput").value = dbResult.title || "";
          
          // Tabulator 인스턴스가 있는지 확인 후 데이터만 업데이트 (성능 최적화)
          const tableData = dbResult.table || [];
          const columns = dbResult.columns || [];
          
          // Tabulator 인스턴스가 있는지 확인
          const { isTabulatorInitialized, updateTabulatorData, updateTabulatorColumns, initTabulator } = await import("./table_tabulator.js");
          
          if (isTabulatorInitialized("ocr")) {
            // ✅ Tabulator 인스턴스가 있으면 데이터만 업데이트 (파괴하지 않음)
            if (tableData.length > 0 || columns.length > 0) {
              updateTabulatorData("ocr", tableData);
              updateTabulatorColumns("ocr", columns);
            } else {
              // 데이터가 없는 경우 빈 테이블 표시
              updateTabulatorData("ocr", []);
              updateTabulatorColumns("ocr", []);
            }
          } else {
            // ✅ Tabulator 인스턴스가 없으면 새로 생성
            if (tableData.length > 0 || columns.length > 0) {
              renderTable(tableData, columns);
            } else {
              // 데이터가 없는 경우 빈 테이블 표시
              renderTable([], []);
            }
          }
          
          $("btnSaveEdits").disabled = false;
          $("btnSaveDb").disabled = false;
          renderPipelinePanel(state.currentFile, dbResult);
          
          console.log("Loaded data from DB:", docKey);
          return;  // DB 데이터를 사용했으므로 함수 종료
        }
      } catch (e) {
        console.log("DB 조회 실패, files.json 데이터 사용:", e);
        // DB 조회 실패 시 files.json 데이터 사용 계속
      }
    }
    */
    
    // ✅ files.json 데이터 사용 (OCR 결과 표시에 충분)
    result.source = "files_json";  // 데이터 출처 표시
    
    state.currentResult = result;
    state.currentResultFileId = fileId;

    $("titleInput").value = result.title || "";
    
    // ✅ 항상 서버에서 최신 데이터를 사용 (캐시 사용 안 함)
    // Tabulator 인스턴스가 있는지 확인 후 데이터만 업데이트 (성능 최적화)
    const tableData = result.table || [];
    const columns = result.columns || [];
    
    // Tabulator 인스턴스가 있는지 확인
    const { isTabulatorInitialized, updateTabulatorData, updateTabulatorColumns, initTabulator } = await import("./table_tabulator.js");
    
    if (isTabulatorInitialized("ocr")) {
      // ✅ Tabulator 인스턴스가 있으면 데이터만 업데이트 (파괴하지 않음)
      if (tableData.length > 0 || columns.length > 0) {
        updateTabulatorData("ocr", tableData);
        updateTabulatorColumns("ocr", columns);
      } else {
        // 데이터가 없는 경우 빈 테이블 표시
        updateTabulatorData("ocr", []);
        updateTabulatorColumns("ocr", []);
      }
    } else {
      // ✅ Tabulator 인스턴스가 없으면 새로 생성
      if (tableData.length > 0 || columns.length > 0) {
        renderTable(tableData, columns);
      } else {
        // 데이터가 없는 경우 빈 테이블 표시
        renderTable([], []);
      }
    }
    
    $("btnSaveEdits").disabled = false;
    $("btnSaveDb").disabled = false;
    renderPipelinePanel(state.currentFile, result);
  } catch (e) {
    // ERROR 발생 시 파일 결과 초기화
    console.error("파일 결과 로드 실패:", e);
    $("resultTable").innerHTML = "";
    resetOcrRowCountHint();
    $("titleInput").value = "";
    $("tableHint").textContent = `결과 로드 실패: ${e.message}`;
    $("btnSaveEdits").disabled = true;
    $("btnSaveDb").disabled = true;
    renderPipelinePanel(state.currentFile, null);
  } finally {
    state.loadingFileResult = false;
  }
}

export async function uploadImages() {
  const files = $("imageFiles").files;
  if (!files || !files.length) return alert("이미지를 선택해주세요.");
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  const rotation = $("rotationImage").value;
  if (rotation) fd.append("rotation", rotation);
  const resp = await api("/api/upload/images", { method: "POST", body: fd });
  await selectJob(resp.job_id);
}

export async function uploadPdf() {
  const f = $("pdfFile").files?.[0];
  if (!f) return alert("PDF를 선택해주세요.");
  const fd = new FormData();
  fd.append("file", f);
  fd.append("dpi", $("pdfDpi").value || "300");
  const rotation = $("rotationPdf").value;
  if (rotation) fd.append("rotation", rotation);
  const resp = await api("/api/upload/pdf", { method: "POST", body: fd });
  await selectJob(resp.job_id);
}

function getOcrColumnsFromDom() {
  const tableEl = $("resultTable");
  const cols = [...(tableEl?.querySelectorAll("thead th[data-col]") || [])]
    .map((th) => th.getAttribute("data-col"))
    .map((col) => (col || "").trim())
    .filter(Boolean);
  if (cols.length) return cols;
  const fallback = state.currentResult?.columns || state.tableEdit.ocr.columns || [];
  const cleanFallback = (fallback || [])
    .map((col) => String(col || "").trim())
    .filter(Boolean);
  return cleanFallback.length ? cleanFallback : computeColumnsFromRows(collectTable(), []);
}

function buildOcrPayloadFromDom() {
  const table = collectTable();
  const columns = getOcrColumnsFromDom();
  return { table, columns };
}

async function autoSaveEdits(reason) {
  if (!state.selectedFileId || !state.currentResult) return;
  try {
    await saveCurrentEdits({ silent: true, reason });
  } catch (e) {
    console.warn(`autosave failed (${reason})`, e);
  }
}

async function saveCurrentEdits(options = {}) {
  const { saveEdits } = await import("./table_edit_fix.js");
  return saveEdits(options);
}

export async function saveToDb() {
  if (!state.selectedFileId) return;
  
  // ✅ 먼저 편집 내용을 서버에 저장 (서버 메모리 업데이트)
  await saveCurrentEdits({ silent: true, reason: "db_save" });
  
  // ✅ 서버에서 최신 데이터를 다시 로드
  await loadSelectedFileResult(state.selectedFileId);
  
  // ✅ 최신 데이터를 DOM에서 직접 수집
  const { table, columns } = buildOcrPayloadFromDom();
  const title = $("titleInput").value.trim();
  const image_name = state.currentResult?.image_name || state.currentFile?.original_name || "";
  
  // ✅ 디버깅: 수집된 데이터 확인
  console.log("[saveToDb] Collected table rows:", table.length);
  console.log("[saveToDb] Collected columns:", columns);
  
  // ✅ 편집된 데이터를 payload로 직접 전달
  const payload = {
    title,
    table,
    columns,
    image_name
  };
  
  try {
    const resp = await api(`/api/files/${state.selectedFileId}/save_to_db`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    
    // ✅ 메모리 상태도 업데이트 (일관성 유지)
    if (state.currentResult) {
      state.currentResult.title = title;
      state.currentResult.table = table;
      state.currentResult.columns = columns;
      if (image_name) {
        state.currentResult.image_name = image_name;
      }
    }
    if (state.selectedFileId) {
      state.fileDbCache[state.selectedFileId] = { exists: true, checkedAt: Date.now(), checkedDone: true, inflight: false };
    }
    if (state.selectedJobId) {
      const jobCached = state.jobsDbCache[state.selectedJobId] || {};
      state.jobsDbCache[state.selectedJobId] = { ...jobCached, hasDbFiles: true, checkedAt: Date.now(), inflight: false };
    }
    
    // ✅ 파일 리스트에서 "(DB 존재)" 표시 즉시 갱신
    if (state.selectedFileId) {
      const filesList = $("files");
      if (filesList) {
        const fileNode = filesList.querySelector(`[data-file="${CSS.escape(state.selectedFileId)}"]`);
        if (fileNode) {
          // 기존 "(DB 존재)" 텍스트 제거
          const existingDbSpan = fileNode.querySelector("div > div.hint span:last-child");
          if (existingDbSpan && existingDbSpan.textContent.includes("(DB 존재)")) {
            existingDbSpan.remove();
          }
          
          // 새로운 "(DB 존재)" 텍스트 추가
          const hintDiv = fileNode.querySelector("div > div.hint");
          if (hintDiv) {
            const dbExistsSpan = document.createElement("span");
            dbExistsSpan.style.color = "#fca5a5";
            dbExistsSpan.style.fontSize = "11px";
            dbExistsSpan.style.flexShrink = "0";
            dbExistsSpan.textContent = "(DB 존재)";
            hintDiv.appendChild(dbExistsSpan);
            fileNode.classList.add("exists-in-db");
          }
        }
      }
    }
    
    alert(`DB 저장 완료 (table=${resp.table}, rows=${resp.rows_inserted || 0})`);
  } catch (e) {
    if (e.status === 409) {
      const msg = e.body?.message || "이미 존재하는 문서입니다. 덮어쓰시겠습니까?";
      const docKey = e.body?.doc_key ? `\n문서키: ${e.body.doc_key}` : "";
      const count = e.body?.count ? `\n건수: ${e.body.count}` : "";
      const ok = confirm(`${msg}${docKey}${count}`);
      if (!ok) return;
      
      // ✅ 덮어쓰기 시에도 편집된 데이터 직접 전달
      const resp2 = await api(`/api/files/${state.selectedFileId}/save_to_db?overwrite=true`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      
      // ✅ 메모리 상태도 업데이트
      if (state.currentResult) {
        state.currentResult.title = title;
        state.currentResult.table = table;
        state.currentResult.columns = columns;
        if (image_name) {
          state.currentResult.image_name = image_name;
        }
      }
      
      if (state.selectedFileId) {
        state.fileDbCache[state.selectedFileId] = { exists: true, checkedAt: Date.now(), checkedDone: true, inflight: false };
      }
      if (state.selectedJobId) {
        const jobCached = state.jobsDbCache[state.selectedJobId] || {};
        state.jobsDbCache[state.selectedJobId] = { ...jobCached, hasDbFiles: true, checkedAt: Date.now(), inflight: false };
      }
      alert(`DB 덮어쓰기 완료 (table=${resp2.table}, rows=${resp2.rows_inserted || 0})`);
      return;
    }
    alert(`DB 저장 실패: ${e.message}`);
  }
}

export async function showHealth() {
  try {
    const h = await api("/api/health");
    alert(`OK\nYOLO=${h.yolo}\nOCR=${h.ocr}\nDOC_FILTER=${h.doc_filter}\nSTORAGE=${h.storage}`);
  } catch (e) {
    alert(`상태 확인 실패: ${e.message}`);
  }
}

// classification.js에서 사용하기 위해 export
export { applyPreviewRotationFromState } from "./ui_utils.js";

const DB_FIELD_DISPLAY_LABELS = {
  heat_no: "Heat No",
  hcn: "HCN",
  spool_tag_no: "Spool Tag No",
};

// 필드명 매핑: 다양한 형태의 필드명을 표준화하여 표시
function normalizeFieldName(fieldName) {
  const key = String(fieldName || "").trim().toLowerCase();
  
  // heat_no 매핑
  if (key === "heat_no" || key === "heat no" || key === "heatno") {
    return "Heat No";
  }
  
  // hcn 매핑
  if (key === "hcn") {
    return "HCN";
  }
  
  // spool_tag_no 매핑
  if (key === "spool_tag_no" || key === "spool tag no" || key === "spooltagno") {
    return "Spool Tag No";
  }
  
  // 그 외는 첫 글자만 대문자로 (영어인 경우)
  return fieldName.charAt(0).toUpperCase() + fieldName.slice(1);
}

function toDisplayFieldName(fieldName) {
  const key = String(fieldName || "").trim();
  return DB_FIELD_DISPLAY_LABELS[key] || normalizeFieldName(fieldName);
}

function buildHistoryVersionLabel(version) {
  const createdAt = String(version?.created_at || "-");
  const userId = String(version?.user_id || "-");
  const rowCount = Number(version?.row_count || 0);
  return `${createdAt} · ${userId} · ${rowCount}행`;
}

function hideAllEmptyColumns(rows) {
  const tableRows = Array.isArray(rows) ? rows.filter((x) => x && typeof x === "object") : [];
  if (!tableRows.length) return [];
  const keys = Array.from(
    tableRows.reduce((set, row) => {
      Object.keys(row).forEach((k) => set.add(k));
      return set;
    }, new Set())
  );
  const keep = keys.filter((k) => {
    if (k === "row_index") return false;
    return tableRows.some((row) => {
      const v = row[k];
      return hasMeaningfulValue(v);
    });
  });
  return tableRows.map((row) => {
    const next = {};
    keep.forEach((k) => {
      if (k in row) next[toDisplayFieldName(k)] = row[k];
    });
    return next;
  });
}

function renderDbHistoryTable(historyRows) {
  const table = $("dbHistoryTable");
  if (!table) return;
  const rows = Array.isArray(historyRows) ? historyRows : [];
  if (!rows.length) {
    table.innerHTML = "";
    return;
  }
  const headers = ["created_at", "field_name", "old_value", "new_value", "action", "user_id"];
  const th = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const td = rows
    .map((row) => {
      const r = row && typeof row === "object" ? row : {};
      const cells = headers
        .map((h) => {
          const value = r[h] == null ? "" : String(r[h]);
          const safe = escapeHtml(value);
          return `<td title="${safe}">${safe}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  table.innerHTML = `<thead><tr>${th}</tr></thead><tbody>${td}</tbody>`;
}

function renderDbHistoryVersionList(versions) {
  const list = $("dbHistoryVersionList");
  if (!list) return;
  const rows = Array.isArray(versions) ? versions : [];
  if (!rows.length) {
    list.innerHTML = `<div class="hint">버전이 없습니다.</div>`;
    return;
  }
  list.innerHTML = rows
    .map((v) => {
      const id = Number(v?.version_id || 0);
      const active = Number(state.db.historySelectedVersionId || 0) === id ? "active" : "";
      const createdAt = escapeHtml(String(v?.created_at || ""));
      const userId = escapeHtml(String(v?.user_id || "-"));
      const rowCount = escapeHtml(String(v?.row_count || 0));
      return `
          <div class="item ${active}" data-db-history-version="${id}">
            <div style="min-width:0">
              <div><b>${escapeHtml(buildHistoryVersionLabel(v))}</b></div>
              <div class="hint">${createdAt} · ${userId}</div>
            </div>
            <span class="badge">${rowCount}행</span>
          </div>
        `;
    })
    .join("");

  [...list.querySelectorAll("[data-db-history-version]")].forEach((node) => {
    node.addEventListener("click", () => {
      const versionId = Number(node.getAttribute("data-db-history-version") || 0);
      if (!versionId) return;
      loadDbHistorySnapshot(versionId).catch((e) => {
        const hint = $("dbHistoryHint");
        if (hint) hint.textContent = `스냅샷 조회 실패: ${e.message}`;
      });
    });
  });
}

function renderDbHistorySnapshot(rows, columns) {
  const table = $("dbHistoryTable");
  if (!table) return;
  const tableRows = hideAllEmptyColumns(Array.isArray(rows) ? rows : []);
  if (!tableRows.length) {
    table.innerHTML = "";
    return;
  }
  state.tableEdit.db.columns = [];
  renderEditableTableTo(table, tableRows);
}

function resetDbHistoryUi(message = "문서를 선택해주세요.") {
  state.db.history = [];
  state.db.historyVersions = [];
  state.db.historySelectedVersionId = null;
  state.db.historyOffset = 0;
  state.db.historyHasMore = false;
  const hint = $("dbHistoryHint");
  if (hint) hint.textContent = message;
  const page = $("dbHistoryPageInfo");
  if (page) page.textContent = "문서를 선택하면 이력 목록이 표시됩니다.";
  const list = $("dbHistoryVersionList");
  if (list) list.innerHTML = `<div class="hint">버전을 선택해주세요.</div>`;
  renderDbHistorySnapshot([], []);
}

async function loadDbHistorySnapshot(versionId) {
  const hint = $("dbHistoryHint");
  if (hint) hint.textContent = "스냅샷을 불러오는 중...";
  try {
    const resp = await api(`/api/db/history/version/${encodeURIComponent(versionId)}`);
    state.db.history = (resp?.rows || []).filter((x) => x && typeof x === "object");
    state.db.historySelectedVersionId = Number(resp?.version_id || versionId);
    renderDbHistoryVersionList(state.db.historyVersions || []);
    renderDbHistorySnapshot(resp?.rows || [], resp?.columns || []);
    if (hint) {
      const selectedVersion = (state.db.historyVersions || []).find(
        (x) => Number(x?.version_id || 0) === state.db.historySelectedVersionId
      );
      hint.textContent = state.db.history.length
        ? `총 ${state.db.history.length}개 · ${buildHistoryVersionLabel(selectedVersion || resp)}`
        : "선택한 버전에 테이블 데이터가 없습니다.";
    }
  } catch (e) {
    renderDbHistorySnapshot([], []);
    if (hint) hint.textContent = `스냅샷 조회 실패: ${e.message}`;
  }
}

export async function loadDbHistory(docKey, options = {}) {
  const targetDocKey = (docKey || state.db.selectedDocKey || "").trim();
  if (!targetDocKey) {
    resetDbHistoryUi("문서를 선택해주세요.");
    return;
  }

  if (options.resetOffset) {
    state.db.historyOffset = 0;
  }

  const params = new URLSearchParams({
    limit: String(state.db.historyLimit),
    offset: String(state.db.historyOffset),
  });

  const hint = $("dbHistoryHint");
  if (hint) hint.textContent = "이력 목록을 불러오는 중...";

  try {
    const resp = await api(`/api/db/doc/${encodeURIComponent(targetDocKey)}/history/versions?${params.toString()}`);
    const versions = (resp.versions || []).filter((x) => x && typeof x === "object");
    state.db.historyVersions = versions;
    state.db.historyHasMore = versions.length === state.db.historyLimit;
    renderDbHistoryVersionList(versions);

    const page = $("dbHistoryPageInfo");
    if (page) {
      const start = versions.length ? state.db.historyOffset + 1 : 0;
      const end = state.db.historyOffset + versions.length;
      page.textContent = `이력 목록: ${start}-${end}${state.db.historyHasMore ? " / 더보기" : ""}`;
    }

    if (!versions.length) {
      state.db.historySelectedVersionId = null;
      renderDbHistorySnapshot([], []);
      if (hint) hint.textContent = "이력이 없습니다.";
      return;
    }

    const firstVersionId = Number(versions[0]?.version_id || 0);
    if (!firstVersionId) {
      state.db.historySelectedVersionId = null;
      renderDbHistorySnapshot([], []);
      if (hint) hint.textContent = "버전 선택 불가";
      return;
    }
    await loadDbHistorySnapshot(firstVersionId);
  } catch (e) {
    renderDbHistoryVersionList([]);
    renderDbHistorySnapshot([], []);
    const page = $("dbHistoryPageInfo");
    if (page) page.textContent = "이력 목록 조회 실패";
    if (hint) hint.textContent = `이력 목록 조회 실패: ${e.message}`;
  }
}

export async function initDbScreen() {
  const sel = $("dbTableSelect");
  if (!sel) return;
  const data = await api("/api/db/tables");
  const tables = data.tables || [];
  
  // 시스템 테이블 제외
  const excludedTables = new Set(["history_table", "job_pages", "ocr_results"]);
  const filteredTables = tables.filter(t => !excludedTables.has(t));
  
  sel.innerHTML = filteredTables.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("");
  
  // 저장된 테이블 이름 불러오기
  const savedTable = localStorage.getItem("ocr_ui_selected_db_table") || "";
  
  if (!state.db.table) {
    const cfg = await api("/api/db_config");
    const preferred = cfg.table_name || "";
    // 저장된 테이블이 있고 유효하면 사용, 아니면 기본값 사용
    if (savedTable && filteredTables.includes(savedTable)) {
      state.db.table = savedTable;
    } else if (preferred && filteredTables.includes(preferred)) {
      state.db.table = preferred;
    } else {
      state.db.table = filteredTables[0] || "";
    }
  }
  sel.value = state.db.table;
  state.db.offset = 0;
  
  // 선택된 DB 테이블을 localStorage에 저장
  try {
    localStorage.setItem("ocr_ui_selected_db_table", state.db.table);
  } catch (e) {
    console.warn("Failed to save selected DB table:", e);
  }
  
  // 버튼 초기 상태 비활성화
  $("btnDbSaveRow").disabled = true;
  $("btnDbDeleteRow").disabled = true;
  $("btnDbDeleteTable").disabled = true;
  
  await loadDbDocs();
  resetDbHistoryUi();
}

export async function loadDbDocs() {
  const table = ($("dbTableSelect")?.value || "").trim();
  if (!table) return;
  state.db.table = table;
  const q = getDbQuery();
  const params = new URLSearchParams({
    limit: String(state.db.limit),
    offset: String(state.db.offset),
    q: q.q,
    table_q: q.table_q,
  });
  const data = await api(`/api/db/${encodeURIComponent(table)}/docs?${params.toString()}`);
  state.db.total = data.total || 0;
  const docs = (data.docs || []).filter(Boolean);
  const list = $("dbRows");
  if (list) {
    if (!docs.length) {
      list.innerHTML = `<div class="hint">결과가 없습니다.</div>`;
    } else {
      list.innerHTML = docs
        .map((d) => {
          if (!d) return "";
          const active = String(state.db.selectedDocKey) === String(d.doc_key) ? "active" : "";
          const title = d.title || d.doc_key || "";
          const name = d.image_name || "";
          const meta = `${d.created_at || ""}`.trim();
          const cnt = Number(d.rows_count || 0);
          return `
              <div class="item ${active}" data-db-doc="${escapeHtml(String(d.doc_key || ""))}">
                <div style="min-width:0">
                  <div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;"><b>${escapeHtml(title || name || (d.doc_key || ""))}</b></div>
                  <div class="hint">${escapeHtml(meta)}</div>
                </div>
                <span class="badge">${escapeHtml(String(cnt))}행</span>
              </div>
            `;
        })
        .join("");
    }
    [...list.querySelectorAll("[data-db-doc]")].forEach((n) => {
      n.addEventListener("click", () => selectDbDoc(n.getAttribute("data-db-doc")));
    });
  }
  const page = $("dbPageInfo");
  if (page) {
    const start = state.db.total ? state.db.offset + 1 : 0;
    const end = Math.min(state.db.offset + state.db.limit, state.db.total);
    page.textContent = `페이지: ${start}-${end} / ${state.db.total}`;
  }
}

export async function selectDbDoc(docKey) {
  const table = state.db.table;
  if (!table || !docKey) return;
  state.db.selectedDocKey = docKey;
  state.db.selectedRowId = null;
  
  // 선택된 DB 문서 키를 localStorage에 저장
  try {
    localStorage.setItem("ocr_ui_selected_db_doc_key", docKey);
  } catch (e) {
    console.warn("Failed to save selected DB doc key:", e);
  }
  
  await loadDbDocs();

  const data = await api(`/api/db/${encodeURIComponent(table)}/doc/${encodeURIComponent(docKey)}/rows`);
  const rows = data.rows || [];
  const serverColumns = data.columns || [];  // 서버에서 받은 컬럼 순서
  state.db.docRows = rows;
  const detailTitle = $("dbDetailTitle");
  if (detailTitle) detailTitle.textContent = `${docKey || ""}`;
  const meta = rows.length ? `${rows[0].image_name || ""}` : "";
  const detailMeta = $("dbDetailMeta");
  if (detailMeta) detailMeta.textContent = `${meta}`.trim();
  const editTitle = $("dbEditTitle");
  if (editTitle) editTitle.value = docKey || "";

  // Render rows as editable table (exclude meta fields)
  const filteredRows = (rows || []).map((r) => {
    const src = r && typeof r === "object" ? r : {};
    const obj = {};
    // 메타 필드 제외
    Object.keys(src).forEach((key) => {
      if (["id", "doc_key", "title", "image_name", "image_path", "created_at", "row_index", "job_id", "page_no"].includes(key)) {
        return; // 메타 필드는 제외
      }
      const normalizedKey = normalizeFieldName(key);
      obj[normalizedKey] = src[key];
    });
    return obj;
  });
  // 서버에서 받은 컬럼 순서 전달
  renderEditableTableTo($("dbTableDataTable"), filteredRows, serverColumns);
  $("btnDbSaveRow").disabled = false;
  $("btnDbDeleteRow").disabled = false;
  $("btnDbDeleteTable").disabled = false;
  const hint = $("dbDetailHint");
  if (hint) hint.textContent = "";
  state.db.historyOffset = 0;
  await loadDbHistory(docKey, { resetOffset: true });
}

export async function saveDbRow() {
  const table = state.db.table;
  const rowId = state.db.selectedRowId;
  if (!table || !rowId) return;

  // 자동 저장 추가 (OCR 화면에서 DB 저장 시와 동일하게)
  if (state.selectedFileId && state.currentResult) {
    try {
      await saveCurrentEdits({ silent: true, reason: "db_save" });
    } catch (e) {
      console.warn("자동 저장 실패 (DB 저장 전 자동 저장)", e);
    }
  }

  const rows = collectEditableTableFrom($("dbTableDataTable"));
  const idx = state.tableEdit.db.selectedRow;
  const data = (Number.isFinite(idx) && rows && rows[idx]) ? rows[idx] : {};
  await api(`/api/db/${encodeURIComponent(table)}/row/${encodeURIComponent(rowId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: $("dbEditTitle").value || "",
      data,
    }),
  });
  const hint = $("dbDetailHint");
  if (hint) hint.textContent = "저장 완료";
  await loadDbDocs();
  await loadDbHistory(state.db.selectedDocKey || "", { resetOffset: true });
}

export async function deleteDbRow() {
  const table = state.db.table;
  const rowId = state.db.selectedRowId;
  if (!table || !rowId) return;

  // 자동 저장 추가 (삭제 전에 편집 내용 저장)
  if (state.selectedFileId && state.currentResult) {
    try {
      await saveCurrentEdits({ silent: true, reason: "db_delete" });
    } catch (e) {
      console.warn("자동 저장 실패 (DB 삭제 전 자동 저장)", e);
    }
  }

  const ok = confirm("선택한 DB 행을 영구 삭제하시겠습니까? 삭제 후 복구 불가합니다. 계속하시겠습니까?");
  if (!ok) return;
  const finalOk = confirm("최종 확인: DB 행 삭제를 실행하시겠습니까? 작업 내용도 모두 삭제됩니다.");
  if (!finalOk) return;
  await api(`/api/db/${encodeURIComponent(table)}/row/${encodeURIComponent(rowId)}`, { method: "DELETE" });
  state.db.selectedRowId = null;
  $("btnDbSaveRow").disabled = true;
  $("btnDbDeleteRow").disabled = true;
  $("dbDetailTitle").textContent = "행을 선택해주세요.";
  $("dbDetailMeta").textContent = "";
  $("dbEditTitle").value = "";
  renderEditableTableTo($("dbTableDataTable"), []);
  const hint = $("dbDetailHint");
  if (hint) hint.textContent = "삭제 완료";
  await loadDbDocs();
  if (state.db.selectedDocKey) {
    await loadDbHistory(state.db.selectedDocKey, { resetOffset: true });
  } else {
    resetDbHistoryUi("문서를 선택해주세요.");
  }
}

export async function deleteDbTable() {
  const table = state.db.table;
  const docKey = state.db.selectedDocKey;
  if (!table || !docKey) return;

  // 자동 저장 추가 (삭제 전에 편집 내용 저장)
  if (state.selectedFileId && state.currentResult) {
    try {
      await saveCurrentEdits({ silent: true, reason: "db_delete_table" });
    } catch (e) {
      console.warn("자동 저장 실패 (DB 테이블 삭제 전 자동 저장)", e);
    }
  }

  const ok = confirm(`선택한 문서(${docKey})의 모든 행을 영구 삭제하시겠습니까? 삭제 후 복구 불가합니다. 계속하시겠습니까?`);
  if (!ok) return;
  const finalOk = confirm(`최종 확인: 문서 "${docKey}"의 모든 테이블 데이터를 영구 삭제하시겠습니까? 작업 내용도 모두 삭제됩니다.`);
  if (!finalOk) return;
  await api(`/api/db/${encodeURIComponent(table)}/doc/${encodeURIComponent(docKey)}`, { method: "DELETE" });
  state.db.selectedDocKey = null;
  state.db.selectedRowId = null;
  $("btnDbSaveRow").disabled = true;
  $("btnDbDeleteRow").disabled = true;
  $("btnDbDeleteTable").disabled = true;
  $("dbDetailTitle").textContent = "행을 선택해주세요.";
  $("dbDetailMeta").textContent = "";
  $("dbEditTitle").value = "";
  renderEditableTableTo($("dbTableDataTable"), []);
  const hint = $("dbDetailHint");
  if (hint) hint.textContent = "테이블 삭제 완료";
  await loadDbDocs();
  resetDbHistoryUi("문서를 선택해주세요.");
}

export async function loadDbConfig() {
  const cfg = await api("/api/db_config");
  $("dbHost").value = cfg.host || "";
  $("dbPort").value = cfg.port || 3306;
  $("dbUser").value = cfg.user || "";
  $("dbPassword").value = cfg.password || "";
  $("dbConfigHint").textContent = "";
}

export async function saveDbConfig() {
  const payload = {
    host: $("dbHost").value || "",
    port: Number($("dbPort").value || 3306),
    user: $("dbUser").value || "",
    password: $("dbPassword").value || "",
    database: "ocr_database_test",
    table_name: "ocr_results",
  };
  try {
    await api("/api/db_config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    $("dbConfigHint").textContent = "저장 완료";
    setTimeout(() => openDbModal(false), 400);
  } catch (e) {
    $("dbConfigHint").textContent = `저장 실패: ${e.message}`;
  }
}
