// Case Builder — Task #6 에서 구현
export function buildCaseBuilder(ctx) {
  const queryEl = document.getElementById("case-query");
  const pickBtn = document.getElementById("pick-target-btn");
  const snapshotBtn = document.getElementById("snapshot-btn");
  const targetDisplay = document.getElementById("target-display");
  const targetInfo = document.getElementById("target-info");
  const snapDisplay = document.getElementById("snapshot-display");
  const snapInfo = document.getElementById("snapshot-info");
  const expectedUrl = document.getElementById("case-expected-url");
  const expectedOutcome = document.getElementById("case-expected-outcome");
  const safety = document.getElementById("case-safety");
  const tags = document.getElementById("case-tags");
  const saveBtn = document.getElementById("save-case-btn");
  const clearBtn = document.getElementById("clear-case-btn");
  const statusEl = document.getElementById("case-status");

  let pickedTarget = null;
  let snapshot = null;

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = `status-line ${kind || ""}`;
  }

  function renderTarget(t) {
    if (!t) {
      targetDisplay.classList.add("hidden");
      return;
    }
    pickedTarget = t;
    targetInfo.textContent = JSON.stringify(t, null, 2);
    targetDisplay.classList.remove("hidden");
  }

  function renderSnapshot(s) {
    if (!s) {
      snapDisplay.classList.add("hidden");
      return;
    }
    snapshot = s;
    snapInfo.textContent = `URL: ${s.url}\nstate_id: ${s.state_id}\ndom_hash: ${s.dom_hash}\nelements: ${s.elements?.length || 0}`;
    snapDisplay.classList.remove("hidden");
  }

  pickBtn.addEventListener("click", () => {
    setStatus("페이지에서 요소를 클릭하세요. ESC 로 취소.", "warn");
    ctx.send({ type: "BENCH_START_INSPECT" });
  });

  snapshotBtn.addEventListener("click", () => {
    setStatus("스냅샷 캡처 중...");
    ctx.send({ type: "BENCH_CAPTURE_SNAPSHOT" });
  });

  saveBtn.addEventListener("click", async () => {
    if (!queryEl.value.trim()) {
      setStatus("자연어 query 를 입력하세요.", "error");
      return;
    }
    if (!snapshot) {
      setStatus("DOM 스냅샷이 필요합니다. '스냅샷' 을 먼저 누르세요.", "error");
      return;
    }
    let site = "";
    try {
      site = new URL(snapshot.url).hostname;
    } catch (_) {}

    const caseObj = {
      case_id: crypto.randomUUID(),
      site,
      url: snapshot.url,
      captured_at: new Date().toISOString(),
      query: queryEl.value.trim(),
      dom_snapshot: {
        elements: snapshot.elements || [],
        dom_hash: snapshot.dom_hash,
        state_id: snapshot.state_id,
      },
      ground_truth: {
        target_xpath: pickedTarget?.xpath || null,
        target_xpath_alternatives: [],
        expected_actions: pickedTarget
          ? [{ type: "click", xpath: pickedTarget.xpath }]
          : [],
        expected_url_after: expectedUrl.value.trim() || null,
        expected_outcome_summary: expectedOutcome.value.trim() || null,
        safety_class: safety.value || null,
      },
      tags: tags.value
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      stale: false,
    };

    ctx.send({ type: "BENCH_SAVE_CASE", payload: caseObj });
    setStatus("저장 중...");
  });

  clearBtn.addEventListener("click", () => {
    queryEl.value = "";
    expectedUrl.value = "";
    expectedOutcome.value = "";
    safety.value = "";
    tags.value = "";
    pickedTarget = null;
    snapshot = null;
    renderTarget(null);
    renderSnapshot(null);
    setStatus("");
  });

  ctx.subscribe((msg) => {
    if (msg.type === "TARGET_PICKED") {
      renderTarget(msg.payload);
      setStatus("타겟 선택됨.", "ok");
    } else if (msg.type === "INSPECT_CANCELLED") {
      setStatus("취소됨.", "warn");
    } else if (msg.type === "SNAPSHOT_RESULT") {
      renderSnapshot(msg.payload);
      setStatus("스냅샷 캡처됨.", "ok");
    } else if (msg.type === "CASE_SAVED") {
      setStatus(`✅ 저장: ${msg.payload.case_id.slice(0, 8)}`, "ok");
    } else if (msg.type === "ERROR") {
      setStatus(`오류: ${msg.payload.error}`, "error");
    }
  });
}
