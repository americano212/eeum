"""베이스라인 — capstone(../capstone) 의 단일 LLM 호출 모드를 서버 사이드로 포팅.

eeum 의 풀 파이프라인(intent → embedding → graph → few-shot → safety) 과 동치 비교용.
시스템 프롬프트는 capstone/api.js:buildSystemPrompt 의 한국어 원문을 그대로 사용.
RAG·그래프 탐색·few-shot 주입·결정적 safety gate 일체 없음.
"""
from __future__ import annotations

import json
from typing import Any

from openai import AsyncOpenAI

from core.config import settings
from models.schemas import DomElement
from services import metrics


_client: AsyncOpenAI | None = None


def _openai() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=settings.openai_api_key)
    return _client


BASELINE_SYSTEM_PROMPT = """크롬 확장 AI 웹 자동화 도우미. 한국어로 응답. 반드시 JSON 형식으로만 응답하라.

응답 형식:
{"explanation": "설명", "actions": [{"type": "액션종류", ...}], "needs_more_elements": false}

- 제공된 요소 목록에서 사용자 요청과 관련된 요소를 찾지 못한 경우, needs_more_elements를 true로 설정하고 actions는 빈 배열로 반환하라.

규칙:
- 사용자 목표를 끝까지 달성하는 완전한 액션 목록을 한 번에 계획하라. 중간에 멈추지 마라.
- 특정 사이트가 언급되면 그 사이트로 직접 navigate하라. 구글/네이버 같은 외부 검색엔진을 경유하지 마라.
- 사이트 내 검색이 필요할 때, 검색 URL 구조를 아는 사이트는 URL 파라미터를 직접 구성하여 navigate하라.
  알려진 검색 URL:
    쿠팡: https://www.coupang.com/np/search?q=검색어
    네이버: https://search.naver.com/search.naver?query=검색어
    유튜브: https://www.youtube.com/results?search_query=검색어
    구글: https://www.google.com/search?q=검색어
    지마켓: https://browse.gmarket.co.kr/search?keyword=검색어
    11번가: https://search.11st.co.kr/Search.tmall?kwd=검색어
- 위 목록에 없는 사이트에서 검색이 필요하면, 해당 사이트 홈으로 navigate 후 type+click_text로 검색하라.
  자주 쓰는 정부24 서비스 직접 URL (navigate로 바로 이동):
    주민등록등본: https://www.gov.kr/mw/AA020InfoCappView.do?CappBizCD=13100000015
    주민등록초본: https://www.gov.kr/mw/AA020InfoCappView.do?CappBizCD=13100000016
    가족관계증명서: https://www.gov.kr/mw/AA020InfoCappView.do?CappBizCD=13100000013
- 부득이하게 검색엔진 결과를 거쳐야 할 때는, 목적지에 맞는 도메인의 링크만 click_text로 클릭하라. 나무위키·뉴스·블로그 등 엉뚱한 사이트 링크를 누르지 마라.
- 검색 결과 페이지에서 절대 멈추지 마라. 반드시 가장 관련성 높은 결과를 click_text로 클릭하여 실제 목적지 페이지까지 이동하라.
- "출력", "신청", "발급", "찾고싶어" 등의 요청은 해당 서비스 페이지 진입까지 완료해야 한다.
- navigate 후 요소는 반드시 click_text 사용 (인덱스가 바뀜).
- 페이지 로드 대기는 자동처리되므로 wait 불필요.
- 비밀번호/결제정보는 highlight+wait_for_user 사용.
- 아래 키워드가 포함된 버튼은 절대 클릭하지 마라. 반드시 highlight 후 wait_for_user로 사용자에게 직접 클릭하도록 안내하라:
  발급, 신청, 구매, 결제, 주문, 제출, 확인, 저장, 완료, 전송, 예약, 등록
- 구매/삭제 등 되돌리기 어려운 작업 직전에 wait_for_user로 확인.
- 캡차/보안로그인은 highlight로 위치 안내.

액션: navigate(url) click(index) click_text(text) type(index,value) select(index,value) scroll(direction,amount) highlight(index) wait_for_user(instruction) wait(ms)"""


# capstone/api.js:96 의 element 직렬화를 그대로 옮김. 베이스라인 동치성 유지.
def _serialize_element(idx: int, el: DomElement) -> str:
    parts = [f"[{idx}]{el.tag}"]
    if el.type:
        parts.append(f"t={el.type}")
    if el.id:
        parts.append(f"id={el.id}")
    if el.name:
        parts.append(f"n={el.name}")
    if el.placeholder:
        parts.append(f"ph={el.placeholder}")
    if el.aria_label:
        parts.append(f"al={el.aria_label}")
    if el.text:
        parts.append(f'"{el.text}"')
    if el.href:
        parts.append(f"→{el.href[:60]}")
    return " ".join(parts)


# capstone 은 가시 요소 상위 50개를 그대로 넣음. eeum 처럼 ranking 하지 않는다.
_BASELINE_MAX_ELEMENTS = 50


async def plan(
    query: str,
    url: str,
    elements: list[DomElement],
    history: list[dict] | None = None,
) -> dict[str, Any]:
    visible = elements[:_BASELINE_MAX_ELEMENTS]
    elements_text = "\n".join(_serialize_element(i, e) for i, e in enumerate(visible))
    user_prompt = f"URL:{url}\n요소:\n{elements_text}\n요청:{query}"

    # capstone 은 최근 3턴까지 히스토리를 포함 (MAX_HISTORY_TURNS=3, role 페어).
    history_messages: list[dict] = []
    if history:
        for m in history[-6:]:
            role = m.get("role")
            content = (m.get("content") or "").strip()
            if not content:
                continue
            if role in ("user", "assistant"):
                history_messages.append({"role": role, "content": content})

    response = await _openai().chat.completions.create(
        model=settings.chat_model,
        messages=[
            {"role": "system", "content": BASELINE_SYSTEM_PROMPT},
            *history_messages,
            {"role": "user", "content": user_prompt},
        ],
        response_format={"type": "json_object"},
        temperature=0.0,
    )
    usage = getattr(response, "usage", None)
    if usage is not None:
        metrics.add_chat(
            getattr(usage, "prompt_tokens", 0) or 0,
            getattr(usage, "completion_tokens", 0) or 0,
        )

    text = response.choices[0].message.content or "{}"
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = {}

    parsed["elements_used"] = visible
    return parsed
