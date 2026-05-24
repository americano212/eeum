from fastapi import APIRouter

from core.config import settings
from services import graph, vector_store


router = APIRouter(prefix="/admin", tags=["admin"])


@router.post("/reset")
async def reset() -> dict:
    """Qdrant dom_elements + Neo4j State/NAVIGATES_TO 삭제. 세션/대화는 보존."""

    qclient = vector_store._qdrant()
    try:
        await qclient.delete_collection(collection_name=settings.qdrant_collection)
    except Exception:
        pass
    await vector_store.ensure_collection()

    async with graph._drv().session() as s:
        await s.run("MATCH (n:State) DETACH DELETE n")

    return {
        "status": "ok",
        "qdrant_recreated": True,
        "neo4j_cleared": True,
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
