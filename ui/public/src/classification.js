import { $ } from "./dom.js";
import { state } from "./state.js";
import {
  requireApiBase,
  api,
  getApiBase,
} from "./api.js";
import { clearFileInput, normalizeRotation, openImagePopup } from "./ui_utils.js";

// 분류 페이지 상태
state.classification = {
  currentJobId: null,
  currentJobName: null, // 작업 이름 (파일 이름)
  currentPageIndex: 0,
  totalPages: 0,
  pages: [], // { page_index, is_interest, rotation, file_id, stored_path, status }
  filter: "all", // all, interest, non_interest, unreviewed
  jobStatusFilter: "all",
  jobSearch: "",
  isSaving: false,
  eventSource: null, // SSE 연결
  // 이미지 확대/축소 상태
  imageZoom: 1,
  imageTranslateX: 0,
  imageTranslateY: 0,
  isDraggingImage: false,
  dragStartX: 0,
  dragStartY: 0,
  initialTranslateX: 0,
  initialTranslateY: 0,
  // 사용자가 변경한 페이지 상태 추적 (SSE 업데이트 시 사용자 변경사항 보호용)
  userModifiedPages: new Set(), // page_index 집합
  // 팝업 창 참조
  popupWindow: null,
  // OCR 처리 대기열 관리
  ocrQueue: [], // 대기 중인 OCR 요청 { page_no, is_interest, rotation, resolve, reject }
  activeOcrRequests: 0, // 현재 활성 OCR 요청 수
  maxConcurrentOcrRequests: 4, // 최대 동시 OCR 요청 수
  // 가상 스크롤 인스턴스
  interestVirtualScroll: null,
  nonInterestVirtualScroll: null,
  // ✅ 디바운싱 타이머 추가
  jobsUpdateDebounceTimer: null,
  pagesUpdateDebounceTimer: null,
  // ✅ 성능 최적화: 작업 중 상태 추적
  isProcessing: false,
  pendingUpdate: false,
  processingUpdateTimer: null,
  lastPagesHash: null, // 페이지 상태 변경 감지용
  // ✅ OCR 처리 탭 캐시 초기화 디바운싱 타이머
  ocrTabCacheClearDebounceTimer: null,
};

/*
// 기존 상태 (가상 스크롤 추가 전)
state.classification = {
  currentJobId: null,
  currentJobName: null, // 작업 이름 (파일 이름)
  currentPageIndex: 0,
  totalPages: 0,
  pages: [], // { page_index, is_interest, rotation, file_id, stored_path, status }
  filter: "all", // all, interest, non_interest, unreviewed
  jobStatusFilter: "all",
  jobSearch: "",
  isSaving: false,
  eventSource: null, // SSE 연결
  // 이미지 확대/축소 상태
  imageZoom: 1,
  imageTranslateX: 0,
  imageTranslateY: 0,
  isDraggingImage: false,
  dragStartX: 0,
  dragStartY: 0,
  initialTranslateX: 0,
  initialTranslateY: 0,
  // 사용자가 변경한 페이지 상태 추적 (SSE 업데이트 시 사용자 변경사항 보호용)
  userModifiedPages: new Set(), // page_index 집합
  // 팝업 창 참조
  popupWindow: null,
  // OCR 처리 대기열 관리
  ocrQueue: [], // 대기 중인 OCR 요청 { page_no, is_interest, rotation, resolve, reject }
  activeOcrRequests: 0, // 현재 활성 OCR 요청 수
  maxConcurrentOcrRequests: 4, // 최대 동시 OCR 요청 수
};
*/

// 작업 목록 로드
async function loadJobs() {
  try {
    console.log("loadJobs() - requireApiBase() 호출 전");
    requireApiBase();
    console.log("loadJobs() - requireApiBase() 호출 완료");
    
    console.log("loadJobs() - api('/api/jobs') 호출 전");
    const data = await api("/api/jobs");
    console.log("loadJobs() - api('/api/jobs') 호출 완료");
    console.log("작업 목록 데이터 수신:", data);
    
    if (!data || !data.jobs) {
      console.error("작업 데이터가 없습니다:", data);
      return;
    }

    const container = $("classificationJobs");
    if (!container) {
      console.error("classificationJobs 컨테이너를 찾을 수 없습니다");
      return;
    }

    container.innerHTML = "";

    // 필터링
    let filteredJobs = data.jobs;
    
    if (state.classification.jobStatusFilter !== "all") {
      filteredJobs = filteredJobs.filter(job => job.status === state.classification.jobStatusFilter);
    }
    
    if (state.classification.jobSearch) {
      const query = state.classification.jobSearch.toLowerCase();
      filteredJobs = filteredJobs.filter(job => {
        const hay = `${job.name || job.kind || ""} ${job.kind || ""} ${job.job_id || ""}`.toLowerCase();
        return hay.includes(query);
      });
    }

    // PDF 작업만 필터링
    const pdfJobs = filteredJobs.filter(job => job.kind === "pdf_upload");
    console.log("필터링된 PDF 작업:", pdfJobs.length, "개");
    
    if (!pdfJobs.length) {
      container.innerHTML = `<div class="hint">PDF 작업이 없습니다.</div>`;
      return;
    }

    pdfJobs.forEach(job => {
      const item = document.createElement("div");
      item.className = "item";
      item.setAttribute("data-job", job.job_id);
      if (job.job_id === state.classification.currentJobId) {
        item.classList.add("active");
      }

      const total = job.progress?.total ?? 0;
      const done = job.progress?.done ?? 0;
      const jobName = job.name || job.job_id;

      // 상태에 따른 배지 스타일 결정
      let statusClass = "";
      if (job.status === "done") {
        statusClass = "ok";
      } else if (job.status === "processing") {
        statusClass = "run";
      } else if (job.status === "error") {
        statusClass = "err";
      } else if (job.status === "cancelled") {
        statusClass = "cancelled";
      }

      item.innerHTML = `
        <div style="min-width:0; flex:1;">
          <div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${jobName}"><b>${jobName}</b></div>
          <div class="hint">${job.job_id.slice(0, 10)} · ${done}/${total}</div>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
          <span class="badge ${statusClass}">${job.status}</span>
        </div>
      `;

      item.addEventListener("click", () => {
        selectJob(job.job_id);
      });

      container.appendChild(item);
    });
    
    console.log("작업 목록 렌더링 완료:", pdfJobs.length, "개");
  } catch (e) {
    console.error("작업 목록 로드 실패:", e);
    console.error("에러 상세:", {
      message: e.message,
      stack: e.stack,
      name: e.name
    });
  }
}

// 작업 선택
async function selectJob(jobId) {
  if (!jobId) {
    state.classification.currentJobId = null;
    state.classification.pages = [];
    state.classification.currentPageIndex = 0;
    state.classification.totalPages = 0;
    updateJobInfo();
    renderPagesList();
    // 작업 목록의 active 클래스 제거
    updateJobItemsActiveClass(null);
    return;
  }

  try {
    requireApiBase();
    
    // 작업 상세 정보 로드
    const jobData = await api(`/api/jobs/${jobId}`);
    if (!jobData || !jobData.job) {
      alert("작업 정보를 찾을 수 없습니다.");
      // 작업 선택 실패 시 상태 초기화
      state.classification.currentJobId = null;
      state.classification.pages = [];
      state.classification.currentPageIndex = 0;
      state.classification.totalPages = 0;
      updateJobInfo();
      renderPagesList();
      updateJobItemsActiveClass(null);
      // 작업 목록 새로고침
      loadJobs();
      return;
    }

    // 페이지 목록 로드
    const pagesData = await api(`/api/jobs/${jobId}/pages`);
    if (!pagesData || !pagesData.pages) {
      alert("페이지 목록을 찾을 수 없습니다.");
      return;
    }

    state.classification.currentJobId = jobId;
    state.classification.currentJobName = jobData.job.name || jobData.job.job_id;
    
    // ✅ classification_status 필드 초기화
    state.classification.pages = pagesData.pages.map(page => ({
      ...page,
      // classification_status가 없으면 기본값으로 "queued" 설정
      classification_status: page.classification_status || "queued"
    }));
    
    state.classification.totalPages = pagesData.pages.length;
    state.classification.currentPageIndex = 0;

    console.log("작업 선택 완료:", {
      jobId: jobId,
      jobName: state.classification.currentJobName,
      totalPages: state.classification.totalPages,
      pages: state.classification.pages
    });

    // 선택된 분류 작업 ID를 localStorage에 저장
    try {
      localStorage.setItem("ocr_ui_classification_job_id", jobId);
    } catch (e) {
      console.warn("Failed to save classification job ID:", e);
    }

    updateJobInfo(jobData.job);
    
    // ✅ 중요: 페이지 목록 렌더링 전에 작업 목록의 active 클래스 업데이트
    updateJobItemsActiveClass(jobId);
    
    // ✅ 페이지 목록 렌더링 (classification_status 초기화 후)
    renderPagesList();
    
    // 페이지가 있으면 첫 페이지 로드
    if (state.classification.totalPages > 0) {
      loadPage(0);
    } else {
      console.warn("페이지가 없어 첫 페이지를 로드할 수 없습니다");
    }
    
    // 작업 목록의 active 클래스 업데이트
    updateJobItemsActiveClass(jobId);
  } catch (e) {
    console.error("작업 선택 실패:", e);
    
    // 작업을 찾을 수 없는 경우 (삭제된 작업)
    if (e.status === 404 || (e.body && e.body.error_code === "JOB_NOT_FOUND")) {
      console.warn("작업을 찾을 수 없음, 상태 초기화:", jobId);
      alert("선택한 작업을 찾을 수 없습니다. 작업이 삭제되었을 수 있습니다.");
      
      // 상태 초기화
      state.classification.currentJobId = null;
      state.classification.pages = [];
      state.classification.currentPageIndex = 0;
      state.classification.totalPages = 0;
      updateJobInfo();
      renderPagesList();
      updateJobItemsActiveClass(null);
      
      // localStorage에서 삭제된 작업 ID 제거
      try {
        localStorage.removeItem("ocr_ui_classification_job_id");
      } catch (err) {
        console.warn("Failed to remove classification job ID from localStorage:", err);
      }
      
      // 작업 목록 새로고침
      loadJobs();
    } else {
      // 다른 에러는 기존대로 처리
      alert("작업 선택 실패: " + e.message);
    }
  }
}

