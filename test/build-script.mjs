/* Verifies scripts/build-climate.mjs end to end against the mock API, and
   checks the file it writes is shaped the way the dashboard expects.
   Run: node test/build-script.mjs */
import { archiveResponse, marineResponse } from './mock.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '  → ' + extra : '')); }
};

/* Stub fetch so the script exercises its real code path without network. */
let calls = 0, weighted = 0;
globalThis.fetch = async (url) => {
  calls++;
  const u = new URL(url);
  const days = u.searchParams.get('start_date')
    ? (Date.parse(u.searchParams.get('end_date')) - Date.parse(u.searchParams.get('start_date'))) / 86400000 + 1
    : 7;
  const vars = ((u.searchParams.get('daily') || '') + ',' + (u.searchParams.get('hourly') || ''))
    .split(',').filter(Boolean).length;
  weighted += (days / 14) * (vars / 10);
  const body = u.hostname.startsWith('marine') ? marineResponse(url) : archiveResponse(url);
  return { ok: true, status: 200, json: async () => body };
};

const outPath = path.join(ROOT, 'test', 'shots', 'climate-test.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });

console.log('\n\x1b[1mrunning scripts/build-climate.mjs against the mock\x1b[0m');
process.argv = [process.argv[0], 'build-climate.mjs', '--pause', '0', '--out', outPath];
const origExit = process.exit;
let exitCode = null;
process.exit = c => { exitCode = c; };            // let the script "exit" without killing us
const origLog = console.log;
console.log = () => {};                            // silence the progress output
await import('../scripts/build-climate.mjs');
console.log = origLog;
process.exit = origExit;

ok('script completed without error exit', exitCode === 0, `exit ${exitCode}`);
ok('wrote the output file', fs.existsSync(outPath));

const j = JSON.parse(fs.readFileSync(outPath, 'utf8'));
console.log('\n\x1b[1moutput shape\x1b[0m');
ok('has a generated timestamp', typeof j.generated === 'string' && !isNaN(Date.parse(j.generated)));
ok('names its source', /Open-Meteo/.test(j.source) && /ERA5/.test(j.source));
ok('carries all three homes', Object.keys(j.homes).sort().join() === 'bonita,nmb,rockaway',
   Object.keys(j.homes).join());
ok('carries all three periods per home',
   Object.values(j.homes).every(h => Object.keys(h).length === 3),
   JSON.stringify(Object.entries(j.homes).map(([k, v]) => k + ':' + Object.keys(v).length)));

const set = j.homes.nmb['1996-2025'];
console.log('\n\x1b[1mcontent of one home/period set\x1b[0m');
ok('has 12 monthly rows', set.rows.length === 12);
ok('rows are in calendar order', set.rows.every((r, i) => r.month === i));
ok('has an annual summary', set.annual && typeof set.annual.annualPrecip === 'number');
ok('has metadata naming the period', set.meta.period === '1996-2025');
ok('extended variables came through', set.meta.extended === true);
ok('ocean data merged', typeof set.rows[6].sst === 'number', String(set.rows[6].sst));
ok('sunrise/sunset present', typeof set.rows[6].sunriseMin === 'number');
ok('sample sizes recorded', set.rows[0].sampleYears >= 25, String(set.rows[0].sampleYears));

const nulls = set.rows.flatMap(r => Object.entries(r).filter(([, v]) => Number.isNaN(v)).map(([k]) => k));
ok('no NaN anywhere in the rows', nulls.length === 0, nulls.slice(0, 5).join());

console.log('\n\x1b[1mkey metrics are populated\x1b[0m');
for (const k of ['avgHigh','avgLow','precipTotal','wetDays','sunnyDays','snowfall',
                 'sst','daylight','humidity','hdd','cdd','beachDays']) {
  ok(`${k} present for all 12 months`, set.rows.every(r => r[k] !== undefined && r[k] !== null), k);
}

console.log('\n\x1b[1mcost and size\x1b[0m');
const kb = fs.statSync(outPath).size / 1024;
ok('file is small enough to serve statically', kb < 3000, `${kb.toFixed(0)} KB`);
console.log(`  → ${calls} HTTP requests, ~${weighted.toFixed(0)} weighted Open-Meteo calls for the whole build`);
console.log(`  → output ${kb.toFixed(0)} KB`);

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);
