/**
 * VLM Model Management
 * VLM 모델 스위칭 및 관리 기능
 */

// API 기본 URL 가져오기 (api.js와 통합)
function getVlmApiBase() {
  // 무한 재귀 방지를 위해 직접 함수 호출하지 않음
  // localStorage에서 API 주소 가져오기
  try {
    const saved = localStorage.getItem("OCR_API_BASE");
    if (saved && saved.trim()) {
      return saved.trim();
    }
  } catch (e) {
    console.warn("localStorage access failed:", e);
  }
  // 기본값 반환
  return 'http://127.0.0.1:8010';
}

class VLMManager {
  constructor() {
    this.currentModel = null;
    this.availableModels = {};
    this.selectElement = null;
    this.apiBase = getVlmApiBase();
    console.log('VLM API Base:', this.apiBase);
    this.init();
  }

  async init() {
    this.selectElement = document.getElementById('vlmModelSelect');
    if (!this.selectElement) {
      console.warn('VLM model selector not found');
      return;
    }

    // 이벤트 리스너 등록
    this.selectElement.addEventListener('change', (e) => this.handleModelChange(e));

    // 초기 데이터 로드
    await this.loadAvailableModels();
    await this.loadCurrentModel();
  }

  async loadAvailableModels() {
    try {
      console.log('Loading available VLM models...');
      const response = await fetch(`${this.apiBase}/api/vlm/models`);
      console.log('Response status:', response.status);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('Error response:', errorText);
        throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
      }
      
      const data = await response.json();
      console.log('Available models data:', data);
      
      this.availableModels = data.models || {};
      
      if (Object.keys(this.availableModels).length === 0) {
        console.warn('No available models found');
        this.selectElement.innerHTML = '<option value="" disabled selected>사용 가능한 모델 없음</option>';
        return;
      }
      
      this.populateModelSelector();
    } catch (error) {
      console.error('Failed to load available VLM models:', error);
      this.selectElement.innerHTML = '<option value="" disabled selected>로드 실패</option>';
      this.showError('VLM 모델 목록 로드 실패: ' + error.message);
    }
  }

  async loadCurrentModel() {
    try {
      console.log('Loading current VLM model...');
      const response = await fetch(`${this.apiBase}/api/vlm/current`);
      console.log('Current model response status:', response.status);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('Error response:', errorText);
        throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
      }
      
      const data = await response.json();
      console.log('Current model data:', data);
      
      this.currentModel = data.current_model;
      
      if (this.currentModel && this.selectElement) {
        this.selectElement.value = this.currentModel;
        console.log('Current model set to:', this.currentModel);
      }
    } catch (error) {
      console.error('Failed to load current VLM model:', error);
      // 에러가 발생해도 첫 번째 모델을 기본값으로 설정
      const modelKeys = Object.keys(this.availableModels);
      if (modelKeys.length > 0) {
        this.currentModel = modelKeys[0];
        this.selectElement.value = this.currentModel;
        console.log('Fallback to first available model:', this.currentModel);
      }
    }
  }

  populateModelSelector() {
    if (!this.selectElement) return;

    // 기존 옵션 제거 (첫 번째 옵션 제외)
    while (this.selectElement.options.length > 1) {
      this.selectElement.remove(1);
    }

    // 모델 옵션 추가
    Object.entries(this.availableModels).forEach(([modelName, modelInfo]) => {
      const option = document.createElement('option');
      option.value = modelName;
      option.textContent = `${modelName} (${modelInfo.speed}, ${modelInfo.accuracy})`;
      option.title = modelInfo.description || '';
      this.selectElement.appendChild(option);
    });
  }

  async handleModelChange(event) {
    const newModel = event.target.value;
    if (!newModel || newModel === this.currentModel) {
      return;
    }

    const modelInfo = this.availableModels[newModel];
    const confirmMessage = `VLM 모델을 ${newModel}(${modelInfo?.speed || ''}, ${modelInfo?.accuracy || ''})로 변경하시겠습니까?`;
    
    if (!confirm(confirmMessage)) {
      // 사용자가 취소하면 이전 모델로 복원
      this.selectElement.value = this.currentModel;
      return;
    }

    try {
      const response = await fetch(`${this.apiBase}/api/vlm/switch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: newModel }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      this.currentModel = newModel;
      this.showSuccess(`VLM 모델이 ${newModel}로 변경되었습니다.`);
      console.log('VLM model switched successfully:', data);
    } catch (error) {
      console.error('Failed to switch VLM model:', error);
      this.showError('VLM 모델 변경 실패');
      // 실패 시 이전 모델로 복원
      this.selectElement.value = this.currentModel;
    }
  }

  showSuccess(message) {
    this.showNotification(message, 'success');
  }

  showError(message) {
    this.showNotification(message, 'error');
  }

  showNotification(message, type = 'info') {
    // 기존 알림 제거
    const existingNotification = document.querySelector('.vlm-notification');
    if (existingNotification) {
      existingNotification.remove();
    }

    // 새 알림 생성
    const notification = document.createElement('div');
    notification.className = `vlm-notification vlm-notification-${type}`;
    notification.textContent = message;
    notification.style.cssText = `
      position: fixed;
      top: 80px;
      right: 20px;
      padding: 12px 16px;
      border-radius: 8px;
      background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6'};
      color: white;
      font-weight: 600;
      font-size: 14px;
      z-index: 1000;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      animation: slideIn 0.3s ease-out;
    `;

    document.body.appendChild(notification);

    // 3초 후 자동 제거
    setTimeout(() => {
      notification.style.animation = 'slideOut 0.3s ease-out';
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  }
}

// 애니메이션 스타일 추가
const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from {
      transform: translateX(100%);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
  
  @keyframes slideOut {
    from {
      transform: translateX(0);
      opacity: 1;
    }
    to {
      transform: translateX(100%);
      opacity: 0;
    }
  }
`;
document.head.appendChild(style);

// VLMManager 클래스 내보내기 (app.js에서 import하여 사용)
export { VLMManager };
