"""
eeum 평가 시스템 메인 엔트리포인트.

예시:
    # 서버에 붙어서 정적 평가
    python -m eval.run_eval --static

    # CI에서 서버 없이 인-프로세스로
    python -m eval.run_eval --static --mode inproc

    # 정적 + LLM-as-Judge + 동적까지 전부
    python -m eval.run_eval --static --judge --dynamic

    # 결과 저장 + 마크다운 리포트
    python -m eval.run_eval --static --report report.md --raw raw.json

종료 코드:
    0  모든 케이스 통과
    1  실패가 하나라도 있음 (CI 게이트용)
    2  실행 오류 (서버 연결 실패 등)
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path


HERE = Path(__file__).resolve().parent


def _ensure_server_dir_on_path() -> None:
    """python -m eval.run_eval 로 server 디렉터리에서 실행할 때 import 경로 맞춤."""
    server_root = HERE.parent
    if str(server_root) not in sys.path:
        sys.path.insert(0, str(server_root))


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="eeum evaluation runner")
    p.add_argument("--static", action="store_true", help="정적 평가 실행")
    p.add_argument("--dynamic", action="store_true", help="Playwright 동적 평가 실행")
    p.add_argument("--judge", action="store_true", help="LLM-as-Judge 추가 평가")
    p.add_argument(
        "--mode",
        choices=("http", "inproc"),
        default="http",
        help="정적 평가 호출 방식. inproc은 OpenAI 직접 호출 (CI용).",
    )
    p.add_argument(
        "--base-url",
        default=os.environ.get("EEUM_BASE_URL", "http://localhost:8000"),
        help="HTTP 모드에서 사용할 서버 주소",
    )
    p.add_argument("--n-runs", type=int, default=1, help="케이스당 반복 횟수 (비결정성 측정용)")
    p.add_argument("--filter", help="ID에 이 문자열이 포함된 케이스만 실행")
    p.add_argument("--judge-model", default="gpt-4o-mini")
    p.add_argument("--headed", action="store_true", help="동적 평가에서 브라우저 표시")
    p.add_argument(
        "--static-dir",
        default=str(HERE / "datasets" / "static"),
        help="정적 데이터셋 디렉터리",
    )
    p.add_argument(
        "--dynamic-dir",
        default=str(HERE / "datasets" / "dynamic"),
        help="동적 데이터셋 디렉터리",
    )
    p.add_argument("--report", help="마크다운 리포트 저장 경로")
    p.add_argument("--raw", help="원본 결과 JSON 저장 경로")
    p.add_argument(
        "--threshold",
        type=float,
        default=1.0,
        help="이 case pass-rate 미만이면 exit 1 (CI 게이트용)",
    )
    return p.parse_args()


async def _amain(args: argparse.Namespace) -> int:
    _ensure_server_dir_on_path()

    from eval import metrics
    from eval.runners import static_runner

    static_result = None
    static_m = None
    judge_results: list[dict] | None = None

    if args.static:
        static_result = await static_runner.run_static_eval(
            Path(args.static_dir),
            mode=args.mode,
            base_url=args.base_url,
            n_runs=args.n_runs,
            case_filter=args.filter,
        )
        if args.judge:
            from eval.runners import llm_judge

            cases_by_id = {c["id"]: c for c in static_runner.load_cases(Path(args.static_dir))}
            pairs: list[tuple[dict, dict]] = []
            for entry in static_result["results"]:
                case = cases_by_id[entry["case_id"]]
                first_run = entry["runs"][0] if entry["runs"] else None
                pairs.append((case, first_run["response"] if first_run else None))
            judge_results = await llm_judge.judge_all(pairs, model=args.judge_model)
        static_m = metrics.static_metrics(static_result, judge_results)

    dynamic_result = None
    dynamic_m = None
    if args.dynamic:
        from eval.runners import dynamic_runner

        dynamic_result = await dynamic_runner.run_dynamic_eval(
            Path(args.dynamic_dir),
            base_url=args.base_url,
            headless=not args.headed,
            scenario_filter=args.filter,
        )
        dynamic_m = metrics.dynamic_metrics(dynamic_result)

    print(metrics.render_console(static_m, dynamic_m))

    if args.report:
        Path(args.report).write_text(
            metrics.render_markdown(static_m, dynamic_m), encoding="utf-8"
        )
        print(f"\n[report]  {args.report}")
    if args.raw:
        metrics.dump_raw(static_result, dynamic_result, Path(args.raw))
        print(f"[raw]     {args.raw}")

    rates = [
        m["case_pass_rate"] if "case_pass_rate" in m else m["success_rate"]
        for m in (static_m, dynamic_m)
        if m is not None
    ]
    if rates and min(rates) < args.threshold:
        return 1
    return 0


def main() -> None:
    args = _parse_args()
    if not (args.static or args.dynamic):
        print("nothing to do (use --static and/or --dynamic)", file=sys.stderr)
        sys.exit(2)
    try:
        code = asyncio.run(_amain(args))
    except KeyboardInterrupt:
        code = 130
    except Exception as exc:
        print(f"[fatal] {type(exc).__name__}: {exc}", file=sys.stderr)
        code = 2
    sys.exit(code)


if __name__ == "__main__":
    main()
