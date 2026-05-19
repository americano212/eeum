// ============================================================
// DOM 캡처 — 메인 익스텐션의 content.js 와 동일한 추출/해시 로직.
// 케이스 라벨링 시점, 실행 직전, 실행 후 검증까지 같은 형태로 쓴다.
//
// self.EEUM_DOM 로 노출. content script 진입점에서 호출.
// ============================================================

(function () {
  "use strict";

  if (self.EEUM_DOM) return;

  const SELECTOR = "button, input, select, textarea, a, [role], [aria-label]";
  const REAL_CONTROL_SELECTOR = "button, input, select, textarea, a";
  const REAL_CONTROL_TAGS = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA", "A"]);

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

  function isVisible(el) {
    if (!el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function isMeaningful(el) {
    if (REAL_CONTROL_TAGS.has(el.tagName)) return true;
    return !el.querySelector(REAL_CONTROL_SELECTOR);
  }

  function extractElements() {
    const nodes = Array.from(document.querySelectorAll(SELECTOR));
    const out = [];
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      if (!isMeaningful(el)) continue;
      out.push({
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
        _el: el,
      });
    }
    return out;
  }

  function stripInternal(elements) {
    return elements.map(({ _el, ...rest }) => rest);
  }

  function stableSignature(e) {
    const text = (e.text || "").trim();
    const stableText = text.length >= 1 && text.length <= 20 && !/\d/.test(text);
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

  function makeStateId(url, hash) {
    return `${url}|${hash}`;
  }

  async function snapshot() {
    const elements = extractElements();
    const hash = await computeDomHash(elements);
    return {
      url: location.href,
      title: document.title,
      dom_hash: hash,
      state_id: makeStateId(location.href, hash),
      elements: stripInternal(elements),
    };
  }

  function findElementByXPath(xpath) {
    const result = document.evaluate(
      xpath,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    );
    return result.singleNodeValue;
  }

  self.EEUM_DOM = {
    getXPath,
    extractElements,
    stripInternal,
    computeDomHash,
    makeStateId,
    snapshot,
    findElementByXPath,
    SELECTOR,
  };
})();
