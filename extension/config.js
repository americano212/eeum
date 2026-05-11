// ============================================================
// 전역 설정 - 서버 주소 등은 여기서 수정
// (service worker, content script, sidebar 모두에서 self.EEUM_CONFIG 로 접근)
// ============================================================

self.EEUM_CONFIG = {
  // 서버 베이스 URL (개발: http://localhost:8000, 운영: 배포 도메인)
  SERVER_URL: "http://localhost:8000",

  // 클릭 후 MutationObserver 가 변화를 감지할 때까지 기다리는 시간 (ms)
  TRIGGER_WINDOW_MS: 500,

  // 인터랙션 요소 수가 이만큼 변할 때 새 상태로 취급
  ELEMENT_CHANGE_THRESHOLD: 5,

  // MutationObserver debounce (ms)
  OBSERVER_DEBOUNCE_MS: 200,

  // 액션 사이 기본 대기 (ms)
  ACTION_DELAY_MS: 400,
};
