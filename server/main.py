from contextlib import asynccontextmanager

from fastapi import FastAPI

from routers import conversations as conversations_router, dom, plan, query
from services import conversations, graph, vector_store


@asynccontextmanager
async def lifespan(app: FastAPI):
    await vector_store.ensure_collection()
    await graph.ensure_constraints()
    await conversations.init()
    yield
    await graph.close()
    await conversations.close()


app = FastAPI(
    title="DOM-based Semantic Navigation API",
    version="0.1.0",
    lifespan=lifespan,
)


app.include_router(dom.router)
app.include_router(query.router)
app.include_router(plan.router)
app.include_router(conversations_router.router)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}
