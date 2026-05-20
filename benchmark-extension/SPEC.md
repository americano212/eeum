# benchmark-extension/ — 관리자 익스텐션 함수 명세

별도 MV3 익스텐션. 케이스 작성 / 배치 실행 / judge 채점 / 결과 대시보드 / DB 채우기 (탐색 모드).

`~/Downloads/eeum-bench/{cases,runs}/*.json` 으로 저장.

## `config.js`
- `self.EEUM_BENCH_CONFIG`
  - `SERVER_URL: string`
  - `DOWNLOAD_PREFIX: string` (기본 `"eeum-bench"`)
  - `INSPECTOR_COLOR: string`
  - `ACTION_DELAY_MS: number`

## `manifest.json` 필수 권한
`activeTab, storage, scripting, sidePanel, downloads, tabs` + `host_permissions: ["<all_urls>"]`
service_worker `"type": "module"` (ESM import 사용)

## `background.js` — service worker (ESM)
```js
import { saveCase, saveRun, saveSnapshot } from "./lib/storage.js";
import { callPlan, callBaseline, callJudge, callDomCheck, callDomUpload } from "./lib/api.js";
```

### 메시지 라우팅
- `chrome.runtime.onConnect` (`name: "bench-panel"`) → `handlePanelMessage(port, msg)`
- `chrome.runtime.onMessage` (content script 단발성):
  - `BENCH_TARGET_PICKED` / `BENCH_INSPECT_CANCELLED` → panel 으로 forward
  - `BENCH_STATE_CHANGED` → `handleStateChanged` (탐색 모드 ON 시 /dom/upload)

### 핵심 함수
- `sendToPanel(msg)` — activePort 로 push (없으면 무시)
- `activeTab() -> chrome.tabs.Tab | null`
- `sendToTab(tabId, msg) -> Promise<any>` — lastError 무시 wrapper
- `ensureContent(tabId, url) -> boolean` — config + dom_capture + content.js 주입
- `snapshotTab(tab) -> snapshot` — BENCH_SNAPSHOT, 실패 시 재주입 + 500ms 대기 후 재시도
- `newId() -> string` — `crypto.randomUUID()`
- `waitForTabLoad(tabId, timeoutMs=15000) -> Promise<void>`

### handlePanelMessage 케이스
- `BENCH_START_INSPECT` / `BENCH_STOP_INSPECT` — content 에 인스펙터 토글
- `BENCH_CAPTURE_SNAPSHOT` → `SNAPSHOT_RESULT`
- `BENCH_SAVE_CASE` → `saveCase` → `CASE_SAVED`
- `BENCH_RUN_CASES` → `runCases(port, payload)`
- `BENCH_EXPLORE_TOGGLE` / `BENCH_EXPLORE_STATE` — chrome.storage `bench_explore` 토글/조회

### 실행 루프
- `runCases(port, {cases, mode, runJudge})` — 케이스 순회, `RUN_STARTED` / `RUN_PROGRESS` / `RUN_CASE_DONE` / `RUN_FINISHED` 메시지. 끝나면 `saveRun(runObj)`
- `runSingleCase(c, mode, runJudge) -> result` — URL navigate → snapshotTab (stale 체크) → `/plan` or `/baseline` → 액션 자동 실행 → `BENCH_PAGE_SUMMARY` → `/judge`. result = `{case_id, mode, stale, processing_ms, tokens, actions, explanation, post_summary, target_hit, outcome_match, safety_correct, composite, reasoning, judge_tokens, judge_error}`

### 탐색 모드
- `handleStateChanged(payload)` — `bench_explore` ON 일 때만. `/dom/check` cache_miss 면 `/dom/upload` + `EXPLORE_CAPTURED` 패널 알림

## `content.js` — 모든 페이지에 주입
`window.__EEUM_BENCH_LOADED__` 가드. config + lib/dom_capture 가 먼저 로드돼야 함 (`self.EEUM_DOM` 의존).

### 라벨링 인스펙터
- `startInspect()` / `stopInspect()` — hover/click/keydown 리스너 토글
- hover 시 `moveInspectOverlay(rect)`, click 시 `summarizeEl(el)` → `BENCH_TARGET_PICKED` 전송
- ESC 키 → `BENCH_INSPECT_CANCELLED`

### 액션 실행 (벤치 자동 모드)
- `executeOne(action)` — `await_*` / `wait_for_user` / `site_search` 는 `{ok: true, deferred: true}` 로 기록만, 멈추지 않음. navigate / click / click_text / type / select / scroll / highlight 는 즉시 실행
- `findByText(text, elements)`

### 탐색 자동 감지 (`bench_explore` ON 시 의미)
- `pushStateChanged(reason)` — DOM snapshot 후 state_id 변경됐으면 `BENCH_STATE_CHANGED` 전송
- `scheduleSnapshot(reason, delay=250)` — debounce
- URL 변화 (`pushState/replaceState/popstate/hashchange`) → 100ms 후 스냅샷
- MutationObserver: main/dialog/tabpanel 컨테이너 교체 OR 인터랙션 요소 수 ±5 변화
- click capture-phase 리스너 → `pendingTriggerXpath` 500ms 윈도우 유지

### 페이지 요약
- `pageSummary()` — `{url, title, headings (h1~h3 8개), visible_text (800자)}` (judge 의 post_dom_summary 입력)

