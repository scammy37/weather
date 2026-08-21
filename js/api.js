/* =============================================================================
   api.js — Open-Meteo data access.

   Everything the dashboard shows is fetched live from Open-Meteo's free,
   key-less, CORS-enabled endpoints:

     api.open-meteo.com          current conditions, hourly + 7-day forecast
     archive-api.open-meteo.com  ERA5 reanalysis, 1940→present (the normals)
     marine-api.open-meteo.com   sea-surface temperature and wave data
     air-quality-api.open-meteo.com  AQI and particulates

   Design notes
   ------------
   * Every request is retried with exponential backoff and an abort timeout.
   * Archive pulls are chunked by decade so one bad window cannot sink the
     whole climatology, and so progress can be reported.
   * "Extended" daily variables (humidity, dew point, cloud cover, pressure)
     were added to the archive API later than the core set. They are requested
     separately: if that request fails the dashboard still renders everything
     else instead of showing an empty page.
   * Aggregated results — never the raw multi-megabyte day arrays — are cached
     in localStorage, which keeps the store comfortably under quota.
   =========================================================================== */

const API = {
  forecast: 'https://api.open-meteo.com/v1/forecast',
  archive:  'https://archive-api.open-meteo.com/v1/archive',
  marine:   'https://marine-api.open-meteo.com/v1/marine',
  air:      'https://air-quality-api.open-meteo.com/v1/air-quality'
};

const UNITS = 'temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch';

/* --- diagnostics -------------------------------------------------------- */
/* Every call lands here so the Data Sources panel can show exactly what
   succeeded, what failed and how long it took. */
const DIAG = [];
function diagStart(label, url) {
  const entry = { label, url, status: 'pending', t0: performance.now(), ms: null, note: '' };
  DIAG.push(entry);
  if (typeof onDiagUpdate === 'function') onDiagUpdate();
  return entry;
}
function diagEnd(entry, status, note = '') {
  entry.status = status;
  entry.ms = Math.round(performance.now() - entry.t0);
  entry.note = note;
  if (typeof onDiagUpdate === 'function') onDiagUpdate();
}

/* --- low-level fetch ---------------------------------------------------- */
async function apiGet(url, { label = 'request', retries = 3, timeout = 45000 } = {}) {
  const entry = diagStart(label, url);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(600 * 2 ** (attempt - 1));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) {
        /* Open-Meteo reports bad parameters as JSON {error:true, reason:"..."}.
           Surface that reason — it is far more useful than "400". */
        let reason = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j && j.reason) reason = j.reason; } catch (_) {}
        throw new Error(reason);
      }
      const json = await res.json();
      if (json && json.error) throw new Error(json.reason || 'API error');
      diagEnd(entry, 'ok', attempt ? `succeeded on retry ${attempt}` : '');
      return json;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      /* A rejected parameter will be rejected again — do not burn retries. */
      const msg = String(err && err.message || err);
      if (/cannot be|not supported|invalid|unknown|out of|allowed/i.test(msg)) break;
    }
  }
  diagEnd(entry, 'fail', String(lastErr && lastErr.message || lastErr));
  throw lastErr;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* --- variable sets ------------------------------------------------------ */
const ARCHIVE_CORE = [
  'weather_code',
  'temperature_2m_max', 'temperature_2m_min', 'temperature_2m_mean',
  'apparent_temperature_max', 'apparent_temperature_min',
  'daylight_duration', 'sunshine_duration',
  'precipitation_sum', 'rain_sum', 'snowfall_sum', 'precipitation_hours',
  'wind_speed_10m_max', 'wind_gusts_10m_max', 'wind_direction_10m_dominant',
  'shortwave_radiation_sum', 'et0_fao_evapotranspiration'
];

const ARCHIVE_EXT = [
  'relative_humidity_2m_mean', 'dew_point_2m_mean',
  'cloud_cover_mean', 'pressure_msl_mean', 'wind_speed_10m_mean'
];

