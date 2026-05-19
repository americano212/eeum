// Runner — Task #7 에서 구현
export function buildRunner(ctx) {
  const folderInput = document.getElementById("case-folder-input");
  const countEl = document.getElementById("case-count");
  const modeEl = document.getElementById("run-mode");
  const judgeEl = document.getElementById("run-judge");
  const runBtn = document.getElementById("run-btn");
  const progress = document.getElementById("run-progress");
  const progressFill = document.getElementById("progress-fill");
  const progressText = document.getElementById("progress-text");
  const resultsList = document.getElementById("run-results");
  const costEl = document.getElementById("cost-estimate");

  let loadedCases = [];

  function pillKind(score) {
    if (score >= 0.8) return "good";
    if (score >= 0.5) return "mid";
    return "bad";
  }

  function estimateCost() {
    const n = loadedCases.length;
    if (!n) {
      costEl.textContent = "";
      return;
    }
    const judge = judgeEl.checked ? 1 : 0;
    const llmCalls = n * (1 + judge);
    costEl.textContent = `예상 LLM 호출: ${llmCalls}회 (모델별 비용 추후 표시)`;
  }

  folderInput.addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []).filter((f) =>
      f.name.endsWith(".json")
    );
    loadedCases = [];
    for (const f of files) {
      try {
        const txt = await f.text();
        const obj = JSON.parse(txt);
        if (obj.case_id && obj.query) loadedCases.push(obj);
      } catch (err) {
        console.warn("[runner] skip", f.name, err);
      }
    }
    countEl.textContent = `로드된 케이스: ${loadedCases.length}`;
    estimateCost();
  });

  judgeEl.addEventListener("change", estimateCost);

  runBtn.addEventListener("click", () => {
    if (!loadedCases.length) {
      progressText.textContent = "케이스를 먼저 로드하세요.";
      progress.classList.remove("hidden");
      return;
    }
    resultsList.innerHTML = "";
    progress.classList.remove("hidden");
    progressFill.style.width = "0%";
    progressText.textContent = "실행 시작...";
    runBtn.disabled = true;
    ctx.send({
      type: "BENCH_RUN_CASES",
      payload: {
        cases: loadedCases,
        mode: modeEl.value,
        runJudge: judgeEl.checked,
      },
    });
  });

  ctx.subscribe((msg) => {
    if (msg.type === "RUN_STARTED") {
      progressText.textContent = `0/${msg.payload.total} 실행 중 (${msg.payload.mode})`;
    } else if (msg.type === "RUN_PROGRESS") {
      const p = msg.payload;
      const pct = Math.round(((p.index || 0) / Math.max(p.total, 1)) * 100);
      progressFill.style.width = `${pct}%`;
      progressText.textContent = `${p.index + 1}/${p.total} — ${p.case_id?.slice(0, 8) || ""}`;
    } else if (msg.type === "RUN_CASE_DONE") {
      const r = msg.payload;
      const li = document.createElement("li");
      if (r.error) {
        li.innerHTML = `<span class="score-pill bad">ERR</span> ${r.case_id?.slice(0, 8) || ""}: ${r.error}`;
      } else {
        const score = r.composite ?? 0;
        const stale = r.stale ? `<span class="score-pill stale">stale</span>` : "";
        li.innerHTML = `
          <span class="score-pill ${pillKind(score)}">${score.toFixed(2)}</span>
          ${stale}
          <strong>${r.case_id?.slice(0, 8)}</strong>
          <span style="color:var(--fg-dim);font-size:11px">
            target=${r.target_hit ?? "-"} outcome=${r.outcome_match ?? "-"} safety=${r.safety_correct ?? "-"} ${r.processing_ms}ms ${r.tokens?.total || 0}tok
          </span>
        `;
      }
      resultsList.appendChild(li);
    } else if (msg.type === "RUN_FINISHED") {
      progressFill.style.width = "100%";
      const s = msg.payload.summary;
      progressText.textContent = `완료 — 평균 ${s.avg_composite.toFixed(3)} (n=${s.n_scored}/${s.n}), ${s.total_tokens} 토큰`;
      runBtn.disabled = false;
    } else if (msg.type === "ERROR") {
      progressText.textContent = `오류: ${msg.payload.error}`;
      runBtn.disabled = false;
    }
  });
}
