// i18n for the Tattoo Art Customs website leg.
//
// Locales: en, de, it, pt-BR, fr, es, sv — the top-10 tattoo countries.
// Detection order: (1) ?hl=<locale> (also sets the tac_locale cookie),
// (2) tac_locale cookie, (3) Accept-Language header mapped to supported
// locales (bare pt -> pt-BR, en-* -> en, everything else -> en).
//
// Money: prices are stored in USD cents. fmtMoney() DISPLAYS them in the
// locale's currency using a static approximate FX table (USD base, Oct 2026
// — refresh periodically). PayPal is the settlement rail and handles real
// FX; fxNote() states the settled USD charge at checkout so nobody is
// surprised. No payment rails were touched.

const fs = require('fs');
const path = require('path');

const SUPPORTED = ['en', 'de', 'it', 'pt-BR', 'fr', 'es', 'sv'];
const NORMALIZED = new Map(SUPPORTED.map((l) => [l.toLowerCase(), l]));

const LOCALE_NAMES = {
  en: 'English',
  de: 'Deutsch',
  it: 'Italiano',
  'pt-BR': 'Português (Brasil)',
  fr: 'Français',
  es: 'Español',
  sv: 'Svenska',
};

// BCP 47 tags for Intl formatting.
const INTL_TAG = {
  en: 'en-US',
  de: 'de-DE',
  it: 'it-IT',
  'pt-BR': 'pt-BR',
  fr: 'fr-FR',
  es: 'es-ES',
  sv: 'sv-SE',
};

// Locale -> display currency. en covers USA/UK/AU/CA: USD display with the
// settled-USD note at checkout (no currency switcher — deliberate scope).
const CURRENCY_FOR = {
  en: 'USD',
  de: 'EUR',
  it: 'EUR',
  'pt-BR': 'BRL',
  fr: 'EUR',
  es: 'EUR',
  sv: 'SEK',
};

// Static FX table, USD base. APPROXIMATE (Oct 2026) — display only.
// PayPal settles in USD at its own rate; refresh these periodically.
const FX_RATES = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  BRL: 5.4,
  CAD: 1.36,
  AUD: 1.52,
  SEK: 10.5,
};

// EU locales get the factual VAT line near prices. en-GB visitors map to the
// en locale but still get the VAT line (detected from the raw header).
const VAT_LOCALES = new Set(['de', 'it', 'fr', 'es', 'sv']);

// ---- Catalog loading -------------------------------------------------------

const catalogs = {};
for (const loc of SUPPORTED) {
  try {
    catalogs[loc] = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'locales', `${loc}.json`), 'utf8')
    );
  } catch (e) {
    catalogs[loc] = {};
  }
}

function lookup(catalog, key) {
  const parts = key.split('.');
  let node = catalog;
  for (const p of parts) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[p];
  }
  return typeof node === 'string' ? node : undefined;
}

// t(key, vars): nested lookup with English fallback, {var} interpolation.
// Returns the key itself if missing everywhere (never throws in a view).
function translate(locale, key, vars) {
  let s = lookup(catalogs[locale], key);
  if (s === undefined) s = lookup(catalogs.en, key);
  if (s === undefined) return key;
  if (vars) {
    s = s.replace(/\{(\w+)\}/g, (m, name) =>
      vars[name] === undefined || vars[name] === null ? m : String(vars[name])
    );
  }
  return s;
}

// ---- Money -----------------------------------------------------------------

function currencyFor(locale) {
  return CURRENCY_FOR[locale] || 'USD';
}

function fmtMoney(locale, usdCents) {
  const currency = currencyFor(locale);
  const rate = FX_RATES[currency] || 1;
  const amount = (Number(usdCents) || 0) / 100 * rate;
  try {
    return new Intl.NumberFormat(INTL_TAG[locale] || 'en-US', {
      style: 'currency',
      currency,
    }).format(amount);
  } catch (e) {
    return `$${(amount).toFixed(2)}`;
  }
}

// USD-formatted amount for the settlement note, e.g. "$125.00".
function fmtUsd(usdCents) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
    .format((Number(usdCents) || 0) / 100);
}

// Settlement note for checkout pages. Empty for USD locales (display ==
// settled there); otherwise states the USD charge + PayPal conversion.
function fxNote(locale, usdCents) {
  if (currencyFor(locale) === 'USD') return '';
  return translate(locale, 'common.fx_note', { amount: fmtUsd(usdCents) });
}

function fmtNum(locale, n) {
  try {
    return new Intl.NumberFormat(INTL_TAG[locale] || 'en-US').format(Number(n) || 0);
  } catch (e) {
    return String(n);
  }
}

