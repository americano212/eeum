// ============================================================
// 전역 설정 - 서버 주소 등은 여기서 수정
// (service worker, content script, sidebar 모두에서 self.EEUM_CONFIG 로 접근)
// ============================================================

self.EEUM_CONFIG = {
  // 서버 베이스 URL (개발: http://localhost:8000, 운영: 배포 도메인)
  SERVER_URL: "http://localhost:8000",

  // 액션 사이 기본 대기 (ms)
  ACTION_DELAY_MS: 400,
};
