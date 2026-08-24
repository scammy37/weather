/* =============================================================================
   radar.js — the live radar: which dish, and how each square is framed

   Everything the radar needs, in one file that nothing else depends on.

   It lives apart from config.js and api.js for a reason beyond tidiness. The
   freshness guard in scripts/pipeline-version.mjs fingerprints the files that
   can change the published normals, and it fingerprints them whole — config.js
   and api.js are both on that list, and the radar constants and the dish lookup
   used to sit inside them. So every radar change made the guard announce that
   the numbers were stale, when the radar cannot reach a single one of them.

   A guard that cries wolf is a guard people learn to wave through, which would
   have cost far more than it saved. Nothing here feeds the normals, nothing
   here is on the fingerprint, and the guard now only speaks up when something
   that really does feed them has moved.
   =========================================================================== */

/* Every WSR-88D dish within range of a home, and where it physically stands.

   The overview thumbnail crops a dish's image around the house, so which dish
   is used decides whether the house can sit in the middle of the square at all.
   That is not the question /points answers: /points names the dish whose
   coverage area owns a coordinate, which is about who forecasts for you, not
   about what a picture centred on the dish can show. At two of the three homes
   the two answers agree. At Bonita Springs they do not — Miami owns the point,
   but Miami's image puts the house 107 km left of centre and hard against the
   edge, while Tampa's, from all of 5 km further away, puts it 32 km off. So the
   dish is chosen here, from geometry, by pickRadarSite().

   The list is every WSR-88D within 250 km of a home, that being the range past
   which a dish stops usefully covering it. The homes are fixed and dishes do
   not move, so the list is too — and listing the losers as well as the winners
   is what makes the choice a search rather than a hardcoded answer. */
const RADAR_SITES = {
  /* Rockaway NJ */
  KDIX: { lat: 39.94694, lon: -74.41072 },   /* Philadelphia, 106 km */
  KOKX: { lat: 40.86552, lon: -72.86392 },   /* Brookhaven, 139 km */
  KBGM: { lat: 42.19969, lon: -75.98472 },   /* Binghamton, 189 km */
  KENX: { lat: 42.58655, lon: -74.06408 },   /* Albany, 191 km */
  KDOX: { lat: 38.82555, lon: -75.44000 },   /* Dover AFB, 244 km */
  /* North Myrtle Beach SC */
  KLTX: { lat: 33.98916, lon: -78.42916 },   /* Wilmington, 30 km */
  KMHX: { lat: 34.77583, lon: -76.87639 },   /* Morehead City, 197 km */
  KRAX: { lat: 35.66527, lon: -78.49000 },   /* Raleigh/Durham, 206 km */
  KCAE: { lat: 33.94860, lon: -81.11861 },   /* Columbia, 226 km */
  /* Bonita Springs FL */
  KAMX: { lat: 25.61055, lon: -80.41305 },   /* Miami, 159 km */
  KTBW: { lat: 27.70527, lon: -82.40194 },   /* Tampa, 164 km */
  KBYX: { lat: 24.59694, lon: -81.70333 },   /* Key West, 194 km */
  KMLB: { lat: 28.11305, lon: -80.65444 },   /* Melbourne, 226 km */
};

/* Past this a dish no longer usefully covers a home, so it is not a candidate
   however well its image would frame one. */
const RADAR_RANGE_KM = 250;

/* ---------------------------------------------------------------------------
   Live radar.

   NWS RIDGE II serves an animated loop of the last ten sweeps as a plain GIF.
   No key, no tile maths, and the station covering each home comes from the
   NWS point lookup rather than a guess.
   ------------------------------------------------------------------------- */
async function loadRadar(locId) {
  if (S.radar[locId]) return S.radar[locId];
  const l = loc(locId);
  const id = pickRadarSite(l);
  const site = id && RADAR_SITES[id];
  S.radar[locId] = id ? {
    id, lat: site.lat, lon: site.lon,
    /* RIDGE II serves an animated loop of the last ten sweeps as a plain GIF —
       no key, no tile maths, and it works as an <img>. */
    loop:  `https://radar.weather.gov/ridge/standard/${id}_loop.gif`,
    still: `https://radar.weather.gov/ridge/standard/${id}_0.gif`,
    page:  `https://radar.weather.gov/station/${id.toLowerCase()}/standard`
  } : null;
  return S.radar[locId];
}

