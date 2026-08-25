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
  alerts:   'https://api.weather.gov/alerts/active',
  archive:  'https://archive-api.open-meteo.com/v1/archive',
  marine:   'https://marine-api.open-meteo.com/v1/marine',
  air:      'https://air-quality-api.open-meteo.com/v1/air-quality'
};

const UNITS = 'temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch';

/* Which archive model to prefer, or null for Open-Meteo's default (ERA5).

   ERA5-Land was tried here on the theory that its finer ~5.6 mile land-only
   grid would fix a suspected coastal warm-season bias. Measured against NOAA
   station normals over the identical 1991–2020 window, it did not: ERA5 was
   closer on daily highs at two of the three homes (+0.4°F vs −1.2°F at North
   Myrtle Beach), and ERA5-Land returned NO precipitation or snowfall at all,
   which silently wiped the rain and snow charts.

   ERA5 is now named explicitly rather than left to Open-Meteo's default.
   The default is a best-match selection, and it does not always resolve to the
   model the validation measured: at North Myrtle Beach the default gave an
   86.0°F July high for 2016–2025 while explicit era5 gave 87.6°F for the
   COOLER 1991–2020 window, against a NOAA normal of 87.4°F. A more recent
   decade reading 1.6°F colder is not warming; it is a different model. Naming
   the model makes the published figures the ones the bias numbers describe.

   scripts/validate-climate.mjs re-measures both models on every rebuild; if
   ERA5-Land ever wins, this is the one line to change. */
const ARCHIVE_MODEL = 'era5';
const MIN_COVERAGE = 0.8;

/* Variables a model must actually deliver before its data is accepted.
   Checking temperature alone is what let ERA5-Land through with empty
   precipitation: the highs looked perfect and the rain charts were blank. */
const REQUIRED_COVERAGE = ['temperature_2m_max', 'temperature_2m_min',
                           'precipitation_sum', 'snowfall_sum'];

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

/* Open-Meteo answers an exceeded quota with HTTP 429 and a reason naming the
   window ("Minutely API request limit exceeded"). That is not a transient
   blip: retrying in a second guarantees another rejection, so it gets its own
   much longer backoff, and its own error type so the UI can explain it. */
const RATE_LIMIT_RE = /limit exceeded|rate.?limit|too many requests|quota/i;
function isRateLimit(status, reason) {
  return status === 429 || RATE_LIMIT_RE.test(String(reason || ''));
}
class RateLimitError extends Error {
  constructor(reason, window) { super(reason); this.name = 'RateLimitError'; this.window = window; }
}
function limitWindow(reason) {
  const r = String(reason || '').toLowerCase();
  if (r.includes('minute')) return 'minute';
  if (r.includes('hour'))   return 'hour';
  if (r.includes('day') || r.includes('daily')) return 'day';
  return 'unknown';
}

/* --- request pacing ------------------------------------------------------
   A global minimum gap between requests. The browser never needs this — it
   makes a handful of calls — but the precompute script does: Open-Meteo caps
   weighted calls per minute as well as per hour, and a 10-year archive chunk
   is worth ~444 of a 600/minute allowance, so two cannot share a minute.

   Enforcing it here rather than in the caller means every request is covered,
   including the chunks inside fetchArchive and the per-year marine pulls,
   which a caller-side sleep silently missed. */
let PACE_MS = 0, lastRequestAt = 0;
function setPacing(ms) { PACE_MS = Math.max(0, ms | 0); }
async function awaitSlot() {
  if (!PACE_MS) return;
  const wait = lastRequestAt + PACE_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

/* --- low-level fetch ---------------------------------------------------- */
async function apiGet(url, { label = 'request', retries = 3, timeout = 45000 } = {}) {
  const entry = diagStart(label, url);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      /* A minute-window rejection needs to wait out the minute; anything else
         is a normal transient and a short backoff is right. */
      const wait = lastErr instanceof RateLimitError && lastErr.window === 'minute'
        ? 62000 : 600 * 2 ** (attempt - 1);
      await sleep(wait);
    }
    await awaitSlot();
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
        if (isRateLimit(res.status, reason)) throw new RateLimitError(reason, limitWindow(reason));
        throw new Error(reason);
      }
      const json = await res.json();
      if (json && json.error) {
        if (isRateLimit(0, json.reason)) throw new RateLimitError(json.reason, limitWindow(json.reason));
        throw new Error(json.reason || 'API error');
      }
      diagEnd(entry, 'ok', attempt ? `succeeded on retry ${attempt}` : '');
      return json;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      /* A rejected parameter will be rejected again — do not burn retries.
         An hour or day quota likewise will not clear within a retry loop. */
      const msg = String(err && err.message || err);
      if (err instanceof RateLimitError && err.window !== 'minute') break;
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
   SEVERE WEATHER ALERTS — US National Weather Service.

   Free, no key, CORS-enabled, and the authoritative source for watches and
   warnings. Three properties on two coasts and one inland is exactly the case
   where a hurricane watch or a freeze warning matters and nobody is standing
   at the window to notice.

   Failure is non-fatal: no alerts panel rather than no dashboard.
   --------------------------------------------------------------------------- */
