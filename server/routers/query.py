import time
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException

from models.schemas import (
    ClickAction,
    ClickTextAction,
    NavigateAction,
    QueryRequest,
    QueryResponse,
    TargetElement,
    TokenUsage,
)
from services import embedding, graph, intent, metrics, session, vector_store


_KR_2LD = {"co", "or", "ne", "ac", "go", "re", "pe"}


def _registered_domain(url: str) -> str:
    """url 에서 eTLD+1 추출 (서브도메인 제거).
    naver.com / nid.naver.com → naver.com,  www.naver.co.kr → naver.co.kr.
    완벽한 PSL 은 아니지만 한국·미국 일반 도메인은 잡힘."""
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return ""
    if not host:
        return ""
    parts = host.split(".")
    if len(parts) <= 2:
        return host
    if parts[-2] in _KR_2LD and len(parts) >= 3:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def _same_site(url_a: str, url_b: str) -> bool:
    da = _registered_domain(url_a)
    db = _registered_domain(url_b)
    return bool(da) and da == db


router = APIRouter(tags=["query"])


@router.post("/query", response_model=QueryResponse)
async def query(req: QueryRequest) -> QueryResponse:
    metrics.start()
    t0 = time.perf_counter()

    session_id, expires_at = await session.touch_or_create(req.session_id)

    # 현재 DOM이 함께 왔고 아직 인덱싱되지 않았다면 즉시 업서트 (인덱스 비어있어도 동작 보장)
    if (
        req.current_elements
        and req.current_url is not None
        and req.current_dom_hash is not None
        and not await graph.state_exists(req.current_state_id)
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

    # 자연어 → {keyword, site_hint} 의도 추출. 짧은 LLM 호출(temp=0).
    # keyword 만 임베딩해서 군더더기/지시문 영향 제거.
    parsed = await intent.extract(req.query)
    keyword = parsed["keyword"]
    site_hint = parsed["site_hint"]

    query_vector = await embedding.embed_one(keyword)
    # site_hint 가 있으면 후필터를 위해 후보 풀을 넓게 — 30개에서 10개 추림.
    raw_hits = await vector_store.search(
        query_vector, top_k=30 if site_hint else 10
    )
    if site_hint:
        host = site_hint.lower()
        filtered = [h for h in raw_hits if host in (h.get("url") or "").lower()]
        hits = filtered or raw_hits
    else:
        hits = raw_hits
    hits = hits[:10]
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

    def _find_link_to(target_url: str, elements) -> dict | None:
        """현재 페이지 요소 중 target_url 호스트로 향하는 링크를 찾는다."""
        if not elements:
            return None
        try:
            t_host = (urlparse(target_url).hostname or "").lower()
            t_path = (urlparse(target_url).path or "").rstrip("/")
        except Exception:
            return None
        if not t_host:
            return None
        best = None
        for el in elements:
            href = getattr(el, "href", None)
            if not href:
                continue
            try:
                hu = urlparse(href)
            except Exception:
                continue
            if (hu.hostname or "").lower() != t_host:
                continue
            hp = (hu.path or "").rstrip("/")
            if hp == t_path:
                return el  # 정확 일치 — 즉시 채택
            if best is None:
                best = el  # 같은 호스트 첫 후보
        return best

    navigation_path: list = []
    current_url = req.current_url or ""
    if top["state_id"] != req.current_state_id:
        hops = await graph.shortest_path(req.current_state_id, top["state_id"])
        if hops:
            # text 가 xpath 보다 페이지 변동에 강함 — text 우선, 없으면 xpath.
            # 사이트가 바뀌는 hop 은 navigate.
            for hop in hops:
                same_site = _same_site(hop["from_url"], hop["to_url"])
                if same_site:
                    if hop.get("trigger_text"):
                        navigation_path.append(
                            ClickTextAction(text=hop["trigger_text"])
                        )
                    elif hop.get("trigger_xpath"):
                        navigation_path.append(
                            ClickAction(xpath=hop["trigger_xpath"])
                        )
                    else:
                        # 트리거 캡처가 빠진 same-site hop — navigate 폴백
                        navigation_path.append(NavigateAction(url=hop["to_url"]))
                else:
                    navigation_path.append(NavigateAction(url=hop["to_url"]))
        else:
            # 그래프에 경로가 없음. 같은 사이트면 현재 페이지 요소 중에서
            # target host 로 향하는 링크를 찾아 클릭으로 처리. 못 찾으면 navigate 폴백.
            if _same_site(current_url, top["url"]):
                link = _find_link_to(top["url"], req.current_elements or [])
                if link is not None and (link.text or "").strip():
                    navigation_path.append(ClickTextAction(text=link.text.strip()))
                elif link is not None:
                    navigation_path.append(ClickAction(xpath=link.xpath))
                else:
                    navigation_path.append(NavigateAction(url=top["url"]))
            else:
                navigation_path.append(NavigateAction(url=top["url"]))

    processing_ms = int((time.perf_counter() - t0) * 1000)
    return QueryResponse(
        session_id=session_id,
        expires_at=expires_at,
        target_element=target,
        navigation_path=navigation_path,
        processing_ms=processing_ms,
        tokens=TokenUsage(**metrics.snapshot()),
    )
