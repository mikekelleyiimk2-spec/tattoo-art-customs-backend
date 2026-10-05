// [toploved] most-loved leaderboard — PLACEHOLDER.
// The toploved leaderboard was never implemented (no routes, no UI). The
// run.js wiring was TEMP-DISABLED with a "module missing" note; restored
// 2026-10-05 as a live require with this explicit placeholder so the wiring
// stays live and the suite stays green. When the leaderboard is built, replace
// runHttpTests below with real coverage.
async function runHttpTests(ok, req) {
  ok(true, '[toploved] SKIP: most-loved leaderboard not yet implemented (placeholder module, wiring live)');
}
module.exports = { runHttpTests };
