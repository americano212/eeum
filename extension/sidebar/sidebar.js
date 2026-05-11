// ============================================================
// Sidebar Script
//   - background 와 Port 통신
//   - 채팅 메시지/액션 진행/대기 UI 렌더링
//   - 서버 URL override (chrome.storage.local)
// ============================================================

(function () {
  "use strict";

  // ── Port 연결 ──────────────────────────────────────────────
  let port = null;
  let isRunning = false;

  function connect() {
    try {
      port = chrome.runtime.connect({ name: "sidebar" });
      port.onMessage.addListener(handleBackgroundMessage);
      port.onDisconnect.addListener(() => {
        port = null;
        setTimeout(connect, 500);
      });
    } catch {
      setTimeout(connect, 1000);
    }
  }
  connect();

  // ── 메시지 핸들러 ──────────────────────────────────────────
  function handleBackgroundMessage(msg) {
    switch (msg.type) {
      case "ASSISTANT_THINKING":
        removeById("thinking-msg");
        appendThinkingMessage();
        setRunning(true);
        break;

      case "ASSISTANT_MESSAGE":
        removeById("thinking-msg");
        appendMessage("assistant", msg.payload.text);
        break;

      case "ACTION_START": {
        const { action, stepIndex, total } = msg.payload;
        updateProgress(stepIndex, total);
        appendActionMessage(
          `단계 ${stepIndex + 1}/${total}`,
          describeAction(action),
          `step-${stepIndex}`
        );
        break;
      }

      case "ACTION_DONE":
        markStepDone(msg.payload.stepIndex);
        break;

      case "ACTION_ERROR":
        removeById("thinking-msg");
        if (msg.payload.stepIndex >= 0) markStepError(msg.payload.stepIndex);
        appendMessage("error", `오류: ${msg.payload.error}`);
        setRunning(false);
        hideProgress();
        break;

      case "WAIT_FOR_USER":
        removeById("thinking-msg");
        appendWaitMessage(msg.payload.instruction);
        break;

      case "AUTOMATION_COMPLETE":
        removeById("thinking-msg");
        appendMessage("complete", "✅ 작업이 완료되었습니다!");
        setRunning(false);
        hideProgress();
        break;

      case "CONVERSATION_CLEARED":
        clearMessagesUI();
        break;
    }
  }

  // ── 입력 ───────────────────────────────────────────────────
  const sendBtn = document.getElementById("send-btn");
  const stopBtn = document.getElementById("stop-btn");
  const userInput = document.getElementById("user-input");

  sendBtn.addEventListener("click", sendMessage);
  userInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  userInput.addEventListener("input", () => {
    userInput.style.height = "auto";
    userInput.style.height = Math.min(userInput.scrollHeight, 120) + "px";
  });

  function sendMessage() {
    const text = userInput.value.trim();
    if (!text || isRunning) return;
    appendMessage("user", text);
    userInput.value = "";
    userInput.style.height = "auto";

    if (!port) {
      appendMessage("error", "백그라운드 연결이 끊겼습니다. 사이드패널을 다시 열어주세요.");
      return;
    }
    port.postMessage({ type: "USER_MESSAGE", payload: { text } });
  }

  stopBtn.addEventListener("click", () => {
    if (port) port.postMessage({ type: "STOP_AUTOMATION" });
    setRunning(false);
    hideProgress();
    removeById("thinking-msg");
    appendMessage("assistant", "작업이 중지되었습니다.");
  });

  // ── 대화 초기화 ────────────────────────────────────────────
  const clearBtn = document.getElementById("clear-btn");
  clearBtn.addEventListener("click", () => {
    if (isRunning) return;
    if (port) port.postMessage({ type: "CLEAR_CONVERSATION" });
    else clearMessagesUI();
  });

  // ── 빠른 칩 ────────────────────────────────────────────────
  document.getElementById("quick-chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip || isRunning) return;
    userInput.value = chip.textContent.trim();
    userInput.dispatchEvent(new Event("input"));
    userInput.focus();
  });

  // ── 설정 패널 (서버 URL) ───────────────────────────────────
  const settingsBtn = document.getElementById("settings-btn");
  const settingsPanel = document.getElementById("settings-panel");
  const serverInput = document.getElementById("server-url-input");
  const saveBtn = document.getElementById("save-server-btn");
  const resetBtn = document.getElementById("reset-server-btn");
  const serverStatus = document.getElementById("server-status");

  chrome.storage.local.get("server_url_override", ({ server_url_override }) => {
    if (server_url_override) serverInput.value = server_url_override;
  });

  settingsBtn.addEventListener("click", () => {
    settingsPanel.classList.toggle("hidden");
    if (!settingsPanel.classList.contains("hidden")) serverInput.focus();
  });

  saveBtn.addEventListener("click", () => {
    const url = serverInput.value.trim();
    if (!url) {
      flashStatus("URL을 입력해주세요.", "error");
      return;
    }
    if (!/^https?:\/\//.test(url)) {
      flashStatus("http:// 또는 https:// 로 시작해야 합니다.", "warn");
      return;
    }
    chrome.storage.local.set({ server_url_override: url }, () => {
      flashStatus("✅ 저장됨. 다음 요청부터 적용됩니다.", "ok");
    });
  });

  resetBtn.addEventListener("click", () => {
    chrome.storage.local.remove("server_url_override", () => {
      serverInput.value = "";
      flashStatus("기본값으로 되돌렸습니다.", "ok");
    });
  });

  function flashStatus(text, kind) {
    serverStatus.textContent = text;
    serverStatus.style.color =
      kind === "error" ? "#e53935" : kind === "warn" ? "#f0a500" : "#43a047";
    serverStatus.classList.remove("hidden");
  }

  // ── 메시지 렌더링 ──────────────────────────────────────────
  const messagesEl = document.getElementById("messages");

  function appendThinkingMessage() {
    const el = document.createElement("div");
    el.className = "msg-bubble thinking";
    el.id = "thinking-msg";
    el.textContent = "분석 중...";
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function appendMessage(type, text, id) {
    const el = document.createElement("div");
    el.className = `msg-bubble ${type}`;
    if (id) el.id = id;
    el.innerHTML = linkify(escapeHtml(text));
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  function appendActionMessage(label, desc, id) {
    const el = document.createElement("div");
    el.className = "msg-bubble action";
    if (id) el.id = id;
    el.innerHTML = `
      <div class="step-label">${escapeHtml(label)}</div>
      <div class="step-desc">${escapeHtml(desc)}</div>
    `;
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  function appendWaitMessage(instruction) {
    const el = document.createElement("div");
    el.className = "msg-bubble wait-user";

    const instr = document.createElement("div");
    instr.className = "wait-instruction";
    instr.innerHTML = `<strong>⏳ 사용자 확인 필요</strong><br>${escapeHtml(instruction)}`;

    const btn = document.createElement("button");
    btn.className = "continue-btn";
    btn.innerHTML = "✅ 완료했어요, 계속 진행";
    btn.addEventListener("click", () => {
      btn.textContent = "계속 진행 중...";
      btn.classList.add("disabled");
      btn.disabled = true;
      if (port) port.postMessage({ type: "RESUME_AUTOMATION" });
    });

    el.appendChild(instr);
    el.appendChild(btn);
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function removeById(id) {
    document.getElementById(id)?.remove();
  }

  function clearMessagesUI() {
    messagesEl.innerHTML = `
      <div class="msg-bubble assistant">
        세션이 초기화되었습니다. 새로운 작업을 말씀해주세요.
      </div>`;
    hideProgress();
  }

  function markStepDone(stepIndex) {
    const el = document.getElementById(`step-${stepIndex}`);
    if (!el) return;
    el.classList.add("done");
    const label = el.querySelector(".step-label");
    if (label) label.textContent = label.textContent.replace("단계", "✅ 완료");
  }

  function markStepError(stepIndex) {
    const el = document.getElementById(`step-${stepIndex}`);
    if (!el) return;
    el.classList.add("done");
    el.style.borderColor = "#e53935";
    const label = el.querySelector(".step-label");
    if (label) label.textContent = label.textContent.replace("단계", "❌ 오류");
  }

  // ── 진행 바 ────────────────────────────────────────────────
  const progressBar = document.getElementById("progress-bar");
  const progressFill = document.getElementById("progress-fill");

  function updateProgress(current, total) {
    progressBar.classList.remove("hidden");
    const pct = total > 0 ? Math.round(((current + 1) / total) * 100) : 0;
    progressFill.style.width = `${pct}%`;
  }

  function hideProgress() {
    setTimeout(() => {
      progressFill.style.width = "100%";
      setTimeout(() => {
        progressBar.classList.add("hidden");
        progressFill.style.width = "0%";
      }, 400);
    }, 300);
  }

  // ── 상태 토글 ──────────────────────────────────────────────
  function setRunning(running) {
    isRunning = running;
    sendBtn.classList.toggle("hidden", running);
    stopBtn.classList.toggle("hidden", !running);
    userInput.disabled = running;
    document.getElementById("quick-chips").classList.toggle("hidden", running);
    clearBtn.disabled = running;
    if (!running) userInput.focus();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  // ── 액션 설명 ──────────────────────────────────────────────
  function describeAction(action) {
    switch (action.type) {
      case "navigate":  return `${action.url} 로 이동`;
      case "click":     return `요소 클릭 (${action.xpath})`;
      case "click_text":return `"${action.text}" 클릭`;
      case "type":
        const v = (action.value ?? "").length > 20
          ? action.value.slice(0, 20) + "..."
          : action.value;
        return `"${v}" 입력`;
      case "select":    return `"${action.value}" 선택`;
      case "scroll":    return `${action.direction === "down" ? "아래로" : "위로"} 스크롤 (${action.amount}px)`;
      case "highlight": return `요소 강조 (${action.xpath})`;
      case "wait":      return `${action.ms}ms 대기`;
      case "wait_for_user": return "사용자 확인 대기";
      default: return action.type;
    }
  }

  // ── 유틸 ──────────────────────────────────────────────────
  function escapeHtml(text) {
    if (!text) return "";
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/\n/g, "<br>");
  }

  function linkify(text) {
    return text.replace(
      /(https?:\/\/[^\s<]+)/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
    );
  }
})();
