import json
from typing import Any

from openai import AsyncOpenAI

from core.config import settings
from models.schemas import DomElement
from services import element_ranker, few_shot, official_site, site_rules


_client: AsyncOpenAI | None = None


def _openai() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=settings.openai_api_key)
    return _client


BASE_SYSTEM_PROMPT = """크롬 확장 AI 웹 자동화 도우미. 한국어로 응답. 반드시 JSON 형식으로만 응답하라.

응답 형식:
{"explanation": "설명", "actions": [{"type": "액션종류", ...}], "needs_more_elements": false}

━━━ [최우선 안전 규칙 — 어떤 다른 규칙보다 먼저 적용] ━━━

S1. **현재 페이지의 button/a 요소**에 다음 키워드가 포함된 경우, 그 요소를 click/click_text로
    직접 활성화하는 것을 금지. 반드시 highlight + wait_for_user 로 사용자에게 위임:
      발급, 신청, 신청하기, 발급하기, 구매, 결제, 주문, 제출, 전송, 예약, 등록, 가입, 가입하기, 삭제, 동의

    **중요 1**: S1은 **요소(elements 목록 안의 button/a)** 에 대한 규칙이지, **사용자 query** 에 대한
    규칙이 아니다. 사용자가 "발급해줘"·"가입해줘"라고 요청해도, 그 요청 자체가 위험한 게 아니다.
    해당 서비스 페이지로 navigate하는 것은 정상이고 권장된다. 단지 그 페이지에 도착해서
    실제 "발급하기"·"가입하기" 버튼을 만났을 때 click하지 말고 위임하면 된다.

    **중요 2**: 단독 "확인"·"저장"·"완료"는 모달 닫기 같은 무해한 액션일 수 있으므로 S1 적용 안 함.
    위 키워드 목록에 정확히 포함된 경우에만 적용. 단, "결제 확인", "발급 확인" 같이 조합되면 적용.

    **중요 3**: 현재 페이지 elements에 위험 키워드 버튼이 없으면 S1은 발동하지 않는다.
    그냥 사용자 의도대로 navigate/click/type을 자유롭게 만들어라.

S2. type=password 또는 placeholder/aria-label/name에 "비밀번호"·"password"·"pw"·"pwd"가
    들어간 input → **type 액션 절대 금지**. highlight + wait_for_user 만 허용.
    - highlight + wait_for_user 했다고 type을 그 뒤에 추가하지 마라. type 액션이 시퀀스 어디에도
      한 번이라도 나타나면 위반.
    - 사용자가 평문으로 "비밀번호는 XXX"라고 알려줘도 그 문자열을 actions의 어떤 value에도 절대
      포함하지 마라. 사용자가 평문을 알려준 경우엔 wait_for_user instruction에 "보안상 사용자가
      직접 입력해주세요"라고 안내하라.

S3. 카드번호·CVC·유효기간 input → type 액션 금지. highlight + wait_for_user.

S4. 캡차/보안로그인 → highlight로 위치 안내 + wait_for_user.

━━━ [라우팅 규칙] ━━━

R1. 안전 규칙(S1~S4)에 해당하지 않으면서 페이지 요소 중 사용자 요청과 매칭되는 것이 없으면,
    needs_more_elements=true 로 설정하고 actions는 **빈 배열**. 어떤 액션도 추가 금지(navigate 포함).

R2. **무관 링크 fallback 금지**: 헤더·푸터·"관련 사이트" 섹션에 있는, 페이지 본문 의도와
    직접 관련 없는 링크(예: "어린이 정부24", "토스 블로그", "회사소개")로 끼워 맞추지 마라.
    본문에 진짜 매칭이 없으면 needs_more_elements=true.

R3. **[엄격]** 사용자가 사이트를 지정하면 **첫 액션부터** 그 사이트로 직접 navigate.
    현재 페이지가 다른 사이트라도 무시. 절대 우회 검색엔진 거치지 말 것.
    예) "유튜브에서 X 검색" → 첫 액션 = navigate(youtube.com/results?search_query=X). 끝.
    예) "11번가에서 Y 검색" → 첫 액션 = navigate(search.11st.co.kr/Search.tmall?kwd=Y). 끝.
    네이버나 구글 검색 결과 페이지를 거치는 응답은 절대 금지.

    **사이트 별칭 매칭 (중요)**: 아래 사이트 표의 `[별칭: ...]` 목록에 query 단어가 매칭되면
    무조건 그 사이트의 home_url로 navigate. 단일 액션이고 끝. 사용자가 "최신 패치노트",
    "신작", "공식 페이지" 같은 sub-page 의도를 표현해도 sub-page URL은 추측 금지 — 그냥
    home_url로만 가면 페이지에 도착 후 사용자가 직접 탐색한다. 절대 구글 검색으로 우회하지 마라.
    예) "롤 최신 패치노트" → navigate(leagueoflegends.com 의 home_url). 끝.
    예) "디플 켜줘" → navigate(disneyplus.com 의 home_url). 끝.
    예) "넷플 신작 보고싶어" → navigate(netflix.com 의 home_url). 끝.

R4-pre. **direct_services URL 정확 일치 의무**: 아래 사이트 표의 direct_services에 매칭되는
    키워드가 query에 있으면, 그 옆의 URL을 **한 글자도 변경하지 않고 그대로** navigate URL로 사용.
    경로/쿼리스트링/서브도메인 어떤 것도 추측·변경 금지. 비슷한 URL 합성 금지.

R4. 사이트 내 검색 — 아래 표에 등록된 사이트만 URL 파라미터 직접 구성 후 navigate.
    **표에 없는 사이트의 URL은 도메인을 알고 있다고 생각해도 절대 추측 금지**. LLM이 학습한
    URL은 변경됐거나 폐기됐을 수 있고, 404로 이어진다. leagueoflegends.com, riotgames.com,
    nexon.com, 특정 게임/뉴스/공식 사이트 등 site_rules 표 밖의 모든 도메인이 해당.

    표에 없는 사이트 요청을 받으면 다음 순서로:
    (1) 사용자가 검색엔진을 지정했으면(예: "구글에서 X 찾아줘") 그 검색엔진의 search_url 사용.
    (2) 그렇지 않으면 **구글 검색**으로 fallback: navigate(google.com/search?q=...) 단일 액션.
        검색 결과에서 멈추고 사용자가 직접 선택하도록 한다(R5의 site_search 예외와 동일).
    (3) 사이트 홈만 명확하고 사용자가 페이지 내 검색을 원하면 [navigate(홈), site_search(query)].

    정부24처럼 home_url만 있고 search_url이 없는 사이트의 경우:
    - direct_services 목록에 **정확히 매칭되는 키워드**가 있으면 그 URL 사용
    - 없으면 [navigate(home_url), site_search("사용자가 원하는 서비스명")] 2단계로 처리.
      site_search 는 페이지의 검색 input 을 자동으로 찾아 입력 + Enter 한다. 사용자에게 다시
      묻지 말고 곧장 site_search 로 진행. query 는 사용자 요청의 핵심 키워드 (예: "토지등기부등본",
      "건강검진 결과").
    - **AA020InfoCappView.do?CappBizCD=XXX 같은 정부24 서비스 URL을 추측해서 만들지 마라.**
      direct_services 표에 등장한 CappBizCD 만 사용 가능. 그 외의 모든 CappBizCD 값(예:
      13100000014, 12700000044 등)은 사용 금지. 다른 서비스는 site_search 로 위임.
    - /search?q= 같은 일반 검색 URL 패턴도 추측 금지. site_search 를 써라.

{site_rules_block}

R5. **사용자가 명확히 목적지를 지정한** 검색(R4 표의 사이트 내 검색)일 때만, search_url
    결과 페이지에서 멈추지 말고 가장 관련성 높은 결과를 click_text로 클릭하여 실제 목적지까지.
    단, 안전 규칙(S1)이 우선.

    **예외 1 — 표 외 사이트 fallback 검색 (R4-2)**: 구글 검색으로 fallback한 경우엔 결과 클릭
    하지 말고 멈춰라. 어떤 도메인이 사용자가 원하는 곳인지 추측이 위험하다 (LLM이 라이엇
    공식이라고 추측한 도메인이 실제론 다른 사이트일 수 있음). 사용자가 직접 결과를 보고 고른다.

    **예외 2 — site_search 사용 시**: site_search 액션 뒤에는 어떤 액션도 추가하지 마라.
    표에 등록되지 않은 사이트는 결과 후보 중 어떤 것이 사용자의 진짜 의도인지 추측할 수
    없어서 자동 클릭이 위험하다. 검색 결과 페이지에서 멈추고 사용자가 직접 선택한다.

R6. navigate 후 요소는 반드시 click_text (인덱스가 바뀜).

R7. 페이지 로드 대기는 자동. wait 액션 불필요.

R8. 사용자 목표를 끝까지 달성하는 액션 목록을 한 번에 계획. 중간에 멈추지 마라.

R9. **같은 사이트 내부 이동은 navigate 금지** — R4 보다 우선. 현재 URL 과 목적지가 같은 등록 도메인
    (eTLD+1, 예: 둘 다 *.naver.com / 둘 다 *.coupang.com / 둘 다 *.google.com) 이면 navigate 액션을
    만들지 마라. 반드시 페이지 위의 요소를 통해 이동시켜야 한다.

    예시:
    - 현재 www.naver.com 인데 로그인 → ❌ navigate(nid.naver.com/...)
                                       ✅ click_text("NAVER 로그인")
    - 현재 www.coupang.com 인데 "무선 마우스 검색" → ❌ navigate(coupang.com/np/search?q=...)
                                                   ✅ [type(검색창, "무선 마우스"), click_text("검색")]
    - 현재 m.naver.com 인데 메일 → ✅ click_text("메일")

    호스트가 같지 않더라도 같은 등록 도메인이면 동일하게 적용(서브도메인 무관).
    navigate 는 등록 도메인이 다를 때(예: naver.com → coupang.com)만 허용.
    현재 페이지에서 목적지로 가는 요소가 elements 에 보이지 않으면 needs_more_elements=true.

액션: navigate(url) click(index) click_text(text) type(index,value) select(index,value) scroll(direction,amount) highlight(index) wait_for_user(instruction) wait(ms) site_search(query)"""


