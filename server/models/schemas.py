from typing import Literal
from pydantic import BaseModel, Field


class DomElement(BaseModel):
    tag: str
    text: str = ""
    aria_label: str | None = None
    role: str | None = None
    xpath: str
    id: str | None = None
    href: str | None = None
    type: str | None = None
    name: str | None = None
    placeholder: str | None = None


class DomCheckRequest(BaseModel):
    session_id: str | None = None
    state_id: str
    url: str
    dom_hash: str


class DomCheckResponse(BaseModel):
    session_id: str
    expires_at: str
    cache_miss: bool


class DomUploadRequest(BaseModel):
    session_id: str | None = None
    state_id: str
    url: str
    dom_hash: str
    referrer_state_id: str | None = None
    trigger_xpath: str | None = None
    elements: list[DomElement]


class DomUploadResponse(BaseModel):
    session_id: str
    expires_at: str
    stored: int


class QueryRequest(BaseModel):
    session_id: str | None = None
    query: str
    current_state_id: str
    current_url: str | None = None
    current_dom_hash: str | None = None
    current_elements: list[DomElement] | None = None


class TargetElement(BaseModel):
    state_id: str
    url: str
    xpath: str
    tag: str
    text: str


class NavigateAction(BaseModel):
    type: Literal["navigate"] = "navigate"
    url: str


class ClickAction(BaseModel):
    type: Literal["click"] = "click"
    xpath: str


class ClickTextAction(BaseModel):
    type: Literal["click_text"] = "click_text"
    text: str


class TypeAction(BaseModel):
    type: Literal["type"] = "type"
    xpath: str
    value: str


class SelectAction(BaseModel):
    type: Literal["select"] = "select"
    xpath: str
    value: str


class ScrollAction(BaseModel):
    type: Literal["scroll"] = "scroll"
    direction: Literal["up", "down"]
    amount: int


class WaitAction(BaseModel):
    type: Literal["wait"] = "wait"
    ms: int


class WaitForUserAction(BaseModel):
    type: Literal["wait_for_user"] = "wait_for_user"
    instruction: str


class HighlightAction(BaseModel):
    type: Literal["highlight"] = "highlight"
    xpath: str


class AwaitClickAction(BaseModel):
    type: Literal["await_click"] = "await_click"
    xpath: str


class AwaitClickTextAction(BaseModel):
    type: Literal["await_click_text"] = "await_click_text"
    text: str


class AwaitTypeAction(BaseModel):
    type: Literal["await_type"] = "await_type"
    xpath: str
    value: str


class AwaitSelectAction(BaseModel):
    type: Literal["await_select"] = "await_select"
    xpath: str
    value: str


class SiteSearchAction(BaseModel):
    type: Literal["site_search"] = "site_search"
    query: str


NavigationStep = (
    NavigateAction
    | ClickAction
    | ClickTextAction
    | TypeAction
    | SelectAction
    | ScrollAction
    | HighlightAction
    | AwaitClickAction
    | AwaitClickTextAction
    | AwaitTypeAction
    | AwaitSelectAction
    | WaitAction
    | WaitForUserAction
    | SiteSearchAction
)


class TokenUsage(BaseModel):
    prompt: int = 0
    completion: int = 0
    embedding: int = 0
    total: int = 0


class QueryResponse(BaseModel):
    session_id: str
    expires_at: str
    target_element: TargetElement
    navigation_path: list[NavigationStep] = Field(default_factory=list)
    processing_ms: int = 0
    tokens: TokenUsage = Field(default_factory=TokenUsage)


class PlanRequest(BaseModel):
    session_id: str | None = None
    query: str
    current_url: str | None = None
    current_elements: list[DomElement] | None = None


class PlanResponse(BaseModel):
    session_id: str
    expires_at: str
    explanation: str = ""
    actions: list[NavigationStep] = Field(default_factory=list)
    needs_more_elements: bool = False
    processing_ms: int = 0
    tokens: TokenUsage = Field(default_factory=TokenUsage)


# ── 베이스라인 (capstone 포팅) ─────────────────────────────────
# RAG·그래프·few-shot·safety gate 전부 없이, 단일 LLM 호출만 하는 비교 대상.

class BaselineRequest(BaseModel):
    query: str
    url: str | None = None
    elements: list[DomElement] = Field(default_factory=list)
    history: list[dict] | None = None


class BaselineResponse(BaseModel):
    explanation: str = ""
    actions: list[NavigationStep] = Field(default_factory=list)
    processing_ms: int = 0
    tokens: TokenUsage = Field(default_factory=TokenUsage)


# ── LLM-as-judge ───────────────────────────────────────────────
# 시스템 응답을 사람-라벨한 ground truth 와 비교 채점.

class JudgeGroundTruth(BaseModel):
    target_xpath: str | None = None
    target_xpath_alternatives: list[str] = Field(default_factory=list)
    expected_actions: list[dict] = Field(default_factory=list)
    expected_url_after: str | None = None
    expected_outcome_summary: str | None = None
    safety_class: str | None = None  # S1~S4 또는 null


class JudgeRequest(BaseModel):
    query: str
    ground_truth: JudgeGroundTruth
    system_response: dict  # /plan or /baseline 응답 그대로
    post_dom_summary: str | None = None  # 실행 후 페이지 요약 (URL/타이틀/주요 텍스트)


class JudgeResponse(BaseModel):
    target_hit: int  # 0/1
    outcome_match: float  # 0.0 / 0.5 / 1.0
    safety_correct: int  # 0/1
    composite: float  # 0.0 ~ 1.0
    reasoning: str = ""
    processing_ms: int = 0
    judge_tokens: TokenUsage = Field(default_factory=TokenUsage)
