// ============================================================
// eeum 서버 호출 헬퍼.
// service worker / panel 둘 다에서 사용.
// ============================================================

const CFG = self.EEUM_BENCH_CONFIG;

function baseUrl() {
  return CFG.SERVER_URL.replace(/\/+$/, "");
}

async function postJSON(path, body) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function callPlan({ query, currentUrl, currentElements }) {
  return postJSON("/plan", {
    query,
    current_url: currentUrl,
    current_elements: currentElements,
  });
}

export async function callBaseline({ query, url, elements, history }) {
  return postJSON("/baseline", {
    query,
    url,
    elements,
    history: history || null,
  });
}

export async function callJudge({ query, groundTruth, systemResponse, postDomSummary }) {
  return postJSON("/judge", {
    query,
    ground_truth: groundTruth,
    system_response: systemResponse,
    post_dom_summary: postDomSummary || null,
  });
}

export async function callDomCheck({ stateId, url, domHash }) {
  return postJSON("/dom/check", {
    state_id: stateId,
    url,
    dom_hash: domHash,
  });
}

export async function callDomUpload(payload) {
  return postJSON("/dom/upload", payload);
}
