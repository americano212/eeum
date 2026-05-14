// ============================================================
// Service Worker
//   - config.js 로딩 (SERVER_URL 등)
//   - sidebar <-> content script <-> server 메시지 라우팅
//   - 세션 관리 (chrome.storage.local)
//   - REST 호출: /dom/check, /dom/upload, /query
// ============================================================

importScripts("config.js");
const CFG = self.EEUM_CONFIG;

// ── 사이드 패널 자동 오픈 ───────────────────────────────────
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

// ── 세션 관리 (chrome.storage.local) ───────────────────────
async function getSession() {
  const { session_id, expires_at } = await chrome.storage.local.get([
    "session_id",
    "expires_at",
  ]);
  if (!session_id || !expires_at) return { session_id: null };
  if (new Date(expires_at).getTime() < Date.now()) {
    return { session_id: null };
  }
  return { session_id };
}

async function saveSession(session_id, expires_at) {
  await chrome.storage.local.set({ session_id, expires_at });
}

async function clearSession() {
  await chrome.storage.local.remove(["session_id", "expires_at"]);
}

// ── 서버 URL 확인 (override 있으면 우선) ───────────────────
async function getServerUrl() {
  const { server_url_override } = await chrome.storage.local.get(
    "server_url_override"
  );
  return (server_url_override || CFG.SERVER_URL).replace(/\/+$/, "");
}