async function fetchAlerts(loc) {
  const url = `${API.alerts}?point=${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}&status=actual`;
  const json = await apiGet(url, { label: `Weather alerts — ${loc.name}`, retries: 1, timeout: 15000 });
  const feats = (json && json.features) || [];
  return feats.map(f => {
    const p = (f && f.properties) || {};
    return {
      id: f.id || p.id,
      event: p.event || 'Alert',
      severity: p.severity || 'Unknown',      // Extreme | Severe | Moderate | Minor | Unknown
      urgency: p.urgency || '',
      certainty: p.certainty || '',
      headline: p.headline || '',
      description: p.description || '',
      instruction: p.instruction || '',
      onset: p.onset || p.effective || null,
      expires: p.expires || p.ends || null,
      sender: p.senderName || ''
    };
  })
  /* Most severe first, so the worst thing is the thing you read. */
  .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

const SEVERITY_RANK = ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'];
/* An unrecognised severity must sort LAST, not first. Bare indexOf returns -1
   for anything off the list, and -1 sorts ahead of Extreme (index 0) — so a
   garbled or newly-invented severity would outrank a hurricane warning and be
   the headline. Unknown ranks below Minor and truly unknown ranks below that. */
function severityRank(sev) {
  const i = SEVERITY_RANK.indexOf(sev);
  return i === -1 ? SEVERITY_RANK.length : i;
}

/* -----------------------------------------------------------------------------
   BACKUP SOURCE 1 — National Weather Service current observations.

   Open-Meteo is a model; this is a thermometer at a nearby airport. It is used
   when the forecast API fails, and is always available as a cross-check, so a
   single provider outage does not blank the page.

   Three chained calls (point → stations → latest observation), so it is only
   attempted on demand rather than on every load.
   --------------------------------------------------------------------------- */
async function fetchNWSObservation(loc) {
  const pt = await apiGet(`https://api.weather.gov/points/${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`,
    { label: `NWS grid point — ${loc.name}`, retries: 1, timeout: 15000 });
  const stationsUrl = pt && pt.properties && pt.properties.observationStations;
  if (!stationsUrl) throw new Error('no observation stations for this point');

  const st = await apiGet(stationsUrl, { label: `NWS stations — ${loc.name}`, retries: 1, timeout: 15000 });
  const first = st && st.features && st.features[0];
  if (!first) throw new Error('station list was empty');

  const obs = await apiGet(`${first.id}/observations/latest`,
    { label: `NWS observation — ${first.properties.stationIdentifier}`, retries: 1, timeout: 15000 });
  const p = (obs && obs.properties) || {};

  /* NWS reports SI with an explicit unitCode per field, so each value is
     converted from what it declares rather than from an assumption. */
  const val = (o, conv) => (o && o.value != null) ? conv(o.value, o.unitCode) : null;
  return {
    source: 'NWS',
    station: first.properties.stationIdentifier,
    stationName: first.properties.name,
    time: p.timestamp || null,
    temperature_2m: val(p.temperature, toFahrenheit),
    apparent_temperature: val(p.heatIndex, toFahrenheit) ?? val(p.windChill, toFahrenheit)
                       ?? val(p.temperature, toFahrenheit),
    relative_humidity_2m: p.relativeHumidity && p.relativeHumidity.value != null
      ? Math.round(p.relativeHumidity.value) : null,
    dew_point_2m: val(p.dewpoint, toFahrenheit),
    wind_speed_10m: val(p.windSpeed, toMph),
    wind_gusts_10m: val(p.windGust, toMph),
    wind_direction_10m: p.windDirection && p.windDirection.value != null ? p.windDirection.value : null,
    pressure_msl: val(p.barometricPressure, toInHg),
    visibility_mi: val(p.visibility, toMiles),
    description: p.textDescription || ''
  };
}

/* -----------------------------------------------------------------------------
   BACKUP SOURCE 2 — NOAA CO-OPS water temperature.

   A physical sensor on a tide gauge, as opposed to the marine model's grid
   cell. Where both are available the page shows the measurement and treats the
   model as corroboration, because for "can I swim in it" a thermometer beats
   an interpolation.
   --------------------------------------------------------------------------- */
async function fetchWaterTempNOAA(loc) {
  const station = loc.marine && loc.marine.coopsStation;
  if (!station) throw new Error('no tide station configured');
  const url = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter'
    + `?product=water_temperature&station=${station}&date=latest`
    + '&units=english&time_zone=lst_ldt&format=json&application=tri-state-weather-dashboard';
  const j = await apiGet(url, { label: `NOAA water temp — ${loc.marine.coopsName}`, retries: 1, timeout: 15000 });
  if (j && j.error) throw new Error(j.error.message || 'station returned an error');
  const row = j && j.data && j.data[0];
  const v = row ? parseFloat(row.v) : NaN;
  if (!Number.isFinite(v)) throw new Error('no reading returned');
  /* units=english means Fahrenheit; a wild value means the sensor is faulty
     rather than that the water is. */
  if (v < 25 || v > 105) throw new Error(`implausible reading ${v}°F`);
  return { source: 'NOAA CO-OPS', station, name: loc.marine.coopsName, tempF: v, time: row.t || null };
}

/* USGS instantaneous values, parameter 00010 — water temperature.

   NOAA's tide-gauge network is not the only one in the water. USGS runs inlet
   and tidal-creek gauges that CO-OPS does not, and at Point Pleasant the
   difference is decisive: the nearest CO-OPS sensor is Sandy Hook, 26 miles
   north inside Raritan Bay, while USGS 01408048 sits 1.4 miles away at the
   Manasquan inlet and reports every fifteen minutes. Checking one network and
   concluding "nobody measures this" was the mistake; the search is in
   scripts/investigate-coops.mjs and covers CO-OPS, NDBC and USGS. */
async function fetchWaterTempUSGS(loc) {
  const site = loc.marine && loc.marine.usgsStation;
  if (!site) throw new Error('no USGS site configured');
  const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${site}`
            + '&parameterCd=00010&siteStatus=active';
  const j = await apiGet(url, { label: `USGS water temp — ${loc.marine.usgsName}`, retries: 1, timeout: 15000 });
  const ts = j && j.value && j.value.timeSeries && j.value.timeSeries[0];
  const row = ts && ts.values && ts.values[0] && ts.values[0].value && ts.values[0].value[0];
  const c = row ? parseFloat(row.value) : NaN;
  if (!Number.isFinite(c) || c < -50) throw new Error('no reading returned');
  const v = c * 9 / 5 + 32;                     // USGS reports 00010 in Celsius
  if (v < 25 || v > 105) throw new Error(`implausible reading ${v.toFixed(1)}°F`);
  /* A gauge that stopped reporting years ago still answers this endpoint with
     its last value, which would read as today's water temperature. */
  const age = row.dateTime ? (Date.now() - Date.parse(row.dateTime)) / 3600000 : Infinity;
  if (!(age < 48)) throw new Error(`last reading is ${Math.round(age)}h old`);
  return { source: 'USGS', station: site, name: loc.marine.usgsName, tempF: v, time: row.dateTime || null };
}

/* Whichever network this home's gauge belongs to. */
async function fetchWaterTemp(loc) {
  return (loc.marine && loc.marine.usgsStation)
    ? fetchWaterTempUSGS(loc)
    : fetchWaterTempNOAA(loc);
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

/* Fraction of a series that is a real number — used to reject a model that
   answers with mostly nulls rather than an error. */
function coverage(arr) {
  if (!Array.isArray(arr) || !arr.length) return 0;
  let n = 0;
  for (const v of arr) if (typeof v === 'number' && Number.isFinite(v)) n++;
  return n / arr.length;
}

async function fetchArchive(loc, period, onProgress) {
  const p = PERIODS[period];
  const chunks = decadeChunks(p.start, p.end);
  const total = chunks.length * 2;
  let done = 0;
  const bump = label => { done++; if (onProgress) onProgress(done, total, label); };

  const base = ({ start, end }, vars, model) =>
    `${API.archive}?latitude=${loc.lat}&longitude=${loc.lon}&timezone=${loc.tz}`
    + `&start_date=${start}&end_date=${end}&daily=${vars.join(',')}&${UNITS}`
    + (model ? `&models=${model}` : '');

  /* Core variables — required. Chunks run sequentially to stay polite to the
     free tier and to keep the progress bar honest. */
  const coreParts = [];
  let model = ARCHIVE_MODEL, modelNote = ARCHIVE_MODEL;
  for (const c of chunks) {
    const label = `Archive ${c.start.slice(0,4)}–${c.end.slice(0,4)} — ${loc.name}`;
    let part = null;
    if (model) {
      try {
        part = await apiGet(base(c, ARCHIVE_CORE, model), { label: `${label} [${model}]`, retries: 1, timeout: 60000 });
        /* Every required variable is checked, not just temperature: a model
           that answers with perfect highs and no precipitation at all must be
           rejected, not accepted with blank rain charts. */
        const thin = REQUIRED_COVERAGE
          .map(k => [k, coverage(part.daily && part.daily[k])])
          .filter(([, cov]) => cov < MIN_COVERAGE);
        if (thin.length) {
          part = null;
          model = null;
          modelNote = `${ARCHIVE_MODEL} rejected — `
            + thin.map(([k, cov]) => `${k} ${Math.round(cov * 100)}% covered`).join(', ')
            + ' — using the default model';
        }
      } catch (_) {
        model = null;
        modelNote = `${ARCHIVE_MODEL} unavailable — using the default model`;
      }
    }
    if (!part) part = await apiGet(base(c, ARCHIVE_CORE, null), { label, timeout: 60000 });
    coreParts.push(part);
    bump(`${loc.short}: ${c.start.slice(0, 4)}–${c.end.slice(0, 4)}`);
  }

  /* Extended variables — best effort.

     These are requested on the SAME model as the core variables wherever
     possible: sunny days come from cloud cover here while temperatures come
     from the core request, and two different models behind one month's row
     would be a silent inconsistency nobody could see on the page.

     But "best effort" has to mean it: cloud cover and mean sea-level pressure
     are not fields every reanalysis carries, and a named model that quietly
     answers with empty arrays would blank the humidity, cloud and pressure
     charts — the exact failure ERA5-Land caused for precipitation. So a thin
     or failed response falls back to the API's default model rather than
     dropping the variables. */
  const extParts = [];
  let extOk = true, extModel = model, extNote = '';
  for (const c of chunks) {
    if (!extOk) { bump(`${loc.short}: extended skipped`); continue; }
    const label = `Archive extended ${c.start.slice(0,4)}–${c.end.slice(0,4)} — ${loc.name}`;
    let part = null;
    if (extModel) {
      try {
        part = await apiGet(base(c, ARCHIVE_EXT, extModel), {
          label: `${label} [${extModel}]`, retries: 1, timeout: 60000 });
        const thin = ARCHIVE_EXT
          .map(k => [k, coverage(part.daily && part.daily[k])])
          .filter(([, cov]) => cov < MIN_COVERAGE);
        if (thin.length) {
          part = null;
          extNote = `extended on ${extModel} rejected (${thin.map(([k]) => k).join(', ')}) — using the default model`;
          extModel = null;
        }
      } catch (_) {
        extNote = `extended on ${extModel} unavailable — using the default model`;
        extModel = null;
      }
    }
    if (!part) {
      try {
        part = await apiGet(base(c, ARCHIVE_EXT, null), { label, retries: 1, timeout: 60000 });
      } catch (_) {
        extOk = false;   // one rejection means the whole variable set is unsupported
      }
    }
    if (part) extParts.push(part);
    bump(`${loc.short}: extended ${c.start.slice(0, 4)}–${c.end.slice(0, 4)}`);
  }
  if (extNote) modelNote = modelNote ? `${modelNote}; ${extNote}` : extNote;

  const daily = mergeDaily(coreParts);
  if (extOk && extParts.length) {
    const ext = mergeDaily(extParts);
    /* Only splice in extended series that line up with the core timeline. */
    for (const [k, v] of Object.entries(ext)) {
      if (k !== 'time' && v.length === daily.time.length) daily[k] = v;
    }
  }
  return { daily, extended: extOk && extParts.length > 0, meta: coreParts[0] || {},
           model: model || 'default', modelNote };
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
  module.exports = { API, apiGet, setPacing, coverage, ARCHIVE_MODEL, SEVERITY_RANK, severityRank,
                     RateLimitError, isRateLimit, limitWindow, fetchAlerts, fetchLive,
                     fetchNWSObservation, fetchWaterTempNOAA, fetchWaterTempUSGS, fetchWaterTemp, fetchAir, fetchMarineLive, fetchArchive,
                     fetchMarineArchive, decadeChunks, mergeDaily, hourlyToDaily,
                     ARCHIVE_CORE, ARCHIVE_EXT, DIAG, cacheGet, cacheSet, cacheKey, clearOurCache };
}