// 작업 목록 아이템의 active 클래스 업데이트
function updateJobItemsActiveClass(selectedJobId) {
  const container = $("classificationJobs");
  if (!container) return;
  
  const items = container.querySelectorAll(".item");
  items.forEach(item => {
    const jobDataAttr = item.getAttribute("data-job");
    if (jobDataAttr === selectedJobId) {
      item.classList.add("active");
    } else {
      item.classList.remove("active");
    }
  });
}

// 작업 정보 업데이트
function updateJobInfo(job = null) {
  const statusEl = $("classificationStatus");
  const currentPageEl = $("classificationCurrentPage");
  const fileNameEl = $("classificationFileName");

  if (!statusEl) return;

  if (!job) {
    statusEl.textContent = "작업을 선택하세요";
    if (currentPageEl) currentPageEl.textContent = "페이지 0 / 0";
    if (fileNameEl) fileNameEl.textContent = "";
    return;
  }

  const total = state.classification.totalPages;
  const done = state.classification.pages.filter(p => p.status === "done").length;

  statusEl.textContent = `${job.name || job.job_id} (${job.status}) · 완료 ${done}/${total}`;
  if (currentPageEl) {
    currentPageEl.textContent = `페이지 ${state.classification.currentPageIndex + 1} / ${total}`;
  }
  if (fileNameEl) {
    fileNameEl.textContent = state.classification.currentJobName || "";
  }
}

// 페이지 목록 렌더링 (관심/비관심 분리) - 성능 최적화 버전
function renderPagesList(scrollToActive = false) {
  const interestContainer = $("classificationInterestPages");
  const nonInterestContainer = $("classificationNonInterestPages");
  const interestCountEl = $("interestPageCount");
  const nonInterestCountEl = $("nonInterestPageCount");
  
  if (!interestContainer || !nonInterestContainer) return;

  // 현재 스크롤 위치 저장
  const interestScrollPosition = interestContainer.scrollTop;
  const nonInterestScrollPosition = nonInterestContainer.scrollTop;

  // 컨테이너 초기화
  interestContainer.innerHTML = "";
  nonInterestContainer.innerHTML = "";

  // 페이지 분류 (is_interest가 1이면 관심, 0이면 비관심, 그 외는 미정)
  const interestPages = state.classification.pages.filter(p => p.is_interest === 1 || p.is_interest === true);
  const nonInterestPages = state.classification.pages.filter(p => p.is_interest === 0 || p.is_interest === false);

  // 카운트 업데이트
  if (interestCountEl) interestCountEl.textContent = `${interestPages.length}개`;
  if (nonInterestCountEl) nonInterestCountEl.textContent = `${nonInterestPages.length}개`;

  // 관심 페이지 렌더링 - DocumentFragment 사용으로 성능 최적화
  if (!interestPages.length) {
    interestContainer.innerHTML = `<div class="hint">관심 페이지가 없습니다.</div>`;
  } else {
    const fragment = document.createDocumentFragment();
    let activeItem = null;
    
    interestPages.forEach(page => {
      const item = createPageItem(page);
      if (page.page_index === state.classification.currentPageIndex) {
        item.classList.add("active");
        activeItem = item;
      }
      fragment.appendChild(item);
    });

    // 한 번에 DOM에 추가 (리플로우 최소화)
    interestContainer.appendChild(fragment);

    // 현재 선택된 페이지가 보이도록 스크롤
    if (activeItem) {
      // requestAnimationFrame을 사용하여 DOM 업데이트 후 스크롤
      requestAnimationFrame(() => {
        if (scrollToActive) {
          // scrollToActive가 true면 활성 페이지로 스크롤
          activeItem.scrollIntoView({ behavior: "smooth", block: "nearest" });
        } else {
          // 그렇지 않으면 스크롤 위치 유지
          interestContainer.scrollTop = interestScrollPosition;
        }
      });
    }
  }

  // 비관심 페이지 렌더링 - DocumentFragment 사용으로 성능 최적화
  if (!nonInterestPages.length) {
    nonInterestContainer.innerHTML = `<div class="hint">비관심 페이지가 없습니다.</div>`;
  } else {
    const fragment = document.createDocumentFragment();
    let activeItem = null;
    
    nonInterestPages.forEach(page => {
      const item = createPageItem(page);
      if (page.page_index === state.classification.currentPageIndex) {
        item.classList.add("active");
        activeItem = item;
      }
      fragment.appendChild(item);
    });

    // 한 번에 DOM에 추가 (리플로우 최소화)
    nonInterestContainer.appendChild(fragment);

    // 현재 선택된 페이지가 보이도록 스크롤
    if (activeItem) {
      // requestAnimationFrame을 사용하여 DOM 업데이트 후 스크롤
      requestAnimationFrame(() => {
        if (scrollToActive) {
          // scrollToActive가 true면 활성 페이지로 스크롤
          activeItem.scrollIntoView({ behavior: "smooth", block: "nearest" });
        } else {
          // 그렇지 않으면 스크롤 위치 유지
          nonInterestContainer.scrollTop = nonInterestScrollPosition;
        }
      });
    }
  }
}

/*
// 기존 코드 (성능 최적화 전)
// 페이지 목록 렌더링 (관심/비관심 분리)
function renderPagesList(scrollToActive = false) {
  const interestContainer = $("classificationInterestPages");
  const nonInterestContainer = $("classificationNonInterestPages");
  const interestCountEl = $("interestPageCount");
  const nonInterestCountEl = $("nonInterestPageCount");
  
  if (!interestContainer || !nonInterestContainer) return;

  // 현재 스크롤 위치 저장
  const interestScrollPosition = interestContainer.scrollTop;
  const nonInterestScrollPosition = nonInterestContainer.scrollTop;

  // 컨테이너 초기화
  interestContainer.innerHTML = "";
  nonInterestContainer.innerHTML = "";

  // 페이지 분류 (is_interest가 1이면 관심, 0이면 비관심, 그 외는 미정)
  const interestPages = state.classification.pages.filter(p => p.is_interest === 1 || p.is_interest === true);
  const nonInterestPages = state.classification.pages.filter(p => p.is_interest === 0 || p.is_interest === false);

  // 카운트 업데이트
  if (interestCountEl) interestCountEl.textContent = `${interestPages.length}개`;
  if (nonInterestCountEl) nonInterestCountEl.textContent = `${nonInterestPages.length}개`;

  // 관심 페이지 렌더링
  if (!interestPages.length) {
    interestContainer.innerHTML = `<div class="hint">관심 페이지가 없습니다.</div>`;
  } else {
    let activeItem = null;
    
    interestPages.forEach(page => {
      const item = createPageItem(page);
      if (page.page_index === state.classification.currentPageIndex) {
        item.classList.add("active");
        activeItem = item;
      }
      interestContainer.appendChild(item);
    });

    // 현재 선택된 페이지가 보이도록 스크롤
    if (activeItem) {
      // requestAnimationFrame을 사용하여 DOM 업데이트 후 스크롤
      requestAnimationFrame(() => {
        if (scrollToActive) {
          // scrollToActive가 true면 활성 페이지로 스크롤
          activeItem.scrollIntoView({ behavior: "smooth", block: "nearest" });
        } else {
          // 그렇지 않으면 스크롤 위치 유지
          interestContainer.scrollTop = interestScrollPosition;
        }
      });
    }
  }

  // 비관심 페이지 렌더링
  if (!nonInterestPages.length) {
    nonInterestContainer.innerHTML = `<div class="hint">비관심 페이지가 없습니다.</div>`;
  } else {
    let activeItem = null;
    
    nonInterestPages.forEach(page => {
      const item = createPageItem(page);
      if (page.page_index === state.classification.currentPageIndex) {
        item.classList.add("active");
        activeItem = item;
      }
      nonInterestContainer.appendChild(item);
    });

    // 현재 선택된 페이지가 보이도록 스크롤
    if (activeItem) {
      // requestAnimationFrame을 사용하여 DOM 업데이트 후 스크롤
      requestAnimationFrame(() => {
        if (scrollToActive) {
          // scrollToActive가 true면 활성 페이지로 스크롤
          activeItem.scrollIntoView({ behavior: "smooth", block: "nearest" });
        } else {
          // 그렇지 않으면 스크롤 위치 유지
          nonInterestContainer.scrollTop = nonInterestScrollPosition;
        }
      });
    }
  }
}
*/

