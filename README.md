# DOM-based Semantic Navigation API

자연어 쿼리("~하고 싶어")를 받아 현재 웹 페이지에서 어떤 요소를 어떤 경로로 조작해야 하는지 반환하는 서버 + Chrome Extension.

설계 명세는 [`spec.md`](./spec.md) 참고.

## 현재 아키텍처 (세 트랙 병존)

```
[Chrome Extension]                            [FastAPI 서버]
                                              ┌──────────────────────────────────┐
사이드패널 입력 ─────────────┐                │ POST /plan/strict                │ ← 기본 ★사용중★
                            │                │   gpt-4o-mini, temperature=0      │
                            ▼                │   S1~S4 안전 / R1~R9 라우팅       │
background.js ─── (선택 가능 1) ────────────▶│   click/type/select 전부 await    │
                                              │                                  │
                                              │ POST /plan                       │ ← 비교용
                                              │   초기 flat-rule 프롬프트         │
                                              │   동일하게 await 후처리           │
                                              │                                  │
                                              │ POST /query                      │ ← 빠른 검색 경로
                                              │   ① 의도 추출(LLM 짧은 호출)      │
                                              │   ② Qdrant cosine + site_hint    │
                                              │   ③ Neo4j shortestPath           │
                                              │                                  │
탐색 모드 ON 일 때만 ─────────│ POST /dom/check / /dom/upload                  │
   STATE_CHANGED              │   페이지 요소 임베딩 → Qdrant 저장             │
                              │   상태 노드/엣지를 Neo4j 그래프에 적재           │
                              │                                                │
                              │ POST /admin/stats, /admin/reset                │
                              │   DB 카운트, 전체 비우기                        │
                              └──────────────────────────────────────────────┘
```

- **세 엔드포인트**는 사이드패널 ⚙ 설정에서 드랍다운으로 선택 가능 (`chrome.storage.local.planning_endpoint`).
- **탐색 모드(REC)** 가 켜져 있을 때만 STATE_CHANGED → `/dom/upload` 가 일어남. 그래야 의도적으로 사이트만 캡처 가능.
- 세 엔드포인트 모두 응답이 동일하게 후처리되어 **click/type/select 가 사용자 위임(await_*) 형태로 치환**된다.

## 클릭/입력 위임 정책

모든 엔드포인트의 응답은 다음 규칙으로 후처리됨:

| 원 액션 | 후처리 결과 | 의미 |
|---|---|---|
| `navigate` / `scroll` / `wait` / `highlight` | 그대로 | 자동 실행 |
| `click` | `await_click` | 영구 펄스 하이라이트 + 유저 클릭 대기 |
| `click_text` | `await_click_text` | 동일 (텍스트 매칭) |
| `type` | `await_type` | 입력란 하이라이트 + 유저 직접 입력 또는 "계속" → 자동 채움 |
| `select` | `await_select` | 동일 (드롭다운) |

- 유저가 강조된 요소를 클릭하지 않고 다른 곳을 클릭 → 시퀀스 중단 + 안내
- await_type/select 는 60~120초 무반응 시 타임아웃
- 안전 규칙(S1~S4)에 걸리는 위험 키워드 버튼/password/카드 input 은 LLM 단에서 `highlight + wait_for_user` 로 위임됨

## 라우팅 규칙 핵심 (STRICT 프롬프트)

`/plan/strict` 의 system prompt 에 인코딩된 규칙 중 R9 가 특히 중요:

> **R9. 같은 사이트 내부 이동은 navigate 금지** — 현재 URL 과 목적지가 같은 등록 도메인(eTLD+1) 이면 페이지 위의 요소(click/click_text/type)로 이동. navigate 는 사이트가 다를 때만 허용. 도달 가능한 요소가 페이지에 없으면 `needs_more_elements=true`.

`/query` 도 동일 정신: hop 처리 시 same-site 면 캡처된 트리거(text 우선, xpath 보조)로 이동, cross-site 면 navigate.

## chrome://newtab 등 restricted 페이지 처리

content script 가 못 붙는 페이지에서도 동작:
- 익스텐션은 빈 elements 로 plan 호출
- 응답이 navigate-only 면 `chrome.tabs.update` 로 직접 이동
- 그 후 정상 페이지에 도착하면 일반 흐름 재개

## 디렉터리

