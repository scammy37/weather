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
  openAlert: null,
  radar:     {},
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
  buildSubtitle();
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

  /* How far the published normals sit from a real NOAA thermometer. Small
     file, never blocks the page, re-renders whatever is on screen when it
     lands. */
  loadValidation().then(() => { renderDiagnostics(); renderClimate(); });

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
  all.innerHTML = `<span aria-hidden="true">🏘️</span><span>Tri-State</span>`;
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

/* The header lists the three homes. It was written out by hand and still read
   in the old order after the homes were reordered, which is the whole argument
   for deriving it: a list that repeats LOCATIONS must come FROM LOCATIONS or it
   silently disagrees with every other list on the page. */
function buildSubtitle() {
  const el = $('headerSub');
  if (!el) return;
  el.textContent = 'Live conditions & monthly climate normals — '
    + LOCATIONS.map(l => `${l.name} ${l.state}`).join(' · ');
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
  /* The Data Sources panel names this home's tide gauge, marine point and
     measured accuracy, so it goes stale the moment the home changes. */
  renderDiagnostics();
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
      const [wx, air, marine, alerts, water] = await Promise.all([
        fetchLive(l),
        fetchAir(l).catch(() => null),
        fetchMarineLive(l).catch(() => null),
        fetchAlerts(l).catch(() => null),
        /* A measured water temperature, alongside the model's. */
        fetchWaterTempNOAA(l).catch(() => null)
      ]);
      S.live[l.id] = { wx, air, marine, alerts, water, at: Date.now(), error: null, source: 'Open-Meteo' };
    } catch (err) {
      /* Open-Meteo is down for this home. Fall back to a second provider
         rather than showing nothing: NWS has a real thermometer nearby, and
         alerts and water temperature come from elsewhere entirely. */
      const [alerts, water, nws] = await Promise.all([
        fetchAlerts(l).catch(() => null),
        fetchWaterTempNOAA(l).catch(() => null),
        fetchNWSObservation(l).catch(() => null)
      ]);
      S.live[l.id] = { wx: null, air: null, marine: null, alerts, water, nws, at: Date.now(),
                       error: String(err && err.message || err),
                       source: nws ? 'NWS (fallback)' : null };
    }
    boot(null, 10 + ((i + 1) / LOCATIONS.length) * 45, `${l.name} done`);
  });
  await Promise.all(jobs);
}

/* ---------------------------------------------------------------------------
   Live rendering
   ------------------------------------------------------------------------- */
/* Elevation as the API reports it for these exact coordinates, converted from
   whatever unit it names. Falls back to the surveyed value in config.js. */
function elevationFt(l, d) {
  const raw = d && d.wx && d.wx.elevation;
  const ft = toFeet(raw, unitOf(d && d.wx, 'elevation', 'elevation') || 'm', 'elevation');
  if (ft != null && ft > -500 && ft < 30000) return `${Math.round(ft)} ft`;
  return `${l.elevationFt} ft`;
}

/* Confirms the API answered in the units we asked for. Anything unexpected is
   converted properly AND recorded, so a changed default shows up in the
   diagnostics panel rather than as a quietly wrong number. */
function verifyUnits(wx) {
  if (!wx) return;
  const checks = [
    ['current', 'temperature_2m',   '°F',   'temperature'],
    ['current', 'wind_speed_10m',   'mph',  'wind speed'],
    ['daily',   'temperature_2m_max','°F',  'daily high'],
    ['daily',   'precipitation_sum','inch', 'precipitation'],
    ['daily',   'snowfall_sum',     'inch', 'snowfall'],
    ['hourly',  'temperature_2m',   '°F',   'hourly temperature']
  ];
  for (const [block, key, want, label] of checks) {
    const got = unitOf(wx, block, key);
    if (got == null) continue;
    if (normUnit(got) !== normUnit(want)) {
      const msg = `${label}: API returned ${got}, expected ${want} — converted on read`;
      if (!UNIT_WARNINGS.includes(msg)) UNIT_WARNINGS.push(msg);
    }
  }
}

