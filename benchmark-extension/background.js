// ============================================================
// 벤치 익스텐션 service worker.
//   - 사이드패널 ↔ content script 메시징 중계
//   - 케이스 생성 / 실행 / judge 호출 / 결과 저장 오케스트레이션
//   - 탐색 모드 (DB 채우기)
// ============================================================

import "./config.js";
import { saveCase, saveRun, saveSnapshot } from "./lib/storage.js";
import { callPlan, callBaseline, callJudge, callDomCheck, callDomUpload } from "./lib/api.js";

const CFG = self.EEUM_BENCH_CONFIG;

// 사이드패널을 action 버튼 클릭으로 열기.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn("[bench] sidePanel error", err));

// ── 활성 사이드패널 포트 ───────────────────────────────────
let activePort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "bench-panel") return;
  activePort = port;
  port.onDisconnect.addListener(() => {
    if (activePort === port) activePort = null;
  });
  port.onMessage.addListener((msg) => handlePanelMessage(port, msg));
});

function sendToPanel(msg) {
  try {
    activePort?.postMessage(msg);
  } catch (_) {}
}

// content script 가 보내는 단발성 이벤트.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "BENCH_TARGET_PICKED") {
    sendToPanel({ type: "TARGET_PICKED", payload: msg.payload });
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === "BENCH_INSPECT_CANCELLED") {
    sendToPanel({ type: "INSPECT_CANCELLED" });
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === "BENCH_STATE_CHANGED") {
    handleStateChanged(msg.payload).catch((err) =>
      console.warn("[bench] state-changed", err)
    );
    sendResponse({ ok: true });
    return true;
  }
});

async function handleStateChanged(payload) {
  const { bench_explore } = await chrome.storage.local.get("bench_explore");
  if (!bench_explore) return;
  try {
    const check = await callDomCheck({
      stateId: payload.state_id,
      url: payload.url,
      domHash: payload.dom_hash,
    });
    if (check.cache_miss) {
      const uploaded = await callDomUpload(payload);
      sendToPanel({
        type: "EXPLORE_CAPTURED",
        payload: {
          url: payload.url,
          stored: uploaded.stored,
        },
      });
    }
  } catch (err) {
    console.warn("[bench] dom upload failed", err);
  }
}

// ── 탭 헬퍼 ──────────────────────────────────────────────
async function activeTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  return tab || null;
}

async function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(resp);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

const RESTRICTED_URL_RE = /^(chrome|edge|brave|about|chrome-extension|view-source):/i;

async function ensureContent(tabId, url) {
  if (!url || RESTRICTED_URL_RE.test(url)) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["config.js", "lib/dom_capture.js", "content.js"],
    });
    return true;
  } catch (err) {
    console.warn("[bench] inject failed", err);
    return false;
  }
}

async function snapshotTab(tab) {
  let snap = await sendToTab(tab.id, { type: "BENCH_SNAPSHOT" });
  if (snap?.state_id) return snap;
  await ensureContent(tab.id, tab.url);
  await new Promise((r) => setTimeout(r, 500));
  return sendToTab(tab.id, { type: "BENCH_SNAPSHOT" });
}

// 새 UUID — case_id / run_id 용.
function newId() {
  return crypto.randomUUID();
}

// ── 패널 메시지 라우팅 ───────────────────────────────────
async function handlePanelMessage(port, msg) {
  try {
    switch (msg.type) {
      case "BENCH_START_INSPECT": {
        const tab = await activeTab();
        if (!tab) return;
        await ensureContent(tab.id, tab.url);
        await sendToTab(tab.id, { type: "BENCH_START_INSPECT" });
        port.postMessage({ type: "INSPECT_STARTED" });
        break;
      }
      case "BENCH_STOP_INSPECT": {
        const tab = await activeTab();
        if (tab) await sendToTab(tab.id, { type: "BENCH_STOP_INSPECT" });
        break;
      }
      case "BENCH_CAPTURE_SNAPSHOT": {
        const tab = await activeTab();
        if (!tab) {
          port.postMessage({ type: "ERROR", payload: { error: "활성 탭이 없습니다." } });
          return;
        }
        await ensureContent(tab.id, tab.url);
        const snap = await snapshotTab(tab);
        port.postMessage({ type: "SNAPSHOT_RESULT", payload: snap });
        break;
      }
      case "BENCH_SAVE_CASE": {
        const c = msg.payload;
        c.case_id = c.case_id || newId();
        c.captured_at = c.captured_at || new Date().toISOString();
        await saveCase(c);
        port.postMessage({ type: "CASE_SAVED", payload: { case_id: c.case_id } });
        break;
      }
      case "BENCH_RUN_CASES": {
        await runCases(port, msg.payload);
        break;
      }
      case "BENCH_EXPLORE_TOGGLE": {
        await chrome.storage.local.set({ bench_explore: !!msg.payload.on });
        port.postMessage({ type: "EXPLORE_STATE", payload: { on: !!msg.payload.on } });
        break;
      }
      case "BENCH_EXPLORE_STATE": {
        const { bench_explore } = await chrome.storage.local.get("bench_explore");
        port.postMessage({ type: "EXPLORE_STATE", payload: { on: !!bench_explore } });
        break;
      }
      default:
        console.warn("[bench] unknown panel msg", msg);
    }
  } catch (err) {
    console.warn("[bench] panel handler error", err);
    port.postMessage({ type: "ERROR", payload: { error: String(err) } });
  }
}

