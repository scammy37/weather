/* End-to-end checks. Serves the dashboard over http, intercepts every
   Open-Meteo request with synthetic data, then drives the real UI.
   Run: node test/e2e.mjs [--headed] [--keep-shots] */
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { archiveResponse, forecastResponse, marineResponse, airResponse, alertsResponse,
         coopsResponse, nwsResponse } from './mock.mjs';
import { createRequire } from 'module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'test', 'shots');

/* Read the real config so period-dependent expectations follow it rather than
   being hardcoded — the default has already changed once. */
const CFG = createRequire(import.meta.url)(path.join(ROOT, 'js/config.js'));
const DEFAULT_PERIOD = CFG.DEFAULT_PERIOD;
const DEFAULT_CHUNKS = Math.ceil(CFG.PERIODS[DEFAULT_PERIOD].years / 10);

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; results.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  → ' + extra : ''}`); }
}
const MIME = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json',
               '.svg':'image/svg+xml', '.css':'text/css' };

/* The default view is the three-home overview, which deliberately has no
   per-home KPI cards or charts. Anything asserting those has to open a home. */
/* sw.js intercepts every same-origin GET, and requests re-issued from a service
   worker bypass page.route entirely — which silently defeated the routes that
   hide data/climate.json. Every test context blocks service workers; the PWA
   behaviour itself is not what these tests are about. */
const CTX = { viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' };

/* A 1x1 GIF stands in for the radar loop: the tests care that the right URL is
   requested and that Refresh busts the cache, not what the pixels show. */
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
async function routeRadar(pg) {
  await pg.route('**://radar.weather.gov/**', r =>
    r.fulfill({ status: 200, contentType: 'image/gif', body: GIF }));
}

/* The standard mock set, in the order these routes must be registered: routes
   are matched in REVERSE registration order, so the narrow alerts pattern goes
   in AFTER the general api.weather.gov one or it is never reached.
   data/climate.json is deliberately left unrouted here — it is served from
   disk, which is what makes a section using this helper fast. */
async function routeAllMocks(pg) {
  const j = (route, body) => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
  await routeRadar(pg);
  await pg.route('**://api.tidesandcurrents.noaa.gov/**', r => j(r, coopsResponse(r.request().url())));
  await pg.route('**://api.weather.gov/**', r => j(r, nwsResponse(r.request().url())));
  await pg.route('**://api.weather.gov/alerts/**', r => j(r, alertsResponse(r.request().url())));
  await pg.route('**://api.open-meteo.com/**', r => j(r, forecastResponse(r.request().url())));
  await pg.route('**://air-quality-api.open-meteo.com/**', r => j(r, airResponse(r.request().url())));
  await pg.route('**://archive-api.open-meteo.com/**', r => j(r, archiveResponse(r.request().url())));
  await pg.route('**://marine-api.open-meteo.com/**', r => j(r, marineResponse(r.request().url())));
}

async function openHome(pg, id = 'nmb', timeout = 120000) {
  await pg.waitForSelector('#app:not([hidden])', { timeout: 60000 });
  await pg.click(`.tab[data-id="${id}"]`);
  await pg.waitForSelector('#kpis .kpi', { timeout });
}

function serve() {
  return new Promise(res => {
    const s = http.createServer((req, rep) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        rep.writeHead(404); return rep.end('not found');
      }
      rep.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      rep.end(fs.readFileSync(file));
    });
    s.listen(0, '127.0.0.1', () => res(s));
  });
}

/* Counts every intercepted call so the test can assert the app actually
   queried what it claims to query. */
const calls = { forecast: 0, archiveCore: 0, archiveExt: 0, marineLive: 0, marineArchive: 0, air: 0 };

