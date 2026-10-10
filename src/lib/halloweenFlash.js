// Halloween flash-day sale (owner-confirmed 2026-10-09).
//
// Timed site sale: 2026-10-09 through 2026-10-31 11:59:59 PM America/Chicago.
// - 31 featured flash designs at $70 ready-made. Best-deal-wins: the standing
//   Saturday-night $50 sale still beats it when both windows overlap — the
//   buyer always pays the lower price, never stacked.
// - Custom designs at $120 full / $60 deposit during the window (best-deal-wins
//   against member_20 / first_custom_20, which are both higher).
// - Standard 48-hour delivery (STANDARD_SLA_HOURS, unchanged).
//
// Server-side enforcement: isHalloweenFlashWindow() gates pricing
// (pricing.js, firstCustom.js, orders.js) AND the /halloween-flash page.
// The client countdown is display-only and never trusted for pricing.
const HALLOWEEN_FLASH_START_ISO = '2026-10-09T00:00:00-05:00';
const HALLOWEEN_FLASH_END_ISO = '2026-10-31T23:59:59-05:00';
const HALLOWEEN_FLASH_PREMADE_CENTS = 7000; // $70 ready-made
const HALLOWEEN_FLASH_CUSTOM_CENTS = 12000; // $120 custom full
const HALLOWEEN_FLASH_DISCOUNT_CODE = 'halloween_flash';

// The 31 featured flash designs (original Halloween-themed gallery pieces;
// watermarked linework previews live in assets/designs/linework-wm/).
const HALLOWEEN_FLASH_DESIGN_IDS = [
  'batch17-carved-stone-gargoyle',
  'batch-ascii-haunted',
  'batch-ascii-owl',
  'batch-ascii-raven',
  'batch-ascii-skull',
  'batch-ascii-tombstone',
  'batch-circuitbloom-owl',
  'batch-cover-skull',
  'batch-pixelated-ghost',
  'batch-pixelated-skull',
  'batch10-p4b2-biomech-raven',
  'batch10-p4b2-celticnorse-ravens',
  'batch10-p4b2-chicano-bandana-skull',
  'batch10-p4b2-chicano-reaper',
  'batch10-p4b2-chicano-sugar-skull',
  'batch10-p4b2-polynesian-owl',
  'batch11-p4b3-pinup-sugar-skull',
  'batch12-p4b4-dino-dino-skull',
  'batch12-p4b4-fire-skull',
  'batch12-p4b4-wings-bat',
  'batch12-p4b4-wings-owl',
  'batch16-sketch-raven',
  'batch17-blackwork-raven',
  'batch17-dark-surrealism-skull',
  'batch17-graffiti-graffiti-skull',
  'batch17-neo-traditional-owl',
  'batch11-p4b3-pinup-devil',
  'batch6-black-cat',
  'batch7-g5-spider',
  'batch8-monster-phantom',
  'batch5-cute-demon',
];

const FLASH_SET = new Set(HALLOWEEN_FLASH_DESIGN_IDS);

function isHalloweenFlashWindow(date = new Date()) {
  const t = date.getTime();
  return t >= new Date(HALLOWEEN_FLASH_START_ISO).getTime() &&
    t <= new Date(HALLOWEEN_FLASH_END_ISO).getTime();
}

function isFlashDesign(id) {
  return FLASH_SET.has(String(id || ''));
}

module.exports = {
  HALLOWEEN_FLASH_START_ISO,
  HALLOWEEN_FLASH_END_ISO,
  HALLOWEEN_FLASH_PREMADE_CENTS,
  HALLOWEEN_FLASH_CUSTOM_CENTS,
  HALLOWEEN_FLASH_DISCOUNT_CODE,
  HALLOWEEN_FLASH_DESIGN_IDS,
  isHalloweenFlashWindow,
  isFlashDesign,
};
