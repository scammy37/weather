/* Station-observation merge. Run: node test/stations.mjs */
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { STATIONS, STATION_FIELDS, mergeStationDaily, firstUsableStation,
         fetchStationDaily, milesBetween } from '../scripts/stations.mjs';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { LOCATIONS } = require(path.join(ROOT, 'js/config.js'));
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + n); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + n + (e ? '  → ' + e : '')); } };

console.log('\n\x1b[1mstation list\x1b[0m');
for (const id of ['rockaway', 'nmb', 'bonita']) {
  ok(`${id} has at least two candidates`, (STATIONS[id] || []).length >= 2);
  ok(`${id} candidates are ordered nearest first`,
     STATIONS[id].every((s, i, a) => i === 0 || s.miles >= a[i - 1].miles),
     STATIONS[id].map(s => s.miles).join(', '));
  ok(`${id} every candidate names a distance from the house`,
     STATIONS[id].every(s => Number.isFinite(s.miles) && s.miles > 0 && s.name));
  /* The stated distance has to be the distance to THIS home. Both wrong ids
     carried a plausible mileage belonging to a station somewhere else —
     Bonita's read 12 while its id sat 118 miles away — so the number and the
     coordinates are now checked against each other and against js/config.js. */
  const home = LOCATIONS.find(l => l.id === id);
  ok(`${id} every candidate carries the station's own coordinates`,
     STATIONS[id].every(s => Number.isFinite(s.lat) && Number.isFinite(s.lon)));
  ok(`${id} the stated miles match those coordinates`,
     STATIONS[id].every(s => Math.abs(milesBetween(home.lat, home.lon, s.lat, s.lon) - s.miles) <= 1),
     STATIONS[id].map(s => `${s.id} says ${s.miles}, is `
       + `${milesBetween(home.lat, home.lon, s.lat, s.lon).toFixed(1)}`).join('; '));
}

console.log(`\n\x1b[1mmeasuring the distance between two points\x1b[0m`);
ok('a station on top of the house is no distance away',
   milesBetween(40.9012, -74.5143, 40.9012, -74.5143) < 0.001);
/* Newark to Naples — about the flight distance — so a sign error or a pair of
   swapped arguments cannot pass. */
ok('and a known long distance comes out right',
   Math.abs(milesBetween(40.6828, -74.1692, 26.1550, -81.7753) - 1094) < 5,
   milesBetween(40.6828, -74.1692, 26.1550, -81.7753).toFixed(1));

console.log('\n\x1b[1mmerging observations over the model\x1b[0m');
const mkDaily = n => {
  const d = { time: [], temperature_2m_max: [], temperature_2m_min: [],
              precipitation_sum: [], snowfall_sum: [], cloud_cover_mean: [] };
  for (let i = 0; i < n; i++) {
    d.time.push(new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10));
    d.temperature_2m_max.push(50);   // the model's answer
    d.temperature_2m_min.push(30);
    d.precipitation_sum.push(0.1);
    d.snowfall_sum.push(0);
    d.cloud_cover_mean.push(42);     // no station measures this
  }
  return d;
};
/* `reports` says which fields the station instruments. Default to all of them
   so the existing cases keep meaning what they meant. */
const station = (dates, rec, reports = { temperature_2m_max: true, temperature_2m_min: true,
                                          precipitation_sum: true, snowfall_sum: true }) => ({
  stationId: 'TEST', name: 'Test', coverage: 1, reports,
  byDate: new Map(dates.map(d => [d, { ...rec }]))
});

const d1 = mkDaily(5);
const r1 = mergeStationDaily(d1, station(d1.time, {
  temperature_2m_max: 95, temperature_2m_min: 71, precipitation_sum: 0.5, snowfall_sum: 0 }));
ok('every day with a reading is replaced', r1.replaced === 5, String(r1.replaced));
ok('the observed high wins over the model', d1.temperature_2m_max.every(v => v === 95));
ok('the observed low wins too', d1.temperature_2m_min.every(v => v === 71));
ok('precipitation is replaced', d1.precipitation_sum.every(v => v === 0.5));
/* This is the entire point: a threshold count computed after the merge must
   reflect what was measured, not what was modelled. */
ok('a day the model called 50°F and the station called 95°F now counts as hot',
   d1.temperature_2m_max.filter(v => v >= 90).length === 5);
ok('fields no station measures are left alone',
   d1.cloud_cover_mean.every(v => v === 42));
ok('the merge reports which fields it touched',
   r1.fields.includes('temperature_2m_max') && !r1.fields.includes('cloud_cover_mean'),
   r1.fields.join(', '));

console.log('\n\x1b[1mdays the station missed\x1b[0m');
const d2 = mkDaily(4);
const r2 = mergeStationDaily(d2, station([d2.time[0], d2.time[2]], {
  temperature_2m_max: 95, temperature_2m_min: 71, precipitation_sum: 0.5, snowfall_sum: 0 }));