// "3d left" / "5h left" / "12m left" — time unit stays compact, word translated.
function fmtLeft(locale, ms) {
  if (ms == null) return '';
  const h = Math.floor(ms / 3600000);
  let time;
  if (h < 1) time = `${Math.max(1, Math.floor(ms / 60000))}m`;
  else if (h < 48) time = `${h}h`;
  else time = `${Math.floor(h / 24)}d`;
  return translate(locale, 'contests.time_left', { time });
}

// ---- Locale detection ------------------------------------------------------

function normalizeLocale(input) {
  if (!input) return null;
  const key = String(input).trim().toLowerCase();
  if (NORMALIZED.has(key)) return NORMALIZED.get(key);
  // Bare language fallbacks: pt -> pt-BR, en-* -> en, etc.
  const bare = key.split('-')[0];
  if (bare === 'pt') return 'pt-BR';
  if (NORMALIZED.has(bare)) return NORMALIZED.get(bare);
  return null;
}

function parseAcceptLanguage(header) {
  const out = [];
  let enGb = false;
  if (!header) return { locales: out, enGb };
  for (const part of String(header).split(',')) {
    const [range, ...params] = part.trim().split(';');
    const tag = range.trim().toLowerCase();
    if (!tag || tag === '*') continue;
    if (tag === 'en-gb' || tag === 'en_gb') enGb = true;
    let q = 1;
    for (const p of params) {
      const m = p.trim().match(/^q=([0-9.]+)$/);
      if (m) q = parseFloat(m[1]);
    }
    const loc = normalizeLocale(tag);
    if (loc && !out.includes(loc)) out.push({ loc, q });
  }
  out.sort((a, b) => b.q - a.q);
  return { locales: out.map((e) => e.loc), enGb };
}

function detectLocale(req) {
  // 1. ?hl=<locale> — also persists to the tac_locale cookie.
  if (req.query && req.query.hl) {
    const loc = normalizeLocale(req.query.hl);
    if (loc) return { locale: loc, fromQuery: true, enGb: false };
  }
  // 2. Cookie.
  if (req.cookies && req.cookies.tac_locale) {
    const loc = normalizeLocale(req.cookies.tac_locale);
    if (loc) return { locale: loc, fromQuery: false, enGb: false };
  }
  // 3. Accept-Language.
  const { locales, enGb } = parseAcceptLanguage(req.headers && req.headers['accept-language']);
  if (locales.length) return { locale: locales[0], fromQuery: false, enGb };
  return { locale: 'en', fromQuery: false, enGb };
}

// ---- Middleware ------------------------------------------------------------

function i18nMiddleware(req, res, next) {
  const { locale, fromQuery, enGb } = detectLocale(req);
  if (fromQuery) {
    res.cookie('tac_locale', locale, {
      maxAge: 365 * 24 * 3600 * 1000,
      httpOnly: false, // readable client-side; not a secret
      sameSite: 'lax',
    });
  }
  const vatApplies = VAT_LOCALES.has(locale) || enGb;
  const t = (key, vars) => translate(locale, key, vars);

  res.locals.t = t;
  res.locals.locale = locale;
  res.locals.localeTag = INTL_TAG[locale];
  res.locals.localeName = LOCALE_NAMES[locale];
  res.locals.supportedLocales = SUPPORTED;
  res.locals.localeNames = LOCALE_NAMES;
  res.locals.fmtMoney = (usdCents) => fmtMoney(locale, usdCents);
  res.locals.fmtNum = (n) => fmtNum(locale, n);
  res.locals.fmtLeft = (ms) => fmtLeft(locale, ms);
  res.locals.fxNote = (usdCents) => fxNote(locale, usdCents);
  res.locals.vatApplies = vatApplies;
  res.locals.vatNote = vatApplies ? t('common.vat_note') : '';
  // Back-compat: legacy `money` helper stays USD for untranslated views.
  next();
}

// ---- Key parity check (scripts/i18n-check.js + tests) ----------------------

function keySet(obj, prefix, out) {
  out = out || new Set();
  for (const k of Object.keys(obj || {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (obj[k] && typeof obj[k] === 'object') keySet(obj[k], p, out);
    else out.add(p);
  }
  return out;
}

function checkParity() {
  const base = keySet(catalogs.en);
  const problems = [];
  for (const loc of SUPPORTED) {
    if (loc === 'en') continue;
    const ks = keySet(catalogs[loc]);
    for (const k of base) if (!ks.has(k)) problems.push(`${loc}: missing key ${k}`);
    for (const k of ks) if (!base.has(k)) problems.push(`${loc}: extra key ${k} (not in en)`);
  }
  return problems;
}

module.exports = {
  SUPPORTED,
  LOCALE_NAMES,
  CURRENCY_FOR,
  FX_RATES,
  i18nMiddleware,
  translate,
  fmtMoney,
  fmtUsd,
  fxNote,
  fmtNum,
  fmtLeft,
  detectLocale,
  normalizeLocale,
  checkParity,
};
