/* Unit tests for the climatology aggregation. Run: node test/unit.mjs */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const cfg = require('../js/config.js');
globalThis.MONTHS = cfg.MONTHS; globalThis.MONTHS_FULL = cfg.MONTHS_FULL;
const solar = require('../js/solar.js');
const { aggregateMonthly, mergeSST, annualSummary } = require('../js/climate.js');

let pass = 0, fail = 0;
const near = (a, b, tol = 1e-6) => a !== null && b !== null && Math.abs(a - b) <= tol;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, got, want, tol = 1e-6) { ok(name, near(got, want, tol), `got ${got}, want ${want}`); }

/* ---- synthetic builder --------------------------------------------------
   Every day of 2023 + 2024 gets deterministic values so each aggregate has a
   hand-checkable expected answer.                                           */
function synth(years = [2023, 2024]) {
  const d = { time: [], temperature_2m_max: [], temperature_2m_min: [], temperature_2m_mean: [],
    apparent_temperature_max: [], apparent_temperature_min: [],
    daylight_duration: [], sunshine_duration: [], precipitation_sum: [], rain_sum: [],
    snowfall_sum: [], precipitation_hours: [], wind_speed_10m_max: [], wind_gusts_10m_max: [],
    wind_speed_10m_mean: [], shortwave_radiation_sum: [], et0_fao_evapotranspiration: [],
    relative_humidity_2m_mean: [], dew_point_2m_mean: [], cloud_cover_mean: [], pressure_msl_mean: [] };
  for (const y of years) for (let mo = 0; mo < 12; mo++) {
    const dim = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    for (let day = 1; day <= dim; day++) {
      d.time.push(`${y}-${String(mo + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
      d.temperature_2m_max.push(mo === 0 ? 40 : 80);
      d.temperature_2m_min.push(mo === 0 ? 20 : 60);
      d.temperature_2m_mean.push(mo === 0 ? 30 : 70);
      d.apparent_temperature_max.push(mo === 0 ? 35 : 88);
      d.apparent_temperature_min.push(mo === 0 ? 12 : 58);
      d.daylight_duration.push(36000);                       // 10 h daylight
      /* Jan: every day sunny (80%). Feb: alternating sunny / cloudy. */
      d.sunshine_duration.push(mo === 0 ? 28800 : (mo === 1 ? (day % 2 ? 28800 : 3600) : 18000));
      d.precipitation_sum.push(mo === 0 ? 0.5 : (mo === 1 ? (day % 2 ? 0 : 1.5) : 0.01));
      d.rain_sum.push(mo === 0 ? 0.2 : (mo === 1 ? (day % 2 ? 0 : 1.5) : 0.01));
      d.snowfall_sum.push(mo === 0 ? 1.0 : 0);
      d.precipitation_hours.push(mo === 0 ? 2 : 0);
      d.wind_speed_10m_max.push(20); d.wind_gusts_10m_max.push(30); d.wind_speed_10m_mean.push(10);
      d.shortwave_radiation_sum.push(18);                    // MJ/m² → 5 kWh/m²
      d.et0_fao_evapotranspiration.push(0.1);
      d.relative_humidity_2m_mean.push(70); d.dew_point_2m_mean.push(50);
      /* Sky cover drives the sunny/partly/cloudy split. Jan clear, Feb split
         by odd/even day, Mar solidly partly cloudy. */
      d.cloud_cover_mean.push(mo === 0 ? 10 : (mo === 1 ? (day % 2 ? 5 : 90) : 55));
      d.pressure_msl_mean.push(1016);
    }
  }
  return d;
}

console.log('\n\x1b[1maggregateMonthly — rate metrics\x1b[0m');
const sunClim = solar.monthlySunClimatology(33.816, -78.68, 'America/New_York');
const rows = aggregateMonthly(synth(), sunClim);
ok('returns 12 rows', rows && rows.length === 12, `got ${rows && rows.length}`);
const jan = rows[0], feb = rows[1], mar = rows[2];
eq('Jan avg high', jan.avgHigh, 40);
eq('Jan avg low', jan.avgLow, 20);
eq('Jan avg mean', jan.avgMean, 30);
eq('Jan diurnal swing', jan.diurnal, 20);
eq('Mar avg high', mar.avgHigh, 80);
eq('Jan feels-like high', jan.apparentHigh, 35);
eq('Jan record high', jan.recordHigh, 40);
eq('Jan record low', jan.recordLow, 20);
eq('Jan sun hours/day (28800 s)', jan.sunHours, 8);
eq('Jan % of possible sun (8/10 h)', jan.pctSun, 80);
eq('solar kWh/m² (18 MJ ÷ 3.6)', jan.solarKwh, 5);
eq('Jan mean wind', jan.windSpeed, 10);
eq('Jan peak gust', jan.windGust, 30);
eq('Jan humidity', jan.humidity, 70);
eq('Jan cloud cover', jan.cloudCover, 10);
eq('Jan pressure inHg (1016 hPa)', jan.pressure, 1016 * 0.02953, 1e-6);

console.log('\n\x1b[1maggregateMonthly — total metrics (per-year sums, averaged)\x1b[0m');
eq('Jan precip total (31 × 0.5)', jan.precipTotal, 15.5, 1e-9);
eq('Jan rainfall only (31 × 0.2)', jan.rainfall, 6.2, 1e-9);
eq('Jan snowfall (31 × 1.0)', jan.snowfall, 31);
eq('Jan snow days', jan.snowDays, 31);
eq('Jan wet days (0.5 ≥ 0.04)', jan.wetDays, 31);
eq('Jan heavy-rain days (0.5 < 1.0)', jan.heavyRainDays, 0);
eq('Jan dry days', jan.dryDays, 0);
eq('Jan precip hours (31 × 2)', jan.precipHours, 62);
eq('Feb wet days (even days: 14 in 2023, 14 in 2024)', feb.wetDays, 14);
eq('Feb heavy-rain days (1.5 ≥ 1.0)', feb.heavyRainDays, 14);
eq('Feb precip total (14 × 1.5)', feb.precipTotal, 21, 1e-9);
eq('Mar wet days (0.01 < 0.04)', mar.wetDays, 0);
eq('Mar dry days (all 31)', mar.dryDays, 31);

console.log('\n\x1b[1msunny / partly / cloudy classification\x1b[0m');
/* Classified by CLOUD COVER on the published convention — 0-3 tenths clear,
   4-7 partly, 8-10 cloudy — not by sunshine duration. ERA5's sunshine is
   generous enough that the old definition put Bonita Springs at 317 sunny days
   a year against 14.7 cloudy ones, which is not a climate that exists. */
eq('Jan sunny days (10% cloud ≤ 30)', jan.sunnyDays, 31);
eq('Jan cloudy days', jan.cloudyDays, 0);
/* 2023 Feb has 28 days (14 odd), 2024 Feb has 29 (15 odd) → mean 14.5.
   The half-day is the leap year showing through, and is correct. */
eq('Feb sunny days (5% cloud on odd days)', feb.sunnyDays, 14.5);
eq('Feb cloudy days (90% cloud ≥ 80)', feb.cloudyDays, 14);
eq('Mar partly days (55% cloud, between the two)', mar.partlyDays, 31);
ok('the split came from cloud cover, not the sunshine fallback',
   jan.skyFromSunshine === 0, String(jan.skyFromSunshine));

/* The boundaries themselves, since "sunny" is a claim a reader will check. */
{
  const edge = synth([2023]);
  edge.cloud_cover_mean = edge.time.map(() => 30);   // exactly clear
  const r0 = aggregateMonthly(edge, sunClim);
  eq('30% cloud counts as clear, not partly', r0[0].sunnyDays, 31);
  edge.cloud_cover_mean = edge.time.map(() => 31);
  eq('31% does not', aggregateMonthly(edge, sunClim)[0].sunnyDays, 0);
  edge.cloud_cover_mean = edge.time.map(() => 80);
  eq('80% cloud counts as cloudy', aggregateMonthly(edge, sunClim)[0].cloudyDays, 31);
  edge.cloud_cover_mean = edge.time.map(() => 79);
  eq('79% is still partly', aggregateMonthly(edge, sunClim)[0].partlyDays, 31);
}

/* Cloud cover is an extended variable and can be absent on its own. */
{
  const noCloud = synth([2023]);
  noCloud.cloud_cover_mean = noCloud.time.map(() => null);
  const r1 = aggregateMonthly(noCloud, sunClim)[0];
  ok('with no cloud cover the split falls back to sunshine rather than vanishing',
     r1.sunnyDays != null && r1.sunnyDays > 0, String(r1.sunnyDays));
  eq('and the fallback is reported in full', r1.skyFromSunshine, 1);
}
ok('sunny + partly + cloudy = mean days in month (28.5 with leap year)',
   near(feb.sunnyDays + feb.partlyDays + feb.cloudyDays, 28.5, 1e-9),
   `${feb.sunnyDays}+${feb.partlyDays}+${feb.cloudyDays}`);
ok('Feb sample spans both years', feb.sampleYears === 2, `${feb.sampleYears}`);

console.log('\n\x1b[1mthreshold and degree-day metrics\x1b[0m');
eq('Jan days ≤ 32°F (low 20)', jan.freeze32, 31);
eq('Jan days ≤ 20°F', jan.freeze20, 31);
eq('Mar days ≥ 90°F (high 80)', mar.hot90, 0);
eq('Jan HDD (31 × (65−30))', jan.hdd, 31 * 35);
eq('Jan CDD', jan.cdd, 0);
eq('Mar CDD (31 × (70−65))', mar.cdd, 31 * 5);
eq('Mar GDD (31 × (70−50))', mar.gdd, 31 * 20);
eq('Jan GDD (mean 30 < base 50)', jan.gdd, 0);
eq('Mar ET₀ (31 × 0.1)', mar.et0, 3.1, 1e-9);
eq('Mar pleasant days (high 80, low 60, dry)', mar.pleasantDays, 31);
eq('Jan pleasant days (too cold)', jan.pleasantDays, 0);
eq('Mar beach days (high 80, dry, 50% sun)', mar.beachDays, 31);

console.log('\n\x1b[1mpartial-month guard\x1b[0m');
const partial = synth([2023]);
/* Append a 5-day fragment of Jan 2024 — too short to count as a month. */
for (let day = 1; day <= 5; day++) {
  partial.time.push(`2024-01-0${day}`);
  for (const k of Object.keys(partial)) if (k !== 'time') partial[k].push(k === 'precipitation_sum' ? 0 : 1);
}
const pRows = aggregateMonthly(partial, sunClim);
eq('Jan still averages one full year only', pRows[0].sampleYears, 1);
eq('Jan precip unaffected by the 5-day fragment', pRows[0].precipTotal, 15.5, 1e-9);
ok('fragment days still counted in the rate sample', pRows[0].sampleDays === 36, `got ${pRows[0].sampleDays}`);

console.log('\n\x1b[1msun-and-sky merge\x1b[0m');
ok('Jan daylight populated from solar.js', jan.daylight > 9 && jan.daylight < 11, `${jan.daylight}`);
ok('Jun daylight longer than Dec', rows[5].daylight > rows[11].daylight,
   `${rows[5].daylight} vs ${rows[11].daylight}`);
ok('sunrise minutes in range', jan.sunriseMin > 300 && jan.sunriseMin < 500, `${jan.sunriseMin}`);
ok('sunset after sunrise', jan.sunsetMin > jan.sunriseMin);

console.log('\n\x1b[1mmergeSST\x1b[0m');
const sst = [];
for (const y of [2023, 2024]) for (let mo = 0; mo < 12; mo++) for (let d = 1; d <= 28; d++)
  sst.push({ date: `${y}-${String(mo+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`,
             mean: 60 + mo, max: 62 + mo, min: 58 + mo, wave: 3 });
mergeSST(rows, sst);
eq('Jan SST mean', rows[0].sst, 60);
eq('Jul SST mean', rows[6].sst, 66);
eq('Jan SST max', rows[0].sstMax, 62);
eq('wave height', rows[0].waveHeight, 3);

console.log('\n\x1b[1mannualSummary\x1b[0m');
const ann = annualSummary(rows);
eq('annual snow = Jan only', ann.annualSnow, 31);
ok('warmest month is not January', ann.warmest.month !== 0, `month ${ann.warmest.month}`);
ok('coldest month is January', ann.coldest.month === 0, `month ${ann.coldest.month}`);
ok('wettest month is February (21 in)', ann.wettest.month === 1, `month ${ann.wettest.month}`);
ok('snowiest month is January', ann.snowiest.month === 0);
ok('warmest ocean is December (60+11)', ann.warmestOcean.month === 11);
ok('longest day in June', ann.longestDay.month === 5, `month ${ann.longestDay.month}`);
eq('annual precip = sum of months', ann.annualPrecip,
   rows.reduce((s, r) => s + r.precipTotal, 0), 1e-6);

console.log('\n\x1b[1mnull-safety\x1b[0m');
const sparse = aggregateMonthly({ time: ['2023-01-01'], temperature_2m_max: [50] }, sunClim);
ok('handles a single day without throwing', Array.isArray(sparse) && sparse.length === 12);
ok('missing series yield null, not NaN', sparse[0].humidity === null, `${sparse[0].humidity}`);
ok('empty input returns null', aggregateMonthly({ time: [] }, sunClim) === null);

console.log('\n\x1b[1mfrostStats\x1b[0m');
const { frostStats, yearlySeries, trendPerDecade, doyToLabel, dayOfYear } = require('../js/climate.js');

/* A climate that freezes reliably: lows below 32 up to 20 March and again from
   10 November, every year. */
function frostSynth(years, springDoy, fallDoy) {
  const d = { time: [], temperature_2m_min: [], temperature_2m_max: [],
              temperature_2m_mean: [], precipitation_sum: [], snowfall_sum: [],
              sunshine_duration: [], daylight_duration: [] };
  for (const y of years) for (let doy = 1; doy <= 365; doy++) {
    const dt = new Date(Date.UTC(y, 0, 1) + (doy - 1) * 86400000);
    d.time.push(dt.toISOString().slice(0, 10));
    const freezing = springDoy != null && (doy <= springDoy || doy >= fallDoy);
    d.temperature_2m_min.push(freezing ? 25 : 50);
    d.temperature_2m_max.push(freezing ? 40 : 80);
    d.temperature_2m_mean.push(freezing ? 32 : 65);
    d.precipitation_sum.push(0.1);
    d.snowfall_sum.push(freezing ? 0.5 : 0);
    d.daylight_duration.push(36000);
    d.sunshine_duration.push(30000);
  }
  return d;
}

const fs1 = frostStats(frostSynth([2020, 2021, 2022], 79, 314));
eq('last spring freeze is day 79', fs1.lastSpringFreezeDoy, 79);
eq('first fall freeze is day 314', fs1.firstFallFreezeDoy, 314);
eq('growing season is the gap', fs1.growingSeasonDays, 314 - 79);
ok('reports that it does freeze', fs1.everFreezes === true);
eq('three whole years analysed', fs1.yearsAnalysed, 3);
eq('no freeze-free years', fs1.freezeFreeYears, 0);
ok('day 79 renders as a date', doyToLabel(79) === 'March 20', doyToLabel(79));
eq('dayOfYear of Jan 1', dayOfYear('2021-01-01'), 1);
eq('dayOfYear of Dec 31 (non-leap)', dayOfYear('2021-12-31'), 365);

/* A climate that never freezes — Bonita Springs. Must not report a frost date. */
const fs2 = frostStats(frostSynth([2020, 2021, 2022], null, null));
ok('a frost-free climate reports no freeze', fs2.everFreezes === false);
eq('every year counted as freeze-free', fs2.freezeFreeYears, 3);
ok('no invented spring freeze date', fs2.lastSpringFreezeDoy === null);
ok('no invented growing-season length', fs2.growingSeasonDays === null);

console.log('\n\x1b[1myearlySeries and trendPerDecade\x1b[0m');
const ys = yearlySeries(frostSynth([2018, 2019, 2020, 2021, 2022], 79, 314));
eq('one row per whole year', ys.length, 5);
ok('rows are in year order', ys.every((r, i) => i === 0 || ys[i - 1].year < r.year));
ok('mean temp populated', typeof ys[0].meanTemp === 'number');
eq('freeze days match the synthetic pattern', ys[0].freeze32, 79 + (365 - 314 + 1));
eq('annual precip is the sum', ys[0].precip, +(365 * 0.1).toFixed(2));

/* A deliberately warming series: +0.5°F per year = +5°F per decade. */
const warming = Array.from({ length: 20 }, (_, i) => ({ year: 2000 + i, meanTemp: 50 + i * 0.5 }));
const tr = trendPerDecade(warming, 'meanTemp');
eq('slope reported per decade', tr.perDecade, 5);
eq('a perfect line has r² of 1', tr.r2, 1);
eq('spans the whole series', tr.n, 20);
ok('a flat series trends to zero',
   trendPerDecade(warming.map(r => ({ ...r, meanTemp: 60 })), 'meanTemp').perDecade === 0);
ok('too few points returns null',
   trendPerDecade(warming.slice(0, 3), 'meanTemp') === null);

console.log('\n\x1b[1mmodel acceptance requires every variable, not just temperature\x1b[0m');
/* ERA5-Land shipped once with perfect highs and no precipitation at all,
   because the coverage check only looked at temperature. */
const api2 = require('../js/api.js');
const full = Array.from({ length: 100 }, (_, i) => i);
const empty = Array.from({ length: 100 }, () => null);
eq('a full series reports full coverage', api2.coverage(full), 1);
eq('an all-null series reports zero coverage', api2.coverage(empty), 0);
eq('a quarter-populated series reports 0.25',
   api2.coverage([1, null, null, null]), 0.25);
ok('an empty series would be rejected at the 0.8 threshold', api2.coverage(empty) < 0.8);
ok('the archive model is named explicitly, not left to best-match',
   api2.ARCHIVE_MODEL === 'era5',
   `ARCHIVE_MODEL is ${JSON.stringify(api2.ARCHIVE_MODEL)} — must be the model the validation measures`);

console.log('\n\x1b[1maggregation reports missing precipitation as missing\x1b[0m');
/* If a model does return empty precipitation, the totals must come back null
   rather than a confident zero — "no rain ever" and "no data" are different. */
const noPrecip = frostSynth([2020, 2021], 79, 314);
noPrecip.precipitation_sum = noPrecip.time.map(() => null);
noPrecip.snowfall_sum = noPrecip.time.map(() => null);
const npRows = aggregateMonthly(noPrecip, sunClim);
ok('a month with no precipitation data reports null, not 0',
   npRows[0].precipTotal === null, String(npRows[0].precipTotal));
ok('and the annual total is null too',
   annualSummary(npRows).annualPrecip === null, String(annualSummary(npRows).annualPrecip));
/* "It did not snow" and "we have no snow data" are different claims, and
   reporting the second as the first told New Jersey it gets no snow. */
ok('missing snowfall data reports null, not a confident zero',
   npRows[0].snowfall === null, String(npRows[0].snowfall));
ok('missing snow days report null too', npRows[0].snowDays === null, String(npRows[0].snowDays));
ok('a real zero is still zero, not null',
   rows[6].snowfall === 0, String(rows[6].snowfall));

/* ---------------------------------------------------------------------------
   Archive model selection, driven through fetchArchive with a stubbed fetch.

   Until now this logic was only exercised through the browser mocks, which
   always answer completely — so the fallback paths, the ones that exist
   precisely because a model can answer INCOMPLETELY, were never run. That is
   how ERA5-Land shipped with no rain.
   ------------------------------------------------------------------------- */
console.log('\n\x1b[1marchive model selection and its fallbacks\x1b[0m');
globalThis.PERIODS = { p1: { start: '2020-01-01', end: '2021-12-31', years: 2, label: 'p1' },
                       p2: { start: '2000-01-01', end: '2021-12-31', years: 22, label: 'p2' } };
const LOC = { id: 'x', name: 'Test', short: 'T', lat: 33.8, lon: -78.7, tz: 'America/New_York' };

/* A full daily payload for whichever variables the URL asked for. */
function daysBetween(a, b) {
  const out = []; const d = new Date(a + 'T00:00:00Z'); const end = new Date(b + 'T00:00:00Z');
  while (d <= end) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
/* `thin` names variables to answer with nulls — a model that replies 200 OK
   and hands back nothing, which is the failure mode that matters. */
function stubFetch(opts = {}) {
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    seen.push({ url, model: u.searchParams.get('models'),
                vars: (u.searchParams.get('daily') || '').split(',') });
    const model = u.searchParams.get('models');
    if (opts.reject && opts.reject(model, seen.length)) {
      return { ok: false, status: 400,
               json: async () => ({ error: true, reason: 'Data corresponding to variable cannot be found' }) };
    }
    const time = daysBetween(u.searchParams.get('start_date'), u.searchParams.get('end_date'));
    const daily = { time };
    for (const v of (u.searchParams.get('daily') || '').split(',')) {
      const isThin = opts.thin && opts.thin(v, model);
      daily[v] = time.map((_, i) => isThin ? null : (v.includes('temperature') ? 70 + (i % 10) : 1));
    }
    return { ok: true, status: 200, json: async () => ({ daily, daily_units: {} }) };
  };
  return seen;
}
const realFetch = globalThis.fetch;

/* 1. A model that answers completely is used, for core AND extended. */
let seen = stubFetch();
let res = await api2.fetchArchive(LOC, 'p1');
ok('a complete model is used for the core variables', res.model === 'era5', res.model);
ok('and the extended variables are requested on the same model',
   seen.filter(r => r.vars.includes('cloud_cover_mean')).every(r => r.model === 'era5'),
   JSON.stringify(seen.filter(r => r.vars.includes('cloud_cover_mean')).map(r => r.model)));
ok('the extended series make it into the merged result',
   Array.isArray(res.daily.cloud_cover_mean) && res.daily.cloud_cover_mean.length === res.daily.time.length);
ok('and it is reported as extended', res.extended === true);

/* 2. The ERA5-Land failure: perfect temperatures, no precipitation. */
seen = stubFetch({ thin: (v, m) => m === 'era5' && /precipitation|snowfall/.test(v) });
res = await api2.fetchArchive(LOC, 'p1');
ok('a model with no precipitation is rejected even though its temperatures are fine',
   res.model === 'default', res.model);
ok('and the rejection says which variables were missing',
   /precipitation_sum/.test(res.modelNote), res.modelNote);
ok('the fallback data actually carries precipitation',
   res.daily.precipitation_sum.filter(v => v != null).length === res.daily.time.length);

/* 3. Extended variables missing on the named model must not lose them. */
seen = stubFetch({ thin: (v, m) => m === 'era5' && v === 'cloud_cover_mean' });
res = await api2.fetchArchive(LOC, 'p1');
ok('a thin extended field does not drag the core model down with it',
   res.model === 'era5', res.model);
ok('the extended set falls back to the default model instead of being dropped',
   res.daily.cloud_cover_mean && res.daily.cloud_cover_mean.every(v => v != null),
   JSON.stringify((res.daily.cloud_cover_mean || []).slice(0, 3)));
ok('and the fallback is disclosed rather than silent',
   /extended on era5 rejected/.test(res.modelNote), res.modelNote);

/* 4. Once the named model is rejected for extended, it is not retried on
      every later chunk — that would double the quota cost of a long period. */
seen = stubFetch({ thin: (v, m) => m === 'era5' && v === 'pressure_msl_mean' });
res = await api2.fetchArchive(LOC, 'p2');
const extNamed = seen.filter(r => r.vars.includes('pressure_msl_mean') && r.model === 'era5');
ok('a 22-year period is split into more than one chunk',
   seen.filter(r => r.vars.includes('pressure_msl_mean')).length > 2,
   String(seen.filter(r => r.vars.includes('pressure_msl_mean')).length));
ok('the rejected model is attempted once, not once per chunk',
   extNamed.length === 1, `${extNamed.length} attempts`);

/* 5. If BOTH models refuse the extended set, the core data still returns.
      Request 1 is the core pull; every request after it is an extended one. */
seen = stubFetch({ reject: (m, n) => n > 1 });
res = await api2.fetchArchive(LOC, 'p1');
ok('an unsupported extended set leaves the core climatology intact',
   res.daily.temperature_2m_max.length > 700, String(res.daily.temperature_2m_max.length));
ok('and it is reported as not extended, rather than pretending', res.extended === false);
globalThis.fetch = realFetch;

/* ---------------------------------------------------------------------------
   The last few functions no suite had ever executed. Found by unioning V8
   coverage across the crawl and the e2e run (test/coverage-report.mjs) rather
   than by reading the code and deciding what looked risky — which is how they
   stayed uncovered in the first place.
   ------------------------------------------------------------------------- */
console.log('\n\x1b[1mcivil twilight\x1b[0m');
/* Sun 6° below the horizon: first and last usable light. Not currently shown
   on the page, but exported, so it is either correct or a trap for later. */
const jun = new Date(Date.UTC(2024, 5, 21));
const ct = solar.civilTwilight(jun, 33.816, -78.68);
const st = solar.sunTimes(jun, 33.816, -78.68);
ok('dawn comes before sunrise', ct.dawn < st.sunrise,
   `${ct.dawn && ct.dawn.toISOString()} vs ${st.sunrise && st.sunrise.toISOString()}`);
ok('dusk comes after sunset', ct.dusk > st.sunset,
   `${ct.dusk && ct.dusk.toISOString()} vs ${st.sunset && st.sunset.toISOString()}`);
/* At this latitude in June the gap is around half an hour either side; well
   outside 10-60 minutes would mean the 96° zenith argument is not landing. */
const dawnGap = (st.sunrise - ct.dawn) / 60000, duskGap = (ct.dusk - st.sunset) / 60000;
ok('dawn precedes sunrise by a plausible margin', dawnGap > 15 && dawnGap < 60, `${dawnGap.toFixed(1)} min`);
ok('dusk follows sunset by a plausible margin', duskGap > 15 && duskGap < 60, `${duskGap.toFixed(1)} min`);
ok('the twilight window is symmetric to within a minute',
   Math.abs(dawnGap - duskGap) < 1.5, `${dawnGap.toFixed(1)} vs ${duskGap.toFixed(1)}`);
/* Further north the sun sets more obliquely, so twilight lasts longer. */
const ctN = solar.civilTwilight(jun, 61.2, -149.9);   // Anchorage
const stN = solar.sunTimes(jun, 61.2, -149.9);
ok('twilight is longer at high latitude in June',
   (stN.sunrise - ctN.dawn) / 60000 > dawnGap,
   `${((stN.sunrise - ctN.dawn) / 60000).toFixed(1)} vs ${dawnGap.toFixed(1)}`);

console.log('\n\x1b[1mrequest pacing\x1b[0m');
/* Pacing is what keeps a full rebuild inside the free tier's per-minute cap.
   It is set by the build scripts, so no browser test ever touched it — and a
   silently-ignored pace is exactly the bug that made a 30-minute build attempt
   to run in 5. */
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: 1 }) });
const timeFour = async () => {
  const t0 = Date.now();
  for (let i = 0; i < 4; i++) await api2.apiGet('https://example.invalid/x' + i, { label: 'pace' });
  return Date.now() - t0;
};
api2.setPacing(0);
const unpaced = await timeFour();
api2.setPacing(120);
const paced = await timeFour();
api2.setPacing(0);
ok('with no pacing four requests return essentially immediately',
   unpaced < 100, `${unpaced} ms`);
ok('a 120 ms pace actually spaces the requests out',
   paced >= 330, `${paced} ms for 4 requests — pacing is being ignored`);
ok('and pacing can be turned back off', (await timeFour()) < 100);
ok('a negative pace is clamped rather than breaking the loop',
   (api2.setPacing(-500), (await timeFour()) < 100));

console.log('\n\x1b[1mhourly sea-surface temperature collapsed to days\x1b[0m');
/* The marine API does not document daily SST for every model, so the hourly
   form is the fallback. If this reduction is wrong the entire ocean-temperature
   chart is wrong, and nothing else in the suite ran it. */
const hourly = { hourly: { time: [], sea_surface_temperature: [], wave_height: [] } };
for (let h = 0; h < 24; h++) {
  hourly.hourly.time.push(`2024-07-01T${String(h).padStart(2, '0')}:00`);
  hourly.hourly.sea_surface_temperature.push(70 + h);   // 70..93, mean 81.5
  hourly.hourly.wave_height.push(2);
}
for (let h = 0; h < 24; h++) {
  hourly.hourly.time.push(`2024-07-02T${String(h).padStart(2, '0')}:00`);
  hourly.hourly.sea_surface_temperature.push(h < 12 ? null : 80);
  hourly.hourly.wave_height.push(3);
}
const days = api2.hourlyToDaily(hourly);
ok('one row per calendar day', days.length === 2, `${days.length} rows`);
eq('the daily mean is the mean of that day\'s hours', days[0].mean, 81.5);
eq('the daily max is that day\'s highest hour', days[0].max, 93);
eq('the daily min is that day\'s lowest hour', days[0].min, 70);
ok('days are keyed by date, not by index', days[0].date === '2024-07-01' && days[1].date === '2024-07-02');
eq('null hours are skipped rather than counted as zero', days[1].mean, 80);
ok('and they do not drag the minimum to zero', days[1].min === 80, String(days[1].min));
eq('wave height falls back to the hourly mean when no daily max is given', days[0].wave, 2);
/* A daily wave_height_max, where present, must win over the hourly mean. */
const withDaily = JSON.parse(JSON.stringify(hourly));
withDaily.daily = { time: ['2024-07-01'], wave_height_max: [9] };
const days2 = api2.hourlyToDaily(withDaily);
eq('a reported daily wave max takes precedence over the hourly mean', days2[0].wave, 9);
eq('and a day without one still falls back', days2[1].wave, 3);
/* A day where every hour is missing must report null, not a temperature of
   -Infinity from an unseeded max. */
const allNull = { hourly: { time: ['2024-08-01T00:00', '2024-08-01T01:00'],
                            sea_surface_temperature: [null, null], wave_height: [null, null] } };
const dn = api2.hourlyToDaily(allNull);
ok('a day with no readings reports null, not Infinity',
   dn[0].mean === null && dn[0].max === null && dn[0].min === null,
   JSON.stringify(dn[0]));
ok('an empty response yields no rows rather than throwing',
   api2.hourlyToDaily({}).length === 0);

console.log('\n\x1b[1mUSGS water temperature\x1b[0m');
/* USGS reports parameter 00010 in Celsius, and a gauge that stopped years ago
   still answers with its last value — which would render as today's water
   temperature. Both are guarded. */
{
  const loc = { marine: { usgsStation: '01408048', usgsName: 'Watson Creek at Manasquan, NJ' } };
  const reply = (tempC, ageHours) => ({
    ok: true, status: 200, json: async () => ({ value: { timeSeries: [{
      sourceInfo: { siteCode: [{ value: '01408048' }] },
      values: [{ value: [{ value: String(tempC),
        dateTime: new Date(Date.now() - ageHours * 3600000).toISOString() }] }] }] } }) });
  const realFetch3 = globalThis.fetch;
  const run = async (c, age) => {
    globalThis.fetch = async () => reply(c, age);
    try { return await api2.fetchWaterTempUSGS(loc); }
    catch (e) { return { error: e.message }; }
  };
  const fresh = await run(24.5, 0.25);
  eq('24.5°C is converted to Fahrenheit', fresh.tempF, 76.1);
  ok('and the source is named', fresh.source === 'USGS' && /Manasquan/.test(fresh.name), JSON.stringify(fresh));
  const stale = await run(24.5, 24 * 30);
  ok('a reading a month old is refused, not shown as today',
     !!stale.error && /old/.test(stale.error), JSON.stringify(stale));
  const silly = await run(-5, 0.25);
  ok('an implausible reading is refused rather than published',
     !!silly.error, JSON.stringify(silly));
  const ok48 = await run(20, 47);
  ok('a reading within two days is still accepted', !ok48.error, JSON.stringify(ok48));
  globalThis.fetch = realFetch3;
}

console.log('\n\x1b[1mthe sun date is the location, not UTC\x1b[0m');
/* The bug: sunTimes reads Y/M/D in UTC, so a bare `new Date()` computed
   TOMORROW's sun times after ~8pm Eastern, when the instant has crossed
   midnight UTC. localCalendarDate derives the day in the home's own zone. */
{
  /* 00:30 UTC on Aug 25 is 8:30pm EDT on Aug 24 — the failing window. */
  const instant = new Date('2026-08-25T00:30:00Z');
  const local = solar.localCalendarDate('America/New_York', instant);
  eq('the local date is the 24th, not the UTC 25th', local.getUTCDate(), 24);
  eq('and the month is August', local.getUTCMonth(), 7);

  const sunLocal = solar.sunTimes(local, 40.90, -74.51);
  const sunUTC   = solar.sunTimes(instant, 40.90, -74.51);   // the old, wrong call
  /* Sunset on the 24th and the 25th differ by a minute or two; the point is
     they are DIFFERENT days, and the local one is the right one. */
  const dayOf = t => new Date(t.getTime()).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  eq('the local-date sunset falls on the 24th', +dayOf(sunLocal.sunset).slice(-2), 24);
  eq('the raw-UTC sunset falls on the 25th — the bug', +dayOf(sunUTC.sunset).slice(-2), 25);
}
{
  /* Midday, when UTC and Eastern share a date, must be unaffected. */
  const noonish = new Date('2026-08-24T16:00:00Z');   // noon EDT
  const local = solar.localCalendarDate('America/New_York', noonish);
  eq('a midday instant keeps the same date', local.getUTCDate(), 24);
}

console.log('\n\x1b[1malert severity ordering\x1b[0m');
/* An unrecognised severity must never outrank Extreme. Bare indexOf returned
   -1 for anything off the list, and -1 sorts first. */
{
  const r = api2.severityRank;
  ok('Extreme is rank 0', r('Extreme') === 0);
  ok('the known order holds', r('Extreme') < r('Severe') && r('Severe') < r('Moderate')
     && r('Moderate') < r('Minor') && r('Minor') < r('Unknown'));
  ok('a garbled severity sorts AFTER Extreme, not before',
     r('WeatherBotSaysRun') > r('Extreme'), String(r('WeatherBotSaysRun')));
  ok('and after every known level', r('WeatherBotSaysRun') >= r('Unknown'));
  ok('a missing severity is handled too', r(undefined) > r('Extreme') && r(null) > r('Extreme'));
  /* The actual sort: a real list with an unknown severity in front. */
  const sorted = [{ severity: 'Nonsense' }, { severity: 'Extreme' }, { severity: 'Minor' }]
    .sort((a, b) => r(a.severity) - r(b.severity));
  eq('Extreme leads the sorted list, not the nonsense value', sorted[0].severity === 'Extreme' ? 1 : 0, 1);
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);