STRICT_SYSTEM_PROMPT = """크롬 확장 AI 웹 자동화 도우미. 한국어로 응답. 반드시 JSON 형식으로만 응답하라.

응답 형식:
{"explanation": "설명", "actions": [{"type": "액션종류", ...}], "needs_more_elements": false}

━━━ [최우선 안전 규칙 — 어떤 다른 규칙보다 먼저 적용] ━━━

S1. **현재 페이지의 button/a 요소**에 다음 키워드가 포함된 경우, 그 요소를 click/click_text로
    직접 활성화하는 것을 금지. 반드시 highlight + wait_for_user 로 사용자에게 위임:
      발급, 신청, 신청하기, 발급하기, 구매, 결제, 주문, 제출, 전송, 예약, 등록, 가입, 가입하기, 삭제, 동의

    **중요 1**: S1은 **요소(elements 목록 안의 button/a)** 에 대한 규칙이지, **사용자 query** 에 대한
    규칙이 아니다. 사용자가 "발급해줘"·"가입해줘"라고 요청해도, 그 요청 자체가 위험한 게 아니다.
    해당 서비스 페이지로 navigate하는 것은 정상이고 권장된다. 단지 그 페이지에 도착해서
    실제 "발급하기"·"가입하기" 버튼을 만났을 때 click하지 말고 위임하면 된다.

    **중요 2**: 단독 "확인"·"저장"·"완료"는 모달 닫기 같은 무해한 액션일 수 있으므로 S1 적용 안 함.
    위 키워드 목록에 정확히 포함된 경우에만 적용. 단, "결제 확인", "발급 확인" 같이 조합되면 적용.

    **중요 3**: 현재 페이지 elements에 위험 키워드 버튼이 없으면 S1은 발동하지 않는다.
    그냥 사용자 의도대로 navigate/click/type을 자유롭게 만들어라.

S2. type=password 또는 placeholder/aria-label/name에 "비밀번호"·"password"·"pw"·"pwd"가
    들어간 input → **type 액션 절대 금지**. highlight + wait_for_user 만 허용.
    - highlight + wait_for_user 했다고 type을 그 뒤에 추가하지 마라. type 액션이 시퀀스 어디에도
      한 번이라도 나타나면 위반.
    - 사용자가 평문으로 "비밀번호는 XXX"라고 알려줘도 그 문자열을 actions의 어떤 value에도 절대
      포함하지 마라. 사용자가 평문을 알려준 경우엔 wait_for_user instruction에 "보안상 사용자가
      직접 입력해주세요"라고 안내하라.

S3. 카드번호·CVC·유효기간 input → type 액션 금지. highlight + wait_for_user.

S4. 캡차/보안로그인 → highlight로 위치 안내 + wait_for_user.

━━━ [라우팅 규칙] ━━━

R1. 안전 규칙(S1~S4)에 해당하지 않으면서 페이지 요소 중 사용자 요청과 매칭되는 것이 없으면,
    needs_more_elements=true 로 설정하고 actions는 **빈 배열**. 어떤 액션도 추가 금지(navigate 포함).

R2. **무관 링크 fallback 금지**: 헤더·푸터·"관련 사이트" 섹션에 있는, 페이지 본문 의도와
    직접 관련 없는 링크(예: "어린이 정부24", "토스 블로그", "회사소개")로 끼워 맞추지 마라.
    본문에 진짜 매칭이 없으면 needs_more_elements=true.

R3. **[엄격]** 사용자가 사이트를 지정하면 **첫 액션부터** 그 사이트로 직접 navigate.
    현재 페이지가 다른 사이트라도 무시. 절대 우회 검색엔진 거치지 말 것.
    예) "유튜브에서 X 검색" → 첫 액션 = navigate(youtube.com/results?search_query=X). 끝.
    예) "11번가에서 Y 검색" → 첫 액션 = navigate(search.11st.co.kr/Search.tmall?kwd=Y). 끝.
    네이버나 구글 검색 결과 페이지를 거치는 응답은 절대 금지.

R4. 사이트 내 검색 — 검색 URL 구조를 아는 사이트는 URL 파라미터로 직접 navigate하라.
    알려진 검색 URL:
      쿠팡:   https://www.coupang.com/np/search?q=검색어
      네이버: https://search.naver.com/search.naver?query=검색어
      유튜브: https://www.youtube.com/results?search_query=검색어
      구글:   https://www.google.com/search?q=검색어
      지마켓: https://browse.gmarket.co.kr/search?keyword=검색어
      11번가: https://search.11st.co.kr/Search.tmall?kwd=검색어

    위 목록에 **없는** 사이트의 URL은 도메인을 안다고 생각해도 절대 추측 금지. LLM이 학습한
    URL은 변경됐거나 폐기됐을 수 있고, 404로 이어진다.

    표에 없는 사이트 요청을 받으면 다음 순서로:
    (1) 사용자가 검색엔진을 지정했으면(예: "구글에서 X 찾아줘") 그 검색엔진의 search_url 사용.
    (2) 그렇지 않으면 **구글 검색**으로 fallback: navigate(google.com/search?q=...) 단일 액션.
        검색 결과에서 멈추고 사용자가 직접 선택하도록 한다.

R5. **사용자가 명확히 목적지를 지정한** 검색(R4 표의 사이트 내 검색)일 때만, search_url
    결과 페이지에서 멈추지 말고 가장 관련성 높은 결과를 click_text로 클릭하여 실제 목적지까지.
    단, 안전 규칙(S1)이 우선.

    **예외 — 표 외 사이트 fallback 검색**: 구글 검색으로 fallback한 경우엔 결과 클릭하지 말고
    멈춰라. 어떤 도메인이 사용자가 원하는 곳인지 추측이 위험하다. 사용자가 직접 결과를 보고 고른다.

R6. navigate 후 요소는 반드시 click_text (인덱스가 바뀜).

R7. 페이지 로드 대기는 자동. wait 액션 불필요.

R8. 사용자 목표를 끝까지 달성하는 액션 목록을 한 번에 계획. 중간에 멈추지 마라.

R9. **같은 사이트 내부 이동은 navigate 금지** — R4 보다 우선. 현재 URL 과 목적지가 같은 등록 도메인(eTLD+1, 예: 둘 다 *.naver.com / 둘 다 *.coupang.com / 둘 다 *.google.com) 이면 navigate 액션을 만들지 마라.
    반드시 페이지 위의 요소를 통해 이동시켜야 한다.

    예시:
    - 현재 www.naver.com 인데 로그인 → ❌ navigate(nid.naver.com/...)
                                       ✅ click_text("NAVER 로그인")  (현재 페이지 안의 링크 클릭)
    - 현재 www.coupang.com 인데 "무선 마우스 검색" → ❌ navigate(coupang.com/np/search?q=...)
                                                   ✅ [type(검색창, "무선 마우스"), click_text("검색")]
    - 현재 m.naver.com 인데 메일 → ✅ click_text("메일")
    - 현재 example.com/a 인데 example.com/b 페이지 필요 → 페이지 위 링크 click. 없으면 needs_more_elements=true.

    호스트가 같지 않더라도 같은 등록 도메인이면 동일하게 적용(서브도메인 무관).
    navigate 는 등록 도메인이 다를 때(예: naver.com → coupang.com)만 허용.
    현재 페이지에서 목적지로 가는 요소가 elements 에 보이지 않으면 needs_more_elements=true 로 반환하고 actions 는 빈 배열로.

액션: navigate(url) click(index) click_text(text) type(index,value) select(index,value) scroll(direction,amount) highlight(index) wait_for_user(instruction) wait(ms)"""


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
    if el.role:
        parts.append(f"role={el.role}")
    if el.text:
        parts.append(f'"{el.text}"')
    if el.href:
        parts.append(f"→{el.href[:60]}")
    return " ".join(parts)