```
eeum/
├── spec.md
├── README.md
├── .vscode/settings.json            # 워크스페이스 인터프리터(server/.venv) + analysis 경로
├── server/
│   ├── main.py
│   ├── routers/
│   │   ├── plan.py                  # POST /plan, POST /plan/strict
│   │   ├── query.py                 # POST /query (의도 추출 + Qdrant + 그래프)
│   │   ├── dom.py                   # POST /dom/check, POST /dom/upload
│   │   └── admin.py                 # POST /admin/reset, GET /admin/stats
│   ├── services/
│   │   ├── llm.py                   # SYSTEM_PROMPT(/plan) + STRICT_SYSTEM_PROMPT(/plan/strict)
│   │   ├── intent.py                # /query 용 키워드/사이트 힌트 추출
│   │   ├── session.py               # Redis 세션 (TTL 7d)
│   │   ├── embedding.py             # OpenAI text-embedding-3-small
│   │   ├── vector_store.py          # Qdrant
│   │   └── graph.py                 # Neo4j (State, NAVIGATES_TO)
│   ├── models/schemas.py
│   ├── core/config.py
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── requirements.txt
└── extension/
    ├── manifest.json
    ├── config.js
    ├── background.js                # 엔드포인트 라우팅, await_* 흐름 조율, admin 호출, restricted 페이지 대응
    ├── content.js                   # DOM 수집/observer/액션 실행/하이라이트/클릭·입력 대기
    └── sidebar/
        ├── sidebar.html
        ├── sidebar.css
        └── sidebar.js               # 탐색 토글, 엔드포인트 드랍다운, DB stats/reset
```

## 사전 요구사항

- Python **3.11+** (로컬 개발 시)
- Docker Desktop (Compose 스택 사용 시)
- OpenAI API Key (`gpt-4o-mini` 호출 가능해야 함)

## 환경변수

`server/.env.example`을 복사해서 `server/.env`로 사용.

```bash
cd server
cp .env.example .env
# OPENAI_API_KEY 채우기
```

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `OPENAI_API_KEY` | — | **필수.** 임베딩 + 채팅 양쪽에 사용 |
| `CHAT_MODEL` | `gpt-4o-mini` | `/plan(.strict)`, `/query` 의도 추출에 사용 |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | 임베딩 모델 |
| `EMBEDDING_DIM` | `1536` | Qdrant 컬렉션 벡터 차원 |
| `NEO4J_USER` | `neo4j` | |
| `NEO4J_PASSWORD` | `password` | |
| `QDRANT_URL` | `http://qdrant:6333` | |
| `NEO4J_URI` | `bolt://neo4j:7687` | |
| `REDIS_URL` | `redis://redis:6379/0` | |

## 실행

### 1) Docker Compose (권장)

```bash
cd server
docker compose up --build
```

- API: <http://localhost:8000>
- Swagger: <http://localhost:8000/docs>
- Qdrant: <http://localhost:6333/dashboard>
- Neo4j: <http://localhost:7474>
- Redis: `localhost:6379`

종료:
```bash
docker compose down          # 컨테이너만
docker compose down -v       # 볼륨까지 삭제
```

### 2) 로컬 개발 (DB는 Docker, API는 로컬)

```bash
cd server
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

docker compose up -d qdrant neo4j redis

export OPENAI_API_KEY=sk-...
export QDRANT_URL=http://localhost:6333
export NEO4J_URI=bolt://localhost:7687
export REDIS_URL=redis://localhost:6379/0

uvicorn main:app --reload --port 8000
```

## API

### `POST /plan/strict` — 구조화 시스템 프롬프트 + 클릭/입력 위임 (기본 활성)

- temperature=0
- 시스템 프롬프트: **S1 ~ S4 안전 규칙** + **R1 ~ R9 라우팅 규칙** (R9: same-site click-through)
- 응답 후처리: `click`/`click_text`/`type`/`select` → `await_*` 변환

요청:
```json
{
  "session_id": null,
  "query": "로그인 버튼 찾아줘",
  "current_url": "https://www.naver.com",
  "current_elements": [
    {
      "tag": "a",
      "text": "NAVER 로그인",
      "aria_label": "NAVER 로그인",
      "xpath": "/html/body/.../a[1]",
      "href": "https://nid.naver.com/..."
    }
  ]
}
```

응답:
```json
{
  "session_id": "uuid...",
  "expires_at": "...",
  "explanation": "현재 페이지의 'NAVER 로그인' 링크를 클릭하면 됩니다.",
  "actions": [
    { "type": "await_click_text", "text": "NAVER 로그인" }
  ],
  "needs_more_elements": false
}
```

### `POST /plan` — 초기 flat-rule 프롬프트 (비교용)

스키마 동일. flat-rule 시스템 프롬프트만 다름. 후처리(`await_*` 치환)는 동일하게 적용.

### `POST /query` — 의도 추출 + 임베딩 + 그래프

