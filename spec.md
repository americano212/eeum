# DOM-based Semantic Navigation System 명세

## 개요

사용자가 자연어로 "~하고 싶어"라고 요청하면, 사이트의 어떤 페이지의 어떤 요소를 어떤 경로로 조작해야 하는지 반환하는 시스템.

---

## 기술 스택

### Client (Chrome Extension)

| 항목 | 선택 |
|------|------|
| 언어 | Vanilla JavaScript (기존 CLAUDE.md 구조 유지) |
| 저장소 | `chrome.storage.local` (session_id, expires_at 보관) |
| 통신 | `fetch` API (REST) |
| DOM 감지 | `MutationObserver`, `history.pushState` 인터셉트 |

### Server

| 항목 | 선택 |
|------|------|
| 언어 | Python 3.11+ |
| 프레임워크 | FastAPI (async 기본, 자동 `/docs` 생성) |
| VectorDB | Qdrant |
| Graph DB | Neo4j |
| 캐시 | Redis |
| 임베딩 | OpenAI `text-embedding-3-small` (`openai` Python SDK) |
| Neo4j 클라이언트 | `neo4j` Python 드라이버 |
| Qdrant 클라이언트 | `qdrant-client` |
| Redis 클라이언트 | `redis-py` (async) |
| 컨테이너 | Docker Compose (Qdrant + Neo4j + Redis + FastAPI) |

---

## Client Side

### 역할

- DOM 수집 및 해시 관리
- 서버와의 통신 (변경분만 전송)
- 페이지 전환 감지 및 점진적 수집
- 세션 ID 로컬 보관 및 만료 관리
- 서버 응답의 xpath → DOM index 변환

### 수집 대상

인터랙션 요소만 추출: `button`, `input`, `select`, `textarea`, `a`, `[role]`, `[aria-label]`

각 요소에서 추출할 필드:

- `tag`, `aria-label`, `role`, `xpath`, `id`, `href` (a 태그의 경우)
- `text`는 포함하되 hash 계산 대상에서는 제외 (아래 dom_hash 참고)

### dom_hash 계산 방식

동적 콘텐츠(타임스탬프, 알림 배지, 광고 등)로 인한 hash 폭발을 방지하기 위해, **텍스트 내용을 제외한 구조만** hash 대상으로 삼는다.

```
hash 대상: tag + xpath + aria-label + role
hash 제외: text 콘텐츠, 숫자, 날짜 등 동적 값
```

### 상태 변화 감지 전략

URL이 바뀌지 않아도 DOM이 변하는 케이스(SPA 탭 전환, 모달 오픈 등)가 많기 때문에, 두 가지 트리거를 모두 감지한다.

**URL 변화 감지** — `history.pushState`, `popstate`, `hashchange` 이벤트 감지

**DOM 변화 감지** — `MutationObserver`로 DOM 변화를 감시하되, 아래 조건 중 하나를 충족할 때만 새 상태로 취급한다.

- 주요 컨테이너(`main`, `[role=main]`, `dialog`, `[role=tabpanel]`)가 교체됐을 때 (1순위)
- 인터랙션 요소 수가 ±5개 이상 변화했을 때 (보조)

### trigger_xpath 추적

클릭 이벤트 발생 시 해당 요소의 xpath를 임시 기록해두고, **500ms 이내에** MutationObserver가 유의미한 변화를 감지하면 해당 클릭을 상태 전환의 원인으로 연결한다. 500ms 내 변화가 없으면 trigger_xpath는 null로 처리한다.

### 노드 식별자 (State ID)

```
state_id = URL + "|" + dom_hash

예시:
"https://example.com/settings|a1b2c3"   ← 일반 탭
"https://example.com/settings|d4e5f6"   ← 결제 탭 (URL 동일, DOM 다름)
"https://example.com/settings|x7y8z9"   ← 모달 열린 상태
```

### 세션 관리 (클라이언트)

- `chrome.storage.local`에 `session_id`와 `expires_at` 보관
- 요청마다 `expires_at`을 현재시각 + 7일로 갱신
- `expires_at` 초과 시 또는 session_id 없을 때 → `session_id: null`로 요청

