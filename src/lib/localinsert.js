// Dawnfold — "Your Local" insert (owner order 2026-10-28).
//
// The publication's local page: every reader's paper carries one page
// for where they actually are. The house default locality is
// Abbeville, Louisiana — the hometown the paper is printed from — and
// a signed-in reader who picks their own town gets that row saved in
// user_localities (migration 117), so the page follows them to every
// device. Guests keep their pick on-device only (the client JS holds
// it in localStorage); this module never sees a guest.
//
// Location honesty, same as the World Weather app:
// - Places come from Open-Meteo geocoding, typed by the reader.
// - Device location is taken ONLY on a tap (the client JS asks
//   navigator.geolocation from a button handler, never on load) and
//   reverse-labeled via BigDataCloud's client API.
// - Weather comes from Open-Meteo, fetched live; on any failure the
//   caller gets null and the page says so — numbers are never
//   fabricated to fill the line.
//
// Every exported function fails soft: DB and network errors return
// null / [] instead of throwing into a page render.
const db = require('../db');

const HOUSE_LOCALITY = {
  label: 'Abbeville, Louisiana',
  name: 'Abbeville',
  region: 'Louisiana',
  country: 'United States',
  lat: 29.9746,
  lon: -92.1553,
  isHouse: true,
};

const FETCH_TIMEOUT_MS = 3500;
const WEATHER_CACHE_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

function cleanText(v, max) {
  if (v == null) return '';
  return String(v).trim().slice(0, max || 200);
}

function isValidLat(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90;
}
function isValidLon(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180;
}

// One fetch with a hard timeout; returns parsed JSON or null.
async function fetchJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function placeLabel(name, region, country) {
  const parts = [];
  for (const p of [name, region, country]) {
    const s = cleanText(p, 120);
    if (s && !parts.includes(s)) parts.push(s);
  }
  return parts.join(', ');
}

// ---------------------------------------------------------------------
// Saved locality (user_localities, one row per user)
// ---------------------------------------------------------------------

function rowToLocality(row) {
  if (!row) return null;
  const lat = Number(row.lat);
  const lon = Number(row.lon);
  if (!isValidLat(lat) || !isValidLon(lon)) return null;
  const label = cleanText(row.label, 120);
  if (!label) return null;
  return {
    label,
    name: cleanText(row.name, 120),
    region: cleanText(row.region, 120),
    country: cleanText(row.country, 120),
    lat,
    lon,
    isHouse: false,
  };
}

async function getUserLocality(userId) {
  try {
    if (userId == null || String(userId).trim() === '') return null;
    const row = await db.get(
      'SELECT label, name, region, country, lat, lon FROM user_localities WHERE user_id = ?',
      [String(userId)]);
    return rowToLocality(row);
  } catch (e) {
    return null;
  }
}