// ── 서버 호출 헬퍼 ─────────────────────────────────────────
async function postJSON(path, body) {
  const baseUrl = await getServerUrl();
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} ${text}`);
  }
  return res.json();
}

async function callDomCheck(payload) {
  const sess = await getSession();
  const data = await postJSON("/dom/check", { ...payload, session_id: sess.session_id });
  await saveSession(data.session_id, data.expires_at);
  return data;
}

async function callDomUpload(payload) {
  const sess = await getSession();
  const data = await postJSON("/dom/upload", { ...payload, session_id: sess.session_id });
  await saveSession(data.session_id, data.expires_at);
  return data;
}

const DEFAULT_ENDPOINT = "/plan/strict";
const VALID_ENDPOINTS = new Set(["/plan/strict", "/plan", "/query"]);

function deferClickAction(a) {
  if (!a || typeof a !== "object") return a;
  if (a.type === "click") return { type: "await_click", xpath: a.xpath };
  if (a.type === "click_text") return { type: "await_click_text", text: a.text };
  if (a.type === "type") return { type: "await_type", xpath: a.xpath, value: a.value };
  if (a.type === "select") return { type: "await_select", xpath: a.xpath, value: a.value };
  return a;
}

const AWAIT_INPUT_ACTIONS = new Set(["await_type", "await_select"]);

async function getPlanningEndpoint() {
  const { planning_endpoint } = await chrome.storage.local.get("planning_endpoint");
  if (planning_endpoint && VALID_ENDPOINTS.has(planning_endpoint)) {
    return planning_endpoint;
  }
  return DEFAULT_ENDPOINT;
}

async function callPlan(query, snapshot) {
  const sess = await getSession();
  const endpoint = await getPlanningEndpoint();

  if (endpoint === "/query") {
    // 레거시: QueryResponse → 통일된 plan 형식으로 어댑트.
    // 모든 클릭은 await_click 으로 위임(자동 클릭 안 함).
    const data = await postJSON("/query", {
      session_id: sess.session_id,
      query,
      current_state_id: snapshot.state_id,
      current_url: snapshot.url,
      current_dom_hash: snapshot.dom_hash,
      current_elements: snapshot.elements,
    });
    await saveSession(data.session_id, data.expires_at);
    const target = data.target_element;
    const navPath = (data.navigation_path || []).map(deferClickAction);
    // 캡처된 xpath 는 페이지 변동에 약하니, target 의 text 가 있으면 text 매칭을 우선.
    const finalClick = target
      ? (target.text && target.text.trim()
          ? [{ type: "await_click_text", text: target.text.trim() }]
          : [{ type: "await_click", xpath: target.xpath }])
      : [];
    return {
      session_id: data.session_id,
      expires_at: data.expires_at,
      explanation: target
        ? `'${target.text || target.tag}' 요소를 찾았습니다.`
        : "관련 요소를 찾지 못했습니다.",
      actions: [...navPath, ...finalClick],
      needs_more_elements: !target,
    };
  }

  const data = await postJSON(endpoint, {
    session_id: sess.session_id,
    query,
    current_url: snapshot.url,
    current_elements: snapshot.elements,
  });
  await saveSession(data.session_id, data.expires_at);
  return data;
}

// ── content script 통신 ────────────────────────────────────
async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id;
}

function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["config.js", "content.js"],
    });
    return true;
  } catch (err) {
    console.warn("[eeum] content script injection failed:", err);
    return false;
  }
}

async function fetchCurrentSnapshot(tabId) {
  let resp = await sendToTab(tabId, { type: "REQUEST_DOM_SNAPSHOT" });
  if (resp?.state_id) return resp;

  const injected = await ensureContentScript(tabId);
  if (!injected) return null;

  // 초기 스냅샷이 잡힐 시간 약간 대기
  await new Promise((r) => setTimeout(r, 600));
  resp = await sendToTab(tabId, { type: "REQUEST_DOM_SNAPSHOT" });
  return resp;
}

const RESTRICTED_URL_RE = /^(chrome|edge|brave|about|chrome-extension|view-source):/i;

function isRestrictedUrl(url) {
  return !url || RESTRICTED_URL_RE.test(url);
}

function emptySnapshot(url) {
  return {
    state_id: `${url || "about:blank"}|empty`,
    url: url || "about:blank",
    dom_hash: "empty",
    elements: [],
  };
}

async function isExplorationOn() {
  const { exploration_mode } = await chrome.storage.local.get("exploration_mode");
  return !!exploration_mode;
}

// ── content script 가 STATE_CHANGED 알릴 때 처리 ───────────
// 탐색 모드 ON 일 때만 /dom/upload 로 적재. OFF 이면 무시.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "STATE_CHANGED") return;

  (async () => {
    try {
      if (!(await isExplorationOn())) {
        sendResponse({ ok: false, reason: "exploration_off" });
        return;
      }
      const check = await callDomCheck({
        state_id: msg.payload.state_id,
        url: msg.payload.url,
        dom_hash: msg.payload.dom_hash,
      });
      if (check.cache_miss) {
        const uploaded = await callDomUpload(msg.payload);
        // 사이드패널이 열려 있으면 캡처 알림
        activePort?.postMessage({
          type: "ASSISTANT_MESSAGE",
          payload: {
            text: `📥 캡처: ${msg.payload.url} (${uploaded.stored}개 요소)`,
          },
        });
      }
      sendResponse({ ok: true });
    } catch (err) {
      console.warn("[eeum] state sync failed:", err);
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  return true;
});

// ── 액션 실행 파이프라인 ───────────────────────────────────
const runtime = {
  running: false,
  resumeResolver: null,
  awaitingInputTabId: null, // await_type/await_select 진행 중일 때 set
};

function instructionFor(action) {
  if (action.type === "await_type") {
    return `'${action.value}' 를 입력란에 직접 입력하거나 "계속" 버튼을 누르면 자동으로 입력합니다.`;
  }
  if (action.type === "await_select") {
    return `'${action.value}' 를 드롭다운에서 직접 고르거나 "계속" 버튼을 누르면 자동 선택합니다.`;
  }
  return "";
}

async function runActions(actions, tabId, port) {
  runtime.running = true;
  const total = actions.length;

  for (let i = 0; i < total; i++) {
    if (!runtime.running) break;

    const action = actions[i];
    port?.postMessage({
      type: "ACTION_START",
      payload: { action, stepIndex: i, total },
    });

    // restricted 페이지(chrome://newtab 등)에서는 content script 주입 불가.
    // navigate 만 chrome.tabs.update 로 직접 처리하고, 그 외 액션은 에러.
    const tabInfo = await chrome.tabs.get(tabId).catch(() => null);
    const onRestricted = isRestrictedUrl(tabInfo?.url);

    let result;
    if (onRestricted) {
      if (action.type === "navigate") {
        try {
          await chrome.tabs.update(tabId, { url: action.url });
          // 페이지 로드 + content script 정착 대기
          await new Promise((r) => setTimeout(r, 1800));
          result = { ok: true, navigated: true };
        } catch (err) {
          result = { ok: false, error: String(err.message || err) };
        }
      } else {
        result = {
          ok: false,
          error:
            "현재 브라우저 내부 페이지에서는 실행할 수 없습니다. 먼저 navigate 액션이 필요합니다.",
        };
      }
    } else {
      // await_type/await_select 는 content.js 가 끝날 때까지 블록되므로
      // 사이드패널 안내(WAIT_FOR_USER) 를 먼저 띄우고, RESUME 신호를 content 로 포워딩.
      if (AWAIT_INPUT_ACTIONS.has(action.type)) {
        runtime.awaitingInputTabId = tabId;
        port?.postMessage({
          type: "WAIT_FOR_USER",
          payload: { instruction: instructionFor(action) },
        });
      }

      result = await sendToTab(tabId, {
        type: "EXECUTE_ACTION",
        payload: { action },
      });

      runtime.awaitingInputTabId = null;
    }

    if (!result || !result.ok) {
      port?.postMessage({
        type: "ACTION_ERROR",
        payload: {
          stepIndex: i,
          error: result?.error ?? "content script 응답 없음",
        },
      });
      runtime.running = false;
      return;
    }

    if (result.waitForUser) {
      port?.postMessage({
        type: "WAIT_FOR_USER",
        payload: { instruction: result.instruction },
      });
      await new Promise((resolve) => {
        runtime.resumeResolver = resolve;
      });
      runtime.resumeResolver = null;
    }

    // await_click 결과: 사용자가 강조된 요소를 클릭하지 않으면 시퀀스 중단.
    if (action.type === "await_click" || action.type === "await_click_text") {
      if (!result.userClicked) {
        port?.postMessage({ type: "ACTION_DONE", payload: { stepIndex: i } });
        const msg = result.timedOut
          ? "대기 시간이 초과되어 작업을 중단합니다. 필요하면 다시 요청해주세요."
          : "사용자가 다른 동작을 선택하여 이후 단계를 중단합니다.";
        port?.postMessage({
          type: "ASSISTANT_MESSAGE",
          payload: { text: msg },
        });
        port?.postMessage({ type: "AUTOMATION_COMPLETE" });
        runtime.running = false;
        return;
      }
    }

    port?.postMessage({ type: "ACTION_DONE", payload: { stepIndex: i } });

    if (result.navigated) {
      await new Promise((r) => setTimeout(r, 1500));
    } else {
      await new Promise((r) => setTimeout(r, CFG.ACTION_DELAY_MS));
    }
  }

  port?.postMessage({ type: "AUTOMATION_COMPLETE" });
  runtime.running = false;
}

// ── sidebar 와의 Port ──────────────────────────────────────
let activePort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sidebar") return;
  activePort = port;

  port.onMessage.addListener(async (msg) => {
    if (msg.type === "USER_MESSAGE") {
      try {
        port.postMessage({ type: "ASSISTANT_THINKING" });

        const tabId = await getActiveTabId();
        if (!tabId) throw new Error("활성 탭을 찾을 수 없습니다.");

        const tabInfo = await chrome.tabs.get(tabId).catch(() => null);
        const tabUrl = tabInfo?.url || "";

        // restricted 페이지(chrome://newtab 등)거나 content script 가 못 붙는 경우
        // → 빈 elements 로 plan 호출. LLM 이 navigate-only 응답을 만들 수 있게.
        let snapshot;
        if (isRestrictedUrl(tabUrl)) {
          snapshot = emptySnapshot(tabUrl);
        } else {
          snapshot = await fetchCurrentSnapshot(tabId);
          if (!snapshot?.state_id) {
            snapshot = emptySnapshot(tabUrl);
          }
        }

        const response = await callPlan(msg.payload.text, snapshot);

        if (response.explanation) {
          port.postMessage({
            type: "ASSISTANT_MESSAGE",
            payload: { text: response.explanation },
          });
        }

        if (response.needs_more_elements) {
          port.postMessage({
            type: "ASSISTANT_MESSAGE",
            payload: { text: "관련 요소를 더 찾지 못했어요. 페이지를 스크롤하거나 다른 키워드로 다시 시도해주세요." },
          });
        }

        await runActions(response.actions || [], tabId, port);
      } catch (err) {
        port.postMessage({
          type: "ACTION_ERROR",
          payload: { stepIndex: -1, error: String(err.message || err) },
        });
      }
    } else if (msg.type === "STOP_AUTOMATION") {
      runtime.running = false;
      if (runtime.resumeResolver) {
        runtime.resumeResolver();
        runtime.resumeResolver = null;
      }
    } else if (msg.type === "RESUME_AUTOMATION") {
      // await_type/await_select 가 진행 중이면 content.js 에 직접 신호 전달.
      if (runtime.awaitingInputTabId) {
        sendToTab(runtime.awaitingInputTabId, { type: "USER_CONTINUED" });
      }
      if (runtime.resumeResolver) {
        runtime.resumeResolver();
        runtime.resumeResolver = null;
      }
    } else if (msg.type === "CLEAR_CONVERSATION") {
      await clearSession();
      port.postMessage({ type: "CONVERSATION_CLEARED" });
    } else if (msg.type === "DB_STATS") {
      try {
        const baseUrl = await getServerUrl();
        const res = await fetch(`${baseUrl}/admin/stats`);
        const data = await res.json();
        port.postMessage({ type: "DB_STATS_RESULT", payload: data });
      } catch (err) {
        port.postMessage({
          type: "DB_STATS_RESULT",
          payload: { error: String(err.message || err) },
        });
      }
    } else if (msg.type === "DB_RESET") {
      try {
        const baseUrl = await getServerUrl();
        const res = await fetch(`${baseUrl}/admin/reset`, { method: "POST" });
        const data = await res.json();
        port.postMessage({ type: "DB_RESET_RESULT", payload: data });
      } catch (err) {
        port.postMessage({
          type: "DB_RESET_RESULT",
          payload: { error: String(err.message || err) },
        });
      }
    }
  });

  port.onDisconnect.addListener(() => {
    if (activePort === port) activePort = null;
  });
});