// 페이지 아이템 생성 헬퍼 함수
function createPageItem(page) {
  const item = document.createElement("div");
  item.className = "item";
  if (page.is_interest === 1) {
    item.classList.add("interest");
  }

  // ✅ 분류 탭에서는 OCR 처리 상태에 따른 시각적 구분 제거
  // OCR 처리 탭에서만 상세 상태를 표시하도록 분리

  // ✅ 분류 탭에서는 "대기중"과 "요청 완료" 두 가지 상태만 표시
  let statusBadge = "";
  let statusIcon = "";
  
  if (page.is_interest === 1) {
    // ✅ 분류 탭 전용 상태 필드만 사용 (classification_status)
    // page.status는 OCR 처리 탭의 상태이므로 분류 탭에서는 참고하지 않음
    const classificationStatus = page.classification_status;
    
    // ✅ 명확한 상태 판단 기준 (OCR 처리와 완전히 독립적):
    // - "대기중": classification_status가 "queued"이거나, classification_status가 비어있는 경우
    // - "요청 완료": classification_status가 "requested"인 경우
    if (!classificationStatus || classificationStatus === "queued") {
      // 대기중: 아직 OCR 요청 전송 전
      statusBadge = '<span class="badge">대기중</span>';
      statusIcon = "⏸️";
    } else if (classificationStatus === "requested") {
      // ✅ 요청 완료: OCR 요청이 서버로 전송됨
      statusBadge = '<span class="badge ok">요청 완료</span>';
      statusIcon = "📤";
    } else {
      // 그 외 상태는 기본적으로 "요청 완료"로 처리
      statusBadge = '<span class="badge ok">요청 완료</span>';
      statusIcon = "📤";
    }
  }

  // 관심 여부 표시
  const interestText = page.is_interest === 1 ? "관심" : page.is_interest === 0 ? "비관심" : "미정";
  const interestIcon = page.is_interest === 1 ? "★" : page.is_interest === 0 ? "☆" : "○";
  
  // 회전 값 표시
  const rotationText = page.rotation && page.rotation !== "none" ? ` ${page.rotation}` : "";

  // ✅ 비관심 문서는 상태 정보 표시 안 함
  let hintText = "";
  if (page.is_interest === 1) {
    // ✅ 관심 문서: "대기중"과 "요청 완료" 두 가지 상태만 표시
    const classificationStatus = page.classification_status;
    let statusText = "";
    if (!classificationStatus || classificationStatus === "queued") {
      statusText = "대기중";
    } else {
      statusText = "요청 완료";
    }
    hintText = `${interestText}${rotationText}${statusText ? ` · ${statusText}` : ""}`;
  } else {
    // 비관심 문서: 관심 여부와 회전 정보만 표시
    hintText = `${interestText}${rotationText}`;
  }

  item.innerHTML = `
    <div style="min-width:0; flex:1;">
      <div style="display:flex; align-items:center; gap:4px;">
        <span>${statusIcon}</span>
        <b>페이지 ${page.page_index + 1}</b>
        <span style="color:${page.is_interest === 1 ? '#fbbf24' : '#9ca3af'}">${interestIcon}</span>
      </div>
      <div class="hint">${hintText}</div>
    </div>
    ${statusBadge}
  `;

  item.addEventListener("click", () => {
    loadPage(page.page_index);
  });

  return item;
}

// 페이지 로드
async function loadPage(pageIndex, scrollToActive = false) {
  if (pageIndex < 0 || pageIndex >= state.classification.totalPages) return;

  const page = state.classification.pages[pageIndex];
  if (!page) return;

  state.classification.currentPageIndex = pageIndex;
  
  // ✅ 중요: 페이지 로드 시 classification_status가 없으면 기본값 "queued" 설정
  if (!page.classification_status) {
    page.classification_status = "queued";
  }
  
  // 선택된 분류 페이지 인덱스를 localStorage에 저장
  try {
    localStorage.setItem("ocr_ui_classification_page_index", String(pageIndex));
  } catch (e) {
    console.warn("Failed to save classification page index:", e);
  }
  
  // 확대/축소 상태 리셋
  resetImageZoom();

  // 이미지 로드
  const imgEl = $("classificationPreviewImg");
  const currentPageEl = $("classificationCurrentPage");

  console.log("페이지 로드:", {
    pageIndex: pageIndex,
    page: page,
    hasFileId: !!page.file_id,
    hasStoredPath: !!page.stored_path
  });

  if (imgEl) {
    // file_id가 있으면 가상 파일 ID로 이미지 로드
    if (page.file_id) {
      const base = getApiBase();
      const imgUrl = base ? `${base}/api/files/${page.file_id}/image` : `/api/files/${page.file_id}/image`;
      console.log("이미지 URL:", imgUrl);
      console.log("페이지 회전 값:", page.rotation);
      
      // 먼저 회전 값 설정
      const rotation = page.rotation || "none";
      imgEl.dataset.rot = rotation;
      
      // 이미지 소스 설정
      imgEl.src = imgUrl;
      imgEl.dataset.imageUrl = imgUrl;
      
      // 이미지 로드 에러 처리
      imgEl.onerror = function() {
        console.error("이미지 로드 실패:", imgUrl);
        imgEl.style.display = "none";
      };
      
  // 이미지 로드 성공 처리
  imgEl.onload = function() {
    console.log("이미지 로드 성공:", imgUrl);
    imgEl.style.display = "block";
    // 부드러운 확대/축소를 위한 transition 설정 (popup.html과 동일)
    imgEl.style.transition = "transform 0.1s ease-out";
    // 이미지 로드 후 회전 및 스케일 조정 적용
    applyImageTransform(imgEl, page.rotation);
  };
      
      // 이미지가 이미 로드되어 있거나 캐시된 경우 즉시 회전 적용
      if (imgEl.complete) {
        console.log("이미지가 이미 로드됨, 즉시 회전 적용");
        imgEl.style.display = "block";
        applyImageTransform(imgEl, page.rotation);
      }
      
      // 이미지 클릭 시 팝업 제거
      imgEl.style.cursor = "default";
      imgEl.onclick = null;
    } else {
      // file_id가 없으면 이미지 숨기기
      console.log("file_id가 없어 이미지를 표시할 수 없습니다");
      imgEl.style.display = "none";
      imgEl.src = "";
      imgEl.onclick = null;
    }
  }

  if (currentPageEl) {
    currentPageEl.textContent = `페이지 ${pageIndex + 1} / ${state.classification.totalPages}`;
  }

  // 관심 여부 UI 업데이트
  updateInterestUI(page.is_interest === 1);
  
  // 회전 UI 업데이트
  updateRotationUI(page.rotation);

  // 페이지 목록에서 현재 페이지 하이라이트
  renderPagesList(scrollToActive);
}

// 이미지 변환 적용 (popup.html의 applyTransform 로직 재사용)
function applyImageTransform(imgEl, rotation) {
  const rot = normalizeRotation(rotation);
  let deg = 0;
  
  if (rot === "cw") deg = 90;
  else if (rot === "ccw") deg = -90;
  else if (rot === "180") deg = 180;
  
  const isRotated = Math.abs(deg) % 180 !== 0;
  
  // 확대/축소 및 이동 적용
  const zoom = state.classification.imageZoom;
  const translateX = state.classification.imageTranslateX;
  const translateY = state.classification.imageTranslateY;
  
  // 이미지 컨테이너의 실제 크기 가져오기
  const container = imgEl.parentElement;
  const containerRect = container.getBoundingClientRect();
  const containerWidth = containerRect.width;
  const containerHeight = containerRect.height;
  
  // 회전 상태와 확대/축소 상태에 따라 최대 너비/높이 조정
  if (zoom > 1) {
    // 확대 상태: 원본 이미지 크기 기준으로 제한 설정
    // 회전된 경우 너비와 높이를 바꿔서 설정
    if (isRotated) {
      imgEl.style.maxWidth = `${containerHeight}px`;
      imgEl.style.maxHeight = `${containerWidth}px`;
    } else {
      imgEl.style.maxWidth = `${containerWidth}px`;
      imgEl.style.maxHeight = `${containerHeight}px`;
    }
  } else {
    // 기본 상태면 컨테이너에 맞춤
    if (isRotated) {
      // 회전된 이미지: 너비와 높이를 서로 바꿈
      imgEl.style.maxWidth = `${containerHeight}px`;
      imgEl.style.maxHeight = `${containerWidth}px`;
    } else {
      imgEl.style.maxWidth = `${containerWidth}px`;
      imgEl.style.maxHeight = `${containerHeight}px`;
    }
  }
  
  // 회전 적용 - 중요: transform 순서를 rotate -> translate -> scale로 변경
  // popup.html과 동일한 순서로 적용해야 회전된 이미지에서 올바른 비율 유지
  if (deg !== 0 || zoom !== 1 || translateX !== 0 || translateY !== 0) {
    imgEl.style.transform = `rotate(${deg}deg) translate(${translateX}px, ${translateY}px) scale(${zoom})`;
  } else {
    imgEl.style.transform = "";
  }
  
  // 커서 스타일
  imgEl.style.cursor = zoom > 1 ? (state.classification.isDraggingImage ? 'grabbing' : 'grab') : 'default';
}