ok('missing days are counted', r2.missing === 2 && r2.replaced === 2,
   `${r2.replaced} replaced, ${r2.missing} missing`);
/* Falling back to the model on the days the station is quiet would reintroduce
   the model's cool bias on exactly the days nobody can inspect. */
ok('a missed day becomes null, NOT the model value',
   d2.temperature_2m_max[1] === null && d2.temperature_2m_max[3] === null,
   JSON.stringify(d2.temperature_2m_max));
ok('and its precipitation is null too, not a confident zero',
   d2.precipitation_sum[1] === null, String(d2.precipitation_sum[1]));
ok('the days it did report are the observed values',
   d2.temperature_2m_max[0] === 95 && d2.temperature_2m_max[2] === 95);
/* A station record with no temperature is not a usable day even if it
   carries rain, or the day counts drift without anything looking wrong. */
const d3 = mkDaily(2);
mergeStationDaily(d3, station(d3.time, {
  temperature_2m_max: null, temperature_2m_min: null, precipitation_sum: 0.9, snowfall_sum: 0 }));
ok('a record with rain but no temperature is treated as missing',
   d3.temperature_2m_max[0] === null && d3.precipitation_sum[0] === null);

console.log('\n\x1b[1mrefusing a station that is not reporting\x1b[0m');
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () =>
  /* 30 days of records inside a 366-day window: 8% coverage. */
  Array.from({ length: 30 }, (_, i) => ({
    DATE: `2024-01-${String(i + 1).padStart(2, '0')}`, NAME: 'Sparse', TMAX: '70', TMIN: '50', PRCP: '0', SNOW: '0' })) });
const sparse = await firstUsableStation('nmb', '2024-01-01', '2024-12-31', () => {});
ok('a station reporting 8% of days is rejected rather than used', sparse === null,
   sparse ? `accepted ${sparse.stationId}` : '');
globalThis.fetch = realFetch;

console.log('\n\x1b[1ma blank is not the same as a zero, and neither is the same as no gauge\x1b[0m');
/* This shipped. GHCN omits SNOW on days nothing fell, so replacing the model's
   complete snowfall series with the station's blanks published a Rockaway and a
   Myrtle Beach with NO snowfall at all — the identical defect ERA5-Land caused
   for precipitation, arrived at the identical way: by assuming an absent value
   meant something. */
const d4 = mkDaily(3);
mergeStationDaily(d4, station(d4.time, {
  temperature_2m_max: 34, temperature_2m_min: 20, precipitation_sum: null, snowfall_sum: null }));
ok('a day the station reported, with no snow figure, counts as no snow',
   d4.snowfall_sum.every(v => v === 0), JSON.stringify(d4.snowfall_sum));
ok('and no rain figure on a reported day counts as dry',
   d4.precipitation_sum.every(v => v === 0), JSON.stringify(d4.precipitation_sum));
ok('but the temperature is still the observed one', d4.temperature_2m_max.every(v => v === 34));

/* A site with no snow gauge is a different case entirely: its blanks mean
   nothing at all, so the model's series has to survive untouched. */
const d5 = mkDaily(3);
const r5 = mergeStationDaily(d5, station(d5.time, {
  temperature_2m_max: 88, temperature_2m_min: 70, precipitation_sum: 0.2, snowfall_sum: null },
  { temperature_2m_max: true, temperature_2m_min: true, precipitation_sum: true, snowfall_sum: false }));
ok('a station with no snow gauge leaves the model snowfall alone',
   d5.snowfall_sum.every(v => v === 0.0) && d5.snowfall_sum.every(v => v !== null),
   JSON.stringify(d5.snowfall_sum));
ok('and that field is reported as left on the model',
   r5.kept.includes('snowfall_sum') && !r5.fields.includes('snowfall_sum'),
   `fields=${r5.fields.join(',')} kept=${r5.kept.join(',')}`);
ok('the fields it does measure are still taken over',
   r5.fields.includes('precipitation_sum') && d5.precipitation_sum.every(v => v === 0.2));

/* Days the station missed are still missing, not zero — otherwise a quiet
   station manufactures a drought. */
const d6 = mkDaily(4);
mergeStationDaily(d6, station([d6.time[0]], {
  temperature_2m_max: 34, temperature_2m_min: 20, precipitation_sum: null, snowfall_sum: null }));
ok('a day with NO station record stays null rather than becoming zero',
   d6.snowfall_sum[1] === null && d6.precipitation_sum[1] === null,
   JSON.stringify([d6.snowfall_sum[1], d6.precipitation_sum[1]]));
ok('while the reported day reads zero', d6.snowfall_sum[0] === 0);

/* And the counting that decides "has a gauge" must not be fooled by one
   stray reading. */
