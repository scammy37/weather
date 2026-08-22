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
      d.cloud_cover_mean.push(40); d.pressure_msl_mean.push(1016);
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
eq('Jan cloud cover', jan.cloudCover, 40);
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
eq('Jan sunny days (ratio 0.80 ≥ 0.70)', jan.sunnyDays, 31);
eq('Jan cloudy days', jan.cloudyDays, 0);
/* 2023 Feb has 28 days (14 odd), 2024 Feb has 29 (15 odd) → mean 14.5.
   The half-day is the leap year showing through, and is correct. */
eq('Feb sunny days (leap-aware mean of 14 and 15)', feb.sunnyDays, 14.5);
eq('Feb cloudy days (ratio 0.10 < 0.35)', feb.cloudyDays, 14);
eq('Mar partly days (ratio 0.50)', mar.partlyDays, 31);
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

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);