// 이미지 확대/축소
function zoomImage(delta) {
  const step = 0.12;
  const newZoom = Math.max(0.2, Math.min(6, state.classification.imageZoom + delta));
  state.classification.imageZoom = newZoom;
  
  const imgEl = $("classificationPreviewImg");
  if (imgEl) {
    const page = state.classification.pages[state.classification.currentPageIndex];
    applyImageTransform(imgEl, page?.rotation);
  }
}

// 이미지 확대/축소 리셋
function resetImageZoom() {
  state.classification.imageZoom = 1;
  state.classification.imageTranslateX = 0;
  state.classification.imageTranslateY = 0;
  
  const imgEl = $("classificationPreviewImg");
  if (imgEl) {
    const page = state.classification.pages[state.classification.currentPageIndex];
    applyImageTransform(imgEl, page?.rotation);
  }
}

// 이미지 드래그 시작
function startImageDrag(e) {
  if (state.classification.imageZoom <= 1) return;
  
  state.classification.isDraggingImage = true;
  state.classification.dragStartX = e.clientX;
  state.classification.dragStartY = e.clientY;
  state.classification.initialTranslateX = state.classification.imageTranslateX;
  state.classification.initialTranslateY = state.classification.imageTranslateY;
  
  const imgEl = $("classificationPreviewImg");
  if (imgEl) {
    imgEl.style.cursor = 'grabbing';
  }
  
  e.preventDefault();
}

// 이미지 드래그 중
function dragImage(e) {
  if (!state.classification.isDraggingImage) return;
  
  const dx = e.clientX - state.classification.dragStartX;
  const dy = e.clientY - state.classification.dragStartY;
  
  // 현재 회전 각도에 따라 이동 방향을 변환
  const page = state.classification.pages[state.classification.currentPageIndex];
  const rotation = page?.rotation || "none";
  let deg = 0;
  
  if (rotation === "cw") deg = 90;
  else if (rotation === "ccw") deg = -90;
  else if (rotation === "180") deg = 180;
  
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  
  // 화면상 드래그를 회전된 좌표계 기준으로 변환
  state.classification.imageTranslateX = state.classification.initialTranslateX + (dx * cos + dy * sin);
  state.classification.imageTranslateY = state.classification.initialTranslateY + (-dx * sin + dy * cos);
  
  const imgEl = $("classificationPreviewImg");
  if (imgEl) {
    applyImageTransform(imgEl, rotation);
  }
}

// 이미지 드래그 종료
function endImageDrag() {
  if (!state.classification.isDraggingImage) return;
  
  state.classification.isDraggingImage = false;
  
  const imgEl = $("classificationPreviewImg");
  if (imgEl) {
    imgEl.style.cursor = state.classification.imageZoom > 1 ? 'grab' : 'default';
  }
}

// 관심 여부 UI 업데이트
function updateInterestUI(isInterest) {
  const iconEl = $("classificationInterestIcon");
  if (!iconEl) return;

  iconEl.textContent = isInterest ? "★" : "☆";
}

// 회전 UI 업데이트
function updateRotationUI(rotation) {
  const btnRotateCw = $("btnClassificationRotateCw");
  if (!btnRotateCw) return;

  // 회전 상태에 따라 버튼 스타일 변경
  if (rotation === "none") {
    btnRotateCw.classList.remove("active");
    btnRotateCw.textContent = "↻";
  } else if (rotation === "cw") {
    btnRotateCw.classList.add("active");
    btnRotateCw.textContent = "↻ (90°)";
  } else if (rotation === "180") {
    btnRotateCw.classList.add("active");
    btnRotateCw.textContent = "↻ (180°)";
  } else if (rotation === "ccw") {
    btnRotateCw.classList.add("active");
    btnRotateCw.textContent = "↻ (270°)";
  }
}

// 페이지 네비게이션
function goToPrevPage() {
  if (state.classification.currentPageIndex > 0) {
    loadPage(state.classification.currentPageIndex - 1);
  }
}

function goToNextPage() {
  if (state.classification.currentPageIndex < state.classification.totalPages - 1) {
    loadPage(state.classification.currentPageIndex + 1);
  }
}

function goToPage(pageNumber) {
  const pageIndex = pageNumber - 1;
  if (pageIndex >= 0 && pageIndex < state.classification.totalPages) {
    loadPage(pageIndex, true); // scrollToActive=true로 설정하여 사이드바 스크롤
  }
}

