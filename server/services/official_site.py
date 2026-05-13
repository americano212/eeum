"""Wikidata 기반 공식 도메인 lookup.

site_rules.yaml에 없는 사이트에 대해 LLM이 URL을 추측하지 않도록 Wikidata의
P856(official website)를 조회한다. 결과는 in-process 캐시.

흐름:
  query 전체 또는 추출된 entity 문자열
    └─ wbsearchentities (Wikidata search API) → top entity ID (Q...)
        └─ wbgetentities (claims=P856) → 공식 사이트 URL

비결정 케이스는 None 반환. 그러면 호출 측은 검색엔진 fallback으로 진행.
"""
from __future__ import annotations

import asyncio
from typing import Optional

import httpx


_SEARCH_URL = "https://www.wikidata.org/w/api.php"
_TIMEOUT = 4.0

# 같은 키 (lowercase) 반복 lookup 비용 절감
_cache: dict[str, Optional[str]] = {}
_lock = asyncio.Lock()


def _strip_intent_words(query: str) -> str:
    """query에서 'X 보고싶어', 'X 검색해줘' 같은 의도 표현을 떼서 핵심만 남긴다."""
    q = query.strip()
    suffix_patterns = [
        "보고싶어", "보고 싶어", "보고싶음", "보고싶다",
        "가고싶어", "가고 싶어", "가줘", "가자",
        "찾아줘", "찾고싶어", "검색해줘", "검색하고싶어",
        "들어가줘", "들어가고싶어",
        "최신 패치노트", "패치노트", "공식 사이트", "공식사이트",
        "공식 홈페이지", "공식홈페이지", "홈페이지",
    ]
    for s in suffix_patterns:
        if q.endswith(s):
            q = q[: -len(s)].strip()
    return q.rstrip(" 의을를이가도와과,.!?")


async def _search_entity(client: httpx.AsyncClient, term: str) -> Optional[str]:
    params = {
        "action": "wbsearchentities",
        "search": term,
        "language": "ko",
        "uselang": "ko",
        "format": "json",
        "limit": 1,
        "type": "item",
    }
    r = await client.get(_SEARCH_URL, params=params)
    r.raise_for_status()
    data = r.json()
    hits = data.get("search") or []
    if not hits:
        # 한국어로 없으면 영어로 다시
        params["language"] = "en"
        params["uselang"] = "en"
        r = await client.get(_SEARCH_URL, params=params)
        r.raise_for_status()
        hits = (r.json() or {}).get("search") or []
    return hits[0]["id"] if hits else None


async def _fetch_official_url(client: httpx.AsyncClient, entity_id: str) -> Optional[str]:
    params = {
        "action": "wbgetclaims",
        "entity": entity_id,
        "property": "P856",
        "format": "json",
    }
    r = await client.get(_SEARCH_URL, params=params)
    r.raise_for_status()
    claims = (r.json() or {}).get("claims") or {}
    p856 = claims.get("P856") or []
    for claim in p856:
        snak = claim.get("mainsnak") or {}
        datavalue = snak.get("datavalue") or {}
        if datavalue.get("type") == "string":
            url = datavalue.get("value")
            if isinstance(url, str) and url.startswith("http"):
                return url
    return None


async def lookup(query: str) -> Optional[str]:
    """query → 공식 사이트 URL. 못 찾으면 None.

    네트워크 / API 에러는 모두 swallow하고 None 반환 (fallback 흐름 깨지 않음).
    """
    key = _strip_intent_words(query).lower()
    if not key:
        return None
    if key in _cache:
        return _cache[key]

    async with _lock:
        if key in _cache:  # double-check
            return _cache[key]
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                entity_id = await _search_entity(client, key)
                if not entity_id:
                    _cache[key] = None
                    return None
                url = await _fetch_official_url(client, entity_id)
                _cache[key] = url
                return url
        except Exception:
            _cache[key] = None
            return None


def reset_cache() -> None:
    _cache.clear()
