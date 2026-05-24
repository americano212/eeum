import uuid
from datetime import datetime, timedelta, timezone

from core.config import settings
from services import conversations


async def touch_or_create(session_id: str | None) -> tuple[str, str]:
    """Return (session_id, expires_at ISO). Issues a new session when missing/expired.

    Postgres-backed sliding TTL: every call extends `expires_at`. Expired rows
    are treated as missing — a fresh UUID is issued.
    """
    pool = conversations._require_pool()
    new_expires = datetime.now(timezone.utc) + timedelta(
        seconds=settings.session_ttl_seconds
    )

    async with pool.acquire() as conn:
        if session_id:
            row = await conn.fetchrow(
                """
                UPDATE session_meta
                   SET expires_at = $2, updated_at = now()
                 WHERE session_id = $1 AND expires_at > now()
                RETURNING session_id
                """,
                session_id,
                new_expires,
            )
            if row:
                return session_id, new_expires.isoformat()

        new_id = str(uuid.uuid4())
        await conn.execute(
            """
            INSERT INTO session_meta (session_id, expires_at)
            VALUES ($1, $2)
            ON CONFLICT (session_id) DO UPDATE
              SET expires_at = EXCLUDED.expires_at, updated_at = now()
            """,
            new_id,
            new_expires,
        )
        return new_id, new_expires.isoformat()


async def delete(session_id: str) -> None:
    """Drop the session row. Conversation log deletion is `conversations.delete_session`."""
    pool = conversations._require_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "DELETE FROM session_meta WHERE session_id = $1",
            session_id,
        )