/* The single-home radar panel. There is no station picker any more: the
   overview gives every home its own thumbnail, so the picker had no caller and
   was dead code the moment that landed. */
function renderRadar(host, locId) {
  const l = loc(locId);
  const p = el('section', 'panel');
  p.id = 'radarPanel';
  p.innerHTML = `<div class="panel-h">
      <h2>📡 Live radar — ${esc(l.name)}</h2>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn js-radar-refresh">↻ Refresh</button>
      </div></div>
    <div class="panel-b">
      <div class="radar-wrap js-radar-wrap">
        <div class="radar-loading">Finding the radar station that covers ${esc(l.short)}…</div>
      </div>
      <div class="note js-radar-note" id="radarNote" style="margin-top:9px;display:block">Loading…</div>
    </div>`;

  /* Queries are scoped to the panel rather than the document: the picker
     rebuilds this panel while it is still detached, and document.getElementById
     would find nothing at that point. */
  const wrap = p.querySelector('.js-radar-wrap');
  const note = p.querySelector('.js-radar-note');

  const paint = st => {
    if (!st) {
      wrap.innerHTML = `<div class="radar-loading">Radar is unavailable for this location right now.</div>`;
      note.textContent = '';
      return;
    }
    /* Cache-buster, so Refresh fetches new sweeps rather than redisplaying
       the browser's copy. */
    const url = `${st.loop}?t=${Date.now()}`;
    wrap.innerHTML = `<a href="${esc(st.page)}" target="_blank" rel="noopener"
        title="Open the full NWS radar for ${esc(st.id)}">
        <img src="${esc(url)}" class="radar-img" loading="lazy"
             alt="National Weather Service radar loop for station ${esc(st.id)}, covering ${esc(l.name)}">
      </a>`;
    note.innerHTML = `Station <b>${esc(st.id)}</b>
      · last ten sweeps · refreshed ${esc(new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))}
      · click the image to open it on weather.gov`;
    wrap.querySelector('img').addEventListener('error', () => {
      wrap.innerHTML = `<div class="radar-loading">The radar image could not be loaded.
        <a href="${esc(st.page)}" target="_blank" rel="noopener">Open it on weather.gov</a> instead.</div>`;
    });
  };

  p.querySelector('.js-radar-refresh').addEventListener('click', e => {
    const b = e.currentTarget;
    b.disabled = true; b.textContent = '↻ Refreshing…';
    paint(S.radar[locId]);
    setTimeout(() => { b.disabled = false; b.textContent = '↻ Refresh'; }, 900);
  });

  host.appendChild(p);
  loadRadar(locId).then(paint);
  return p;
}

/* ---------------------------------------------------------------------------
   Radar thumbnails on the overview.

   One small loop beside each home rather than a single large panel at the
   bottom with a picker. Three homes under three different dishes (KOKX, KLTX,
   KTBW) means the picker was always showing two-thirds of the reader the wrong
   weather; a thumbnail per card shows all three at once, and clicking one
   opens it full size.
   ------------------------------------------------------------------------- */
/* Three radars, one per home, equal size, side by side. They live in their own
   section rather than inside the cards: squeezed into a card the loop had to be
   either a square that pushed the readings into a narrow column, or a band so
   short it showed nothing. At full width all three are the same size and big
   enough to read, and comparing them across the three homes — which is the
   only reason to show three at once — actually works. */
function renderRadarRow(host) {
  const p = el('section', 'panel');
  p.id = 'radarRow';
  p.innerHTML = `
    <div class="panel-h"><h2>📡 Live radar</h2>
      <span class="note">Last ten sweeps at each home · click one to enlarge</span></div>
    <div class="panel-b">
      <div class="rr-grid">${LOCATIONS.map(l => `
        <div class="rr-cell">
          <div class="rr-name">${l.emoji} ${esc(l.short)}, ${l.state}</div>
          <div class="rr-slot js-rr-slot" data-loc="${l.id}"></div>
        </div>`).join('')}</div>
    </div>`;
  host.appendChild(p);
  if (radarResize) radarResize.disconnect();
  radarBoxes = [];
  radarResize = window.ResizeObserver ? new ResizeObserver(() => refitRadarRow()) : null;
  p.querySelectorAll('.js-rr-slot').forEach(slot =>
    mountRadarThumb(slot, loc(slot.dataset.loc)));
  return p;
}