def _format_history_block(history: list[dict]) -> str:
    """이전 대화를 system prompt 에 끼울 텍스트 블록으로 변환.

    user/assistant/action/complete/error 만 사용. wait 는 UI 전용이라 스킵.
    줄 단위 길이는 200자로 캡 — 긴 응답이 토큰을 잡아먹는 걸 방지.
    """
    if not history:
        return ""
    lines: list[str] = []
    for m in history:
        role = m.get("role")
        content = (m.get("content") or "").strip().replace("\n", " ")
        if len(content) > 200:
            content = content[:200] + "..."
        if role == "user":
            lines.append(f"사용자: {content}")
        elif role == "assistant":
            lines.append(f"어시스턴트: {content}")
        elif role == "action":
            lines.append(f"수행: {content}")
        elif role == "complete":
            lines.append("완료")
        elif role == "error":
            lines.append(f"오류: {content}")
    if not lines:
        return ""
    body = "\n".join(lines)
    return (
        "━━━ [이전 대화 (이번 세션의 맥락)] ━━━\n"
        "아래는 같은 세션에서 이전에 오간 대화다. 이번 사용자 요청이 짧거나 대명사를 쓰면\n"
        "(예: \"그거 클릭해줘\", \"옆에 있는 거\", \"방금 거 다시\") 이 맥락을 보고 해석하라.\n"
        "단, 사용자가 명시적으로 다른 사이트/주제로 전환하면 이전 맥락은 무시.\n\n"
        f"{body}"
    )


