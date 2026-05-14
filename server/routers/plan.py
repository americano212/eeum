from fastapi import APIRouter

from models.schemas import (
    ClickAction,
    ClickTextAction,
    DomElement,
    HighlightAction,
    NavigateAction,
    NavigationStep,
    PlanRequest,
    PlanResponse,
    ScrollAction,
    SelectAction,
    SiteSearchAction,
    TypeAction,
    WaitAction,
    WaitForUserAction,
)
from services import llm, safety, session


router = APIRouter(tags=["plan"])


def _action_from_llm(a: dict, elements: list[DomElement]):
    action_type = a.get("type")

    if action_type == "navigate":
        url = a.get("url")
        if not url:
            return None
        return NavigateAction(url=url)
    if action_type == "click_text":
        text = a.get("text")
        if not text:
            return None
        return ClickTextAction(text=text)
    if action_type == "scroll":
        return ScrollAction(
            direction=a.get("direction", "down"),
            amount=int(a.get("amount", 300)),
        )
    if action_type == "wait":
        return WaitAction(ms=int(a.get("ms", 500)))
    if action_type == "wait_for_user":
        return WaitForUserAction(instruction=a.get("instruction", ""))
    if action_type == "site_search":
        q = a.get("query")
        if not q:
            return None
        return SiteSearchAction(query=q)

    # index 기반 액션 — index → xpath 변환
    idx = a.get("index")
    if not isinstance(idx, int) or not (0 <= idx < len(elements)):
        return None
    xpath = elements[idx].xpath

    if action_type == "click":
        return ClickAction(xpath=xpath)
    if action_type == "type":
        return TypeAction(xpath=xpath, value=a.get("value", ""))
    if action_type == "select":
        return SelectAction(xpath=xpath, value=a.get("value", ""))
    if action_type == "highlight":
        return HighlightAction(xpath=xpath)

    return None


@router.post("/plan", response_model=PlanResponse)
async def plan(req: PlanRequest) -> PlanResponse:
    session_id, expires_at = await session.touch_or_create(req.session_id)

    elements = req.current_elements or []
    raw_plan = await llm.plan_actions(
        query=req.query,
        url=req.current_url or "",
        elements=elements,
    )

    # plan_actions 가 실제 LLM 에 보낸(=ranked top-K) elements. index 는 이 리스트 기준.
    elements_used: list[DomElement] = raw_plan.get("elements_used") or elements

    actions: list[NavigationStep] = []
    for a in raw_plan.get("actions") or []:
        converted = _action_from_llm(a, elements_used)
        if converted is not None:
            actions.append(converted)

    # 결정적 안전 게이트 — LLM 이 S1~S4 를 어겼더라도 여기서 강제 교정.
    actions = safety.apply(actions, elements_used)

    return PlanResponse(
        session_id=session_id,
        expires_at=expires_at,
        explanation=raw_plan.get("explanation") or "",
        actions=actions,
        needs_more_elements=bool(raw_plan.get("needs_more_elements")),
    )
