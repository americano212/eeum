"""LLM 응답을 신뢰하지 않는 결정적 안전 게이트.

system prompt(S1~S4)에 의존하지 않고, 클릭/입력 대상 요소를 검사해서
위험 요소면 click/type을 highlight + wait_for_user로 강제 변환한다.
"""
from __future__ import annotations

from models.schemas import (
    ClickAction,
    ClickTextAction,
    DomElement,
    HighlightAction,
    NavigationStep,
    TypeAction,
    WaitForUserAction,
)


DANGER_KEYWORDS: tuple[str, ...] = (
    "발급", "신청", "신청하기", "발급하기",
    "구매", "결제", "주문", "제출", "전송",
    "예약", "등록", "가입", "가입하기",
    "삭제", "동의",
)

# 단독으로는 무해해서 차단 대상이 아니지만, 위험 키워드와 결합되면 차단
COMBO_KEYWORDS: tuple[str, ...] = ("결제 확인", "발급 확인", "주문 확인", "결제확인", "발급확인")

PASSWORD_INDICATORS: tuple[str, ...] = ("비밀번호", "password", "pw", "pwd", "passwd")

CARD_INDICATORS: tuple[str, ...] = (
    "카드번호", "card-number", "cardnumber", "card number",
    "cvc", "cvv", "유효기간", "expiry", "expiration",
)


def _haystacks(el: DomElement) -> list[str]:
    return [
        (el.text or ""),
        (el.aria_label or ""),
        (el.placeholder or ""),
        (el.name or ""),
        (el.id or ""),
    ]


def _matches_danger(text: str) -> bool:
    if not text:
        return False
    if any(c in text for c in COMBO_KEYWORDS):
        return True
    return any(k in text for k in DANGER_KEYWORDS)


def is_dangerous_target(el: DomElement) -> bool:
    if el.tag.lower() not in ("button", "a", "input"):
        # span/div 같은 비표준 버튼도 위험 키워드면 차단
        pass
    return any(_matches_danger(h) for h in _haystacks(el))


def is_password_input(el: DomElement) -> bool:
    if (el.type or "").lower() == "password":
        return True
    lowered = [h.lower() for h in _haystacks(el)]
    return any(any(k in h for k in PASSWORD_INDICATORS) for h in lowered)


def is_card_input(el: DomElement) -> bool:
    lowered = [h.lower() for h in _haystacks(el)]
    return any(any(k in h for k in CARD_INDICATORS) for h in lowered)


def apply(
    actions: list[NavigationStep],
    elements: list[DomElement],
) -> list[NavigationStep]:
    by_xpath: dict[str, DomElement] = {e.xpath: e for e in elements}
    out: list[NavigationStep] = []

    for a in actions:
        if isinstance(a, ClickAction):
            el = by_xpath.get(a.xpath)
            if el and is_dangerous_target(el):
                label = el.text or el.aria_label or "이 버튼"
                out.append(HighlightAction(xpath=a.xpath))
                out.append(WaitForUserAction(
                    instruction=f"'{label}' 클릭은 사용자가 직접 확인 후 진행해주세요."
                ))
                continue

        elif isinstance(a, ClickTextAction):
            if _matches_danger(a.text):
                out.append(WaitForUserAction(
                    instruction=f"'{a.text}' 버튼은 직접 확인 후 클릭해주세요."
                ))
                continue

        elif isinstance(a, TypeAction):
            el = by_xpath.get(a.xpath)
            if el and (is_password_input(el) or is_card_input(el)):
                kind = "비밀번호" if is_password_input(el) else "카드정보"
                out.append(HighlightAction(xpath=a.xpath))
                out.append(WaitForUserAction(
                    instruction=f"{kind}는 사용자가 직접 입력해주세요."
                ))
                continue

        out.append(a)

    return out
