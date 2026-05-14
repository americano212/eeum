# eeum eval

`/plan` 응답의 **액션 시퀀스 정확도**를 자동으로 측정한다.
프롬프트를 수정했을 때 회귀가 나는지 즉시 확인하기 위함.

## 구조

```
eval/
├── datasets/
│   ├── static/      # (query, DOM 스냅샷, expected) JSON — 결정적
│   └── dynamic/     # Playwright 시나리오 YAML — 실제 사이트
├── runners/
│   ├── static_runner.py    # /plan 호출 + 룰 기반 매칭
│   ├── llm_judge.py        # 의미적 동등성 LLM 판정
│   └── dynamic_runner.py   # Playwright로 실제 실행
├── metrics.py       # 집계 + 마크다운/콘솔 리포트
└── run_eval.py      # 메인 엔트리포인트
```

## 평가 레이어

| 레이어 | 입력 | 검증 | 비용 | 사이트 변경에 |
|--------|------|------|------|---------------|
| **정적 룰 매칭** | 합성 DOM + query | xpath/action 매칭 규칙 | OpenAI 호출 1회/케이스 | 영향 없음 |
| **LLM-as-Judge** | + 정적 응답 | 의미적 동등성 판정 | OpenAI 호출 2회/케이스 | 영향 없음 |
| **동적 (Playwright)** | 실제 URL + query | 최종 페이지 URL/텍스트 | OpenAI 호출 N회 + 브라우저 | 깨질 수 있음 |

## 빠른 시작

### 1) 서버 띄워두고 정적 평가

```bash
cd server
docker compose up -d
python -m eval.run_eval --static
```

### 2) 서버 없이 (인-프로세스, CI 친화적)

```bash
cd server
export OPENAI_API_KEY=sk-...
python -m eval.run_eval --static --mode inproc
```

### 3) LLM-as-Judge 추가

```bash
python -m eval.run_eval --static --judge
```

### 4) 전체 평가 + 리포트 저장

```bash
python -m eval.run_eval \
  --static --judge --dynamic \
  --n-runs 3 \
  --report report.md \
  --raw raw.json
```

`--n-runs 3` 은 같은 입력을 3회 호출해서 OpenAI 응답의 비결정성을 측정한다.

### 5) Playwright 동적 평가만

```bash
python -m playwright install chromium     # 처음 1회만
python -m eval.run_eval --dynamic --headed
```

## 골든 데이터셋 작성

### 정적 (`datasets/static/*.json`)

```json
{
  "id": "naver_login",
  "description": "...",
  "query": "로그인하고 싶어",
  "url": "https://www.naver.com",
  "elements": [
    { "tag": "a", "text": "NAVER 로그인", "xpath": "/...", "href": "..." }
  ],
  "expected": {
    "needs_more_elements": false,
    "acceptable_action_sequences": [
      [{ "type": "click", "xpath": "/..." }],
      [{ "type": "navigate", "url_contains": "nid.naver.com" }]
    ],
    "must_not_click_xpaths": [],
    "must_highlight_only": []
  }
}
```

지원하는 `expected` 규칙:

| 키 | 설명 |
|---|---|
| `needs_more_elements` | 응답 플래그가 이 값과 일치해야 함 |
| `max_actions` | 액션 개수 상한 |
| `must_not_click_xpaths` | 해당 xpath 직접 클릭 금지 |
| `must_highlight_only` | 해당 xpath는 highlight만 (click 없이) |
| `must_contain_action_type` | 시퀀스에 이 타입 액션이 하나 이상 |
| `must_contain_action_with_xpath` | 시퀀스에 이 xpath 액션이 하나 이상 |
| `must_not_type_in_xpaths` | type 액션 금지 (비밀번호 등) |
| `must_highlight_or_wait_for_user_around` | 안전 처리 위임 확인 |
| `first_action_must_match` | 첫 액션 조건 매칭 |
| `acceptable_action_sequences` | 정답 시퀀스 후보 — 하나라도 prefix-match 하면 통과 |

`acceptable_action_sequences` 안의 각 액션 조건은 다음 키를 지원:
`type`, `xpath`, `url`, `url_contains`, `url_must_contain_query`, `value_contains`.

### 동적 (`datasets/dynamic/*.yaml`)

```yaml
id: scenario_id
description: "..."
start_url: https://...
query: "..."
success:
  url_contains: target.com    # 최종 URL이 포함하면 성공
  text_visible: "...어떤 텍스트..."   # (선택)
max_steps: 5
```

## 프롬프트 튜닝 워크플로

1. `services/llm.py` 의 `SYSTEM_PROMPT` 수정
2. `python -m eval.run_eval --static --judge --n-runs 3 --report before.md` (수정 전 기준점은 main에서 미리 한 번)
3. 새 프롬프트로 같은 명령 실행 → `after.md`
4. case별 pass-rate 차이 확인
5. 회귀가 나면 새 케이스를 `datasets/static/` 에 추가해서 재현 → 프롬프트 다시 수정 → 반복

## CI

`.github/workflows/eval.yml` 가 PR에서 자동으로 정적 평가를 돌리고 결과를 PR 코멘트로 남긴다. 임계치(`--threshold 0.8`) 미만이면 빨간불.

동적 평가는 비용·시간이 크니 수동 트리거(`workflow_dispatch`) 한정.

## 종료 코드

| 코드 | 의미 |
|---|---|
| 0 | 모든 케이스 통과 (case pass-rate ≥ `--threshold`) |
| 1 | 임계치 미달 — CI에서 빨간불 |
| 2 | 실행 자체 실패 (OpenAI 키 누락 등) |

## 한계

- OpenAI 응답은 비결정적. `--n-runs` 로 N회 평균을 봐야 안정적.
- 동적 평가는 사이트 DOM 변경에 깨질 수 있음. 정기적으로 시나리오 정비 필요.
- 합성 DOM은 실제 페이지의 노이즈(광고, 모달 등)를 반영하지 않음 — 그래서 동적 평가가 따로 필요.
