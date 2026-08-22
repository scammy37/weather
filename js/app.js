/* =============================================================================
   app.js — state, rendering and wiring.

   Load order
     1. live conditions for all three homes (fast, always fresh)
     2. climate normals for the selected home (cached; rebuilt on demand)

   The page renders as soon as step 1 lands, so the live feed is never held
   hostage by the much larger archive pull.
   =========================================================================== */

const ALL = 'all';                 // the three-up overview, not a location

const S = {
  locId:     ALL,
  period:    DEFAULT_PERIOD,
  group:     'all',
  month:     -1,                 // focus month, -1 = none
  compareKey:'avgHigh',
  sort:      { key: 'month', dir: 1 },
  live:      {},                 // locId → { wx, air, marine, error, at }
  clim:      {},                 // `locId|period` → { rows, annual, meta }
  climState: {},                 // `locId|period` → 'loading' | 'ready' | 'error'
  fcDay:     -1,
  theme:     'light'
};

const $  = id => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const isAll = () => S.locId === ALL;
/* Falls back to the first home so anything that needs a concrete location
   (time zone, coordinates) still has one while the overview is showing. */
const loc = id => LOCATIONS.find(l => l.id === (id || S.locId)) || LOCATIONS[0];
const climKey = (id, p) => `${id}|${p}`;
const curClim = () => S.clim[climKey(S.locId, S.period)] || null;

/* Accent for a location in the current theme. */
const accentOf = l => S.theme === 'dark' ? l.accentDark : l.accent;

/* ---------------------------------------------------------------------------
   Boot
   ------------------------------------------------------------------------- */
window.addEventListener('DOMContentLoaded', init);

async function init() {
  /* Theme: stored choice wins, otherwise follow the OS. */
  let stored = null;
  try { stored = localStorage.getItem('wx-theme'); } catch (_) {}
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  setTheme(stored || (prefersDark ? 'dark' : 'light'));

  buildTabs();
  buildSelects();
  wireControls();

  boot('Fetching live conditions for all three homes…', 10);
  await loadAllLive();
  boot('Rendering…', 60);

  $('bootstrap').hidden = true;
  $('app').hidden = false;
  renderLive();
  renderBanners();
  renderClimate();      /* overview mode has no loadClimate() to render it */
  renderDiagnostics();
  renderFooter();

  /* Normals are heavier — start after the page is interactive. The overview is
     the default view, so the comparison set is what needs warming. */
  if (isAll()) loadCompareSet(); else loadClimate(S.locId, S.period);

  window.addEventListener('resize', debounce(() => { renderCharts(); renderCompare(); renderLive(); }, 180));
}

function boot(msg, pct, sub) {
  const m = $('bootMsg'), b = $('bootBar'), s = $('bootSub');
  if (m && msg) m.textContent = msg;
  if (b && pct != null) b.style.width = pct + '%';
  if (s) s.textContent = sub || '';
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/* ---------------------------------------------------------------------------
   Chrome: tabs, selects, control wiring
   ------------------------------------------------------------------------- */
function buildTabs() {
  const nav = $('tabs');
  nav.innerHTML = '';

  const all = el('button', 'tab' + (isAll() ? ' on' : ''));
  all.type = 'button';
  all.dataset.id = ALL;
  all.setAttribute('aria-current', isAll() ? 'true' : 'false');
  all.innerHTML = `<span aria-hidden="true">🏘️</span><span>All three homes</span>`;
  all.addEventListener('click', () => selectLocation(ALL));
  nav.appendChild(all);

  LOCATIONS.forEach(l => {
    const b = el('button', 'tab' + (l.id === S.locId ? ' on' : ''));
    b.type = 'button';
    b.dataset.id = l.id;
    b.setAttribute('aria-current', l.id === S.locId ? 'true' : 'false');
    b.innerHTML = `<span class="dot" style="background:${accentOf(l)}"></span>
      <span>${l.emoji} ${esc(l.name)}, ${l.state}</span>
      <span class="tmeta" id="tabTemp-${l.id}">—</span>`;
    b.addEventListener('click', () => selectLocation(l.id));
    nav.appendChild(b);
  });
}

function buildSelects() {
  const p = $('selPeriod');
  p.innerHTML = Object.entries(PERIODS).map(([k, v]) =>
    `<option value="${k}"${k === S.period ? ' selected' : ''}>${esc(v.label)}</option>`).join('');

  const g = $('selGroup');
  g.innerHTML = `<option value="all">All charts</option>`
    + Object.entries(GROUPS).map(([k, v]) => `<option value="${k}">${v.icon} ${esc(v.label)}</option>`).join('');

  const m = $('selMonth');
  m.innerHTML = `<option value="-1">None — show all months</option>`
    + MONTHS_FULL.map((n, i) => `<option value="${i}">${n}</option>`).join('');

  const c = $('selCompare');
  const groups = {};
  METRICS.forEach(mt => (groups[mt.group] || (groups[mt.group] = [])).push(mt));
  c.innerHTML = Object.entries(groups).map(([gk, list]) =>
    `<optgroup label="${GROUPS[gk].icon} ${esc(GROUPS[gk].label)}">`
    + list.map(mt => `<option value="${mt.key}"${mt.key === S.compareKey ? ' selected' : ''}>${esc(mt.label)}</option>`).join('')
    + `</optgroup>`).join('');
}

function wireControls() {
  $('btnTheme').addEventListener('click', () => {
    setTheme(S.theme === 'dark' ? 'light' : 'dark');
    buildTabs(); renderLive(); renderClimate(); renderCompare(); renderDiagnostics();
  });
  $('btnRefresh').addEventListener('click', async () => {
    $('btnRefresh').disabled = true;
    $('btnRefresh').textContent = '↻ Refreshing…';
    await loadAllLive(true);
    renderLive(); renderBanners(); renderDiagnostics(); renderFooter();
    $('btnRefresh').disabled = false;
    $('btnRefresh').textContent = '↻ Refresh live';
  });
  $('selPeriod').addEventListener('change', e => {
    S.period = e.target.value; S.month = -1; $('selMonth').value = '-1';
    renderClimate(); loadClimate(S.locId, S.period); loadCompareSet();
  });
  $('selGroup').addEventListener('change', e => { S.group = e.target.value; renderCharts(); });
  $('selMonth').addEventListener('change', e => selectMonth(+e.target.value));
  $('selCompare').addEventListener('change', e => { S.compareKey = e.target.value; renderCompare(); });
  $('btnCsv').addEventListener('click', () => {
    if (isAll()) { alert('Pick a single home from the tabs first — the CSV covers one home at a time.'); return; }
    exportCSV();
  });
  $('btnCloseDetail').addEventListener('click', () => selectMonth(-1));
  $('btnRebuild').addEventListener('click', () => {
    if (isAll()) { alert('Pick a single home from the tabs first.'); return; }
    delete S.clim[climKey(S.locId, S.period)];
    try { localStorage.removeItem(cacheKey('clim', S.locId, S.period)); } catch (_) {}
    loadClimate(S.locId, S.period, true);
  });
  $('btnClearCache').addEventListener('click', () => {
    const n = clearOurCache();
    S.clim = {}; S.climState = {};
    renderClimate();
    loadClimate(S.locId, S.period, true);
    alert(`Cleared ${n} cached item${n === 1 ? '' : 's'}. Rebuilding normals from the archive…`);
  });
}

function setTheme(t) {
  S.theme = t;
  document.body.classList.toggle('dark', t === 'dark');
  const b = $('btnTheme');
  if (b) b.textContent = t === 'dark' ? '☀️ Light' : '🌙 Dark';
  document.querySelector('meta[name=theme-color]')
    ?.setAttribute('content', t === 'dark' ? '#0a1f34' : '#123a5f');
  try { localStorage.setItem('wx-theme', t); } catch (_) {}
}

function selectLocation(id) {
  if (id === S.locId) return;
  S.locId = id; S.month = -1; S.fcDay = -1;
  $('selMonth').value = '-1';
  buildTabs(); renderLive(); renderClimate(); renderBanners();
  if (isAll()) loadCompareSet(); else loadClimate(S.locId, S.period);
}

function selectMonth(m) {
  S.month = (m === S.month) ? -1 : m;
  $('selMonth').value = String(S.month);
  renderDetail(); renderCharts(); renderTable(); renderCompare();
  if (S.month >= 0) $('detail').scrollIntoView({ block: 'nearest' });
}

/* ---------------------------------------------------------------------------
   Live data
   ------------------------------------------------------------------------- */
async function loadAllLive(force) {
  const jobs = LOCATIONS.map(async (l, i) => {
    try {
      const [wx, air, marine] = await Promise.all([
        fetchLive(l),
        fetchAir(l).catch(() => null),
        fetchMarineLive(l).catch(() => null)
      ]);
      S.live[l.id] = { wx, air, marine, at: Date.now(), error: null };
    } catch (err) {
      S.live[l.id] = { wx: null, air: null, marine: null, at: Date.now(), error: String(err && err.message || err) };
    }
    boot(null, 10 + ((i + 1) / LOCATIONS.length) * 45, `${l.name} done`);
  });
  await Promise.all(jobs);
}

/* ---------------------------------------------------------------------------
   Live rendering
   ------------------------------------------------------------------------- */
function renderLive() {
  const l = loc(), d = S.live[l.id];
  const host = $('liveHost');
  host.innerHTML = '';

  /* Tab temperature badges stay current for every location, not just the
     selected one — that is the point of having three homes on one page. */
  LOCATIONS.forEach(x => {
    const t = $('tabTemp-' + x.id);
    const c = S.live[x.id] && S.live[x.id].wx && S.live[x.id].wx.current;
    if (t) t.textContent = c && typeof c.temperature_2m === 'number' ? `${Math.round(c.temperature_2m)}°` : '—';
  });

  if (isAll()) { renderOverview(host); return; }

  if (!d || d.error || !d.wx) {
    host.appendChild(el('div', 'banner err',
      `<span class="bico">⚠️</span><div><b>Live feed unavailable for ${esc(l.name)}</b>
       ${esc(d && d.error || 'No response from the forecast API.')}
       <br>The monthly normals below are unaffected. Use <b>↻ Refresh live</b> to try again.</div>`));
    return;
  }

  const cur = d.wx.current || {}, cu = d.wx.current_units || {};
  const daily = d.wx.daily || {}, hourly = d.wx.hourly || {};
  const isDay = cur.is_day == null ? 1 : cur.is_day;
  const w = wmoInfo(cur.weather_code, isDay);

  /* index of "today" within the daily arrays — past_days=2 shifts it. */
  const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: l.tz });
  let ti = (daily.time || []).indexOf(todayISO);
  if (ti < 0) ti = Math.min(2, (daily.time || []).length - 1);

  const sun = sunTimes(new Date(), l.lat, l.lon);
  const sunriseMin = localMinutes(sun.sunrise, l.tz), sunsetMin = localMinutes(sun.sunset, l.tz);
  const nowMin = localMinutes(new Date(), l.tz);

  const grid = el('div', 'live-grid');

  /* --- hero --- */
  const now = el('div', 'now');
  const poles = isDark() ? TEMP_POLES.dark : TEMP_POLES.light;
  now.innerHTML = `
    <div class="now-top">
      <div class="now-icon" aria-hidden="true">${w.icon}</div>
      <div>
        <div class="now-temp">${fmtNum(cur.temperature_2m, 0)}°</div>
        <div class="now-feels">Feels like ${fmtNum(cur.apparent_temperature, 0)}°F</div>
      </div>
    </div>
    <div class="now-cond">${esc(w.label)}</div>
    <div class="now-hilo">
      <span style="color:${poles.high}">↑ ${fmtNum(daily.temperature_2m_max?.[ti], 0)}°</span>
      <span style="color:${poles.low}">↓ ${fmtNum(daily.temperature_2m_min?.[ti], 0)}°</span>
      <span style="color:var(--muted);font-weight:600">today</span>
    </div>
    ${sunArc(nowMin, sunriseMin, sunsetMin)}
    <div class="now-place" style="margin-top:auto">🌎 ${esc(l.blurb)}</div>
    <div class="now-place">📍 ${l.lat.toFixed(3)}°N, ${Math.abs(l.lon).toFixed(3)}°W · ${l.elevationFt} ft above sea level</div>
    <div class="now-place">🕐 Observed ${esc(fmtClock(cur.time, l.tz))} local · updated ${esc(relTime(d.at))}</div>`;
  grid.appendChild(now);

  /* --- stat tiles --- */
  const stats = el('div');
  const uvNow = pickHourly(hourly, 'uv_index', l.tz);
  const visNow = pickHourly(hourly, 'visibility', l.tz);
  const dewNow = pickHourly(hourly, 'dew_point_2m', l.tz);
  const aqi = d.air && d.air.current ? d.air.current.us_aqi : null;

  const tiles = [
    ['Humidity',      fmtNum(cur.relative_humidity_2m, 0) + '%',            'Relative'],
    ['Dew point',     fmtNum(dewNow, 0) + '°F',                              dewLabel(dewNow)],
    ['Wind',          `${fmtNum(cur.wind_speed_10m, 0)} mph`,               `${degToCompass(cur.wind_direction_10m)} · gusts ${fmtNum(cur.wind_gusts_10m, 0)}`],
    ['Pressure',      fmtNum(cur.pressure_msl != null ? cur.pressure_msl * 0.02953 : null, 2) + ' inHg', 'Sea level'],
    ['Cloud cover',   fmtNum(cur.cloud_cover, 0) + '%',                      cloudLabel(cur.cloud_cover)],
    ['Visibility',    visNow != null ? `${(visNow / 5280).toFixed(1)} mi` : '—', 'Surface'],
    ['UV index',      fmtNum(uvNow, 1),                                      uvLabel(uvNow)],
    ['Precip today',  `${fmtNum(daily.precipitation_sum?.[ti], 2)} in`,      `${fmtNum(daily.precipitation_probability_max?.[ti], 0)}% chance`],
    ['Sunrise',       fmtMinutes(sunriseMin),                                'NOAA solar calc'],
    ['Sunset',        fmtMinutes(sunsetMin),                                 'NOAA solar calc'],
    ['Daylight',      fmtDuration(sun.daylightMinutes),                      daylightProgress(nowMin, sunriseMin, sunsetMin)],
    ['Air quality',   aqi != null ? String(Math.round(aqi)) : '—',           aqi != null ? aqiLabel(aqi) : 'US AQI unavailable']
  ];
  if ((daily.snowfall_sum?.[ti] || 0) > 0)
    tiles.push(['Snow today', `${fmtNum(daily.snowfall_sum[ti], 1)} in`, 'Forecast total']);

  stats.innerHTML = `<div class="stat-grid">` + tiles.map(([a, b, c]) =>
    `<div class="stat"><div class="stat-l">${esc(a)}</div><div class="stat-v">${b}</div><div class="stat-s">${esc(c)}</div></div>`).join('') + `</div>`;

  /* --- ocean --- */
  const m = l.marine, mc = d.marine && d.marine.current;
  const oceanTiles = mc ? [
    ['Water temp',  fmtNum(mc.sea_surface_temperature, 1) + '°F', swimLabel(mc.sea_surface_temperature)],
    ['Wave height', fmtNum(mc.wave_height, 1) + ' ft',            'Significant height'],
    ['Wave period', fmtNum(mc.wave_period, 1) + ' s',             'Between crests'],
    ['Swell from',  degToCompass(mc.wave_direction),              `${fmtNum(mc.wave_direction, 0)}°`]
  ] : null;

  stats.innerHTML += `
    <div style="margin-top:14px" class="panel">
      <div class="panel-h"><h2>🌊 ${esc(m.body)} right now</h2>
        <span class="note">${esc(m.label)}</span></div>
      <div class="panel-b">
        ${m.proxy ? `<div class="banner info" style="margin-bottom:12px"><span class="bico">ℹ️</span><div>
            <b>Rockaway is inland — about ${m.proxyDistanceMi} miles from the coast.</b>
            There is no ocean at this home, so these readings come from the Atlantic off
            ${esc(m.proxyName)}, the nearest shore point, as a beach-trip reference.</div></div>` : ''}
        ${oceanTiles
          ? `<div class="stat-grid">` + oceanTiles.map(([a, b, c]) =>
              `<div class="stat"><div class="stat-l">${esc(a)}</div><div class="stat-v">${b}</div><div class="stat-s">${esc(c)}</div></div>`).join('') + `</div>`
          : `<div style="color:var(--muted);font-size:.82rem">Marine model returned no current reading for this point. The monthly ocean-temperature chart below is unaffected.</div>`}
      </div>
    </div>`;
  grid.appendChild(stats);
  host.appendChild(grid);

  renderForecast(host, l, d);
  renderHourly(host, l, d);
}