### 메시지 핸들러
- `BENCH_START_INSPECT` / `BENCH_STOP_INSPECT` / `BENCH_SNAPSHOT` / `BENCH_EXECUTE_ACTION` / `BENCH_PAGE_SUMMARY`

## `lib/dom_capture.js` — 공유 DOM 추출
`self.EEUM_DOM` 글로벌. content script 에서만 사용.
- `getXPath(el) -> string`
- `extractElements() -> DomElement[]` (내부 참조 `_el` 포함)
- `stripInternal(elements) -> 직렬화 가능 배열`
- `computeDomHash(elements) -> string` — SHA-256 앞 16자
- `makeStateId(url, hash) -> string` — `"{url}|{hash}"`
- `snapshot() -> {url, title, dom_hash, state_id, elements}`
- `findElementByXPath(xpath) -> Element | null`
- `SELECTOR` — `"button, input, select, textarea, a, [role], [aria-label]"`

## `lib/storage.js` — chrome.downloads wrapping (ESM exports)
- `saveCase(caseObj) -> Promise<downloadId>` — `eeum-bench/cases/<slug>_<site>_<id>.json`
- `saveRun(runObj) -> Promise<downloadId>` — `eeum-bench/runs/<slug>_<mode>_<id>.json`
- `saveSnapshot(prefix, snapshotObj) -> Promise<downloadId>` — `eeum-bench/snapshots/<slug>_<prefix>.json`

내부: data URL + conflictAction `"overwrite"` + saveAs `false`.

## `lib/api.js` — 서버 호출 (ESM exports)
- `callPlan({query, currentUrl, currentElements}) -> Promise<PlanResponse>`
- `callBaseline({query, url, elements, history}) -> Promise<BaselineResponse>`
- `callJudge({query, groundTruth, systemResponse, postDomSummary}) -> Promise<JudgeResponse>`
- `callDomCheck({stateId, url, domHash}) -> Promise<DomCheckResponse>`
- `callDomUpload(payload) -> Promise<DomUploadResponse>`

## `panel/panel.js` — 사이드패널 ESM entry
- `connect()` — 새 port + onMessage 디스패치 + onDisconnect 핸들러
- `getPort()` — lazy, disconnect 시 재연결
- `subscribe(fn) -> unsubscribe` — 모든 view 가 등록
- `send(msg)` — try/retry pattern (SW idle 종료 대비)
- `ctx = {send, subscribe}` 를 각 view 에 주입

### 탭 4개 초기화
`buildCaseBuilder(ctx)`, `buildRunner(ctx)`, `buildExplorer(ctx)`, `buildDashboard(ctx)`

## `views/case-builder.js`
- `buildCaseBuilder(ctx)` — DOM 바인딩 + 이벤트 핸들러 등록
- 사용 panel id: `case-query, pick-target-btn, snapshot-btn, target-display, target-info, snapshot-display, snapshot-info, case-expected-url, case-expected-outcome, case-safety, case-tags, save-case-btn, clear-case-btn, case-status`
- subscribe 이벤트: `TARGET_PICKED, INSPECT_CANCELLED, SNAPSHOT_RESULT, CASE_SAVED, ERROR`

## `views/runner.js`
- `buildRunner(ctx)` — 케이스 다중 선택 (.json) → 모드 토글 → 실행
- panel id: `case-folder-input, case-count, run-mode, run-judge, run-btn, run-progress, progress-fill, progress-text, run-results, cost-estimate`
- subscribe: `RUN_STARTED, RUN_PROGRESS, RUN_CASE_DONE, RUN_FINISHED, ERROR`

## `views/explorer.js`
- `buildExplorer(ctx)` — 토글 + 캡처 카운트
- panel id: `explore-toggle-btn, explore-status`
- subscribe: `EXPLORE_STATE, EXPLORE_CAPTURED`

## `views/dashboard.js`
- `buildDashboard(ctx)` — 결과 JSON 다중 선택 → 모드별/태그별 집계
- panel id: `result-folder-input, dashboard-summary, dashboard-by-mode, dashboard-by-tag, dashboard-cases`
- 같이 선택된 case JSON (case_id + tags 있으면) 으로 태그 룩업

---

## 케이스 / 결과 JSON 스키마
케이스: README 의 "케이스 JSON 포맷" 섹션 참고.
결과 (run 1개): `{run_id, started_at, finished_at, mode, results: [...], summary: {n, n_scored, avg_*, total_tokens}}`.

## 메시지 타입 인덱스 (panel ↔ background)
패널 → background:
- `BENCH_START_INSPECT, BENCH_STOP_INSPECT, BENCH_CAPTURE_SNAPSHOT, BENCH_SAVE_CASE, BENCH_RUN_CASES, BENCH_EXPLORE_TOGGLE, BENCH_EXPLORE_STATE`

background → panel:
- `TARGET_PICKED, INSPECT_CANCELLED, SNAPSHOT_RESULT, CASE_SAVED, RUN_STARTED, RUN_PROGRESS, RUN_CASE_DONE, RUN_FINISHED, EXPLORE_STATE, EXPLORE_CAPTURED, ERROR`

content ↔ background:
- request: `BENCH_START_INSPECT, BENCH_STOP_INSPECT, BENCH_SNAPSHOT, BENCH_EXECUTE_ACTION, BENCH_PAGE_SUMMARY`
- 단발: `BENCH_TARGET_PICKED, BENCH_INSPECT_CANCELLED, BENCH_STATE_CHANGED`
