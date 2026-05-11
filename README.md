# DOM-based Semantic Navigation API

자연어 쿼리("~하고 싶어")를 받아 현재 웹 페이지에서 어떤 요소를 어떤 경로로 조작해야 하는지 반환하는 서버 + Chrome Extension.

설계 명세는 [`spec.md`](./spec.md) 참고. 현재 동작 구조는 아래 그대로.

## 현재 아키텍처 (두 트랙 병존)

```
[Chrome Extension]                            [FastAPI 서버]
                                              ┌──────────────────────────────┐
사이드패널 입력 ─────────────┐                │ POST /plan                   │ ← 현재 ★사용중★
                            │                │   gpt-4o-mini chat.completions │
                            ▼                │   capstone와 동일한 system prompt
background.js ──────── POST /plan ──────────▶│   index→xpath 변환 후 응답   │
                                              │                              │
content.js (페이지 상태 바뀔 때)              │ POST /dom/check              │
   STATE_CHANGED                              │ POST /dom/upload             │
       │                                      │   현재 페이지의 인터랙션 요소 │
       ▼                                      │   임베딩 후 Qdrant 저장,     │
background.js ─── /dom/check ────────────────▶│   상태 노드를 Neo4j 그래프에 │
              └── /dom/upload (cache miss) ─▶│   추가 (referrer 엣지 포함) │
                                              │                              │
                                              │ POST /query                  │ ← 보존(미사용)
                                              │   임베딩 + 그래프 기반 흐름  │
                                              └──────────────────────────────┘
```

- **활성 경로:** 익스텐션의 USER_MESSAGE → `/plan` (LLM 플래닝)
- **백그라운드 누적:** content script가 페이지 상태 전이를 감지할 때마다 `/dom/check` → 캐시 미스면 `/dom/upload`. Qdrant와 Neo4j 인덱스가 계속 누적됨.
- **레거시 경로:** `/query`. 임베딩 유사도 + Neo4j shortestPath로 동작. 익스텐션은 현재 호출하지 않음. 추후 LLM 없이 동작하는 모드를 다시 시험할 때 사용.

## 디렉터리

```
eeum/
├── spec.md
├── README.md
├── server/
│   ├── main.py                      # FastAPI 엔트리 (lifespan에서 Qdrant·Neo4j 초기화)
│   ├── routers/
│   │   ├── plan.py                  # POST /plan (LLM 플래닝)
│   │   ├── query.py                 # POST /query (레거시, 임베딩+그래프)
│   │   └── dom.py                   # POST /dom/check, POST /dom/upload
│   ├── services/
│   │   ├── llm.py                   # OpenAI chat.completions, system prompt
│   │   ├── session.py               # Redis 세션 (TTL 7d)
│   │   ├── embedding.py             # OpenAI text-embedding-3-small
│   │   ├── vector_store.py          # Qdrant (delete-then-upsert)
│   │   └── graph.py                 # Neo4j (State, NAVIGATES_TO)
│   ├── models/schemas.py            # Pydantic 모델 (DomElement, Plan/Query Req·Resp, 액션 타입)
│   ├── core/config.py               # pydantic-settings
│   ├── Dockerfile
│   ├── docker-compose.yml           # qdrant + neo4j(healthcheck) + redis + api
│   └── requirements.txt
└── extension/
    ├── manifest.json                # MV3, sidePanel + scripting + webNavigation
    ├── config.js                    # SERVER_URL 등
    ├── background.js                # service worker. /plan 호출, 액션 실행 파이프라인
    ├── content.js                   # DOM 수집/observer/액션 실행/하이라이트
    └── sidebar/                     # 사이드 패널 UI
        ├── sidebar.html
        ├── sidebar.css
        └── sidebar.js
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
| `OPENAI_API_KEY` | — | **필수.** 임베딩(`text-embedding-3-small`) + 채팅(`gpt-4o-mini`) 양쪽에 사용 |
| `CHAT_MODEL` | `gpt-4o-mini` | `/plan` 에서 사용할 OpenAI 모델 |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | 임베딩 모델 |
| `EMBEDDING_DIM` | `1536` | Qdrant 컬렉션 벡터 차원 |
| `NEO4J_USER` | `neo4j` | |
| `NEO4J_PASSWORD` | `password` | |
| `QDRANT_URL` | `http://qdrant:6333` | Compose 내부 host 기준 |
| `NEO4J_URI` | `bolt://neo4j:7687` | |
| `REDIS_URL` | `redis://redis:6379/0` | |

## 실행

### 1) Docker Compose (권장)

```bash
cd server
docker compose up --build
```

