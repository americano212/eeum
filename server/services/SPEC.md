# server/services — 함수 명세

각 모듈의 **공개 (밑줄 없는) 함수만** 정리. private (`_`) helper 는 생략. 모든 함수 signature 는 실제 코드와 동기화 유지 — 변경 시 이 파일도 같이 수정.

## `metrics.py` — 요청 단위 토큰 누적 (ContextVar)
- `start() -> _Usage` — 요청 진입점에서 호출. 새 ContextVar 누적기 설치
- `add_chat(prompt_tokens: int, completion_tokens: int) -> None` — chat completion usage push
- `add_embedding(tokens: int) -> None` — embedding usage push
- `snapshot() -> dict[str, int]` — `{prompt, completion, embedding, total}` dict 로 응답에 실음

## `embedding.py` — OpenAI 임베딩 + metrics 통합
- `embed(texts: list[str]) -> list[list[float]]` — 다건. 빈 입력은 `[]`. usage 자동 push
- `embed_one(text: str) -> list[float]` — 1건 wrapper
- `element_text(tag, xpath, aria_label, text) -> str` — DOM 요소 → 임베딩 입력 텍스트. xpath 는 제외

## `intent.py` — `/query` 키워드 추출
- `extract(query: str) -> dict` — `{keyword: str, site_hint: str|None}`. 짧은 chat 호출(temp=0). JSON 실패 시 query 그대로 반환

## `llm.py` — `/plan` 계열 메인 LLM 호출
- `plan_actions(query, url, elements, max_elements=50, history=None) -> dict` — 풀 파이프라인: element_ranker → few-shot → site_rules → official_hint → chat. 결과에 `elements_used` 같이 반환
- `plan_actions_strict(query, url, elements, max_elements=50, history=None) -> dict` — STRICT_SYSTEM_PROMPT 만. site_rules / few-shot 미사용
- `BASE_SYSTEM_PROMPT` / `STRICT_SYSTEM_PROMPT` — 상수. S1~S4 + R1~R9

## `baseline.py` — capstone 동치 단일 호출
- `plan(query, url, elements, history=None) -> dict` — `{explanation, actions, needs_more_elements, elements_used}`. capstone `buildSystemPrompt` 그대로

## `judge.py` — LLM-as-judge 채점
- `judge(query, ground_truth, system_response, post_dom_summary) -> dict` — `{target_hit, outcome_match, safety_correct, composite, reasoning}`. target_hit / safety_correct 는 코드 결정, outcome_match 만 LLM

## `safety.py` — 결정적 안전 게이트 (`/plan` 후처리)
- `is_dangerous_target(el: DomElement) -> bool` — button/a 텍스트에 S1 키워드(발급/신청/결제/...) 포함
- `is_password_input(el: DomElement) -> bool` — type=password 또는 비밀번호 관련 attr
- `is_card_input(el: DomElement) -> bool` — 카드번호/CVC/유효기간 관련
- `apply(actions: list[NavigationStep], elements: list[DomElement]) -> list[NavigationStep]` — 위반 액션을 `highlight + wait_for_user` 로 치환

## `few_shot.py` — JSONL 코퍼스 RAG
- `retrieve(query: str, url: str, top_k=3) -> list[dict]` — 사례 검색. 코사인 ≥ MIN_SCORE(0.35) 만
- `format_block(examples: list[dict]) -> str` — system prompt 에 끼울 텍스트 블록
- `reset_cache() -> None` — 핫리로드/테스트용

## `element_ranker.py` — query 기반 요소 ranking
- `rank(query: str, elements: list[DomElement], top_k: int) -> list[DomElement]` — 임베딩 + cosine 으로 정렬 후 상위 top_k

## `site_rules.py` — `site_rules.yaml` 파서
- `lookup(url: str) -> dict | None` — 호스트로 site 규칙 조회
- `lookup_direct_service(query: str) -> tuple[site_name, keyword, url] | None` — direct_services 키워드 정확 매칭 (예: "주민등록등본")
- `all_sites_block() -> str` — system prompt 에 박을 전체 사이트 표
- `current_site_block(url: str) -> str` — 현재 URL 매칭 사이트의 규칙 블록

## `official_site.py` — Wikidata 공식 사이트 lookup
- `lookup(query: str) -> str | None` — query 핵심어 → Wikidata SEARCH → P856(official website) 추출. cross-site 의도 + 인덱스 cold 일 때만 호출
- `reset_cache() -> None`

## `vector_store.py` — Qdrant
- `ensure_collection() -> None` — startup. 컬렉션 없으면 생성 (cosine, dim 1536, payload index `state_id`)
- `upsert_elements(state_id, url, dom_hash, elements_with_vectors) -> int` — 같은 state_id 기존 포인트 삭제 후 재적재. 반환: 적재 수
- `search(query_vector: list[float], top_k=5) -> list[dict]` — `{score, state_id, url, xpath, tag, text, ...}` 리스트

## `graph.py` — Neo4j
- `ensure_constraints() -> None` — startup. `State.state_id` UNIQUE
- `close() -> None` — shutdown
- `state_exists(state_id) -> bool` — State 노드 존재 여부. `/dom/check` 히트 판정용
- `upsert_state(state_id, url, dom_hash) -> None` — MERGE
- `add_edge(from_state_id, to_state_id, trigger_xpath, trigger_text) -> None` — MERGE 엣지. 같은 (from,to) 면 trigger 갱신
- `shortest_path(from_state_id, to_state_id) -> list[dict]` — 최대 hop 20. 각 hop = `{trigger_xpath, trigger_text, from_url, to_url}`

## `session.py` — Postgres 세션 (TTL 7d sliding)
- `touch_or_create(session_id: str | None) -> tuple[session_id, expires_at_iso]` — `session_meta.expires_at` UPSERT. 만료/없으면 새 UUID 발급
- `delete(session_id: str) -> None` — `session_meta` row 삭제 (대화 로그는 `conversations.delete_session` 책임)

## `conversations.py` — Postgres 대화 영속화
- `init() -> None` — startup. 스키마 자동 마이그레이션 (conversations + session_meta)
- `close() -> None`
- `add_message(session_id, role, content) -> None`
- `get_messages(session_id) -> list[dict]` — 전체, 시간순
- `get_recent_messages(session_id, limit) -> list[dict]` — 마지막 N개
- `get_session_summaries(session_ids: list[str]) -> list[dict]` — 각 세션 첫 user 메시지(=제목) + last_url + last_activity
- `set_last_url(session_id, url) -> None`
- `get_last_url(session_id) -> str | None`
- `delete_session(session_id) -> None` — 대화 + 메타 삭제
