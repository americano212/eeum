"""
Playwright 기반 동적 평가 러너.

실제 브라우저로 사이트를 띄우고 /plan 응답을 단계별로 실행하면서
success 조건이 만족되는지 확인한다.

scenario YAML 형식:
    id: ...
    description: ...
    start_url: https://...
    query: "..."
    success:
      url_contains: "..."        # 최종 URL이 이 문자열을 포함하면 성공
      text_visible: "..."        # 페이지에 이 텍스트가 보이면 성공 (선택)
    max_steps: 5
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import httpx
import yaml

# Playwright는 무거우니 함수 안에서 import.

INTERACTIVE_SELECTOR = (
    "button, input, select, textarea, a[href], "
    "[role=button], [role=link], [role=tab], [aria-label]"
)


async def _extract_elements(page) -> list[dict]:
    """Extension content.js의 단순화 버전 — 인터랙션 요소만 추출."""
    return await page.evaluate(
        """(selector) => {
            function xpathFor(el) {
                if (el.id) return `//*[@id="${el.id}"]`;
                const parts = [];
                while (el && el.nodeType === 1) {
                    let idx = 1;
                    let sib = el.previousElementSibling;
                    while (sib) {
                        if (sib.tagName === el.tagName) idx++;
                        sib = sib.previousElementSibling;
                    }
                    parts.unshift(`${el.tagName.toLowerCase()}[${idx}]`);
                    el = el.parentElement;
                }
                return '/' + parts.join('/');
            }
            const nodes = Array.from(document.querySelectorAll(selector));
            return nodes.slice(0, 80).map(el => ({
                tag: el.tagName.toLowerCase(),
                text: (el.innerText || el.value || '').trim().slice(0, 120),
                aria_label: el.getAttribute('aria-label'),
                role: el.getAttribute('role'),
                xpath: xpathFor(el),
                id: el.id || null,
                href: el.getAttribute('href'),
                type: el.getAttribute('type'),
                name: el.getAttribute('name'),
                placeholder: el.getAttribute('placeholder'),
            }));
        }""",
        INTERACTIVE_SELECTOR,
    )


async def _execute_action(page, action: dict, timeout_ms: int = 8000) -> str:
    """Returns 'ok', 'skipped', or raises."""
    t = action.get("type")
    if t == "navigate":
        await page.goto(action["url"], wait_until="domcontentloaded", timeout=timeout_ms)
        return "ok"
    if t == "click":
        loc = page.locator(f"xpath={action['xpath']}").first
        await loc.click(timeout=timeout_ms)
        return "ok"
    if t == "click_text":
        await page.get_by_text(action["text"], exact=False).first.click(timeout=timeout_ms)
        return "ok"
    if t == "type":
        loc = page.locator(f"xpath={action['xpath']}").first
        await loc.fill(action.get("value", ""), timeout=timeout_ms)
        return "ok"
    if t == "select":
        loc = page.locator(f"xpath={action['xpath']}").first
        await loc.select_option(action.get("value", ""), timeout=timeout_ms)
        return "ok"
    if t == "scroll":
        direction = action.get("direction", "down")
        amount = int(action.get("amount", 400))
        dy = amount if direction == "down" else -amount
        await page.mouse.wheel(0, dy)
        return "ok"
    if t in ("highlight", "wait_for_user"):
        return "skipped"  # 평가에서는 사용자 위임 액션을 무시
    if t == "wait":
        await page.wait_for_timeout(int(action.get("ms", 500)))
        return "ok"
    return "skipped"


async def _call_plan(base_url: str, query: str, url: str, elements: list[dict]) -> dict:
    async with httpx.AsyncClient(timeout=90.0) as client:
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


async def _check_success(page, criteria: dict) -> bool:
    if "url_contains" in criteria:
        if criteria["url_contains"] not in page.url:
            return False
    if "text_visible" in criteria:
        content = await page.content()
        if criteria["text_visible"] not in content:
            return False
    return True


async def run_dynamic_scenario(
    scenario: dict,
    base_url: str,
    headless: bool = True,
) -> dict[str, Any]:
    from playwright.async_api import async_playwright

    log: list[dict] = []
    success = False
    error: str | None = None

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=headless)
        ctx = await browser.new_context()
        page = await ctx.new_page()
        try:
            await page.goto(scenario["start_url"], wait_until="domcontentloaded", timeout=20000)
            for step_no in range(1, scenario.get("max_steps", 5) + 1):
                elements = await _extract_elements(page)
                plan_resp = await _call_plan(
                    base_url, scenario["query"], page.url, elements
                )
                actions = plan_resp.get("actions", [])
                step_log = {
                    "step": step_no,
                    "url_before": page.url,
                    "n_elements": len(elements),
                    "explanation": plan_resp.get("explanation", ""),
                    "actions": actions,
                    "executed": [],
                }
                if not actions:
                    log.append(step_log)
                    break
                for action in actions:
                    try:
                        status = await _execute_action(page, action)
                        step_log["executed"].append(
                            {"action": action, "status": status}
                        )
                        if status == "ok" and action["type"] in ("navigate", "click", "click_text"):
                            await page.wait_for_load_state("domcontentloaded", timeout=15000)
                    except Exception as exc:
                        step_log["executed"].append(
                            {
                                "action": action,
                                "status": "error",
                                "error": f"{type(exc).__name__}: {exc}",
                            }
                        )
                        break
                log.append(step_log)
                if await _check_success(page, scenario.get("success", {})):
                    success = True
                    break
            if not success:
                success = await _check_success(page, scenario.get("success", {}))
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
        finally:
            await browser.close()

    return {
        "scenario_id": scenario["id"],
        "description": scenario.get("description", ""),
        "success": success,
        "error": error,
        "steps": log,
    }


def load_scenarios(dir_path: Path) -> list[dict]:
    out = []
    for f in sorted(dir_path.glob("*.yaml")) + sorted(dir_path.glob("*.yml")):
        out.append(yaml.safe_load(f.read_text(encoding="utf-8")))
    return out


async def run_dynamic_eval(
    dataset_dir: Path,
    base_url: str = "http://localhost:8000",
    headless: bool = True,
    scenario_filter: str | None = None,
) -> dict[str, Any]:
    scenarios = load_scenarios(dataset_dir)
    if scenario_filter:
        scenarios = [s for s in scenarios if scenario_filter in s["id"]]
    results = []
    for sc in scenarios:
        results.append(await run_dynamic_scenario(sc, base_url, headless=headless))
    return {"results": results}