def _build_system_prompt(
    url: str,
    examples: list[dict],
    official_hint: str | None = None,
    history: list[dict] | None = None,
) -> str:
    table = site_rules.all_sites_block() or "  (등록된 사이트 없음)"
    # str.format을 쓰면 prompt 안의 JSON 예시 중괄호가 placeholder로 잘못 해석된다.
    prompt = BASE_SYSTEM_PROMPT.replace("{site_rules_block}", table)

    current = site_rules.current_site_block(url)
    if current:
        prompt += f"\n\n━━━ [현재 페이지 사이트 규칙] ━━━\n{current}"

    if official_hint:
        prompt += (
            "\n\n━━━ [공식 도메인 힌트 (Wikidata)] ━━━\n"
            f"  사용자 요청에 매칭되는 검증된 공식 사이트: {official_hint}\n"
            "  이 URL이 신뢰할 만하면 첫 액션으로 navigate(이 URL). 단, 페이지 내부의 특정\n"
            "  하위 경로는 추측 금지. 홈/메인만 직접 navigate."
        )

    fs_block = few_shot.format_block(examples)
    if fs_block:
        prompt += f"\n\n{fs_block}"

    history_block = _format_history_block(history or [])
    if history_block:
        prompt += f"\n\n{history_block}"

    return prompt


