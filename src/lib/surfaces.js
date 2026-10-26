// The surface registry — the ONLY surfaces that may write a tie to
// the table (migration 110, src/lib/onemind.js). Owner law restated
// 2026-10-26: "You're tied to the table the moment you sit down
// anywhere" — a sign-in on any tieable surface seats the account in
// OneMind, whether or not the person ever opens the OneMind app.
//
// KIDS' SURFACES ARE ABSENT BY CONSTRUCTION. Kids' Corner, Little
// Inkers, the Poppy & Ziggy game/show surfaces, and Color With Us
// are NOT in this list — there is no flag, config row, or request
// parameter that can add them. A tie for a kids' surface cannot be
// written because the surface does not exist here. Adding ANY new
// surface is a code change to this file, reviewed like a schema
// change — never a runtime decision, never a client-supplied value
// (recordTie looks the client's string up in this list and refuses
// everything that is not here, kids' names included).
//
// Surface ids are stable contract vocabulary (see
// docs/onemind-signin-contract.md): apps send exactly these strings.
const SURFACES = [
  { id: 'website', name: 'Website', kind: 'web' },
  { id: 'onemind-app', name: 'OneMind app', kind: 'app' },
  { id: 'ai2ai-app', name: 'AI to AI app', kind: 'app' },
  { id: 'tac-app', name: 'Tattoo Art Customs app', kind: 'app' },
  { id: 'tester-hub', name: 'Tester Hub', kind: 'app' },
  { id: 'killintime-console', name: 'KillinTime Console', kind: 'app' },
  { id: 'folder-app', name: 'UsefulAppz Folder', kind: 'app' },
];

const BY_ID = new Map(SURFACES.map((s) => [s.id, s]));

function isTieable(id) {
  return BY_ID.has(String(id || ''));
}

function surface(id) {
  return BY_ID.get(String(id || '')) || null;
}

function list() {
  return SURFACES.slice();
}

module.exports = { SURFACES, isTieable, surface, list };
