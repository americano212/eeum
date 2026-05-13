"""
실제 사이트의 DOM을 캡처해서 정적 평가 케이스의 raw snapshot으로 저장한다.

저장 위치: server/eval/datasets/captures/<id>.json
이후 expected 룰을 손으로 채워 server/eval/datasets/static/ 으로 옮기면 정식 케이스가 된다.

사용법:
  # 단건
  python -m eval.capture --url https://www.coupang.com --id coupang_main \
                         --query "노트북 검색해줘"

  # 배치 (YAML)
  python -m eval.capture --batch eval/capture-targets.yaml

YAML 형식:
  - id: gov24_main
    url: https://www.gov.kr/portal/main/nologin
    query: "주민등록등본 발급하고 싶어"
    wait_ms: 1500            # (선택) 페이지 로드 후 추가 대기
    max_elements: 80         # (선택)
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

import yaml


HERE = Path(__file__).resolve().parent
DEFAULT_OUT = HERE / "datasets" / "captures"

INTERACTIVE_SELECTOR = (
    "button, input, select, textarea, a[href], "
    "[role=button], [role=link], [role=tab], [role=menuitem], [aria-label]"
)


async def _extract(page, max_elements: int) -> list[dict]:
    return await page.evaluate(
        """({selector, maxN}) => {
            function xpathFor(el) {
                if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id)) return `//*[@id="${el.id}"]`;
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
            function visible(el) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) return false;
                const s = window.getComputedStyle(el);
                if (s.display === 'none' || s.visibility === 'hidden') return false;
                return true;
            }
            const nodes = Array.from(document.querySelectorAll(selector));
            const out = [];
            for (const el of nodes) {
                if (!visible(el)) continue;
                // role/aria-label wrapper인데 안에 실제 컨트롤 있으면 wrapper 제외 (leaf 우선)
                const role = el.getAttribute('role');
                const hasInnerControl =
                    (role || el.hasAttribute('aria-label')) &&
                    el.querySelector('button, input, select, textarea, a[href]');
                if (hasInnerControl && !['button','input','select','textarea','a'].includes(el.tagName.toLowerCase())) {
                    continue;
                }
                out.push({
                    tag: el.tagName.toLowerCase(),
                    text: (el.innerText || el.value || '').trim().replace(/\\s+/g, ' ').slice(0, 120),
                    aria_label: el.getAttribute('aria-label'),
                    role: role,
                    xpath: xpathFor(el),
                    id: el.id || null,
                    href: el.getAttribute('href'),
                    type: el.getAttribute('type'),
                    name: el.getAttribute('name'),
                    placeholder: el.getAttribute('placeholder'),
                });
                if (out.length >= maxN) break;
            }
            return out;
        }""",
        {"selector": INTERACTIVE_SELECTOR, "maxN": max_elements},
    )


async def capture_one(
    target: dict,
    out_dir: Path,
    headless: bool = True,
    user_agent: str | None = None,
) -> dict:
    from playwright.async_api import async_playwright

    case_id = target["id"]
    url = target["url"]
    query = target.get("query", "")
    wait_ms = int(target.get("wait_ms", 1200))
    max_elements = int(target.get("max_elements", 80))

    error: str | None = None
    elements: list[dict] = []
    final_url = url
    title = ""

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=headless)
        ctx = await browser.new_context(
            user_agent=user_agent
            or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
               "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            locale="ko-KR",
            viewport={"width": 1280, "height": 800},
        )
        page = await ctx.new_page()
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=25000)
            if wait_ms:
                await page.wait_for_timeout(wait_ms)
            try:
                await page.wait_for_load_state("networkidle", timeout=4000)
            except Exception:
                pass
            final_url = page.url
            title = await page.title()
            elements = await _extract(page, max_elements)
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
        finally:
            await browser.close()

    case = {
        "id": case_id,
        "_source": "capture",
        "description": f"{title} ({final_url})",
        "query": query,
        "url": final_url,
        "elements": elements,
        "expected": {
            "_pending_review": True,
            "needs_more_elements": False
        }
    }
    if error:
        case["_capture_error"] = error

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{case_id}.json"
    out_path.write_text(json.dumps(case, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "id": case_id,
        "url": final_url,
        "title": title,
        "n_elements": len(elements),
        "error": error,
        "saved": str(out_path),
    }


async def capture_batch(
    targets: list[dict],
    out_dir: Path,
    headless: bool = True,
) -> list[dict]:
    results = []
    for t in targets:
        print(f"[capture] {t['id']:<30} {t['url']}")
        r = await capture_one(t, out_dir, headless=headless)
        status = "ERROR" if r["error"] else f"{r['n_elements']:3d} elements"
        print(f"          → {status}  '{r['title'][:50]}'")
        results.append(r)
    return results


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--url")
    p.add_argument("--id")
    p.add_argument("--query", default="")
    p.add_argument("--batch", help="YAML file with target list")
    p.add_argument("--out", default=str(DEFAULT_OUT))
    p.add_argument("--headed", action="store_true")
    p.add_argument("--max-elements", type=int, default=80)
    return p.parse_args()


def main() -> None:
    args = _parse_args()
    out_dir = Path(args.out)

    if args.batch:
        targets = yaml.safe_load(Path(args.batch).read_text(encoding="utf-8"))
        if not isinstance(targets, list):
            print("batch YAML must be a list", file=sys.stderr)
            sys.exit(2)
    elif args.url and args.id:
        targets = [{
            "id": args.id,
            "url": args.url,
            "query": args.query,
            "max_elements": args.max_elements,
        }]
    else:
        print("either --batch or (--url + --id) required", file=sys.stderr)
        sys.exit(2)

    asyncio.run(capture_batch(targets, out_dir, headless=not args.headed))


if __name__ == "__main__":
    main()
