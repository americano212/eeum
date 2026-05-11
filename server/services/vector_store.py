import uuid

from qdrant_client import AsyncQdrantClient
from qdrant_client.http import models as qmodels

from core.config import settings


_client: AsyncQdrantClient | None = None


def _qdrant() -> AsyncQdrantClient:
    global _client
    if _client is None:
        _client = AsyncQdrantClient(url=settings.qdrant_url)
    return _client


async def ensure_collection() -> None:
    client = _qdrant()
    existing = await client.get_collections()
    names = {c.name for c in existing.collections}
    if settings.qdrant_collection in names:
        return
    await client.create_collection(
        collection_name=settings.qdrant_collection,
        vectors_config=qmodels.VectorParams(
            size=settings.embedding_dim,
            distance=qmodels.Distance.COSINE,
        ),
    )
    await client.create_payload_index(
        collection_name=settings.qdrant_collection,
        field_name="state_id",
        field_schema=qmodels.PayloadSchemaType.KEYWORD,
    )


async def upsert_elements(
    state_id: str,
    url: str,
    dom_hash: str,
    elements_with_vectors: list[tuple[dict, list[float]]],
) -> int:
    if not elements_with_vectors:
        return 0
    client = _qdrant()

    await client.delete(
        collection_name=settings.qdrant_collection,
        points_selector=qmodels.FilterSelector(
            filter=qmodels.Filter(
                must=[
                    qmodels.FieldCondition(
                        key="state_id",
                        match=qmodels.MatchValue(value=state_id),
                    )
                ]
            )
        ),
    )

    points = []
    for element, vector in elements_with_vectors:
        points.append(
            qmodels.PointStruct(
                id=str(uuid.uuid4()),
                vector=vector,
                payload={
                    "state_id": state_id,
                    "url": url,
                    "dom_hash": dom_hash,
                    "xpath": element["xpath"],
                    "tag": element["tag"],
                    "text": element.get("text", ""),
                    "aria_label": element.get("aria_label"),
                    "role": element.get("role"),
                },
            )
        )
    await client.upsert(
        collection_name=settings.qdrant_collection,
        points=points,
    )
    return len(points)


async def search(query_vector: list[float], top_k: int = 5) -> list[dict]:
    client = _qdrant()
    result = await client.search(
        collection_name=settings.qdrant_collection,
        query_vector=query_vector,
        limit=top_k,
    )
    return [{"score": hit.score, **(hit.payload or {})} for hit in result]
