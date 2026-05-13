"""주요 사이트의 검색 URL을 자동 발견해서 site_rules.yaml.draft 로 출력.

파이프라인 (도메인당):
  1. OpenSearch 발견: https://{domain}/ HTML에서
        <link rel="search" type="application/opensearchdescription+xml" href=...>
     찾아서 OSD XML을 받고 <Url type="text/html" template="...{searchTerms}..."> 추출.
  2. Form 스크레이핑 fallback: <form> 중 role=search, type=search input, 또는
     알려진 query 파라미터 이름(q/query/keyword/kwd/search_query)을 가진 폼으로 URL 합성.
  3. 검증: 합성된 URL에 probe 쿼리("테스트")를 넣어 HTTP GET. 200이면서 응답 본문에
     probe 가 (decoded 또는 encoded) 등장해야 통과.

추측 금지: 검증 실패한 entry는 draft에 쓰지 않고 실패 목록으로만 보고. site_rules.yaml은
이 도구가 절대 직접 수정하지 않는다. 사람이 draft를 확인 후 머지.

사용:
  cd server
  python -m tools.build_site_rules
  python -m tools.build_site_rules --include-known   # 이미 등록된 도메인도 재검증
  python -m tools.build_site_rules --domain coupang.com   # 한 도메인만
"""
from __future__ import annotations

import argparse
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote, urljoin, urlparse
from xml.etree import ElementTree as ET

import httpx
import yaml


UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)
HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.5",
}
PROBE_QUERY = "eeumprobe2k4xyz"   # 자연 발생 확률이 사실상 0인 unique 토큰
DECOY_QUERY = "eeumdecoy9zq7abc"  # 차분(diff) 검증용 두 번째 probe
HTTP_TIMEOUT = 15.0
MAX_WORKERS = 6

# 알려진 검색 input name. form 스코어링 + 추출에 사용.
KNOWN_QUERY_NAMES = (
    "q", "query", "keyword", "kwd", "search_query", "searchTerms",
    "wd", "word", "search", "searchKeyword", "keywords",
)


# ────────────────────────────────────────────────────────────────────
# HTML 파싱
# ────────────────────────────────────────────────────────────────────

class _PageExtractor(HTMLParser):
    """opensearch <link> + <form>+<input> 만 추출."""
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.opensearch_href: str | None = None
        self.title: str | None = None
        self._in_title = False
        self.forms: list[dict] = []
        self._current_form: dict | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        d = {k: (v or "") for k, v in attrs}
        if tag == "link":
            rel = d.get("rel", "").lower()
            typ = d.get("type", "").lower()
            if "search" in rel and "opensearchdescription" in typ and d.get("href"):
                self.opensearch_href = d["href"]
        elif tag == "title":
            self._in_title = True
        elif tag == "form":
            self._current_form = {
                "action": d.get("action", ""),
                "method": (d.get("method", "GET") or "GET").upper(),
                "role": d.get("role", "").lower(),
                "inputs": [],
            }
        elif tag == "input" and self._current_form is not None:
            self._current_form["inputs"].append({
                "type": (d.get("type", "text") or "text").lower(),
                "name": d.get("name", ""),
            })

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        elif tag == "form" and self._current_form is not None:
            self.forms.append(self._current_form)
            self._current_form = None

    def handle_data(self, data: str) -> None:
        if self._in_title and self.title is None:
            t = data.strip()
            if t:
                self.title = t


def _parse_html(text: str) -> _PageExtractor:
    p = _PageExtractor()
    try:
        p.feed(text)
    except Exception:
        # 누구의 HTML은 깨져있을 수 있음 — 그때까지 파싱된 만큼만 쓴다.
        pass
    return p


# ────────────────────────────────────────────────────────────────────
# 발견 단계
# ────────────────────────────────────────────────────────────────────

@dataclass
class Discovery:
    name: str
    search_url: str
    source: str  # "opensearch" | "form"


def _get(client: httpx.Client, url: str) -> httpx.Response | None:
    try:
        r = client.get(url, headers=HEADERS, follow_redirects=True, timeout=HTTP_TIMEOUT)
    except (httpx.HTTPError, OSError):
        return None
    return r


def _opensearch_template_to_query(template: str) -> str | None:
    """OpenSearch URL template을 우리 포맷({query})으로 변환.

    - {searchTerms} → {query}
    - {language?}·{inputEncoding?} 같은 optional placeholder 는 제거 (값 없이 OK)
    - 그 외 placeholder가 남아있으면 None 반환 (필수 변수를 못 채움)
    """
    if "{searchTerms}" not in template:
        return None
    url = template.replace("{searchTerms}", "{query}")
    url = re.sub(r"\{[^}]*\?\}", "", url)
    url = re.sub(r"&[a-zA-Z]+=(?=&|$)", "", url)  # 빈 쿼리 파라미터 정리
    if re.search(r"\{[^}]+\}", url.replace("{query}", "")):
        return None
    return url


