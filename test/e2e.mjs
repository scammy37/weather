/* End-to-end checks. Serves the dashboard over http, intercepts every
   Open-Meteo request with synthetic data, then drives the real UI.
   Run: node test/e2e.mjs [--headed] [--keep-shots] */
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { archiveResponse, forecastResponse, marineResponse, airResponse } from './mock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'test', 'shots');

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; results.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  → ' + extra : ''}`); }
}
const MIME = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json',
               '.svg':'image/svg+xml', '.css':'text/css' };

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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + e.message));

  const json = (route, body) => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });

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

  console.log('\n\x1b[1m1. Boot and live feed\x1b[0m');
  await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
  ok('app becomes visible after boot', true);
  ok('forecast API called once per home', calls.forecast === 3, `${calls.forecast} calls`);
  ok('marine live called once per home', calls.marineLive === 3, `${calls.marineLive} calls`);
  ok('air quality called once per home', calls.air === 3, `${calls.air} calls`);

  const heroTemp = (await page.textContent('.now-temp') || '').trim();
  ok('hero temperature rendered', /^-?\d+°$/.test(heroTemp), heroTemp);
  ok('no "NaN" anywhere on the live panel',
     !(await page.textContent('#liveHost')).includes('NaN'));
  ok('all three tabs show a temperature',
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
  ok('archive core requested (3 decade chunks for a 30-year period)',
     calls.archiveCore >= 3, `${calls.archiveCore}`);
  ok('extended variables requested separately', calls.archiveExt >= 3, `${calls.archiveExt}`);
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
  await page.waitForFunction(() => document.querySelectorAll('#compareTableBox tbody tr').length === 3, { timeout: 90000 });
  ok('all three homes appear in the comparison table', true);
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
  await page.selectOption('#selPeriod', '2011-2025');
  await page.waitForFunction(() => document.querySelectorAll('#kpis .kpi').length > 0, { timeout: 90000 });
  ok('changing the period refetches the archive', calls.archiveCore > before);
  ok('table note names the new period', (await page.textContent('#tableNote')).includes('2011'));
  await page.selectOption('#selPeriod', '1996-2025');
  await page.waitForFunction(() => document.querySelectorAll('#kpis .kpi').length > 0, { timeout: 90000 });

  console.log('\n\x1b[1m12. Caching\x1b[0m');
  const cachedKeys = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('wx-v1:')));
  ok('aggregates are cached in localStorage', cachedKeys.length >= 3, JSON.stringify(cachedKeys));
  const cacheBytes = await page.evaluate(() =>
    Object.keys(localStorage).filter(k => k.startsWith('wx-v1:')).reduce((s, k) => s + localStorage.getItem(k).length, 0));
  ok('cache stays far below the 5 MB quota', cacheBytes < 1_500_000, `${(cacheBytes / 1024).toFixed(0)} KB`);
  const beforeReload = calls.archiveCore;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#kpis .kpi', { timeout: 30000 });
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
     /nmb-climate-normals-1996-2025\.csv/.test(download.suggestedFilename()), download.suggestedFilename());
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
  ok('source notes explain every feed', (await page.textContent('#sourceNotes')).includes('ERA5'));

  console.log('\n\x1b[1m16. Failure handling\x1b[0m');
  const page2 = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page2.route('**://*.open-meteo.com/**', r => r.abort('failed'));
  await page2.route('**://api.open-meteo.com/**', r => r.abort('failed'));
  await page2.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  await page2.waitForSelector('#app:not([hidden])', { timeout: 60000 });
  ok('page still renders when every API is down', true);
  const bannerTxt = await page2.textContent('#banners');
  ok('a clear offline banner is shown', bannerTxt.includes('No live data'), bannerTxt.slice(0, 80));
  await page2.waitForSelector('#climateStatus .banner.err', { timeout: 90000 });
  ok('normals failure is explained, not silent',
     (await page2.textContent('#climateStatus')).includes('Could not build'));
  await page2.screenshot({ path: path.join(SHOTS, '04-offline.png') });
  await page2.close();

  console.log('\n\x1b[1m17. Partial failure — archive up, marine down\x1b[0m');
  const page3 = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page3.route('**://api.open-meteo.com/**',   r => json(r, forecastResponse(r.request().url())));
  await page3.route('**://air-quality-api.open-meteo.com/**', r => json(r, airResponse(r.request().url())));
  await page3.route('**://archive-api.open-meteo.com/**', r => json(r, archiveResponse(r.request().url())));
  await page3.route('**://marine-api.open-meteo.com/**', r => r.abort('failed'));
  await page3.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  await page3.waitForSelector('#kpis .kpi', { timeout: 120000 });
  ok('normals still build when the marine API is down',
     (await page3.$$('#charts .chart')).length > 20);
  ok('ocean charts are hidden rather than blank',
     !(await page3.textContent('#charts')).includes('Swimmable water'));
  ok('the missing ocean data is explained',
     (await page3.textContent('#climateStatus')).includes('Ocean temperature'));
  await page3.close();

  console.log('\n\x1b[1m18. Mobile layout\x1b[0m');
  const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await m.route('**://api.open-meteo.com/**',   r => json(r, forecastResponse(r.request().url())));
  await m.route('**://air-quality-api.open-meteo.com/**', r => json(r, airResponse(r.request().url())));
  await m.route('**://archive-api.open-meteo.com/**', r => json(r, archiveResponse(r.request().url())));
  await m.route('**://marine-api.open-meteo.com/**',  r => json(r, marineResponse(r.request().url())));
  await m.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  await m.waitForSelector('#kpis .kpi', { timeout: 120000 });
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

  console.log('\n\x1b[1m19. Time zones — a viewer in Denver reading East Coast homes\x1b[0m');
  const tzCtx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/Denver' });
  const tzp = await tzCtx.newPage();
  await tzp.route('**://api.open-meteo.com/**',   r => json(r, forecastResponse(r.request().url())));
  await tzp.route('**://air-quality-api.open-meteo.com/**', r => json(r, airResponse(r.request().url())));
  await tzp.route('**://archive-api.open-meteo.com/**', r => json(r, archiveResponse(r.request().url())));
  await tzp.route('**://marine-api.open-meteo.com/**',  r => json(r, marineResponse(r.request().url())));
  await tzp.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  await tzp.waitForSelector('#app:not([hidden])', { timeout: 30000 });

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

  console.log('\n\x1b[1m20. Console health\x1b[0m');
  const realErrors = consoleErrors.filter(e => !/Failed to load resource|net::ERR/.test(e));
  ok('no uncaught JavaScript errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  /* Full-page screenshots for visual review. */
  await page.screenshot({ path: path.join(SHOTS, '01-full.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(SHOTS, '02-top.png') });

  await browser.close();
  server.close();

  console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
  if (fail) console.log('Failures:\n  - ' + results.join('\n  - '));
  console.log(`Intercepted calls: ${JSON.stringify(calls)}`);
  console.log(`Screenshots in ${SHOTS}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
