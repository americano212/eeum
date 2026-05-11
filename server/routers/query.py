from fastapi import APIRouter, HTTPException

from models.schemas import (
    ClickAction,
    ClickTextAction,
    NavigateAction,
    QueryRequest,
    QueryResponse,
    TargetElement,
)
from services import embedding, graph, session, vector_store


router = APIRouter(tags=["query"])


@router.post("/query", response_model=QueryResponse)
async def query(req: QueryRequest) -> QueryResponse:
    session_id, expires_at = await session.touch_or_create(req.session_id)

    # 현재 DOM이 함께 왔고 아직 인덱싱되지 않았다면 즉시 업서트 (인덱스 비어있어도 동작 보장)
    if (
        req.current_elements
        and req.current_url is not None
        and req.current_dom_hash is not None
        and not await session.state_cached(req.current_state_id)
    ):
        element_texts = [
            embedding.element_text(e.tag, e.xpath, e.aria_label, e.text)
            for e in req.current_elements
        ]
        element_vectors = await embedding.embed(element_texts)
        pairs = [
            (e.model_dump(), v)
            for e, v in zip(req.current_elements, element_vectors)
        ]
        await vector_store.upsert_elements(
            state_id=req.current_state_id,
            url=req.current_url,
            dom_hash=req.current_dom_hash,
            elements_with_vectors=pairs,
        )
        await graph.upsert_state(
            req.current_state_id, req.current_url, req.current_dom_hash
        )
        await session.mark_state_cached(req.current_state_id)

    query_vector = await embedding.embed_one(req.query)
    hits = await vector_store.search(query_vector, top_k=10)
    if not hits:
        raise HTTPException(status_code=404, detail="No matching element found")

    # 현재 페이지 안에 적합한 후보가 있으면 그쪽을 우선 — 불필요한 페이지 이동 방지
    current_hits = [h for h in hits if h["state_id"] == req.current_state_id]
    top = current_hits[0] if current_hits else hits[0]
    target = TargetElement(
        state_id=top["state_id"],
        url=top["url"],
        xpath=top["xpath"],
        tag=top["tag"],
        text=top.get("text", "") or "",
    )

    navigation_path: list = []
    if top["state_id"] != req.current_state_id:
        hops = await graph.shortest_path(req.current_state_id, top["state_id"])
        if hops:
            for hop in hops:
                if hop["from_url"] != hop["to_url"]:
                    navigation_path.append(NavigateAction(url=hop["to_url"]))
                    if hop.get("trigger_text"):
                        navigation_path.append(
                            ClickTextAction(text=hop["trigger_text"])
                        )
                elif hop["trigger_xpath"]:
                    navigation_path.append(ClickAction(xpath=hop["trigger_xpath"]))
        else:
            navigation_path.append(NavigateAction(url=top["url"]))

    return QueryResponse(
        session_id=session_id,
        expires_at=expires_at,
        target_element=target,
        navigation_path=navigation_path,
    )
