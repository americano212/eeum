from neo4j import AsyncGraphDatabase, AsyncDriver

from core.config import settings


_driver: AsyncDriver | None = None


def _drv() -> AsyncDriver:
    global _driver
    if _driver is None:
        _driver = AsyncGraphDatabase.driver(
            settings.neo4j_uri,
            auth=(settings.neo4j_user, settings.neo4j_password),
        )
    return _driver


async def ensure_constraints() -> None:
    async with _drv().session() as session:
        await session.run(
            "CREATE CONSTRAINT state_id_unique IF NOT EXISTS "
            "FOR (s:State) REQUIRE s.state_id IS UNIQUE"
        )


async def close() -> None:
    global _driver
    if _driver is not None:
        await _driver.close()
        _driver = None


async def upsert_state(state_id: str, url: str, dom_hash: str) -> None:
    async with _drv().session() as session:
        await session.run(
            "MERGE (s:State {state_id: $state_id}) "
            "SET s.url = $url, s.dom_hash = $dom_hash",
            state_id=state_id,
            url=url,
            dom_hash=dom_hash,
        )


async def add_edge(
    from_state_id: str,
    to_state_id: str,
    trigger_xpath: str | None,
    trigger_text: str | None,
) -> None:
    async with _drv().session() as session:
        await session.run(
            "MERGE (a:State {state_id: $from_id}) "
            "MERGE (b:State {state_id: $to_id}) "
            "MERGE (a)-[r:NAVIGATES_TO]->(b) "
            "SET r.trigger_xpath = $xpath, r.trigger_text = $text",
            from_id=from_state_id,
            to_id=to_state_id,
            xpath=trigger_xpath,
            text=trigger_text,
        )


async def shortest_path(from_state_id: str, to_state_id: str) -> list[dict]:
    """Return ordered list of edge properties along the shortest path."""
    if from_state_id == to_state_id:
        return []
    async with _drv().session() as session:
        result = await session.run(
            "MATCH p = shortestPath((a:State {state_id: $from_id})"
            "-[:NAVIGATES_TO*..20]->(b:State {state_id: $to_id})) "
            "RETURN [rel IN relationships(p) | "
            "  {trigger_xpath: rel.trigger_xpath, trigger_text: rel.trigger_text}] AS hops, "
            "[node IN nodes(p) | {state_id: node.state_id, url: node.url}] AS states",
            from_id=from_state_id,
            to_id=to_state_id,
        )
        record = await result.single()
        if not record:
            return []
        hops = record["hops"]
        states = record["states"]
        steps = []
        for i, hop in enumerate(hops):
            steps.append(
                {
                    "trigger_xpath": hop["trigger_xpath"],
                    "trigger_text": hop["trigger_text"],
                    "from_url": states[i]["url"],
                    "to_url": states[i + 1]["url"],
                }
            )
        return steps
