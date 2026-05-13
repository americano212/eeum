"""성공 사례 (query, url, plan) 코퍼스에서 의미적 유사 사례 retrieval.

JSONL 파일을 프로세스 기동 시 한 번만 로드해서 임베딩을 캐시. /plan 호출
시에는 query+url 임베딩 한 번 + 코사인 정렬로 top-K를 system prompt 에 주입.

코퍼스 추가/갱신: server/services/few_shot_examples.jsonl 에 한 줄씩 JSON.
   {"query": "...", "url": "...", "response": {"explanation":..., "actions":[...], "needs_more_elements":false}}
"""
from __future__ import annotations

import asyncio
import json
import math
from pathlib import Path

from services import embedding


_PATH = Path(__file__).parent / "few_shot_examples.jsonl"
_examples: list[dict] | None = None
_vectors: list[list[float]] | None = None
_load_lock = asyncio.Lock()

MIN_SCORE = 0.35  # 이 미만은 노이즈로 보고 주입 안 함


def _key(ex: dict) -> str:
    return f"{ex.get('query','')} @ {ex.get('url','')}"


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


async def _ensure_loaded() -> None:
    global _examples, _vectors
    if _examples is not None:
        return
    async with _load_lock:
        if _examples is not None:
            return
        if not _PATH.exists():
            _examples = []
            _vectors = []
            return
        raw_lines = _PATH.read_text(encoding="utf-8").splitlines()
        parsed: list[dict] = []
        for line in raw_lines:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                parsed.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        _examples = parsed
        if not parsed:
            _vectors = []
            return
        _vectors = await embedding.embed([_key(ex) for ex in parsed])


async def retrieve(query: str, url: str, top_k: int = 3) -> list[dict]:
    await _ensure_loaded()
    if not _examples:
        return []
    q_vec = await embedding.embed_one(f"{query} @ {url or ''}")
    scored = [
        (ex, _cosine(q_vec, v))
        for ex, v in zip(_examples, _vectors or [])
    ]
    scored.sort(key=lambda t: t[1], reverse=True)
    return [ex for ex, score in scored[:top_k] if score >= MIN_SCORE]


def format_block(examples: list[dict]) -> str:
    if not examples:
        return ""
    lines: list[str] = ["━━━ [참고 사례 — 유사한 과거 성공 케이스] ━━━"]
    for ex in examples:
        lines.append(f"요청: {ex.get('query','')}")
        if ex.get("url"):
            lines.append(f"URL: {ex['url']}")
        lines.append(f"응답: {json.dumps(ex.get('response', {}), ensure_ascii=False)}")
        lines.append("")
    return "\n".join(lines).rstrip()


def reset_cache() -> None:
    """테스트/핫리로드용. jsonl을 다시 읽고 임베딩도 다시 만든다."""
    global _examples, _vectors
    _examples = None
    _vectors = None
