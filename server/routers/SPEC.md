# server/routers — 엔드포인트 명세

전부 FastAPI `APIRouter`. 모든 응답에 `processing_ms: int` + `tokens: TokenUsage` 포함 (스키마는 `models/schemas.py`). 변경 시 같이 갱신.

## `plan.py`
- `POST /plan` → `PlanResponse` — 자동 실행 + safety.apply 후처리. `llm.plan_actions` 사용
- `POST /plan/strict` → `PlanResponse` — 모든 click/click_text/type/select 를 `await_*` 로 wrap. `llm.plan_actions_strict` 사용
- 공통 헬퍼:
  - `_action_from_llm(a: dict, elements: list[DomElement]) -> NavigationStep | None` — LLM JSON → typed Pydantic. index 기반 액션은 elements[idx] 의 xpath 로 변환
  - `_run_plan(req, plan_fn) -> PlanResponse` — touch session → history (HISTORY_LIMIT=20) → plan_fn → safety.apply → 응답
  - `_defer_action(action)` — strict 모드의 await_* wrapping

## `query.py`
- `POST /query` → `QueryResponse` — intent → Qdrant top-K → Neo4j shortestPath → target + navigation_path. 404 if no match
  - `current_elements` 동봉되고 인덱스 cold 면 즉석 upsert
  - `site_hint` 있으면 top-30 → host filter
  - 같은 page hit 가 있으면 우선
- 헬퍼:
  - `_registered_domain(url) -> str` — eTLD+1 (한국 2LD 포함: co/or/ne/ac/go/re/pe)
  - `_same_site(url_a, url_b) -> bool`

## `baseline.py`
- `POST /baseline` → `BaselineResponse` — capstone 동치. `baseline.plan` 호출 + index→xpath 변환만. safety 없음

## `judge.py`
- `POST /judge` → `JudgeResponse` — `judge.judge` 호출. **judge_tokens** 필드로 토큰 격리 (시스템 metrics 와 분리)

## `dom.py` (prefix `/dom`)
- `POST /dom/check` → `DomCheckResponse` — Neo4j `State` 노드 존재 여부 → `cache_miss` bool
- `POST /dom/upload` → `DomUploadResponse` — 요소 임베딩 → Qdrant upsert + Neo4j upsert_state + (referrer 있으면) add_edge

## `admin.py` (prefix `/admin`)
- `POST /admin/reset` → dict — Qdrant 컬렉션 드롭&재생성 + Neo4j 전체 DETACH DELETE. 세션/대화는 보존
- `GET /admin/stats` → dict — `{qdrant_points, neo4j_states, neo4j_edges}`

## `conversations.py` — Postgres 대화 영속화
- `POST /conversations/log` → `LogMessageResponse` — `(session_id, role, content, current_url?)` 적재. last_url 동기화
- `GET /conversations/{session_id}` → `MessagesResponse` — 전체 메시지 시간순
- `POST /conversations/sessions` → `SessionSummariesResponse` — 다건 세션 요약 (title=첫 user msg, last_activity, last_url)
- `DELETE /conversations/{session_id}` → `DeleteSessionResponse` — 대화 + 세션 메타 삭제

---

## 신규 엔드포인트 추가 시 체크리스트
1. `models/schemas.py` 에 Request/Response Pydantic 정의 (`processing_ms` + `tokens` 포함)
2. router 파일에서 `metrics.start()` + `time.perf_counter()` 측정
3. `main.py` 의 `include_router` 등록
4. 이 SPEC.md 갱신
