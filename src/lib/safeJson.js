// Safe JSON serialization for embedding values inside <script> blocks
// (JSON-LD, inline config). Plain JSON.stringify can emit "</script>" when a
// value contains it, letting attacker-controlled strings break out of the
// script element and execute (stored XSS). Escaping <, >, & (plus U+2028/29)
// keeps the output valid JSON while making breakout impossible.
function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

module.exports = { safeJson };
