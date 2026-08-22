/* Verification pass: the REAL committed data against independently published
   climate values for these three places.

   Everything else in the suite tests the code. This tests the numbers — the
   thing a reader actually relies on. Ranges are deliberately generous: they
   are meant to catch a wrong model, a unit slip or a broken aggregation, not
   to police the third decimal place.

   Run: node test/spot-check.mjs        (skips cleanly if the data is absent)
   =========================================================================== */
import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data', 'climate.json');

let pass = 0, fail = 0, warn = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + n); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + n + (e ? '  → ' + e : '')); } };
const soft = (n, c, e = '') => { if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + n); }
  else { warn++; console.log('  \x1b[33m!\x1b[0m ' + n + (e ? '  → ' + e : '')); } };

if (!fs.existsSync(DATA)) {
  console.log('\ndata/climate.json is not present — nothing to spot-check. Run scripts/build-climate.mjs first.\n');
  process.exit(0);
}
const j = JSON.parse(fs.readFileSync(DATA, 'utf8'));

/* Published climate values for each area, from NOAA/NWS station normals.
   Coastal July highs are the diagnostic: ERA5's coarse grid mixes in ocean and
   reads low there, which is exactly what these bounds are set to catch. */
const REF = {
  nmb: { name: 'North Myrtle Beach, SC', station: 'Myrtle Beach area',
    julHigh: [86, 92], janHigh: [52, 60], janLow: [33, 42], julLow: [70, 78],
    precip: [45, 65], snow: [0, 4], freeze: [0, 35], hot90: [10, 60], oceanAug: [78, 87] },
  bonita: { name: 'Bonita Springs, FL', station: 'Naples / Fort Myers',
    julHigh: [89, 95], janHigh: [72, 79], janLow: [50, 60], julLow: [72, 78],
    precip: [45, 62], snow: [0, 0.1], freeze: [0, 3], hot90: [90, 160], oceanAug: [84, 91] },
  rockaway: { name: 'Rockaway, NJ', station: 'Morristown area',
    julHigh: [80, 88], janHigh: [34, 42], janLow: [15, 26], julLow: [60, 68],
    precip: [40, 58], snow: [12, 48], freeze: [80, 135], hot90: [5, 35], oceanAug: [68, 76] }
};

console.log('\n\x1b[1mdata/climate.json\x1b[0m');
console.log(`  generated ${j.generated}`);
ok('carries all three homes', Object.keys(j.homes).length === 3, Object.keys(j.homes).join(', '));

for (const [id, r] of Object.entries(REF)) {
  const periods = j.homes[id];
  if (!periods) { ok(`${r.name} present`, false); continue; }
  const key = Object.keys(periods)[0];
  const set = periods[key];
  const rows = set.rows, a = set.annual;

  console.log(`\n\x1b[1m${r.name}\x1b[0m  ${key} · model ${set.meta.model || 'unknown'} · ref: ${r.station}`);

  const range = (label, v, [lo, hi], hard = true) => {
    const fn = hard ? ok : soft;
    fn(`${label} ${v == null ? '—' : v.toFixed(1)} within ${lo}–${hi}`,
       v != null && v >= lo && v <= hi, `outside the published range`);
  };

  range('Jul avg high ', rows[6].avgHigh, r.julHigh);
  range('Jan avg high ', rows[0].avgHigh, r.janHigh);
  range('Jan avg low  ', rows[0].avgLow,  r.janLow);
  range('Jul avg low  ', rows[6].avgLow,  r.julLow);
  range('annual precip', a.annualPrecip,  r.precip);
  range('annual snow  ', a.annualSnow,    r.snow);
  range('days ≤ 32°F  ', a.annualFreeze,  r.freeze);
  /* Threshold counts are the most sensitive to a degree or two of model bias,
     so they warn rather than fail. */
  range('days ≥ 90°F  ', a.annualHot90,   r.hot90, false);
  if (rows[7].sst != null) range('Aug ocean    ', rows[7].sst, r.oceanAug, false);

  /* Structural invariants that must hold whatever the climate. */
  ok('  every month has a high above its low', rows.every(x => x.avgHigh > x.avgLow));
  ok('  the warmest month is in May–September',
     [4,5,6,7,8].includes(rows.reduce((m, x, i2) => x.avgHigh > rows[m].avgHigh ? i2 : m, 0)));
  ok('  the coldest month is in November–March',
     [10,11,0,1,2].includes(rows.reduce((m, x, i2) => x.avgLow < rows[m].avgLow ? i2 : m, 0)));
  ok('  daylight peaks in June', rows.reduce((m, x, i2) => x.daylight > rows[m].daylight ? i2 : m, 0) === 5);
  ok('  no month has negative precipitation', rows.every(x => x.precipTotal >= 0));
  ok('  sample size is the full period', rows.every(x => x.sampleYears >= 9), `${rows[0].sampleYears}`);
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed, ${warn} warnings\x1b[0m`);
if (warn) console.log('Warnings are values outside the published range on the most bias-sensitive measures.');
console.log();
process.exit(fail ? 1 : 0);
