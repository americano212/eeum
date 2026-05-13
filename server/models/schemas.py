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
    | WaitAction
    | WaitForUserAction
    | SiteSearchAction
)


class QueryResponse(BaseModel):
    session_id: str
    expires_at: str
    target_element: TargetElement
    navigation_path: list[NavigationStep] = Field(default_factory=list)


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
