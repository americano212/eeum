// ============================================================
// 벤치 익스텐션 전역 설정.
// service worker / content script / sidebar 가 self.EEUM_BENCH_CONFIG 로 접근.
// ============================================================

self.EEUM_BENCH_CONFIG = {
  // eeum 서버 베이스 URL.
  SERVER_URL: "http://localhost:8000",

  // chrome.downloads 가 사용할 prefix (~/Downloads 기준 상대 경로).
  DOWNLOAD_PREFIX: "eeum-bench",

  // 라벨링 인스펙터에서 hover 한 요소를 표시할 색 (RGB).
  INSPECTOR_COLOR: "#f0a500",

  // 실행 시 액션 사이 기본 대기 (ms).
  ACTION_DELAY_MS: 400,
};
