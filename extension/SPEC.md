# extension/ — 사용자 익스텐션 함수 명세

MV3 sidePanel. 일상 사용자가 자연어 요청을 입력하면 액션 실행. **DB 채우기·서버 주소 변경은 여기 없음** (관리자 익스텐션으로 분리됨).

## `config.js`
- `self.EEUM_CONFIG` 글로벌
  - `SERVER_URL: string` — 변경 시 코드 수정 (UI override 없음)
  - `ACTION_DELAY_MS: number` — 액션 사이 기본 대기

## `background.js` — service worker
세션·서버 호출·액션 실행 오케스트레이션. ESM 아닌 classic script.

### 세션
- `getSession()` / `saveSession(id, expires_at)` / `clearSession()` — chrome.storage.local
- `getKnownSessions()` / `registerKnownSession(id)` / `unregisterKnownSession(id)` — 다중 세션 목록 관리

### 설정
- `getPlanningEndpoint()` — `/plan` / `/plan/strict` / `/query` 중 사이드패널 설정값
- `getServerUrl()` — `CFG.SERVER_URL` 그대로 반환 (trailing slash 제거)

### 서버 호출
- `postJSON(path, body)` / `getJSON(path)` / `deleteJSON(path)` — fetch wrapper. 401/429 처리
- `callPlan(query, snapshot)` — endpoint 선택 + cross-site 의도 시 elements 비우기 + 헤더에 last_url

### 활성 탭 / content script
- `getActiveTabId()`, `sendToTab(tabId, msg)`, `ensureContentScript(tabId)`, `fetchCurrentSnapshot(tabId)` — content script 미주입 시 자동 inject + REQUEST_DOM_SNAPSHOT
- `isRestrictedUrl(url)` — `chrome://`, `chrome-extension://` 등

### restricted 페이지
- `handleRestrictedPage(tabId, query, port)` — 빈 elements 로 plan 호출 → 첫 액션이 navigate 면 `chrome.tabs.update` 로 직접 이동 → 정상 페이지에서 다시 일반 흐름

### 액션 실행
- `runActions(actions, tabId, port)` — 순회 실행, navigate 후 재주입 + replan, await_* 와 wait_for_user 처리
- `deferClickAction(a)` — click/click_text/type/select → await_*
- `navigateTabAndWait(tabId, url, timeoutMs)` — tabs.update + load 완료 대기
- `instructionFor(action)` — await_* 액션의 사용자 안내문

### 대화 로그
- `postLog(role, content)` — POST /conversations/log + last_url 동기화
- `getActiveTabUrl()`, `notifySidebar(port, msg)` — 사이드패널에 보내는 메시지는 자동으로 DB 에도 기록 (`logFromOutgoing`)
- `describeAction(action)` — 한 줄 요약 (action 로그용)

### cross-site 감지
- `_hostnameOf(url)` — URL → hostname
- `looksLikeCrossSiteIntent(query, currentUrl)` — query 에 site_rules 키워드/별칭 등장 + 현재 페이지 호스트 다름

### 메시지 수신
- `chrome.runtime.onConnect` → 사이드패널 port. `USER_MESSAGE` 처리
- (STATE_CHANGED 핸들러는 제거됨 — 관리자 익스텐션으로 이전)

## `content.js` — 모든 페이지에 주입
IIFE, exports 없음. background 가 보내는 단발성 메시지만 처리.

### 메시지 핸들러
- `REQUEST_DOM_SNAPSHOT` → 현재 페이지 elements + dom_hash + state_id 반환
- `EXECUTE_ACTION` → 단일 액션 실행
- `USER_CONTINUED` → wait_for_user/await_type/await_select 중인 promise resolve

### DOM 추출
- `getXPath(el)` — `/html/body/.../tag[idx]` 형식
- `extractElements()` — `button, input, select, textarea, a, [role], [aria-label]` 중 visible + meaningful (wrapper 의 leaf 우선)
- `computeDomHash(elements)` — stableSignature 정렬 후 SHA-256 앞 16자. id/aria-label/name/짧고 숫자 없는 텍스트만 시그너처에 포함

### 액션 실행
- `executeOne(action)` — navigate/click/click_text/type/select/scroll/highlight/wait/wait_for_user/site_search/await_*
- `highlightElement(el, holdMs)` — 600ms 펄스 오버레이
- `persistentHighlight(el)` — rAF 추적, await_* 용 영구 펄스. cleanup 함수 반환
- `waitForUserClick(targetEl, timeoutMs)` — `{userClicked, timedOut}`
- `waitForInput(el, suggestedValue, eventName, timeoutMs)` — user 직접 입력 OR "계속" 자동 채움
- `executeSiteSearch(query)` — `SEARCH_INPUT_SELECTORS` 후보 시도 + Enter

## `sidebar/sidebar.js`
DOM ready 후 module 패턴.

### 주요 영역
- Port 연결 (`bench-sidebar` 아님, 그냥 익스텐션 default)
- 메시지 렌더링 (assistant/action/wait/error/complete 버블)
- 진행률 바, 입력창, 빠른 칩
- 헤더 버튼: 대화 내역, 세션 초기화, 설정
- 설정 패널: 엔드포인트 드랍다운 (`planning_endpoint` storage 키) + DB stats/reset
- 대화 내역: `POST /conversations/sessions` → 리스트 → 클릭 시 메시지 로드

### chrome.storage.local 키
- `session_id`, `session_expires_at`
- `known_sessions: string[]`
- `planning_endpoint: "/plan" | "/plan/strict" | "/query"` (기본 `/plan`)
- (`server_url_override` 는 제거됨)
- (`exploration_mode` 는 제거됨)