// 관심 여부 토글
async function toggleInterest() {
  const page = state.classification.pages[state.classification.currentPageIndex];
  if (!page) return;

  const newInterest = !(page.is_interest === 1);
  updateInterestUI(newInterest);
  
  // 메모리 상태 업데이트
  page.is_interest = newInterest ? 1 : 0;
  
  // ✅ 페이지 상태 업데이트 (관심 여부에 따라 상태 변경)
  if (newInterest) {
    // 비관심 -> 관심: OCR 처리가 필요하므로 queued로 변경 (처리 대기)
    page.status = "queued";
  } else {
    // 관심 -> 비관심: 분류 완료로 처리
    page.status = "done";
  }
  
  // 사용자 변경사항 추적
  state.classification.userModifiedPages.add(page.page_index);
  
  // 사이드바 페이지 목록 즉시 갱신
  renderPagesList();
  
  // 진행률 업데이트
  updateJobInfo();
  
  // 즉시 서버에 저장
  try {
    requireApiBase();
    
    const payload = {
      is_interest: page.is_interest === 1,
      rotation: page.rotation || null,
      // ✅ classification_status도 서버에 저장
      classification_status: page.classification_status || "queued"
    };

    await api(`/api/jobs/${state.classification.currentJobId}/pages/${page.page_index}/classification`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    console.log(`페이지 ${page.page_index + 1} 관심 여부 저장됨: ${newInterest ? '관심' : '비관심'}, 상태: ${page.status}`);
    
    // 저장 완료 후 추적에서 제거 (비관심인 경우에만 제거, 관심인 경우는 유지하여 SSE 업데이트 방지)
    if (!newInterest) {
      state.classification.userModifiedPages.delete(page.page_index);
    }
  } catch (e) {
    console.error("관심 여부 저장 실패:", e);
    alert("관심 여부 저장 실패: " + e.message);
  }
}

// 회전 토글 (시계 방향으로 계속 회전)
async function toggleRotation() {
  const page = state.classification.pages[state.classification.currentPageIndex];
  if (!page) return;

  const currentRotation = page.rotation || "none";
  let newRotation;
  
  // 회전 순환: none -> cw -> 180 -> ccw -> none
  if (currentRotation === "none") {
    newRotation = "cw";
  } else if (currentRotation === "cw") {
    newRotation = "180";
  } else if (currentRotation === "180") {
    newRotation = "ccw";
  } else {
    newRotation = "none";
  }
  
  updateRotationUI(newRotation);
  
  // 메모리 상태 업데이트
  page.rotation = newRotation;
  
  // 사용자 변경사항 추적
  state.classification.userModifiedPages.add(page.page_index);
  
  // 이미지 회전 미리보기
  const imgEl = $("classificationPreviewImg");
  if (imgEl) {
    imgEl.dataset.rot = newRotation;
    applyImageTransform(imgEl, newRotation);
  }
  
  // 즉시 서버에 저장
  try {
    requireApiBase();
    
    const payload = {
      is_interest: page.is_interest === 1,
      rotation: page.rotation || null,
      // ✅ classification_status도 서버에 저장
      classification_status: page.classification_status || "queued"
    };

    await api(`/api/jobs/${state.classification.currentJobId}/pages/${page.page_index}/classification`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    console.log(`페이지 ${page.page_index + 1} 회전 정보 저장됨: ${newRotation}`);
    
    // 저장 완료 후 추적에서 제거
    state.classification.userModifiedPages.delete(page.page_index);
  } catch (e) {
    console.error("회전 정보 저장 실패:", e);
    alert("회전 정보 저장 실패: " + e.message);
  }
}

// 회전 리셋
async function resetRotation() {
  const page = state.classification.pages[state.classification.currentPageIndex];
  if (!page) return;

  // 원래 회전 상태 저장
  const originalRotation = page.rotation || "none";
  
  // 확대/축소 상태만 리셋 (회전은 원래 상태 유지)
  resetImageZoom();
  
  // 이미지 회전 미리보기 (원래 상태로)
  const imgEl = $("classificationPreviewImg");
  if (imgEl) {
    imgEl.dataset.rot = originalRotation;
    applyImageTransform(imgEl, originalRotation);
  }
  
  console.log(`페이지 ${page.page_index + 1} 확대/축소 리셋됨 (회전: ${originalRotation})`);
}

// 저장
async function saveCurrentPage() {
  if (state.classification.isSaving) return;

  const page = state.classification.pages[state.classification.currentPageIndex];
  if (!page) return;

  try {
    state.classification.isSaving = true;

    requireApiBase();
    
    const payload = {
      is_interest: page.is_interest === 1,
      rotation: page.rotation || null,
      // ✅ classification_status도 서버에 저장
      classification_status: page.classification_status || "queued"
    };

    const response = await api(`/api/jobs/${state.classification.currentJobId}/pages/${page.page_index}/classification`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    // 페이지 상태 업데이트 (관심 문서인 경우 OCR 처리 상태 설정)
    if (page.is_interest === 1) {
      // 관심 문서: OCR 처리가 시작되므로 queued 상태로 설정
      // 백엔드에서 OCR 처리를 시작하면 processing으로 변경됨
      page.status = "queued";
    } else {
      // 비관심 문서: 분류 완료로 처리
      page.status = "done";
    }
    
    // 사용자 변경사항 추적에서 제거 (저장 완료 후 SSE 업데이트 허용)
    state.classification.userModifiedPages.delete(page.page_index);
    
    // 진행률 업데이트
    updateJobInfo();
    renderPagesList();

    return true;
  } catch (e) {
    console.error("저장 실패:", e);
    alert("저장 실패: " + e.message);
    return false;
  } finally {
    state.classification.isSaving = false;
  }
}

// OCR 요청 대기열 처리 함수
async function processOcrQueue() {
  // 최대 동시 요청 수에 도달하면 대기
  if (state.classification.activeOcrRequests >= state.classification.maxConcurrentOcrRequests) {
    console.log(`OCR 대기열: 최대 동시 요청(${state.classification.maxConcurrentOcrRequests}) 도달, 대기 중...`);
    return;
  }

  // 대기열에서 요청 가져오기
  const request = state.classification.ocrQueue.shift();
  if (!request) {
    console.log("OCR 대기열: 처리할 요청 없음");
    return;
  }

  const { page_no, is_interest, rotation, resolve, reject } = request;
  const page_index = page_no - 1;

  // 활성 요청 수 증가
  state.classification.activeOcrRequests++;
  console.log(`OCR 요청 시작: 페이지 ${page_no} (활성 요청: ${state.classification.activeOcrRequests}/${state.classification.maxConcurrentOcrRequests})`);

  // ✅ 중요: 분류 탭에서는 "요청 완료" 상태로만 표시
  const page = state.classification.pages.find(p => p.page_index === page_index);
  if (page) {
    page.classification_status = "requested"; // 분류 탭 전용 상태: 요청 완료
    renderPagesList(); // 즉시 UI 갱신
  }

  try {
    requireApiBase();
    
    const payload = {
      reprocess: true,
      is_interest: is_interest,
      rotation: rotation || null
    };
    
    await api(`/api/jobs/${state.classification.currentJobId}/pages/${page_no}/override`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    
    console.log(`페이지 ${page_no} OCR 재처리 요청됨`);
    
    // 페이지 목록 새로고침
    await refreshCurrentJobPages();
    console.log(`페이지 ${page_no} 상태 갱신됨`);
    
    resolve();
  } catch (e) {
    console.error(`페이지 ${page_no} OCR 재처리 요청 실패:`, e);
    // ✅ 에러 발생 시 상태를 error로 변경
    const errorPage = state.classification.pages.find(p => p.page_index === page_index);
    if (errorPage) {
      errorPage.status = "error";
      renderPagesList();
    }
    reject(e);
  } finally {
    // 활성 요청 수 감소
    state.classification.activeOcrRequests--;
    console.log(`OCR 요청 완료: 페이지 ${page_no} (활성 요청: ${state.classification.activeOcrRequests}/${state.classification.maxConcurrentOcrRequests})`);
    
    // 다음 대기열 요청 처리
    processOcrQueue();
  }
}

// OCR 요청을 대기열에 추가
function queueOcrRequest(page_no, is_interest, rotation) {
  return new Promise((resolve, reject) => {
    const page_index = page_no - 1;
    
    // ✅ 중요: 대기열에 추가할 때 상태를 queued로 설정 (대기 중임을 표시)
    const page = state.classification.pages.find(p => p.page_index === page_index);
    if (page) {
      page.status = "queued";
      renderPagesList(); // 즉시 UI 갱신하여 대기 상태 표시
    }
    
    state.classification.ocrQueue.push({
      page_no,
      is_interest,
      rotation,
      resolve,
      reject
    });
    
    console.log(`OCR 대기열에 추가: 페이지 ${page_no} (대기열 크기: ${state.classification.ocrQueue.length})`);
    
    // 대기열 처리 시작
    processOcrQueue();
  });
}

// 저장 + 다음 + OCR 재처리
async function saveAndNext() {
  const page = state.classification.pages[state.classification.currentPageIndex];
  if (!page) return;

  // ✅ 중요: 처리 버튼은 항상 관심으로 변경 후 처리
  // 1. 먼저 관심으로 변경 (A 버튼 효과)
  if (page.is_interest !== 1) {
    page.is_interest = 1;
    updateInterestUI(true);
    
    // 사용자 변경사항 추적
    state.classification.userModifiedPages.add(page.page_index);
    
    // 사이드바 페이지 목록 즉시 갱신
    renderPagesList();
  }
  
  const isInterest = true; // 항상 관심으로 처리
  const page_no = page.page_index + 1;

  // ✅ 중요: 저장 전에 classification_status를 "requested"로 설정 (요청 완료 상태)
  page.classification_status = "requested";
  
  // 저장
  const saved = await saveCurrentPage();
  if (saved) {
    // ✅ 중요: 저장 성공 후 즉시 "요청 완료" 상태로 UI 업데이트
    page.classification_status = "requested";
    renderPagesList();
    
    // 관심 문서인 경우 OCR 재처리 요청 (대기열 사용)
    try {
      // 대기열에 요청 추가 (최대 4개 동시 처리)
      await queueOcrRequest(page_no, isInterest, page.rotation);
    } catch (e) {
      console.error("OCR 재처리 요청 실패:", e);
      alert(`OCR 재처리 요청 실패: ${e.message}`);
      // 재처리 실패해도 다음 페이지로 이동
    }
    
    // ✅ 중요: 다음 페이지로 이동할 때 classification_status 유지
    // 다음 페이지의 classification_status가 이미 설정되어 있으면 유지
    const nextPageIndex = state.classification.currentPageIndex + 1;
    if (nextPageIndex < state.classification.totalPages) {
      const nextPage = state.classification.pages[nextPageIndex];
      if (nextPage && !nextPage.classification_status) {
        // classification_status가 없으면 기본값 "queued" 설정
        nextPage.classification_status = "queued";
      }
    }
    
    // 다음 페이지로 이동
    goToNextPage();
  }
}

// 관심 페이지 일괄 처리
async function batchProcessInterestPages() {
  if (!state.classification.currentJobId) {
    alert("작업을 선택해주세요.");
    return;
  }

  // 관심 페이지 필터링 (OCR 처리가 완료되지 않은 페이지만)
  const interestPages = state.classification.pages.filter(p => 
    p.is_interest === 1 && p.status !== 'done'
  );
  
  if (!interestPages.length) {
    alert("처리할 관심 페이지가 없습니다.\n이미 OCR 처리가 완료된 페이지만 있습니다.");
    return;
  }

  // 전체 관심 페이지 수와 처리할 페이지 수 확인
  const totalInterestPages = state.classification.pages.filter(p => p.is_interest === 1).length;
  const alreadyProcessedCount = totalInterestPages - interestPages.length;
  
  let confirmMessage = `${interestPages.length}개의 관심 페이지를 OCR 처리로 전송하시겠습니까?\n\n`;
  if (alreadyProcessedCount > 0) {
    confirmMessage += `이미 처리 완료된 ${alreadyProcessedCount}개의 페이지는 제외됩니다.\n`;
  }
  confirmMessage += `각 페이지의 is_interest와 rotation 정보가 함께 전송됩니다.`;
  
  if (!confirm(confirmMessage)) {
    return;
  }

  try {
    requireApiBase();
    
    let successCount = 0;
    let failCount = 0;
    let skippedCount = 0;
    
    for (const page of interestPages) {
      const page_no = page.page_index + 1;
      
      // 이미 처리 중이거나 완료된 페이지는 건너뜀
      if (page.status === 'processing' || page.status === 'done') {
        console.log(`페이지 ${page_no}는 이미 ${page.status} 상태입니다. 건너뜁니다.`);
        skippedCount++;
        continue;
      }
      
      try {
        const payload = {
          reprocess: true,
          is_interest: true,
          rotation: page.rotation || null
        };
        
        await api(`/api/jobs/${state.classification.currentJobId}/pages/${page_no}/override`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        
        console.log(`페이지 ${page_no} OCR 재처리 요청됨 (is_interest: ${payload.is_interest}, rotation: ${payload.rotation})`);
        successCount++;
      } catch (e) {
        console.error(`페이지 ${page_no} OCR 재처리 요청 실패:`, e);
        failCount++;
      }
    }
    
    let resultMessage = `일괄 처리 완료:\n성공: ${successCount}개`;
    if (failCount > 0) {
      resultMessage += `\n실패: ${failCount}개`;
    }
    if (skippedCount > 0) {
      resultMessage += `\n건너뜀: ${skippedCount}개 (이미 처리 중/완료)`;
    }
    
    alert(resultMessage);
    
    // 일괄 처리 완료 후 페이지 목록 새로고침
    if (successCount > 0) {
      console.log("일괄 처리 완료, 페이지 목록 새로고침");
      await refreshCurrentJobPages();
    }
    
  } catch (e) {
    console.error("일괄 처리 실패:", e);
    alert("일괄 처리 실패: " + e.message);
  }
}

// PDF 업로드 (분류 탭 전용: 업로드만 수행, 자동 분류 없음)
async function uploadClassificationPdf() {
  const fileInput = $("classificationPdfFile");
  if (!fileInput || !fileInput.files || !fileInput.files[0]) {
    alert("PDF를 선택해주세요.");
    return;
  }

  try {
    const file = fileInput.files[0];
    const dpi = parseInt($("classificationPdfDpi").value) || 300;
    const rotation = $("classificationPdfRotation").value;

    console.log("PDF 업로드 시작 (분류 탭 전용):", {
      fileName: file.name,
      fileSize: file.size,
      dpi: dpi,
      rotation: rotation
    });

    const formData = new FormData();
    formData.append("file", file);
    formData.append("dpi", dpi);
    if (rotation) {
      formData.append("rotation", rotation);
    }

    // ✅ 업로드 시작 전 SSE 연결 완전 중지 (실시간 업데이트 부하 제거)
    console.log("업로드 시작: SSE 연결 중지");
    stopClassificationEvents();
    
    // ✅ 즉시 UI 피드백: 업로드 버튼 비활성화 및 로딩 표시
    const btnUploadPdf = $("btnClassificationUploadPdf");
    if (btnUploadPdf) {
      btnUploadPdf.disabled = true;
      btnUploadPdf.textContent = "업로드 중...";
    }

    // 분류 탭 전용 엔드포인트 사용: 자동 분류 없이 업로드만 수행
    const response = await api("/api/upload/pdf/classification", {
      method: "POST",
      body: formData,
    });

    console.log("PDF 업로드 응답:", response);

    // ✅ 업로드 완료 후 작업 완료 대기 (가벼운 폴링으로 진행률만 표시)
    console.log("업로드 완료: 작업 완료 대기 시작");
    await waitForJobCompletion(response.job_id);
    
    // ✅ 작업 완료 후 일괄로 데이터 로드
    console.log("작업 완료: 일괄 데이터 로드 시작");
    await loadJobs(); // 전체 작업 목록 새로고침
    await selectJob(response.job_id); // 새 작업 선택 및 데이터 로드
    
    // ✅ 모든 데이터 로드 완료 후 SSE 연결 재개
    console.log("데이터 로드 완료: SSE 연결 재개");
    startClassificationEvents();
    
    // 파일 입력 초기화
    clearFileInput("classificationPdfFile");
    
    // ✅ 업로드 버튼 상태 복원
    if (btnUploadPdf) {
      btnUploadPdf.disabled = false;
      btnUploadPdf.textContent = "PDF 업로드";
    }
    
  } catch (e) {
    console.error("PDF 업로드 실패:", e);
    console.error("에러 상세:", {
      message: e.message,
      status: e.status,
      body: e.body
    });
    
    // ✅ 에러 발생 시에도 SSE 연결 재개
    console.log("에러 발생: SSE 연결 재개");
    startClassificationEvents();
    
    alert("PDF 업로드 실패: " + e.message);
    
    // ✅ 에러 시 업로드 버튼 상태 복원
    const btnUploadPdf = $("btnClassificationUploadPdf");
    if (btnUploadPdf) {
      btnUploadPdf.disabled = false;
      btnUploadPdf.textContent = "PDF 업로드";
    }
  }
}

// ✅ 새로운 함수: 작업 완료 대기 (가벼운 폴링으로 진행률만 표시)
async function waitForJobCompletion(jobId, timeoutMs = 300000) { // 최대 5분 대기
  const startTime = Date.now();
  const checkInterval = 3000; // 3초마다 확인 (널널한 주기로 부하 최소화)
  
  console.log(`작업 완료 대기 시작: ${jobId}`);
  
  while (true) {
    // 타임아웃 체크
    if (Date.now() - startTime > timeoutMs) {
      throw new Error("작업 완료 대기 시간 초과");
    }
    
    try {
      // ✅ 가벼운 상태 확인 API만 호출 (전체 데이터 아님)
      const jobData = await api(`/api/jobs/${jobId}`);
      const job = jobData.job;
      
      console.log(`작업 상태 확인: ${job.status}`);
      
      // 작업 완료 확인
      if (job.status === "done") {
        console.log("작업 완료!");
        return;
      }
      
      // 에러 상태 확인
      if (job.status === "error" || job.status === "cancelled") {
        throw new Error(`작업 실패: ${job.status} - ${job.error || "알 수 없는 오류"}`);
      }
      
      // ✅ 진행률 표시 (가벼운 UI 업데이트만 수행)
      const total = job.progress?.total || 0;
      const done = job.progress?.done || 0;
      const percentage = total > 0 ? Math.round((done / total) * 100) : 0;
      
      const btnUploadPdf = $("btnClassificationUploadPdf");
      if (btnUploadPdf) {
        btnUploadPdf.textContent = `처리 중... ${percentage}% (${done}/${total}페이지)`;
      }
      
      console.log(`작업 진행 중: ${done}/${total} (${percentage}%)`);
      
    } catch (e) {
      // API 호출 실패 시 재시도
      console.warn("작업 상태 확인 실패, 재시도:", e);
    }
    
    // 3초 대기 후 다시 확인 (널널한 주기)
    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }
}

// UI 바인딩
function bindClassificationUi() {
  // 이미지 확대/축소 및 드래그 이벤트
  const imgEl = $("classificationPreviewImg");
  if (imgEl) {
    // 마우스 휠로 확대/축소 (Ctrl + 휠로 작동 - popup.html과 동일)
    imgEl.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.12 : -0.12;
      zoomImage(delta);
    }, { passive: false });
    
    // 마우스 드래그로 이동
    imgEl.addEventListener("mousedown", startImageDrag);
    document.addEventListener("mousemove", dragImage);
    document.addEventListener("mouseup", endImageDrag);
    document.addEventListener("mouseleave", endImageDrag);
    
    // 더블클릭으로 리셋
    imgEl.addEventListener("dblclick", () => {
      resetImageZoom();
    });
  }
  
  // PDF 업로드
  const btnUploadPdf = $("btnClassificationUploadPdf");
  const btnClearPdf = $("btnClassificationClearPdf");
  
  if (btnUploadPdf) {
    btnUploadPdf.addEventListener("click", uploadClassificationPdf);
  }
  
  if (btnClearPdf) {
    btnClearPdf.addEventListener("click", () => {
      clearFileInput("classificationPdfFile");
    });
  }

  // 작업 상태 필터
  const jobStatusFilter = $("classificationJobStatusFilter");
  if (jobStatusFilter) {
    jobStatusFilter.addEventListener("change", () => {
      state.classification.jobStatusFilter = jobStatusFilter.value;
      loadJobs();
    });
  }

  // 작업 검색
  const jobSearch = $("classificationJobSearch");
  if (jobSearch) {
    jobSearch.addEventListener("input", () => {
      state.classification.jobSearch = jobSearch.value;
      loadJobs();
    });
  }

  // 페이지 필터
  const pageFilter = $("classificationPageFilter");
  if (pageFilter) {
    pageFilter.addEventListener("change", () => {
      state.classification.filter = pageFilter.value;
      renderPagesList();
    });
  }

  // 페이지 네비게이션 버튼
  const btnPrev = $("btnClassificationPrevPage");
  const btnNext = $("btnClassificationNextPage");
  const btnPageGo = $("btnClassificationPageGo");
  const pageGoInput = $("classificationPageGo");

  if (btnPrev) btnPrev.addEventListener("click", goToPrevPage);
  if (btnNext) btnNext.addEventListener("click", goToNextPage);
  
  if (btnPageGo && pageGoInput) {
    const handlePageGo = () => {
      const page = parseInt(pageGoInput.value);
      if (!isNaN(page)) {
        goToPage(page);
        pageGoInput.value = "";
      }
    };
    
    btnPageGo.addEventListener("click", handlePageGo);
    
    // Enter 키로 페이지 이동
    pageGoInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handlePageGo();
      } else if (e.key === "Escape") {
        e.preventDefault();
        pageGoInput.blur();
      }
    });
  }

  // 관심/비관심 토글
  const btnToggleInterest = $("btnClassificationToggleInterest");
  if (btnToggleInterest) {
    btnToggleInterest.addEventListener("click", toggleInterest);
  }

  // 회전 버튼
  const btnRotateCw = $("btnClassificationRotateCw");
  if (btnRotateCw) {
    btnRotateCw.addEventListener("click", toggleRotation);
  }

  // 리셋 버튼
  const btnReset = $("btnClassificationReset");
  if (btnReset) {
    btnReset.addEventListener("click", resetRotation);
  }

  // 저장 버튼
  const btnSaveAndNext = $("btnClassificationSaveAndNext");
  if (btnSaveAndNext) {
    btnSaveAndNext.addEventListener("click", saveAndNext);
  }

  // 도움말
  const btnHelp = $("btnClassificationHelp");
  const btnHelpClose = $("btnClassificationHelpClose");
  const helpDrawer = $("classificationHelpDrawer");

  if (btnHelp && helpDrawer) {
    btnHelp.addEventListener("click", () => {
      helpDrawer.classList.toggle("hidden");
    });
  }

  if (btnHelpClose && helpDrawer) {
    btnHelpClose.addEventListener("click", () => {
      helpDrawer.classList.add("hidden");
    });
  }

  // 단축키
  document.addEventListener("keydown", (e) => {
    // 분류 페이지가 활성화되어 있을 때만
    const classificationScreen = $("screenClassification");
    if (!classificationScreen || classificationScreen.classList.contains("hidden")) return;

    // 입력 필드에서는 단축키 무시
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        goToPrevPage();
        break;
      case "ArrowRight":
        e.preventDefault();
        goToNextPage();
        break;
      case "a":
      case "A":
        e.preventDefault();
        toggleInterest();
        break;
      case "s":
      case "S":
        e.preventDefault();
        toggleRotation();
        break;
      case "r":
      case "R":
        e.preventDefault();
        resetRotation();
        break;
      case "d":
      case "D":
        e.preventDefault();
        saveAndNext();
        break;
      case "g":
      case "G":
        e.preventDefault();
        pageGoInput?.focus();
        break;
      case "h":
      case "H":
        e.preventDefault();
        helpDrawer?.classList.toggle("hidden");
        break;
    }
  });
}

