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

  function setStatus(kind, text) {
    const strip = document.getElementById("status-strip");
    const label = document.getElementById("status-text");
    if (!strip || !label) return;
    strip.className = `status-${kind}`;
    label.textContent = text;
  }

  function connect() {
    try {
      port = chrome.runtime.connect({ name: "sidebar" });
      setStatus("ready", "준비됨");
      port.onMessage.addListener(handleBackgroundMessage);
      port.onDisconnect.addListener(() => {
        port = null;
        setStatus("disconnected", "백그라운드 재연결 중");
        setTimeout(connect, 500);
      });
    } catch {
      setStatus("disconnected", "백그라운드 연결 대기 중");
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
        setStatus("thinking", "페이지 분석 중");
        setRunning(true);
        break;

      case "ASSISTANT_MESSAGE":
        removeById("thinking-msg");
        appendMessage("assistant", msg.payload.text);
        if (isRunning) setStatus("running", "실행 준비 중");
        break;

      case "ACTION_START": {
        const { action, stepIndex, total } = msg.payload;
        updateProgress(stepIndex, total);
        setStatus("running", `실행 중 ${stepIndex + 1}/${total}`);
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
        appendErrorMessage(`오류: ${msg.payload.error}`);
        setStatus("error", "오류 발생");
        setRunning(false);
        hideProgress();
        break;

      case "WAIT_FOR_USER":
        removeById("thinking-msg");
        appendWaitMessage(msg.payload.instruction);
        setStatus("waiting", "사용자 확인 대기");
        break;

      case "AUTOMATION_COMPLETE":
        removeById("thinking-msg");
        appendMessage("complete", "작업이 완료되었습니다.");
        setStatus("ready", "완료됨");
        setRunning(false);
        hideProgress();
        break;

      case "CONVERSATION_CLEARED":
        clearMessagesUI();
        setStatus("ready", "준비됨");
        break;

      case "HISTORY_LIST":
        renderSessionList(msg.payload.sessions || [], msg.payload.current_session_id);
        break;

      case "SESSION_LOADED":
        renderLoadedSession(msg.payload.session_id, msg.payload.messages || []);
        break;

      case "SESSION_LOAD_ERROR":
        appendErrorMessage(`대화 불러오기 실패: ${msg.payload.error}`);
        setStatus("error", "대화 불러오기 실패");
        break;

      case "SESSION_DELETED":
        // 현재 세션이 사라지면 채팅창도 빈 상태로 리셋.
        if (msg.payload.was_current) clearMessagesUI();
        // 패널이 열려있으면 갱신된 목록 다시 요청.
        if (!historyPanel.classList.contains("hidden") && port) {
          port.postMessage({ type: "REQUEST_HISTORY" });
        }
        break;

      case "SESSION_DELETE_ERROR":
        appendErrorMessage(`대화 삭제 실패: ${msg.payload.error}`);
        setStatus("error", "대화 삭제 실패");
        break;

      case "DB_STATS_RESULT": {
        const d = msg.payload || {};
        const el = document.getElementById("db-stats");
        if (!el) break;
        if (d.error) {
          el.textContent = `(조회 실패: ${d.error})`;
        } else {
          el.textContent =
            `Qdrant points : ${d.qdrant_points}\n` +
            `Neo4j states  : ${d.neo4j_states}\n` +
            `Neo4j edges   : ${d.neo4j_edges}`;
        }
        break;
      }

      case "DB_RESET_RESULT": {
        const d = msg.payload || {};
        if (d.error) {
          flashDbStatus(`실패: ${d.error}`, "error");
        } else {
          flashDbStatus(`✅ 비웠습니다 (state 키 ${d.redis_state_keys_cleared}개 제거)`, "ok");
          refreshStats();
        }
        break;
      }
    }
  }

  // ── 입력 ───────────────────────────────────────────────────
  const sendBtn = document.getElementById("send-btn");
  const stopBtn = document.getElementById("stop-btn");
  const userInput = document.getElementById("user-input");
  const charCount = document.getElementById("char-count");
  const maxInputLength = Number(userInput.getAttribute("maxlength") || 500);
  let isComposingText = false;
  let suppressNextEnter = false;

  sendBtn.addEventListener("click", sendMessage);
  userInput.addEventListener("compositionstart", () => {
    isComposingText = true;
  });
  userInput.addEventListener("compositionend", () => {
    isComposingText = false;
    setTimeout(updateInputState, 0);
    setTimeout(() => {
      suppressNextEnter = false;
    }, 120);
  });
  userInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      const composing = e.isComposing || e.keyCode === 229 || isComposingText;
      if (composing) {
        suppressNextEnter = true;
        setTimeout(() => {
          suppressNextEnter = false;
        }, 120);
        return;
      }
      if (suppressNextEnter) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      sendMessage();
    }
  });
  userInput.addEventListener("input", () => {
    userInput.style.height = "auto";
    userInput.style.height = Math.min(userInput.scrollHeight, 120) + "px";
    updateInputState();
  });
  updateInputState();

  function updateInputState() {
    const len = userInput.value.length;
    charCount.textContent = `${len}/${maxInputLength}`;
    charCount.classList.toggle("near-limit", len >= Math.floor(maxInputLength * 0.9));
    charCount.classList.toggle("at-limit", len >= maxInputLength);
    sendBtn.disabled = isRunning || userInput.value.trim().length === 0;
  }

  function sendMessage() {
    const text = userInput.value.trim();
    if (!text || isRunning) return;
    appendMessage("user", text);
    userInput.value = "";
    userInput.style.height = "auto";
    updateInputState();

    if (!port) {
      appendErrorMessage("백그라운드 연결이 끊겼습니다. 사이드패널을 다시 열어주세요.");
      setStatus("disconnected", "백그라운드 연결 끊김");
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
    setStatus("ready", "중지됨");
  });

  // ── 탐색 모드 토글 (DB 채우기) ────────────────────────────
  const exploreBtn = document.getElementById("explore-btn");

  function renderExploreBtn(on) {
    exploreBtn.textContent = on ? "● REC" : "OFF";
    exploreBtn.classList.toggle("explore-on", on);
    exploreBtn.classList.toggle("explore-off", !on);
  }

  chrome.storage.local.get("exploration_mode", ({ exploration_mode }) => {
    renderExploreBtn(!!exploration_mode);
  });

  exploreBtn.addEventListener("click", async () => {
    const { exploration_mode } = await chrome.storage.local.get("exploration_mode");
    const next = !exploration_mode;
    await chrome.storage.local.set({ exploration_mode: next });
    renderExploreBtn(next);
    appendMessage(
      "assistant",
      next
        ? "🔴 탐색 모드 시작. 페이지를 손으로 탐색하면 상태가 자동으로 DB에 적재됩니다."
        : "⚪ 탐색 모드 종료. STATE_CHANGED 업로드를 중단합니다."
    );
  });

  // ── 대화 초기화 ────────────────────────────────────────────
  const clearBtn = document.getElementById("clear-btn");
  clearBtn.addEventListener("click", () => {
    if (isRunning) return;
    if (port) port.postMessage({ type: "CLEAR_CONVERSATION" });
    else clearMessagesUI();
  });

  // ── 대화 내역 패널 ────────────────────────────────────────
  const historyBtn = document.getElementById("history-btn");
  const historyPanel = document.getElementById("history-panel");
  const sessionListEl = document.getElementById("session-list");
  const newSessionBtn = document.getElementById("new-session-btn");

  historyBtn.addEventListener("click", () => {
    const opening = historyPanel.classList.contains("hidden");
    historyPanel.classList.toggle("hidden");
    historyBtn.classList.toggle("active", opening);
    if (opening) {
      sessionListEl.innerHTML = `<li class="session-empty">불러오는 중...</li>`;
      if (port) port.postMessage({ type: "REQUEST_HISTORY" });
    }
  });

  newSessionBtn.addEventListener("click", () => {
    if (isRunning) return;
    if (port) port.postMessage({ type: "NEW_SESSION" });
    historyPanel.classList.add("hidden");
    historyBtn.classList.remove("active");
  });

  function renderSessionList(sessions, currentSessionId) {
    if (sessions.length === 0) {
      sessionListEl.innerHTML = `<li class="session-empty">아직 대화 내역이 없습니다.</li>`;
      return;
    }
    sessionListEl.innerHTML = "";
    for (const s of sessions) {
      const li = document.createElement("li");
      li.className = "session-item";
      if (s.session_id === currentSessionId) li.classList.add("active");

      const body = document.createElement("div");
      body.className = "session-body";

      const title = document.createElement("div");
      title.className = "session-title";
      title.textContent = truncate(s.title || "(빈 대화)", 40);

      const time = document.createElement("div");
      time.className = "session-time";
      time.textContent = s.last_activity ? formatTime(s.last_activity) : "";

      body.appendChild(title);
      body.appendChild(time);
      body.addEventListener("click", () => {
        if (isRunning) return;
        if (port) port.postMessage({ type: "SWITCH_SESSION", payload: { session_id: s.session_id } });
        historyPanel.classList.add("hidden");
        historyBtn.classList.remove("active");
      });

      const delBtn = document.createElement("button");
      delBtn.className = "session-delete";
      delBtn.title = "이 대화 삭제";
      delBtn.setAttribute("aria-label", "이 대화 삭제");
      delBtn.textContent = "✕";
      delBtn.addEventListener("click", (e) => {
        // body 클릭(=세션 전환)으로 버블링되면 삭제 직후 사라진 세션을 다시 열려 시도해 에러난다.
        e.stopPropagation();
        if (isRunning) return;
        const label = truncate(s.title || "(빈 대화)", 30);
        if (!confirm(`"${label}" 대화를 삭제할까요? 되돌릴 수 없습니다.`)) return;
        if (port) port.postMessage({ type: "DELETE_SESSION", payload: { session_id: s.session_id } });
      });

      li.appendChild(body);
      li.appendChild(delBtn);
      sessionListEl.appendChild(li);
    }
  }

  function renderLoadedSession(sessionId, messages) {
    messagesEl.innerHTML = "";
    if (messages.length === 0) {
      messagesEl.innerHTML = `
        <div class="msg-bubble assistant">
          새로운 대화를 시작하세요. 무엇을 도와드릴까요?
        </div>`;
      hideProgress();
      return;
    }
    for (const m of messages) renderHistoryMessage(m.role, m.content);
    hideProgress();
    scrollToBottom();
  }

  function renderHistoryMessage(role, content) {
    switch (role) {
      case "user":
      case "assistant":
      case "error":
      case "complete":
        appendMessage(role, content);
        break;
      case "action": {
        const m = content.match(/^(단계 \d+\/\d+):\s*(.+)$/);
        if (m) appendActionMessage(m[1], m[2]);
        else appendActionMessage("단계", content);
        break;
      }
      case "wait": {
        // 과거 wait 지시문은 버튼 없이 안내만 표시.
        const el = document.createElement("div");
        el.className = "msg-bubble wait-user";
        const instr = document.createElement("div");
        instr.className = "wait-instruction";
        instr.innerHTML = `<strong>⏳ 사용자 확인</strong><br>${escapeHtml(content)}`;
        el.appendChild(instr);
        messagesEl.appendChild(el);
        break;
      }
      default:
        appendMessage("assistant", content);
    }
  }

  function truncate(text, max) {
    const s = String(text || "");
    return s.length > max ? s.slice(0, max) + "..." : s;
  }

  function formatTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    const pad = (n) => String(n).padStart(2, "0");
    if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // ── 빠른 칩 ────────────────────────────────────────────────
  document.getElementById("quick-chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip || isRunning) return;
    userInput.value = chip.textContent.trim();
    userInput.dispatchEvent(new Event("input"));
    userInput.focus();
  });

  // ── 설정 패널 ───────────────────────────────────
  // 세 가지 섹션 통합: 플래닝 엔드포인트 / 서버 URL / DB 상태.
  const settingsBtn = document.getElementById("settings-btn");
  const settingsPanel = document.getElementById("settings-panel");

  // ── 1) 플래닝 엔드포인트 ─────────────────────
  const endpointSelect = document.getElementById("endpoint-select");
  const saveEndpointBtn = document.getElementById("save-endpoint-btn");
  const resetEndpointBtn = document.getElementById("reset-endpoint-btn");
  const endpointStatus = document.getElementById("endpoint-status");

  const DEFAULT_ENDPOINT = "/plan";
  const VALID_ENDPOINTS = new Set(["/plan", "/plan/strict", "/query"]);

  chrome.storage.local.get("planning_endpoint", ({ planning_endpoint }) => {
    const value =
      planning_endpoint && VALID_ENDPOINTS.has(planning_endpoint)
        ? planning_endpoint
        : DEFAULT_ENDPOINT;
    endpointSelect.value = value;
  });

  saveEndpointBtn.addEventListener("click", () => {
    const value = endpointSelect.value;
    if (!VALID_ENDPOINTS.has(value)) {
      flashEndpointStatus("알 수 없는 엔드포인트입니다.", "error");
      return;
    }
    chrome.storage.local.set({ planning_endpoint: value }, () => {
      flashEndpointStatus(`✅ 저장됨: ${value}. 다음 요청부터 적용됩니다.`, "ok");
    });
  });

  resetEndpointBtn.addEventListener("click", () => {
    chrome.storage.local.remove("planning_endpoint", () => {
      endpointSelect.value = DEFAULT_ENDPOINT;
      flashEndpointStatus(`기본값(${DEFAULT_ENDPOINT})으로 되돌렸습니다.`, "ok");
    });
  });

  function flashEndpointStatus(text, kind) {
    endpointStatus.textContent = text;
    endpointStatus.style.color =
      kind === "error" ? "#e53935" : kind === "warn" ? "#f0a500" : "#43a047";
    endpointStatus.classList.remove("hidden");
  }

  // ── 2) 서버 URL override ─────────────────────
  const serverInput = document.getElementById("server-url-input");
  const saveServerBtn = document.getElementById("save-server-btn");
  const resetServerBtn = document.getElementById("reset-server-btn");
  const serverStatus = document.getElementById("server-status");

  chrome.storage.local.get("server_url_override", ({ server_url_override }) => {
    if (server_url_override) serverInput.value = server_url_override;
  });

  settingsBtn.addEventListener("click", () => {
    settingsPanel.classList.toggle("hidden");
    if (!settingsPanel.classList.contains("hidden")) {
      endpointSelect.focus();
      refreshStats();
    }
  });

  saveServerBtn.addEventListener("click", () => {
    const url = serverInput.value.trim();
    if (!url) {
      flashServerStatus("URL을 입력해주세요.", "error");
      return;
    }
    if (!/^https?:\/\//.test(url)) {
      flashServerStatus("http:// 또는 https:// 로 시작해야 합니다.", "warn");
      return;
    }
    chrome.storage.local.set({ server_url_override: url }, () => {
      flashServerStatus("✅ 저장됨. 다음 요청부터 적용됩니다.", "ok");
    });
  });

  resetServerBtn.addEventListener("click", () => {
    chrome.storage.local.remove("server_url_override", () => {
      serverInput.value = "";
      flashServerStatus("기본값으로 되돌렸습니다.", "ok");
    });
  });

  function flashServerStatus(text, kind) {
    serverStatus.textContent = text;
    serverStatus.style.color =
      kind === "error" ? "#e53935" : kind === "warn" ? "#f0a500" : "#43a047";
    serverStatus.classList.remove("hidden");
  }

  // ── 3) DB 통계 + 리셋 ────────────────────────
  const dbStatsEl = document.getElementById("db-stats");
  const refreshStatsBtn = document.getElementById("refresh-stats-btn");
  const resetDbBtn = document.getElementById("reset-db-btn");
  const dbStatus = document.getElementById("db-status");

  function flashDbStatus(text, kind) {
    dbStatus.textContent = text;
    dbStatus.style.color =
      kind === "error" ? "#e53935" : kind === "warn" ? "#f0a500" : "#43a047";
    dbStatus.classList.remove("hidden");
  }

  function refreshStats() {
    dbStatsEl.textContent = "로딩 중…";
    if (!port) {
      dbStatsEl.textContent = "(백그라운드 연결 없음)";
      return;
    }
    port.postMessage({ type: "DB_STATS" });
  }

  refreshStatsBtn.addEventListener("click", refreshStats);

  resetDbBtn.addEventListener("click", () => {
    const ok = confirm(
      "Qdrant 포인트, Neo4j 노드/엣지, Redis state 캐시를 모두 비웁니다. 계속할까요?"
    );
    if (!ok) return;
    flashDbStatus("DB 비우는 중…", "warn");
    if (port) port.postMessage({ type: "DB_RESET" });
  });

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

  function appendErrorMessage(text) {
    const el = appendMessage("error", text);
    const btn = document.createElement("button");
    btn.className = "error-copy-btn";
    btn.type = "button";
    btn.textContent = "오류 복사";
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = "복사됨";
      } catch {
        btn.textContent = "복사 실패";
      }
    });
    el.appendChild(btn);
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
    updateInputState();
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
