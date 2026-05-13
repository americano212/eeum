"""site_rules.yaml 로딩 + 도메인 lookup.

system prompt의 R4 (사이트별 search URL 표) 를 외부화. LLM에는 현재 페이지
도메인에 매칭되는 한 줄 + 전체 목록 fallback 만 주입한다.
"""
from __future__ import annotations

from pathlib import Path
from urllib.parse import urlparse

import yaml


_PATH = Path(__file__).parent / "site_rules.yaml"
_cache: dict | None = None


def _load() -> dict:
    global _cache
    if _cache is None:
        if not _PATH.exists():
            _cache = {"sites": {}}
        else:
            _cache = yaml.safe_load(_PATH.read_text(encoding="utf-8")) or {"sites": {}}
    return _cache


def _hostname(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower()
    except Exception:
        return ""


def lookup(url: str) -> dict | None:
    """현재 페이지 URL에 매칭되는 사이트 규칙 1개. suffix 매치 (www. 등 허용)."""
    host = _hostname(url)
    if not host:
        return None
    sites = _load().get("sites", {})
    for key, rule in sites.items():
        key_l = key.lower()
        if host == key_l or host.endswith("." + key_l):
            return {"domain": key, **rule}
    return None


def all_sites_block() -> str:
    """알려진 사이트 표 — system prompt 블록.

    - search_url 있으면: 일반 검색 요청에 그 URL 사용.
    - home_url 있으면: 검색 URL 없는 사이트의 진입점.
    - aliases: 사용자 query 매칭용 별칭.
    - direct_services: 키워드 매칭 시 그 URL 직접 navigate.
    """
    sites = _load().get("sites", {})
    if not sites:
        return ""
    lines: list[str] = []
    for _, rule in sites.items():
        name = rule.get("name", "")
        if not name:
            continue
        aliases = rule.get("aliases") or []
        alias_str = ""
        if aliases:
            alias_str = f"  [별칭: {', '.join(aliases)}]"
        search = rule.get("search_url", "")
        home = rule.get("home_url", "")
        if search:
            lines.append(f"  {name} 검색: {search}{alias_str}")
        elif home:
            lines.append(
                f"  {name} 홈: {home}{alias_str}  (검색 URL 등록 안 됨 — direct_services 매칭 키워드 있으면 "
                "그 URL, 없으면 [navigate(홈), site_search(query)]. URL 추측 금지)"
            )
        direct = rule.get("direct_services") or {}
        for keyword, direct_url in direct.items():
            lines.append(f"  {name} - \"{keyword}\" 요청 시 → navigate({direct_url})")
    return "\n".join(lines)


def lookup_direct_service(query: str) -> tuple[str, str, str] | None:
    """query에 direct_services 키워드가 substring으로 정확 매칭되면 (사이트명, 키워드, URL).

    가장 긴 키워드 우선 매칭 (예: "부동산 등기부등본"이 "등기부등본"보다 우선).
    """
    if not query:
        return None
    sites = _load().get("sites", {})
    best: tuple[str, str, str] | None = None
    best_len = 0
    for _, rule in sites.items():
        name = rule.get("name", "")
        direct = rule.get("direct_services") or {}
        for keyword, url in direct.items():
            if keyword and keyword in query and len(keyword) > best_len:
                best = (name, keyword, url)
                best_len = len(keyword)
    return best


def current_site_block(url: str) -> str:
    """현재 도메인 한 줄만 — 가장 관련성 높은 규칙이라 LLM 주의가 쏠리게."""
    rule = lookup(url)
    if not rule:
        return ""
    name = rule.get("name", rule["domain"])
    search = rule.get("search_url")
    home = rule.get("home_url")
    if search:
        return f"현재 사이트: {name}. 사이트 내 검색은 다음 URL로 직접 navigate: {search}"
    if home:
        return (
            f"현재 사이트: {name}. 검색 URL 등록 안 됨 — direct_services에 매칭되는 키워드가 "
            f"있으면 그 URL 사용. 없으면 site_search(query)로 페이지 내 검색창에 입력. "
            f"홈: {home}"
        )
    return f"현재 사이트: {name}."
