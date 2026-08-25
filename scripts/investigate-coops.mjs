/* Which NOAA CO-OPS station actually measures water temperature nearest a
   point — asked of NOAA rather than recalled.

   The last set of station ids in this project were wrong, and were wrong
   because they were written from memory. This one asks the metadata API which
   stations carry a water-temperature sensor, computes the distance to each,
   and reports the nearest few. Run in CI; this sandbox has no network.

   Run: node scripts/investigate-coops.mjs
   =========================================================================== */
const TARGETS = [
  { id: 'rockaway-ocean', name: 'Point Pleasant Beach, NJ', lat: 40.0918, lon: -74.0479 },
  { id: 'nmb-ocean',      name: 'North Myrtle Beach, SC',   lat: 33.8160, lon: -78.6800 },
  { id: 'bonita-ocean',   name: 'Bonita Beach, FL',         lat: 26.3400, lon: -81.8500 }
];

const R = 3958.7613;
const rad = d => d * Math.PI / 180;
function milesBetween(aLat, aLon, bLat, bLon) {
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2
          + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* --- source 1: NOAA CO-OPS tide gauges ---------------------------------- */
async function coops() {
  const url = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=watertemp';
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { stations } = await res.json();
  return stations.map(s => ({ src: 'CO-OPS', id: String(s.id), name: `${s.name}, ${s.state}`,
                              lat: s.lat, lon: s.lng }));
}

/* --- source 2: NDBC buoys and coastal stations --------------------------- */
/* latest_obs.txt is every station reporting right now, one row each, with the
   water temperature already in it. A buoy sitting in the ocean off the beach
   is a better answer than a tide gauge inside a bay 26 miles away. */
async function ndbc() {
  const res = await fetch('https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt',
                          { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const lines = (await res.text()).split('\n');
  const head = lines[0].trim().replace(/^#/, '').split(/\s+/);
  const iLat = head.indexOf('LAT'), iLon = head.indexOf('LON'), iW = head.indexOf('WTMP');
  const out = [];
  for (const line of lines.slice(2)) {
    const f = line.trim().split(/\s+/);
    if (f.length < head.length) continue;
    const wt = parseFloat(f[iW]);
    if (!Number.isFinite(wt)) continue;              // only stations actually reporting
    out.push({ src: 'NDBC', id: f[0], name: `buoy ${f[0]}`,
               lat: parseFloat(f[iLat]), lon: parseFloat(f[iLon]),
               reading: `${(wt * 9 / 5 + 32).toFixed(1)}°F` });
  }
  return out;
}

/* --- source 3: USGS gauges ---------------------------------------------- */
/* Parameter 00010 is water temperature. USGS runs tidal and inlet gauges that
   NOAA does not, including on the Manasquan River at Point Pleasant Beach. */
async function usgs(lat, lon, deg = 0.75) {
  const bbox = [(lon - deg).toFixed(4), (lat - deg).toFixed(4),
                (lon + deg).toFixed(4), (lat + deg).toFixed(4)].join(',');
  const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&bBox=${bbox}`
            + '&parameterCd=00010&siteStatus=active';
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const seen = new Map();
  for (const ts of (j.value && j.value.timeSeries) || []) {
    const si = ts.sourceInfo;
    const v = ts.values?.[0]?.value?.[0];
    if (!v || !Number.isFinite(parseFloat(v.value)) || parseFloat(v.value) < -50) continue;
    const id = si.siteCode[0].value;
    if (seen.has(id)) continue;
    seen.set(id, { src: 'USGS', id, name: si.siteName,
                   lat: +si.geoLocation.geogLocation.latitude,
                   lon: +si.geoLocation.geogLocation.longitude,
                   reading: `${(parseFloat(v.value) * 9 / 5 + 32).toFixed(1)}°F at ${v.dateTime}` });
  }
  return [...seen.values()];
}

const UA = 'tri-state-weather-dashboard (investigation)';

for (const t of TARGETS) {
  console.log(`\n\x1b[1m${t.name}\x1b[0m  (${t.lat}, ${t.lon})`);
  let all = [];
  for (const [label, fn] of [['CO-OPS', coops], ['NDBC', ndbc], ['USGS', () => usgs(t.lat, t.lon)]]) {
    try { all = all.concat(await fn()); }
    catch (e) { console.log(`  ${label} unavailable (${e.message})`); }
  }
  const near = all
    .filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lon))
    .map(s => ({ ...s, miles: milesBetween(t.lat, t.lon, s.lat, s.lon) }))
    .sort((a, b) => a.miles - b.miles)
    .slice(0, 8);

  for (const s of near) {
    let live = s.reading || '';
    if (!live && s.src === 'CO-OPS') {
      try {
        const q = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=water_temperature'
          + `&station=${s.id}&date=latest&units=english&time_zone=lst_ldt&format=json&application=tri-state-weather`;
        const j2 = await (await fetch(q)).json();
        live = j2?.data?.[0] ? `${j2.data[0].v}°F at ${j2.data[0].t}` : 'no data';
      } catch (e) { live = `unreachable (${e.message})`; }
    }
    console.log(`  ${s.src.padEnd(7)} ${String(s.id).padEnd(11)} ${s.miles.toFixed(1).padStart(6)} mi  `
      + `${s.name.slice(0, 44).padEnd(46)} ${live}`);
  }
}
console.log();