async function main() {
  const args = process.argv.slice(2);
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: !args.includes('--headed') });

  /* --coverage records which app functions this suite actually executes, across
     EVERY context it opens, not just the main one. A pass count says nothing
     about what was never run; this does. Contexts get closed mid-suite, so
     coverage is harvested on close rather than at the end. */
  const COVERAGE = args.includes('--coverage');
  const covEntries = [];
  if (COVERAGE) {
    const realNewContext = browser.newContext.bind(browser);
    browser.newContext = async (...a) => {
      const c = await realNewContext(...a);
      const realNewPage = c.newPage.bind(c);
      const pages = [];
      c.newPage = async (...b) => {
        const pg = await realNewPage(...b);
        await pg.coverage.startJSCoverage({ resetOnNavigation: false });
        pages.push(pg);
        return pg;
      };
      const realClose = c.close.bind(c);
      c.close = async (...b) => {
        for (const pg of pages) {
          try { covEntries.push(...await pg.coverage.stopJSCoverage()); } catch (_) {}
        }
        return realClose(...b);
      };
      return c;
    };
  }
  const page = await (await browser.newContext(CTX)).newPage();

  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + e.message));

  const json = (route, body) => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });

  /* Hide the committed snapshot from this context: these sections test the
     path taken when no precomputed data is available. Section 19 covers the
     snapshot path with the fixture served explicitly. */
  await routeRadar(page);
  await page.route('**://api.tidesandcurrents.noaa.gov/**', r => json(r, coopsResponse(r.request().url())));
  await page.route('**://api.weather.gov/**', r => json(r, nwsResponse(r.request().url())));
  await page.route('**://api.weather.gov/alerts/**', r => json(r, alertsResponse(r.request().url())));
  await page.route('**/data/climate.json', r => r.fulfill({ status: 404, body: 'not found' }));
  await page.route('**://api.open-meteo.com/**',        r => { calls.forecast++;   json(r, forecastResponse(r.request().url())); });
  await page.route('**://air-quality-api.open-meteo.com/**', r => { calls.air++;   json(r, airResponse(r.request().url())); });
  await page.route('**://marine-api.open-meteo.com/**',  r => {
    const u = r.request().url();
    if (u.includes('start_date')) calls.marineArchive++; else calls.marineLive++;
    json(r, marineResponse(u));
  });
  await page.route('**://archive-api.open-meteo.com/**', r => {
    const u = r.request().url();
    if (u.includes('relative_humidity_2m_mean')) calls.archiveExt++; else calls.archiveCore++;
    json(r, archiveResponse(u));
  });

  console.log('\n\x1b[1m0. All-homes overview (the default view)\x1b[0m');
  await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
  ok('the overview is what loads first',
     (await page.getAttribute('.tab[data-id="all"]', 'class')).includes('on'));
  ok('all three homes are visible without clicking', (await page.$$('.ov-card')).length === 3);
  const ovTemps = await page.$$eval('.ov-card .ov-temp', e => e.map(x => x.textContent.trim()));
  ok('each card shows a current temperature', ovTemps.length === 3 && ovTemps.every(t => /^-?\d+°$/.test(t)),
     ovTemps.join(' '));
  ok('each card shows a 7-day strip',
     (await page.$$eval('.ov-card', cards => cards.every(c => c.querySelectorAll('.ov-day').length === 7))));
  ok('the quick-reference table is the first thing shown',
     (await page.textContent('#liveHost')).includes('Quick reference'));
  /* The old warmest/coolest strip and week-ahead ranking were removed on
     purpose: Bonita Springs wins both every day of the year, so neither told
     the reader anything. */
  const ovTxt = await page.textContent('#liveHost');
  ok('no panel ranks the homes against each other',
     !ovTxt.includes('Warmest right now') && !ovTxt.includes('Best week ahead'),
     'a ranking panel came back');
  ok('no "NaN" anywhere in the overview', !(await page.textContent('#liveHost')).includes('NaN'));
  ok('overview mode explains where the per-home detail lives',
     (await page.textContent('#climateStatus')).includes('pick it from the tabs'));
  ok('overview mode hides the single-home charts', (await page.$$('#charts .chart')).length === 0);
  /* Clicking a card is the drill-down path — but the radar band sits across
     the middle of the card and deliberately does NOT navigate, so this clicks
     the header rather than the card's geometric centre. Both behaviours are
     asserted: the ambiguity is the whole reason to pin it down. */
  await page.click('.ov-card:nth-child(2) .ov-head');
  await page.waitForSelector('.now-temp', { timeout: 15000 });
  ok('clicking a card opens that home',
     !(await page.getAttribute('.tab[data-id="all"]', 'class')).includes('on'));
  await page.click('.tab[data-id="all"]');
  await page.waitForSelector('.ov-card', { timeout: 15000 });
  /* Every other part of the card must still open the home, or the radar has
     quietly eaten the card's job. */
  for (const part of ['.ov-now', '.ov-week', '.ov-more']) {
    await page.click(`.ov-card:nth-child(2) ${part}`);
    await page.waitForSelector('.now-temp', { timeout: 15000 }).catch(() => {});
    ok(`clicking ${part} still opens the home`,
       (await page.$$('#radarModal')).length === 0 &&
       !(await page.getAttribute('.tab[data-id="all"]', 'class')).includes('on'),
       part);
    await page.click('.tab[data-id="all"]');
    await page.waitForSelector('.ov-card', { timeout: 15000 });
  }
  await page.click('.tab[data-id="all"]');
  await page.waitForSelector('.ov-card', { timeout: 15000 });
  ok('the All tab returns to the overview', (await page.$$('.ov-card')).length === 3);

  console.log('\n\x1b[1m1. Boot and live feed\x1b[0m');
  await page.click('.tab[data-id="nmb"]');
  await page.waitForSelector('.now-temp', { timeout: 15000 });
  ok('a single home opens to its full live panel', true);
  ok('forecast API called once per home', calls.forecast === 3, `${calls.forecast} calls`);
  ok('marine live called once per home', calls.marineLive === 3, `${calls.marineLive} calls`);
  ok('air quality called once per home', calls.air === 3, `${calls.air} calls`);

  const heroTemp = (await page.textContent('.now-temp') || '').trim();
  ok('hero temperature rendered', /^-?\d+°$/.test(heroTemp), heroTemp);
  ok('no "NaN" anywhere on the live panel',
     !(await page.textContent('#liveHost')).includes('NaN'));
  ok('all three home tabs show a temperature',
     (await page.$$eval('.tab .tmeta', els => els.map(e => e.textContent.trim())))
       .every(t => /^-?\d+°$/.test(t)));
  ok('7-day forecast shows 7 cards', (await page.$$('#fcStrip .fc')).length === 7,
     String((await page.$$('#fcStrip .fc')).length));
  ok('first forecast card is labelled Today',
     (await page.textContent('#fcStrip .fc .fc-day')).trim() === 'Today');
  ok('four hourly charts rendered with marks',
     (await page.$$eval('#hrTemp .mark, #hrPop .mark, #hrWind .mark, #hrRh .mark', e => e.length)) > 100);
  ok('ocean panel present', (await page.textContent('#liveHost')).includes('right now'));

  console.log('\n\x1b[1m2. Forecast day drill-down\x1b[0m');
  await page.click('#fcStrip .fc:nth-child(3)');
  await page.waitForSelector('#fcDetail .di');
  const fcRows = await page.$$eval('#fcDetail .di', e => e.length);
  ok('clicking a forecast day opens its detail', fcRows >= 12, `${fcRows} fields`);
  ok('detail includes sunrise and sunset',
     (await page.textContent('#fcDetail')).includes('Sunrise') &&
     (await page.textContent('#fcDetail')).includes('Sunset'));
  await page.click('#fcStrip .fc:nth-child(3)');
  ok('clicking again closes it', (await page.$$('#fcDetail .di')).length === 0);

  console.log('\n\x1b[1m3. Climate normals build\x1b[0m');
  await page.waitForSelector('#kpis .kpi', { timeout: 90000 });
  ok(`archive core requested (${DEFAULT_CHUNKS} decade chunk(s) for ${CFG.PERIODS[DEFAULT_PERIOD].years} years)`,
     calls.archiveCore >= DEFAULT_CHUNKS, `${calls.archiveCore}`);
  ok('extended variables requested separately', calls.archiveExt >= DEFAULT_CHUNKS, `${calls.archiveExt}`);
  ok('marine archive requested', calls.marineArchive >= 5, `${calls.marineArchive}`);
  const kpiCount = (await page.$$('#kpis .kpi')).length;
  ok('KPI cards rendered', kpiCount >= 18, `${kpiCount} cards`);
  ok('no "NaN" in the KPI cards', !(await page.textContent('#kpis')).includes('NaN'));
  ok('KPI sparklines drawn', (await page.$$('#kpis .kpi-spark svg')).length >= 15);

  const chartCount = (await page.$$('#charts .chart')).length;
  ok('chart grid populated', chartCount >= 25, `${chartCount} charts`);
  const svgWithMarks = await page.$$eval('#charts .chart svg',
     els => els.filter(s => s.querySelectorAll('rect,path,circle').length > 0).length);
  ok('every chart drew marks', svgWithMarks === chartCount, `${svgWithMarks}/${chartCount}`);
  ok('no chart reported an error',
     !(await page.textContent('#charts')).includes('Chart unavailable'));

  console.log('\n\x1b[1m4. Chart interaction\x1b[0m');
  const firstBar = await page.$('#charts .chart svg .mark');
  await firstBar.hover();
  await page.waitForFunction(() => document.getElementById('tip').style.display === 'block', { timeout: 4000 });
  const tipText = await page.textContent('#tip');
  ok('hovering a mark shows a tooltip', tipText.length > 3, tipText);
  await page.mouse.move(5, 5);

  console.log('\n\x1b[1m5. Month selection syncs everywhere\x1b[0m');
  await page.selectOption('#selMonth', '6');
  await page.waitForSelector('#detail.show');
  const dTitle = await page.textContent('#detailTitle');
  ok('detail panel opens for July', dTitle.includes('July'), dTitle);
  const dFields = (await page.$$('#detailGrid .di')).length;
  ok('detail lists many measures', dFields >= 30, `${dFields} fields`);
  ok('detail groups are labelled', (await page.$$('#detailGrid .dgroup-title')).length >= 5);
  ok('table row for July is highlighted',
     await page.$eval('#tbl tbody tr.on td', td => td.textContent.trim()) === 'July');
  ok('no "NaN" in the month detail', !(await page.textContent('#detailGrid')).includes('NaN'));

  console.log('\n\x1b[1m6. Sortable table\x1b[0m');
  const nCols = (await page.$$('#tbl thead th')).length;
  ok('table has a column per available measure', nCols >= 40, `${nCols} columns`);
  ok('table has 12 rows', (await page.$$('#tbl tbody tr')).length === 12);
  const monthOrder = () => page.$$eval('#tbl tbody tr td:first-child', e => e.map(x => x.textContent.trim()));
  ok('default order is January first', (await monthOrder())[0] === 'January');

  /* Sort by average high, descending first. */
  const hiIdx = await page.$$eval('#tbl thead th', ths => ths.findIndex(t => t.dataset.k === 'avgHigh'));
  await page.click(`#tbl thead th:nth-child(${hiIdx + 1})`);
  const sortedVals = await page.$$eval(`#tbl tbody tr td:nth-child(${hiIdx + 1})`, e => e.map(x => parseFloat(x.textContent)));
  ok('sorting by avg high is descending', sortedVals.every((v, i) => i === 0 || sortedVals[i - 1] >= v),
     JSON.stringify(sortedVals));
  ok('hottest month sorts to the top', sortedVals[0] === Math.max(...sortedVals));
  await page.click(`#tbl thead th:nth-child(${hiIdx + 1})`);
  const asc = await page.$$eval(`#tbl tbody tr td:nth-child(${hiIdx + 1})`, e => e.map(x => parseFloat(x.textContent)));
  ok('clicking again reverses to ascending', asc.every((v, i) => i === 0 || asc[i - 1] <= v));
  await page.click('#tbl thead th:nth-child(1)');
  ok('sorting by month restores calendar order', (await monthOrder())[0] === 'January');

  console.log('\n\x1b[1m7. Clicking a table row opens that month\x1b[0m');
  await page.click('#tbl tbody tr:nth-child(4)');
  ok('row click opens April', (await page.textContent('#detailTitle')).includes('April'));

  console.log('\n\x1b[1m8. Comparison view\x1b[0m');
  /* No snapshot is served in this context, so the comparison asks before
     spending ~1,800 weighted API calls per extra home. */
  await page.waitForSelector('#btnLoadCompare', { timeout: 20000 });
  ok('comparison asks before building homes live', true);
  ok('the prompt states the cost',
     (await page.textContent('#compareNote')).includes('weighted API calls'));
  await page.click('#btnLoadCompare');
  await page.waitForFunction(() => document.querySelectorAll('#compareTableBox tbody tr').length === 3, { timeout: 120000 });
  ok('all three homes appear once opted in', true);
  ok('comparison chart has a legend with 3 entries',
     (await page.$$eval('#cmpSvg g rect', e => e.length)) >= 3);
  ok('comparison chart draws 3 lines',
     (await page.$$eval('#cmpSvg path', e => e.length)) === 3,
     String(await page.$$eval('#cmpSvg path', e => e.length)));
  for (const key of ['precipTotal', 'sst', 'snowfall', 'sunriseMin', 'daylight', 'hdd']) {
    await page.selectOption('#selCompare', key);
    await page.waitForTimeout(120);
    const t = await page.textContent('#compareTableBox');
    ok(`comparison renders for "${key}" without NaN`, !t.includes('NaN'));
  }
  await page.selectOption('#selCompare', 'sunriseMin');
  const sunriseCell = await page.$eval('#compareTableBox tbody tr td:nth-child(2)', e => e.textContent.trim());
  ok('clock-time metrics format as times, not raw minutes', /(AM|PM)/.test(sunriseCell), sunriseCell);

  console.log('\n\x1b[1m9. Chart group filter\x1b[0m');
  for (const g of ['temp', 'water', 'sun', 'ocean', 'sky', 'air', 'thresh', 'energy']) {
    await page.selectOption('#selGroup', g);
    await page.waitForTimeout(90);
    const n = (await page.$$('#charts .chart')).length;
    ok(`group "${g}" shows charts`, n > 0, `${n}`);
  }
  await page.selectOption('#selGroup', 'all');

  console.log('\n\x1b[1m10. Switching homes\x1b[0m');
  await page.click('.tab[data-id="rockaway"]');
  await page.waitForFunction(() => document.querySelectorAll('#kpis .kpi').length > 0, { timeout: 90000 });
  ok('Rockaway becomes the active tab',
     (await page.getAttribute('.tab[data-id="rockaway"]', 'class')).includes('on'));
  const rockText = await page.textContent('#liveHost');
  ok('inland caveat shown for Rockaway', rockText.includes('inland'));
  ok('nearest-coast reference named', rockText.includes('Point Pleasant'));
  ok('Rockaway has a snowfall chart',
     (await page.textContent('#charts')).includes('Average snowfall'));
  await page.click('.tab[data-id="bonita"]');
  await page.waitForFunction(() => document.querySelectorAll('#kpis .kpi').length > 0, { timeout: 90000 });
  ok('Bonita Springs has no snowfall chart (correctly hidden)',
     !(await page.textContent('#charts')).includes('Average snowfall'));
  ok('Bonita shows the Gulf of Mexico', (await page.textContent('#liveHost')).includes('Gulf of Mexico'));

  console.log('\n\x1b[1m11. Normals period switch\x1b[0m');
  await page.click('.tab[data-id="nmb"]');
  await page.waitForFunction(() => document.querySelectorAll('#kpis .kpi').length > 0, { timeout: 90000 });
  const before = calls.archiveCore;
  const altPeriod = Object.keys(CFG.PERIODS).find(k => k !== DEFAULT_PERIOD);
  await page.selectOption('#selPeriod', altPeriod);
  await page.waitForFunction(() => document.querySelectorAll('#kpis .kpi').length > 0, { timeout: 120000 });
  ok('changing the period refetches the archive', calls.archiveCore > before);
  ok('table note names the new period',
     (await page.textContent('#tableNote')).includes(altPeriod.slice(0, 4)));
  await page.selectOption('#selPeriod', DEFAULT_PERIOD);
  await page.waitForFunction(() => document.querySelectorAll('#kpis .kpi').length > 0, { timeout: 90000 });

  console.log('\n\x1b[1m12. Caching\x1b[0m');
  const cachedKeys = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('wx-v1:')));
  ok('aggregates are cached in localStorage', cachedKeys.length >= 3, JSON.stringify(cachedKeys));
  const cacheBytes = await page.evaluate(() =>
    Object.keys(localStorage).filter(k => k.startsWith('wx-v1:')).reduce((s, k) => s + localStorage.getItem(k).length, 0));
  ok('cache stays far below the 5 MB quota', cacheBytes < 1_500_000, `${(cacheBytes / 1024).toFixed(0)} KB`);
  const beforeReload = calls.archiveCore;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openHome(page, 'nmb', 30000);
  ok('a reload serves normals from cache without refetching',
     calls.archiveCore === beforeReload, `${calls.archiveCore} vs ${beforeReload}`);

  console.log('\n\x1b[1m13. CSV export\x1b[0m');
  const dl = page.waitForEvent('download', { timeout: 10000 });
  await page.click('#btnCsv');
  const download = await dl;
  const csvPath = path.join(SHOTS, 'export.csv');
  await download.saveAs(csvPath);
  const csv = fs.readFileSync(csvPath, 'utf8');
  const csvLines = csv.trim().split('\n');
  ok('CSV filename names the location and period',
     download.suggestedFilename() === `nmb-climate-normals-${DEFAULT_PERIOD}.csv`,
     download.suggestedFilename());
  ok('CSV has a header plus 12 month rows', csvLines.length >= 20, `${csvLines.length} lines`);
  ok('CSV names the data source', csv.includes('Open-Meteo'));
  ok('CSV rows carry values, not blanks',
     csvLines[csvLines.length - 1].split(',').filter(c => c !== '').length > 20);

  console.log('\n\x1b[1m14. Dark mode\x1b[0m');
  await page.click('#btnTheme');
  await page.waitForTimeout(400);
  ok('dark class applied', await page.evaluate(() => document.body.classList.contains('dark')));
  const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ok('page background actually changed', darkBg === 'rgb(13, 13, 13)', darkBg);
  ok('charts re-rendered in dark mode',
     (await page.$$eval('#charts .chart svg', e => e.filter(s => s.children.length).length)) > 20);
  await page.screenshot({ path: path.join(SHOTS, '03-dark.png'), fullPage: false });
  await page.click('#btnTheme');
  await page.waitForTimeout(400);
  ok('theme toggles back to light', !(await page.evaluate(() => document.body.classList.contains('dark'))));

  console.log('\n\x1b[1m15. Diagnostics panel\x1b[0m');
  const diagRows = (await page.$$('#diagTbl tr')).length;
  ok('diagnostics lists the requests made', diagRows > 5, `${diagRows} rows`);
  ok('diagnostics shows successes', (await page.textContent('#diagTbl')).includes('ok'));
  const notes = await page.textContent('#sourceNotes');
  for (const feed of ['ERA5', 'Marine API', 'Air Quality', 'National Weather Service', 'NOAA solar'])
    ok(`source notes name the ${feed} feed`, notes.includes(feed), notes.slice(0, 120));

  console.log('\n\x1b[1m16. Failure handling\x1b[0m');
  const page2 = await (await browser.newContext(CTX)).newPage();
  await routeRadar(page2);
  await page2.route('**://api.tidesandcurrents.noaa.gov/**', r => json(r, coopsResponse(r.request().url())));
  await page2.route('**://api.weather.gov/**', r => json(r, nwsResponse(r.request().url())));
  await page2.route('**://api.weather.gov/alerts/**', r => json(r, alertsResponse(r.request().url())));
  await page2.route('**/data/climate.json', r => r.fulfill({ status: 404, body: 'not found' }));
  await page2.route('**://*.open-meteo.com/**', r => r.abort('failed'));
  await page2.route('**/data/climate.json', r => r.fulfill({ status: 404, body: 'not found' }));
  await page2.route('**://api.open-meteo.com/**', r => r.abort('failed'));
  await page2.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  await page2.waitForSelector('#app:not([hidden])', { timeout: 60000 });
  ok('page still renders when every API is down', true);
  const bannerTxt = await page2.textContent('#banners');
  ok('a clear offline banner is shown', bannerTxt.includes('No live data'), bannerTxt.slice(0, 80));
  ok('the overview degrades to per-card notices rather than a blank page',
     (await page2.$$('.ov-card')).length === 3 &&
     (await page2.textContent('#liveHost')).includes('Live feed unavailable'));
  /* The normals error belongs to a single home, so open one. Wait for the
     settled state rather than the first appearance of an error element — the
     panel legitimately cycles through loading while retries are in flight. */
  await page2.click('.tab[data-id="nmb"]');
  /* Wait for the load to actually settle rather than for text to appear —
     the panel legitimately shows a spinner while retries are in flight, and
     racing the render made this assertion flaky. */
  await page2.waitForFunction(
    () => Object.values(S.climState).some(v => v === 'error' || v === 'ready'),
    { timeout: 90000 });
  const climTxt = (await page2.textContent('#climateStatus')).trim();
  ok('normals failure is explained, not silent',
     climTxt.includes('Could not build'), climTxt.slice(0, 200));
  await page2.screenshot({ path: path.join(SHOTS, '04-offline.png') });
  await page2.close();

  console.log('\n\x1b[1m17. Partial failure — archive up, marine down\x1b[0m');
  const page3 = await (await browser.newContext(CTX)).newPage();
  await routeRadar(page3);
  await page3.route('**://api.tidesandcurrents.noaa.gov/**', r => json(r, coopsResponse(r.request().url())));
  await page3.route('**://api.weather.gov/**', r => json(r, nwsResponse(r.request().url())));
  await page3.route('**://api.weather.gov/alerts/**', r => json(r, alertsResponse(r.request().url())));
  await page3.route('**/data/climate.json', r => r.fulfill({ status: 404, body: 'not found' }));
  await page3.route('**://api.open-meteo.com/**',   r => json(r, forecastResponse(r.request().url())));
  await page3.route('**://air-quality-api.open-meteo.com/**', r => json(r, airResponse(r.request().url())));
  await page3.route('**://archive-api.open-meteo.com/**', r => json(r, archiveResponse(r.request().url())));
  await page3.route('**://marine-api.open-meteo.com/**', r => r.abort('failed'));
  await page3.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  await openHome(page3, 'nmb');
  ok('normals still build when the marine API is down',
     (await page3.$$('#charts .chart')).length > 20);
  ok('ocean charts are hidden rather than blank',
     !(await page3.textContent('#charts')).includes('Swimmable water'));
  ok('the missing ocean data is explained',
     (await page3.textContent('#climateStatus')).includes('Ocean temperature'));
  await page3.close();

  console.log('\n\x1b[1m18. Mobile layout\x1b[0m');
  const m = await (await browser.newContext({ ...CTX, viewport: { width: 390, height: 844 } })).newPage();
  await routeRadar(m);
  await m.route('**://api.tidesandcurrents.noaa.gov/**', r => json(r, coopsResponse(r.request().url())));
  await m.route('**://api.weather.gov/**', r => json(r, nwsResponse(r.request().url())));
  await m.route('**://api.weather.gov/alerts/**', r => json(r, alertsResponse(r.request().url())));
  await m.route('**/data/climate.json', r => r.fulfill({ status: 404, body: 'not found' }));
  await m.route('**://api.open-meteo.com/**',   r => json(r, forecastResponse(r.request().url())));
  await m.route('**://air-quality-api.open-meteo.com/**', r => json(r, airResponse(r.request().url())));
  await m.route('**://archive-api.open-meteo.com/**', r => json(r, archiveResponse(r.request().url())));
  await m.route('**://marine-api.open-meteo.com/**',  r => json(r, marineResponse(r.request().url())));
  await m.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  await openHome(m, 'nmb');
  const overflow = await m.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('no horizontal page overflow at 390px', overflow <= 1, `${overflow}px`);
  const chartOverflow = await m.evaluate(() => {
    const bad = [];
    document.querySelectorAll('#charts .chart svg').forEach((s, i) => {
      if (s.getBoundingClientRect().width > s.parentElement.clientWidth + 2) bad.push(i);
    });
    return bad.length;
  });
  ok('charts fit their containers on mobile', chartOverflow === 0, `${chartOverflow} overflowing`);
  await m.screenshot({ path: path.join(SHOTS, '05-mobile.png'), fullPage: false });
  await m.close();

  console.log('\n\x1b[1m18b. Severe weather alerts\x1b[0m');
  await page.click('.tab[data-id="all"]');
  await page.waitForSelector('.ov-card', { timeout: 15000 });
  ok('an active alert is surfaced', (await page.$$('#alertHost .alert-card')).length >= 1);
  const alertTxt = await page.textContent('#alertHost');
  ok('it names the event and the home', alertTxt.includes('Hurricane Watch') && alertTxt.includes('Myrtle'));
  ok('severity is stated', alertTxt.includes('Severe'));
  ok('a severe alert uses the error styling, not a mild one',
     (await page.$$('#alertHost .banner.err')).length >= 1);
  await page.click('#alertHost .alert-toggle');
  await page.waitForSelector('#alertHost .alert-body', { timeout: 5000 });
  ok('the full NWS text expands', (await page.textContent('#alertHost .alert-body')).includes('hurricane conditions'));
  ok('and the official instruction is shown',
     (await page.textContent('#alertHost .alert-body')).includes('evacuation plan'));
  await page.click('#alertHost .alert-toggle');
  ok('it collapses again', (await page.$$('#alertHost .alert-body')).length === 0);
  /* On a home with no alert of its own, the other home's alert must still surface. */
  await page.click('.tab[data-id="bonita"]');
  await page.waitForSelector('.now-temp', { timeout: 15000 });
  ok("another home's alert is still flagged",
     (await page.textContent('#alertHost')).includes('at your other home'));
  await page.click('.tab[data-id="all"]');
  await page.waitForSelector('.ov-card', { timeout: 15000 });

  console.log('\n\x1b[1m18c. Quick reference table\x1b[0m');
  await page.waitForSelector('table.qr', { timeout: 15000 });
  ok('one row per home', (await page.$$('table.qr tbody tr')).length === 3);
  const qrHead = await page.$$eval('table.qr thead th', e => e.map(x => x.textContent.trim()));
  for (const col of ['Now', 'Feels', 'Today', 'Rain', 'Humidity', 'Wind', 'Water', 'Sunset', 'Alert'])
    ok(`has a "${col}" column`, qrHead.includes(col), qrHead.join(', '));
  const qrTxt = await page.textContent('table.qr');
  ok('every home is named', ['Myrtle', 'Bonita', 'Rockaway'].every(n => qrTxt.includes(n)));
  ok('no NaN in the table', !qrTxt.includes('NaN'));
  ok('it does not crown a winner', !qrTxt.toLowerCase().includes('best') && !qrTxt.includes('place to be'));
  ok('an active alert shows as a count', (await page.$$('table.qr .qr-alert')).length >= 1);
  /* Read the row's own identity rather than assuming which home is third:
     this assertion was pinned to nth-child(3) and broke the moment the homes
     were reordered, which is a test coupled to the wrong thing. */
  const thirdId = await page.$eval('table.qr tbody tr:nth-child(3)', r => r.dataset.l || '');
  ok('each quick-reference row knows which home it is', thirdId !== '', 'no data-id on the row');
  await page.click('table.qr tbody tr:nth-child(3)');
  await page.waitForSelector('.now-temp', { timeout: 15000 });
  ok('clicking a row opens that home',
     (await page.getAttribute(`.tab[data-id="${thirdId}"]`, 'class')).includes('on'), thirdId);
  await page.click('.tab[data-id="all"]');
  await page.waitForSelector('.ov-card', { timeout: 15000 });

  console.log('\n\x1b[1m18g. The homes appear in one consistent order everywhere\x1b[0m');
  /* Asked for north to south: Rockaway, North Myrtle Beach, Bonita Springs.
     An order that holds on the tabs but not in the table is worse than any
     order, because the reader stops being able to scan by position. */
  const WANT = ['rockaway', 'nmb', 'bonita'];
  const tabOrder = await page.$$eval('.tab[data-id]', ts =>
    ts.map(t => t.dataset.id).filter(id => id !== 'all'));
  ok('the tabs run north to south', JSON.stringify(tabOrder) === JSON.stringify(WANT), tabOrder.join(', '));
  const qrOrder = await page.$$eval('table.qr tbody tr', rs => rs.map(r => r.dataset.l));
  ok('the quick-reference table uses the same order',
     JSON.stringify(qrOrder) === JSON.stringify(WANT), qrOrder.join(', '));
  const sub = await page.textContent('#headerSub');
  ok('the header subtitle lists the homes in that order too',
     sub.indexOf('Rockaway') < sub.indexOf('North Myrtle') && sub.indexOf('North Myrtle') < sub.indexOf('Bonita'),
     sub.trim());
  ok('and it is derived from the config rather than written out by hand',
     sub.includes('Rockaway NJ') && sub.includes('Bonita Springs FL'), sub.trim());
  const cardOrder = await page.$$eval('.ov-card .ov-name', ns => ns.map(n => n.textContent.trim()));
  ok('the overview cards use the same order',
     /^Rockaway/.test(cardOrder[0]) && /^North Myrtle/.test(cardOrder[1]) && /^Bonita/.test(cardOrder[2]),
     cardOrder.join(' | '));
  const cmpOrder = await page.$$eval('#compare .cmp-key, #compare .lg-item, #compare .legend span',
    ns => ns.map(n => n.textContent.trim()).filter(Boolean));
  if (cmpOrder.length >= 3)
    ok('the comparison legend uses the same order',
       /Rockaway/.test(cmpOrder[0]) && /Myrtle/.test(cmpOrder[1]) && /Bonita/.test(cmpOrder[2]),
       cmpOrder.slice(0, 3).join(' | '));
  /* Colour must follow the home, not its position, or reordering silently
     recolours every chart in the dashboard. */
  const dots = await page.$$eval('table.qr tbody tr', rs => rs.map(r => ({
    id: r.dataset.l, colour: (r.querySelector('.qr-dot') || {}).style?.background || '' })));
  const green = dots.find(d => d.id === 'rockaway');
  ok('Rockaway kept its own accent colour after the reorder',
     /27, 175, 122|1baf7a|25, 158, 112|199e70/.test(green.colour), JSON.stringify(dots));

  console.log('\n\x1b[1m18f. The live radar row\x1b[0m');
  /* Its own section at the top of the overview, three equal squares. Inside
     the cards it had to be either a square that squeezed the readings into a
     narrow column or a band too short to read; neither worked. */
  await page.waitForFunction(() => document.querySelectorAll('#radarRow .ov-radar-btn').length === 3,
                             null, { timeout: 25000 });
  ok('the radar row holds one radar per home', (await page.$$('#radarRow .ov-radar-btn')).length === 3);
  ok('no radar is left inside the home cards', (await page.$$('.ov-card .ov-radar-btn')).length === 0);
  ok('the row sits below the quick-reference table',
     await page.evaluate(() => {
       const r = document.getElementById('radarRow'), q = document.querySelector('table.qr');
       return !!(r && q) && r.getBoundingClientRect().top > q.getBoundingClientRect().top;
     }));
  /* The three fill the row in equal parts with only a hairline between them,
     rather than sitting as small squares in wide empty columns. */
  const fill = await page.evaluate(() => {
    const grid = document.querySelector('.rr-grid');
    const bs = [...document.querySelectorAll('#radarRow .ov-radar-btn')].map(b => b.getBoundingClientRect());
    const gaps = [bs[1].left - bs[0].right, bs[2].left - bs[1].right];
    return { gridW: Math.round(grid.getBoundingClientRect().width),
             covered: Math.round(bs.reduce((s, r) => s + r.width, 0)), gaps: gaps.map(Math.round) };
  });
  ok('the radars span the row rather than floating in empty columns',
     fill.covered / fill.gridW > 0.95, JSON.stringify(fill));
  ok('with only a hairline between them', fill.gaps.every(g => g <= 10), JSON.stringify(fill.gaps));

  const readBoxes = pg => pg.$$eval('#radarRow .ov-radar-btn', bs => bs.map(b => {
    const r = b.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) };
  }));
  const boxes = await readBoxes(page);
  ok('every radar is square', boxes.every(b => Math.abs(b.w - b.h) <= 1), JSON.stringify(boxes));
  ok('all three are the same size',
     new Set(boxes.map(b => b.w)).size === 1, JSON.stringify(boxes.map(b => b.w)));
  ok('and none is so small it shows nothing', boxes.every(b => b.w >= 120), JSON.stringify(boxes));
  ok('the three sit on one row rather than stacked',
     new Set(boxes.map(b => b.top)).size === 1, JSON.stringify(boxes.map(b => b.top)));

  const cells = await page.$$eval('#radarRow .rr-cell', cs => cs.map(c => ({
    name: (c.querySelector('.rr-name') || {}).textContent || '',
    src: (c.querySelector('.ov-radar-img') || {}).src || '',
    alt: (c.querySelector('.ov-radar-img') || {}).alt || '',
    cap: (c.querySelector('.ov-radar-cap') || {}).textContent || ''
  })));
  ok('each square is labelled with its home',
     /Rockaway/.test(cells[0].name) && /Myrtle/.test(cells[1].name) && /Bonita/.test(cells[2].name),
     cells.map(c => c.name).join(' | '));
  /* The three homes really are under three different dishes; a row showing the
     same station three times would be worse than no row. */
  const want = ['KOKX', 'KLTX', 'KTBW'];
  cells.forEach((c, i) => ok(`${want[i]} is the station shown for ${c.name.trim()}`,
    c.src.includes(want[i]) && c.cap.includes(want[i]), `${c.cap} / ${c.src}`));
  ok('each image names the place it covers in its alt text',
     cells.every(c => /radar loop/i.test(c.alt)));

  await page.click('#radarRow .ov-radar-btn');
  await page.waitForSelector('#radarModal', { timeout: 10000 });
  const modalTxt = await page.textContent('#radarModal');
  ok('clicking a square opens the full-size radar', modalTxt.includes('Rockaway'), modalTxt.slice(0, 90));
  ok('the viewer is announced as a dialog',
     (await page.getAttribute('#radarModal', 'role')) === 'dialog' &&
     (await page.getAttribute('#radarModal', 'aria-modal')) === 'true');
  ok('it links out to the full NWS radar',
     ((await page.getAttribute('#radarModal a.btn', 'href')) || '').includes('radar.weather.gov/station'));
  ok('the page behind is locked while it is open',
     await page.evaluate(() => document.body.classList.contains('modal-open')));
  const rrBefore = await page.getAttribute('#radarModal img', 'src');
  await page.waitForTimeout(1100);
  await page.click('#radarModal .js-radar-refresh');
  await page.waitForTimeout(300);
  ok('Refresh fetches new sweeps rather than the cached copy',
     rrBefore !== await page.getAttribute('#radarModal img', 'src'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  ok('Escape closes it', (await page.$$('#radarModal')).length === 0);
  ok('and the page scrolls again', !(await page.evaluate(() => document.body.classList.contains('modal-open'))));

  await page.$eval('#radarRow .ov-radar-btn', b => b.focus());
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  ok('a square opens from the keyboard too', (await page.$$('#radarModal')).length === 1);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  /* The regression that actually reached the user: a breakpoint at 1080px
     stacked the three radars vertically, so anyone whose window was not
     near-maximised saw them on top of each other. Laptop widths are checked
     explicitly now rather than assumed from one 1440px screenshot. */
  for (const w of [1280, 1024, 860]) {
    await page.setViewportSize({ width: w, height: 1000 });
    await page.waitForTimeout(250);
    const b = await readBoxes(page);
    ok(`at ${w}px the three radars are still side by side`,
       b.length === 3 && new Set(b.map(x => x.top)).size === 1, JSON.stringify(b.map(x => x.top)));
    ok(`at ${w}px they are still square and equal`,
       b.every(x => Math.abs(x.w - x.h) <= 1) && new Set(b.map(x => x.w)).size === 1,
       JSON.stringify(b));
    ok(`at ${w}px the page does not scroll sideways`,
       await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1));
  }
  await page.setViewportSize(CTX.viewport);
  await page.waitForTimeout(250);

  await page.click('.tab[data-id="nmb"]');
  /* A single home still gets the full panel, with its own station. */
  await page.click('.tab[data-id="nmb"]');
  await page.waitForSelector('#radarPanel', { timeout: 20000 });
  await page.waitForFunction(() => {
    const n = document.getElementById('radarNote');
    return n && n.textContent.includes('Station');
  }, { timeout: 20000 }).catch(() => {});
  const radarTxt = await page.textContent('#radarPanel');
  ok('a single home still shows the full radar panel', /Station\s+K[A-Z]{3}/.test(radarTxt), radarTxt.slice(0, 120));
  ok('it is that home\'s station', radarTxt.includes('KLTX'), radarTxt.slice(0, 120));
  ok('the radar image points at the NWS loop',
     (await page.getAttribute('.js-radar-wrap img', 'src') || '').includes('radar.weather.gov'));
  ok('it links out to weather.gov',
     (await page.getAttribute('.js-radar-wrap a', 'href') || '').includes('radar.weather.gov/station'));
  ok('the image carries a descriptive alt text',
     ((await page.getAttribute('.js-radar-wrap img', 'alt')) || '').includes('radar loop'));
  const radarBefore = await page.getAttribute('.js-radar-wrap img', 'src');
  await page.waitForTimeout(1100);
  await page.click('#radarPanel .js-radar-refresh');
  await page.waitForTimeout(300);
  ok('Refresh fetches a new frame rather than the cached one',
     radarBefore !== await page.getAttribute('.js-radar-wrap img', 'src'));
  ok('the station came from the NWS point lookup, not the fallback',
     !radarTxt.includes('default for this area'), radarTxt.slice(0, 90));
  ok('a single home has no radar picker — there is nothing to pick',
     (await page.$$('.radar-pick')).length === 0);
  await page.click('.tab[data-id="all"]');
  await page.waitForSelector('.ov-card', { timeout: 15000 });

  console.log('\n\x1b[1m18d. Units come from the API, not from assumptions\x1b[0m');
  await page.click('.tab[data-id="nmb"]');
  await page.waitForSelector('.now-temp', { timeout: 15000 });
  const statTxt = await page.textContent('#liveHost');
  /* The mock declares visibility in feet; 52000 ft is 9.8 mi, not 32 mi. */
  const visMatch = /([\d.]+) mi/.exec(statTxt);
  ok('visibility is converted from the declared unit', visMatch != null, statTxt.slice(0, 60));
  ok('and lands in a physically plausible range',
     visMatch && +visMatch[1] > 0 && +visMatch[1] < 250, visMatch && visMatch[1]);
  ok('the tile states which unit the API reported', statTxt.includes('reported in'));
  const diagTxt = await page.textContent('#sourceNotes');
  ok('the sources panel audits the units received', diagTxt.includes('every figure is converted from the unit the API declares'.slice(0, 30)) || diagTxt.includes('Units'));
  ok('and lists the declared units for this session', /temperature\s*°F|temperature .?F/.test(diagTxt), diagTxt.slice(diagTxt.indexOf('Units'), diagTxt.indexOf('Units') + 130));
  ok('no kilometres anywhere on the page',
     !(await page.textContent('body')).match(/\d\s?km\b/), 'found a km measurement');
  ok('elevation is shown in feet', /\d+ ft above sea level/.test(statTxt));

  console.log('\n\x1b[1m18e. Backup data sources\x1b[0m');
  ok('the measured water temperature is preferred over the model',
     statTxt.includes('measured at'), statTxt.slice(statTxt.indexOf('Water temp'), statTxt.indexOf('Water temp') + 90));
  ok('the model is shown against the gauge as a cross-check',
     statTxt.includes('Model vs gauge'));
  ok('the sources panel names the tide gauge', diagTxt.includes('NOAA CO-OPS'));
  ok('and names the backup provider', diagTxt.includes('Backup provider'));

  /* Open-Meteo down, everything else up: the page must fall back, not blank. */
  const fbCtx = await browser.newContext(CTX);
  const fb = await fbCtx.newPage();
  await routeRadar(fb);
  await fb.route('**://api.tidesandcurrents.noaa.gov/**', r => json(r, coopsResponse(r.request().url())));
  await fb.route('**://api.weather.gov/**', r => json(r, nwsResponse(r.request().url())));
  await fb.route('**://api.weather.gov/alerts/**', r => json(r, alertsResponse(r.request().url())));
  await fb.route('**/data/climate.json', r => r.fulfill({ status: 404, body: 'nf' }));
  await fb.route('**://*.open-meteo.com/**', r => r.abort('failed'));
  await fb.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  await fb.waitForSelector('#app:not([hidden])', { timeout: 60000 });
  await fb.click('.tab[data-id="nmb"]');
  await fb.waitForSelector('.stat-grid', { timeout: 30000 });
  const fbTxt = await fb.textContent('#liveHost');
  ok('falls back to the NWS station when Open-Meteo is down', fbTxt.includes('National Weather Service'));
  ok('and names the station it used', fbTxt.includes('KCRE') || fbTxt.includes('Grand Strand'));
  ok('30.0°C from NWS renders as 86°F', /86°F/.test(fbTxt), fbTxt.replace(/\s+/g, ' ').slice(250, 420));
  ok('16.092 km/h renders as 10 mph', /10 mph/.test(fbTxt));
  ok('101325 Pa renders as 29.92 inHg', fbTxt.includes('29.92'));
  ok('16093.44 m renders as 10.0 mi', /10\.0 mi/.test(fbTxt));
  ok('18.9°C dew point renders as 66°F', /66°F/.test(fbTxt));
  ok('the water gauge still works during the outage',
     fbTxt.includes('Water temp') && /78\.4°F/.test(fbTxt), 'measured water temp missing');
  ok('it is honest that the forecast is unavailable', fbTxt.includes('Open-Meteo is unavailable'));
  await fbCtx.close();
  await page.click('.tab[data-id="all"]');
  await page.waitForSelector('.ov-card', { timeout: 15000 });

  console.log('\n\x1b[1m19. Precomputed snapshot — the page must not hit the archive at all\x1b[0m');
  /* Build a snapshot the same way scripts/build-climate.mjs does, serve it, and
     assert the archive is never touched. This is the whole point of the fix. */
  const fixture = JSON.parse(fs.readFileSync(path.join(SHOTS, 'climate-test.json'), 'utf8'));
  const serveSnapshot = obj => r => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(obj) });

  const snapCtx = await browser.newContext(CTX);
  const sp = await snapCtx.newPage();
  await routeRadar(sp);
  await sp.route('**://api.tidesandcurrents.noaa.gov/**', r => json(r, coopsResponse(r.request().url())));
  await sp.route('**://api.weather.gov/**', r => json(r, nwsResponse(r.request().url())));
  await sp.route('**://api.weather.gov/alerts/**', r => json(r, alertsResponse(r.request().url())));
  await sp.route('**/data/climate.json', serveSnapshot(fixture));
  let archiveHits = 0, marineArchiveHits = 0;
  await sp.route('**://api.open-meteo.com/**',   r => json(r, forecastResponse(r.request().url())));
  await sp.route('**://air-quality-api.open-meteo.com/**', r => json(r, airResponse(r.request().url())));
  await sp.route('**://archive-api.open-meteo.com/**', r => { archiveHits++; json(r, archiveResponse(r.request().url())); });
  await sp.route('**://marine-api.open-meteo.com/**',  r => {
    if (r.request().url().includes('start_date')) marineArchiveHits++;
    json(r, marineResponse(r.request().url()));
  });
  await sp.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  await openHome(sp, 'nmb', 30000);
  ok('normals render from the snapshot', (await sp.$$('#kpis .kpi')).length >= 18);
  ok('ZERO archive requests were made', archiveHits === 0, `${archiveHits} hits`);
  ok('ZERO marine-archive requests were made', marineArchiveHits === 0, `${marineArchiveHits} hits`);
  ok('the page says the data came from the snapshot',
     (await sp.textContent('#climateStatus')).includes('precomputed'));
  ok('charts still render in full', (await sp.$$('#charts .chart')).length >= 25);

  /* All three homes are in the snapshot, so the comparison is free and should
     populate without asking. */
  await sp.waitForFunction(() => document.querySelectorAll('#compareTableBox tbody tr').length === 3, { timeout: 20000 });
  ok('comparison fills from the snapshot with no prompt', true);
  ok('no "Load anyway" prompt when the snapshot covers everything',
     (await sp.$('#btnLoadCompare')) === null);

  /* Switching to a period the snapshot lacks must fall back, and say so. */
  const missingPeriod = Object.keys(CFG.PERIODS).find(k => k !== DEFAULT_PERIOD);
  const partial = JSON.parse(JSON.stringify(fixture));
  for (const h of Object.values(partial.homes)) delete h[missingPeriod];
  const sp2 = await snapCtx.newPage();
  await routeRadar(sp2);
  await sp2.route('**://api.tidesandcurrents.noaa.gov/**', r => json(r, coopsResponse(r.request().url())));
  await sp2.route('**://api.weather.gov/**', r => json(r, nwsResponse(r.request().url())));
  await sp2.route('**://api.weather.gov/alerts/**', r => json(r, alertsResponse(r.request().url())));
  await sp2.route('**/data/climate.json', serveSnapshot(partial));
  let archiveHits2 = 0;
  await sp2.route('**://api.open-meteo.com/**',   r => json(r, forecastResponse(r.request().url())));
  await sp2.route('**://air-quality-api.open-meteo.com/**', r => json(r, airResponse(r.request().url())));
  await sp2.route('**://archive-api.open-meteo.com/**', r => { archiveHits2++; json(r, archiveResponse(r.request().url())); });
  await sp2.route('**://marine-api.open-meteo.com/**',  r => json(r, marineResponse(r.request().url())));
  await sp2.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  await openHome(sp2, 'nmb', 30000);
  ok('default period still costs no archive requests', archiveHits2 === 0, `${archiveHits2}`);
  await sp2.selectOption('#selPeriod', missingPeriod);
  await sp2.waitForFunction(() => document.querySelectorAll('#kpis .kpi').length > 0, { timeout: 120000 });
  ok('a missing period falls back to building live', archiveHits2 > 0, `${archiveHits2}`);
  ok('and warns that it was built live',
     (await sp2.textContent('#climateStatus')).includes('built live'));
  ok('comparison offers opt-in rather than fetching three homes',
     (await sp2.$('#btnLoadCompare')) !== null);
  await snapCtx.close();

  console.log('\n\x1b[1m20. Rate-limit handling\x1b[0m');
  const rlCtx = await browser.newContext(CTX);
  const rp = await rlCtx.newPage();
  await routeRadar(rp);
  await rp.route('**://api.tidesandcurrents.noaa.gov/**', r => json(r, coopsResponse(r.request().url())));
  await rp.route('**://api.weather.gov/**', r => json(r, nwsResponse(r.request().url())));
  await rp.route('**://api.weather.gov/alerts/**', r => json(r, alertsResponse(r.request().url())));
  await rp.route('**/data/climate.json', serveSnapshot(partial));
  await rp.route('**://api.open-meteo.com/**',   r => json(r, forecastResponse(r.request().url())));
  await rp.route('**://air-quality-api.open-meteo.com/**', r => json(r, airResponse(r.request().url())));
  await rp.route('**://marine-api.open-meteo.com/**',  r => json(r, marineResponse(r.request().url())));
  await rp.route('**://archive-api.open-meteo.com/**', r => r.fulfill({
    status: 429, contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ error: true, reason: 'Hourly API request limit exceeded. Please try again in the next hour.' })
  }));
  await rp.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  await openHome(rp, 'nmb', 30000);
  const rlStart = Date.now();
  await rp.selectOption('#selPeriod', missingPeriod);
  await rp.waitForSelector('#climateStatus .banner', { timeout: 60000 });
  const rlText = await rp.textContent('#climateStatus');
  ok('an hourly quota rejection is not retried in a loop', Date.now() - rlStart < 30000,
     `took ${((Date.now() - rlStart) / 1000).toFixed(0)}s`);
  ok('the rate limit is named as such, not shown as a generic error',
     rlText.includes('free-tier limit'), rlText.slice(0, 90).trim());
  ok('it says when the quota clears', rlText.includes('next hour'));
  ok('it points back at the precomputed period', rlText.includes('precomputed'));
  ok('live conditions still work through a rate limit',
     /^-?\d+°$/.test((await rp.textContent('.now-temp')).trim()));
  await rlCtx.close();

  console.log('\n\x1b[1m20b. Trends, frost dates and wind\x1b[0m');
  await page.click('.tab[data-id="rockaway"]');
  await openHome(page, 'rockaway');
  const frostTxt = await page.textContent('#climateStatus');
  ok('Rockaway shows frost dates', frostTxt.includes('Frost dates'), frostTxt.slice(0, 80));
  ok('it gives a last spring freeze', frostTxt.includes('Last spring freeze'));
  ok('and a growing-season length', frostTxt.includes('Growing season'));
  await page.selectOption('#selGroup', 'trend');
  await page.waitForTimeout(200);
  const trendCharts = (await page.$$('#charts .chart')).length;
  ok('trend charts render', trendCharts >= 5, `${trendCharts}`);
  const trendTxt = await page.textContent('#charts');
  ok('each trend states a per-decade slope', trendTxt.includes('per decade'));
  ok('and reports r² so a scattered fit is not read as a firm trend', trendTxt.includes('r²'));
  ok('trend charts draw a fit line',
     (await page.$$eval('#charts .chart svg line', e => e.length)) > 0);
  await page.selectOption('#selGroup', 'wind');
  await page.waitForTimeout(200);
  ok('wind charts render', (await page.$$('#charts .chart')).length >= 2);
  ok('gale-force days are explained as tropical-storm force',
     (await page.textContent('#charts')).includes('tropical-storm force'));
  await page.selectOption('#selGroup', 'all');

  /* Bonita never freezes — it must say so rather than invent a frost date. */
  await page.click('.tab[data-id="bonita"]');
  await openHome(page, 'bonita');
  const bonitaFrost = await page.textContent('#climateStatus');
  ok('a frost-free home says so explicitly',
     bonitaFrost.includes('not record a single freeze') || bonitaFrost.includes('Frost dates'),
     bonitaFrost.slice(0, 100));

  console.log('\n\x1b[1m21. Time zones — a viewer in Denver reading East Coast homes\x1b[0m');
  const tzCtx = await browser.newContext({ ...CTX, timezoneId: 'America/Denver' });
  const tzp = await tzCtx.newPage();
  await routeRadar(tzp);
  await tzp.route('**://api.tidesandcurrents.noaa.gov/**', r => json(r, coopsResponse(r.request().url())));
  await tzp.route('**://api.weather.gov/**', r => json(r, nwsResponse(r.request().url())));
  await tzp.route('**://api.weather.gov/alerts/**', r => json(r, alertsResponse(r.request().url())));
  await tzp.route('**/data/climate.json', r => r.fulfill({ status: 404, body: 'not found' }));
  await tzp.route('**://api.open-meteo.com/**',   r => json(r, forecastResponse(r.request().url())));
  await tzp.route('**://air-quality-api.open-meteo.com/**', r => json(r, airResponse(r.request().url())));
  await tzp.route('**://archive-api.open-meteo.com/**', r => json(r, archiveResponse(r.request().url())));
  await tzp.route('**://marine-api.open-meteo.com/**',  r => json(r, marineResponse(r.request().url())));
  await tzp.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  await tzp.waitForSelector('#app:not([hidden])', { timeout: 30000 });
  /* The hourly charts live in a single home's view. */
  await tzp.click('.tab[data-id="nmb"]');
  await tzp.waitForSelector('#hrTemp .mark', { timeout: 30000 });

  /* The 48-hour window must begin at the *location's* current hour, not the
     viewer's and not UTC. */
  const firstHourLabel = await tzp.evaluate(() => {
    const r = document.querySelector('#hrTemp .mark');
    return r ? r.getAttribute('data-tip') : null;
  });
  const eastNow = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: true });
  const eastHour = eastNow.replace(/\s?(AM|PM)/i, m => ' ' + m.trim().toUpperCase()).trim();
  ok('48-hour window starts at the home\'s local hour, not the viewer\'s',
     firstHourLabel != null && firstHourLabel.includes(eastHour.split(' ')[0] + ' '),
     `tooltip "${firstHourLabel}" vs expected hour "${eastHour}"`);

  const observed = await tzp.textContent('.now-place:last-of-type');
  ok('observation time is shown in the home\'s local clock',
     observed.includes(eastHour.split(' ')[0] + ':'), observed.trim());
  const arcText = await tzp.textContent('.now .now-place, .now div');
  ok('sun progress renders without NaN in a foreign zone',
     !(await tzp.textContent('.now')).includes('NaN'));
  await tzCtx.close();

  /* ------------------------------------------------------------------
     The accuracy disclosure. This exists because the published figures come
     from a reanalysis model, not a thermometer, and the gap is real — up to
     +6°F on overnight lows. A disclosure that quietly disappears is worse
     than none, so it is asserted on the overview, on each home, and on the
     way back to a home already cached. The overview case is the one that was
     actually broken: the first version loaded the report from loadClimate(),
     which never runs on the three-home overview, so the Data Sources panel
     sat on "comparing…" until a single home was picked.
     ------------------------------------------------------------------ */
  console.log('\n\x1b[1m22. Accuracy disclosure vs NOAA\x1b[0m');
  const VFIX = {
    generated: new Date().toISOString(), window: '1991–2020',
    homes: {
      nmb: { name: 'North Myrtle Beach', noaa: { stationId: 'USC00386153', name: 'x', months: [] },
        models: { era5: { vsNoaa: {
          tmax: { meanBias: 0.39, worstMonth: 'Mar', worstBias: 1.74, n: 12 },
          tmin: { meanBias: 3.93, worstMonth: 'Feb', worstBias: 5.35, n: 12 },
          prcp: { meanBias: -0.15, worstMonth: 'Sep', worstBias: -0.66, n: 12 } } } } },
      bonita: { name: 'Bonita Springs', noaa: { stationId: 'USW00012835', name: 'y', months: [] },
        models: { era5: { vsNoaa: {
          tmax: { meanBias: -2.71, worstMonth: 'Jul', worstBias: -3.28, n: 12 },
          tmin: { meanBias: 1.10, worstMonth: 'Jan', worstBias: 2.02, n: 12 },
          prcp: { meanBias: 0.22, worstMonth: 'Aug', worstBias: 1.10, n: 12 } } } } },
      /* Rockaway is the first home, so it is what the overview describes. */
      rockaway: { name: 'Rockaway', noaa: { stationId: 'USW00054785', name: 'z', months: [] },
        models: { era5: { vsNoaa: {
          tmax: { meanBias: -1.42, worstMonth: 'Jul', worstBias: -2.42, n: 12 },
          tmin: { meanBias: 2.81, worstMonth: 'Feb', worstBias: 4.10, n: 12 },
          prcp: { meanBias: -0.08, worstMonth: 'Sep', worstBias: -0.40, n: 12 } } } } }
    }
  };
  /* innerText inserts line breaks around the <b> elements that carry the
     numbers, so every assertion here reads a whitespace-normalised copy.
     Matching raw innerText would have silently passed on nothing. */
  const flat = t => t.replace(/\s+/g, ' ').trim();
  const vCtx = await browser.newContext(CTX);
  const vp = await vCtx.newPage();
  await routeAllMocks(vp);
  await vp.route('**/data/validation.json', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(VFIX) }));
  await vp.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  await vp.waitForSelector('#app:not([hidden])', { timeout: 60000 });

  /* The overview is the landing view and loads no per-home normals, so the
     accuracy line has to arrive without a home being opened at all. */
  await vp.waitForFunction(
    () => /USW00054785/.test(document.getElementById('sourceNotes').innerText),
    null, { timeout: 20000 }).catch(() => {});
  const overviewDiag = flat(await vp.innerText('#sourceNotes'));
  ok('the accuracy line is present on the overview, before any home is opened',
     overviewDiag.includes('USW00054785') && !overviewDiag.includes('comparing the normals'),
     overviewDiag.slice(0, 220));

  await openHome(vp, 'nmb');
  await vp.waitForFunction(
    () => /on daily highs/.test(document.getElementById('climateStatus').innerText),
    null, { timeout: 30000 });

  const nmbNote = flat(await vp.innerText('#climateStatus'));
  ok('the disclosure names the NOAA station it was measured against',
     nmbNote.includes('USC00386153'), nmbNote.slice(0, 160));
  ok('it states the measured high bias to a tenth, with its sign',
     nmbNote.includes('+0.4°F on daily highs'), nmbNote.slice(0, 200));
  ok('it states the measured low bias, which is the large one',
     nmbNote.includes('+3.9°F'), nmbNote.slice(0, 200));
  ok('a low bias above 2°F is explained, not just printed',
     /gridded model/.test(nmbNote));
  ok('the comparison window is stated, so it is not mistaken for our period',
     nmbNote.includes('1991–2020'));

  /* The regression this feature actually had. */
  await vp.click('.tab[data-id="bonita"]');
  await vp.waitForSelector('#kpis .kpi', { timeout: 120000 });
  const bonNote = flat(await vp.innerText('#climateStatus'));
  ok('the disclosure survives switching homes',
     /°F on daily highs/.test(bonNote), bonNote.slice(0, 160));
  ok('and it re-reads for the home now on screen, rather than repeating the first',
     bonNote.includes('USW00012835') && bonNote.includes('-2.7°F') && !bonNote.includes('USC00386153'),
     bonNote.slice(0, 200));
  ok('a negative bias is not dressed up as a warm one',
     !/gridded model/.test(bonNote) || bonNote.includes('+1.1°F'));

  /* And going back — cached state is the path that broke before. */
  await vp.click('.tab[data-id="nmb"]');
  await vp.waitForSelector('#kpis .kpi', { timeout: 120000 });
  ok('it survives returning to a home whose normals are already cached',
     flat(await vp.innerText('#climateStatus')).includes('USC00386153'));

  const diag = flat(await vp.innerText('#sourceNotes'));
  ok('the Data Sources panel carries the accuracy line too',
     diag.includes('Accuracy check') && diag.includes('USC00386153'), diag.slice(0, 200));
  /* That panel also names this home's tide gauge and marine point, so it has
     to follow the tab rather than describe whichever home loaded first. */
  await vp.click('.tab[data-id="bonita"]');
  await vp.waitForSelector('#kpis .kpi', { timeout: 120000 });
  const diagB = flat(await vp.innerText('#sourceNotes'));
  ok('and the panel follows the selected home instead of going stale',
     diagB.includes('USW00012835') && !diagB.includes('USC00386153'), diagB.slice(0, 220));
  ok('the panel no longer claims ERA5-Land is requested first',
     !/finer one is requested first/.test(diag));
  await vCtx.close();

  /* Optional means optional: no report must not mean no page. */
  const nvCtx = await browser.newContext(CTX);
  const nvp = await nvCtx.newPage();
  const nvErrors = [];
  nvp.on('pageerror', e => nvErrors.push(String(e)));
  await routeAllMocks(nvp);
  await nvp.route('**/data/validation.json', r => r.fulfill({ status: 404, body: 'not found' }));
  await nvp.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  await openHome(nvp, 'nmb');
  const noVal = flat(await nvp.innerText('#climateStatus'));
  ok('without the report the disclosure is absent rather than blank or broken',
     !noVal.includes('daily highs') && !/NaN|undefined/.test(noVal), noVal.slice(0, 160));
  ok('and the climate view still renders its normals',
     (await nvp.$$('#kpis .kpi')).length > 0);
  ok('a missing optional report raises no uncaught error',
     nvErrors.length === 0, nvErrors.slice(0, 2).join(' | '));
  const nvDiag = flat(await nvp.innerText('#sourceNotes'));
  ok('the Data Sources panel says the report is missing instead of implying it passed',
     /not available in this deployment/.test(nvDiag), nvDiag.slice(0, 200));
  await nvCtx.close();

  /* ------------------------------------------------------------------
     Charts with nothing to draw. Every chart function has an early exit that
     paints "No data available" instead of an empty frame or a crash, and
     coverage showed not one of those exits had ever run. A month with a
     genuinely null metric — snowfall in Florida, ocean temperature inland —
     is not hypothetical, so this is a path real data reaches.
     ------------------------------------------------------------------ */
  console.log('\n\x1b[1m24. Charts with no data to draw\x1b[0m');
  const emptyResults = await page.evaluate(() => {
    const out = [];
    const svgNS = 'http://www.w3.org/2000/svg';
    const host = document.createElement('div');
    host.style.width = '600px';
    document.body.appendChild(host);
    const fresh = () => {
      const el = document.createElementNS(svgNS, 'svg');
      host.appendChild(el);
      return el;
    };
    const labels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const nulls = labels.map(() => null);
    const cases = {
      barChart:       () => barChart(fresh(), { values: nulls, labels, color: '#333' }),
      rangeChart:     () => rangeChart(fresh(), { high: nulls, low: nulls, labels }),
      multiLine:      () => multiLine(fresh(), { series: [{ label: 'a', color: '#333', values: nulls }], labels }),
      stackedBar:     () => stackedBar(fresh(), { stacks: labels.map(() => [0, 0]), labels,
                                                  seriesLabels: ['a','b'], ramp: ['#333','#666'] }),
      daylightRibbon: () => daylightRibbon(fresh(), { curve: [] }),
      trendChart:     () => trendChart(fresh(), { years: [], values: [], trend: null, color: '#333' }),
      hourlyChart:    () => hourlyChart(fresh(), { times: [], values: [], isDayFlags: [], color: '#333' })
    };
    for (const [name, run] of Object.entries(cases)) {
      try {
        run();
        const el = host.lastChild;
        out.push({ name, threw: null, text: el.textContent,
                   w: el.getAttribute('width'), h: el.getAttribute('height'),
                   marks: el.querySelectorAll('.mark').length });
      } catch (err) {
        out.push({ name, threw: String(err && err.message || err) });
      }
    }
    /* sparkLine returns a string rather than drawing into an element. */
    out.push({ name: 'sparkLine', threw: null, text: sparkLine([], '#333'), spark: true });
    out.push({ name: 'sparkLineOne', threw: null, text: sparkLine([5], '#333'), spark: true });
    host.remove();
    return out;
  });

  for (const r of emptyResults.filter(r => !r.spark)) {
    ok(`${r.name} does not throw on empty data`, r.threw === null, r.threw || '');
    ok(`${r.name} says "No data available" rather than drawing an empty frame`,
       (r.text || '').includes('No data available'), JSON.stringify(r.text || '').slice(0, 80));
    ok(`${r.name} draws no marks that would tooltip a non-existent value`,
       r.marks === 0, `${r.marks} marks`);
    ok(`${r.name} still sizes its canvas, so the layout does not collapse`,
       r.w && r.h && +r.w > 0 && +r.h > 0, `${r.w}x${r.h}`);
  }
  const spark0 = emptyResults.find(r => r.name === 'sparkLine');
  const spark1 = emptyResults.find(r => r.name === 'sparkLineOne');
  ok('sparkLine returns nothing at all for no data, rather than a flat line',
     spark0.text === '', JSON.stringify(spark0.text).slice(0, 60));
  ok('and a single point is not drawn as a trend either',
     spark1.text === '', JSON.stringify(spark1.text).slice(0, 60));

  console.log('\n\x1b[1m23. Console health\x1b[0m');
  const realErrors = consoleErrors.filter(e => !/Failed to load resource|net::ERR/.test(e));
  ok('no uncaught JavaScript errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  /* Full-page screenshots for visual review. */
  await page.screenshot({ path: path.join(SHOTS, '01-full.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(SHOTS, '02-top.png') });

  if (COVERAGE) {
    for (const c of browser.contexts()) { try { await c.close(); } catch (_) {} }
    writeCoverage(covEntries);
  }
  await browser.close();
  server.close();

  console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
  if (fail) console.log('Failures:\n  - ' + results.join('\n  - '));
  console.log(`Intercepted calls: ${JSON.stringify(calls)}`);
  console.log(`Screenshots in ${SHOTS}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });


/* Dump the raw V8 ranges so they can be unioned with the crawl's. The question
   worth answering is what NO suite touched, not what each one missed. */
function writeCoverage(entries) {
  const out = path.join(SHOTS, 'coverage-e2e.json');
  fs.writeFileSync(out, JSON.stringify(entries.map(e => ({
    url: e.url, functions: e.functions.map(f => ({ ranges: f.ranges }))
  }))));
  console.log(`Coverage ranges written to ${out}`);
}
