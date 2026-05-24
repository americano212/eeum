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

CREATE TABLE IF NOT EXISTS session_meta (
    session_id  TEXT PRIMARY KEY,
    last_url    TEXT,
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS session_meta_expires_idx
    ON session_meta (expires_at);
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


async def get_recent_messages(session_id: str, limit: int) -> list[dict]:
    """가장 최근 `limit`개 메시지를 시간순(오래된→최신)으로 반환."""
    pool = _require_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT role, content, created_at FROM (
              SELECT id, role, content, created_at FROM conversations
              WHERE session_id = $1
              ORDER BY id DESC
              LIMIT $2
            ) recent
            ORDER BY id ASC
            """,
            session_id,
            limit,
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
    """각 세션의 첫 user 메시지(=제목)와 마지막 활동 시각, 마지막 URL."""
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
              MAX(c1.created_at) AS last_activity,
              (SELECT last_url FROM session_meta sm WHERE sm.session_id = c1.session_id) AS last_url
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
            "last_url": r["last_url"],
        }
        for r in rows
    ]


async def set_last_url(session_id: str, url: str) -> None:
    pool = _require_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO session_meta (session_id, last_url, updated_at)
            VALUES ($1, $2, now())
            ON CONFLICT (session_id)
            DO UPDATE SET last_url = EXCLUDED.last_url, updated_at = now()
            """,
            session_id,
            url,
        )


async def get_last_url(session_id: str) -> str | None:
    pool = _require_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT last_url FROM session_meta WHERE session_id = $1",
            session_id,
        )
    return row["last_url"] if row else None


async def delete_session(session_id: str) -> None:
    """대화 로그 + 세션 메타를 한 번에 삭제."""
    pool = _require_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "DELETE FROM conversations WHERE session_id = $1",
                session_id,
            )
            await conn.execute(
                "DELETE FROM session_meta WHERE session_id = $1",
                session_id,
            )