def discover_opensearch(client: httpx.Client, base: str) -> Discovery | None:
    r = _get(client, base)
    if r is None or r.status_code >= 400 or not r.text:
        return None
    page = _parse_html(r.text)
    if not page.opensearch_href:
        return None
    osd_url = urljoin(str(r.url), page.opensearch_href)
    r2 = _get(client, osd_url)
    if r2 is None or r2.status_code >= 400 or not r2.text:
        return None
    try:
        root = ET.fromstring(r2.text.encode("utf-8"))
    except ET.ParseError:
        return None

    ns = "{http://a9.com/-/spec/opensearch/1.1/}"
    short_name = ""
    sn_el = root.find(f"{ns}ShortName")
    if sn_el is not None and sn_el.text:
        short_name = sn_el.text.strip()

    for url_el in root.findall(f"{ns}Url"):
        if url_el.get("type") != "text/html":
            continue
        template = url_el.get("template") or ""
        converted = _opensearch_template_to_query(template)
        if converted:
            return Discovery(
                name=short_name or page.title or urlparse(base).hostname or "",
                search_url=converted,
                source="opensearch",
            )
    return None


def discover_form(client: httpx.Client, base: str) -> Discovery | None:
    r = _get(client, base)
    if r is None or r.status_code >= 400 or not r.text:
        return None
    page = _parse_html(r.text)

    SEARCH_PATH_KW = ("search", "result", "find", "query", "lookup", "browse")
    scored: list[tuple[int, dict, str]] = []  # (score, form, picked_name)
    for f in page.forms:
        if f["method"] not in ("GET", ""):
            continue
        # hard filter: 폼이 검색을 위한 것이라는 표식이 있어야 함.
        action_url = urljoin(str(r.url), f["action"] or "")
        path_lower = (urlparse(action_url).path or "").lower()
        is_search_form = (
            f["role"] == "search"
            or any(kw in path_lower for kw in SEARCH_PATH_KW)
        )
        if not is_search_form:
            continue

        score = 0
        if f["role"] == "search":
            score += 10
        if "search" in path_lower:
            score += 6
        picked = ""
        for inp in f["inputs"]:
            if inp["type"] == "search":
                score += 5
            if inp["name"] and inp["name"] in KNOWN_QUERY_NAMES:
                score += 4
                if not picked:
                    picked = inp["name"]
        if not picked:
            for inp in f["inputs"]:
                if inp["type"] in ("search", "text") and inp["name"]:
                    picked = inp["name"]
                    score += 1
                    break
        if score > 0 and picked:
            scored.append((score, f, picked))

    if not scored:
        return None
    scored.sort(key=lambda t: -t[0])
    _, form, query_name = scored[0]

    action = form["action"] or str(r.url)
    action_url = urljoin(str(r.url), action)
    sep = "&" if "?" in action_url else "?"
    search_url = f"{action_url}{sep}{query_name}={{query}}"

    name = page.title or urlparse(base).hostname or ""
    return Discovery(name=name, search_url=search_url, source="form")


# ────────────────────────────────────────────────────────────────────
# 검증
# ────────────────────────────────────────────────────────────────────

def _probe_in(body: str, probe: str) -> bool:
    enc = quote(probe)
    return probe in body or enc in body or enc.lower() in body.lower()


def verify(client: httpx.Client, search_url: str) -> bool:
    """엄격 검증:
       1) probe 쿼리로 200 응답 + 응답 본문에 probe 가 등장 (검색어가 reflected)
       2) decoy 쿼리로도 200 응답 + decoy 가 등장 + probe 응답과 본문이 달라야 함
       조건 2 가 없으면 melon.com?q=X 처럼 query 를 무시하고 항상 같은 페이지를
       돌려주는 URL이 통과해버린다.
    """
    probe_url = search_url.replace("{query}", quote(PROBE_QUERY))
    decoy_url = search_url.replace("{query}", quote(DECOY_QUERY))

    r1 = _get(client, probe_url)
    if r1 is None or r1.status_code >= 400 or not r1.text:
        return False
    # 최종 redirect 경로가 비어있거나 "/" 면 검색이 아니라 홈으로 떨어진 것 — 가짜 양성.
    final_path = urlparse(str(r1.url)).path
    if not final_path or final_path == "/":
        return False
    if not _probe_in(r1.text, PROBE_QUERY):
        return False

    r2 = _get(client, decoy_url)
    if r2 is None or r2.status_code >= 400 or not r2.text:
        return False
    if not _probe_in(r2.text, DECOY_QUERY):
        return False

    # query 가 무시되면 두 응답이 거의 동일 — 본문이 정확히 같으면 fail.
    if r1.text == r2.text:
        return False
    # decoy 응답에 probe가 들어있으면 (역도, 의심) fail
    if _probe_in(r2.text, PROBE_QUERY):
        return False
    return True