// SSE 이벤트 시작
function startClassificationEvents() {
  if (state.classification.eventSource) {
    state.classification.eventSource.close();
    state.classification.eventSource = null;
  }

  try {
    requireApiBase();
    const base = getApiBase();
    
    // API Base URL 유효성 검증
    if (!base) {
      console.error("SSE 연결 실패: API Base URL이 설정되지 않았습니다.");
      console.error("현재 설정된 API Base:", base);
      alert("SSE 연결 실패: API 주소가 설정되지 않았습니다.\n\n설정에서 API 주소를 확인해주세요.");
      return;
    }
    
    const eventsUrl = `${base}/api/jobs/events`;
    console.log("SSE 연결 시도:", eventsUrl);
    
    state.classification.eventSource = new EventSource(eventsUrl);
    
    state.classification.eventSource.addEventListener("jobs", (e) => {
      try {
        const data = JSON.parse(e.data);
        console.log("SSE jobs 이벤트 수신:", data);
        console.log("현재 선택된 작업 ID:", state.classification.currentJobId);
        
        // ✅ 성능 최적화: 작업 상태 감지 (현재 작업만 체크)
        const currentJob = data.jobs?.find(j => j.job_id === state.classification.currentJobId);
        state.classification.isProcessing = currentJob && (currentJob.status === "processing" || currentJob.status === "queued");
        
        // ✅ 작업 완료 감지
        const completedJob = data.jobs?.find(j => 
          j.job_id === state.classification.currentJobId && 
          (j.status === "done" || j.status === "error")
        );
        
        if (completedJob) {
          // 작업 완료 시 즉시 업데이트
          console.log("작업 완료 감지, 즉시 업데이트");
          state.classification.isProcessing = false;
          loadJobs();
          if (state.classification.currentJobId) {
            refreshCurrentJobPages().catch(err => {
              console.error("페이지 목록 새로고침 실패:", err);
            });
          }
          return;
        }
        
        // ✅ 작업 중에는 5초에 한 번만 UI 업데이트
        if (state.classification.isProcessing) {
          if (!state.classification.pendingUpdate) {
            state.classification.pendingUpdate = true;
            console.log("작업 중, 5초 후 UI 업데이트 예약");
            if (state.classification.processingUpdateTimer) {
              clearTimeout(state.classification.processingUpdateTimer);
            }
            state.classification.processingUpdateTimer = setTimeout(() => {
              console.log("작업 중 UI 업데이트 실행");
              loadJobs();
              if (state.classification.currentJobId) {
                refreshCurrentJobPages().catch(err => {
                  console.error("페이지 목록 새로고침 실패:", err);
                });
              }
              state.classification.pendingUpdate = false;
              state.classification.processingUpdateTimer = null;
            }, 5000);
          }
          return; // 즉시 반환 (UI 업데이트 지연)
        }
        
        // ✅ 작업 중이 아니면 기존 디바운싱 로직 사용
        // 디바운싱 적용: 작업 목록 새로고침 (500ms)
        if (state.classification.jobsUpdateDebounceTimer) {
          clearTimeout(state.classification.jobsUpdateDebounceTimer);
        }
        state.classification.jobsUpdateDebounceTimer = setTimeout(() => {
          console.log("loadJobs() 호출 시작");
          loadJobs().then(() => {
            console.log("loadJobs() 완료");
          }).catch(err => {
            console.error("loadJobs() 실패:", err);
          });
          state.classification.jobsUpdateDebounceTimer = null;
        }, 500);
        
        // 현재 선택된 작업이 업데이트되면 페이지 목록도 새로고침
        if (state.classification.currentJobId) {
          const updatedJob = data.jobs?.find(j => j.job_id === state.classification.currentJobId);
          console.log("현재 작업 찾음:", updatedJob);
          if (updatedJob) {
            console.log("현재 작업 업데이트됨, 페이지 목록 새로고침");
            // 디바운싱 적용: 페이지 목록 새로고침 (300ms)
            if (state.classification.pagesUpdateDebounceTimer) {
              clearTimeout(state.classification.pagesUpdateDebounceTimer);
            }
            state.classification.pagesUpdateDebounceTimer = setTimeout(() => {
              refreshCurrentJobPages().catch(err => {
                console.error("페이지 목록 새로고침 실패:", err);
              });
              state.classification.pagesUpdateDebounceTimer = null;
            }, 300);
          } else {
            console.log("현재 작업이 업데이트 목록에 없음");
          }
        }
      } catch (err) {
        console.error("SSE 이벤트 파싱 실패:", err);
      }
    });
    
    state.classification.eventSource.addEventListener("ping", (e) => {
      // 핑 메시지는 무시 (연결 유지용)
    });
    
    state.classification.eventSource.onerror = (err) => {
      console.error("SSE 연결 오류:", err);
      console.error("EventSource 상태:", state.classification.eventSource?.readyState);
      console.error("연결 URL:", eventsUrl);
      
      // 연결이 끊어지면 재시도 (최대 5번 시도)
      if (!state.classification.sseRetryCount) {
        state.classification.sseRetryCount = 0;
      }
      
      if (state.classification.sseRetryCount < 5) {
        state.classification.sseRetryCount++;
        const retryDelay = 3000 * state.classification.sseRetryCount; // 3초, 6초, 9초, 12초, 15초
        console.log(`SSE 재연결 시도 (${state.classification.sseRetryCount}/5) - ${retryDelay}ms 후`);
        
        setTimeout(() => {
          if (state.classification.eventSource) {
            startClassificationEvents();
          }
        }, retryDelay);
      } else {
        console.error("SSE 재연결 시도 횟수 초과 (5회). 연결을 중단합니다.");
        alert("SSE 연결 실패: 서버와의 연결을 유지할 수 없습니다.\n\n페이지를 새로고침하거나 API 주소를 확인해주세요.");
        state.classification.eventSource = null;
        state.classification.sseRetryCount = 0;
      }
    };
    
    // 연결 성공 시 재시도 카운트 초기화
    state.classification.eventSource.addEventListener("open", () => {
      console.log("SSE 연결 성공:", eventsUrl);
      state.classification.sseRetryCount = 0;
    });
    
    console.log("분류 페이지 SSE 연결 시작됨");
  } catch (e) {
    console.error("SSE 연결 실패:", e);
    console.error("에러 상세:", e.message, e.stack);
    alert("SSE 연결 실패: " + e.message + "\n\n페이지를 새로고침하거나 API 주소를 확인해주세요.");
  }
}

