// ============================================================
// 벤치 익스텐션 content script.
//   - 라벨링 인스펙터 모드 (hover 표시 + 클릭으로 타겟 마킹)
//   - 액션 자동 실행 (await_* 와 wait_for_user 는 "위임" 으로 기록만)
//   - background 가 호출하는 메시지: START_INSPECT, STOP_INSPECT,
//     REQUEST_SNAPSHOT, EXECUTE_ACTION, GET_PAGE_SUMMARY
// ============================================================

(function () {
  "use strict";

  if (window.__EEUM_BENCH_LOADED__) return;
  window.__EEUM_BENCH_LOADED__ = true;

  const CFG = self.EEUM_BENCH_CONFIG;
  const DOM = self.EEUM_DOM;

  // ── 라벨링 인스펙터 ─────────────────────────────────────────
  let inspectOverlay = null;
  let inspectActive = false;

  function ensureInspectOverlay() {
    if (inspectOverlay) return inspectOverlay;
    inspectOverlay = document.createElement("div");
    inspectOverlay.style.cssText = [
      "position:fixed",
      "pointer-events:none",
      "z-index:2147483647",
      `border:3px solid ${CFG.INSPECTOR_COLOR}`,
      "border-radius:6px",
      `box-shadow:0 0 0 2px ${CFG.INSPECTOR_COLOR}33, 0 0 14px ${CFG.INSPECTOR_COLOR}88`,
      "transition:all 60ms linear",
      "display:none",
    ].join(";");
    document.documentElement.appendChild(inspectOverlay);
    return inspectOverlay;
  }

  function moveInspectOverlay(rect) {
    const o = ensureInspectOverlay();
    o.style.display = "block";
    o.style.left = `${rect.left}px`;
    o.style.top = `${rect.top}px`;
    o.style.width = `${rect.width}px`;
    o.style.height = `${rect.height}px`;
  }

  function hideInspectOverlay() {
    if (inspectOverlay) inspectOverlay.style.display = "none";
  }

  function summarizeEl(el) {
    return {
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.value || "").trim().slice(0, 200),
      aria_label: el.getAttribute("aria-label") || null,
      role: el.getAttribute("role") || null,
      xpath: DOM.getXPath(el),
      id: el.id || null,
      href: el.tagName === "A" ? el.getAttribute("href") : null,
      type: el.getAttribute("type") || null,
      name: el.getAttribute("name") || null,
      placeholder: el.getAttribute("placeholder") || null,
    };
  }

  function onInspectMove(e) {
    const el = e.target;
    if (!el || el === inspectOverlay) return;
    const rect = el.getBoundingClientRect();
    moveInspectOverlay(rect);
  }

  function onInspectClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    const summary = summarizeEl(el);
    chrome.runtime
      .sendMessage({ type: "BENCH_TARGET_PICKED", payload: summary })
      .catch(() => {});
    stopInspect();
  }

  function onInspectKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      stopInspect();
      chrome.runtime
        .sendMessage({ type: "BENCH_INSPECT_CANCELLED" })
        .catch(() => {});
    }
  }

  function startInspect() {
    if (inspectActive) return;
    inspectActive = true;
    ensureInspectOverlay();
    document.addEventListener("mousemove", onInspectMove, true);
    document.addEventListener("click", onInspectClick, true);
    document.addEventListener("keydown", onInspectKey, true);
  }

  function stopInspect() {
    if (!inspectActive) return;
    inspectActive = false;
    document.removeEventListener("mousemove", onInspectMove, true);
    document.removeEventListener("click", onInspectClick, true);
    document.removeEventListener("keydown", onInspectKey, true);
    hideInspectOverlay();
  }

  // ── 액션 실행 (벤치 자동 모드) ─────────────────────────────
  // await_* / wait_for_user 는 "위임" 으로 분류만 하고 실제로는 멈추지 않는다.
  // 벤치는 "한 사이클에 한 응답" 만 평가하므로 멀티스텝 사용자 위임을 시뮬레이션할 필요 없음.

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function findByText(text, elements) {
    const t = (text || "").trim();
    if (!t) return -1;
    let idx = elements.findIndex((e) => e.text === t);
    if (idx >= 0) return idx;
    return elements.findIndex((e) => e.text && e.text.includes(t));
  }

  async function executeOne(action) {
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
    if (action.type === "wait_for_user" || action.type.startsWith("await_")) {
      // 벤치 모드: 위임 액션은 멈추지 않고 기록만 한다.
      return { ok: true, deferred: true };
    }
    if (action.type === "highlight") {
      return { ok: true };
    }
    if (action.type === "site_search") {
      // 벤치 평가는 단일 응답 중심이므로 site_search 도 위임 분류.
      return { ok: true, deferred: true };
    }

    const elements = DOM.extractElements();

    let target = null;
    if (action.type === "click_text") {
      const idx = findByText(action.text, elements);
      if (idx >= 0) target = elements[idx]._el;
    } else if (action.xpath) {
      target = DOM.findElementByXPath(action.xpath);
    }

    if (!target) {
      return {
        ok: false,
        error: `요소를 찾을 수 없음 (${action.type}: ${action.xpath || action.text})`,
      };
    }

    target.scrollIntoView({ block: "center", behavior: "smooth" });
    await sleep(200);

    switch (action.type) {
      case "click":
      case "click_text":
        target.click();
        return { ok: true };
      case "type":
        target.focus();
        target.value = action.value;
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true };
      case "select":
        target.value = action.value;
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true };
      default:
        return { ok: false, error: `알 수 없는 액션: ${action.type}` };
    }
  }

  // ── 탐색 모드 자동 감지 ─────────────────────────────────────
  // background 가 STATE_CHANGED 를 받아서 explore on 일 때만 /dom/upload 한다.
  // 클릭 trigger_xpath 도 같이 실어줘서 그래프 엣지를 만들 수 있게 한다.
  let lastStateId = null;
  let previousStateId = null;
  let pendingTriggerXpath = null;
  let pendingTriggerExpiresAt = 0;
  const TRIGGER_WINDOW_MS = 500;
  const OBSERVER_DEBOUNCE_MS = 250;
  const ELEMENT_CHANGE_THRESHOLD = 5;
  let lastElementCount = 0;

  async function pushStateChanged(reason) {
    const snap = await DOM.snapshot();
    if (snap.state_id === lastStateId) {
      lastElementCount = snap.elements.length;
      return;
    }
    previousStateId = lastStateId;
    lastStateId = snap.state_id;
    const triggerXpath =
      Date.now() <= pendingTriggerExpiresAt ? pendingTriggerXpath : null;
    pendingTriggerXpath = null;
    pendingTriggerExpiresAt = 0;
    try {
      if (!chrome.runtime?.id) return;
      chrome.runtime
        .sendMessage({
          type: "BENCH_STATE_CHANGED",
          payload: {
            state_id: snap.state_id,
            url: snap.url,
            dom_hash: snap.dom_hash,
            referrer_state_id: previousStateId,
            trigger_xpath: triggerXpath,
            elements: snap.elements,
          },
        })
        .catch(() => {});
    } catch (_) {}
    lastElementCount = snap.elements.length;
  }

  let snapshotTimer = null;
  function scheduleSnapshot(reason, delay = OBSERVER_DEBOUNCE_MS) {
    clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => pushStateChanged(reason), delay);
  }

  (function patchHistory() {
    const wrap = (name) => {
      const orig = history[name];
      history[name] = function () {
        const ret = orig.apply(this, arguments);
        window.dispatchEvent(new Event("bench:urlchange"));
        return ret;
      };
    };
    wrap("pushState");
    wrap("replaceState");
  })();

  window.addEventListener("popstate", () =>
    window.dispatchEvent(new Event("bench:urlchange"))
  );
  window.addEventListener("hashchange", () =>
    window.dispatchEvent(new Event("bench:urlchange"))
  );
  window.addEventListener("bench:urlchange", () => scheduleSnapshot("url", 100));

  const MAIN_CONTAINERS = ['main', '[role="main"]', "dialog", '[role="tabpanel"]'];
  new MutationObserver((mutations) => {
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
      scheduleSnapshot("container");
      return;
    }
    const currentCount = document.querySelectorAll(DOM.SELECTOR).length;
    if (Math.abs(currentCount - lastElementCount) >= ELEMENT_CHANGE_THRESHOLD) {
      scheduleSnapshot("count");
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener(
    "click",
    (e) => {
      const target = e.target.closest(DOM.SELECTOR);
      if (!target) return;
      pendingTriggerXpath = DOM.getXPath(target);
      pendingTriggerExpiresAt = Date.now() + TRIGGER_WINDOW_MS;
    },
    true
  );

  if (document.readyState === "complete") {
    scheduleSnapshot("initial", 300);
  } else {
    window.addEventListener("load", () => scheduleSnapshot("initial", 300));
  }

  // ── 페이지 요약 (judge 입력용 post_dom_summary) ─────────────
  function pageSummary() {
    const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
      .slice(0, 8)
      .map((h) => h.innerText.trim().slice(0, 80))
      .filter(Boolean);
    const visibleText = (document.body?.innerText || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 800);
    return {
      url: location.href,
      title: document.title,
      headings,
      visible_text: visibleText,
    };
  }

  // ── background 메시지 라우팅 ──────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        if (msg.type === "BENCH_START_INSPECT") {
          startInspect();
          sendResponse({ ok: true });
          return;
        }
        if (msg.type === "BENCH_STOP_INSPECT") {
          stopInspect();
          sendResponse({ ok: true });
          return;
        }
        if (msg.type === "BENCH_SNAPSHOT") {
          const snap = await DOM.snapshot();
          sendResponse(snap);
          return;
        }
        if (msg.type === "BENCH_EXECUTE_ACTION") {
          const result = await executeOne(msg.payload.action);
          sendResponse(result);
          return;
        }
        if (msg.type === "BENCH_PAGE_SUMMARY") {
          sendResponse(pageSummary());
          return;
        }
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  });
})();
