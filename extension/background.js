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
  await registerKnownSession(session_id);
}

async function clearSession() {
  await chrome.storage.local.remove(["session_id", "expires_at"]);
}

// 이 브라우저에서 발급받은 session_id 목록.
// 서버는 사용자 개념이 없어 자기 세션을 식별할 방법이 chrome.storage 뿐이다.
async function getKnownSessions() {
  const { known_sessions } = await chrome.storage.local.get("known_sessions");
  return Array.isArray(known_sessions) ? known_sessions : [];
}

async function registerKnownSession(session_id) {
  if (!session_id) return;
  const list = await getKnownSessions();
  if (!list.includes(session_id)) {
    list.unshift(session_id);
    await chrome.storage.local.set({ known_sessions: list });
  }
}

// ── 플래닝 엔드포인트 선택 ─────────────────────────────────
// /plan       — 자동 실행 + 안전 게이트 (기본)
// /plan/strict — 모든 액션 사용자 위임 (await_*)
// /query      — 임베딩 + 그래프 기반 레거시
const DEFAULT_ENDPOINT = "/plan";
const VALID_ENDPOINTS = new Set(["/plan", "/plan/strict", "/query"]);

async function getPlanningEndpoint() {
  const { planning_endpoint } = await chrome.storage.local.get("planning_endpoint");
  if (planning_endpoint && VALID_ENDPOINTS.has(planning_endpoint)) {
    return planning_endpoint;
  }
  return DEFAULT_ENDPOINT;
}

function deferClickAction(a) {
  // /query 결과나 strict 외 경로에서도 자동 click 을 막아야 할 때 쓰는 헬퍼.
  if (a.type === "click") return { type: "await_click", xpath: a.xpath };
  if (a.type === "click_text") return { type: "await_click_text", text: a.text };
  if (a.type === "type") return { type: "await_type", xpath: a.xpath, value: a.value };
  if (a.type === "select") return { type: "await_select", xpath: a.xpath, value: a.value };
  return a;
}

const AWAIT_INPUT_ACTIONS = new Set(["await_type", "await_select"]);

// ── 서버 URL ─────────────────────────────────────────────
async function getServerUrl() {
  return CFG.SERVER_URL.replace(/\/+$/, "");
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

async function getJSON(path) {
  const baseUrl = await getServerUrl();
  const res = await fetch(`${baseUrl}${path}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} ${text}`);
  }
  return res.json();
}