/* -----------------------------------------------------------------------------
   LIVE FEED — current conditions, 48 hourly steps, 7 daily.
   --------------------------------------------------------------------------- */
async function fetchLive(loc) {
  const q = new URLSearchParams({
    latitude: loc.lat, longitude: loc.lon, timezone: loc.tz, forecast_days: '7', past_days: '2'
  });
  const current = [
    'temperature_2m','relative_humidity_2m','apparent_temperature','is_day','precipitation',
    'rain','showers','snowfall','weather_code','cloud_cover','pressure_msl','surface_pressure',
    'wind_speed_10m','wind_direction_10m','wind_gusts_10m'
  ].join(',');
  const hourly = [
    'temperature_2m','relative_humidity_2m','dew_point_2m','apparent_temperature',
    'precipitation_probability','precipitation','weather_code','cloud_cover','visibility',
    'wind_speed_10m','wind_gusts_10m','wind_direction_10m','uv_index','is_day'
  ].join(',');
  const daily = [
    'weather_code','temperature_2m_max','temperature_2m_min',
    'apparent_temperature_max','apparent_temperature_min','sunrise','sunset',
    'daylight_duration','sunshine_duration','uv_index_max','precipitation_sum','rain_sum',
    'showers_sum','snowfall_sum','precipitation_hours','precipitation_probability_max',
    'wind_speed_10m_max','wind_gusts_10m_max','wind_direction_10m_dominant'
  ].join(',');

  const url = `${API.forecast}?${q}&current=${current}&hourly=${hourly}&daily=${daily}&${UNITS}`;
  return apiGet(url, { label: `Live forecast — ${loc.name}`, timeout: 20000 });
}

/* -----------------------------------------------------------------------------
   AIR QUALITY — optional; failure degrades to a hidden panel.
   --------------------------------------------------------------------------- */
async function fetchAir(loc) {
  const url = `${API.air}?latitude=${loc.lat}&longitude=${loc.lon}&timezone=${loc.tz}`
            + `&current=us_aqi,pm10,pm2_5,ozone,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide`
            + `&hourly=us_aqi&forecast_days=3`;
  return apiGet(url, { label: `Air quality — ${loc.name}`, retries: 1, timeout: 15000 });
}

/* -----------------------------------------------------------------------------
   LIVE MARINE — sea-surface temperature and waves at the offshore point.
   --------------------------------------------------------------------------- */
async function fetchMarineLive(loc) {
  const m = loc.marine;
  const url = `${API.marine}?latitude=${m.lat}&longitude=${m.lon}&timezone=${loc.tz}`
            + `&current=sea_surface_temperature,wave_height,wave_period,wave_direction`
            + `&hourly=sea_surface_temperature,wave_height,wave_period`
            + `&daily=wave_height_max,wave_period_max,wave_direction_dominant`
            + `&forecast_days=7&${UNITS}&length_unit=imperial`;
  return apiGet(url, { label: `Live marine — ${m.body}`, retries: 2, timeout: 20000 });
}

/* -----------------------------------------------------------------------------
   ARCHIVE — ERA5 daily history, chunked by decade.
   `onProgress(done, total, label)` drives the loading bar.
   --------------------------------------------------------------------------- */
function decadeChunks(start, end) {
  const chunks = [];
  let y0 = +start.slice(0, 4);
  const yEnd = +end.slice(0, 4);
  while (y0 <= yEnd) {
    const y1 = Math.min(y0 + 9, yEnd);
    chunks.push({
      start: y0 === +start.slice(0, 4) ? start : `${y0}-01-01`,
      end:   y1 === yEnd ? end : `${y1}-12-31`
    });
    y0 = y1 + 1;
  }
  return chunks;
}