// ── 케이스 실행 루프 (구현은 다음 단계에서 확장) ──────────
async function runCases(port, payload) {
  // payload: { cases: [...], mode: "eeum" | "baseline", runJudge: bool }
  const { cases = [], mode = "eeum", runJudge = true } = payload || {};
  const runId = newId();
  const startedAt = new Date().toISOString();
  const results = [];

  port.postMessage({
    type: "RUN_STARTED",
    payload: { run_id: runId, total: cases.length, mode },
  });

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    port.postMessage({
      type: "RUN_PROGRESS",
      payload: { index: i, total: cases.length, case_id: c.case_id },
    });

    try {
      const result = await runSingleCase(c, mode, runJudge);
      results.push(result);
      port.postMessage({ type: "RUN_CASE_DONE", payload: result });
    } catch (err) {
      const errResult = {
        case_id: c.case_id,
        error: String(err),
      };
      results.push(errResult);
      port.postMessage({ type: "RUN_CASE_DONE", payload: errResult });
    }
  }

  const totalScored = results.filter((r) => typeof r.composite === "number");
  const avg = (key) =>
    totalScored.length
      ? totalScored.reduce((s, r) => s + (r[key] || 0), 0) / totalScored.length
      : 0;

  const runObj = {
    run_id: runId,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    mode,
    results,
    summary: {
      n: cases.length,
      n_scored: totalScored.length,
      avg_composite: avg("composite"),
      avg_target_hit: avg("target_hit"),
      avg_outcome_match: avg("outcome_match"),
      avg_safety_correct: avg("safety_correct"),
      avg_processing_ms: avg("processing_ms"),
      total_tokens: results.reduce((s, r) => s + (r?.tokens?.total || 0), 0),
    },
  };
  await saveRun(runObj);
  port.postMessage({ type: "RUN_FINISHED", payload: runObj });
}

async function runSingleCase(c, mode, runJudge) {
  // 1) 케이스의 URL 로 활성 탭 이동
  const tab = await activeTab();
  if (!tab) throw new Error("활성 탭이 없습니다.");
  if (tab.url !== c.url) {
    await chrome.tabs.update(tab.id, { url: c.url });
    await waitForTabLoad(tab.id);
  }
  await ensureContent(tab.id, c.url);

  // 2) 현재 DOM 스냅샷 (drift 비교)
  const liveSnap = await snapshotTab(tab);
  const stale =
    !liveSnap || liveSnap.dom_hash !== c.dom_snapshot?.dom_hash;

  // 3) 시스템 응답 요청
  const reqBody = {
    query: c.query,
    currentUrl: liveSnap?.url || c.url,
    currentElements: liveSnap?.elements || c.dom_snapshot?.elements || [],
  };
  let systemResponse;
  if (mode === "baseline") {
    systemResponse = await callBaseline({
      query: c.query,
      url: reqBody.currentUrl,
      elements: reqBody.currentElements,
    });
  } else {
    systemResponse = await callPlan(reqBody);
  }

  // 4) 액션 자동 실행
  for (const action of systemResponse.actions || []) {
    const result = await sendToTab(tab.id, {
      type: "BENCH_EXECUTE_ACTION",
      payload: { action },
    });
    if (action.type === "navigate" || result?.navigated) {
      await waitForTabLoad(tab.id);
      await ensureContent(tab.id, undefined);
    }
    await new Promise((r) => setTimeout(r, CFG.ACTION_DELAY_MS));
  }

  // 5) 실행 후 페이지 요약
  const postSummary = await sendToTab(tab.id, { type: "BENCH_PAGE_SUMMARY" });

  // 6) judge 호출
  let judgeResult = null;
  if (runJudge) {
    try {
      judgeResult = await callJudge({
        query: c.query,
        groundTruth: c.ground_truth,
        systemResponse,
        postDomSummary: JSON.stringify(postSummary || {}),
      });
    } catch (err) {
      judgeResult = { error: String(err) };
    }
  }

  return {
    case_id: c.case_id,
    mode,
    stale,
    processing_ms: systemResponse.processing_ms,
    tokens: systemResponse.tokens,
    actions: systemResponse.actions,
    explanation: systemResponse.explanation,
    post_summary: postSummary,
    target_hit: judgeResult?.target_hit,
    outcome_match: judgeResult?.outcome_match,
    safety_correct: judgeResult?.safety_correct,
    composite: judgeResult?.composite,
    reasoning: judgeResult?.reasoning,
    judge_tokens: judgeResult?.judge_tokens,
    judge_error: judgeResult?.error,
  };
}

function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();
    function check() {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) {
          resolve();
          return;
        }
        if (tab.status === "complete") {
          resolve();
          return;
        }
        if (Date.now() - start > timeoutMs) {
          resolve();
          return;
        }
        setTimeout(check, 200);
      });
    }
    check();
  });
}

// ── 탐색 모드 (DB 채우기) ──────────────────────────────────
// 사용자가 사이드패널에서 토글 ON 하면 활성 탭의 페이지 변화를 자동 적재.
// 실제 변화 감지는 향후 작업에서 — 지금은 명시적 "현재 페이지 적재" 버튼만 동작.
// (확장된 자동 감지는 Task #9 에서 구현)
