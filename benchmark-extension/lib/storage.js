// ============================================================
// 케이스/결과 로컬 저장.
//   - chrome.downloads 로 JSON 파일을 ~/Downloads/<prefix>/<sub>/ 아래에 떨군다.
//   - 사용자가 import 할 때는 panel 에서 <input type=file webkitdirectory> 로 폴더 선택.
//
// service worker 에서만 동작 — content script 에선 chrome.downloads 권한이 없다.
// ============================================================

const CFG = self.EEUM_BENCH_CONFIG;

function isoSlug(ts) {
  // 2026-05-19T13:24:55.000Z → 20260519-132455
  return ts
    .replace(/[-:T]/g, "")
    .replace(/\..*$/, "")
    .replace(/Z$/, "");
}

function buildPath(subdir, filename) {
  const prefix = (CFG.DOWNLOAD_PREFIX || "eeum-bench").replace(/^\/+|\/+$/g, "");
  return [prefix, subdir, filename].filter(Boolean).join("/");
}

async function downloadJSON(subdir, filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  // service worker 에서는 URL.createObjectURL 이 안 됨 → data: URL 사용.
  const text = await blob.text();
  const dataUrl =
    "data:application/json;charset=utf-8," + encodeURIComponent(text);

  const id = await chrome.downloads.download({
    url: dataUrl,
    filename: buildPath(subdir, filename),
    conflictAction: "overwrite",
    saveAs: false,
  });
  return id;
}

export async function saveCase(caseObj) {
  const slug = isoSlug(caseObj.captured_at || new Date().toISOString());
  const safeSite = (caseObj.site || "unknown").replace(/[^a-z0-9.-]/gi, "_");
  const filename = `${slug}_${safeSite}_${caseObj.case_id.slice(0, 8)}.json`;
  return downloadJSON("cases", filename, caseObj);
}

export async function saveRun(runObj) {
  const slug = isoSlug(runObj.started_at || new Date().toISOString());
  const filename = `${slug}_${runObj.mode}_${runObj.run_id.slice(0, 8)}.json`;
  return downloadJSON("runs", filename, runObj);
}

export async function saveSnapshot(prefix, snapshotObj) {
  const slug = isoSlug(new Date().toISOString());
  const filename = `${slug}_${prefix}.json`;
  return downloadJSON("snapshots", filename, snapshotObj);
}