/* Merges the per-chunk `daily` objects into one continuous series. */
function mergeDaily(parts) {
  const out = {};
  for (const p of parts) {
    if (!p || !p.daily) continue;
    for (const [k, v] of Object.entries(p.daily)) {
      if (!Array.isArray(v)) continue;
      (out[k] || (out[k] = [])).push(...v);
    }
  }
  return out;
}

async function fetchArchive(loc, period, onProgress) {
  const p = PERIODS[period];
  const chunks = decadeChunks(p.start, p.end);
  const total = chunks.length * 2;
  let done = 0;
  const bump = label => { done++; if (onProgress) onProgress(done, total, label); };

  const base = ({ start, end }, vars) =>
    `${API.archive}?latitude=${loc.lat}&longitude=${loc.lon}&timezone=${loc.tz}`
    + `&start_date=${start}&end_date=${end}&daily=${vars.join(',')}&${UNITS}`;

  /* Core variables — required. Chunks run sequentially to stay polite to the
     free tier and to keep the progress bar honest. */
  const coreParts = [];
  for (const c of chunks) {
    coreParts.push(await apiGet(base(c, ARCHIVE_CORE), {
      label: `Archive ${c.start.slice(0,4)}–${c.end.slice(0,4)} — ${loc.name}`, timeout: 60000
    }));
    bump(`${loc.short}: ${c.start.slice(0, 4)}–${c.end.slice(0, 4)}`);
  }

  /* Extended variables — best effort. */
  const extParts = [];
  let extOk = true;
  for (const c of chunks) {
    if (!extOk) { bump(`${loc.short}: extended skipped`); continue; }
    try {
      extParts.push(await apiGet(base(c, ARCHIVE_EXT), {
        label: `Archive extended ${c.start.slice(0,4)}–${c.end.slice(0,4)} — ${loc.name}`,
        retries: 1, timeout: 60000
      }));
    } catch (_) {
      extOk = false;   // one rejection means the whole variable set is unsupported
    }
    bump(`${loc.short}: extended ${c.start.slice(0, 4)}–${c.end.slice(0, 4)}`);
  }

  const daily = mergeDaily(coreParts);
  if (extOk && extParts.length) {
    const ext = mergeDaily(extParts);
    /* Only splice in extended series that line up with the core timeline. */
    for (const [k, v] of Object.entries(ext)) {
      if (k !== 'time' && v.length === daily.time.length) daily[k] = v;
    }
  }
  return { daily, extended: extOk && extParts.length > 0, meta: coreParts[0] || {} };
}

/* -----------------------------------------------------------------------------
   MARINE ARCHIVE — sea-surface temperature climatology.

   Daily SST aggregates are not documented for every marine model, so the daily
   form is attempted first and the hourly form is used as a fallback. Both are
   reduced to per-day means before returning, so downstream code sees one shape.
   --------------------------------------------------------------------------- */
