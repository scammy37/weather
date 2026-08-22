/* Verifies scripts/validate-climate.mjs computes bias correctly, using stubbed
   NOAA and Open-Meteo responses with known answers.
   Run: node test/validate-script.mjs */
import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + n); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + n + (e ? '  → ' + e : '')); } };

/* NOAA says July max is 89. era5 will say 86 (3° cool), era5_land 88.5 (0.5° cool). */
const NOAA_TMAX = [58,61,68,75,82,87,89,88,84,76,68,60];
const NOAA_TMIN = [36,39,45,52,61,69,73,72,68,57,47,39];
const NOAA_PRCP = [3.5,3.2,4.0,3.0,3.4,5.5,6.5,7.0,6.8,3.5,3.0,3.3];
const BIAS = { era5: -3.0, era5_land: -0.5 };

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('ncei.noaa.gov')) {
    const rows = [];
    for (let m = 0; m < 12; m++) rows.push({
      STATION: 'USW00013717', DATE: `2010-${String(m + 1).padStart(2, '0')}`,
      STATION_NAME: 'TEST STATION, SC US',
      'MLY-TMAX-NORMAL': NOAA_TMAX[m], 'MLY-TMIN-NORMAL': NOAA_TMIN[m], 'MLY-PRCP-NORMAL': NOAA_PRCP[m]
    });
    return { ok: true, status: 200, json: async () => rows };
  }
  const model = /models=([a-z0-9_]+)/.exec(u)?.[1] || 'default';
  const off = BIAS[model] ?? 0;
  const time = [], tmax = [], tmin = [], prcp = [];
  for (let y = 1991; y <= 2020; y++) for (let m = 0; m < 12; m++) {
    const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    for (let d = 1; d <= dim; d++) {
      time.push(`${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
      tmax.push(NOAA_TMAX[m] + off);
      tmin.push(NOAA_TMIN[m] + off);
      prcp.push(NOAA_PRCP[m] / dim);       // month total matches the normal exactly
    }
  }
  return { ok: true, status: 200, json: async () => ({ daily: { time, temperature_2m_max: tmax, temperature_2m_min: tmin, precipitation_sum: prcp } }) };
};

const outPath = path.join(ROOT, 'test', 'shots', 'validation-test.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
console.log('\n\x1b[1mrunning scripts/validate-climate.mjs against stubbed sources\x1b[0m');
process.argv = [process.argv[0], 'validate-climate.mjs', '--home', 'nmb', '--out', outPath];
const origLog = console.log, origExit = process.exit;
let exitCode = 0;
process.exit = c => { exitCode = c; };
console.log = () => {};
await import('../scripts/validate-climate.mjs');
console.log = origLog; process.exit = origExit;

const r = JSON.parse(fs.readFileSync(outPath, 'utf8'));
const e = r.homes.nmb;
console.log('\n\x1b[1mreport shape\x1b[0m');
ok('exited cleanly', exitCode === 0, `exit ${exitCode}`);
ok('window is the NOAA normals period', r.window === '1991–2020', r.window);
ok('resolved a NOAA station', !!e.noaa && e.noaa.stationId === 'USW00013717');
ok('carries 12 NOAA months', e.noaa.months.length === 12);
ok('both models present', !!e.models.era5 && !!e.models.era5_land);

console.log('\n\x1b[1mbias is measured, not assumed\x1b[0m');
const a = e.models.era5.vsNoaa.tmax, b = e.models.era5_land.vsNoaa.tmax;
ok('era5 high bias detected as −3.0°F', Math.abs(a.meanBias + 3) < 0.05, `${a.meanBias}`);
ok('era5_land high bias detected as −0.5°F', Math.abs(b.meanBias + 0.5) < 0.05, `${b.meanBias}`);
ok('all 12 months compared', a.n === 12 && b.n === 12);
ok('verdict picks the closer model', e.verdict === 'era5_land', e.verdict);
ok('low temperatures compared too', Math.abs(e.models.era5.vsNoaa.tmin.meanBias + 3) < 0.05);
ok('precipitation matches with no bias', Math.abs(e.models.era5.vsNoaa.prcp.meanBias) < 0.02,
   `${e.models.era5.vsNoaa.prcp.meanBias}`);

console.log('\n\x1b[1mverdict flips when the models swap places\x1b[0m');
BIAS.era5 = -0.2; BIAS.era5_land = -4.0;
const p2 = path.join(ROOT, 'test', 'shots', 'validation-test2.json');
process.argv = [process.argv[0], 'validate-climate.mjs', '--home', 'nmb', '--out', p2];
process.exit = c => { exitCode = c; }; console.log = () => {};
await import('../scripts/validate-climate.mjs?flip');
console.log = origLog; process.exit = origExit;
const e2 = JSON.parse(fs.readFileSync(p2, 'utf8')).homes.nmb;
ok('now prefers era5', e2.verdict === 'era5', e2.verdict);
ok('and reports the larger era5_land bias', Math.abs(e2.models.era5_land.vsNoaa.tmax.meanBias + 4) < 0.05,
   `${e2.models.era5_land.vsNoaa.tmax.meanBias}`);
fs.rmSync(p2, { force: true });

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);
