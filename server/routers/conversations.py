from fastapi import APIRouter
from pydantic import BaseModel

from services import conversations, session


router = APIRouter(tags=["conversations"])


class LogMessageRequest(BaseModel):
    session_id: str | None = None
    role: str
    content: str
    current_url: str | None = None


class LogMessageResponse(BaseModel):
    session_id: str
    expires_at: str


class MessageItem(BaseModel):
    role: str
    content: str
    created_at: str


class MessagesResponse(BaseModel):
    session_id: str
    messages: list[MessageItem]
    last_url: str | None = None


class SessionSummary(BaseModel):
    session_id: str
    title: str | None = None
    last_activity: str | None = None
    last_url: str | None = None


class SessionSummariesRequest(BaseModel):
    session_ids: list[str]


class SessionSummariesResponse(BaseModel):
    sessions: list[SessionSummary]


@router.post("/conversations/log", response_model=LogMessageResponse)
async def log_message(req: LogMessageRequest) -> LogMessageResponse:
    session_id, expires_at = await session.touch_or_create(req.session_id)
    await conversations.add_message(session_id, req.role, req.content)
    if req.current_url:
        await conversations.set_last_url(session_id, req.current_url)
    return LogMessageResponse(session_id=session_id, expires_at=expires_at)


@router.get("/conversations/{session_id}", response_model=MessagesResponse)
async def get_session_messages(session_id: str) -> MessagesResponse:
    rows = await conversations.get_messages(session_id)
    last_url = await conversations.get_last_url(session_id)
    return MessagesResponse(
        session_id=session_id,
        messages=[MessageItem(**m) for m in rows],
        last_url=last_url,
    )


@router.post("/conversations/sessions", response_model=SessionSummariesResponse)
async def get_session_summaries(
    req: SessionSummariesRequest,
) -> SessionSummariesResponse:
    rows = await conversations.get_session_summaries(req.session_ids)
    return SessionSummariesResponse(
        sessions=[SessionSummary(**r) for r in rows],
    )


class DeleteSessionResponse(BaseModel):
    session_id: str
    deleted: bool


@router.delete("/conversations/{session_id}", response_model=DeleteSessionResponse)
async def delete_session(session_id: str) -> DeleteSessionResponse:
    await conversations.delete_session(session_id)
    return DeleteSessionResponse(session_id=session_id, deleted=True)
