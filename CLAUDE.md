# CLAUDE.md

이 파일은 Claude Code 에게 주는 프로젝트 가이드. **세션마다 자동 로드되니 새 컨텍스트에서 매번 다시 설명할 필요 없도록 여기에 유지.**

## 컨텍스트를 적게 쓰는 방법

코드 전체를 읽지 말고 먼저 폴더별 **SPEC.md** 를 읽어 필요한 함수만 골라 보기.

| 폴더 | SPEC | 무엇 |
|---|---|---|
| `server/services/` | `server/services/SPEC.md` | 서비스 모듈 공개 함수 signature + 한 줄 설명 |
| `server/routers/` | `server/routers/SPEC.md` | FastAPI 엔드포인트 + 헬퍼 |
| `extension/` | `extension/SPEC.md` | 사용자 익스텐션 JS (background/content/sidebar) |
| `benchmark-extension/` | `benchmark-extension/SPEC.md` | 관리자 익스텐션 JS (background/content/lib/views/panel) |

전체 구조·실행법은 [`README.md`](./README.md), 원래 설계 명세는 [`spec.md`](./spec.md).

## SPEC 갱신 규칙 (필수)

**모든 코드 변경에 적용**:

1. **공개 함수의 signature 가 바뀌면** 해당 SPEC.md 도 같이 수정
2. **공개 함수가 추가/삭제되면** SPEC.md 에 추가/삭제
3. **모듈 / 파일이 추가/삭제되면** SPEC.md 에 항목 추가/삭제 + 이 파일의 표도 갱신
4. **메시지 타입 (chrome.runtime / port) 이 새로 생기면** 해당 익스텐션 SPEC.md 의 "메시지 타입 인덱스" 갱신
5. **storage 키 / 환경변수 가 추가되면** SPEC.md 또는 README 적절한 곳에 기재
6. **외부 API (`POST /...`) 가 추가/삭제되면** `server/routers/SPEC.md` + README 엔드포인트 표 둘 다

private (`_` prefix) 함수와 한 모듈 내부에서만 쓰는 helper 는 SPEC 에 안 적어도 됨. 외부에서 import 하는 시점부터 공개로 간주.

커밋 메시지에 "spec 갱신" 같은 별도 표시 불필요 — 코드 변경 커밋과 같이 묶어 올림.

## 이 프로젝트의 큰 그림

**두 익스텐션 + 한 서버**:

```
[extension/]                  사용자 에이전트. 자연어 → 액션 실행
[benchmark-extension/]        관리자 도구. 케이스 작성 / 벤치 실행 / 탐색
[server/]                     FastAPI + Qdrant + Neo4j + Postgres
```

핵심 엔드포인트:
- `/plan`, `/plan/strict` — LLM 풀 파이프라인 (site_rules + few-shot + safety)
- `/baseline` — capstone 동치 단일 LLM (벤치 비교 대상)
- `/query` — Qdrant + Neo4j shortestPath (사이트 간 경로 검색)
- `/judge` — LLM-as-judge 채점 (judge_tokens 별도)
- `/dom/check`, `/dom/upload` — DB 채우기
- 응답 공통: `processing_ms` (서버 처리 시간) + `tokens: {prompt, completion, embedding, total}`

DB 사용 현황:
- **Qdrant + Neo4j 는 `/query` 전용**. `/plan` 계열은 stateless
- **탐색 모드 (관리자 익스텐션)** 에서만 DB 채워짐
- 자세한 건 README "엔드포인트 요약" 표 + spec.md

## 자주 까먹는 것

- `processing_ms` / `tokens` 는 모든 신규 응답 스키마에 들어가야 함 (judge 만 `judge_tokens`)
- 라우트 진입점마다 `metrics.start()` 한 번 부르고 응답에 `metrics.snapshot()` 으로 마무리
- 메인 익스텐션에는 **explore 토글·서버 URL override 가 없다** (둘 다 관리자 익스텐션으로 이동)
- `state_id = "{url}|{dom_hash[:8]}"` — `dom_hash` 는 안정 시그너처 (id/aria_label/name/짧고 숫자 없는 텍스트만)
- 벤치 익스텐션은 ESM service worker (`"type": "module"`) — content script 는 classic
- chrome.downloads + data URL 로 저장 (chrome.downloads 권한 + `~/Downloads/eeum-bench/`)
- MV3 service worker 는 idle 로 죽음 — panel.js 의 `getPort()` lazy reconnect 패턴 유지

## 자주 까먹는 것 (작업 진행 시)

- 사용자가 destructive action(`docker compose down -v`, `git reset --hard` 등) 요청 안 했으면 묻고 진행
- 새 파일 만들기보다 기존 파일 수정 우선
- 주석 없는 게 기본. WHY 가 비자명할 때만 한 줄 (자세한 docstring 금지)
- 결정 사항 따로 받기 전에 함부로 destructive operation 안 함

## 관련 외부 위치

- 전신 프로토타입: `../capstone/` — 단일 LLM 호출 버전. `/baseline` 의 원본 소스 (`api.js:buildSystemPrompt`)