async function deleteJSON(path) {
  const baseUrl = await getServerUrl();
  const res = await fetch(`${baseUrl}${path}`, { method: "DELETE" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} ${text}`);
  }
  return res.json();
}

async function unregisterKnownSession(session_id) {
  if (!session_id) return;
  const list = await getKnownSessions();
  const next = list.filter((s) => s !== session_id);
  if (next.length !== list.length) {
    await chrome.storage.local.set({ known_sessions: next });
  }
}

// ── 대화 로그 ──────────────────────────────────────────────
// 사이드바에 표시되는 모든 영구 bubble을 서버 DB로 push.
// transient placeholder("분석 중...")와 background와의 통신이 끊긴 상태에서
// 띄우는 에러는 제외 — 전자는 의미 없고 후자는 push 자체가 실패한다.
//
// 매 push마다 현재 탭 URL을 같이 보내 서버가 세션의 "마지막 사이트"를 갱신한다.
// 자동화가 navigate로 끝나면 AUTOMATION_COMPLETE 로그 시점의 URL이 곧 종착지가 된다.
async function getActiveTabUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const url = tab?.url || "";
    if (!url || RESTRICTED_URL_RE.test(url)) return null;
    return url;
  } catch {
    return null;
  }
}

async function postLog(role, content) {
  try {
    const sess = await getSession();
    const currentUrl = await getActiveTabUrl();
    const data = await postJSON("/conversations/log", {
      session_id: sess.session_id,
      role,
      content: content ?? "",
      current_url: currentUrl,
    });
    await saveSession(data.session_id, data.expires_at);
  } catch (err) {
    console.warn("[eeum] log push failed:", err);
  }
}

function describeAction(action) {
  switch (action.type) {
    case "navigate":   return `${action.url} 로 이동`;
    case "click":      return `요소 클릭 (${action.xpath})`;
    case "click_text": return `"${action.text}" 클릭`;
    case "type": {
      const v = (action.value ?? "").length > 20
        ? action.value.slice(0, 20) + "..."
        : action.value;
      return `"${v}" 입력`;
    }
    case "select":    return `"${action.value}" 선택`;
    case "scroll":    return `${action.direction === "down" ? "아래로" : "위로"} 스크롤 (${action.amount}px)`;
    case "highlight": return `요소 강조 (${action.xpath})`;
    case "wait":      return `${action.ms}ms 대기`;
    case "wait_for_user": return "사용자 확인 대기";
    default: return action.type;
  }
}

function logFromOutgoing(msg) {
  switch (msg.type) {
    case "ASSISTANT_MESSAGE":
      return { role: "assistant", content: msg.payload.text };
    case "ACTION_START": {
      const { action, stepIndex, total } = msg.payload;
      return {
        role: "action",
        content: `단계 ${stepIndex + 1}/${total}: ${describeAction(action)}`,
      };
    }
    case "WAIT_FOR_USER":
      return { role: "wait", content: msg.payload.instruction };
    case "ACTION_ERROR":
      return { role: "error", content: `오류: ${msg.payload.error}` };
    case "AUTOMATION_COMPLETE":
      return { role: "complete", content: "✅ 작업이 완료되었습니다!" };
    default:
      return null;
  }
}

// 사이드바로 보내는 메시지 = DB에 남는 메시지. 두 경로를 한 함수로 묶어
// "UI에 보였는데 DB엔 없다"는 표류를 막는다.
async function notifySidebar(port, msg) {
  port?.postMessage(msg);
  const log = logFromOutgoing(msg);
  if (log) await postLog(log.role, log.content);
}

// query에 명시적으로 다른 사이트가 등장하면 현재 페이지 elements를 무시하고
// 의도만 서버에 보낸다. 풍부한 페이지 요소가 LLM을 다른 방향으로 끌어가는 회귀를 막는다.
// 키워드는 server/services/site_rules.yaml 에 등록된 사이트들과 자주 쓰는 별칭.
const CROSS_SITE_KEYWORDS = [
  // 사이트명 (site_rules.yaml의 sites 키)
  "쿠팡", "네이버", "유튜브", "구글", "지마켓", "11번가",
  "정부24", "토스", "카카오", "당근", "배민", "배달의민족",
  "amazon", "youtube", "google", "naver", "coupang", "gmarket",
  // 정부24 직접 서비스명 (site_rules.yaml direct_services 와 동기화)
  "주민등록등본", "주민등록초본", "전입신고",
  "가족관계증명서", "기본증명서", "혼인관계증명서",
  "입양관계증명서", "친양자입양관계증명서",
  "인감증명서", "토지대장", "임야대장", "건축물대장", "자동차등록원부",
  "여권", "출입국", "외국인등록",
  "사업자등록증명", "납세증명서", "국세납세증명", "지방세납세증명", "소득금액증명",
  "운전경력증명서", "국민연금 가입", "건강보험자격득실",
];

function _hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (_) {
    return "";
  }
}

function looksLikeCrossSiteIntent(query, currentUrl) {
  const q = (query || "").toLowerCase();
  const host = _hostnameOf(currentUrl);
  return CROSS_SITE_KEYWORDS.some((kw) => {
    if (!q.includes(kw.toLowerCase())) return false;
    // 현재 호스트가 그 키워드와 매칭되면 cross-site 아님 (네이버에서 "네이버 메일")
    if (host && host.includes(kw.toLowerCase())) return false;
    return true;
  });
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
    // 캡처된 xpath 는 페이지 변동에 약하니, target 의 text 가 있으면 text 매칭 우선.
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

  // /plan 또는 /plan/strict.
  // query 에 명시적으로 다른 사이트가 등장하면 elements 를 비워 LLM 이 페이지 요소에 끌려가지 않도록 함.
  const crossSite = looksLikeCrossSiteIntent(query, snapshot.url || "");
  if (crossSite) {
    console.log("[eeum] cross-site intent detected — sending empty elements", {
      query,
      currentUrl: snapshot.url,
    });
  }
  const data = await postJSON(endpoint, {
    session_id: sess.session_id,
    query,
    current_url: snapshot.url,
    current_elements: crossSite ? [] : snapshot.elements,
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

function instructionFor(action) {
  if (action.type === "await_type") {
    return `'${action.value}' 를 입력란에 직접 입력하거나 "계속" 버튼을 누르면 자동으로 입력합니다.`;
  }
  if (action.type === "await_select") {
    return `'${action.value}' 를 드롭다운에서 직접 고르거나 "계속" 버튼을 누르면 자동 선택합니다.`;
  }
  return "";
}

// 새 탭/chrome:// 같은 곳에서도 "X 사이트로 가줘" 류 요청은 처리한다 —
// 빈 snapshot으로 /plan 받고, 첫 액션이 navigate면 chrome.tabs.update 로 직접 이동.
async function navigateTabAndWait(tabId, url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      err ? reject(err) : resolve();
    };
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => finish(), timeoutMs);
    chrome.tabs.update(tabId, { url }, () => {
      if (chrome.runtime.lastError) finish(new Error(chrome.runtime.lastError.message));
    });
  });
}

async function handleRestrictedPage(tabId, query, port) {
  // 현재 페이지 elements 없이 의도만 보내 navigate 의도 추출
  const response = await callPlan(query, { url: "", elements: [] });

  if (response.explanation) {
    await notifySidebar(port, {
      type: "ASSISTANT_MESSAGE",
      payload: { text: response.explanation },
    });
  }

  const actions = response.actions || [];
  const firstNav = actions[0];
  if (!firstNav || firstNav.type !== "navigate" || !firstNav.url) {
    throw new Error(
      "현재 페이지(브라우저 내부)에서는 페이지 요소를 읽을 수 없어 자동화가 어려워요. " +
        "'쿠팡에서 X 검색해줘' / '주민등록등본 발급받고 싶어' 처럼 갈 사이트를 알려주시면 곧장 이동해드릴게요."
    );
  }

  await notifySidebar(port, {
    type: "ACTION_START",
    payload: { action: firstNav, stepIndex: 0, total: actions.length },
  });
  await navigateTabAndWait(tabId, firstNav.url);
  port.postMessage({ type: "ACTION_DONE", payload: { stepIndex: 0 } });

  const remaining = actions.slice(1);
  if (remaining.length === 0) {
    await notifySidebar(port, { type: "AUTOMATION_COMPLETE" });
    return;
  }

  // navigate된 새 페이지에 content script 주입 후 남은 액션 실행
  await ensureContentScript(tabId);
  await new Promise((r) => setTimeout(r, 800));
  await runActions(remaining, tabId, port);
}

// ── 액션 실행 파이프라인 ───────────────────────────────────
const runtime = {
  running: false,
  resumeResolver: null,
  awaitingInputTabId: null, // await_type/await_select 진행 중일 때 set
};

async function runActions(actions, tabId, port) {
  runtime.running = true;
  const total = actions.length;

  for (let i = 0; i < total; i++) {
    if (!runtime.running) break;

    const action = actions[i];
    await notifySidebar(port, {
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
        await notifySidebar(port, {
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
      await notifySidebar(port, {
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
      await notifySidebar(port, {
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
        const text = result.timedOut
          ? "대기 시간이 초과되어 작업을 중단합니다. 필요하면 다시 요청해주세요."
          : "사용자가 다른 동작을 선택하여 이후 단계를 중단합니다.";
        await notifySidebar(port, {
          type: "ASSISTANT_MESSAGE",
          payload: { text },
        });
        await notifySidebar(port, { type: "AUTOMATION_COMPLETE" });
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

  await notifySidebar(port, { type: "AUTOMATION_COMPLETE" });
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
        await postLog("user", msg.payload.text);
        port.postMessage({ type: "ASSISTANT_THINKING" });

        const tabId = await getActiveTabId();
        if (!tabId) throw new Error("활성 탭을 찾을 수 없습니다.");

        const tabInfo = await chrome.tabs.get(tabId).catch(() => null);
        const tabUrl = tabInfo?.url || "";
        if (!tabUrl || RESTRICTED_URL_RE.test(tabUrl)) {
          // 브라우저 내부 페이지면 빈 snapshot으로 의도만 추출해 곧장 navigate.
          await handleRestrictedPage(tabId, msg.payload.text, port);
          return;
        }

        const snapshot = await fetchCurrentSnapshot(tabId);
        if (!snapshot?.state_id) {
          throw new Error(
            "페이지 콘텐츠를 인식하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해주세요."
          );
        }

        const response = await callPlan(msg.payload.text, snapshot);

        if (response.explanation) {
          await notifySidebar(port, {
            type: "ASSISTANT_MESSAGE",
            payload: { text: response.explanation },
          });
        }

        if (response.needs_more_elements) {
          await notifySidebar(port, {
            type: "ASSISTANT_MESSAGE",
            payload: { text: "관련 요소를 더 찾지 못했어요. 페이지를 스크롤하거나 다른 키워드로 다시 시도해주세요." },
          });
        }

        await runActions(response.actions || [], tabId, port);
      } catch (err) {
        await notifySidebar(port, {
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
      await postLog("assistant", "작업이 중지되었습니다.");
    } else if (msg.type === "RESUME_AUTOMATION") {
      if (runtime.resumeResolver) {
        runtime.resumeResolver();
        runtime.resumeResolver = null;
      }
      // await_type/await_select 진행 중이면 content.js 의 "계속" 누른 효과로 RESUME 포워딩.
      if (runtime.awaitingInputTabId !== null) {
        sendToTab(runtime.awaitingInputTabId, { type: "RESUME_AWAIT_INPUT" });
      }
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
    } else if (msg.type === "CLEAR_CONVERSATION") {
      await clearSession();
      port.postMessage({ type: "CONVERSATION_CLEARED" });
    } else if (msg.type === "REQUEST_HISTORY") {
      try {
        const known = await getKnownSessions();
        const { session_id: current } = await getSession();
        if (known.length === 0) {
          port.postMessage({
            type: "HISTORY_LIST",
            payload: { sessions: [], current_session_id: current },
          });
          return;
        }
        const data = await postJSON("/conversations/sessions", {
          session_ids: known,
        });
        // known_sessions 순서대로 정렬 (최신 발급 순)
        const byId = new Map((data.sessions || []).map((s) => [s.session_id, s]));
        const ordered = known
          .map((sid) => byId.get(sid) || { session_id: sid, title: null, last_activity: null });
        port.postMessage({
          type: "HISTORY_LIST",
          payload: { sessions: ordered, current_session_id: current },
        });
      } catch (err) {
        console.warn("[eeum] history fetch failed:", err);
        port.postMessage({
          type: "HISTORY_LIST",
          payload: { sessions: [], current_session_id: null, error: String(err.message || err) },
        });
      }
    } else if (msg.type === "NEW_SESSION") {
      await clearSession();
      port.postMessage({ type: "SESSION_LOADED", payload: { session_id: null, messages: [] } });
    } else if (msg.type === "DELETE_SESSION") {
      try {
        const sid = msg.payload.session_id;
        await deleteJSON(`/conversations/${encodeURIComponent(sid)}`);
        const { session_id: current } = await getSession();
        const wasCurrent = current === sid;
        if (wasCurrent) await clearSession();
        await unregisterKnownSession(sid);
        port.postMessage({
          type: "SESSION_DELETED",
          payload: { session_id: sid, was_current: wasCurrent },
        });
      } catch (err) {
        port.postMessage({
          type: "SESSION_DELETE_ERROR",
          payload: { error: String(err.message || err) },
        });
      }
    } else if (msg.type === "SWITCH_SESSION") {
      try {
        const sid = msg.payload.session_id;
        const data = await getJSON(`/conversations/${encodeURIComponent(sid)}`);
        // 사이드바에서 새로 보낼 메시지가 이 세션에 이어지도록 storage에도 반영.
        // expires_at은 다음 서버 응답에서 정확한 값으로 덮어쓰여진다.
        const fakeExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        await saveSession(sid, fakeExpires);
        port.postMessage({
          type: "SESSION_LOADED",
          payload: { session_id: sid, messages: data.messages || [] },
        });
        // 세션의 마지막 사이트로 활성 탭 이동.
        // 현재 URL과 같으면 새로고침 안 함 (스크롤/입력 상태 보존).
        if (data.last_url) {
          try {
            const tabId = await getActiveTabId();
            if (tabId) {
              const tab = await chrome.tabs.get(tabId).catch(() => null);
              if (tab && tab.url !== data.last_url) {
                await chrome.tabs.update(tabId, { url: data.last_url });
              }
            }
          } catch (navErr) {
            console.warn("[eeum] session URL restore failed:", navErr);
          }
        }
      } catch (err) {
        port.postMessage({
          type: "SESSION_LOAD_ERROR",
          payload: { error: String(err.message || err) },
        });
      }
    }
  });

  port.onDisconnect.addListener(() => {
    if (activePort === port) activePort = null;
  });
});
