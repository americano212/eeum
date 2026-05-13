"""사용자 query와 의미적으로 가장 가까운 DOM element top-K만 추리는 in-memory ranker.

/plan 흐름은 사전 인덱싱 없이 매 요청마다 호출되므로, Qdrant 왕복 없이
배치 임베딩 한 번 + 코사인 정렬로 처리한다.
"""
from __future__ import annotations

import math

from models.schemas import DomElement
from services import embedding


def _text_for_ranking(el: DomElement) -> str:
    parts: list[str] = [el.tag]
    for v in (el.aria_label, el.placeholder, el.text, el.name, el.role, el.id):
        if v:
            parts.append(v)
    if el.href:
        parts.append(el.href[:80])
    return " ".join(parts)


def _cosine(a: list[float], b: list[float]) -> float:
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (math.sqrt(na) * math.sqrt(nb))


async def rank(
    query: str,
    elements: list[DomElement],
    top_k: int = 50,
) -> list[DomElement]:
    if not elements:
        return []
    if len(elements) <= top_k:
        return elements

    texts = [query] + [_text_for_ranking(e) for e in elements]
    vectors = await embedding.embed(texts)
    q_vec = vectors[0]
    e_vecs = vectors[1:]

    scored = [(i, _cosine(q_vec, v)) for i, v in enumerate(e_vecs)]
    scored.sort(key=lambda t: t[1], reverse=True)
    top_indices = sorted(i for i, _ in scored[:top_k])
    return [elements[i] for i in top_indices]
