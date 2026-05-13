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

  // ── 3. dom_hash 계산 (구조만, 텍스트 제외) ─────────────────
  async function computeDomHash(elements) {
    const sigParts = elements.map(
      (e) =>
        `${e.tag}|${e.xpath}|${e.aria_label || ""}|${e.role || ""}`
    );
    const sig = sigParts.join("\n");
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
    if (action.type === "click_text") {
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
