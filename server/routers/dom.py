from fastapi import APIRouter

from models.schemas import (
    DomCheckRequest,
    DomCheckResponse,
    DomUploadRequest,
    DomUploadResponse,
)
from services import embedding, graph, session, vector_store


router = APIRouter(prefix="/dom", tags=["dom"])


@router.post("/check", response_model=DomCheckResponse)
async def check(req: DomCheckRequest) -> DomCheckResponse:
    session_id, expires_at = await session.touch_or_create(req.session_id)
    hit = await graph.state_exists(req.state_id)
    return DomCheckResponse(
        session_id=session_id,
        expires_at=expires_at,
        cache_miss=not hit,
    )


@router.post("/upload", response_model=DomUploadResponse)
async def upload(req: DomUploadRequest) -> DomUploadResponse:
    session_id, expires_at = await session.touch_or_create(req.session_id)

    texts = [
        embedding.element_text(e.tag, e.xpath, e.aria_label, e.text)
        for e in req.elements
    ]
    vectors = await embedding.embed(texts)
    pairs = [(e.model_dump(), v) for e, v in zip(req.elements, vectors)]
    stored = await vector_store.upsert_elements(
        state_id=req.state_id,
        url=req.url,
        dom_hash=req.dom_hash,
        elements_with_vectors=pairs,
    )

    await graph.upsert_state(req.state_id, req.url, req.dom_hash)
    if req.referrer_state_id:
        trigger_text = None
        if req.trigger_xpath:
            for e in req.elements:
                if e.xpath == req.trigger_xpath:
                    trigger_text = e.text
                    break
        await graph.add_edge(
            from_state_id=req.referrer_state_id,
            to_state_id=req.state_id,
            trigger_xpath=req.trigger_xpath,
            trigger_text=trigger_text,
        )

    return DomUploadResponse(
        session_id=session_id,
        expires_at=expires_at,
        stored=stored,
    )
