// ============================================================
// 사이드패널 컨트롤러. background 와 Port 통신.
//   - tabs 전환
//   - 케이스 빌더 (Task #6)
//   - 실행 (Task #7)
//   - 탐색 (Task #9)
//   - 대시보드 (Task #8)
// ============================================================

import { buildCaseBuilder } from "../views/case-builder.js";
import { buildRunner } from "../views/runner.js";
import { buildExplorer } from "../views/explorer.js";
import { buildDashboard } from "../views/dashboard.js";

// SW 가 idle 로 죽으면 port 가 disconnect 됨 → 사용 시점에 lazy 재연결.
let port = null;
const subscribers = new Set();

function connect() {
  const p = chrome.runtime.connect({ name: "bench-panel" });
  p.onMessage.addListener((msg) => {
    for (const fn of subscribers) {
      try { fn(msg); } catch (err) { console.warn("[panel] subscriber error", err); }
    }
  });
  p.onDisconnect.addListener(() => {
    if (port === p) port = null;
  });
  return p;
}

function getPort() {
  if (!port) port = connect();
  return port;
}

function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function send(msg) {
  try {
    getPort().postMessage(msg);
  } catch (_) {
    // 처음 잡은 port 가 그새 disconnect 됐으면 한 번 재시도.
    port = null;
    getPort().postMessage(msg);
  }
}

// 초기 연결 — 패널 열리는 즉시 SW 깨우고 이벤트 받을 준비.
getPort();

const ctx = { send, subscribe };

// ── tab 전환 ───────────────────────────────────────────────
const tabButtons = document.querySelectorAll(".tab");
const tabPanels = document.querySelectorAll(".tab-panel");

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const name = btn.dataset.tab;
    tabButtons.forEach((b) => b.classList.toggle("active", b === btn));
    tabPanels.forEach((p) =>
      p.classList.toggle("active", p.id === `tab-${name}`)
    );
  });
});

// ── 각 탭 초기화 ───────────────────────────────────────────
buildCaseBuilder(ctx);
buildRunner(ctx);
buildExplorer(ctx);
buildDashboard(ctx);