- API: <http://localhost:8000>
- Swagger 문서: <http://localhost:8000/docs>
- Qdrant 대시보드: <http://localhost:6333/dashboard>
- Neo4j 브라우저: <http://localhost:7474> (id/pw는 `.env`)
- Redis: `localhost:6379`

`docker-compose.yml`의 `neo4j` 서비스에 healthcheck가 걸려 있어서 `api`는 Neo4j가 실제로 준비된 뒤에 시작됩니다.

종료:

```bash
docker compose down          # 컨테이너만 제거
docker compose down -v       # 볼륨(Qdrant/Neo4j/Redis 데이터)까지 삭제
```

### 2) 로컬 개발 (DB는 Docker, API는 로컬)

```bash
cd server

python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# DB만 컴포즈로 띄우기
docker compose up -d qdrant neo4j redis

# 호스트 기준 주소로 .env 또는 export
export OPENAI_API_KEY=sk-...
export QDRANT_URL=http://localhost:6333
export NEO4J_URI=bolt://localhost:7687
export REDIS_URL=redis://localhost:6379/0

uvicorn main:app --reload --port 8000
```

## API

### `POST /plan` — LLM 기반 액션 플랜 (익스텐션이 사용)

**요청**

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
      "role": null,
      "xpath": "/html/body/.../a[1]",
      "id": null,
      "href": "https://nid.naver.com/...",
      "type": null,
      "name": null,
      "placeholder": null
    },
    "..."
  ]
}
```

**응답**

```json
{
  "session_id": "uuid...",
  "expires_at": "2026-05-18T...",
  "explanation": "로그인 버튼을 클릭합니다.",
  "actions": [
    { "type": "click", "xpath": "/html/body/.../a[1]" }
  ],
  "needs_more_elements": false
}
```

내부적으로 `gpt-4o-mini` 채팅 호출 (JSON mode). LLM은 `index` 기반으로 액션을 반환하고, 서버가 클라이언트 실행에 쓰일 `xpath` 기반 액션으로 변환.

지원 액션 타입:

| 타입 | 필드 | 설명 |
|------|------|------|
| `navigate` | `url` | 페이지 이동 |
| `click` | `xpath` | 요소 클릭 |
| `click_text` | `text` | 텍스트로 매칭해서 클릭 (`navigate` 이후 권장) |
| `type` | `xpath`, `value` | 입력 |
| `select` | `xpath`, `value` | `<select>` 옵션 선택 |
| `scroll` | `direction`("up"/"down"), `amount` | 스크롤 |
| `highlight` | `xpath` | 클릭 없이 시각 강조만 (위험 액션 안내용) |
| `wait` | `ms` | 대기 |
| `wait_for_user` | `instruction` | 사용자 확인 필요, 사이드패널에 "계속 진행" 버튼 표시 |

LLM은 `발급/신청/구매/결제/주문/제출/확인/저장/완료/전송/예약/등록` 등 되돌리기 어려운 버튼은 직접 클릭하지 않고 `highlight` + `wait_for_user` 조합으로 사용자에게 위임하도록 system prompt에 명시되어 있음.

### `POST /dom/check` — 상태 캐시 확인 (자동 파이프라인)

```json
{
  "session_id": null,
  "state_id": "https://example.com/settings|a1b2c3",
  "url": "https://example.com/settings",
  "dom_hash": "a1b2c3"
}
```

응답에 `cache_miss: true`면 `/dom/upload`로 이어짐.

### `POST /dom/upload` — DOM 요소 업로드 (자동 파이프라인)

요소들을 임베딩해서 Qdrant에 저장하고, Neo4j에 상태 노드 + (있다면) referrer 엣지를 만듭니다. 같은 `state_id`로 들어오면 기존 포인트를 삭제 후 다시 적재(중복 누적 방지).

### `POST /query` — 레거시 시맨틱 검색 (현재 미사용)

임베딩 유사도 기반으로 후보 요소를 찾고, Neo4j `shortestPath`로 도달 경로를 조립합니다. 현재 익스텐션은 호출하지 않으나 엔드포인트는 보존. 자세한 흐름은 [`spec.md`](./spec.md) 참고.

### `GET /health`

```bash
curl http://localhost:8000/health
# {"status":"ok"}
```

## Chrome Extension

Chrome MV3 사이드패널. 빌드 없이 unpacked로 로드.

### 1) 서버 주소

기본값: `extension/config.js`의 `SERVER_URL = "http://localhost:8000"`. 운영 서버가 바뀌면 이 파일만 수정. 임시 변경은 사이드패널의 ⚙ 버튼에서 override (값은 `chrome.storage.local.server_url_override`).

### 2) 로드

1. `chrome://extensions` 접속
2. 우측 상단 **개발자 모드** 토글 ON
3. **압축해제된 확장 프로그램 로드** → `eeum/extension/` 선택
4. 툴바 퍼즐 아이콘 → "DOM Navigator" 핀 (선택)

