"""요청 단위 토큰 사용량 누적기.

ContextVar 기반이라 FastAPI 의 동시 요청들이 서로의 카운터를 오염시키지 않는다.
각 라우트 handler 진입점에서 `metrics.start()` 를 한 번 호출하면 그 요청의 LLM/임베딩
호출들이 자동으로 합산되고, 응답 직전에 `metrics.snapshot()` 으로 꺼낸다.
"""
from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass


@dataclass
class _Usage:
    prompt: int = 0
    completion: int = 0
    embedding: int = 0

    @property
    def total(self) -> int:
        return self.prompt + self.completion + self.embedding


_current: ContextVar[_Usage | None] = ContextVar("token_usage", default=None)


def start() -> _Usage:
    """현재 요청 컨텍스트에 새 누적기를 설치. 라우트 진입점에서 호출."""
    usage = _Usage()
    _current.set(usage)
    return usage


def add_chat(prompt_tokens: int, completion_tokens: int) -> None:
    usage = _current.get()
    if usage is None:
        return
    usage.prompt += prompt_tokens or 0
    usage.completion += completion_tokens or 0


def add_embedding(tokens: int) -> None:
    usage = _current.get()
    if usage is None:
        return
    usage.embedding += tokens or 0


def snapshot() -> dict[str, int]:
    """응답에 실을 직렬화 가능한 dict. 누적기가 없으면 0 만 반환."""
    usage = _current.get()
    if usage is None:
        return {"prompt": 0, "completion": 0, "embedding": 0, "total": 0}
    return {
        "prompt": usage.prompt,
        "completion": usage.completion,
        "embedding": usage.embedding,
        "total": usage.total,
    }