function renderLive() {
  const l = loc(), d = S.live[l.id];
  if (d && d.wx) verifyUnits(d.wx);
  const host = $('liveHost');
  host.innerHTML = '';

  /* Tab temperature badges stay current for every location, not just the
     selected one — that is the point of having three homes on one page. */
  LOCATIONS.forEach(x => {
    const t = $('tabTemp-' + x.id);
    const c = S.live[x.id] && S.live[x.id].wx && S.live[x.id].wx.current;
    if (t) t.textContent = c && typeof c.temperature_2m === 'number' ? `${Math.round(c.temperature_2m)}°` : '—';
  });

  renderAlerts();
  if (isAll()) { renderOverview(host); return; }

  if (!d || d.error || !d.wx) {
    host.appendChild(el('div', 'banner ' + (d && d.nws ? 'warn' : 'err'),
      `<span class="bico">${d && d.nws ? '🛟' : '⚠️'}</span><div>
       <b>Open-Meteo is unavailable for ${esc(l.name)}.</b>
       ${esc(d && d.error || 'No response from the forecast API.')}
       ${d && d.nws
         ? `<br>Showing the latest National Weather Service observation from
            ${esc(d.nws.stationName || d.nws.station)} instead. The forecast and hourly charts
            need Open-Meteo and are unavailable until it returns.`
         : '<br>The monthly normals below are unaffected. Use <b>↻ Refresh live</b> to try again.'}
       </div>`));
    if (d && d.nws) host.appendChild(nwsFallbackPanel(l, d));
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
    <div class="now-place">📍 ${l.lat.toFixed(3)}°N, ${Math.abs(l.lon).toFixed(3)}°W · ${esc(elevationFt(l, d))} above sea level</div>
    <div class="now-place">🕐 Observed ${esc(fmtClock(cur.time, l.tz))} local · updated ${esc(relTime(d.at))}</div>`;
  grid.appendChild(now);

  /* --- stat tiles --- */
  const stats = el('div');
  const uvNow = pickHourly(hourly, 'uv_index', l.tz);
  const visNow = pickHourly(hourly, 'visibility', l.tz);
  /* Visibility is the one field where a wrong assumption is invisible: metres
     and feet differ by 3.28x and both produce a plausible-looking mileage. The
     unit is read from the payload, and an implausible result is reported as
     such rather than displayed. */
  const visUnit = unitOf(d.wx, 'hourly', 'visibility');
  let visMi = toMiles(visNow, visUnit, 'live visibility');
  let visNote = visUnit ? `Surface · reported in ${visUnit}` : 'Surface';
  if (visMi != null && (visMi < 0 || visMi > 250)) {
    visNote = `implausible (${fmtNum(visNow, 0)} ${esc(String(visUnit))}) — not shown`;
    visMi = null;
  }
  const dewNow = pickHourly(hourly, 'dew_point_2m', l.tz);
  const aqi = d.air && d.air.current ? d.air.current.us_aqi : null;

  const tiles = [
    ['Humidity',      fmtNum(cur.relative_humidity_2m, 0) + '%',            'Relative'],
    ['Dew point',     fmtNum(dewNow, 0) + '°F',                              dewLabel(dewNow)],
    ['Wind',          `${fmtNum(cur.wind_speed_10m, 0)} mph`,               `${degToCompass(cur.wind_direction_10m)} · gusts ${fmtNum(cur.wind_gusts_10m, 0)}`],
    ['Pressure',      fmtNum(toInHg(cur.pressure_msl, unitOf(d.wx, 'current', 'pressure_msl'), 'live pressure'), 2) + ' inHg', 'Sea level'],
    ['Cloud cover',   fmtNum(cur.cloud_cover, 0) + '%',                      cloudLabel(cur.cloud_cover)],
    ['Visibility',    visMi != null ? `${visMi.toFixed(1)} mi` : '—', visNote],
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
  const gauge = d.water;                       /* `w` is the weather code above */
  const oceanTiles = mc ? [
    ['Water temp',  fmtNum(gauge ? gauge.tempF : mc.sea_surface_temperature, 1) + '°F',
      gauge ? `measured at ${gauge.name}` : swimLabel(mc.sea_surface_temperature)],
    ['Wave height', fmtNum(mc.wave_height, 1) + ' ft',            'Significant height'],
    ['Wave period', fmtNum(mc.wave_period, 1) + ' s',             'Between crests'],
    ['Swell from',  degToCompass(mc.wave_direction),              `${fmtNum(mc.wave_direction, 0)}°`]
  ] : (d.water ? [['Water temp', `${fmtNum(d.water.tempF, 1)}°F`, `measured at ${d.water.name}`]] : null);
  /* Where both a gauge and the model are available, show the gap: agreement is
     reassuring and disagreement is worth knowing about. */
  if (mc && gauge && typeof mc.sea_surface_temperature === 'number') {
    const gap = gauge.tempF - mc.sea_surface_temperature;
    oceanTiles.push(['Model vs gauge',
      `${gap >= 0 ? '+' : ''}${gap.toFixed(1)}°F`,
      Math.abs(gap) < 2 ? 'model agrees with the sensor'
        : Math.abs(gap) < 5 ? 'model differs modestly' : 'model and sensor disagree']);
  }

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
  renderRadar(host, l.id);
  renderHourly(host, l, d);
}

/* ---------------------------------------------------------------------------
   Severe weather alerts.

   Rendered above everything else, for every home at once regardless of which
   tab is open — a hurricane watch on the Carolina house is not less urgent
   because you happen to be looking at New Jersey.
   ------------------------------------------------------------------------- */
const SEVERITY_STYLE = {
  Extreme:  { cls: 'err',  icon: '🚨', rank: 0 },
  Severe:   { cls: 'err',  icon: '⚠️', rank: 1 },
  Moderate: { cls: 'warn', icon: '⚠️', rank: 2 },
  Minor:    { cls: 'warn', icon: 'ℹ️', rank: 3 },
  Unknown:  { cls: 'info', icon: 'ℹ️', rank: 4 }
};

function allAlerts() {
  const out = [];
  for (const l of LOCATIONS) {
    const d = S.live[l.id];
    for (const a of (d && d.alerts) || []) out.push({ ...a, loc: l });
  }
  return out.sort((a, b) =>
    (SEVERITY_STYLE[a.severity] || SEVERITY_STYLE.Unknown).rank -
    (SEVERITY_STYLE[b.severity] || SEVERITY_STYLE.Unknown).rank);
}

function renderAlerts() {
  const host = $('alertHost');
  if (!host) return;
  const showing = isAll() ? allAlerts() : allAlerts().filter(a => a.loc.id === S.locId);
  const others = isAll() ? [] : allAlerts().filter(a => a.loc.id !== S.locId);

  if (!showing.length && !others.length) { host.innerHTML = ''; return; }

  const card = a => {
    const st = SEVERITY_STYLE[a.severity] || SEVERITY_STYLE.Unknown;
    const when = a.expires ? `until ${new Date(a.expires).toLocaleString(undefined,
      { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '';
    const open = S.openAlert === a.id;
    return `<div class="banner ${st.cls} alert-card" data-id="${esc(a.id || '')}">
      <span class="bico">${st.icon}</span>
      <div style="flex:1;min-width:0">
        <b>${esc(a.event)} — ${esc(a.loc.short)}, ${a.loc.state}</b>
        <div style="font-size:.78rem">${esc(a.headline || '')}</div>
        <div style="font-size:.72rem;color:var(--muted);margin-top:3px">
          ${esc(a.severity)}${a.urgency ? ' · ' + esc(a.urgency) : ''}${when ? ' · ' + esc(when) : ''}
          ${a.sender ? ' · ' + esc(a.sender) : ''}</div>
        ${open ? `<div class="alert-body">${esc(a.description || '').replace(/\n\n/g, '<br><br>').replace(/\n/g, ' ')}
          ${a.instruction ? `<div style="margin-top:8px"><b>What to do:</b> ${esc(a.instruction).replace(/\n/g, ' ')}</div>` : ''}</div>` : ''}
        <button class="btn alert-toggle" style="margin-top:7px;font-size:.72rem;padding:4px 9px">
          ${open ? '▲ Less' : '▼ Full text'}</button>
      </div></div>`;
  };

  host.innerHTML = showing.map(card).join('')
    + (others.length ? `<div class="banner info"><span class="bico">📍</span><div>
        <b>${others.length} active alert${others.length === 1 ? '' : 's'} at your other home${others.length === 1 ? '' : 's'}</b>
        — ${esc([...new Set(others.map(o => o.loc.short))].join(', '))}.
        <button class="btn" id="btnAllAlerts" style="margin-left:8px;font-size:.72rem;padding:4px 9px">See all</button>
        </div></div>` : '');

  host.querySelectorAll('.alert-card').forEach(el2 => {
    el2.querySelector('.alert-toggle').addEventListener('click', () => {
      S.openAlert = S.openAlert === el2.dataset.id ? null : el2.dataset.id;
      renderAlerts();
    });
  });
  const b = $('btnAllAlerts');
  if (b) b.addEventListener('click', () => selectLocation(ALL));
}

/* ---------------------------------------------------------------------------
   Quick reference — the three homes side by side.

   This replaced a "best week ahead" ranking and a warmest/coolest summary.
   Both were technically correct and practically useless: Bonita Springs is
   warmer and sunnier than New Jersey every single day of the year, so a
   ranking that crowns it carries no information. A plain table of the same
   figures lets you read the differences yourself, which is what comparing
   three homes actually means.
   ------------------------------------------------------------------------- */
function renderQuickReference(host) {
  const rows = LOCATIONS.map(l => {
    const d = S.live[l.id];
    const cur = d && d.wx && d.wx.current;
    const daily = (d && d.wx && d.wx.daily) || {};
    const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: l.tz });
    let ti = (daily.time || []).indexOf(todayISO);
    if (ti < 0) ti = Math.min(2, (daily.time || []).length - 1);
    const sun = sunTimes(new Date(), l.lat, l.lon);
    const mc = d && d.marine && d.marine.current;
    const waterF = d && d.water ? d.water.tempF
      : (mc && typeof mc.sea_surface_temperature === 'number' ? mc.sea_surface_temperature : null);
    return {
      l, cur, d,
      icon: cur ? wmoInfo(cur.weather_code, cur.is_day == null ? 1 : cur.is_day) : null,
      hi: daily.temperature_2m_max?.[ti], lo: daily.temperature_2m_min?.[ti],
      pop: daily.precipitation_probability_max?.[ti],
      rain: daily.precipitation_sum?.[ti],
      waterF,
      sunset: localMinutes(sun.sunset, l.tz),
      alerts: (d && d.alerts) || []
    };
  });

  const p = el('section', 'panel');
  const cell = (v, suffix = '') => v == null || Number.isNaN(v) ? '<span class="qr-na">—</span>' : `${v}${suffix}`;
  p.innerHTML = `
    <div class="panel-h"><h2>📋 Quick reference</h2>
      <span class="note">Right now at all three · click a row for the full dashboard</span></div>
    <div class="panel-b tscroll">
      <table class="qr">
        <thead><tr>
          <th>Home</th><th>Now</th><th>Feels</th><th>Today</th><th>Rain</th>
          <th>Humidity</th><th>Wind</th><th>Water</th><th>Sunset</th><th>Alert</th>
        </tr></thead>
        <tbody>${rows.map(r => `<tr data-l="${r.l.id}">
          <td><span class="qr-dot" style="background:${accentOf(r.l)}"></span>${r.l.emoji} ${esc(r.l.short)}, ${r.l.state}</td>
          <td class="qr-big">${r.cur ? `${r.icon.icon} ${Math.round(r.cur.temperature_2m)}°` : '<span class="qr-na">—</span>'}</td>
          <td>${r.cur ? Math.round(r.cur.apparent_temperature) + '°' : '<span class="qr-na">—</span>'}</td>
          <td>${r.hi != null ? `<b>${Math.round(r.hi)}°</b> / ${Math.round(r.lo)}°` : '<span class="qr-na">—</span>'}</td>
          <td>${cell(r.pop != null ? Math.round(r.pop) : null, '%')}</td>
          <td>${r.cur ? Math.round(r.cur.relative_humidity_2m) + '%' : '<span class="qr-na">—</span>'}</td>
          <td>${r.cur ? `${Math.round(r.cur.wind_speed_10m)} ${degToCompass(r.cur.wind_direction_10m)}` : '<span class="qr-na">—</span>'}</td>
          <td>${r.waterF != null ? Math.round(r.waterF) + '°' : '<span class="qr-na">—</span>'}</td>
          <td>${esc(fmtMinutes(r.sunset))}</td>
          <td>${r.alerts.length
                ? `<span class="qr-alert">${r.alerts.length}</span>`
                : '<span class="qr-na">none</span>'}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`;
  host.appendChild(p);
  p.querySelectorAll('tbody tr').forEach(tr =>
    tr.addEventListener('click', () => selectLocation(tr.dataset.l)));
}

/* ---------------------------------------------------------------------------
   Overview — all three homes at once.

   The default view. Every home's current conditions, today's range, the ocean,
   sun times and a compact week are visible without a click; selecting a home
   is for going deeper, not for the basics.
   ------------------------------------------------------------------------- */
function renderOverview(host) {
  renderQuickReference(host);
  renderRadarRow(host);

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
    const waterF = d.water ? d.water.tempF
      : (mc && typeof mc.sea_surface_temperature === 'number' ? mc.sea_surface_temperature : null);
    if (waterF != null)
      chips.push(['🌊', `${fmtNum(waterF, 0)}°`,
        (d.water ? `measured at ${d.water.name}` : 'marine model')
        + (l.marine.proxy ? ` — ${l.marine.proxyDistanceMi} mi from this home` : '')]);

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
      /* Only when the card itself has focus. The radar button inside it is its
         own control: without this check, Enter on the radar both opened the
         viewer and navigated away from it. */
      if (e.target !== card) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    grid.appendChild(card);
  });
  host.appendChild(grid);
}

/* What can still be shown from the NWS observation alone. */
function nwsFallbackPanel(l, d) {
  const n = d.nws;
  const wrap = el('section', 'panel');
  const tiles = [
    ['Temperature',  n.temperature_2m == null ? '—' : `${Math.round(n.temperature_2m)}°F`, n.description || 'Observed'],
    ['Feels like',   n.apparent_temperature == null ? '—' : `${Math.round(n.apparent_temperature)}°F`, 'Heat index or wind chill'],
    ['Humidity',     n.relative_humidity_2m == null ? '—' : `${n.relative_humidity_2m}%`, 'Relative'],
    ['Dew point',    n.dew_point_2m == null ? '—' : `${Math.round(n.dew_point_2m)}°F`, dewLabel(n.dew_point_2m)],
    ['Wind',         n.wind_speed_10m == null ? '—' : `${Math.round(n.wind_speed_10m)} mph`, degToCompass(n.wind_direction_10m)],
    ['Pressure',     n.pressure_msl == null ? '—' : `${n.pressure_msl.toFixed(2)} inHg`, 'Sea level'],
    ['Visibility',   n.visibility_mi == null ? '—' : `${n.visibility_mi.toFixed(1)} mi`, 'Surface']
  ];
  /* NOAA's tide gauge is a different provider entirely, so it survives an
     Open-Meteo outage. Showing it here rather than dropping it with the rest. */
  if (d.water) tiles.push(['Water temp', `${fmtNum(d.water.tempF, 1)}°F`,
    `measured at ${d.water.name}`]);
  wrap.innerHTML = `<div class="panel-h"><h2>🛟 National Weather Service — ${esc(l.name)}</h2>
      <span class="note">Station ${esc(n.station)}${n.time ? ` · ${esc(new Date(n.time).toLocaleString())}` : ''}</span></div>
    <div class="panel-b"><div class="stat-grid">${tiles.map(([a, b, c2]) =>
      `<div class="stat"><div class="stat-l">${esc(a)}</div><div class="stat-v">${esc(String(b))}</div>
       <div class="stat-s">${esc(String(c2 || ''))}</div></div>`).join('')}</div></div>`;
  return wrap;
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
let VALIDATION = null;        // measured bias against NOAA station normals

/* The accuracy report produced by scripts/validate-climate.mjs.

   Loaded at boot rather than from loadClimate(), because loadClimate() never
   runs on the three-home overview — which is the view the page opens on. Hung
   off the climate load, the Data Sources panel sat on "comparing…" until you
   picked a single home. Its absence hides the disclosure rather than breaking
   anything. */
async function loadValidation() {
  if (VALIDATION !== null) return VALIDATION;
  const entry = diagStart('Accuracy check vs NOAA — data/validation.json', 'data/validation.json');
  try {
    const res = await fetch('data/validation.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (!j || !j.homes) throw new Error('unexpected shape');
    VALIDATION = j;
    diagEnd(entry, 'ok', `${Object.keys(j.homes).length} homes compared against NOAA station normals, ${j.window}`);
  } catch (err) {
    VALIDATION = false;
    diagEnd(entry, 'warn', `${String(err && err.message || err)} — the accuracy disclosure is hidden`);
  }
  return VALIDATION;
}

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
      frost: frostStats(arch.daily),
      years: yearlySeries(arch.daily),
      meta: { period, locId, extended: arch.extended, sst: sstInfo, built: Date.now(),
              model: arch.model, modelNote: arch.modelNote,
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

  box.innerHTML = sourceNote() + accuracyNote() + climateNotes(c) + frostPanel(c);
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

/* How far the reanalysis sits from the nearest NOAA weather station, measured
   over an identical window. Stated plainly because a reader comparing these
   figures against a memory of their own thermometer deserves to know. */
/* Where each figure actually comes from. Temperature, rain and snow are
   station observations; everything a thermometer cannot measure stays with the
   reanalysis. Saying so matters because the station is a real place a few
   miles away, not the back garden. */
function sourceNote() {
  const c = curClim();
  const st = c && c.meta && c.meta.station;
  if (!st) return '';
  const pct = Math.round((st.coverage || 0) * 100);
  /* Which station supplied which measurement. They are usually not the same
     one: thermometers are rare and rain gauges are everywhere, so the rain on
     this page is often measured miles nearer the house than the temperature.
     Naming a single station would misdescribe most of the figures. */
  const src = f => {
    const all = (st.sources || []).filter(x => x.fields && x.fields.includes(f));
    if (!all.length) return null;
    return all.slice().sort((a, b) => (b.days[f] || 0) - (a.days[f] || 0))[0];
  };
  const where = x => `station ${esc(x.id)} — ${esc(x.name)}, ${esc(String(x.miles))} `
    + `mile${x.miles === 1 ? '' : 's'} away`;
  const temp = src('temperature_2m_max');
  const rain = src('precipitation_sum');
  const snow = src('snowfall_sum');
  let lines;
  if (temp && rain) {
    const same = rain.id === temp.id;
    lines = `The thermometer is ${where(temp)}, and it reported on
      ${esc(String(pct))}% of days in this period.
      ${same ? 'Rain and snow come from the same station.'
             : `Rain${snow && snow.id === rain.id ? ' and snow' : ''} come from
                ${where(rain)} — a gauge read by hand every morning, which is why
                it can sit closer to the house than any thermometer.`}`;
  } else {
    /* Older snapshots recorded a single station and no breakdown. */
    lines = `They come from NOAA station ${esc(st.id)} — ${esc(st.name)}, about
      ${esc(String(st.miles))} miles from the house — which reported on
      ${esc(String(pct))}% of days in this period.`;
  }
  return `<div class="banner info"><span class="bico">🌡️</span><div>
    <b>Temperature, rain and snow are measured, not modelled.</b>
    ${lines}
    Cloud cover, sunshine, humidity and the ocean have no thermometer to read,
    so those stay with the ERA5 reanalysis.
    <br><span style="color:var(--muted)">The model is close on monthly averages but
    not on day counts: over this window it put Bonita Springs at 13 days a year
    at or above 90°F against a measured 123, because a 3°F bias moves an average
    barely and a threshold enormously.</span></div></div>`;
}

function accuracyNote() {
  const v = VALIDATION;
  const l = loc();
  const e = v && v.homes && v.homes[l.id];
  const b = e && e.models && e.models.era5 && e.models.era5.vsNoaa;
  if (!b || !b.tmax || !b.tmin) return '';
  const sign = n => (n >= 0 ? '+' : '') + n.toFixed(1);
  const station = e.noaa ? e.noaa.stationId : 'the nearest station';
  return `<div class="banner info"><span class="bico">🎯</span><div>
    <b>How close these figures are to a real thermometer.</b>
    Measured against NOAA station ${esc(station)} over the same ${esc(v.window)} window,
    this reanalysis runs <b>${esc(sign(b.tmax.meanBias))}°F</b> on daily highs and
    <b>${esc(sign(b.tmin.meanBias))}°F</b> on overnight lows.
    ${b.tmin.meanBias > 2 ? `The warm bias in the lows is inherent to a gridded model —
      it averages over an area and smooths away the overnight cooling a thermometer
      in a field records. Treat the low temperatures as a few degrees optimistic.` : ''}
    ${b.prcp ? `Precipitation is ${esc(sign(b.prcp.meanBias))} in per month.` : ''}
    </div></div>`;
}

function climateNotes(c) {
  const bits = [];
  if (c.meta && c.meta.fromSnapshot) bits.push(`<div class="banner info"><span class="bico">⚡</span><div>
    <b>Loaded from the precomputed normals</b>${c.meta.snapshotBuilt
      ? ` built ${esc(new Date(c.meta.snapshotBuilt).toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'}))}`
      : ''} — no historical API requests were needed for this.</div></div>`);
  else if (c.rows) {
    /* Two different situations, and telling them apart matters: the snapshot
       file may be missing entirely, or it may simply not carry this period. */
    const noFile = SNAPSHOT === false;
    bits.push(`<div class="banner warn"><span class="bico">🐢</span><div>
      <b>${noFile
        ? 'The precomputed normals file could not be loaded, so this was built live.'
        : 'This period is not in the precomputed set, so it was built live.'}</b>
      That costs roughly ${PERIODS[S.period].years * 180} weighted Open-Meteo calls against a
      5,000/hour free-tier cap, which is why it was slow. It is cached in this browser for 30 days.
      ${noFile
        ? 'See the Data sources panel below for what failed.'
        : `${esc(PERIODS[DEFAULT_PERIOD].label)} loads instantly.`}</div></div>`);
  }
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

/* Frost dates and growing season — the numbers a garden runs on. */
function frostPanel(c) {
  const f = c.frost;
  if (!f) return '';
  const l = loc();
  if (!f.everFreezes) return `<div class="banner info"><span class="bico">🌱</span><div>
    <b>${esc(l.name)} did not record a single freeze in ${f.yearsAnalysed} years.</b>
    The growing season is the whole year — there is no last-frost date to plan around.</div></div>`;

  const bits = [
    ['Last spring freeze', doyToLabel(f.lastSpringFreezeDoy), 'average of the final 32°F night'],
    ['First fall freeze',  doyToLabel(f.firstFallFreezeDoy),  'average of the first 32°F night'],
    ['Growing season',     `${f.growingSeasonDays} days`,     'between those two dates'],
    ['Plant after',        doyToLabel(f.latestSpringFreezeDoy), '9 years in 10 are frost-free by now'],
    ['Shortest season',    `${f.shortestSeasonDays} days`,    `in ${f.yearsAnalysed} years of record`],
    ['Longest season',     `${f.longestSeasonDays} days`,     `in ${f.yearsAnalysed} years of record`]
  ].filter(b => b[1] != null && !String(b[1]).includes('null'));

  return `<section class="panel"><div class="panel-h">
      <h2>🌱 Frost dates &amp; growing season</h2>
      <span class="note">${esc(l.name)} · ${f.yearsAnalysed} years${f.freezeFreeYears ? ` · ${f.freezeFreeYears} with no freeze at all` : ''}</span>
    </div><div class="panel-b"><div class="stat-grid">${bits.map(([a, b, cc]) =>
      `<div class="stat"><div class="stat-l">${esc(a)}</div><div class="stat-v">${esc(String(b))}</div>
       <div class="stat-s">${esc(cc)}</div></div>`).join('')}</div></div></section>`;
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
    'Days with at least 0.04 in of precipitation — the WMO standard "rain day" threshold.',
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

  /* Wind and storms */
  defs.push(['wind', false, 'Breezy days',
    'Days gusting to 25 mph or more.',
    svg => barChart(svg, { values: vals('breezyDays'), labels: MONTHS, color: isDark() ? '#199e70' : '#1baf7a', unit: 'days', dec: 1, selected: sel, onClick })]);
  defs.push(['wind', false, 'Gale-force days',
    `Days gusting to 39 mph — tropical-storm force. ${l.marine.proxy ? '' : 'The Atlantic hurricane season runs 1 June to 30 November, which is the hump you are looking at.'}`,
    svg => barChart(svg, { values: vals('strongWindDays'), labels: MONTHS, color: isDark() ? '#d95926' : '#eb6834', unit: 'days', dec: 1, selected: sel, onClick })]);
  if (rows.some(r => (r.severeWindDays || 0) > 0.01))
    defs.push(['wind', false, 'Damaging wind days',
      'Days gusting to 58 mph — the severe-thunderstorm threshold. These are rare, so the scale is small by design.',
      svg => barChart(svg, { values: vals('severeWindDays'), labels: MONTHS, color: isDark() ? '#e66767' : '#e34948', unit: 'days', dec: 2, selected: sel, onClick })]);

  /* Year-by-year trends */
  const yrs = c.years || [];
  if (yrs.length >= 5) {
    const years = yrs.map(r => r.year);
    const TRENDS = [
      ['meanTemp',  'Average temperature',   '°F',   1, isDark() ? '#e66767' : '#e34948', 'Mean of every day in the year.'],
      ['meanHigh',  'Average daily high',    '°F',   1, isDark() ? '#d95926' : '#eb6834', 'Mean of the daily maximum.'],
      ['meanLow',   'Average daily low',     '°F',   1, isDark() ? '#3987e5' : '#2a78d6', 'Mean of the daily minimum — often where warming shows first.'],
      ['precip',    'Annual precipitation',  'in',   1, isDark() ? '#3987e5' : '#2a78d6', 'Total for the year.'],
      ['hot90',     'Days at or above 90°F', 'days', 0, isDark() ? '#e66767' : '#e34948', 'Count per year.'],
      ['freeze32',  'Days at or below 32°F', 'days', 0, isDark() ? '#3987e5' : '#2a78d6', 'Count per year.'],
      ['sunnyDays', 'Sunny days',            'days', 0, isDark() ? '#fbbf24' : '#eda100', 'Count per year.']
    ];
    if (yrs.some(r => r.snow > 0.5))
      TRENDS.push(['snow', 'Annual snowfall', 'in', 1, isDark() ? '#c3c2b7' : '#52514e', 'Total for the year.']);

    for (const [key, title, unit, dec, color, desc] of TRENDS) {
      const series = yrs.map(r => r[key]);
      const tr = trendPerDecade(yrs, key);
      defs.push(['trend', false, title,
        `${desc} The line is a least-squares fit; r² says how tightly the years actually follow it. ${yrs.length} years — too short to call a climate trend on its own, but it is what this record shows.`,
        svg => trendChart(svg, { years, values: series, trend: tr, color, unit, dec, label: title })]);
    }
  }

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
                 : s === 'warn' ? '<span class="pill warn">! optional</span>'
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
    <div><b>Monthly normals</b> — Open-Meteo Historical Weather API (ECMWF <b>ERA5</b> reanalysis family),
      ${PERIODS[S.period].years} years of daily records${c && c.meta && c.meta.model ? `, model <code>${esc(c.meta.model)}</code>` : ''}.
      The model is named explicitly rather than left to the API's best-match selection, so the figures
      you see are the same ones the accuracy check below measured. ERA5-Land, the finer ~5.6 mile grid,
      was tried and rejected: it returned no precipitation or snowfall at all for these locations.
      ${c && c.meta && c.meta.modelNote && c.meta.modelNote !== c.meta.model ? `<br><span style="color:var(--muted)">${esc(c.meta.modelNote)}</span>` : ''}</div>
    <div><b>Accuracy check</b> — ${validationLine()}</div>
    <div><b>Severe weather alerts</b> — US National Weather Service (api.weather.gov), active watches and warnings for each home's exact coordinates.</div>
    <div><b>Water temperature</b> — NOAA CO-OPS tide gauge (${esc(l.marine.coopsName || 'n/a')}, station ${esc(l.marine.coopsStation || '—')}),
      a physical sensor. The marine model is shown alongside it as corroboration.</div>
    <div><b>Backup provider</b> — if Open-Meteo is unreachable, current conditions fall back to the nearest
      National Weather Service station observation, so an outage at one provider does not blank the page.</div>
    <div><b>Ocean temperature and waves</b> — Open-Meteo Marine API at ${esc(l.marine.label)}${c && c.meta && c.meta.sst && c.meta.sst.years ? ` · ${c.meta.sst.years} years retrieved` : ''}.</div>
    <div><b>Air quality</b> — Open-Meteo Air Quality API (CAMS), US AQI scale.</div>
    <div><b>Sunrise, sunset, solar noon and daylight</b> — computed locally from the NOAA solar equations, then converted to local clock time with your browser's IANA time-zone database, so daylight saving is handled exactly.</div>
    <div><b>Units</b> — every figure is converted from the unit the API declares in its own response rather than
      an assumed one. ${unitAuditLine()}</div>
    <div style="margin-top:8px;color:var(--muted)">${okCount} request${okCount === 1 ? '' : 's'} succeeded, ${failCount} failed this session.
    Normals are cached in this browser for 30 days${c && c.meta && c.meta.built ? ` · this set built ${relTime(c.meta.built)}` : ''}.</div>`;
}

/* What the accuracy comparison actually found for the home on screen, stated
   as a number rather than a reassurance. */
function validationLine() {
  const v = VALIDATION;
  if (v === null) return 'comparing the normals against NOAA station records…';
  if (!v) return 'not available in this deployment — run <code>scripts/validate-climate.mjs</code> to generate it.';
  const e = v.homes && v.homes[loc().id];
  const b = e && e.models && e.models.era5 && e.models.era5.vsNoaa;
  if (!b) return `NOAA station normals for ${esc(v.window)} are on file, but this home has no comparison.`;
  const sign = n => (n >= 0 ? '+' : '') + n.toFixed(1);
  return `every monthly figure is compared against NOAA station ${esc(e.noaa ? e.noaa.stationId : '—')}
    over an identical ${esc(v.window)} window. Highs run ${esc(sign(b.tmax.meanBias))}°F,
    lows ${esc(sign(b.tmin.meanBias))}°F${b.prcp ? `, precipitation ${esc(sign(b.prcp.meanBias))} in/month` : ''}.`;
}

/* One line summarising what the APIs said their units were, plus anything that
   did not match expectations. */
function unitAuditLine() {
  const d = S.live[loc().id];
  const bits = [];
  if (d && d.wx) {
    for (const [block, key, label] of [
      ['current', 'temperature_2m', 'temperature'],
      ['current', 'wind_speed_10m', 'wind'],
      ['hourly',  'visibility',     'visibility'],
      ['current', 'pressure_msl',   'pressure'],
      ['daily',   'precipitation_sum', 'precipitation']
    ]) {
      const u = unitOf(d.wx, block, key);
      if (u) bits.push(`${label} <code>${esc(u)}</code>`);
    }
  }
  const warn = UNIT_WARNINGS.length
    ? `<br><span style="color:var(--warn)">⚠ ${UNIT_WARNINGS.map(esc).join('; ')}</span>` : '';
  return (bits.length ? `This session: ${bits.join(', ')}.` : '') + warn;
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
