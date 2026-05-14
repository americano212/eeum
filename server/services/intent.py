import json
from typing import Any

from openai import AsyncOpenAI

from core.config import settings


_client: AsyncOpenAI | None = None


def _openai() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=settings.openai_api_key)
    return _client


INTENT_PROMPT = """사용자의 한국어 자연어 요청에서 페이지 안에서 찾을 핵심 키워드와 사이트 힌트만 뽑아라.
반드시 JSON 형식으로 응답.

응답 스키마:
{"keyword": "...", "site_hint": "..." | null}

규칙:
- keyword: 페이지 요소(버튼/링크/입력란 등)와 매칭될 가장 짧은 핵심 문구. "찾아줘"·"보여줘"·"하고싶어"·"으로 가" 같은 군더더기 제거.
- site_hint: 사용자가 특정 사이트를 지정했으면 그 호스트(예: "naver.com", "coupang.com"). 일반 표현이면 null.

예시:
"네이버 로그인 버튼 찾아줘" → {"keyword": "로그인", "site_hint": "naver.com"}
"결제 플랜 변경하고 싶어" → {"keyword": "플랜 변경", "site_hint": null}
"쿠팡에서 무선 마우스 검색해줘" → {"keyword": "무선 마우스", "site_hint": "coupang.com"}
"내 알림 설정 켜고 싶어" → {"keyword": "알림 설정", "site_hint": null}
"""


async def extract(query: str) -> dict[str, Any]:
    response = await _openai().chat.completions.create(
        model=settings.chat_model,
        messages=[
            {"role": "system", "content": INTENT_PROMPT},
            {"role": "user", "content": query},
        ],
        response_format={"type": "json_object"},
        temperature=0.0,
    )
    text = response.choices[0].message.content or "{}"
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return {"keyword": query, "site_hint": None}
    keyword = data.get("keyword")
    if not isinstance(keyword, str) or not keyword.strip():
        keyword = query
    site_hint = data.get("site_hint")
    if not isinstance(site_hint, str) or not site_hint.strip():
        site_hint = None
    return {"keyword": keyword.strip(), "site_hint": site_hint}
