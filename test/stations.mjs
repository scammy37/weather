/* Station-observation merge. Run: node test/stations.mjs */
import { STATIONS, STATION_FIELDS, mergeStationDaily, firstUsableStation,
         fetchStationDaily } from '../scripts/stations.mjs';
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
}

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

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);
