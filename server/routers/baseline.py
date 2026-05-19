"""베이스라인 라우터 — 단일 LLM 호출 (capstone 동치) 모드.

eeum 풀 파이프라인과 비교하기 위한 평가 대상. safety.apply / history 통합 / few-shot /
intent 추출 / 그래프 전부 없음.
"""
import time

from fastapi import APIRouter

from models.schemas import (
    BaselineRequest,
    BaselineResponse,
    DomElement,
    NavigationStep,
    TokenUsage,
)
from routers.plan import _action_from_llm
from services import baseline as baseline_service, metrics


router = APIRouter(tags=["baseline"])


@router.post("/baseline", response_model=BaselineResponse)
async def baseline(req: BaselineRequest) -> BaselineResponse:
    metrics.start()
    t0 = time.perf_counter()

    raw = await baseline_service.plan(
        query=req.query,
        url=req.url or "",
        elements=req.elements,
        history=req.history,
    )

    elements_used: list[DomElement] = raw.get("elements_used") or req.elements
    actions: list[NavigationStep] = []
    for a in raw.get("actions") or []:
        converted = _action_from_llm(a, elements_used)
        if converted is not None:
            actions.append(converted)

    processing_ms = int((time.perf_counter() - t0) * 1000)
    return BaselineResponse(
        explanation=raw.get("explanation") or "",
        actions=actions,
        processing_ms=processing_ms,
        tokens=TokenUsage(**metrics.snapshot()),
    )
