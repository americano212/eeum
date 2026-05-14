from fastapi import APIRouter

from models.schemas import (
    AwaitClickAction,
    AwaitClickTextAction,
    AwaitSelectAction,
    AwaitTypeAction,
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
from services import conversations, llm, safety, session


# 대화 맥락에 포함할 최대 메시지 수 — 토큰 비용 vs 컨텍스트 풍부도의 트레이드오프.
HISTORY_LIMIT = 20


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


async def _run_plan(req: PlanRequest, plan_fn) -> PlanResponse:
    session_id, expires_at = await session.touch_or_create(req.session_id)

    # 익스텐션은 /plan 직전에 user 메시지를 /conversations/log 로 push 하므로
    # 가장 최근 user 행이 곧 현재 query와 동일하다 → 중복 방지를 위해 끝에서 제거.
    history = await conversations.get_recent_messages(session_id, HISTORY_LIMIT)
    if history and history[-1]["role"] == "user" and history[-1]["content"] == req.query:
        history = history[:-1]

    elements = req.current_elements or []
    raw_plan = await plan_fn(
        query=req.query,
        url=req.current_url or "",
        elements=elements,
        history=history,
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


def _defer_action(action):
    # 자동 클릭/입력을 막고 매 단계를 사용자 위임 형태로 변환.
    # navigate/scroll/wait/highlight 는 그대로 자동 실행.
    if isinstance(action, ClickAction):
        return AwaitClickAction(xpath=action.xpath)
    if isinstance(action, ClickTextAction):
        return AwaitClickTextAction(text=action.text)
    if isinstance(action, TypeAction):
        return AwaitTypeAction(xpath=action.xpath, value=action.value)
    if isinstance(action, SelectAction):
        return AwaitSelectAction(xpath=action.xpath, value=action.value)
    return action


@router.post("/plan", response_model=PlanResponse)
async def plan(req: PlanRequest) -> PlanResponse:
    # 자동 실행 + 안전 게이트 모드. 일반 click/type 은 즉시 실행, S1~S4 위반만 safety.apply 가 강제 교정.
    return await _run_plan(req, llm.plan_actions)


@router.post("/plan/strict", response_model=PlanResponse)
async def plan_strict(req: PlanRequest) -> PlanResponse:
    # 모든 click/click_text/type/select 를 사용자 위임 (await_*) 으로 감싸는 안전 모드.
    resp = await _run_plan(req, llm.plan_actions_strict)
    resp.actions = [_defer_action(a) for a in resp.actions]
    return resp
