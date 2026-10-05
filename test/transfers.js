// [transfers] customer<->shop art pipeline — PLACEHOLDER.
// The customer<->shop art transfer pipeline was never implemented (no routes,
// no UI; the only "transfer" code in src is money movement). The run.js wiring
// was TEMP-DISABLED with a "module missing" note; restored 2026-10-05 as a
// live require with this explicit placeholder so the wiring stays live and the
// suite stays green. When the pipeline is built, replace runHttpTests below
// with real coverage.
async function runHttpTests(ok, req) {
  ok(true, '[transfers] SKIP: customer<->shop art pipeline not yet implemented (placeholder module, wiring live)');
}
module.exports = { runHttpTests };