흐름:
1. **의도 추출** — gpt-4o-mini 짧은 호출로 `{keyword, site_hint}` 분리
2. **Qdrant 검색** — `keyword` 임베딩 → top 10 (site_hint 있으면 top 30 → 호스트 매칭으로 추림)
3. **현재 페이지 우선** — `current_state_id` 일치 hit 우선
4. **경로 조립** — `shortest_path` 호출:
   - same-site hop: 캡처된 `trigger_text` → `trigger_xpath` 순으로 click
   - cross-site hop: `navigate`
   - 경로 없음 + same-site: `current_elements` 중 target 호스트 향하는 링크 발견 시 그 링크로 click, 못 찾으면 navigate 폴백
   - 경로 없음 + cross-site: navigate
5. 최종 `target_element` 의 click 은 클라이언트 어댑터에서 추가됨 (`text` 우선, 없으면 `xpath`)

요청:
```json
{
  "session_id": null,
  "query": "로그인 하려면 어떻게 해?",
  "current_state_id": "https://www.naver.com/|abc123",
  "current_url": "https://www.naver.com/",
  "current_dom_hash": "abc123",
  "current_elements": [ ... ]
}
```

응답:
```json
{
  "session_id": "uuid...",
  "expires_at": "...",
  "target_element": {
    "state_id": "https://nid.naver.com/.../#account|...",
    "url": "https://nid.naver.com/...",
    "xpath": "/html/body/.../button[1]",
    "tag": "button",
    "text": "로그인"
  },
  "navigation_path": [
    { "type": "click_text", "text": "NAVER 로그인" }
  ]
}
```
* 익스텐션의 background.js 가 `target_element` + `navigation_path` 를 통합 plan 형식으로 어댑트해서 동일한 await 흐름으로 실행.

### `POST /dom/check`, `POST /dom/upload` — 자동 인덱싱

탐색 모드가 ON 일 때만 호출됨. 같은 `state_id` 재업로드 시 기존 포인트 삭제 후 재적재.

### `POST /admin/reset` — DB 비우기

Qdrant 컬렉션 재생성 + Neo4j 전체 노드/엣지 삭제 + Redis `state:*` 키 삭제. 세션은 보존.

```json
{
  "status": "ok",
  "qdrant_recreated": true,
  "neo4j_cleared": true,
  "redis_state_keys_cleared": 12
}
```

### `GET /admin/stats` — DB 카운트

```json
{ "qdrant_points": 0, "neo4j_states": 0, "neo4j_edges": 0 }
```

### `GET /health`

```bash
curl http://localhost:8000/health
# {"status":"ok"}
```

### 지원 액션 타입

| 타입 | 필드 | 설명 |
|------|------|------|
| `navigate` | `url` | 페이지 이동 (cross-site 시) |
| `click` / `click_text` | `xpath` / `text` | 자동 클릭. 응답 후처리로 거의 안 나오고, /query 의 navigation_path 에서 동일사이트 hop 으로 등장 가능 |
| `await_click` | `xpath` | 영구 하이라이트 + 사용자 클릭 대기 |
| `await_click_text` | `text` | 텍스트 매칭 + 사용자 클릭 대기 |
| `type` / `select` | `xpath`, `value` | (드물게 그대로) 자동 입력/선택 |
| `await_type` | `xpath`, `value` | 입력란 하이라이트 + 사용자 직접 입력 또는 "계속" 자동 채움 |
| `await_select` | `xpath`, `value` | 드롭다운 하이라이트 + 사용자 선택 또는 "계속" 자동 |
| `scroll` | `direction`, `amount` | 스크롤 |
| `highlight` | `xpath` | 클릭 없이 시각 강조 |
| `wait` | `ms` | 대기 |
| `wait_for_user` | `instruction` | 사이드패널 "계속 진행" 버튼 대기 |

## Chrome Extension

Chrome MV3 사이드패널. 빌드 없이 unpacked 로드.

### 사이드패널 UI

| 요소 | 동작 |
|---|---|
| 상단 `OFF` / `● REC` | **탐색 모드 토글**. ON 일 때만 STATE_CHANGED → `/dom/upload` |
| 상단 🗑 | 세션 초기화 (chrome.storage.local 의 session_id 만 제거) |
| 상단 ⚙ | 설정 패널 토글 — 엔드포인트 드랍다운 + DB 통계/리셋 |
| 설정 → 엔드포인트 | `/plan/strict`, `/plan`, `/query` 중 선택 (저장: `planning_endpoint`) |
| 설정 → DB 새로고침 | `/admin/stats` 호출해 현재 DB 카운트 표시 |
| 설정 → DB 비우기 | 확인 다이얼로그 → `/admin/reset` |

### 1) 로드

1. `chrome://extensions` 접속
2. 우측 상단 **개발자 모드** ON
3. **압축해제된 확장 프로그램 로드** → `eeum/extension/`
4. 툴바 핀 (선택)

### 2) 권장 사용 흐름

