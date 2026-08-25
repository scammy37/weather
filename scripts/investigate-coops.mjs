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

const url = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=watertemp';
const res = await fetch(url, { headers: { 'User-Agent': 'tri-state-weather-dashboard (investigation)' } });
if (!res.ok) { console.error(`HTTP ${res.status}`); process.exit(1); }
const { stations } = await res.json();
console.log(`\n${stations.length} CO-OPS stations report water temperature\n`);

for (const t of TARGETS) {
  const near = stations
    .map(s => ({ id: s.id, name: s.name, state: s.state, lat: s.lat, lon: s.lng,
                 miles: milesBetween(t.lat, t.lon, s.lat, s.lng) }))
    .sort((a, b) => a.miles - b.miles)
    .slice(0, 5);
  console.log(`\x1b[1m${t.name}\x1b[0m  (${t.lat}, ${t.lon})`);
  for (const s of near) {
    /* Does it actually have recent readings? A sensor listed in the metadata
       and a sensor returning numbers are different things. */
    let live = '';
    try {
      const q = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=water_temperature`
        + `&station=${s.id}&date=latest&units=english&time_zone=lst_ldt&format=json&application=tri-state-weather`;
      const r2 = await fetch(q);
      const j2 = await r2.json();
      live = j2 && j2.data && j2.data[0] ? `${j2.data[0].v}°F at ${j2.data[0].t}` : (j2 && j2.error ? `no data (${j2.error.message})` : 'no data');
    } catch (e) { live = `unreachable (${e.message})`; }
    console.log(`  ${String(s.id).padEnd(9)} ${s.miles.toFixed(1).padStart(6)} mi  ${(s.name + ', ' + s.state).padEnd(38)} ${live}`);
  }
  console.log();
}