// 현재 작업의 페이지 목록 새로고침
async function refreshCurrentJobPages() {
  if (!state.classification.currentJobId) return;
  
  try {
    console.log("페이지 목록 새로고침 시작:", state.classification.currentJobId);
    const pagesData = await api(`/api/jobs/${state.classification.currentJobId}/pages`);
    if (pagesData && pagesData.pages) {
      console.log("페이지 데이터 수신:", pagesData.pages.length, "개");
      
      // 기존 페이지 상태 유지하면서 업데이트
      const oldPages = state.classification.pages;
      const newPages = pagesData.pages;
      
      // 페이지 상태 병합
      state.classification.pages = newPages.map(newPage => {
        const oldPage = oldPages.find(p => p.page_index === newPage.page_index);
        if (oldPage) {
          // 사용자가 아직 저장하지 않은 변경사항이 있는지 확인
          const isUserModified = state.classification.userModifiedPages.has(newPage.page_index);
          
          if (isUserModified) {
            // 사용자가 변경한 페이지: 사용자의 is_interest, rotation, status, classification_status 유지
            // 비관심 → 관심 전환 시 queued 상태가 유지되도록 status도 사용자 상태 반영
            return {
              ...newPage,
              is_interest: oldPage.is_interest !== undefined ? oldPage.is_interest : newPage.is_interest,
              rotation: oldPage.rotation !== undefined ? oldPage.rotation : newPage.rotation,
              status: oldPage.status !== undefined ? oldPage.status : newPage.status,
              classification_status: oldPage.classification_status !== undefined ? oldPage.classification_status : newPage.classification_status,
              // file_id, stored_path 등은 서버 상태 반영
              file_id: newPage.file_id,
              stored_path: newPage.stored_path
            };
            } else {
                // ✅ 중요: 대기열 처리 중인 페이지의 상태 유지
                // 클라이언트에서 설정한 queued/processing 상태가 SSE 업데이트로 덮어쓰이지 않도록 함
                // 단, 서버에서 "done" 또는 "error" 상태가 오면 무조건 반영 (OCR 완료 또는 오류 처리)
                const isInQueue = state.classification.ocrQueue.some(req => req.page_no === newPage.page_index + 1);
                const isProcessing = oldPage.status === "processing" && state.classification.activeOcrRequests > 0;
                const isQueued = oldPage.status === "queued" && isInQueue;
                
                // ✅ 디버깅 로그 추가
                console.log(`🔍 페이지 ${newPage.page_index + 1} 상태 비교:`, {
                    oldStatus: oldPage.status,
                    newStatus: newPage.status,
                    isInQueue,
                    activeOcrRequests: state.classification.activeOcrRequests,
                    isProcessing,
                    isQueued,
                    ocrQueueLength: state.classification.ocrQueue.length
                });
                
                // ✅ 분류 탭에서는 OCR 처리 상태를 단순화
                // "요청 완료"까지만 표시하고, 실제 OCR 처리 완료는 OCR 처리 탭에서만 관리
                // 서버에서 done/error 상태가 와도 분류 탭에서는 "요청 완료" 상태 유지
                if (newPage.status === "done" || newPage.status === "error") {
                    // OCR 완료/오류: 분류 탭에서는 "요청 완료" 상태 유지
                    console.log(`✅ 페이지 ${newPage.page_index + 1} OCR ${newPage.status === 'done' ? '완료' : '오류'} 감지, 분류 탭에서는 "요청 완료" 상태 유지`);
                    return {
                        ...newPage,
                        classification_status: "requested", // 분류 탭 전용 상태 필드
                        status: newPage.status // 실제 OCR 상태는 유지 (OCR 처리 탭에서 사용)
                    };
                }
                
                if (isProcessing || isQueued) {
                    // 아직 처리 중: 클라이언트 상태 유지
                    console.log(`⏳ 페이지 ${newPage.page_index + 1} 아직 처리 중, 클라이언트 상태 유지: ${oldPage.status}`);
                    return {
                        ...newPage,
                        status: oldPage.status, // 클라이언트 상태 유지 (queued 또는 processing)
                        // file_id, stored_path 등은 서버 상태 반영
                        file_id: newPage.file_id,
                        stored_path: newPage.stored_path
                    };
                } else {
                    // 사용자가 변경하지 않은 페이지: 서버 상태 그대로 사용 (OCR 처리 상태 포함)
                    console.log(`🔄 페이지 ${newPage.page_index + 1} 서버 상태 반영: ${newPage.status}`);
                    return newPage;
                }
            }
        }
        return newPage;
      });
      
      console.log("페이지 상태 병합 완료, 렌더링 시작");
      renderPagesList();
      updateJobInfo();
      
      // 현재 로드된 페이지의 이미지만 다시 로드 (file_id가 변경되었을 수 있음)
      const currentPage = state.classification.pages[state.classification.currentPageIndex];
      if (currentPage) {
        // loadPage 대신 이미지만 다시 로드 (이중 렌더링 방지)
        const imgEl = $("classificationPreviewImg");
        if (imgEl && currentPage.file_id) {
          const base = getApiBase();
          const imgUrl = base ? `${base}/api/files/${currentPage.file_id}/image` : `/api/files/${currentPage.file_id}/image`;
          if (imgEl.src !== imgUrl) {
            console.log("이미지 다시 로드:", imgUrl);
            imgEl.src = imgUrl;
          }
        }
      }
      
      console.log("페이지 목록 새로고침 완료");
    }
  } catch (e) {
    console.error("페이지 목록 새로고침 실패:", e);
  }
}

