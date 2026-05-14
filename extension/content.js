// ============================================================
// Content Script
//   - 인터랙션 요소 추출 + xpath/dom_hash 계산
//   - URL/MutationObserver 기반 상태 변화 감지
//   - 클릭 시 trigger_xpath 임시 기록 (500ms window)
//   - background 와 통신: STATE_CHANGED, EXECUTE_ACTIONS
//   - 서버 액션(xpath) → 현재 DOM 의 index 로 변환 후 실행
// ============================================================

(function () {
  "use strict";

  if (window.__EEUM_CONTENT_LOADED__) return;
  window.__EEUM_CONTENT_LOADED__ = true;

  const CFG = self.EEUM_CONFIG;

  // ── 1. xpath 생성 ──────────────────────────────────────────
  function getXPath(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el === document.body) return "/html/body";

    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      let index = 1;
      let sibling = node.previousSibling;
      while (sibling) {
        if (sibling.nodeType === 1 && sibling.tagName === node.tagName) index++;
        sibling = sibling.previousSibling;
      }
      parts.unshift(`${node.tagName.toLowerCase()}[${index}]`);
      node = node.parentNode;
    }
    return "/html/" + parts.join("/");
  }

  // ── 2. 인터랙션 요소 추출 ──────────────────────────────────
  const SELECTOR =
    'button, input, select, textarea, a, [role], [aria-label]';
  const REAL_CONTROL_SELECTOR = "button, input, select, textarea, a";
  const REAL_CONTROL_TAGS = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA", "A"]);

  function isVisible(el) {
    if (!el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function isMeaningful(el) {
    // 진짜 컨트롤(button/input/select/textarea/a) 은 그대로 통과.
    if (REAL_CONTROL_TAGS.has(el.tagName)) return true;
    // [role] / [aria-label] 매치된 wrapper 는 내부에 진짜 컨트롤이 없을 때만 채택.
    return !el.querySelector(REAL_CONTROL_SELECTOR);
  }

  function extractElements() {
    const nodes = Array.from(document.querySelectorAll(SELECTOR));
    const elements = [];
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      if (!isMeaningful(el)) continue;
      elements.push({
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.value || "").trim().slice(0, 200),
        aria_label: el.getAttribute("aria-label") || null,
        role: el.getAttribute("role") || null,
        xpath: getXPath(el),
        id: el.id || null,
        href: el.tagName === "A" ? el.getAttribute("href") : null,
        type: el.getAttribute("type") || null,
        name: el.getAttribute("name") || null,
        placeholder: el.getAttribute("placeholder") || null,
        _el: el, // 내부 참조 (직렬화 시 제거)
      });
    }
    return elements;
  }

  function stripInternal(elements) {
    return elements.map(({ _el, ...rest }) => rest);
  }

  // ── 3. dom_hash 계산 (안정 식별자만, 순서 비의존) ───────────
  // xpath 는 광고·배너·뉴스 회전 같은 비-구조적 변화에 idx 가 흔들려서 제외.
  // id / aria-label / name / 짧고 숫자 없는 텍스트(레이블) 가 있는 요소만 채택.
  // 결과를 정렬해 DOM 순서 변화에 무관하게 만든다.
  function stableSignature(e) {
    const text = (e.text || "").trim();
    const stableText =
      text.length >= 1 && text.length <= 20 && !/\d/.test(text);
    if (!e.id && !e.aria_label && !e.name && !stableText) return null;
    return [
      e.tag,
      e.id || "",
      e.aria_label || "",
      e.name || "",
      e.role || "",
      stableText ? text : "",
    ].join("|");
  }

  async function computeDomHash(elements) {
    const parts = elements.map(stableSignature).filter(Boolean);
    parts.sort();
    const sig = parts.join("\n");
    const data = new TextEncoder().encode(sig);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buf))
      .slice(0, 8)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // ── 4. 상태 추적 ───────────────────────────────────────────
  let currentStateId = null;
  let previousStateId = null;
  let lastElementCount = 0;
  let pendingTriggerXpath = null;
  let pendingTriggerExpiresAt = 0;

  function makeStateId(url, hash) {
    return `${url}|${hash}`;
  }

  async function snapshotAndSync(reason) {
    const elements = extractElements();
    const hash = await computeDomHash(elements);
    const url = location.href;
    const newStateId = makeStateId(url, hash);

    if (newStateId === currentStateId) {
      lastElementCount = elements.length;
      return;
    }

    previousStateId = currentStateId;
    currentStateId = newStateId;

    const triggerXpath =
      Date.now() <= pendingTriggerExpiresAt ? pendingTriggerXpath : null;
    pendingTriggerXpath = null;
    pendingTriggerExpiresAt = 0;

    try {
      if (!chrome.runtime?.id) return;
      chrome.runtime
        .sendMessage({
          type: "STATE_CHANGED",
          payload: {
            state_id: newStateId,
            url,
            dom_hash: hash,
            referrer_state_id: previousStateId,
            trigger_xpath: triggerXpath,
            elements: stripInternal(elements),
          },
        })
        .catch(() => {}); // background 가 아직 안 깨어있어도 무시
    } catch {
      return;
    }

    lastElementCount = elements.length;
  }

  // ── 5. URL 변화 감지 ───────────────────────────────────────
  (function patchHistory() {
    const wrap = (name) => {
      const orig = history[name];
      history[name] = function () {
        const ret = orig.apply(this, arguments);
        window.dispatchEvent(new Event("eeum:urlchange"));
        return ret;
      };
    };
    wrap("pushState");
    wrap("replaceState");
  })();

  window.addEventListener("popstate", () =>
    window.dispatchEvent(new Event("eeum:urlchange"))
  );
  window.addEventListener("hashchange", () =>
    window.dispatchEvent(new Event("eeum:urlchange"))
  );
  window.addEventListener("eeum:urlchange", () =>
    scheduleSnapshot("url-change", 100)
  );

  // ── 6. MutationObserver ────────────────────────────────────
  const MAIN_CONTAINERS = ["main", '[role="main"]', "dialog", '[role="tabpanel"]'];

  let snapshotTimer = null;
  function scheduleSnapshot(reason, delay = CFG.OBSERVER_DEBOUNCE_MS) {
    clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => snapshotAndSync(reason), delay);
  }

  const observer = new MutationObserver((mutations) => {
    let containerSwapped = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (MAIN_CONTAINERS.some((s) => node.matches?.(s))) {
          containerSwapped = true;
          break;
        }
      }
      if (containerSwapped) break;
    }

    if (containerSwapped) {
      scheduleSnapshot("container-swap");
      return;
    }

    // 인터랙션 요소 수 ±N 이상 변화 시 보조 트리거
    const currentCount = document.querySelectorAll(SELECTOR).length;
    if (Math.abs(currentCount - lastElementCount) >= CFG.ELEMENT_CHANGE_THRESHOLD) {
      scheduleSnapshot("element-count");
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // ── 7. trigger_xpath 추적 ──────────────────────────────────
  document.addEventListener(
    "click",
    (e) => {
      const target = e.target.closest(SELECTOR);
      if (!target) return;
      pendingTriggerXpath = getXPath(target);
      pendingTriggerExpiresAt = Date.now() + CFG.TRIGGER_WINDOW_MS;
    },
    true
  );

  // ── 8. xpath → index 변환 (액션 실행 직전) ─────────────────
  function findIndexByXpath(xpath, elements) {
    return elements.findIndex((e) => e.xpath === xpath);
  }

  function findByText(text, elements) {
    const t = (text || "").trim();
    if (!t) return -1;
    // 완전 일치 우선, 그 다음 부분 일치
    let idx = elements.findIndex((e) => e.text === t);
    if (idx >= 0) return idx;
    return elements.findIndex((e) => e.text && e.text.includes(t));
  }

  // ── 9. 액션 실행 ────────────────────────────────────────────
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function highlightElement(el, holdMs = 600) {
    const rect = el.getBoundingClientRect();
    const overlay = document.createElement("div");
    overlay.setAttribute("data-eeum-highlight", "1");
    overlay.style.cssText = [
      "position:fixed",
      `left:${rect.left}px`,
      `top:${rect.top}px`,
      `width:${rect.width}px`,
      `height:${rect.height}px`,
      "border:3px solid #4a90d9",
      "border-radius:6px",
      "box-shadow:0 0 0 2px rgba(74,144,217,0.25), 0 0 16px rgba(74,144,217,0.6)",
      "pointer-events:none",
      "z-index:2147483647",
      "transition:opacity 0.2s",
      "opacity:1",
    ].join(";");
    document.documentElement.appendChild(overlay);
    await sleep(holdMs);
    overlay.style.opacity = "0";
    setTimeout(() => overlay.remove(), 220);
  }

  // 유저 클릭 대기 중에도 요소를 추적하는 영구 하이라이트.
  // rAF 로 매 프레임 위치를 다시 잡아서 스크롤·sticky 모두 대응한다.
  function persistentHighlight(el) {
    const overlay = document.createElement("div");
    overlay.setAttribute("data-eeum-highlight", "await");
    overlay.style.cssText = [
      "position:fixed",
      "border:3px solid #f0a500",
      "border-radius:6px",
      "box-shadow:0 0 0 2px rgba(240,165,0,0.3), 0 0 18px rgba(240,165,0,0.7)",
      "pointer-events:none",
      "z-index:2147483647",
      "animation:eeumPulse 1.2s ease-in-out infinite",
    ].join(";");

    if (!document.getElementById("eeum-pulse-style")) {
      const style = document.createElement("style");
      style.id = "eeum-pulse-style";
      style.textContent =
        "@keyframes eeumPulse{0%,100%{opacity:1}50%{opacity:0.55}}";
      document.documentElement.appendChild(style);
    }

    document.documentElement.appendChild(overlay);

    let alive = true;
    function update() {
      if (!alive) return;
      const rect = el.getBoundingClientRect();
      overlay.style.left = `${rect.left}px`;
      overlay.style.top = `${rect.top}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
      requestAnimationFrame(update);
    }
    update();

    return () => {
      alive = false;
      overlay.remove();
    };
  }

  // 하이라이트 된 요소를 유저가 클릭했는지 감시. 다른 곳을 클릭하면 false.
  function waitForUserClick(targetEl, timeoutMs = 60000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (matched) => {
        if (done) return;
        done = true;
        document.removeEventListener("click", onClick, true);
        clearTimeout(timer);
        resolve({ userClicked: matched, timedOut: false });
      };
      const onClick = (e) => {
        const t = e.target;
        const matched = targetEl === t || targetEl.contains(t);
        finish(matched);
      };
      document.addEventListener("click", onClick, true);
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        document.removeEventListener("click", onClick, true);
        resolve({ userClicked: false, timedOut: true });
      }, timeoutMs);
    });
  }

  // USER_CONTINUED 신호(사이드패널 "계속" 버튼 → background → content) 대기.
  // 한 번에 하나의 대기만 활성. background 가 보내는 단발성 메시지.
  let pendingUserContinue = null;

  // 입력란/셀렉트에 대한 대기 헬퍼.
  // - 유저가 직접 타이핑/선택 → input/change 이벤트 → userInteracted=true, finalValue=el.value
  // - 유저가 "계속" → suggested value 자동 입력 → userInteracted=false
  // - 120초 무반응 → 타임아웃
  function waitForInput(el, suggestedValue, eventName, timeoutMs = 120000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (payload) => {
        if (done) return;
        done = true;
        el.removeEventListener(eventName, onEvent);
        pendingUserContinue = null;
        clearTimeout(timer);
        resolve(payload);
      };
      const onEvent = () => {
        // 유저가 직접 값 변경 — 그 값을 그대로 사용
        finish({
          userInteracted: true,
          finalValue: el.value,
          timedOut: false,
        });
      };
      el.addEventListener(eventName, onEvent);
      pendingUserContinue = () => {
        // 계속 → 제안값 자동 입력
        el.focus();
        el.value = suggestedValue;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        finish({
          userInteracted: false,
          finalValue: suggestedValue,
          timedOut: false,
        });
      };
      const timer = setTimeout(() => {
        finish({
          userInteracted: false,
          finalValue: el.value,
          timedOut: true,
        });
      }, timeoutMs);
    });
  }

  // site_search 용 — 페이지의 검색 input 추측. selector 우선순위 순.
  // 추측이 빗나가면 null 반환해 LLM URL 추측보다 안전한 실패.
  const SEARCH_INPUT_SELECTORS = [
    'input[type="search"]',
    '[role="searchbox"]',
    'input[name="q"]',
    'input[name="query"]',
    'input[name="keyword"]',
    'input[name="kwd"]',
    'input[name="search_query"]',
    'input[name="searchWord"]',
    'input[name="searchKwd"]',
    'input[name="searchKeyword"]',
    'input[name="nttSj"]',
    'input[aria-label*="검색"]',
    'input[aria-label*="search" i]',
    'input[placeholder*="검색"]',
    'input[placeholder*="search" i]',
  ];

  function querySearchInput() {
    for (const sel of SEARCH_INPUT_SELECTORS) {
      const candidates = document.querySelectorAll(sel);
      for (const el of candidates) {
        if (!isVisible(el)) continue;
        if (el.disabled) continue;
        const t = (el.getAttribute("type") || "").toLowerCase();
        if (t === "password" || t === "hidden") continue;
        return el;
      }
    }
    return null;
  }

  async function findSearchInput(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    let el = querySearchInput();
    while (!el && Date.now() < deadline) {
      await sleep(150);
      el = querySearchInput();
    }
    return el;
  }

  async function executeSiteSearch(query) {
    const input = await findSearchInput();
    if (!input) {
      return { ok: false, error: "이 페이지에서 검색창을 찾지 못했어요." };
    }

    input.scrollIntoView({ block: "center", behavior: "smooth" });
    await sleep(200);
    await highlightElement(input);

    input.focus();
    input.value = query;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    // SPA(검색창 onKeyDown 핸들러) 대응
    const enterInit = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    };
    input.dispatchEvent(new KeyboardEvent("keydown", enterInit));
    input.dispatchEvent(new KeyboardEvent("keyup", enterInit));

    // 전통 form 사이트(정부24 등) 대응 — 합성 Enter는 native submit을 트리거하지 않음
    if (input.form) {
      try {
        if (typeof input.form.requestSubmit === "function") {
          input.form.requestSubmit();
        } else {
          input.form.submit();
        }
      } catch (_) {
        // SPA가 onSubmit을 가로채 e.preventDefault() 하는 경우 등 — 무시
      }
    }

    return { ok: true, navigated: true };
  }

  async function executeOne(action) {
    // navigate 는 페이지 전환이라 별도 처리
    if (action.type === "navigate") {
      location.href = action.url;
      return { ok: true, navigated: true };
    }
    if (action.type === "wait") {
      await sleep(action.ms);
      return { ok: true };
    }
    if (action.type === "scroll") {
      const delta = (action.direction === "down" ? 1 : -1) * action.amount;
      window.scrollBy({ top: delta, behavior: "smooth" });
      return { ok: true };
    }
    if (action.type === "wait_for_user") {
      // sidebar 가 사용자 확인 받을 때까지 background 가 일시정지함
      return { ok: true, waitForUser: true, instruction: action.instruction };
    }
    if (action.type === "site_search") {
      return executeSiteSearch(action.query || "");
    }

    // 요소 기반 액션 - 현재 DOM 에서 재추출 후 xpath → index 변환
    const elements = extractElements();

    let index = -1;
    if (action.type === "click_text" || action.type === "await_click_text") {
      index = findByText(action.text, elements);
    } else if (action.xpath) {
      index = findIndexByXpath(action.xpath, elements);
    }

    if (index < 0) {
      return {
        ok: false,
        error: `요소를 찾을 수 없음 (${action.type}: ${action.xpath || action.text})`,
      };
    }

    const el = elements[index]._el;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    await sleep(250);

    // await_click / await_click_text 는 영구 하이라이트 + 유저 클릭 대기.
    // 유저가 그 요소를 직접 클릭했는지(userClicked) 다음 액션 흐름에서 사용.
    if (action.type === "await_click" || action.type === "await_click_text") {
      const cleanup = persistentHighlight(el);
      const { userClicked, timedOut } = await waitForUserClick(el);
      cleanup();
      const tag = el.tagName.toLowerCase();
      const href = el.getAttribute("href");
      const navigates =
        userClicked &&
        ((tag === "a" && href && !href.startsWith("#")) ||
          el.getAttribute("type") === "submit");
      return { ok: true, userClicked, timedOut, navigated: navigates, index };
    }

    // await_type — 입력란 영구 하이라이트 + 유저가 직접 타이핑 OR "계속" 버튼.
    // 계속 누르면 제안 value 자동 입력. 직접 타이핑하면 그 값을 그대로 사용.
    if (action.type === "await_type") {
      el.focus();
      const cleanup = persistentHighlight(el);
      const { userInteracted, finalValue, timedOut } = await waitForInput(
        el,
        action.value,
        "input"
      );
      cleanup();
      return { ok: true, userInteracted, finalValue, timedOut, index };
    }

    // await_select — <select> 하이라이트 + 유저 직접 선택 OR "계속" 자동 선택.
    if (action.type === "await_select") {
      const cleanup = persistentHighlight(el);
      const { userInteracted, finalValue, timedOut } = await waitForInput(
        el,
        action.value,
        "change"
      );
      cleanup();
      return { ok: true, userInteracted, finalValue, timedOut, index };
    }

    await highlightElement(el);

    switch (action.type) {
      case "click":
      case "click_text":
        el.click();
        return { ok: true, index };
      case "type":
        el.focus();
        el.value = action.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, index };
      case "select":
        el.value = action.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, index };
      case "highlight":
        // 강조만 — 클릭은 하지 않음 (위험 동작은 사용자가 직접 누르도록)
        return { ok: true, index };
      default:
        return { ok: false, error: `알 수 없는 액션: ${action.type}` };
    }
  }

  // ── 10. background 메시지 수신 ─────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      if (msg.type === "USER_CONTINUED") {
        const resume = pendingUserContinue;
        pendingUserContinue = null;
        if (resume) resume();
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "REQUEST_DOM_SNAPSHOT") {
        const elements = extractElements();
        const hash = await computeDomHash(elements);
        sendResponse({
          state_id: makeStateId(location.href, hash),
          url: location.href,
          dom_hash: hash,
          referrer_state_id: previousStateId,
          trigger_xpath: null,
          elements: stripInternal(elements),
        });
        return;
      }

      if (msg.type === "GET_CURRENT_STATE") {
        if (!currentStateId) await snapshotAndSync("get-current");
        sendResponse({ state_id: currentStateId });
        return;
      }

      if (msg.type === "EXECUTE_ACTION") {
        const result = await executeOne(msg.payload.action);
        sendResponse(result);
        return;
      }
    })();
    return true; // async response
  });

  // ── 11. 초기 스냅샷 ────────────────────────────────────────
  if (document.readyState === "complete") {
    scheduleSnapshot("initial", 300);
  } else {
    window.addEventListener("load", () => scheduleSnapshot("initial", 300));
  }
})();