/* ---------------------------------------------------------------------------
   Where a place lands inside a RIDGE image.

   The loop is 600x550 with the dish at its centre, and the map is drawn on a
   fixed linear scale. NWS publishes no world file for these GIFs, so the scale
   was measured off the city labels of two stations fourteen degrees of latitude
   apart — KDIX and KAMX — against twenty known towns: 141 px per degree of
   longitude and 126.2 px per degree of latitude put every one of them within a
   couple of pixels, and the same pair of numbers fits both stations, so the
   scale does not vary with latitude and one constant works for all three homes.
   ------------------------------------------------------------------------- */
/* mapTop/mapBottom bracket the rows that are actually map: the NWS banner
   covers 0-23 and the dBZ scale and timestamp cover 526-549. Both are drawn
   over the map, so a crop that runs into them shows a strip of chrome. */
const RIDGE = { w: 600, h: 550, mapTop: 24, mapBottom: 526, pxLon: 141, pxLat: 126.2 };

/* Pixel position of a home in its station's image, or null when the dish
   coordinates are unknown — in which case the caller leaves the crop centred on
   the dish, which is what it was before. */
function ridgePoint(st, l) {
  if (!st || !Number.isFinite(st.lat) || !Number.isFinite(st.lon)) return null;
  return {
    x: RIDGE.w / 2 + (l.lon - st.lon) * RIDGE.pxLon,
    y: RIDGE.h / 2 - (l.lat - st.lat) * RIDGE.pxLat
  };
}

/* Never wider than this: the loop carries a broad empty margin around the
   sweep, and 1.16 is the zoom that trims it off — what the row used to be fixed
   at. Never tighter than the cap either, which is a guard rather than a limit
   anything reaches: it stops one badly placed home from zooming the row down to
   a postage stamp. */
const RIDGE_ZOOM = { min: 1.16, max: 3 };

/* The row's usual desktop shape, used only to choose stations. That choice has
   to be stable — the id is captioned on the square and the modal links to it —
   so it is settled against a fixed shape rather than against whatever the
   window happens to be right now. A caption that changed as you dragged the
   window would be worse than a slightly tighter crop. */
const RIDGE_NOMINAL_RATIO = 169 / 408;

/* How far a square has to zoom in before the house can sit in its middle.

   Panning alone cannot do it: the crop is a window on a 600x550 image, and once
   the house is closer to an edge than half the window is wide, centring it
   would run off the picture. Zooming shrinks the window until it fits. The two
   axes are asked separately and the tighter one wins, because the window is
   wide and short — it has room to pan a degree north or south and barely a
   quarter of one east or west. */
function radarZoomNeeded(pt, ratio) {
  if (!pt) return RIDGE_ZOOM.min;
  const roomX = Math.min(pt.x, RIDGE.w - pt.x);
  const roomY = Math.min(pt.y - RIDGE.mapTop, RIDGE.mapBottom - pt.y);
  return Math.max(roomX > 0 ? (RIDGE.w / 2) / roomX : Infinity,
                  roomY > 0 ? (RIDGE.w / 2) * ratio / roomY : Infinity);
}

/* What this station would cost the row, as a zoom. Never below the floor, so
   that every station able to centre the house comfortably scores the same and
   the tie falls to distance. */
function radarSiteZoom(site, l) {
  return Math.max(RIDGE_ZOOM.min, radarZoomNeeded(ridgePoint(site, l), RIDGE_NOMINAL_RATIO));
}

/* Rough great-circle distance. Only ever compared against other distances and
   against a range in the hundreds of kilometres, so the flat-earth shortcut is
   several orders of magnitude better than it needs to be. */
function radarDistanceKm(site, l) {
  return Math.hypot((site.lat - l.lat) * 111.19,
                    (site.lon - l.lon) * 111.19 * Math.cos((site.lat + l.lat) / 2 * Math.PI / 180));
}

