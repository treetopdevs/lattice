// Plan 185 judge spike page. Imported only by the VITE_TREEHOUSE_JUDGE_SPIKE=1 build
// (npm run tauri:build:judge-spike); the ordinary and dev-trace builds contain none of it.
// It hands this window to the Popcorn vector judge copied into dist/judge/ at build time. That
// page calls no native command and talks only to the spike harness collector on loopback.
const COLLECTOR = "http://127.0.0.1:47185";

export function openJudgeSpike(): void {
  const params = new URLSearchParams({ collector: COLLECTOR, shellOrigin: String(performance.timeOrigin) });
  const launch = new URLSearchParams(window.location.search).get("launch");
  if (launch !== null) params.set("launch", launch);
  window.location.replace(`/judge/judge.html?${params.toString()}`);
}
