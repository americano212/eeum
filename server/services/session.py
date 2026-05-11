import uuid
from datetime import datetime, timedelta, timezone

import redis.asyncio as redis

from core.config import settings


_redis: redis.Redis | None = None


def _client() -> redis.Redis:
    global _redis
    if _redis is None:
        _redis = redis.from_url(settings.redis_url, decode_responses=True)
    return _redis


def _session_key(session_id: str) -> str:
    return f"session:{session_id}"


def _state_cache_key(state_id: str) -> str:
    return f"state:{state_id}"


async def touch_or_create(session_id: str | None) -> tuple[str, str]:
    """Return (session_id, expires_at ISO). Issues a new session when missing/expired."""
    client = _client()
    if session_id:
        exists = await client.exists(_session_key(session_id))
        if not exists:
            session_id = None

    if not session_id:
        session_id = str(uuid.uuid4())
        await client.set(
            _session_key(session_id),
            "1",
            ex=settings.session_ttl_seconds,
        )
    else:
        await client.expire(_session_key(session_id), settings.session_ttl_seconds)

    expires_at = (
        datetime.now(timezone.utc) + timedelta(seconds=settings.session_ttl_seconds)
    ).isoformat()
    return session_id, expires_at


async def state_cached(state_id: str) -> bool:
    client = _client()
    return bool(await client.exists(_state_cache_key(state_id)))


async def mark_state_cached(state_id: str) -> None:
    client = _client()
    await client.set(
        _state_cache_key(state_id), "1", ex=settings.state_cache_ttl_seconds
    )
