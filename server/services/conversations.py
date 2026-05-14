import asyncpg

from core.config import settings


_pool: asyncpg.Pool | None = None


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS conversations (
    id          BIGSERIAL PRIMARY KEY,
    session_id  TEXT NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_session_created_idx
    ON conversations (session_id, created_at);
"""


async def init() -> None:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(settings.postgres_dsn, min_size=1, max_size=5)
    async with _pool.acquire() as conn:
        await conn.execute(SCHEMA_SQL)


async def close() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def _require_pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("conversations pool not initialized")
    return _pool


async def add_message(session_id: str, role: str, content: str) -> None:
    pool = _require_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO conversations (session_id, role, content) VALUES ($1, $2, $3)",
            session_id,
            role,
            content,
        )


async def get_messages(session_id: str) -> list[dict]:
    pool = _require_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT role, content, created_at FROM conversations "
            "WHERE session_id = $1 ORDER BY id ASC",
            session_id,
        )
    return [
        {
            "role": r["role"],
            "content": r["content"],
            "created_at": r["created_at"].isoformat(),
        }
        for r in rows
    ]


async def get_session_summaries(session_ids: list[str]) -> list[dict]:
    """각 세션의 첫 user 메시지(=제목)와 마지막 활동 시각."""
    if not session_ids:
        return []
    pool = _require_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
              c1.session_id,
              (SELECT content FROM conversations c2
                 WHERE c2.session_id = c1.session_id AND c2.role = 'user'
                 ORDER BY id ASC LIMIT 1) AS title,
              MAX(c1.created_at) AS last_activity
            FROM conversations c1
            WHERE c1.session_id = ANY($1::text[])
            GROUP BY c1.session_id
            """,
            session_ids,
        )
    return [
        {
            "session_id": r["session_id"],
            "title": r["title"],
            "last_activity": r["last_activity"].isoformat() if r["last_activity"] else None,
        }
        for r in rows
    ]
