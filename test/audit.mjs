/* Verification pass: every displayed quantity, checked for unit and plausibility.

   Renders the real page against the mock and reads back every stat tile,
   asserting each value carries the expected imperial unit and sits inside a
   physically sensible range. A wrong conversion factor produces a plausible
   number in the wrong unit — the range check is what catches that.
   Run: node test/audit.mjs */
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';
import { archiveResponse, forecastResponse, marineResponse, airResponse,
         alertsResponse, coopsResponse, nwsResponse } from './mock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + n); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + n + (e ? '  → ' + e : '')); } };

const MIME = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.svg':'image/svg+xml' };
const srv = http.createServer((q, r) => {
  const f = path.join(ROOT, q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0]);
  if (!fs.existsSync(f)) { r.writeHead(404); return r.end('nf'); }
  r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' }); r.end(fs.readFileSync(f));
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', e => errors.push(e.message));
const json = (rt, body) => rt.fulfill({ status: 200, contentType: 'application/json',
  headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
await p.route('**://api.tidesandcurrents.noaa.gov/**', r => json(r, coopsResponse(r.request().url())));
await p.route('**://api.weather.gov/**', r => json(r, nwsResponse(r.request().url())));
await p.route('**://api.weather.gov/alerts/**', r => json(r, alertsResponse(r.request().url())));
await p.route('**/data/climate.json', r => r.fulfill({ status: 404, body: 'nf' }));
await p.route('**://api.open-meteo.com/**', r => json(r, forecastResponse(r.request().url())));
await p.route('**://air-quality-api.open-meteo.com/**', r => json(r, airResponse(r.request().url())));
await p.route('**://archive-api.open-meteo.com/**', r => json(r, archiveResponse(r.request().url())));
await p.route('**://marine-api.open-meteo.com/**', r => json(r, marineResponse(r.request().url())));

await p.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
await p.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await p.click('.tab[data-id="nmb"]');
await p.waitForSelector('#kpis .kpi', { timeout: 120000 });

/* label → [regex the value must match, min, max, what it is] */
const EXPECT = {
  'Humidity':      [/^\d{1,3}%$/,            0, 100,  'percent'],
  'Dew point':     [/^-?\d{1,3}°F$/,       -60, 90,   '°F'],
  'Wind':          [/^\d{1,3} mph$/,         0, 250,  'mph'],
  'Pressure':      [/^\d{2}\.\d{2} inHg$/,  25, 32,   'inHg'],
  'Cloud cover':   [/^\d{1,3}%$/,            0, 100,  'percent'],
  'Visibility':    [/^\d{1,3}\.\d mi$/,      0, 250,  'miles'],
  'UV index':      [/^\d{1,2}\.\d$/,         0, 20,   'index'],
  'Precip today':  [/^\d+\.\d{2} in$/,       0, 40,   'inches'],
  'Air quality':   [/^\d{1,3}$/,             0, 500,  'US AQI'],
  'Water temp':    [/^\d{1,3}\.\d°F$/,      25, 105,  '°F'],
  'Wave height':   [/^\d+\.\d ft$/,          0, 60,   'feet'],
  'Wave period':   [/^\d+\.\d s$/,           0, 30,   'seconds']
};

console.log('\n\x1b[1mevery live stat tile carries the right unit and a sane value\x1b[0m');
const tiles = await p.$$eval('#liveHost .stat',
  els => els.map(e => [e.querySelector('.stat-l').textContent.trim(),
                       e.querySelector('.stat-v').textContent.trim()]));
let checked = 0;
for (const [label, value] of tiles) {
  const spec = EXPECT[label];
  if (!spec) continue;
  checked++;
  const [re, min, max, what] = spec;
  const shapeOk = re.test(value);
  const num = parseFloat(value);
  const rangeOk = Number.isFinite(num) && num >= min && num <= max;
  ok(`${label}: "${value}" is ${what} in [${min}, ${max}]`, shapeOk && rangeOk,
     shapeOk ? `out of range` : `wrong shape, expected ${re}`);
}
ok(`covered ${checked} of the ${Object.keys(EXPECT).length} audited measures`, checked >= 10, `${checked}`);

console.log('\n\x1b[1mno metric units leak into the page\x1b[0m');
const body = await p.textContent('body');
for (const [re, what] of [
  [/\d\s?km(?![\/a-z])/i, 'kilometres'], [/\d\s?°C/, 'Celsius'],
  [/\d\s?hPa/, 'hectopascals'], [/\d\s?m\/s/, 'metres per second'],
  [/\d\s?mm\b/, 'millimetres'], [/\d\s?metres?\b/i, 'metres']
]) ok(`no ${what}`, !re.test(body), (re.exec(body) || [''])[0]);

console.log('\n\x1b[1mmonthly table values are in range for every measure\x1b[0m');
const RANGES = {
  'Avg High': [-40, 130], 'Avg Low': [-60, 110], 'Record High': [-20, 140], 'Record Low': [-70, 100],
  'Total Precipitation': [0, 60], 'Avg Snowfall': [0, 200], 'Avg Wet Days': [0, 31],
  'Avg Sunny Days': [0, 31], 'Avg Humidity': [0, 100], 'Avg Ocean Temp': [25, 100],
  'Avg Wind': [0, 100], 'Avg Pressure': [25, 32], 'Heating Degree Days': [0, 3000],
  'Cooling Degree Days': [0, 2000], 'Avg Daylight': [0, 24], 'Solar Energy': [0, 15]
};
const headers = await p.$$eval('#tbl thead th', th => th.map(t => t.textContent.replace(/[▲▼⇅]/g, '').replace(/\(.*\)/, '').trim()));
const rows = await p.$$eval('#tbl tbody tr', trs => trs.map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim())));
let colChecks = 0, colBad = [];
headers.forEach((h, i) => {
  const r = RANGES[h]; if (!r) return;
  colChecks++;
  for (const row of rows) {
    const v = parseFloat(row[i]);
    if (Number.isFinite(v) && (v < r[0] || v > r[1])) colBad.push(`${h}=${v}`);
  }
});
ok(`all values in ${colChecks} audited columns are physically plausible`, colBad.length === 0, colBad.slice(0, 5).join(', '));

console.log('\n\x1b[1minternal consistency\x1b[0m');
const tbl = Object.fromEntries(headers.map((h, i) => [h, rows.map(r => parseFloat(r[i]))]));
const hi = tbl['Avg High'], lo = tbl['Avg Low'], swing = tbl['Day/Night Swing'];
ok('the average high is above the average low in every month',
   hi && lo && hi.every((v, i) => v > lo[i]));
ok('the day/night swing equals high minus low',
   swing && hi && hi.every((v, i) => Math.abs((v - lo[i]) - swing[i]) < 0.15));
const wet = tbl['Avg Wet Days'], dry = tbl['Avg Dry Days'];
ok('wet days plus dry days is a month',
   wet && dry && wet.every((v, i) => v + dry[i] > 27 && v + dry[i] < 32));
const rec = tbl['Record High'];
ok('no record high is below that month\'s average high', rec && rec.every((v, i) => v >= hi[i]));
const recLo = tbl['Record Low'];
ok('no record low is above that month\'s average low', recLo && recLo.every((v, i) => v <= lo[i]));

console.log('\n\x1b[1mno rendering errors\x1b[0m');
ok('no uncaught exceptions during the audit', errors.length === 0, errors.slice(0, 2).join(' | '));
ok('no "NaN" printed anywhere', !body.includes('NaN'));
ok('no "undefined" printed anywhere', !body.includes('undefined'));
ok('no "[object Object]" printed anywhere', !body.includes('[object Object]'));

await b.close(); srv.close();
console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);
