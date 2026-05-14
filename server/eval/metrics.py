"""정적/동적 평가 결과에서 메트릭을 계산하고 콘솔/마크다운으로 리포트한다."""
from __future__ import annotations

import json
from pathlib import Path
from statistics import mean
from typing import Any


# ────────────────────────────────────────────────────────────────────
# 정적 평가 메트릭
# ────────────────────────────────────────────────────────────────────

def static_metrics(static_result: dict, judge_results: list[dict] | None = None) -> dict[str, Any]:
    """static_result는 run_static_eval() 반환값."""
    judge_by_id = {j["case_id"]: j for j in (judge_results or [])}
    cases: list[dict] = []
    total_runs = 0
    total_ok = 0
    total_checks = 0
    total_passed = 0
    judge_pass = 0
    judge_total = 0

    for entry in static_result.get("results", []):
        case_id = entry["case_id"]
        runs = entry["runs"]
        ok_count = sum(1 for r in runs if r["ok"])
        passed_check_count = sum(r["passed"] for r in runs)
        total_check_count = sum(r["total"] for r in runs)
        judgement = judge_by_id.get(case_id)
        if judgement:
            judge_total += 1
            if judgement["verdict"] == "pass":
                judge_pass += 1

        cases.append(
            {
                "case_id": case_id,
                "n_runs": len(runs),
                "ok_rate": ok_count / len(runs) if runs else 0.0,
                "check_pass_rate": (
                    passed_check_count / total_check_count if total_check_count else 0.0
                ),
                "judge": judgement,
                "first_run_checks": runs[0]["checks"] if runs else [],
                "first_run_error": runs[0].get("error") if runs else None,
            }
        )
        total_runs += len(runs)
        total_ok += ok_count
        total_checks += total_check_count
        total_passed += passed_check_count

    return {
        "mode": static_result.get("mode"),
        "n_runs_per_case": static_result.get("n_runs"),
        "n_cases": len(cases),
        "total_runs": total_runs,
        "case_pass_rate": total_ok / total_runs if total_runs else 0.0,
        "check_pass_rate": total_passed / total_checks if total_checks else 0.0,
        "judge_pass_rate": (judge_pass / judge_total) if judge_total else None,
        "cases": cases,
    }


# ────────────────────────────────────────────────────────────────────
# 동적 평가 메트릭
# ────────────────────────────────────────────────────────────────────

def dynamic_metrics(dynamic_result: dict) -> dict[str, Any]:
    scenarios = dynamic_result.get("results", [])
    n_total = len(scenarios)
    n_success = sum(1 for s in scenarios if s["success"])
    avg_steps = (
        mean(len(s["steps"]) for s in scenarios) if scenarios else 0.0
    )
    return {
        "n_scenarios": n_total,
        "success_rate": (n_success / n_total) if n_total else 0.0,
        "avg_steps": avg_steps,
        "scenarios": [
            {
                "id": s["scenario_id"],
                "success": s["success"],
                "steps": len(s["steps"]),
                "error": s.get("error"),
            }
            for s in scenarios
        ],
    }


# ────────────────────────────────────────────────────────────────────
# 리포트 출력
# ────────────────────────────────────────────────────────────────────

def render_markdown(static_m: dict | None, dynamic_m: dict | None) -> str:
    lines: list[str] = ["# eeum eval report", ""]

    if static_m is not None:
        lines.append("## Static evaluation")
        lines.append("")
        lines.append(f"- mode: `{static_m['mode']}`")
        lines.append(f"- cases: **{static_m['n_cases']}** (runs/case: {static_m['n_runs_per_case']})")
        lines.append(f"- case pass-rate: **{static_m['case_pass_rate']:.1%}**")
        lines.append(f"- check pass-rate: **{static_m['check_pass_rate']:.1%}**")
        if static_m["judge_pass_rate"] is not None:
            lines.append(f"- LLM-judge pass-rate: **{static_m['judge_pass_rate']:.1%}**")
        lines.append("")
        lines.append("| case | ok-rate | checks | judge |")
        lines.append("|------|---------|--------|-------|")
        for c in static_m["cases"]:
            judge_txt = "—"
            if c["judge"]:
                judge_txt = f"{c['judge']['verdict']} ({c['judge']['score']:.2f})"
            lines.append(
                f"| {c['case_id']} | {c['ok_rate']:.0%} | "
                f"{c['check_pass_rate']:.0%} | {judge_txt} |"
            )
        lines.append("")

        failures = [c for c in static_m["cases"] if c["ok_rate"] < 1.0]
        if failures:
            lines.append("### Failing checks")
            lines.append("")
            for c in failures:
                lines.append(f"**{c['case_id']}**")
                if c["first_run_error"]:
                    lines.append(f"- error: `{c['first_run_error']}`")
                for chk in c["first_run_checks"]:
                    icon = "✅" if chk["passed"] else "❌"
                    lines.append(f"- {icon} {chk['name']} {chk.get('detail') or ''}".rstrip())
                if c["judge"]:
                    lines.append(
                        f"- judge: `{c['judge']['verdict']}` — {c['judge']['reasoning']}"
                    )
                lines.append("")

    if dynamic_m is not None:
        lines.append("## Dynamic evaluation (Playwright)")
        lines.append("")
        lines.append(f"- scenarios: **{dynamic_m['n_scenarios']}**")
        lines.append(f"- success-rate: **{dynamic_m['success_rate']:.1%}**")
        lines.append(f"- avg steps: {dynamic_m['avg_steps']:.1f}")
        lines.append("")
        lines.append("| scenario | success | steps | error |")
        lines.append("|----------|---------|-------|-------|")
        for s in dynamic_m["scenarios"]:
            icon = "✅" if s["success"] else "❌"
            err = (s["error"] or "").replace("|", "\\|")[:60]
            lines.append(f"| {s['id']} | {icon} | {s['steps']} | {err} |")
        lines.append("")

    return "\n".join(lines)


def render_console(static_m: dict | None, dynamic_m: dict | None) -> str:
    out: list[str] = []
    if static_m is not None:
        out.append("─── Static eval ─────────────────────────")
        out.append(
            f"  mode={static_m['mode']}  cases={static_m['n_cases']}  "
            f"runs/case={static_m['n_runs_per_case']}"
        )
        out.append(f"  case pass-rate : {static_m['case_pass_rate']:.1%}")
        out.append(f"  check pass-rate: {static_m['check_pass_rate']:.1%}")
        if static_m["judge_pass_rate"] is not None:
            out.append(f"  llm-judge      : {static_m['judge_pass_rate']:.1%}")
        for c in static_m["cases"]:
            mark = "✓" if c["ok_rate"] == 1.0 else "✗"
            out.append(
                f"   {mark} {c['case_id']:<40} "
                f"ok={c['ok_rate']:.0%} checks={c['check_pass_rate']:.0%}"
            )
    if dynamic_m is not None:
        out.append("─── Dynamic eval ────────────────────────")
        out.append(
            f"  scenarios={dynamic_m['n_scenarios']}  "
            f"success={dynamic_m['success_rate']:.1%}  "
            f"avg_steps={dynamic_m['avg_steps']:.1f}"
        )
        for s in dynamic_m["scenarios"]:
            mark = "✓" if s["success"] else "✗"
            err = f"  err={s['error']}" if s["error"] else ""
            out.append(f"   {mark} {s['id']:<40} steps={s['steps']}{err}")
    return "\n".join(out)


def dump_raw(static_result: dict | None, dynamic_result: dict | None, out_path: Path) -> None:
    out_path.write_text(
        json.dumps(
            {"static": static_result, "dynamic": dynamic_result},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