# ────────────────────────────────────────────────────────────────────
# 도메인별 파이프라인
# ────────────────────────────────────────────────────────────────────

@dataclass
class Result:
    domain: str
    ok: bool
    discovery: Discovery | None = None
    reason: str = ""


def discover_domain(domain: str) -> Result:
    bases: list[str] = []
    if "." in domain and not domain.startswith("www."):
        bases.append(f"https://www.{domain}")
    bases.append(f"https://{domain}")

    last_reason = "no-discovery"
    with httpx.Client(timeout=HTTP_TIMEOUT, http2=False) as client:
        for base in bases:
            for fn, label in ((discover_opensearch, "opensearch"), (discover_form, "form")):
                try:
                    d = fn(client, base)
                except Exception as exc:
                    last_reason = f"{label}-error: {type(exc).__name__}"
                    continue
                if d is None:
                    last_reason = f"{label}-not-found"
                    continue
                try:
                    if verify(client, d.search_url):
                        return Result(domain=domain, ok=True, discovery=d)
                    last_reason = f"{label}-verify-failed: {d.search_url}"
                except Exception as exc:
                    last_reason = f"{label}-verify-error: {type(exc).__name__}"
    return Result(domain=domain, ok=False, reason=last_reason)


# ────────────────────────────────────────────────────────────────────
# CLI
# ────────────────────────────────────────────────────────────────────

def _load_existing(path: Path) -> dict:
    if not path.exists():
        return {}
    doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return doc.get("sites", {}) or {}


def _load_seed(path: Path) -> list[str]:
    out: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        out.append(line)
    return out


def main() -> int:
    here = Path(__file__).resolve().parent
    services_dir = here.parent / "services"

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seed", default=str(here / "seed_domains.txt"))
    ap.add_argument("--existing", default=str(services_dir / "site_rules.yaml"))
    ap.add_argument("--out", default=str(services_dir / "site_rules.yaml.draft"))
    ap.add_argument("--include-known", action="store_true",
                    help="이미 site_rules.yaml에 있는 도메인도 다시 발견")
    ap.add_argument("--domain", action="append", default=[],
                    help="시드 파일 대신 이 도메인만 처리 (반복 가능)")
    ap.add_argument("--workers", type=int, default=MAX_WORKERS)
    args = ap.parse_args()

    existing = _load_existing(Path(args.existing))
    if args.domain:
        domains = args.domain
    else:
        domains = _load_seed(Path(args.seed))

    targets: list[str] = []
    skipped: list[str] = []
    for d in domains:
        if not args.include_known and d in existing:
            skipped.append(d)
        else:
            targets.append(d)

    print(f"  targets: {len(targets)}   skipped(known): {len(skipped)}")
    if skipped:
        print(f"  [skipped] {', '.join(skipped)}")

    results: list[Result] = []
    started = time.time()
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = {pool.submit(discover_domain, d): d for d in targets}
        for fut in as_completed(futures):
            r = fut.result()
            results.append(r)
            if r.ok and r.discovery:
                print(f"  OK   {r.domain:<22} [{r.discovery.source:9}] {r.discovery.search_url}")
            else:
                print(f"  FAIL {r.domain:<22} {r.reason}")

    elapsed = time.time() - started
    discovered = {r.domain: r for r in results if r.ok and r.discovery}
    failed = [r for r in results if not r.ok]

    if discovered:
        out_sites: dict[str, dict] = {}
        for domain, r in sorted(discovered.items()):
            d = r.discovery
            assert d is not None
            out_sites[domain] = {"name": d.name or domain, "search_url": d.search_url}
        out_doc = {"sites": out_sites}
        out_path = Path(args.out)
        header = (
            "# AUTO-GENERATED by tools/build_site_rules.py — DO NOT EDIT BY HAND.\n"
            "# 검증 통과한 entry 만 들어있음. 머지하려면 site_rules.yaml로 옮기고\n"
            "# (필요시 direct_services 등 보강) 이 파일은 지워도 됨.\n"
        )
        body = yaml.safe_dump(out_doc, allow_unicode=True, sort_keys=False)
        out_path.write_text(header + body, encoding="utf-8")
        print(f"\n[draft]  {out_path}  ({len(out_sites)} entries)")
    else:
        print("\n[draft]  (no verified entries — nothing written)")

    if failed:
        print(f"[failed] {len(failed)}: " + ", ".join(r.domain for r in failed[:20]))
    print(f"[elapsed] {elapsed:.1f}s")
    return 0 if discovered else 1


if __name__ == "__main__":
    sys.exit(main())