### 3) 사용

- 아무 사이트에서 툴바의 **DOM Navigator** 아이콘 클릭 → 사이드패널
- 자연어로 입력 (예: "결제 플랜 변경하고 싶어")
- 백그라운드에서 페이지 상태가 바뀔 때마다 자동으로 DOM이 서버에 누적됨 (Qdrant + Neo4j 그래프 — 현재 활성 경로에서는 안 쓰이지만 데이터는 쌓임)

### 4) 디버그

| 위치 | 확인 |
|------|------|
| Sidebar console | 사이드패널 우클릭 → 검사 |
| Service worker  | `chrome://extensions` → "서비스 워커" |
| Content script  | 일반 페이지 DevTools Console |

### 5) 동작 메모

- **인터랙션 요소만 수집**: `button, input, select, textarea, a, [role], [aria-label]`. 단, `[role]`/`[aria-label]` 로 잡힌 wrapper 가 내부에 실제 컨트롤을 품고 있으면 wrapper 는 제외(leaf 우선).
- **요소 필드**: `tag, text, aria_label, role, xpath, id, href, type, name, placeholder`.
- **`dom_hash`**: `tag + xpath + aria-label + role` 시그너처를 SHA-256으로 해시 후 앞 8 bytes만. 동적 텍스트는 제외해서 hash 폭발 방지.
- **상태 변화 트리거**: ① `main/[role=main]/dialog/[role=tabpanel]` 컨테이너 교체, ② 인터랙션 요소 수 ±5 이상 변화, ③ URL 변경(`pushState`/`popstate`/`hashchange`).
- **`trigger_xpath`**: 클릭 후 500ms 윈도우 내에 변화가 감지되면 그 클릭이 엣지의 `trigger_xpath` 로 기록.
- **content script 중복 주입 방지**: `window.__EEUM_CONTENT_LOADED__` 가드.
- **타겟 요소 하이라이트**: 액션 실행 직전에 `position:fixed` 오버레이로 600ms 강조 후 클릭. `highlight` 액션은 강조만 하고 클릭은 생략(`wait_for_user` 와 함께 사용자에게 위임).

## 운영 메모

- **세션**: `session_id`가 `null`이거나 만료된 경우 서버가 새 UUID 발급. 응답의 `session_id`/`expires_at`을 클라이언트가 `chrome.storage.local`에 보관. TTL 7일 sliding.
- **state 캐시 TTL**: 1시간. `/dom/check`의 히트 판정과 `/query`의 동기 업로드 분기에 사용.
- **Neo4j 리셋**: 문제 발생 시 노드/엣지 전체 드롭 허용.
  ```cypher
  MATCH (n) DETACH DELETE n;
  ```
- **Qdrant 컬렉션**: 앱 시작 시 자동 생성 (`dom_elements`, COSINE, dim=1536). 같은 `state_id` 재업로드는 기존 포인트 삭제 후 재적재.
- **OpenAI 호환성 픽스**: `requirements.txt` 에 `httpx<0.28` 핀. openai 1.54.0이 httpx 0.28에서 제거된 `proxies` 인자를 넘기는 버그 회피용.

## 트러블슈팅

| 증상 | 확인 |
|------|------|
| `OPENAI_API_KEY` 누락 | `server/.env` 또는 export 여부 |
| `Connection refused` (qdrant/neo4j/redis) | Compose 컨테이너 기동 여부 (`docker compose ps`) |
| `Couldn't connect to neo4j:7687` at startup | healthcheck 추가 후엔 자동 대기. 그래도 나면 `docker compose down -v && up --build` |
| `proxies` keyword TypeError | openai/httpx 버전 충돌. `pip install -r requirements.txt` 재실행 |
| Extension에서 CORS / Mixed Content | 서버가 `https`면 extension SERVER_URL도 `https` |
| 사이드패널이 안 열림 | manifest의 `side_panel` 권한 / `chrome://extensions`에서 리로드 |
| "페이지 콘텐츠를 인식하지 못했습니다" | 탭을 한 번 새로고침. content script가 페이지 로드 시점에만 주입되는 게 원인 |
| `chrome://newtab` 등에서 동작 안 함 | 브라우저 내부 페이지는 의도적으로 차단 (background.js의 RESTRICTED_URL_RE) |
| `STATE_CHANGED` 무한 반복 | `dom_hash`가 매번 달라짐 → 페이지의 동적 요소가 selector에 잡히는지 확인 |
| Neo4j 인증 실패 | 첫 기동 이후 비밀번호 변경 시 `docker compose down -v`로 볼륨 초기화 |