async function saveUserLocality(userId, place) {
  try {
    if (userId == null || String(userId).trim() === '') return null;
    if (!place || typeof place !== 'object') return null;
    const lat = Number(place.lat);
    const lon = Number(place.lon);
    if (!isValidLat(lat) || !isValidLon(lon)) return null;
    const label = cleanText(place.label, 120);
    if (!label || label.length > 120) return null;
    const saved = {
      label,
      name: cleanText(place.name, 120),
      region: cleanText(place.region, 120),
      country: cleanText(place.country, 120),
      lat,
      lon,
      isHouse: false,
    };
    const uid = String(userId);
    const now = Date.now();
    const existing = await db.get(
      'SELECT id FROM user_localities WHERE user_id = ?', [uid]);
    if (existing) {
      await db.update('user_localities', existing.id, {
        label: saved.label,
        name: saved.name,
        region: saved.region,
        country: saved.country,
        lat: saved.lat,
        lon: saved.lon,
        updated_at: now,
      });
    } else {
      await db.insert('user_localities', {
        user_id: uid,
        label: saved.label,
        name: saved.name,
        region: saved.region,
        country: saved.country,
        lat: saved.lat,
        lon: saved.lon,
        created_at: now,
        updated_at: now,
      });
    }
    return saved;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------
// Place search — Open-Meteo geocoding (typed by the reader)
// ---------------------------------------------------------------------

async function searchPlaces(query) {
  try {
    const q = cleanText(query, 120);
    if (q.length < 2) return [];
    const url = 'https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&format=json&name='
      + encodeURIComponent(q);
    const data = await fetchJson(url);
    const list = (data && Array.isArray(data.results)) ? data.results : [];
    const out = [];
    for (const r of list) {
      if (!r) continue;
      const lat = Number(r.latitude);
      const lon = Number(r.longitude);
      if (!isValidLat(lat) || !isValidLon(lon)) continue;
      const name = cleanText(r.name, 120);
      if (!name) continue;
      const region = cleanText(r.admin1, 120);
      const country = cleanText(r.country, 120);
      out.push({
        label: placeLabel(name, region, country),
        name,
        region,
        country,
        lat,
        lon,
      });
    }
    return out;
  } catch (e) {
    return [];
  }
}

// ---------------------------------------------------------------------
// Local weather — Open-Meteo forecast, plain language, 10-min cache
// ---------------------------------------------------------------------

// WMO weather codes (0-99) → short plain-language phrases, in the
// paper's voice: what a reader would say looking out the window.
const WMO_TEXT = {
  0: 'clear',
  1: 'mostly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'patchy fog',
  48: 'patchy fog with frost',
  51: 'light drizzle',
  53: 'drizzle',
  55: 'steady drizzle',
  56: 'freezing drizzle',
  57: 'freezing drizzle',
  61: 'light rain',
  63: 'rain likely',
  65: 'heavy rain',
  66: 'freezing rain',
  67: 'freezing rain',
  71: 'light snow',
  73: 'snow',
  75: 'heavy snow',
  77: 'snow grains',
  80: 'light showers',
  81: 'showers',
  82: 'heavy showers',
  85: 'snow showers',
  86: 'snow showers',
  95: 'thunderstorms',
  96: 'thunderstorms with hail',
  99: 'thunderstorms with hail',
};

function codeText(code) {
  const n = Number(code);
  if (Number.isFinite(n) && Object.prototype.hasOwnProperty.call(WMO_TEXT, n)) {
    return WMO_TEXT[n];
  }
  return 'fair';
}

function roundOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// Open-Meteo returns sunrise/sunset as local ISO strings
// ("2026-10-28T07:19"); render the clock part the way the paper
// prints it ("7:19 AM"). Anything unparseable passes through as-is.
function fmtClock(iso) {
  if (iso == null) return null;
  const s = String(iso);
  const m = s.match(/T(\d{2}):(\d{2})/);
  if (!m) return s;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return h + ':' + min + ' ' + ampm;
}

const weatherCache = new Map(); // "lat,lon" (2dp) -> { at, data }

async function getLocalWeather(lat, lon) {
  try {
    const la = Number(lat);
    const lo = Number(lon);
    if (!isValidLat(la) || !isValidLon(lo)) return null;
    const key = la.toFixed(2) + ',' + lo.toFixed(2);
    const hit = weatherCache.get(key);
    if (hit && (Date.now() - hit.at) < WEATHER_CACHE_TTL_MS) return hit.data;

    const url = 'https://api.open-meteo.com/v1/forecast'
      + '?latitude=' + encodeURIComponent(la)
      + '&longitude=' + encodeURIComponent(lo)
      + '&current=temperature_2m,weather_code'
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max'
      + '&temperature_unit=fahrenheit&timezone=auto&forecast_days=2';
    const data = await fetchJson(url);
    if (!data || !data.current || !data.daily) return null;

    const daily = data.daily;
    const at = (arr, i) => (Array.isArray(arr) && arr.length > i ? arr[i] : null);
    const rain = at(daily.precipitation_probability_max, 0);
    const out = {
      nowTempF: roundOrNull(data.current.temperature_2m),
      nowText: codeText(data.current.weather_code),
      todayHighF: roundOrNull(at(daily.temperature_2m_max, 0)),
      todayLowF: roundOrNull(at(daily.temperature_2m_min, 0)),
      todayText: codeText(at(daily.weather_code, 0)),
      sunrise: fmtClock(at(daily.sunrise, 0)),
      sunset: fmtClock(at(daily.sunset, 0)),
      rainChancePct: rain == null ? null : roundOrNull(rain),
      tomorrowHighF: roundOrNull(at(daily.temperature_2m_max, 1)),
      tomorrowLowF: roundOrNull(at(daily.temperature_2m_min, 1)),
      tomorrowText: codeText(at(daily.weather_code, 1)),
      fetchedAt: new Date().toISOString(),
    };
    // A row with no usable numbers at all is a failure, not a forecast.
    if (out.nowTempF == null && out.todayHighF == null) return null;
    weatherCache.set(key, { at: Date.now(), data: out });
    return out;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------
// Brief slots — the insert's structured local slots, as data.
// Honest by construction: the briefs slot is a founding/open slot.
// The desk fills it as local coverage opens; nothing here invents
// local news, events, or people for a town the desk doesn't cover yet.
// ---------------------------------------------------------------------

function briefSlots(locality) {
  const loc = (locality && typeof locality === 'object') ? locality : HOUSE_LOCALITY;
  const name = cleanText(loc.name, 120)
    || cleanText(loc.label, 120)
    || HOUSE_LOCALITY.name;
  const label = cleanText(loc.label, 120) || HOUSE_LOCALITY.label;
  return [
    {
      kind: 'weather',
      title: name + ' weather',
      state: 'live',
      note: 'Live weather for ' + label + ' rides at the top of this insert — fetched fresh from Open-Meteo on each edition refresh.',
    },
    {
      kind: 'sky',
      title: 'Sky over ' + name,
      state: 'live',
      note: 'Sunrise and sunset for ' + label + ' ride with the weather line above, so the day here is planned by the light here.',
    },
    {
      kind: 'briefs',
      title: name + ' briefs',
      state: 'open',
      note: 'A founding slot — open. The desk fills ' + name + ' briefs as local coverage opens here; until then this space stays honestly open, with no invented local news.',
    },
  ];
}

module.exports = {
  HOUSE_LOCALITY,
  getUserLocality,
  saveUserLocality,
  searchPlaces,
  getLocalWeather,
  briefSlots,
};