1. 설정에서 엔드포인트 확인 (기본 `/plan/strict`)
2. **탐색 모드 ON** → 손으로 사이트를 돌아다니며 DB 채움 (사이드패널에 "📥 캡처: ..." 표시)
3. 채운 뒤 탐색 모드 OFF
4. 자연어로 입력 → 액션 시퀀스 실행 (대부분 await 액션이라 사용자가 직접 클릭/입력)

### 3) 디버그

| 위치 | 확인 |
|------|------|
| Sidebar console | 사이드패널 우클릭 → 검사 |
| Service worker  | `chrome://extensions` → "서비스 워커" |
| Content script  | 일반 페이지 DevTools Console (`[eeum]` 키워드) |

### 4) 동작 메모

- **인터랙션 요소만 수집**: `button, input, select, textarea, a, [role], [aria-label]`. `[role]`/`[aria-label]` wrapper 가 내부에 실제 컨트롤을 품으면 wrapper 제외 (leaf 우선).
- **요소 필드**: `tag, text, aria_label, role, xpath, id, href, type, name, placeholder`.
- **`dom_hash` (안정 식별자 기반)**: `id || aria_label || name || (1~20자 짧은 텍스트 + 숫자 없음)` 요소만 시그너처에 포함. 결과 정렬하여 DOM 순서 비의존. xpath 는 hash 에서 제외. 효과: 광고 회전/sticky/뉴스 위젯으로 인한 hash 폭발 방지.
- **상태 변화 트리거**: ① `main/[role=main]/dialog/[role=tabpanel]` 컨테이너 교체, ② 인터랙션 요소 수 ±5 이상 변화, ③ URL 변경.
- **`trigger_xpath`**: 클릭 후 500ms 윈도우 내 변화 감지 시 그 클릭 xpath 가 엣지에 기록.
- **content script 중복 주입 방지**: `window.__EEUM_CONTENT_LOADED__` 가드.
- **타겟 요소 하이라이트**: 자동 액션 직전 `position:fixed` 오버레이 600ms.
- **클릭/입력 대기 하이라이트**: `await_*` 액션은 주황 펄스 영구 하이라이트(rAF 추적). capture-phase 클릭/`input`/`change` 리스너로 사용자 행동 감지.
- **restricted 페이지**: chrome://newtab 등에서 첫 navigate 액션은 content script 대신 `chrome.tabs.update` 로 직접 처리.

## 운영 메모

- **세션 TTL**: 7일 sliding.
- **state 캐시 TTL**: 1시간 (`/dom/check` 히트 판정용).
- **Neo4j 리셋**: 위 `/admin/reset` 사용 권장. 수동:
  ```cypher
  MATCH (n) DETACH DELETE n;
  ```
- **Qdrant 컬렉션**: 앱 시작 시 자동 생성 (`dom_elements`, COSINE, dim=1536, payload index: `state_id`).
- **OpenAI 호환성 핀**: `requirements.txt` 에 `httpx<0.28`. openai 1.54.0 의 `proxies` 인자 호환성 회피.

## 트러블슈팅

| 증상 | 확인 |
|------|------|
| `OPENAI_API_KEY` 누락 | `server/.env` 또는 export |
| `Connection refused` (qdrant/neo4j/redis) | `docker compose ps` 로 컨테이너 기동 확인 |
| `Couldn't connect to neo4j:7687` at startup | healthcheck 로 자동 대기. 그래도 나면 `docker compose down -v && up --build` |
| `proxies` TypeError | openai/httpx 버전 충돌. `pip install -r requirements.txt` 재실행 |
| Extension CORS / Mixed Content | 서버가 `https` 면 extension SERVER_URL 도 `https` |
| 사이드패널이 안 열림 | manifest `side_panel` 권한 / `chrome://extensions` 리로드 |
| "페이지 콘텐츠를 인식하지 못했습니다" | 탭 새로고침 (content script 가 페이지 로드 시점에만 주입됨). chrome://newtab 등이면 restricted 흐름으로 자동 대응됨 |
| "요소를 찾을 수 없음 (await_click: ...)" | `/query` 응답의 xpath 가 stale. `target.text` 가 비어 있으면 발생. 같은 사이트 캡처 데이터가 부족할 가능성 — 탐색 모드로 더 채우거나 `/plan/strict` 사용 |
| 캡처 메시지 폭주 | 사이드패널 채팅에 "📥 캡처: ..." 가 많이 뜸 — 탐색 모드 OFF |
| `STATE_CHANGED` 무한 반복 | `dom_hash` 가 매번 달라짐 — content.js 의 `stableSignature` 가 잡지 못한 동적 요소 확인 |
| Neo4j 인증 실패 | 비밀번호 변경 시 `docker compose down -v` 로 볼륨 초기화 |
