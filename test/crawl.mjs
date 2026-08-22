/* Exhaustive interaction crawl.

   The other suites test what I thought to test, which is why new defects kept
   surfacing when someone else clicked around. This one is mechanical: it reads
   the interactive elements out of the DOM and exercises all of them, in every
   view, checking after each interaction that the page did not throw, did not
   render a placeholder value, did not go blank, and did not overflow.

   It is slow on purpose. Run: node test/crawl.mjs [--fast]
   =========================================================================== */
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';
import { archiveResponse, forecastResponse, marineResponse, airResponse,
         alertsResponse, coopsResponse, nwsResponse } from './mock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAST = process.argv.includes('--fast');
let pass = 0, fail = 0;
const problems = [];
const ok = (n, c, e = '') => {
  if (c) { pass++; }
  else { fail++; problems.push(`${n}${e ? ' — ' + e : ''}`); console.log(`  \x1b[31m✗\x1b[0m ${n}${e ? '  → ' + e : ''}`); }
};
const step = m => console.log(`  \x1b[2m${m}\x1b[0m`);

const MIME = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.svg':'image/svg+xml' };
const srv = http.createServer((q, r) => {
  const f = path.join(ROOT, q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0]);
  if (!fs.existsSync(f)) { r.writeHead(404); return r.end('nf'); }
  r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' }); r.end(fs.readFileSync(f));
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch();
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/* --coverage records which functions in the app actually execute during the
   crawl, and prints the ones that never do. A suite's blind spots are not
   visible from its pass count; this makes them mechanical instead of a guess. */
const COVERAGE = process.argv.includes('--coverage');
const jsErrors = [];
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
const p = await ctx.newPage();
if (COVERAGE) await p.coverage.startJSCoverage({ resetOnNavigation: false });
p.on('pageerror', e => jsErrors.push(e.message));
p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) jsErrors.push('console: ' + m.text()); });
const json = (rt, body) => rt.fulfill({ status: 200, contentType: 'application/json',
  headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
await p.route('**://radar.weather.gov/**', r => r.fulfill({ status: 200, contentType: 'image/gif', body: GIF }));
await p.route('**://api.tidesandcurrents.noaa.gov/**', r => json(r, coopsResponse(r.request().url())));
await p.route('**://api.weather.gov/**', r => json(r, nwsResponse(r.request().url())));
await p.route('**://api.weather.gov/alerts/**', r => json(r, alertsResponse(r.request().url())));
await p.route('**://api.open-meteo.com/**', r => json(r, forecastResponse(r.request().url())));
await p.route('**://air-quality-api.open-meteo.com/**', r => json(r, airResponse(r.request().url())));
await p.route('**://archive-api.open-meteo.com/**', r => json(r, archiveResponse(r.request().url())));
await p.route('**://marine-api.open-meteo.com/**', r => json(r, marineResponse(r.request().url())));
/* Serve the real committed snapshot if there is one, so the crawl exercises
   the path a visitor actually takes. */
const snapPath = path.join(ROOT, 'data', 'climate.json');
if (fs.existsSync(snapPath)) {
  const snap = fs.readFileSync(snapPath);
  await p.route('**/data/climate.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: snap }));
}

/* Tokens that are never legitimate output.

   Deliberately plain substring matches, NOT word-boundary regexes. textContent
   concatenates a label straight onto its value, so a broken humidity tile reads
   "HumidityNaN%" — and /\bNaN\b/ does not match that, because "y" and "N" are
   both word characters. An earlier version of this crawl used \b and reported
   3057 passing checks against a page that was visibly displaying NaN. */
const BAD_TOKENS = ['NaN', 'undefined', '[object Object]', 'Infinity', '${', 'function (', '=> {'];

/* "null" needs value-level checking: it appears legitimately inside prose but
   never as a rendered figure. */
const VALUE_SELECTORS = '.stat-v, .kpi-v, .di-v, #tbl tbody td, table.qr tbody td, .ov-temp, .now-temp, .fc-hi, .fc-lo';

let seenErrors = 0;      // module-level: errors already reported

async function checkState(where) {
  const [body, values, overflow, visible] = await Promise.all([
    /* innerText, not textContent: textContent includes the contents of <script>
       elements, so the page's own inline JS tripped the "=> {" detector. */
    p.evaluate(() => document.body.innerText || ''),
    p.$$eval(VALUE_SELECTORS, els => els.map(e => (e.textContent || '').trim())).catch(() => []),
    p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    p.evaluate(() => document.getElementById('app') && !document.getElementById('app').hidden)
  ]);
  for (const token of BAD_TOKENS) {
    const i = body.indexOf(token);
    if (i >= 0) ok(`${where}: no "${token}" rendered`, false,
             body.slice(Math.max(0, i - 55), i + 25).replace(/\s+/g, ' '));
    else pass++;
  }
  /* Every rendered figure must be a real value, an em dash, or a formatted
     string — never a stringified null or an empty cell. */
  const badValues = values.filter(v => v === 'null' || v === 'NaN' || v === 'undefined' || v === '');
  ok(`${where}: all ${values.length} rendered values are real`, badValues.length === 0,
     `${badValues.length} bad: ${[...new Set(badValues)].join(', ')}`);
  ok(`${where}: app still visible`, visible === true);
  ok(`${where}: no horizontal overflow`, overflow <= 1, `${overflow}px`);
  ok(`${where}: no new JS errors`, jsErrors.length === seenErrors,
     jsErrors.slice(seenErrors).join(' | ').slice(0, 200));
  seenErrors = jsErrors.length;
}

/* Some buttons open the full-size radar over the page. Left open, it swallows
   every subsequent click and the crawl stalls on the next tab — so the modal is
   checked like any other state, then dismissed. Escape closing it is itself
   part of what this asserts: a modal that cannot be dismissed traps the reader
   exactly the way it trapped the crawl. */
async function closeAnyModal(where) {
  if (!(await p.$('#radarModal'))) return;
  await checkState(`${where} (radar viewer open)`);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(150);
  ok(`${where}: the radar viewer closes on Escape`, (await p.$('#radarModal')) === null);
}

await p.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
await p.waitForSelector('#app:not([hidden])', { timeout: 60000 });
await p.waitForTimeout(1500);

console.log('\n\x1b[1mcrawling every tab\x1b[0m');
const tabs = await p.$$eval('.tab', els => els.map(e => e.dataset.id));
step(`tabs found: ${tabs.join(', ')}`);

for (const tab of tabs) {
  await closeAnyModal(`before tab ${tab}`);
  await p.click(`.tab[data-id="${tab}"]`);
  await p.waitForTimeout(FAST ? 400 : 900);
  /* Wait for whichever view this tab renders. */
  await p.waitForSelector(tab === 'all' ? 'table.qr' : '.now-temp', { timeout: 60000 }).catch(() => {});
  if (tab !== 'all') await p.waitForSelector('#kpis .kpi', { timeout: 120000 }).catch(() => {});
  await p.waitForTimeout(FAST ? 300 : 700);
  await checkState(`tab ${tab}`);

  /* Every option of every select on the page. */
  for (const sel of ['#selPeriod', '#selGroup', '#selMonth', '#selCompare']) {
    const opts = await p.$$eval(`${sel} option`, os => os.map(o => o.value)).catch(() => []);
    if (!opts.length) continue;
    /* The compare list is 50-odd metrics; sample it unless running full. */
    const list = (sel === '#selCompare' && FAST) ? opts.filter((_, i) => i % 7 === 0) : opts;
    step(`${tab}: ${sel} — ${list.length} of ${opts.length} options`);
    for (const v of list) {
      await p.selectOption(sel, v).catch(() => {});
      await p.waitForTimeout(sel === '#selPeriod' ? (FAST ? 800 : 1500) : 150);
      if (sel === '#selPeriod') await p.waitForFunction(
        () => !document.querySelector('#climateStatus .spin'), { timeout: 120000 }).catch(() => {});
      await checkState(`${tab} ${sel}=${v}`);
    }
    /* Leave each select on its first option so the next loop starts clean. */
    await p.selectOption(sel, opts[0]).catch(() => {});
    await p.waitForTimeout(200);
  }

  /* Wait for the climate section to settle before touching anything that
     depends on it — the first version of this crawl clicked "Rebuild normals"
     first and then reported zero charts and zero table columns, which looked
     like a pass and was actually a blind spot. */
  const settle = async () => {
    await p.waitForFunction(() => !document.querySelector('#climateStatus .spin'),
      { timeout: 180000 }).catch(() => {});
    await p.waitForTimeout(FAST ? 250 : 600);
  };
  await settle();

  if (tab !== 'all') {
    const nCharts = await p.$$eval('#charts .chart', e => e.length);
    const nCols = await p.$$eval('#tbl thead th', e => e.length);
    const nKpi = await p.$$eval('#kpis .kpi', e => e.length);
    ok(`${tab}: charts actually rendered`, nCharts > 10, `${nCharts}`);
    ok(`${tab}: table actually rendered`, nCols > 20, `${nCols} columns`);
    ok(`${tab}: KPI cards actually rendered`, nKpi > 10, `${nKpi}`);
    step(`${tab}: ${nCharts} charts, ${nCols} columns, ${nKpi} KPI cards`);
  }

  /* Every KPI card opens a month. */
  const kpis = await p.$$('#kpis .kpi');
  for (let i = 0; i < kpis.length; i += (FAST ? 5 : 2)) {
    await kpis[i].click().catch(() => {});
    await p.waitForTimeout(120);
    await checkState(`${tab} KPI card ${i}`);
  }
  /* Every table row opens a month. */
  const rows = await p.$$('#tbl tbody tr');
  for (let i = 0; i < rows.length; i += (FAST ? 6 : 3)) {
    const rr = await p.$$('#tbl tbody tr');
    if (!rr[i]) continue;
    await rr[i].click().catch(() => {});
    await p.waitForTimeout(120);
    await checkState(`${tab} table row ${i}`);
  }
  /* Every sortable column heading, both directions. */
  const ths = await p.$$('#tbl thead th');
  step(`${tab}: ${ths.length} sortable columns`);
  for (let i = 0; i < ths.length; i += (FAST ? 6 : 2)) {
    const t2 = await p.$$('#tbl thead th');
    if (!t2[i]) continue;
    await t2[i].click().catch(() => {});
    await p.waitForTimeout(70);
    await t2[i].click().catch(() => {});
    await p.waitForTimeout(70);
    await checkState(`${tab} sort column ${i}`);
  }
  /* Hover chart marks to exercise every tooltip formatter. */
  const marks = await p.$$('#charts .chart svg .mark');
  step(`${tab}: ${marks.length} chart marks, sampling`);
  ok(`${tab}: charts carry hoverable marks`, tab === 'all' || marks.length > 50, `${marks.length}`);
  for (let i = 0; i < marks.length; i += Math.max(1, Math.floor(marks.length / (FAST ? 12 : 40)))) {
    await marks[i].hover().catch(() => {});
    await p.waitForTimeout(35);
  }

  /* Buttons LAST, because some of them rebuild or reset the view. */
  const btns = await p.$$eval('button:not([disabled])', els => els
    .filter(e => e.offsetParent !== null)
    .map(e => (e.textContent || '').trim().slice(0, 24)));
  step(`${tab}: ${btns.length} visible buttons`);
  for (let i = 0; i < btns.length; i++) {
    const handles = await p.$$('button:not([disabled])');
    const h = handles[i];
    if (!h) continue;
    const txt = (await h.textContent().catch(() => '') || '').trim().slice(0, 24);
    if (/Clear cached/i.test(txt)) continue;   // exercised separately; wipes state
    await h.click({ timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(FAST ? 120 : 260);
    await checkState(`${tab} button "${txt}"`);
    await closeAnyModal(`${tab} button "${txt}"`);
  }
  await settle();

  const tip = await p.textContent('#tip').catch(() => '');
  ok(`${tab}: tooltips render without placeholders`,
     !/NaN|undefined|\[object/.test(tip), tip.slice(0, 90));
  await p.mouse.move(2, 2);
  await checkState(`${tab} after hovering charts`);
}

console.log('\n\x1b[1mdark mode, crawled the same way\x1b[0m');
await p.click('#btnTheme');
await p.waitForTimeout(700);
for (const tab of tabs) {
  await p.click(`.tab[data-id="${tab}"]`);
  await p.waitForTimeout(FAST ? 400 : 900);
  if (tab !== 'all') await p.waitForSelector('#kpis .kpi', { timeout: 120000 }).catch(() => {});
  await p.waitForTimeout(400);
  await checkState(`dark tab ${tab}`);
  for (const sel of ['#selGroup', '#selCompare']) {
    const opts = await p.$$eval(`${sel} option`, os => os.map(o => o.value)).catch(() => []);
    for (const v of opts.filter((_, i) => i % (FAST ? 9 : 4) === 0)) {
      await p.selectOption(sel, v).catch(() => {});
      await p.waitForTimeout(140);
      await checkState(`dark ${tab} ${sel}=${v}`);
    }
  }
}
await p.click('#btnTheme');
await p.waitForTimeout(500);

console.log('\n\x1b[1mnarrow viewport, crawled the same way\x1b[0m');
for (const [w, h] of [[390, 844], [768, 1024], [1280, 800]]) {
  await p.setViewportSize({ width: w, height: h });
  await p.waitForTimeout(500);
  for (const tab of tabs) {
    await p.click(`.tab[data-id="${tab}"]`).catch(() => {});
    await p.waitForTimeout(FAST ? 350 : 700);
    await checkState(`${w}px tab ${tab}`);
  }
}
await p.setViewportSize({ width: 1440, height: 1000 });

console.log('\n\x1b[1mclear-cache path, on its own\x1b[0m');
p.on('dialog', d => d.accept());
await p.click('.tab[data-id="nmb"]');
await p.waitForSelector('#kpis .kpi', { timeout: 120000 }).catch(() => {});
const clearBtn = await p.$('#btnClearCache');
if (clearBtn) {
  await clearBtn.click().catch(() => {});
  await p.waitForTimeout(2500);
  await p.waitForFunction(() => !document.querySelector('#climateStatus .spin'), { timeout: 120000 }).catch(() => {});
  await checkState('after clearing the cache');
}

if (COVERAGE) {
  const entries = await p.coverage.stopJSCoverage();
  const out = path.join(ROOT, 'test', 'shots', 'coverage-crawl.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(entries.map(e => ({
    url: e.url, functions: e.functions.map(f => ({ ranges: f.ranges })) }))));
  reportCoverage(entries);
  console.log(`Coverage ranges written to ${out}`);
}
await browser.close(); srv.close();
console.log(`\n\x1b[1m${pass} checks passed, ${fail} failed\x1b[0m`);
if (problems.length) {
  console.log('\nDistinct problems:');
  [...new Set(problems.map(x => x.split(' — ')[0]))].slice(0, 30).forEach(x => console.log('  - ' + x));
}
console.log();
process.exit(fail ? 1 : 0);


/* Map V8's byte ranges back onto declared functions, and name the ones the
   crawl never entered. Not a percentage — a list, because the useful question
   is "which code did nobody look at", not "what number did we score". */
function reportCoverage(entries) {
  const FN = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  console.log('\n\x1b[1mcode the crawl never executed\x1b[0m');
  let totalFns = 0, missed = 0;
  for (const e of entries) {
    const file = (e.url || '').split('/').pop().split('?')[0];
    if (!/^(app|api|charts|climate|solar|units|config)\.js$/.test(file)) continue;
    const src = e.source || fs.readFileSync(path.join(ROOT, 'js', file), 'utf8');
    /* A byte offset is covered if any range containing it has count > 0. */
    const ranges = [];
    for (const f of e.functions) for (const r of f.ranges) ranges.push(r);
    const covered = off => {
      let best = null;
      for (const r of ranges) {
        if (off >= r.startOffset && off < r.endOffset &&
            (!best || (r.endOffset - r.startOffset) < (best.endOffset - best.startOffset))) best = r;
      }
      return best ? best.count > 0 : false;
    };
    const cold = [];
    let m;
    FN.lastIndex = 0;
    while ((m = FN.exec(src))) {
      totalFns++;
      /* Probe a byte just inside the body rather than at the declaration:
         the declaration is covered simply by the file being parsed. */
      const bodyAt = src.indexOf('{', m.index + m[0].length - 1);
      if (bodyAt < 0) continue;
      if (!covered(bodyAt + 1)) { cold.push(m[1]); missed++; }
    }
    if (cold.length) console.log(`  \x1b[33m${file}\x1b[0m  ${cold.length} never entered: ${cold.join(', ')}`);
    else console.log(`  \x1b[32m${file}\x1b[0m  every declared function ran`);
  }
  console.log(`  ${totalFns - missed}/${totalFns} declared functions executed`);
}