// SSE 이벤트 중지
function stopClassificationEvents() {
  if (state.classification.eventSource) {
    state.classification.eventSource.close();
    state.classification.eventSource = null;
    console.log("분류 페이지 SSE 연결 종료됨");
  }
}

// 가상 스크롤 클래스 - 대용량 리스트 성능 최적화
class VirtualScroll {
  constructor(container, items, itemHeight, createItemFn, onItemClickFn) {
    this.container = container;
    this.items = items; // 전체 아이템 배열 (JavaScript 객체)
    this.itemHeight = itemHeight; // 각 아이템의 높이
    this.createItemFn = createItemFn; // 아이템 DOM 생성 함수
    this.onItemClickFn = onItemClickFn; // 아이템 클릭 핸들러
    
    // 화면에 보이는 아이템 수 계산 (여유분 포함)
    this.visibleCount = Math.ceil(container.clientHeight / itemHeight) + 5;
    
    // 스크롤 위치 추적
    this.scrollTop = 0;
    
    // 초기화
    this.init();
  }
  
  init() {
    // 컨테이너 높이 설정 (전체 아이템 높이)
    this.container.style.height = `${this.items.length * this.itemHeight}px`;
    this.container.style.position = 'relative';
    
    // 초기 렌더링
    this.renderVisibleItems();
    
    // 스크롤 이벤트 리스너 (throttle 적용)
    let scrollTimeout;
    this.container.addEventListener('scroll', () => {
      if (scrollTimeout) {
        return;
      }
      
      scrollTimeout = requestAnimationFrame(() => {
        this.renderVisibleItems();
        scrollTimeout = null;
      });
    });
    
    // 윈도우 리사이즈 시 visibleCount 재계산
    window.addEventListener('resize', () => {
      this.visibleCount = Math.ceil(this.container.clientHeight / this.itemHeight) + 5;
      this.renderVisibleItems();
    });
  }
  
  renderVisibleItems() {
    const scrollTop = this.container.scrollTop;
    this.scrollTop = scrollTop;
    
    // 보이는 아이템 범위 계산
    const startIndex = Math.floor(scrollTop / this.itemHeight);
    const endIndex = Math.min(startIndex + this.visibleCount, this.items.length);
    
    // 기존 DOM 제거
    this.container.innerHTML = '';
    
    // 보이는 아이템만 DOM 생성
    const fragment = document.createDocumentFragment();
    
    for (let i = startIndex; i < endIndex; i++) {
      const item = this.items[i];
      const dom = this.createItemFn(item);
      
      // 절대 위치 설정
      dom.style.position = 'absolute';
      dom.style.top = `${i * this.itemHeight}px`;
      dom.style.left = '0';
      dom.style.right = '0';
      dom.style.width = '100%';
      
      // 클릭 이벤트 추가
      dom.addEventListener('click', () => {
        if (this.onItemClickFn) {
          this.onItemClickFn(item);
        }
      });
      
      fragment.appendChild(dom);
    }
    
    // 한 번에 DOM에 추가
    this.container.appendChild(fragment);
  }
  
  // 아이템 목록 업데이트
  updateItems(newItems) {
    this.items = newItems;
    this.container.style.height = `${this.items.length * this.itemHeight}px`;
    this.renderVisibleItems();
  }
  
  // 특정 아이템으로 스크롤
  scrollToItem(itemIndex, behavior = 'smooth') {
    const targetScrollTop = itemIndex * this.itemHeight;
    this.container.scrollTo({
      top: targetScrollTop,
      behavior: behavior
    });
  }
  
  // 현재 스크롤 위치 가져오기
  getScrollTop() {
    return this.scrollTop;
  }
  
  // 스크롤 위치 설정하기
  setScrollTop(scrollTop) {
    this.container.scrollTop = scrollTop;
  }
  
  // 파괴 (이벤트 리스너 제거)
  destroy() {
    this.container.innerHTML = '';
    this.container.style.height = '';
    this.container.style.position = '';
  }
}

/*
// 기존 코드 (가상 스크롤 추가 전)
// 초기화
async function initClassification() {
  bindClassificationUi();
  startClassificationEvents();
}
*/

// 초기화
async function initClassification() {
  bindClassificationUi();
  startClassificationEvents();
}

export {
  initClassification,
  loadJobs,
  selectJob,
  loadPage,
  goToPrevPage,
  goToNextPage,
  goToPage,
  toggleInterest,
  toggleRotation,
  saveCurrentPage,
  saveAndNext,
};
