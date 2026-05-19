// Explorer — 사용자가 페이지를 직접 돌아다니면 STATE_CHANGED → /dom/check + /dom/upload.
export function buildExplorer(ctx) {
  const btn = document.getElementById("explore-toggle-btn");
  const status = document.getElementById("explore-status");

  let captured = [];

  function render(on) {
    btn.textContent = on ? "탐색 ON (DB 채우는 중)" : "탐색 OFF";
    btn.style.background = on ? "var(--danger)" : "";
    btn.style.color = on ? "#fff" : "";
    refreshStatus();
  }

  function refreshStatus() {
    const on = btn.classList.contains("on");
    if (!on) {
      status.textContent = captured.length
        ? `(이전 세션) ${captured.length}개 페이지 적재됨.`
        : "";
      status.className = "status-line";
      return;
    }
    status.textContent = `🔴 자동 적재 중. 캡처된 페이지: ${captured.length}`;
    status.className = "status-line warn";
  }

  btn.addEventListener("click", () => {
    const on = !btn.classList.contains("on");
    btn.classList.toggle("on", on);
    if (on) captured = [];
    ctx.send({ type: "BENCH_EXPLORE_TOGGLE", payload: { on } });
    render(on);
  });

  ctx.subscribe((msg) => {
    if (msg.type === "EXPLORE_STATE") {
      btn.classList.toggle("on", !!msg.payload.on);
      render(!!msg.payload.on);
    } else if (msg.type === "EXPLORE_CAPTURED") {
      captured.push(msg.payload);
      refreshStatus();
    }
  });

  ctx.send({ type: "BENCH_EXPLORE_STATE" });
}
