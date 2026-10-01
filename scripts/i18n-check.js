// i18n key parity check: every key in en.json must exist in all 7 locale
// files, and no locale may carry keys that en.json lacks. Fails loudly
// (non-zero exit) so CI / npm test can gate on it.
const { checkParity, SUPPORTED } = require('../src/i18n');

const problems = checkParity();
if (problems.length) {
  console.error(`i18n parity FAILED — ${problems.length} problem(s):`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
const { translate } = require('../src/i18n');
// Spot-check: interpolation + fallback never throw and never return undefined.
for (const loc of SUPPORTED) {
  const s = translate(loc, 'common.fx_note', { amount: '$1.00' });
  if (typeof s !== 'string' || !s.includes('$1.00')) {
    console.error(`i18n spot-check FAILED for ${loc}`);
    process.exit(1);
  }
}
console.log(`i18n parity OK — ${SUPPORTED.length} locales, all keys present.`);
