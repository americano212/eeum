import time

from fastapi import APIRouter

from models.schemas import JudgeRequest, JudgeResponse, TokenUsage
from services import judge as judge_service, metrics


router = APIRouter(tags=["judge"])


@router.post("/judge", response_model=JudgeResponse)
async def judge(req: JudgeRequest) -> JudgeResponse:
    metrics.start()
    t0 = time.perf_counter()

    result = await judge_service.judge(
        query=req.query,
        ground_truth=req.ground_truth.model_dump(),
        system_response=req.system_response,
        post_dom_summary=req.post_dom_summary,
    )

    processing_ms = int((time.perf_counter() - t0) * 1000)
    return JudgeResponse(
        target_hit=result["target_hit"],
        outcome_match=result["outcome_match"],
        safety_correct=result["safety_correct"],
        composite=result["composite"],
        reasoning=result["reasoning"],
        processing_ms=processing_ms,
        judge_tokens=TokenUsage(**metrics.snapshot()),
    )