console.log('\n\x1b[1mdeciding whether a station has a gauge at all\x1b[0m');
{
  const rows = Array.from({ length: 200 }, (_, i) => ({
    DATE: new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10),
    NAME: 'G', TMAX: '70', TMIN: '50', PRCP: '0.1',
    SNOW: i === 0 ? '2.0' : ''            // exactly one snow reading
  }));
  const realFetch2 = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => rows });
  const st = await fetchStationDaily('X', '2024-01-01', '2024-07-18');
  globalThis.fetch = realFetch2;
  ok('one lone snow reading does not count as a snow gauge',
     st.reports.snowfall_sum === false, `seen ${st.seen.snowfall_sum}`);
  ok('a field reported every day does count',
     st.reports.precipitation_sum === true, `seen ${st.seen.precipitation_sum}`);
}

/* The defect the placement guard exists for: an id that is not the station
   the table names. No amount of looking at the data can catch it, because the
   wrong station's data is perfectly good data — from the wrong place. */
console.log(`\n\x1b[1mrefusing a station that is not where the table says\x1b[0m`);
{
  const rows = (lat, lon, name) => Array.from({ length: 366 }, (_, i) => ({
    DATE: new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10),
    NAME: name, LATITUDE: String(lat), LONGITUDE: String(lon),
    TMAX: '70', TMIN: '50', PRCP: '0.1', SNOW: '0' }));
  const realFetch = globalThis.fetch;
  const lines = [];

  /* Every candidate answers from Fort Pierce: flawless coverage, wrong place.
     Nothing must come back rather than something plausible. */
  globalThis.fetch = async () => ({ ok: true, status: 200,
    json: async () => rows(27.4981, -80.3764, 'FT PIERCE ST LUCIE CO INTL AP, FL US') });
  const misplaced = await firstUsableStation('bonita', '2024-01-01', '2024-12-31', m => lines.push(m));
  ok('a station 118 miles from where the table says it is gets rejected',
     misplaced === null, misplaced ? `accepted ${misplaced.stationId}` : '');
  ok('and the log blames the id rather than the coverage',
     lines.some(l => /mi from where this/.test(l) && /Fix the id/.test(l)),
     lines.join(' | ').slice(0, 200));

  /* The same station answering from where it should be must still work, or
     the guard is just an outage. */
  globalThis.fetch = async () => ({ ok: true, status: 200,
    json: async () => rows(26.1550, -81.7753, 'NAPLES MUNICIPAL AIRPORT, FL US') });
  const right = await firstUsableStation('bonita', '2024-01-01', '2024-12-31', () => {});
  ok('while the station at the coordinates in the table is accepted',
     right !== null && right.stationId === STATIONS.bonita[0].id,
     right ? right.stationId : 'rejected');

  /* A payload with no coordinates is the shape NOAA returned before this
     asked for them. It must not take the build down. */
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () =>
    rows(0, 0, 'X').map(r => { const { LATITUDE, LONGITUDE, ...rest } = r; return rest; }) });
  const unverified = await firstUsableStation('bonita', '2024-01-01', '2024-12-31', () => {});
  ok('a response without coordinates is used rather than refused',
     unverified !== null, 'rejected a station NOAA gave no position for');
  globalThis.fetch = realFetch;
}

console.log(`\n\x1b[1mdiscarding a reading that cannot have happened\x1b[0m`);
{
  /* Naples, 2024-10-15: 9.0 inches of snow, low 71 degrees, no precipitation.
     One keying slip in ten years, and enough to publish an inch of snow a year
     for a town in the subtropics. */
  const day = (d, snow, tmin) => ({ DATE: d, NAME: 'N', TMAX: '86', TMIN: String(tmin),
                                    PRCP: '0.00', SNOW: snow });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => [
    day('2024-10-15', '9.0', 71),        // impossible
    day('2024-01-07', '4.0', 28),        // a real snowfall
    day('2024-03-10', '0.2', 36),        // real, and marginal
    day('2024-10-16', '0', 70)
  ] });
  const st = await fetchStationDaily('X', '2024-10-15', '2024-10-18');
  globalThis.fetch = realFetch;
  ok('snow reported on a day whose low was 71F is discarded',
     st.byDate.get('2024-10-15').snowfall_sum === null,
     String(st.byDate.get('2024-10-15').snowfall_sum));
  ok('and it is discarded, not zeroed — a keying error is not a measurement',
     st.snowRejected.length === 1 && st.snowRejected[0].date === '2024-10-15',
     JSON.stringify(st.snowRejected));
  ok('a genuine cold-day snowfall is kept', st.byDate.get('2024-01-07').snowfall_sum === 4);
  ok('and so is a marginal one at 36F, which really happens',
     st.byDate.get('2024-03-10').snowfall_sum === 0.2);
  ok('the discarded day does not count towards having a snow gauge',
     st.seen.snowfall_sum === 3, String(st.seen.snowfall_sum));
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);