### xpath → index 변환 (응답 후처리)

서버는 xpath 기반으로 요소를 특정하지만, 기존 Extension 액션 스키마는 index 기반이다. 클라이언트가 서버 응답을 받은 후 현재 DOM에서 변환을 수행한다.

```
서버 응답 수신 (xpath 포함)
    │
    ▼
현재 페이지의 인터랙션 요소 목록을 추출 (수집 시와 동일한 방식)
    │
    ▼
xpath로 해당 요소를 찾아 목록 내 index 확인
    │
    ▼
{ type: "click", xpath: "..." } → { type: "click", index: N }
{ type: "type", xpath: "...", value } → { type: "type", index: N, value }
    │
    ▼
변환된 액션을 기존 Extension 실행 파이프라인으로 전달
```

**navigate 이후 주의**: URL 전환 후에는 DOM이 바뀌므로 index 변환 불가. 이 경우 서버는 `click_text`를 사용하며 클라이언트는 변환 없이 그대로 실행한다. (기존 CLAUDE.md 규칙과 동일)

### 동작 플로우

```
[트리거 1] URL 변경 감지
[트리거 2] MutationObserver → DOM 유의미한 변화 감지
        │
        ▼
인터랙션 요소 추출 → dom_hash 생성 (구조만)
        │
        ▼
state_id = current_url + "|" + dom_hash
        │
        ├─ 서버에 state_id 전송 → 캐시 히트 → 종료
        │
        └─ 캐시 미스
              │
              ├─ 이전 state_id가 있으면 referrer_state_id로 기록
              └─ 추출된 요소 목록 전송
```

### 서버로 전송하는 데이터 구조

**hash 확인 요청**

```typescript
{
  session_id: string | null,
  state_id: string,
  url: string,
  dom_hash: string
}
```

**캐시 미스 시 DOM 전송**

```typescript
{
  session_id: string | null,
  state_id: string,
  url: string,
  dom_hash: string,
  referrer_state_id: string | null,
  trigger_xpath: string | null,
  elements: [
    {
      tag: string,
      text: string,
      aria_label: string | null,
      role: string | null,
      xpath: string,
      id: string | null,
      href: string | null
    }
  ]
}
```

**쿼리 요청**

```typescript
{
  session_id: string | null,
  query: string,
  current_state_id: string
}
```

---

## Server Side

### 역할

- 세션 발급 및 컨텍스트 관리
- DOM 데이터 수신 및 임베딩 생성
- VectorDB 저장 및 검색
- Navigation Graph 관리
- 쿼리에 대한 경로 + 요소 반환 (xpath 기반)

### 디렉터리 구조

```
server/
├── main.py                  # FastAPI 앱 엔트리포인트
├── routers/
│   ├── dom.py               # POST /dom/check, POST /dom/upload
│   └── query.py             # POST /query
├── services/
│   ├── session.py           # 세션 발급 및 컨텍스트 관리
│   ├── embedding.py         # OpenAI 임베딩 호출
│   ├── vector_store.py      # Qdrant 저장/검색
│   └── graph.py             # Neo4j 엣지 추가/경로 탐색
├── models/
│   └── schemas.py           # Pydantic 요청/응답 모델
├── core/
│   └── config.py            # 환경변수 (API 키, DB URL 등)
├── docker-compose.yml
└── requirements.txt
```

### 세션 관리 (서버)

**발급 흐름**

```
session_id: null 요청 수신
    │
    ▼
UUID로 새 session_id 생성
Redis에 세션 저장 (TTL 7일)
    │
    ▼
응답에 session_id + expires_at 포함
```

**컨텍스트 보관**

- 세션당 최근 대화 10턴 보관 (query + response 1쌍 = 1턴)
- 11번째 턴부터 가장 오래된 턴 제거 (sliding window)
- 만료된 session_id 수신 시 새 session_id 발급 후 응답
- 요청마다 Redis 세션 TTL을 7일로 갱신

### DOM 수신 처리 플로우

