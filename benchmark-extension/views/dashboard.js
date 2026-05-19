// Dashboard — 결과 폴더 import 후 모드별·태그별 집계.
export function buildDashboard(ctx) {
  const folderInput = document.getElementById("result-folder-input");
  const summary = document.getElementById("dashboard-summary");
  const byMode = document.getElementById("dashboard-by-mode");
  const byTag = document.getElementById("dashboard-by-tag");
  const list = document.getElementById("dashboard-cases");

  let runs = [];
  let casesByTag = {}; // case_id → tags lookup (없으면 추후 케이스 import 도)

  function pillKind(score) {
    if (score >= 0.8) return "good";
    if (score >= 0.5) return "mid";
    return "bad";
  }

  function avg(arr) {
    return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  }

  function renderSummary() {
    if (!runs.length) {
      summary.innerHTML = "<p class='hint'>로드된 결과 없음.</p>";
      byMode.innerHTML = "";
      byTag.innerHTML = "";
      list.innerHTML = "";
      return;
    }
    const totalRuns = runs.length;
    const totalCases = runs.reduce(
      (s, r) => s + (r.results?.length || 0),
      0
    );
    const allScored = runs.flatMap((r) =>
      (r.results || []).filter((x) => typeof x.composite === "number")
    );
    summary.innerHTML = `
      <table>
        <tr><th>run 파일</th><td>${totalRuns}</td></tr>
        <tr><th>총 케이스 실행</th><td>${totalCases}</td></tr>
        <tr><th>평균 composite</th><td>${avg(allScored.map((x) => x.composite)).toFixed(3)}</td></tr>
        <tr><th>평균 처리 시간</th><td>${Math.round(avg(allScored.map((x) => x.processing_ms || 0)))} ms</td></tr>
        <tr><th>총 시스템 토큰</th><td>${runs.reduce((s, r) => s + (r.summary?.total_tokens || 0), 0)}</td></tr>
      </table>
    `;
  }

  function renderByMode() {
    const buckets = {};
    for (const r of runs) {
      const m = r.mode || "unknown";
      (buckets[m] = buckets[m] || []).push(...(r.results || []));
    }
    const rows = Object.entries(buckets).map(([mode, results]) => {
      const scored = results.filter((x) => typeof x.composite === "number");
      return `
        <tr>
          <td>${mode}</td>
          <td>${scored.length}</td>
          <td>${avg(scored.map((x) => x.composite)).toFixed(3)}</td>
          <td>${avg(scored.map((x) => x.target_hit || 0)).toFixed(2)}</td>
          <td>${avg(scored.map((x) => x.outcome_match || 0)).toFixed(2)}</td>
          <td>${avg(scored.map((x) => x.safety_correct || 0)).toFixed(2)}</td>
          <td>${Math.round(avg(scored.map((x) => x.processing_ms || 0)))}ms</td>
        </tr>`;
    });
    byMode.innerHTML = `
      <h3>모드별</h3>
      <table>
        <tr><th>mode</th><th>n</th><th>composite</th><th>target</th><th>outcome</th><th>safety</th><th>time</th></tr>
        ${rows.join("")}
      </table>
    `;
  }

  function renderByTag() {
    const buckets = {};
    for (const r of runs) {
      for (const res of r.results || []) {
        const tags = casesByTag[res.case_id] || ["(미분류)"];
        for (const tag of tags) {
          (buckets[tag] = buckets[tag] || []).push(res);
        }
      }
    }
    const rows = Object.entries(buckets)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([tag, results]) => {
        const scored = results.filter(
          (x) => typeof x.composite === "number"
        );
        return `
          <tr>
            <td>${tag}</td>
            <td>${scored.length}</td>
            <td>${avg(scored.map((x) => x.composite)).toFixed(3)}</td>
          </tr>`;
      });
    byTag.innerHTML = `
      <h3>태그별</h3>
      <table>
        <tr><th>tag</th><th>n</th><th>composite</th></tr>
        ${rows.join("")}
      </table>
    `;
  }

  function renderCaseList() {
    const flat = runs.flatMap((r) =>
      (r.results || []).map((res) => ({ ...res, mode: r.mode }))
    );
    flat.sort((a, b) => (a.composite ?? 1) - (b.composite ?? 1));
    list.innerHTML = flat
      .slice(0, 50)
      .map((r) => {
        const score = r.composite ?? 0;
        return `
          <li>
            <span class="score-pill ${pillKind(score)}">${score.toFixed(2)}</span>
            <strong>${r.case_id?.slice(0, 8) || ""}</strong>
            <span style="color:var(--fg-dim);font-size:11px">${r.mode || ""}</span>
            ${r.reasoning ? `<div style="margin-top:4px;font-size:11.5px;color:var(--fg-dim)">${r.reasoning}</div>` : ""}
          </li>`;
      })
      .join("");
  }

  folderInput.addEventListener("change", async (e) => {
    runs = [];
    casesByTag = {};
    const files = Array.from(e.target.files || []).filter((f) =>
      f.name.endsWith(".json")
    );
    for (const f of files) {
      try {
        const obj = JSON.parse(await f.text());
        if (obj.run_id && obj.results) {
          runs.push(obj);
        } else if (obj.case_id && obj.tags) {
          casesByTag[obj.case_id] = obj.tags;
        }
      } catch (err) {
        console.warn("[dashboard] skip", f.name, err);
      }
    }
    renderSummary();
    renderByMode();
    renderByTag();
    renderCaseList();
  });

  renderSummary();
}
