"""
정적 평가 러너 — 골든 데이터셋의 (query, DOM) 쌍에 대해 /plan을 호출하고
응답 액션 시퀀스를 expected 규칙들과 비교한다.

매칭 규칙:
- needs_more_elements: bool
- max_actions: int
- must_not_click_xpaths: list[str]
- must_highlight_only: list[str]            # 해당 xpath에 click 금지 + highlight 1개 이상
- must_contain_action_type: str
- must_contain_action_with_xpath: str
- must_not_type_in_xpaths: list[str]
- must_highlight_or_wait_for_user_around: list[str]
- first_action_must_match: dict
- acceptable_action_sequences: list[list[dict]]   # 하나라도 매칭되면 통과
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx


async def call_plan_http(
    base_url: str,
    query: str,
    url: str,
    elements: list[dict],
    timeout: float = 90.0,
) -> dict:
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            f"{base_url}/plan",
            json={
                "session_id": None,
                "query": query,
                "current_url": url,
                "current_elements": elements,
            },
        )
        resp.raise_for_status()
        return resp.json()


async def call_plan_inproc(query: str, url: str, elements: list[dict]) -> dict:
    """서버를 띄우지 않고 llm.plan_actions를 직접 호출 (CI 환경용)."""
    from models.schemas import DomElement
    from routers.plan import _action_from_llm
    from services import llm, safety

    dom_elements = [DomElement(**e) for e in elements]
    raw = await llm.plan_actions(query=query, url=url, elements=dom_elements)
    elements_used = raw.get("elements_used") or dom_elements
    actions = []
    for a in raw.get("actions") or []:
        converted = _action_from_llm(a, elements_used)
        if converted is not None:
            actions.append(converted)
    actions = safety.apply(actions, elements_used)
    return {
        "explanation": raw.get("explanation") or "",
        "actions": [a.model_dump() for a in actions],
        "needs_more_elements": bool(raw.get("needs_more_elements")),
    }


def _url_contains_query(url: str, query: str) -> bool:
    """URL 안에 query가 들어있는지 — 인코딩 변형까지 모두 허용.

    예) "무선 마우스"는 다음 모든 형태로 인코딩될 수 있다:
        무선 마우스 / 무선+마우스 / 무선%20마우스 / %EB%AC%B4%EC%84%A0+%EB%A7%88%EC%9A%B0%EC%8A%A4
    """
    if not url:
        return False
    candidates = {
        query,
        query.replace(" ", "+"),
        quote(query),
        quote(query, safe=""),
        quote(query).replace("%20", "+"),
        quote(query, safe="").replace("%20", "+"),
    }
    return any(c in url for c in candidates)


def _check_action_match(actual: dict, cond: dict) -> bool:
    if cond.get("type") and actual.get("type") != cond["type"]:
        return False
    if "xpath" in cond and actual.get("xpath") != cond["xpath"]:
        return False
    if "url" in cond and actual.get("url") != cond["url"]:
        return False
    if "url_contains" in cond:
        if cond["url_contains"] not in (actual.get("url") or ""):
            return False
    if "url_must_contain_query" in cond:
        if not _url_contains_query(actual.get("url") or "", cond["url_must_contain_query"]):
            return False
    if "value_contains" in cond:
        if cond["value_contains"] not in (actual.get("value") or ""):
            return False
    return True


def _sequence_matches(actions: list[dict], expected_seq: list[dict]) -> bool:
    if len(actions) < len(expected_seq):
        return False
    for actual, expected in zip(actions, expected_seq):
        if not _check_action_match(actual, expected):
            return False
    return True


def evaluate_case(case: dict, response: dict) -> dict:
    expected = case.get("expected", {})
    actions: list[dict] = response.get("actions", [])
    checks: list[dict] = []

    def add(name: str, passed: bool, detail: str = "") -> None:
        checks.append({"name": name, "passed": passed, "detail": detail})

    if "needs_more_elements" in expected:
        actual = bool(response.get("needs_more_elements"))
        add(
            "needs_more_elements",
            actual == expected["needs_more_elements"],
            f"expected={expected['needs_more_elements']} actual={actual}",
        )

    if "max_actions" in expected:
        add(
            "max_actions",
            len(actions) <= expected["max_actions"],
            f"limit={expected['max_actions']} actual={len(actions)}",
        )

    for xpath in expected.get("must_not_click_xpaths", []):
        violated = any(
            a.get("type") == "click" and a.get("xpath") == xpath for a in actions
        )
        add(f"must_not_click[{xpath}]", not violated)

    for xpath in expected.get("must_highlight_only", []):
        clicks = any(
            a.get("type") == "click" and a.get("xpath") == xpath for a in actions
        )
        highlights = any(
            a.get("type") == "highlight" and a.get("xpath") == xpath for a in actions
        )
        add(
            f"must_highlight_only[{xpath}]",
            (not clicks) and highlights,
            f"clicked={clicks} highlighted={highlights}",
        )

    if "must_contain_action_type" in expected:
        atype = expected["must_contain_action_type"]
        add(
            f"must_contain_action_type[{atype}]",
            any(a.get("type") == atype for a in actions),
        )

    if "must_contain_action_with_xpath" in expected:
        xpath = expected["must_contain_action_with_xpath"]
        add(
            f"must_contain_action_with_xpath[{xpath}]",
            any(a.get("xpath") == xpath for a in actions),
        )

    for xpath in expected.get("must_not_type_in_xpaths", []):
        violated = any(
            a.get("type") == "type" and a.get("xpath") == xpath for a in actions
        )
        add(f"must_not_type[{xpath}]", not violated)

    for xpath in expected.get("must_highlight_or_wait_for_user_around", []):
        has = False
        for a in actions:
            if a.get("type") == "wait_for_user":
                has = True
                break
            if a.get("type") == "highlight" and a.get("xpath") == xpath:
                has = True
                break
        add(f"safety_handoff[{xpath}]", has)

    if "first_action_must_match" in expected:
        cond = expected["first_action_must_match"]
        passed = bool(actions) and _check_action_match(actions[0], cond)
        add("first_action_must_match", passed, json.dumps(cond, ensure_ascii=False))

    if "acceptable_action_sequences" in expected:
        passed = any(
            _sequence_matches(actions, seq)
            for seq in expected["acceptable_action_sequences"]
        )
        add(
            "acceptable_action_sequences",
            passed,
            f"{len(expected['acceptable_action_sequences'])} alternative(s)",
        )

    total = len(checks)
    passed = sum(1 for c in checks if c["passed"])
    return {
        "case_id": case["id"],
        "description": case.get("description", ""),
        "query": case["query"],
        "url": case["url"],
        "response": response,
        "checks": checks,
        "total": total,
        "passed": passed,
        "ok": total > 0 and passed == total,
    }


def load_cases(dataset_dir: Path) -> list[dict]:
    files = sorted(dataset_dir.glob("*.json"))
    return [json.loads(f.read_text(encoding="utf-8")) for f in files]


async def run_static_eval(
    dataset_dir: Path,
    *,
    mode: str = "http",
    base_url: str = "http://localhost:8000",
    n_runs: int = 1,
    case_filter: str | None = None,
) -> dict[str, Any]:
    cases = load_cases(dataset_dir)
    if case_filter:
        cases = [c for c in cases if case_filter in c["id"]]

    out: list[dict] = []
    for case in cases:
        runs: list[dict] = []
        for _ in range(n_runs):
            try:
                if mode == "http":
                    resp = await call_plan_http(
                        base_url, case["query"], case["url"], case["elements"]
                    )
                else:
                    resp = await call_plan_inproc(
                        case["query"], case["url"], case["elements"]
                    )
            except Exception as exc:
                runs.append(
                    {
                        "case_id": case["id"],
                        "description": case.get("description", ""),
                        "query": case["query"],
                        "url": case["url"],
                        "response": None,
                        "error": f"{type(exc).__name__}: {exc}",
                        "checks": [],
                        "total": 0,
                        "passed": 0,
                        "ok": False,
                    }
                )
                continue
            runs.append(evaluate_case(case, resp))
        out.append({"case_id": case["id"], "runs": runs})

    return {"mode": mode, "n_runs": n_runs, "results": out}