/* The dish that can centre this house for the least zoom, out of those close
   enough to cover it. Least zoom rather than least distance because the row
   shares one zoom, so the worst-placed home decides how much of the map all
   three get to show — a dish five kilometres nearer is worth nothing if it
   costs the whole row a third of its view. Ties go to the nearer dish, since
   past that the only thing left to prefer is a shorter beam. */
function pickRadarSite(l) {
  let best = null;
  for (const id of Object.keys(RADAR_SITES)) {
    const site = RADAR_SITES[id];
    const km = radarDistanceKm(site, l);
    if (km > RADAR_RANGE_KM) continue;
    const zoom = radarSiteZoom(site, l);
    if (!best || zoom < best.zoom - 0.001 || (zoom < best.zoom + 0.001 && km < best.km))
      best = { id, zoom, km };
  }
  return best && best.id;
}

/* Which point each box is framed on, the row's squares in order, and one
   observer for the lot.

   Both the zoom and the pan are derived from the size of the square — a taller
   square relative to its width needs more zoom to fit the house in, and the pan
   is measured off the image's laid-out width — so neither can be worked out
   until the box has a size, and both stop being right the moment it changes.
   Hence an observer rather than a single measurement at render time. It is
   rebuilt with the row, so it never holds on to squares that have been thrown
   away. */
const RADAR_FRAMES = new WeakMap();
let radarBoxes = [];
let radarResize = null;

/* Zoom and frame the whole row together.

   One zoom for all three squares, not one each. The row exists to be read
   across — three homes, same weather system, at a glance — and that only works
   if a blob the same size means the same thing in every square. So the row
   zooms to whatever its worst-placed home needs and the other two follow, even
   though they would each have been happy wider.

   Today that worst home is Bonita Springs, and it costs the row about a third
   of its reach: the Gulf coast has no dish at its longitude, so the nearest one
   that can frame it at all sits up at Tampa with the house low in the picture.
   Rockaway would have settled for 1.05 and North Myrtle Beach for 1.13. */
function refitRadarRow() {
  const boxes = radarBoxes.filter(b => b.isConnected && b.clientWidth > 0 && RADAR_FRAMES.has(b));
  if (!boxes.length) return;

  let zoom = RIDGE_ZOOM.min;
  for (const b of boxes) {
    zoom = Math.max(zoom, radarZoomNeeded(RADAR_FRAMES.get(b).pt, b.clientHeight / b.clientWidth));
  }
  zoom = Math.min(zoom, RIDGE_ZOOM.max);

  for (const b of boxes) {
    const f = RADAR_FRAMES.get(b);
    f.img.style.width = (zoom * 100).toFixed(2) + '%';
    frameRadarThumb(b, f.img, f.pt);
  }
}

/* Pan the thumbnail so the house sits in the middle of the box.

   `left/top: 50%` puts the image's own top-left corner at the centre of the
   box; translating back by the house's position as a percentage of the image's
   own size then lands exactly that pixel on the centre, whatever size the box
   is — no layout arithmetic in the CSS.

   The pan is clamped to the map area, so neither empty background nor the
   image's own banner can appear. That clamp does bite at Bonita Springs: the
   dish NWS assigns it is a hundred miles east in Miami, which leaves the house
   too near the left edge of its own image to be centred, and the crop shows it
   as far from that edge as the frame allows. The other two centre exactly. */
function frameRadarThumb(box, img, pt) {
  if (!box || !img || !pt) return;
  const scale = img.getBoundingClientRect().width / RIDGE.w;
  if (!(scale > 0)) return;
  const halfW = box.clientWidth  / 2 / scale;
  const halfH = box.clientHeight / 2 / scale;
  const clamp = (v, lo, hi) => lo > hi ? (lo + hi) / 2 : Math.min(Math.max(v, lo), hi);
  const cx = clamp(pt.x, halfW, RIDGE.w - halfW);
  /* Keep the banner and the dBZ strip out of the crop where the box is short
     enough for that to be possible, then guard the image's own edges. */
  const cy = clamp(clamp(pt.y, RIDGE.mapTop + halfH, RIDGE.mapBottom - halfH),
                   halfH, RIDGE.h - halfH);
  img.style.transform = `translate(${-cx / RIDGE.w * 100}%, ${-cy / RIDGE.h * 100}%)`;
}