async function fetchMarineArchive(loc, onProgress) {
  const m = loc.marine;
  const y0 = +SST_PERIOD.start.slice(0, 4), y1 = +SST_PERIOD.end.slice(0, 4);
  const years = [];
  for (let y = y0; y <= y1; y++) years.push(y);

  const url = (y, daily, hourly) => {
    let u = `${API.marine}?latitude=${m.lat}&longitude=${m.lon}&timezone=${loc.tz}`
          + `&start_date=${y}-01-01&end_date=${y}-12-31&${UNITS}&length_unit=imperial`;
    if (daily)  u += `&daily=${daily}`;
    if (hourly) u += `&hourly=${hourly}`;
    return u;
  };

  const DAILY_VARS  = 'sea_surface_temperature_mean,sea_surface_temperature_max,sea_surface_temperature_min,wave_height_max';
  const HOURLY_VARS = 'sea_surface_temperature,wave_height';

  /* Probe one year to decide which shape this deployment supports. */
  let useDaily = true;
  try {
    await apiGet(url(y1, DAILY_VARS, null), { label: `Marine daily probe — ${m.body}`, retries: 0, timeout: 25000 });
  } catch (_) {
    useDaily = false;
  }

  const rows = [];   // { date, mean, max, min, wave }
  let ok = 0;
  for (const y of years) {
    try {
      if (useDaily) {
        const j = await apiGet(url(y, DAILY_VARS, null), { label: `Marine ${y} — ${m.body}`, retries: 1, timeout: 40000 });
        const d = j.daily || {};
        (d.time || []).forEach((t, i) => rows.push({
          date: t,
          mean: num(d.sea_surface_temperature_mean?.[i]),
          max:  num(d.sea_surface_temperature_max?.[i]),
          min:  num(d.sea_surface_temperature_min?.[i]),
          wave: num(d.wave_height_max?.[i])
        }));
      } else {
        const j = await apiGet(url(y, 'wave_height_max', HOURLY_VARS), { label: `Marine ${y} — ${m.body}`, retries: 1, timeout: 60000 });
        rows.push(...hourlyToDaily(j));
      }
      ok++;
    } catch (_) { /* a missing year just narrows the sample */ }
    if (onProgress) onProgress(ok, years.length, `${m.body} ${y}`);
  }
  return { rows, years: ok, mode: useDaily ? 'daily' : 'hourly' };
}

/* Collapse hourly marine data into per-day mean / max / min. */
function hourlyToDaily(json) {
  const h = json.hourly || {}, d = json.daily || {};
  const buckets = new Map();
  (h.time || []).forEach((t, i) => {
    const day = t.slice(0, 10);
    let b = buckets.get(day);
    if (!b) buckets.set(day, b = { sum: 0, n: 0, max: -Infinity, min: Infinity, wSum: 0, wN: 0 });
    const v = num(h.sea_surface_temperature?.[i]);
    if (v != null) { b.sum += v; b.n++; if (v > b.max) b.max = v; if (v < b.min) b.min = v; }
    const w = num(h.wave_height?.[i]);
    if (w != null) { b.wSum += w; b.wN++; }
  });
  const waveMax = new Map();
  (d.time || []).forEach((t, i) => waveMax.set(t, num(d.wave_height_max?.[i])));
  return [...buckets.entries()].map(([date, b]) => ({
    date,
    mean: b.n ? b.sum / b.n : null,
    max:  b.n ? b.max : null,
    min:  b.n ? b.min : null,
    wave: waveMax.has(date) ? waveMax.get(date) : (b.wN ? b.wSum / b.wN : null)
  }));
}

const num = v => (v === null || v === undefined || Number.isNaN(v)) ? null : +v;

/* -----------------------------------------------------------------------------
   CACHE — aggregated climatology only, versioned and time-limited.
   --------------------------------------------------------------------------- */
const CACHE_VERSION = 'wx-v1';
const CACHE_TTL_MS  = 30 * 24 * 3600 * 1000;   // normals move slowly

function cacheKey(kind, locId, extra = '') { return `${CACHE_VERSION}:${kind}:${locId}:${extra}`; }

function cacheGet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || !o.t || Date.now() - o.t > CACHE_TTL_MS) { localStorage.removeItem(key); return null; }
    return o.v;
  } catch (_) { return null; }
}

function cacheSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: value }));
    return true;
  } catch (_) {
    /* Quota exceeded or storage disabled — the dashboard works without it. */
    try { clearOurCache(); localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: value })); return true; }
    catch (__) { return false; }
  }
}

function clearOurCache() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(CACHE_VERSION + ':')) keys.push(k);
    }
    keys.forEach(k => localStorage.removeItem(k));
    return keys.length;
  } catch (_) { return 0; }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { API, apiGet, fetchLive, fetchAir, fetchMarineLive, fetchArchive,
                     fetchMarineArchive, decadeChunks, mergeDaily, hourlyToDaily,
                     ARCHIVE_CORE, ARCHIVE_EXT, DIAG, cacheGet, cacheSet, cacheKey, clearOurCache };
}