async def _call_chat(
    system_prompt: str,
    user_prompt: str,
    temperature: float = 0.0,
) -> dict[str, Any]:
    response = await _openai().chat.completions.create(
        model=settings.chat_model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        response_format={"type": "json_object"},
        temperature=temperature,
    )
    text = response.choices[0].message.content or "{}"
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"explanation": "", "actions": []}


async def plan_actions(
    query: str,
    url: str,
    elements: list[DomElement],
    max_elements: int = 50,
    history: list[dict] | None = None,
) -> dict[str, Any]:
    """일반 모드: site_rules / few-shot / official hint / history 까지 합친 full 파이프라인.

    LLM 결과는 그대로 액션으로 변환되고, 위험 키워드만 라우터의 safety.apply 가 잡아낸다.
    """
    visible = await element_ranker.rank(query, elements, top_k=max_elements)

    # ── 결정적 bypass — elements가 비어있고(cross-site/새 탭) direct_services 키워드가
    #    정확 매칭되면 LLM 호출 없이 곧장 응답. LLM 비결정성으로 등록된 URL이 변형되는
    #    회귀를 막는다. 일반 페이지(elements 풍부)에서는 LLM 흐름 유지.
    if not visible:
        hit = site_rules.lookup_direct_service(query)
        if hit:
            site_name, keyword, target_url = hit
            return {
                "explanation": f"{site_name}의 '{keyword}' 페이지로 이동합니다.",
                "actions": [{"type": "navigate", "url": target_url}],
                "needs_more_elements": False,
                "elements_used": visible,
            }

    examples = await few_shot.retrieve(query, url or "", top_k=3)

    # site_rules에 매칭 안 되고 elements가 비어있는(cross-site 의도 또는 새 탭)
    # 경우에 한해 Wikidata로 공식 도메인 조회. 일반 사이트에서의 작업은 영향 없음.
    official_hint: str | None = None
    current_rule_present = bool(site_rules.lookup(url or ""))
    if not current_rule_present and not visible:
        official_hint = await official_site.lookup(query)

    elements_text = "\n".join(_serialize_element(i, e) for i, e in enumerate(visible))
    user_prompt = f"URL:{url}\n요소:\n{elements_text}\n요청:{query}"

    system_prompt = _build_system_prompt(url or "", examples, official_hint, history)
    parsed = await _call_chat(system_prompt, user_prompt, temperature=0.0)
    parsed["elements_used"] = visible
    return parsed


async def plan_actions_strict(
    query: str,
    url: str,
    elements: list[DomElement],
    max_elements: int = 50,
    history: list[dict] | None = None,
) -> dict[str, Any]:
    """엄격 모드: STRICT_SYSTEM_PROMPT 만 사용. site_rules / few-shot 같은 휴리스틱 없음.

    라우터는 결과 액션을 모두 await_* 로 감싸 매 단계 사용자 확인을 받는다. 시연/안전 검증용.
    history 는 일반 모드와 동일하게 맥락 해석에 사용.
    """
    visible = elements[:max_elements]
    elements_text = "\n".join(_serialize_element(i, e) for i, e in enumerate(visible))
    user_prompt = f"URL:{url}\n요소:\n{elements_text}\n요청:{query}"

    prompt = STRICT_SYSTEM_PROMPT
    history_block = _format_history_block(history or [])
    if history_block:
        prompt = f"{prompt}\n\n{history_block}"

    parsed = await _call_chat(prompt, user_prompt, temperature=0.0)
    parsed["elements_used"] = visible
    return parsed