function mountRadarThumb(slot, l) {
  if (!slot) return;
  slot.innerHTML = `<div class="ov-radar-ph">radar…</div>`;
  loadRadar(l.id).then(st => {
    if (!st) {
      /* Say why the box is empty rather than leaving a grey rectangle. */
      slot.innerHTML = `<div class="ov-radar-ph">no radar</div>`;
      return;
    }
    /* Square, because the loop itself is square with the station at its
       centre — any other aspect ratio throws away range in one direction. */
    slot.innerHTML = `
      <button type="button" class="ov-radar-btn js-radar-open"
              aria-label="Enlarge the ${esc(st.id)} radar loop covering ${esc(l.name)}">
        <img src="${esc(st.loop)}?t=${Date.now()}" class="ov-radar-img" loading="lazy"
             alt="Weather radar loop for station ${esc(st.id)}, covering ${esc(l.name)}">
        <span class="ov-radar-cap">${esc(st.id)}</span>
        <span class="ov-radar-zoom" aria-hidden="true">⤢</span>
      </button>`;

    const img = slot.querySelector('img');
    /* Crop around the house rather than around the dish. */
    const btn = slot.querySelector('.ov-radar-btn');
    RADAR_FRAMES.set(btn, { img, pt: ridgePoint(st, l) });
    radarBoxes.push(btn);
    /* Re-run for the whole row, not just this square: the zoom is shared, so a
       home arriving can widen or tighten the two already on screen. */
    refitRadarRow();
    if (radarResize) radarResize.observe(btn);
    else requestAnimationFrame(refitRadarRow);
    img.addEventListener('error', () => { slot.innerHTML = `<div class="ov-radar-ph">radar<br>offline</div>`; });
    /* The whole card is a button that opens the home. Without this the radar
       would navigate away instead of enlarging. */
    slot.querySelector('.js-radar-open').addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      openRadarViewer(l, st);
    });
  });
}

/* Full-size radar over the page. Escape or the backdrop closes it, and focus
   returns to where it came from. */
function openRadarViewer(l, st) {
  closeRadarViewer();
  const ov = el('div', 'radar-modal');
  ov.id = 'radarModal';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-label', `Radar for ${l.name}`);
  ov.innerHTML = `
    <div class="radar-modal-box" role="document">
      <div class="radar-modal-h">
        <div><b>📡 ${esc(l.name)}, ${l.state}</b>
          <span class="radar-modal-sub">station ${esc(st.id)} · last ten sweeps</span></div>
        <div class="radar-modal-btns">
          <button class="btn js-radar-refresh" type="button">↻ Refresh</button>
          <a class="btn" href="${esc(st.page)}" target="_blank" rel="noopener">Open on weather.gov ↗</a>
          <button class="btn js-radar-close" type="button" aria-label="Close the radar">✕ Close</button>
        </div>
      </div>
      <div class="radar-modal-b js-radar-body">
        <img src="${esc(st.loop)}?t=${Date.now()}" alt="Radar loop for station ${esc(st.id)}, covering ${esc(l.name)}">
      </div>
    </div>`;
  ov.addEventListener('click', e => { if (e.target === ov) closeRadarViewer(); });
  ov.querySelector('.js-radar-close').addEventListener('click', closeRadarViewer);
  ov.querySelector('.js-radar-refresh').addEventListener('click', e => {
    const b = e.currentTarget;
    b.disabled = true; b.textContent = '↻ Refreshing…';
    ov.querySelector('.js-radar-body').innerHTML =
      `<img src="${esc(st.loop)}?t=${Date.now()}" alt="Radar loop for station ${esc(st.id)}, covering ${esc(l.name)}">`;
    setTimeout(() => { b.disabled = false; b.textContent = '↻ Refresh'; }, 900);
  });
  document.body.appendChild(ov);
  document.body.classList.add('modal-open');
  document.addEventListener('keydown', radarEscape);
  ov.querySelector('.js-radar-close').focus();
}

function radarEscape(e) { if (e.key === 'Escape') closeRadarViewer(); }

function closeRadarViewer() {
  const ov = $('radarModal');
  if (ov) ov.remove();
  document.body.classList.remove('modal-open');
  document.removeEventListener('keydown', radarEscape);
}