```
POST /dom/check (state_id 캐시 확인)
    ├─ 히트 → 204 반환
    └─ 미스 → 204 + cache_miss: true 반환

POST /dom/upload (캐시 미스 시 요소 목록 수신)
    │
    ▼
각 요소의 (tag + xpath + aria-label + text) 조합 → 임베딩 생성 (OpenAI API)
    │
    ▼
Qdrant에 저장 (payload에 state_id, url, xpath 등 포함)
    │
    ▼
referrer_state_id 있으면 Neo4j에 엣지 추가
(referrer_state_id → state_id, trigger_xpath/trigger_text 속성 포함)
    │
    ▼
Redis에 state_id 저장 (TTL 1시간)
```

### Qdrant 저장 구조

```
collection: "dom_elements"

point:
  vector: float[]
  payload:
    state_id: string        // "https://example.com/settings|a1b2c3"
    url: string
    dom_hash: string
    xpath: string
    tag: string
    text: string
    aria_label: string
    role: string
```

### Navigation Graph 구조 (Neo4j)

```
노드: State { state_id, url, dom_hash }
엣지: NAVIGATES_TO { trigger_xpath, trigger_text }

예시:
(settings|aaa)-[:NAVIGATES_TO { xpath: "//li[1]", text: "결제" }]->(settings|bbb)
(settings|bbb)-[:NAVIGATES_TO { xpath: "//button", text: "플랜변경" }]->(settings|ccc)

경로 탐색:
MATCH p = shortestPath((a:State {state_id: $from})-[:NAVIGATES_TO*]->(b:State {state_id: $to}))
RETURN p

Neo4j 특이사항:
- 문제 발생 시 노드/엣지 전체 드롭 후 재구축 허용
```

### 쿼리 처리 플로우

```
POST /query (session_id, query, current_state_id 수신)
    │
    ▼
세션 컨텍스트 조회 (최근 10턴)
    │
    ▼
query 임베딩 생성 (OpenAI API)
    │
    ▼
Qdrant 유사도 검색 (상위 5개)
    │
    ▼
각 결과의 state_id 추출
    │
    ├─ current_state_id와 동일 → 바로 xpath 반환
    │
    └─ 다른 state_id → Neo4j shortestPath로 경로 탐색
                        엣지의 trigger_xpath 순서대로 조합
                              │
                              ▼
                        경로 + target xpath 반환
    │
    ▼
세션 컨텍스트에 이번 턴 추가 (sliding window, 최대 10턴)
Redis 세션 TTL 7일로 갱신
```

### 응답 구조

서버는 xpath 기반으로 응답한다. index 변환은 클라이언트 책임.

```typescript
{
  session_id: string,
  expires_at: string,             // ISO 8601, 마지막 요청 기준 +7일
  target_element: {
    state_id: string,
    url: string,
    xpath: string,
    tag: string,
    text: string
  },
  navigation_path: [
    { type: "navigate", url: string },
    { type: "click", xpath: string },
    { type: "click_text", text: string },    // navigate 이후 전용
    { type: "type", xpath: string, value: string },
    { type: "select", xpath: string, value: string },
    { type: "scroll", direction: "up" | "down", amount: number },
    { type: "wait", ms: number },
    { type: "wait_for_user", instruction: string },
  ]
}
```

---

## 확정 사항

| # | 항목 | 결정 |
|---|------|------|
| 1 | Graph DB | Neo4j, 문제 시 드롭 후 재구축 허용 |
| 2 | 세션 | 서버 발급 UUID, 클라이언트 로컬 보관, 만료 7일 (마지막 요청 기준 갱신), 컨텍스트 최대 10턴 sliding window |
| 3 | TTL | state_id 캐시 일괄 1시간 |
| 4 | MutationObserver | 주요 컨테이너 교체 1순위 + ±5개 요소 변화 보조 |
| 5 | dom_hash | 구조(tag + xpath + aria-label)만 대상, 텍스트 콘텐츠 제외 |
| 6 | trigger_xpath | 클릭 시 xpath 기록 → 500ms 내 MutationObserver 감지 시 연결 |
| 7 | 서버 언어/프레임워크 | Python 3.11+ / FastAPI |
| 8 | 액션 스키마 | 기존 CLAUDE.md 액션 타입 준수, xpath→index 변환은 클라이언트 담당 |