/* ---------------------------------------------------------------------------
   Overview — all three homes at once.

   The default view. Every home's current conditions, today's range, the ocean,
   sun times and a compact week are visible without a click; selecting a home
   is for going deeper, not for the basics.
   ------------------------------------------------------------------------- */
function renderOverview(host) {
  const live = LOCATIONS.map(l => ({ l, d: S.live[l.id] }))
    .map(o => ({ ...o, cur: o.d && o.d.wx && o.d.wx.current }));
  const withData = live.filter(o => o.cur && typeof o.cur.temperature_2m === 'number');

  /* Headline strip: the comparisons worth making across three homes. */
  if (withData.length > 1) {
    const warm = withData.reduce((a, b) => b.cur.temperature_2m > a.cur.temperature_2m ? b : a);
    const cool = withData.reduce((a, b) => b.cur.temperature_2m < a.cur.temperature_2m ? b : a);
    const spread = warm.cur.temperature_2m - cool.cur.temperature_2m;
    const wet = withData.filter(o => (o.cur.precipitation || 0) > 0);
    const oceans = LOCATIONS.map(l => ({ l, m: S.live[l.id] && S.live[l.id].marine && S.live[l.id].marine.current }))
      .filter(o => o.m && typeof o.m.sea_surface_temperature === 'number' && !o.l.marine.proxy);
    const bestOcean = oceans.length
      ? oceans.reduce((a, b) => b.m.sea_surface_temperature > a.m.sea_surface_temperature ? b : a) : null;

    const facts = [
      ['Warmest right now', `${warm.l.emoji} ${warm.l.short}`, `${Math.round(warm.cur.temperature_2m)}°F`],
      ['Coolest right now', `${cool.l.emoji} ${cool.l.short}`, `${Math.round(cool.cur.temperature_2m)}°F`],
      ['Spread between homes', `${Math.round(spread)}°F`, spread > 25 ? 'a different season entirely' : spread > 12 ? 'a real difference' : 'much of a muchness'],
      ['Raining now', wet.length ? wet.map(o => o.l.short).join(', ') : 'Nowhere', wet.length ? `${wet.length} of ${withData.length} homes` : 'all three dry']
    ];
    if (bestOcean) facts.push(['Warmest water',
      `${bestOcean.l.emoji} ${bestOcean.l.short}`,
      `${fmtNum(bestOcean.m.sea_surface_temperature, 1)}°F · ${swimLabel(bestOcean.m.sea_surface_temperature)}`]);

    const strip = el('section', 'panel');
    strip.innerHTML = `<div class="panel-h"><h2>📍 Across all three homes</h2>
        <span class="note">Updated ${esc(relTime(Math.max(...live.map(o => (o.d && o.d.at) || 0))))}</span></div>
      <div class="panel-b"><div class="stat-grid">${facts.map(([a, b, c]) =>
        `<div class="stat"><div class="stat-l">${esc(a)}</div><div class="stat-v">${esc(String(b))}</div>
         <div class="stat-s">${esc(String(c))}</div></div>`).join('')}</div></div>`;
    host.appendChild(strip);
  }

  /* One card per home. */
  const grid = el('div', 'ov-grid');
  LOCATIONS.forEach(l => {
    const d = S.live[l.id];
    const card = el('article', 'ov-card');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Open the full dashboard for ${l.name}, ${l.state}`);
    card.style.borderTopColor = accentOf(l);

    if (!d || d.error || !d.wx || !d.wx.current) {
      card.innerHTML = `<div class="ov-head"><span class="ov-emoji">${l.emoji}</span>
          <div><div class="ov-name">${esc(l.name)}, ${l.state}</div>
          <div class="ov-blurb">${esc(l.blurb)}</div></div></div>
        <div class="banner err" style="margin:14px 0 0"><span class="bico">⚠️</span>
          <div>Live feed unavailable.<br>${esc(d && d.error || 'No response.')}</div></div>`;
      grid.appendChild(card);
      card.addEventListener('click', () => selectLocation(l.id));
      return;
    }

    const cur = d.wx.current, daily = d.wx.daily || {}, hourly = d.wx.hourly || {};
    const w = wmoInfo(cur.weather_code, cur.is_day == null ? 1 : cur.is_day);
    const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: l.tz });
    let ti = (daily.time || []).indexOf(todayISO);
    if (ti < 0) ti = Math.min(2, (daily.time || []).length - 1);

    const sun = sunTimes(new Date(), l.lat, l.lon);
    const riseMin = localMinutes(sun.sunrise, l.tz), setMin = localMinutes(sun.sunset, l.tz);
    const nowMin = localMinutes(new Date(), l.tz);
    const poles = isDark() ? TEMP_POLES.dark : TEMP_POLES.light;
    const mc = d.marine && d.marine.current;
    const dewNow = pickHourly(hourly, 'dew_point_2m', l.tz);

    /* Compact week: icon over high/low, seven across. */
    const times = daily.time || [];
    let start = times.indexOf(todayISO); if (start < 0) start = 0;
    let week = '';
    for (let i = start; i < times.length && i < start + 7; i++) {
      const wi = wmoInfo(daily.weather_code?.[i], 1);
      const dt = new Date(times[i] + 'T12:00:00');
      const pop = daily.precipitation_probability_max?.[i];
      week += `<div class="ov-day" title="${esc(wi.label)}">
        <div class="ov-dow">${i === start ? 'Today' : dt.toLocaleDateString(undefined, { weekday: 'short' })}</div>
        <div class="ov-dico" aria-hidden="true">${wi.icon}</div>
        <div class="ov-dhi">${fmtNum(daily.temperature_2m_max?.[i], 0)}°</div>
        <div class="ov-dlo">${fmtNum(daily.temperature_2m_min?.[i], 0)}°</div>
        <div class="ov-dpop">${pop > 20 ? Math.round(pop) + '%' : ''}</div>
      </div>`;
    }

    const chips = [
      ['💧', `${fmtNum(cur.relative_humidity_2m, 0)}%`, 'Humidity'],
      ['🌫️', `${fmtNum(dewNow, 0)}°`, 'Dew point'],
      ['💨', `${fmtNum(cur.wind_speed_10m, 0)} ${degToCompass(cur.wind_direction_10m)}`, 'Wind mph'],
      ['☁️', `${fmtNum(cur.cloud_cover, 0)}%`, 'Cloud cover']
    ];
    if (mc && typeof mc.sea_surface_temperature === 'number')
      chips.push(['🌊', `${fmtNum(mc.sea_surface_temperature, 0)}°`,
        l.marine.proxy ? `${l.marine.proxyName} — ${l.marine.proxyDistanceMi} mi away` : 'Water temperature']);

    card.innerHTML = `
      <div class="ov-head">
        <span class="ov-emoji" aria-hidden="true">${l.emoji}</span>
        <div>
          <div class="ov-name">${esc(l.name)}, ${l.state}</div>
          <div class="ov-blurb">${esc(l.blurb)}</div>
        </div>
      </div>
      <div class="ov-now">
        <span class="ov-ico" aria-hidden="true">${w.icon}</span>
        <span class="ov-temp">${fmtNum(cur.temperature_2m, 0)}°</span>
        <span class="ov-meta">
          <span class="ov-cond">${esc(w.label)}</span>
          <span class="ov-feels">Feels ${fmtNum(cur.apparent_temperature, 0)}°</span>
        </span>
      </div>
      <div class="ov-hilo">
        <span style="color:${poles.high}">↑ ${fmtNum(daily.temperature_2m_max?.[ti], 0)}°</span>
        <span style="color:${poles.low}">↓ ${fmtNum(daily.temperature_2m_min?.[ti], 0)}°</span>
        <span class="ov-pop">${fmtNum(daily.precipitation_probability_max?.[ti], 0)}% rain today</span>
      </div>
      <div class="ov-chips">${chips.map(([i, v, t]) =>
        `<span class="ov-chip" title="${esc(t)}"><span aria-hidden="true">${i}</span> ${esc(v)}</span>`).join('')}</div>
      <div class="ov-sun">🌅 ${esc(fmtMinutes(riseMin))} · 🌇 ${esc(fmtMinutes(setMin))} ·
        ${esc(fmtDuration(sun.daylightMinutes))}${nowMin != null && riseMin != null && setMin != null
          ? ` · ${esc(daylightProgress(nowMin, riseMin, setMin))}` : ''}</div>
      <div class="ov-week">${week}</div>
      <div class="ov-more">Full dashboard for ${esc(l.short)} →</div>`;

    const open = () => selectLocation(l.id);
    card.addEventListener('click', open);
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    grid.appendChild(card);
  });
  host.appendChild(grid);
}

/* --- 7-day forecast ------------------------------------------------------ */
function renderForecast(host, l, d) {
  const daily = d.wx.daily || {};
  const times = daily.time || [];
  const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: l.tz });
  let start = times.indexOf(todayISO); if (start < 0) start = 0;
  const idxs = [];
  for (let i = start; i < times.length && idxs.length < 7; i++) idxs.push(i);

  const p = el('section', 'panel');
  p.innerHTML = `<div class="panel-h"><h2>📅 7-day forecast — ${esc(l.name)}</h2>
    <span class="note">Click a day for the full detail</span></div>
    <div class="panel-b"><div class="fc-strip" id="fcStrip"></div><div id="fcDetail"></div></div>`;
  host.appendChild(p);

  const strip = p.querySelector('#fcStrip');
  idxs.forEach((i, n) => {
    const w = wmoInfo(daily.weather_code?.[i], 1);
    const dt = new Date(times[i] + 'T12:00:00');
    const pop = daily.precipitation_probability_max?.[i];
    const c = el('div', 'fc' + (S.fcDay === i ? ' on' : ''));
    c.tabIndex = 0;
    c.setAttribute('role', 'button');
    c.innerHTML = `
      <div class="fc-day">${n === 0 ? 'Today' : dt.toLocaleDateString(undefined, { weekday: 'short' })}</div>
      <div class="fc-date">${dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
      <div class="fc-ico" aria-hidden="true">${w.icon}</div>
      <div class="fc-hi">${fmtNum(daily.temperature_2m_max?.[i], 0)}°</div>
      <div class="fc-lo">${fmtNum(daily.temperature_2m_min?.[i], 0)}°</div>
      <div class="fc-pop">${pop != null && pop > 0 ? `💧 ${Math.round(pop)}%` : ''}</div>`;
    const open = () => { S.fcDay = S.fcDay === i ? -1 : i; renderLive(); };
    c.addEventListener('click', open);
    c.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    c.addEventListener('mouseenter', e => showTip(e,
      `<b>${dt.toLocaleDateString(undefined, { weekday:'long', month:'short', day:'numeric' })}</b><br>
       ${esc(w.label)}<br>High ${fmtNum(daily.temperature_2m_max?.[i],0)}° · Low ${fmtNum(daily.temperature_2m_min?.[i],0)}°<br>
       Rain ${fmtNum(daily.precipitation_sum?.[i],2)} in · UV ${fmtNum(daily.uv_index_max?.[i],1)}`));
    c.addEventListener('mousemove', moveTip);
    c.addEventListener('mouseleave', hideTip);
    strip.appendChild(c);
  });

  if (S.fcDay >= 0 && times[S.fcDay]) {
    const i = S.fcDay;
    const dt = new Date(times[i] + 'T12:00:00');
    const sun = sunTimes(new Date(times[i] + 'T12:00:00Z'), l.lat, l.lon);
    const rows = [
      ['Condition',   wmoInfo(daily.weather_code?.[i], 1).label],
      ['High / Low',  `${fmtNum(daily.temperature_2m_max?.[i],0)}° / ${fmtNum(daily.temperature_2m_min?.[i],0)}°F`],
      ['Feels like',  `${fmtNum(daily.apparent_temperature_max?.[i],0)}° / ${fmtNum(daily.apparent_temperature_min?.[i],0)}°F`],
      ['Chance of precip', `${fmtNum(daily.precipitation_probability_max?.[i],0)}%`],
      ['Precip total', `${fmtNum(daily.precipitation_sum?.[i],2)} in`],
      ['Rain / Showers', `${fmtNum(daily.rain_sum?.[i],2)} / ${fmtNum(daily.showers_sum?.[i],2)} in`],
      ['Snowfall',    `${fmtNum(daily.snowfall_sum?.[i],1)} in`],
      ['Precip hours',`${fmtNum(daily.precipitation_hours?.[i],0)} hrs`],
      ['Max UV index',fmtNum(daily.uv_index_max?.[i],1)],
      ['Wind',        `${fmtNum(daily.wind_speed_10m_max?.[i],0)} mph ${degToCompass(daily.wind_direction_10m_dominant?.[i])}`],
      ['Max gust',    `${fmtNum(daily.wind_gusts_10m_max?.[i],0)} mph`],
      ['Sunrise',     fmtMinutes(localMinutes(sun.sunrise, l.tz))],
      ['Sunset',      fmtMinutes(localMinutes(sun.sunset, l.tz))],
      ['Daylight',    fmtDuration(sun.daylightMinutes)],
      ['Sunshine',    `${fmtNum((daily.sunshine_duration?.[i] || 0) / 3600, 1)} hrs`]
    ];
    p.querySelector('#fcDetail').innerHTML = `
      <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
        <div style="font-size:.85rem;font-weight:700;margin-bottom:11px">
          ${dt.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' })} — full detail</div>
        <div class="dgrid">${rows.map(([a, b]) =>
          `<div class="di"><div class="di-l">${esc(a)}</div><div class="di-v">${esc(String(b))}</div></div>`).join('')}</div>
      </div>`;
  }
}

/* --- hourly: two single-axis charts, never one with two scales ----------- */
function renderHourly(host, l, d) {
  const h = d.wx.hourly || {};
  const times = h.time || [];
  const nowISO = nowLocalHour(l.tz);
  let start = times.findIndex(t => String(t).slice(0, 13) >= nowISO);
  if (start < 0) start = 0;
  const end = Math.min(times.length, start + 48);
  const slice = a => (a || []).slice(start, end);
  const tSlice = times.slice(start, end);
  if (!tSlice.length) return;

  const p = el('section', 'panel');
  p.innerHTML = `<div class="panel-h"><h2>🕘 Next 48 hours — ${esc(l.name)}</h2>
      <span class="note">Shaded bands are night · hover for any hour</span></div>
    <div class="panel-b"><div class="charts">
      <div class="chart"><h3>Temperature</h3><div class="cdesc">Air temperature, hour by hour.</div><svg id="hrTemp"></svg></div>
      <div class="chart"><h3>Chance of precipitation</h3><div class="cdesc">Probability of measurable precipitation.</div><svg id="hrPop"></svg></div>
      <div class="chart"><h3>Wind speed</h3><div class="cdesc">Sustained wind at 10 m.</div><svg id="hrWind"></svg></div>
      <div class="chart"><h3>Humidity</h3><div class="cdesc">Relative humidity.</div><svg id="hrRh"></svg></div>
    </div></div>`;
  host.appendChild(p);

  const day = slice(h.is_day).map(v => !!v);
  const a = accentOf(l);
  hourlyChart($('hrTemp'), { times: tSlice, values: slice(h.temperature_2m), isDayFlags: day, color: a, unit: '°F', label: 'Temp' });
  hourlyChart($('hrPop'),  { times: tSlice, values: slice(h.precipitation_probability), isDayFlags: day, color: isDark() ? '#3987e5' : '#2a78d6', unit: '%', label: 'Chance' });
  hourlyChart($('hrWind'), { times: tSlice, values: slice(h.wind_speed_10m), isDayFlags: day, color: isDark() ? '#199e70' : '#1baf7a', unit: 'mph', label: 'Wind' });
  hourlyChart($('hrRh'),   { times: tSlice, values: slice(h.relative_humidity_2m), isDayFlags: day, color: isDark() ? '#d95926' : '#eb6834', unit: '%', label: 'Humidity' });
}

/* ---------------------------------------------------------------------------
   Precomputed normals.

   data/climate.json is built by scripts/build-climate.mjs and committed, so the
   page normally makes zero archive requests. Building the normals in the
   browser cost roughly 5,500 weighted Open-Meteo calls per load against a
   5,000/hour free-tier cap — the page rate-limited itself. The snapshot is now
   the primary source; live building survives only as the fallback for a period
   the snapshot does not carry.
   ------------------------------------------------------------------------- */
let SNAPSHOT = null;          // null = not loaded yet, false = unavailable

async function loadSnapshot() {
  if (SNAPSHOT !== null) return SNAPSHOT;
  const entry = diagStart('Precomputed normals — data/climate.json', 'data/climate.json');
  try {
    const res = await fetch('data/climate.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (!j || !j.homes) throw new Error('unexpected shape');
    SNAPSHOT = j;
    const sets = Object.values(j.homes).reduce((n, h) => n + Object.keys(h).length, 0);
    diagEnd(entry, 'ok', `${sets} home/period sets, built ${new Date(j.generated).toLocaleDateString()}`);
  } catch (err) {
    SNAPSHOT = false;
    diagEnd(entry, 'fail', `${String(err && err.message || err)} — falling back to building normals live`);
  }
  return SNAPSHOT;
}

function snapshotFor(locId, period) {
  const s = SNAPSHOT;
  return (s && s.homes && s.homes[locId] && s.homes[locId][period]) || null;
}

/* ---------------------------------------------------------------------------
   Climate normals — load, cache, render
   ------------------------------------------------------------------------- */
async function loadClimate(locId, period, force) {
  const key = climKey(locId, period);
  if (S.clim[key] || S.climState[key] === 'loading') { renderClimate(); return; }

  /* 1. The committed snapshot — no network cost beyond one small file. */
  await loadSnapshot();
  const snap = snapshotFor(locId, period);
  if (snap && !force) {
    S.clim[key] = { ...snap, meta: { ...snap.meta, fromSnapshot: true,
                                     snapshotBuilt: SNAPSHOT && SNAPSHOT.generated } };
    S.climState[key] = 'ready';
    renderClimate();
    loadCompareSet();
    return;
  }

  /* 2. Anything this browser built earlier for a period the snapshot lacks. */
  if (!force) {
    const cached = cacheGet(cacheKey('clim', locId, period));
    if (cached && cached.rows) {
      S.clim[key] = cached; S.climState[key] = 'ready';
      renderClimate(); loadCompareSet(); return;
    }
  }

  S.climState[key] = 'loading';
  renderClimate();

  const l = loc(locId);
  const setProgress = (done, total, label) => {
    const bar = $('climProgress'), txt = $('climProgressTxt');
    if (bar) bar.style.width = Math.round(done / total * 100) + '%';
    if (txt) txt.textContent = label || '';
  };

  try {
    const sunClim = monthlySunClimatology(l.lat, l.lon, l.tz);
    const arch = await fetchArchive(l, period, (d, t, lb) => setProgress(d, t + 2, lb));
    let rows = aggregateMonthly(arch.daily, sunClim);
    if (!rows) throw new Error('The archive returned no usable daily records.');

    /* Ocean temperature is a separate model and a separate failure mode. */
    let sstInfo = { years: 0, mode: null, error: null };
    try {
      const marine = await fetchMarineArchive(l, (d, t, lb) => setProgress(d, t + 2, `ocean — ${lb}`));
      if (marine.rows.length) { mergeSST(rows, marine.rows); sstInfo = { years: marine.years, mode: marine.mode, error: null }; }
      else sstInfo.error = 'no rows returned';
    } catch (err) { sstInfo.error = String(err && err.message || err); }

    const payload = {
      rows, annual: annualSummary(rows),
      meta: { period, locId, extended: arch.extended, sst: sstInfo, built: Date.now(),
              elevation: arch.meta && arch.meta.elevation }
    };
    S.clim[key] = payload; S.climState[key] = 'ready';
    cacheSet(cacheKey('clim', locId, period), payload);
  } catch (err) {
    S.climState[key] = 'error';
    S.clim[key] = {
      error: String(err && err.message || err),
      rateLimited: err && err.name === 'RateLimitError',
      window: err && err.window
    };
  }
  renderClimate();
  renderDiagnostics();
  loadCompareSet();
}

/* Comparison needs all three homes. When the snapshot covers them that is free,
   so they load immediately. When it does not, each home would mean another
   ~1,800 weighted API calls, so the user is asked first rather than having
   three archive pulls fired off on their behalf. */
function loadCompareSet(userAsked) {
  LOCATIONS.forEach(l => {
    const k = climKey(l.id, S.period);
    if (S.clim[k] || S.climState[k] === 'loading') return;
    if (snapshotFor(l.id, S.period) || userAsked) loadClimate(l.id, S.period);
  });
  renderCompare();
}

/* True when some home still needs a live build for the comparison. */
function compareNeedsFetch() {
  return LOCATIONS.some(l => {
    const k = climKey(l.id, S.period);
    return !S.clim[k] && !snapshotFor(l.id, S.period);
  });
}

function renderClimate() {
  if (isAll()) {
    $('climateStatus').innerHTML = `<div class="banner info"><span class="bico">🏘️</span><div>
      <b>Showing all three homes.</b> The comparison below plots any measure for
      each home on one axis. For a single home's full climate detail — every
      chart, the KPI cards and the sortable table — pick it from the tabs at the
      top of the page.</div></div>`;
    $('kpis').innerHTML = ''; $('charts').innerHTML = '';
    $('detail').classList.remove('show');
    clearTable();
    $('tableNote').textContent = '— pick a home above to see its monthly table';
    return;
  }
  const key = climKey(S.locId, S.period);
  const state = S.climState[key];
  const box = $('climateStatus');

  if (state === 'loading') {
    box.innerHTML = `<div class="panel"><div class="panel-b" style="text-align:center;padding:34px 20px">
      <div class="spin" aria-hidden="true"></div>
      <div style="font-size:.88rem;font-weight:600">Building ${esc(PERIODS[S.period].label)} for ${esc(loc().name)}…</div>
      <div style="font-size:.76rem;color:var(--muted);margin-top:5px">
        Reading ${PERIODS[S.period].years} years of daily ERA5 records, then ${SST_PERIOD.years} years of ocean data.
        This runs once — the result is cached in your browser.</div>
      <div class="bar"><div id="climProgress"></div></div>
      <div id="climProgressTxt" style="font-size:.73rem;color:var(--muted)"></div>
    </div></div>`;
    $('kpis').innerHTML = ''; $('charts').innerHTML = ''; clearTable();
    return;
  }

  const c = curClim();
  if (!c || c.error) {
    box.innerHTML = c && c.rateLimited ? rateLimitBanner(c) : `
      <div class="banner err"><span class="bico">⚠️</span><div>
        <b>Could not build the monthly normals for ${esc(loc().name)}.</b>
        ${esc(c && c.error || 'Unknown error.')}
        <br>Live conditions above still work. Press <b>↻ Rebuild normals</b> to retry.</div></div>`;
    $('kpis').innerHTML = ''; $('charts').innerHTML = ''; clearTable();
    return;
  }

  box.innerHTML = climateNotes(c);
  renderKPIs(); renderDetail(); renderCharts(); renderTable();
}

/* Rate limits are not a bug the user can fix by retrying, so say what actually
   happened, when it clears, and what still works meanwhile. */
function rateLimitBanner(c) {
  const clears = c.window === 'minute' ? 'in about a minute'
               : c.window === 'hour'   ? 'at the top of the next hour'
               : c.window === 'day'    ? 'tomorrow'
               : 'shortly';
  const inSnapshot = SNAPSHOT && SNAPSHOT.homes && Object.keys(SNAPSHOT.homes).length;
  return `<div class="banner warn"><span class="bico">⏳</span><div>
    <b>Open-Meteo's free-tier limit was reached, so this period could not be built.</b>
    The quota clears ${esc(clears)}.
    ${inSnapshot ? `Switch back to <b>${esc(PERIODS[DEFAULT_PERIOD].label)}</b> — that one is
      precomputed and needs no API calls at all.`
    : `The precomputed normals file is missing, so every period has to be built live.
      See the Data sources panel below.`}
    <br>Live conditions and the forecast above are unaffected — they are tiny by comparison.
    </div></div>`;
}

function climateNotes(c) {
  const bits = [];
  if (c.meta && c.meta.fromSnapshot) bits.push(`<div class="banner info"><span class="bico">⚡</span><div>
    <b>Loaded from the precomputed normals</b>${c.meta.snapshotBuilt
      ? ` built ${esc(new Date(c.meta.snapshotBuilt).toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'}))}`
      : ''} — no historical API requests were needed for this.</div></div>`);
  else if (c.rows) bits.push(`<div class="banner warn"><span class="bico">🐢</span><div>
    <b>This period is not in the precomputed set, so it was built live.</b>
    That costs roughly 1,800 weighted Open-Meteo calls against a 5,000/hour free-tier
    cap, which is why it was slow. It is cached in this browser for 30 days.
    ${esc(PERIODS[DEFAULT_PERIOD].label)} loads instantly.</div></div>`);
  if (!c.meta.extended) bits.push(`<div class="banner warn"><span class="bico">ℹ️</span><div>
    <b>Humidity, dew point, cloud cover and pressure are unavailable for this period.</b>
    The archive rejected the extended variable set, so those four charts are hidden.
    Everything else is unaffected.</div></div>`);
  if (c.meta.sst && !c.meta.sst.years) bits.push(`<div class="banner warn"><span class="bico">🌊</span><div>
    <b>Ocean temperature history could not be retrieved.</b>
    ${esc(c.meta.sst.error || '')} The ocean charts are hidden; the live water
    temperature above is fetched separately and may still be working.</div></div>`);
  return bits.join('');
}

/* --- KPI cards ----------------------------------------------------------- */
function renderKPIs() {
  const c = curClim(); if (!c || !c.rows) return;
  const a = c.annual, rows = c.rows, l = loc(), col = accentOf(l);
  const mName = r => r ? MONTHS_FULL[r.month] : '—';
  const spark = k => sparkLine(rows.map(r => r[k]), col);

  const cards = [
    { l:'Warmest month',      v: mName(a.warmest),    s: `${fmtNum(a.warmest?.avgHigh,1)}°F average high`,      m:a.warmest?.month,  k:'avgHigh' },
    { l:'Coldest month',      v: mName(a.coldest),    s: `${fmtNum(a.coldest?.avgLow,1)}°F average low`,        m:a.coldest?.month,  k:'avgLow' },
    { l:'Annual precipitation', v: `${fmtNum(a.annualPrecip,1)} in`, s: `${fmtNum(a.annualWetDays,0)} wet days a year`, m:-1, k:'precipTotal' },
    { l:'Wettest month',      v: mName(a.wettest),    s: `${fmtNum(a.wettest?.precipTotal,2)} in typical`,      m:a.wettest?.month,  k:'precipTotal' },
    { l:'Driest month',       v: mName(a.driest),     s: `${fmtNum(a.driest?.precipTotal,2)} in typical`,       m:a.driest?.month,   k:'precipTotal' },
    { l:'Sunniest month',     v: mName(a.sunniest),   s: `${fmtNum(a.sunniest?.sunnyDays,1)} sunny days`,       m:a.sunniest?.month, k:'sunnyDays' },
    { l:'Sunny days a year',  v: fmtNum(a.annualSunnyDays,0), s: `${fmtNum(a.meanSunHours,1)} sun hours/day avg`, m:-1, k:'sunnyDays' },
    { l:'Cloudiest month',    v: mName(a.cloudiest),  s: `${fmtNum(a.cloudiest?.cloudyDays,1)} cloudy days`,    m:a.cloudiest?.month,k:'cloudyDays' },
    { l:'Days ≥ 90°F a year', v: fmtNum(a.annualHot90,0), s: `${fmtNum(a.annualHot95,0)} of them reach 95°F`,   m:-1, k:'hot90' },
    { l:'Days ≤ 32°F a year', v: fmtNum(a.annualFreeze,0), s: `Coldest night ${fmtNum(a.recordLow?.recordLow,0)}°F on record`, m:-1, k:'freeze32' },
    { l:'Best beach month',   v: mName(a.bestBeach),  s: `${fmtNum(a.bestBeach?.beachDays,1)} beach-quality days`, m:a.bestBeach?.month, k:'beachDays' },
    { l:'Most pleasant month',v: mName(a.bestPleasant), s: `${fmtNum(a.bestPleasant?.pleasantDays,1)} mild, dry days`, m:a.bestPleasant?.month, k:'pleasantDays' }
  ];

  if (a.annualSnow > 0.05) cards.push(
    { l:'Annual snowfall', v: `${fmtNum(a.annualSnow,1)} in`, s: `Snowiest: ${mName(a.snowiest)} (${fmtNum(a.snowiest?.snowfall,1)} in)`, m:a.snowiest?.month, k:'snowfall' });
  if (a.meanSST != null) cards.push(
    { l:'Warmest ocean month', v: mName(a.warmestOcean), s: `${fmtNum(a.warmestOcean?.sst,1)}°F water`, m:a.warmestOcean?.month, k:'sst' },
    { l:'Coldest ocean month', v: mName(a.coldestOcean), s: `${fmtNum(a.coldestOcean?.sst,1)}°F water`, m:a.coldestOcean?.month, k:'sst' });
  cards.push(
    { l:'Longest day',   v: mName(a.longestDay),  s: `${fmtDuration((a.longestDay?.daylight||0)*60)} of daylight`,  m:a.longestDay?.month,  k:'daylight' },
    { l:'Shortest day',  v: mName(a.shortestDay), s: `${fmtDuration((a.shortestDay?.daylight||0)*60)} of daylight`, m:a.shortestDay?.month, k:'daylight' },
    { l:'Heating degree days', v: fmtNum(a.annualHDD,0), s: 'Annual HDD, base 65°F', m:-1, k:'hdd' },
    { l:'Cooling degree days', v: fmtNum(a.annualCDD,0), s: 'Annual CDD, base 65°F', m:-1, k:'cdd' },
    { l:'Hottest on record', v: `${fmtNum(a.recordHigh?.recordHigh,0)}°F`, s: `in ${mName(a.recordHigh)}`, m:a.recordHigh?.month, k:'recordHigh' },
    { l:'Windiest month', v: mName(a.windiest), s: `${fmtNum(a.windiest?.windMax,1)} mph average peak`, m:a.windiest?.month, k:'windMax' });

  $('kpis').innerHTML = cards.map((c2, i) =>
    `<button class="kpi" type="button" data-m="${c2.m ?? -1}" style="border-left-color:${col}">
       <div class="kpi-l">${esc(c2.l)}</div>
       <div class="kpi-v">${esc(String(c2.v))}</div>
       <div class="kpi-s">${esc(String(c2.s))}</div>
       <div class="kpi-spark">${c2.k ? spark(c2.k) : ''}</div>
     </button>`).join('');

  $('kpis').querySelectorAll('.kpi').forEach(b => b.addEventListener('click', () => {
    const m = +b.dataset.m;
    if (m >= 0) selectMonth(m);
  }));
}

/* --- month detail -------------------------------------------------------- */
function renderDetail() {
  const c = curClim(), d = $('detail');
  if (!c || !c.rows || S.month < 0) { d.classList.remove('show'); return; }
  const r = c.rows[S.month], l = loc();
  $('detailTitle').textContent = `${MONTHS_FULL[S.month]} in ${l.name}, ${l.state} — ${PERIODS[S.period].label}`;

  let html = '';
  for (const [gk, g] of Object.entries(GROUPS)) {
    const list = METRICS.filter(m => m.group === gk && r[m.key] != null);
    if (!list.length) continue;
    html += `<div class="dgroup-title">${g.icon} ${esc(g.label)}</div>`;
    html += list.map(m => `<div class="di" title="${esc(m.desc)}">
      <div class="di-l">${esc(m.label)}</div>
      <div class="di-v">${esc(displayValue(r, m))}</div></div>`).join('');
  }
  html += `<div class="dgroup-title">📐 Sample</div>
    <div class="di"><div class="di-l">Days averaged</div><div class="di-v">${fmtNum(r.sampleDays,0)}</div></div>
    <div class="di"><div class="di-l">Years averaged</div><div class="di-v">${fmtNum(r.sampleYears,0)}</div></div>
    <div class="di"><div class="di-l">Wettest ${esc(MONTHS_FULL[S.month])} on record</div><div class="di-v">${fmtNum(r.wettestMonthOnRecord,2)} in</div></div>
    <div class="di"><div class="di-l">Driest ${esc(MONTHS_FULL[S.month])} on record</div><div class="di-v">${fmtNum(r.driestMonthOnRecord,2)} in</div></div>`;
  $('detailGrid').innerHTML = html;
  d.classList.add('show');
}

/* --- chart grid ---------------------------------------------------------- */
function renderCharts() {
  const c = curClim(); if (!c || !c.rows) return;
  const rows = c.rows, l = loc(), col = accentOf(l), host = $('charts');
  const has = k => rows.some(r => r[k] != null);
  const vals = k => rows.map(r => r[k]);
  const sel = S.month;
  const onClick = i => selectMonth(i);

  /* Each entry: [group, wide?, title, description, render(svg)] */
  const defs = [];

  defs.push(['temp', true, 'Average high and low temperature',
    'The envelope of a typical day, month by month. The shaded band is the gap between the two — how far the temperature travels between afternoon and dawn.',
    svg => rangeChart(svg, { high: vals('avgHigh'), low: vals('avgLow'), labels: MONTHS, selected: sel, onClick,
      extra: has('avgMean') ? { values: vals('avgMean'), color: isDark() ? '#c3c2b7' : '#52514e', label: 'Daily mean' } : null })]);

  defs.push(['temp', false, 'Record high and record low',
    `The most extreme readings in the whole ${PERIODS[S.period].years}-year period — not an average.`,
    svg => rangeChart(svg, { high: vals('recordHigh'), low: vals('recordLow'), labels: MONTHS, selected: sel, onClick, height: 240,
      highLabel: 'Record high', lowLabel: 'Record low', swingLabel: 'Spread' })]);

  defs.push(['temp', false, 'Day-to-night temperature swing',
    'Average high minus average low. Coastal homes swing less than inland ones.',
    svg => barChart(svg, { values: vals('diurnal'), labels: MONTHS, color: col, unit: '°F', dec: 1, selected: sel, onClick })]);

  if (has('apparentHigh')) defs.push(['temp', false, 'Feels-like high',
    'Apparent temperature — what the afternoon actually feels like once humidity and wind are folded in.',
    svg => barChart(svg, { values: vals('apparentHigh'), labels: MONTHS, color: isDark() ? '#d95926' : '#eb6834', unit: '°F', dec: 1, selected: sel, onClick, zeroBase: false })]);

  defs.push(['water', false, 'Average total precipitation',
    'Rain plus melted snow, as a monthly total. Hover for the driest and wettest that month has ever been.',
    svg => barChart(svg, { values: vals('precipTotal'), labels: MONTHS, color: isDark() ? '#3987e5' : '#2a78d6', unit: 'in', dec: 2, selected: sel, onClick,
      tipFmt: i => `<b>${MONTHS_FULL[i]}</b><br>Typical ${fmtNum(rows[i].precipTotal,2)} in<br>
        Rain only ${fmtNum(rows[i].rainfall,2)} in<br>
        Range ${fmtNum(rows[i].precipP10,2)}–${fmtNum(rows[i].precipP90,2)} in<br>
        Wettest on record ${fmtNum(rows[i].wettestMonthOnRecord,2)} in` })]);

  defs.push(['water', false, 'Average wet days',
    'Days with at least 0.04 in (1 mm) of precipitation — the standard "rain day" threshold.',
    svg => barChart(svg, { values: vals('wetDays'), labels: MONTHS, color: isDark() ? '#3987e5' : '#2a78d6', unit: 'days', dec: 1, selected: sel, onClick })]);

  defs.push(['water', false, 'Dry days',
    'The complement of wet days — how much of the month stays rain-free.',
    svg => barChart(svg, { values: vals('dryDays'), labels: MONTHS, color: isDark() ? '#d18b06' : '#b06f00', unit: 'days', dec: 1, selected: sel, onClick })]);

  defs.push(['water', false, 'Heavy rain days',
    'Days delivering an inch or more — the ones that flood a yard.',
    svg => barChart(svg, { values: vals('heavyRainDays'), labels: MONTHS, color: isDark() ? '#3987e5' : '#2a78d6', unit: 'days', dec: 1, selected: sel, onClick })]);

  if (has('snowfall') && rows.some(r => r.snowfall > 0.05)) {
    defs.push(['water', false, 'Average snowfall',
      'Monthly snowfall total. Coastal Carolina and southwest Florida sit at essentially zero all year — that flat line is the real answer.',
      svg => barChart(svg, { values: vals('snowfall'), labels: MONTHS, color: isDark() ? '#c3c2b7' : '#52514e', unit: 'in', dec: 2, selected: sel, onClick })]);
    defs.push(['water', false, 'Average snow days',
      'Days receiving at least 0.1 in of snow.',
      svg => barChart(svg, { values: vals('snowDays'), labels: MONTHS, color: isDark() ? '#c3c2b7' : '#52514e', unit: 'days', dec: 1, selected: sel, onClick })]);
  }

  defs.push(['sun', true, 'Sky conditions by month',
    'Every day of the month sorted by how much of the available daylight was actually sunny: sunny ≥ 70%, partly 35–70%, cloudy below 35%.',
    svg => stackedBar(svg, {
      stacks: rows.map(r => [r.sunnyDays, r.partlyDays, r.cloudyDays]),
      labels: MONTHS, seriesLabels: ['Sunny', 'Partly sunny', 'Cloudy'],
      ramp: isDark() ? SKY_RAMP.dark : SKY_RAMP.light, selected: sel, onClick })]);

  defs.push(['sun', false, 'Average sunny days',
    'Days where sunshine covered at least 70% of the daylight hours.',
    svg => barChart(svg, { values: vals('sunnyDays'), labels: MONTHS, color: isDark() ? '#fbbf24' : '#eda100', unit: 'days', dec: 1, selected: sel, onClick })]);

  defs.push(['sun', false, 'Sunshine hours per day',
    'Average hours of direct sunshine each day.',
    svg => barChart(svg, { values: vals('sunHours'), labels: MONTHS, color: isDark() ? '#fbbf24' : '#eda100', unit: 'hrs', dec: 1, selected: sel, onClick })]);

  defs.push(['sun', false, 'Percent of possible sunshine',
    'Sunshine received divided by daylight available — strips out the seasonal change in day length.',
    svg => barChart(svg, { values: vals('pctSun'), labels: MONTHS, color: isDark() ? '#d18b06' : '#b06f00', unit: '%', dec: 0, selected: sel, onClick })]);

  defs.push(['sun', false, 'Solar energy received',
    'Daily shortwave radiation at the surface — what a rooftop solar array has to work with.',
    svg => barChart(svg, { values: vals('solarKwh'), labels: MONTHS, color: isDark() ? '#fbbf24' : '#eda100', unit: 'kWh/m²', dec: 2, selected: sel, onClick })]);

  if (has('sst')) {
    const m = l.marine;
    defs.push(['ocean', true, `${m.body} temperature`,
      `Monthly mean sea-surface temperature at ${esc(m.label)}${m.proxy ? ' — a nearest-coast reference, not water at this home' : ''}. Built from ${SST_PERIOD.years} years of marine model data.`,
      svg => rangeChart(svg, { high: vals('sstMax'), low: vals('sstMin'), labels: MONTHS, selected: sel, onClick,
        extra: { values: vals('sst'), color: isDark() ? '#199e70' : '#1baf7a', label: 'Monthly mean' }, height: 260,
        highLabel: 'Daily warmest', lowLabel: 'Daily coolest', swingLabel: 'Daily range' })]);
    defs.push(['ocean', false, 'Swimmable water',
      'The monthly mean again, plainly: above about 70°F most people will swim without a wetsuit.',
      svg => barChart(svg, { values: vals('sst'), labels: MONTHS, color: isDark() ? '#199e70' : '#1baf7a', unit: '°F', dec: 1, selected: sel, onClick, zeroBase: false,
        tipFmt: i => `<b>${MONTHS_FULL[i]}</b><br>${fmtNum(rows[i].sst,1)}°F mean<br>${esc(swimLabel(rows[i].sst))}` })]);
  }
  if (has('waveHeight')) defs.push(['ocean', false, 'Average wave height',
    'Significant wave height offshore — the average of the largest third of waves.',
    svg => barChart(svg, { values: vals('waveHeight'), labels: MONTHS, color: isDark() ? '#199e70' : '#1baf7a', unit: 'ft', dec: 1, selected: sel, onClick })]);

  defs.push(['sky', true, 'Sunrise, sunset and daylight through the year',
    `Every day of the year for ${esc(l.name)}. The lit band is daylight; the vertical dashes mark the solstices and equinoxes. The step in March and November is daylight saving time, which is why the curve jumps rather than bends.`,
    svg => daylightRibbon(svg, { curve: dailySunCurve(l.lat, l.lon, l.tz), tz: 'local clock time' })]);

  defs.push(['sky', true, 'Average sunrise and sunset by month',
    'Mean local clock time of sunrise and sunset for each month, with solar noon between them. These are wall-clock times, so daylight saving is baked in — which is why sunrise jumps an hour between February and April.',
    svg => rangeChart(svg, {
      high: vals('sunsetMin'), low: vals('sunriseMin'), labels: MONTHS, selected: sel, onClick, height: 280,
      highLabel: 'Sunset', lowLabel: 'Sunrise', swingLabel: 'Daylight', padAxis: 62,
      extra: { values: vals('solarNoonMin'), color: isDark() ? '#c3c2b7' : '#52514e', label: 'Solar noon' },
      yFmt: v => fmtMinutes(v), valFmt: v => fmtMinutes(v) })]);

  defs.push(['sky', false, 'Average daylight per day',
    'Sunrise to sunset, averaged across each month.',
    svg => barChart(svg, { values: vals('daylight'), labels: MONTHS, color: isDark() ? '#fbbf24' : '#eda100', unit: 'hrs', dec: 2, selected: sel, onClick,
      tipFmt: i => `<b>${MONTHS_FULL[i]}</b><br>Daylight ${fmtDuration(rows[i].daylight*60)}<br>
        Sunrise ${fmtMinutes(rows[i].sunriseMin)}<br>Sunset ${fmtMinutes(rows[i].sunsetMin)}<br>
        Solar noon ${fmtMinutes(rows[i].solarNoonMin)}` })]);

  if (has('humidity')) defs.push(['air', false, 'Average relative humidity',
    'Daily mean relative humidity.',
    svg => barChart(svg, { values: vals('humidity'), labels: MONTHS, color: isDark() ? '#3987e5' : '#2a78d6', unit: '%', dec: 0, selected: sel, onClick })]);
  if (has('dewPoint')) defs.push(['air', false, 'Average dew point',
    'The honest muggy-ness measure: above 65°F feels sticky, above 70°F feels oppressive.',
    svg => barChart(svg, { values: vals('dewPoint'), labels: MONTHS, color: isDark() ? '#199e70' : '#1baf7a', unit: '°F', dec: 1, selected: sel, onClick, zeroBase: false,
      tipFmt: i => `<b>${MONTHS_FULL[i]}</b><br>${fmtNum(rows[i].dewPoint,1)}°F<br>${esc(dewLabel(rows[i].dewPoint))}` })]);
  if (has('cloudCover')) defs.push(['air', false, 'Average cloud cover',
    'Mean fraction of the sky covered by cloud.',
    svg => barChart(svg, { values: vals('cloudCover'), labels: MONTHS, color: isDark() ? '#c3c2b7' : '#52514e', unit: '%', dec: 0, selected: sel, onClick })]);
  defs.push(['air', false, 'Average peak wind',
    'Mean of the daily maximum sustained wind.',
    svg => barChart(svg, { values: vals('windMax'), labels: MONTHS, color: isDark() ? '#199e70' : '#1baf7a', unit: 'mph', dec: 1, selected: sel, onClick })]);
  defs.push(['air', false, 'Average peak gust',
    'Mean of the daily maximum gust — the number that matters for awnings and boats.',
    svg => barChart(svg, { values: vals('windGust'), labels: MONTHS, color: isDark() ? '#199e70' : '#1baf7a', unit: 'mph', dec: 1, selected: sel, onClick })]);
  if (has('pressure')) defs.push(['air', false, 'Average sea-level pressure',
    'Monthly mean barometric pressure.',
    svg => barChart(svg, { values: vals('pressure'), labels: MONTHS, color: isDark() ? '#c3c2b7' : '#52514e', unit: 'inHg', dec: 2, selected: sel, onClick, zeroBase: false })]);

  defs.push(['thresh', false, 'Days at or above 90°F',
    'How much of the month is genuinely hot.',
    svg => barChart(svg, { values: vals('hot90'), labels: MONTHS, color: isDark() ? '#e66767' : '#e34948', unit: 'days', dec: 1, selected: sel, onClick })]);
  defs.push(['thresh', false, 'Days at or below freezing',
    'Nights that drop to 32°F or colder.',
    svg => barChart(svg, { values: vals('freeze32'), labels: MONTHS, color: isDark() ? '#3987e5' : '#2a78d6', unit: 'days', dec: 1, selected: sel, onClick })]);
  defs.push(['thresh', false, 'Beach days',
    'Days with a high of 75–95°F, under 0.04 in of rain, and sunshine covering at least half the daylight.',
    svg => barChart(svg, { values: vals('beachDays'), labels: MONTHS, color: isDark() ? '#fbbf24' : '#eda100', unit: 'days', dec: 1, selected: sel, onClick })]);
  defs.push(['thresh', false, 'Pleasant days',
    'High 65–85°F, low no colder than 45°F, and dry — porch weather.',
    svg => barChart(svg, { values: vals('pleasantDays'), labels: MONTHS, color: isDark() ? '#199e70' : '#1baf7a', unit: 'days', dec: 1, selected: sel, onClick })]);

  defs.push(['energy', false, 'Heating degree days',
    'How hard the furnace has to work: the shortfall below 65°F, summed over the month.',
    svg => barChart(svg, { values: vals('hdd'), labels: MONTHS, color: isDark() ? '#3987e5' : '#2a78d6', unit: 'HDD', dec: 0, selected: sel, onClick })]);
  defs.push(['energy', false, 'Cooling degree days',
    'The same for air conditioning: the excess above 65°F, summed over the month.',
    svg => barChart(svg, { values: vals('cdd'), labels: MONTHS, color: isDark() ? '#e66767' : '#e34948', unit: 'CDD', dec: 0, selected: sel, onClick })]);
  defs.push(['energy', false, 'Growing degree days',
    'Accumulated warmth above 50°F — the gardening clock.',
    svg => barChart(svg, { values: vals('gdd'), labels: MONTHS, color: isDark() ? '#199e70' : '#1baf7a', unit: 'GDD', dec: 0, selected: sel, onClick })]);
  defs.push(['energy', false, 'Reference evapotranspiration',
    'How much water a well-watered lawn loses per month — irrigation demand.',
    svg => barChart(svg, { values: vals('et0'), labels: MONTHS, color: isDark() ? '#199e70' : '#1baf7a', unit: 'in', dec: 2, selected: sel, onClick })]);

  const shown = defs.filter(d => S.group === 'all' || d[0] === S.group);
  host.innerHTML = shown.map((d, i) =>
    `<div class="chart${d[1] ? ' wide' : ''}">
       <h3>${esc(d[2])}</h3><div class="cdesc">${d[3]}</div><svg id="ch${i}"></svg></div>`).join('');
  shown.forEach((d, i) => { const s = $('ch' + i); if (s) try { d[4](s); } catch (err) { s.outerHTML = `<div style="color:var(--muted);font-size:.8rem">Chart unavailable: ${esc(String(err.message || err))}</div>`; } });
}

/* ---------------------------------------------------------------------------
   Compare — one measure, all three homes on a single axis
   ------------------------------------------------------------------------- */
function renderCompare() {
  const m = METRIC_BY_KEY[S.compareKey];
  const box = $('compareChartBox'), tbox = $('compareTableBox');
  const ready = LOCATIONS.filter(l => { const c = S.clim[climKey(l.id, S.period)]; return c && c.rows; });
  const pending = LOCATIONS.length - ready.length;

  const needsFetch = compareNeedsFetch();
  $('compareNote').innerHTML = needsFetch
    ? `<span style="color:var(--muted)">${pending} home${pending === 1 ? '' : 's'} not in the
       precomputed set for this period — building them live costs about
       ${1800 * pending} weighted API calls.</span>
       <button class="btn" id="btnLoadCompare" style="margin-left:8px">Load anyway</button>`
    : pending
      ? `Loading ${pending} more location${pending === 1 ? '' : 's'}…`
      : `${esc(PERIODS[S.period].label)} · all three homes`;
  const lb = $('btnLoadCompare');
  if (lb) lb.addEventListener('click', () => {
    lb.disabled = true; lb.textContent = 'Loading…';
    loadCompareSet(true);
  });

  if (!ready.length) {
    box.innerHTML = `<h3>${esc(m.label)}</h3><div class="cdesc">Waiting for the monthly normals to finish building.</div>`;
    tbox.innerHTML = ''; return;
  }

  const series = ready.map(l => ({
    label: `${l.name}, ${l.state}`,
    shortLabel: l.state,
    color: accentOf(l),
    values: S.clim[climKey(l.id, S.period)].rows.map(r => r[m.key])
  }));

  const anyData = series.some(s => s.values.some(v => v != null));
  box.innerHTML = `<h3>${esc(m.label)} — all three homes</h3>
    <div class="cdesc">${esc(m.desc)}${m.unit && m.unit !== 'time' ? ` · measured in ${esc(m.unit)}` : ''}.
    ${pending ? ' Locations still loading will appear automatically.' : ''}</div>
    <svg id="cmpSvg"></svg>`;

  if (!anyData) {
    box.querySelector('#cmpSvg').outerHTML =
      `<div style="color:var(--muted);font-size:.82rem;padding:20px 0">No data for this measure at these locations.</div>`;
  } else if (m.unit === 'time') {
    /* Clock times are minutes-after-midnight; plot them but label as times. */
    multiLine($('cmpSvg'), { series, labels: MONTHS, unit: '', dec: 0, selected: S.month,
      onClick: i => selectMonth(i), height: 320 });
  } else {
    multiLine($('cmpSvg'), { series, labels: MONTHS, unit: m.unit, dec: m.dec, selected: S.month,
      onClick: i => selectMonth(i), height: 320 });
  }

  /* Side-by-side table, which is also the relief for the low-contrast series. */
  const fmtCell = (v) => m.unit === 'time' ? fmtMinutes(v) : (v == null ? '—' : fmtVal(v, m.dec, m.unit));
  const annualOf = vals => {
    const nums = vals.filter(v => typeof v === 'number' && isFinite(v));
    if (!nums.length) return '—';
    const isSum = ['precipTotal','rainfall','snowfall','precipHours','et0','wetDays','heavyRainDays',
                   'dryDays','snowDays','sunnyDays','partlyDays','cloudyDays','hot90','hot95',
                   'freeze32','freeze20','beachDays','pleasantDays','hdd','cdd','gdd'].includes(m.key);
    const v = isSum ? nums.reduce((a, b) => a + b, 0) : nums.reduce((a, b) => a + b, 0) / nums.length;
    return `${fmtVal(v, m.dec, m.unit)} ${isSum ? 'total' : 'avg'}`;
  };

  tbox.innerHTML = `
    <div class="panel-h"><h2>${esc(m.label)} side by side</h2>
      <span class="note">${esc(m.desc)}</span></div>
    <div class="panel-b tscroll"><table>
      <thead><tr><th>Home</th>${MONTHS.map(x => `<th>${x}</th>`).join('')}<th>Year</th></tr></thead>
      <tbody>${ready.map((l, li) => `<tr data-l="${l.id}">
        <td><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${accentOf(l)};margin-right:6px"></span>${esc(l.short)}, ${l.state}</td>
        ${series[li].values.map((v, i) => `<td${i === S.month ? ' class="lo"' : ''}>${fmtCell(v)}</td>`).join('')}
        <td style="font-weight:700">${annualOf(series[li].values)}</td></tr>`).join('')}</tbody>
    </table></div>`;
  tbox.querySelectorAll('tbody tr').forEach(tr =>
    tr.addEventListener('click', () => selectLocation(tr.dataset.l)));
}

/* ---------------------------------------------------------------------------
   Sortable monthly table
   ------------------------------------------------------------------------- */
function tableMetrics() {
  const c = curClim(); if (!c || !c.rows) return [];
  return METRICS.filter(m => c.rows.some(r => r[m.key] != null));
}

function clearTable() {
  $('tbl').querySelector('thead').innerHTML = '';
  $('tbl').querySelector('tbody').innerHTML = '';
  $('tableNote').textContent = '';
}

function renderTable() {
  const c = curClim(); if (!c || !c.rows) { clearTable(); return; }
  const mets = tableMetrics(), l = loc();
  $('tableNote').textContent = `— ${l.name}, ${l.state} · ${PERIODS[S.period].label} · ${mets.length} measures`;

  const arrow = k => S.sort.key === k ? (S.sort.dir > 0 ? '▲' : '▼') : '⇅';
  $('tbl').querySelector('thead').innerHTML =
    `<tr><th tabindex="0" data-k="month" class="${S.sort.key === 'month' ? 'sorted' : ''}">Month <span class="arrow">${arrow('month')}</span></th>`
    + mets.map(m => `<th tabindex="0" data-k="${m.key}" title="${esc(m.desc)}" class="${S.sort.key === m.key ? 'sorted' : ''}">${esc(m.label)}${m.unit && m.unit !== 'time' ? ` (${esc(m.unit)})` : ''} <span class="arrow">${arrow(m.key)}</span></th>`).join('')
    + `</tr>`;

  const rows = [...c.rows].sort((a, b) => {
    const k = S.sort.key;
    const av = a[k], bv = b[k];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;          // nulls always sink
    if (bv == null) return -1;
    return (av < bv ? -1 : av > bv ? 1 : 0) * S.sort.dir;
  });

  /* Highest and lowest in each column get a colour cue, plus bold weight so
     the emphasis is never carried by colour alone. */
  const extremes = {};
  for (const m of mets) {
    const vals = c.rows.map(r => r[m.key]).filter(v => typeof v === 'number' && isFinite(v));
    if (vals.length < 2) continue;
    const max = Math.max(...vals), min = Math.min(...vals);
    /* A column where every month is identical has no highest or lowest —
       marking one would invent a distinction that is not in the data. */
    if (max !== min) extremes[m.key] = { max, min };
  }

  $('tbl').querySelector('tbody').innerHTML = rows.map(r => {
    const cells = mets.map(m => {
      const v = r[m.key];
      const e = extremes[m.key];
      const cls = e && v === e.max ? 'hi' : e && v === e.min ? 'lo' : '';
      return `<td class="${cls}">${m.unit === 'time' ? fmtMinutes(v) : (v == null ? '—' : fmtVal(v, m.dec, ''))}</td>`;
    }).join('');
    return `<tr data-m="${r.month}" class="${r.month === S.month ? 'on' : ''}"><td>${esc(r.monthFull)}</td>${cells}</tr>`;
  }).join('');

  $('tbl').querySelectorAll('thead th').forEach(th => {
    const go = () => {
      const k = th.dataset.k;
      /* Month sorts ascending first; measures sort descending first, because
         "which month has the most" is the usual question. */
      if (S.sort.key === k) S.sort.dir *= -1;
      else S.sort = { key: k, dir: k === 'month' ? 1 : -1 };
      renderTable();
    };
    th.addEventListener('click', go);
    th.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
  $('tbl').querySelectorAll('tbody tr').forEach(tr =>
    tr.addEventListener('click', () => selectMonth(+tr.dataset.m)));
}

/* --- CSV ---------------------------------------------------------------- */
function exportCSV() {
  const c = curClim(); if (!c || !c.rows) return;
  const l = loc(), mets = tableMetrics();
  const head = ['Month', ...mets.map(m => `${m.label}${m.unit && m.unit !== 'time' ? ` (${m.unit})` : ''}`)];
  const q = s => `"${String(s).replace(/"/g, '""')}"`;
  const lines = [
    q(`${l.name}, ${l.state} — monthly climate normals`),
    q(`Period: ${PERIODS[S.period].label}`),
    q(`Coordinates: ${l.lat}, ${l.lon} · elevation ${l.elevationFt} ft · ${l.tz}`),
    q(`Ocean point: ${l.marine.label}`),
    q(`Source: Open-Meteo ERA5 archive; sunrise/sunset computed with the NOAA solar equations`),
    q(`Generated ${new Date().toISOString()}`),
    '',
    head.map(q).join(',')
  ];
  for (const r of c.rows) {
    lines.push([q(r.monthFull), ...mets.map(m => {
      const v = r[m.key];
      if (v == null) return '';
      return m.unit === 'time' ? q(fmtMinutes(v)) : (+v).toFixed(m.dec);
    })].join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${l.id}-climate-normals-${S.period}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------------------------------------------------------------------------
   Banners, diagnostics, footer
   ------------------------------------------------------------------------- */
function renderBanners() {
  const failed = LOCATIONS.filter(l => S.live[l.id] && S.live[l.id].error);
  $('banners').innerHTML = failed.length === LOCATIONS.length
    ? `<div class="banner err"><span class="bico">📡</span><div>
        <b>No live data reached this page.</b>
        Every forecast request failed — usually that means no internet connection, or a
        network that blocks api.open-meteo.com. The page itself is fine; press
        <b>↻ Refresh live</b> once you are back online.</div></div>`
    : '';
}

function onDiagUpdate() {
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    clearTimeout(onDiagUpdate._t);
    onDiagUpdate._t = setTimeout(renderDiagnostics, 250);
  }
}

function renderDiagnostics() {
  const t = $('diagTbl'); if (!t) return;
  const rows = DIAG.slice(-60).reverse();
  const pill = s => s === 'ok' ? '<span class="pill ok">✓ ok</span>'
                 : s === 'fail' ? '<span class="pill bad">✕ failed</span>'
                 : '<span class="pill wait">⋯ pending</span>';
  t.innerHTML = rows.length
    ? rows.map(r => `<tr>
        <td>${pill(r.status)}</td>
        <td><b>${esc(r.label)}</b>${r.note ? `<br><span style="color:var(--muted);font-size:.68rem">${esc(r.note)}</span>` : ''}</td>
        <td style="white-space:nowrap;color:var(--muted)">${r.ms != null ? r.ms + ' ms' : ''}</td>
        <td class="u">${esc(r.url.replace(/^https:\/\//, ''))}</td></tr>`).join('')
    : '<tr><td style="color:var(--muted)">No requests recorded yet.</td></tr>';

  const c = curClim(), l = loc();
  const okCount = DIAG.filter(d => d.status === 'ok').length, failCount = DIAG.filter(d => d.status === 'fail').length;
  $('sourceNotes').innerHTML = `
    <div><b>Live conditions, 7-day forecast and hourly detail</b> — Open-Meteo Forecast API, refreshed on every page load.</div>
    <div><b>Monthly normals</b> — Open-Meteo Historical Weather API (ECMWF ERA5 reanalysis), ${PERIODS[S.period].years} years of daily records aggregated in your browser.</div>
    <div><b>Ocean temperature and waves</b> — Open-Meteo Marine API at ${esc(l.marine.label)}${c && c.meta && c.meta.sst && c.meta.sst.years ? ` · ${c.meta.sst.years} years retrieved` : ''}.</div>
    <div><b>Air quality</b> — Open-Meteo Air Quality API (CAMS), US AQI scale.</div>
    <div><b>Sunrise, sunset, solar noon and daylight</b> — computed locally from the NOAA solar equations, then converted to local clock time with your browser's IANA time-zone database, so daylight saving is handled exactly.</div>
    <div style="margin-top:8px;color:var(--muted)">${okCount} request${okCount === 1 ? '' : 's'} succeeded, ${failCount} failed this session.
    Normals are cached in this browser for 30 days${c && c.meta && c.meta.built ? ` · this set built ${relTime(c.meta.built)}` : ''}.</div>`;
}

function renderFooter() {
  const parts = LOCATIONS.map(l => {
    const d = S.live[l.id];
    const c = d && d.wx && d.wx.current;
    return `${l.emoji} ${l.short}: ${c && typeof c.temperature_2m === 'number' ? Math.round(c.temperature_2m) + '°F' : 'unavailable'}`;
  });
  $('footMeta').textContent = `${parts.join('  ·  ')}  ·  page loaded ${new Date().toLocaleString()}`;
}

/* ---------------------------------------------------------------------------
   Small formatters
   ------------------------------------------------------------------------- */
function fmtNum(v, dec) {
  if (v == null || !isFinite(v)) return '—';
  return dec === 0 ? String(Math.round(v))
    : (+v).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function displayValue(r, m) {
  const v = r[m.key];
  if (v == null) return '—';
  if (m.unit === 'time') return fmtMinutes(v);
  if (m.key === 'daylight') return fmtDuration(v * 60);
  return fmtVal(v, m.dec, m.unit);
}

function degToCompass(deg) {
  if (deg == null || !isFinite(deg)) return '—';
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(((deg % 360) / 22.5)) % 16];
}

function fmtClock(iso, tz) {
  if (!iso) return '—';
  /* Open-Meteo returns local-to-the-location times without an offset. */
  const d = new Date(String(iso).length <= 16 ? iso + ':00' : iso);
  if (Number.isNaN(+d)) return String(iso);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function relTime(ms) {
  if (!ms) return '—';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/* "YYYY-MM-DDTHH" for the current moment in the given IANA zone. Open-Meteo's
   hourly timestamps carry no offset, so they can only be compared against a
   string built in the same zone. sv-SE is used because its locale format is
   already ISO-shaped. */
function nowLocalHour(tz) {
  try {
    return new Date().toLocaleString('sv-SE', { timeZone: tz }).slice(0, 13).replace(' ', 'T');
  } catch (_) {
    return new Date().toISOString().slice(0, 13);
  }
}

/* Value at the current hour from an hourly series. */
function pickHourly(hourly, key, tz) {
  const times = hourly && hourly.time, arr = hourly && hourly[key];
  if (!times || !arr) return null;
  const nowISO = nowLocalHour(tz);
  let i = times.findIndex(t => String(t).slice(0, 13) >= nowISO);
  if (i < 0) i = times.length - 1;
  for (let k = i; k >= 0 && k > i - 3; k--) if (typeof arr[k] === 'number') return arr[k];
  return null;
}

function dewLabel(d) {
  if (d == null || !isFinite(d)) return '';
  if (d < 50) return 'Dry and comfortable';
  if (d < 60) return 'Comfortable';
  if (d < 65) return 'Getting sticky';
  if (d < 70) return 'Humid';
  if (d < 75) return 'Very humid';
  return 'Oppressive';
}
function cloudLabel(c) {
  if (c == null) return '';
  if (c < 12) return 'Clear'; if (c < 40) return 'Mostly clear';
  if (c < 70) return 'Partly cloudy'; if (c < 90) return 'Mostly cloudy'; return 'Overcast';
}
function uvLabel(u) {
  if (u == null || !isFinite(u)) return 'Unavailable';
  if (u < 3) return 'Low'; if (u < 6) return 'Moderate';
  if (u < 8) return 'High'; if (u < 11) return 'Very high'; return 'Extreme';
}
function aqiLabel(a) {
  if (a <= 50) return 'Good'; if (a <= 100) return 'Moderate';
  if (a <= 150) return 'Unhealthy for sensitive groups';
  if (a <= 200) return 'Unhealthy'; if (a <= 300) return 'Very unhealthy'; return 'Hazardous';
}
function swimLabel(t) {
  if (t == null || !isFinite(t)) return '';
  if (t < 55) return 'Dangerously cold';
  if (t < 65) return 'Wetsuit weather';
  if (t < 70) return 'Bracing';
  if (t < 78) return 'Comfortable swimming';
  if (t < 85) return 'Warm as a bath';
  return 'Very warm';
}
/* A slim sunrise → now → sunset bar. Position is the day's progress; the label
   under each end is the actual clock time, so the bar never carries meaning alone. */
function sunArc(now, rise, set) {
  if (now == null || rise == null || set == null || set <= rise) return '';
  const pct = Math.max(0, Math.min(100, (now - rise) / (set - rise) * 100));
  const isDaytime = now >= rise && now <= set;
  return `<div style="margin-top:14px">
    <div style="height:6px;border-radius:99px;background:var(--surface3);position:relative;overflow:visible">
      <div style="height:100%;width:${pct.toFixed(1)}%;border-radius:99px;background:linear-gradient(90deg,#eda100,#eb6834)"></div>
      ${isDaytime ? `<div style="position:absolute;left:${pct.toFixed(1)}%;top:50%;transform:translate(-50%,-50%);
        width:13px;height:13px;border-radius:50%;background:#eda100;border:2px solid var(--surface)"
        title="Now"></div>` : ''}
    </div>
    <div style="display:flex;justify-content:space-between;font-size:.68rem;color:var(--muted);margin-top:5px">
      <span>🌅 ${esc(fmtMinutes(rise))}</span>
      <span>${esc(daylightProgress(now, rise, set))}</span>
      <span>${esc(fmtMinutes(set))} 🌇</span>
    </div></div>`;
}

function daylightProgress(now, rise, set) {
  if (now == null || rise == null || set == null) return '';
  if (now < rise) return `Sunrise in ${fmtDuration(rise - now)}`;
  if (now > set)  return `Sunset was ${fmtDuration(now - set)} ago`;
  return `${Math.round((now - rise) / (set - rise) * 100)}% elapsed`;
}
