import redis.asyncio as redis
from fastapi import APIRouter

from core.config import settings
from services import graph, vector_store


router = APIRouter(prefix="/admin", tags=["admin"])


@router.post("/reset")
async def reset() -> dict:
    """Qdrant dom_elements + Neo4j State/NAVIGATES_TO + Redis state:* 전부 삭제.
    session:* 키와 활성 컨테이너는 유지."""

    # Qdrant — 컬렉션 드롭 후 재생성
    qclient = vector_store._qdrant()
    try:
        await qclient.delete_collection(collection_name=settings.qdrant_collection)
    except Exception:
        pass
    await vector_store.ensure_collection()

    # Neo4j — 모든 노드+엣지 삭제
    async with graph._drv().session() as s:
        await s.run("MATCH (n) DETACH DELETE n")

    # Redis — state:* 키만 삭제 (세션은 보존)
    r = redis.from_url(settings.redis_url, decode_responses=True)
    state_keys = []
    async for key in r.scan_iter("state:*"):
        state_keys.append(key)
    if state_keys:
        await r.delete(*state_keys)
    await r.aclose()

    return {
        "status": "ok",
        "qdrant_recreated": True,
        "neo4j_cleared": True,
        "redis_state_keys_cleared": len(state_keys),
    }


@router.get("/stats")
async def stats() -> dict:
    qclient = vector_store._qdrant()
    info = await qclient.get_collection(settings.qdrant_collection)

    async with graph._drv().session() as s:
        r1 = await s.run("MATCH (n:State) RETURN count(n) AS c")
        rec1 = await r1.single()
        state_count = int(rec1["c"]) if rec1 else 0

        r2 = await s.run("MATCH ()-[r:NAVIGATES_TO]->() RETURN count(r) AS c")
        rec2 = await r2.single()
        edge_count = int(rec2["c"]) if rec2 else 0

    return {
        "qdrant_points": info.points_count,
        "neo4j_states": state_count,
        "neo4j_edges": edge_count,
    }
