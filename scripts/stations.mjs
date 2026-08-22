/* =============================================================================
   NOAA GHCN-Daily station observations.

   Why this exists
   ---------------
   ERA5 is a model. For monthly AVERAGES it is close enough — within a degree
   or two. For THRESHOLD counts it is not close at all, because a threshold
   turns a small bias into a large error whenever the threshold sits inside the
   bulk of the distribution. Measured over 2016–2025 against the station
   records, days per year at or above 90°F:

     Rockaway NJ           era5 14    Morristown 30, Newark 35
     North Myrtle Beach    era5 24    Grand Strand 19
     Bonita Springs FL     era5 13    Naples 80, Fort Myers 144

   Two of three homes wrong, one of them by a factor of six. It was only
   noticed at Bonita because Florida fell below New Jersey; Rockaway's 14 looks
   perfectly plausible and is half the real figure.

   No other model fixes it — era5_land, era5_ensemble and ecmwf_ifs all read
   COLDER still. Moving the query point inland fixes Bonita (13 → 109) and
   ruins North Myrtle Beach (24 → 3), so it is a coincidence rather than a fix.

   What is right everywhere is the thermometer, because it is the measurement
   rather than a model of it — and it is the same record the published figures
   for these towns are computed from. So temperature, precipitation and snow
   come from the nearest reporting station; everything a station has no
   instrument for (cloud cover, sunshine, radiation, humidity, the ocean) stays
   with the reanalysis, which is the right tool for a field rather than a point.

   The cost is honest and stated on the page: a station is a specific place a
   few miles from the house, not the back garden.
   =========================================================================== */

/* Elements a daily-summaries record can carry, mapped onto the names the
   aggregation already uses. Anything not listed stays with the model. */
export const STATION_FIELDS = {
  TMAX: 'temperature_2m_max',
  TMIN: 'temperature_2m_min',
  PRCP: 'precipitation_sum',
  SNOW: 'snowfall_sum'
};

/* Candidates per home, nearest usable first. Distances are to the house.
   Airport stations report continuously, which matters: a co-op site that
   reports five days a week under-counts hot days purely by being closed. */
export const STATIONS = {
  rockaway: [
    { id: 'USW00054785', name: 'Morristown Municipal Airport, NJ', miles: 7 },
    { id: 'USW00014734', name: 'Newark Liberty International, NJ',  miles: 22 }
  ],
  nmb: [
    { id: 'USW00093718', name: 'N. Myrtle Beach Grand Strand Airport, SC', miles: 3 },
    { id: 'USW00013717', name: 'Myrtle Beach International, SC',           miles: 17 }
  ],
  bonita: [
    { id: 'USW00012895', name: 'Naples Municipal Airport, FL',    miles: 12 },
    { id: 'USW00012835', name: 'Fort Myers Page Field, FL',       miles: 16 }
  ]
};

const MIN_COVERAGE = 0.9;   // a station with real gaps under-counts everything

export async function fetchStationDaily(stationId, start, end) {
  const url = 'https://www.ncei.noaa.gov/access/services/data/v1'
    + `?dataset=daily-summaries&stations=${stationId}`
    + `&startDate=${start}&endDate=${end}&format=json&units=standard`
    + `&dataTypes=${Object.keys(STATION_FIELDS).join(',')}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'tri-state-weather-dashboard' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error('no rows returned');

  const num = v => { const n = parseFloat(v); return Number.isFinite(n) && n > -900 ? n : null; };
  const byDate = new Map();
  const seen = Object.fromEntries(Object.values(STATION_FIELDS).map(k => [k, 0]));
  let name = stationId;
  for (const r of rows) {
    if (r.NAME) name = r.NAME;
    const rec = {};
    for (const [el, key] of Object.entries(STATION_FIELDS)) {
      rec[key] = num(r[el]);
      if (rec[key] != null) seen[key]++;
    }
    byDate.set(r.DATE, rec);
  }
  const expected = Math.round((new Date(end) - new Date(start)) / 86400000) + 1;
  const withTemp = [...byDate.values()].filter(r => r.temperature_2m_max != null).length;
  /* Which fields this station actually instruments. GHCN omits an element
     entirely when the site does not measure it — and, for SNOW, often omits it
     on days when nothing fell rather than writing a zero. Those two cases look
     identical in the payload and must not be treated the same way, so the
     count decides: a station that reported snow on some days measures snow,
     and a blank on another day means none fell. A station that never reported
     it has no gauge, and its blanks mean nothing at all. */
  const REPORTS_AT_ALL = 5;
  const reports = Object.fromEntries(Object.entries(seen).map(([k, n]) => [k, n >= REPORTS_AT_ALL]));
  return { stationId, name, byDate, coverage: withTemp / expected, days: byDate.size, seen, reports };
}

/* The first candidate that actually reports. A station that has gone quiet is
   reported and skipped rather than silently halving the day counts. */
export async function firstUsableStation(homeId, start, end, log = () => {}) {
  for (const cand of STATIONS[homeId] || []) {
    try {
      const s = await fetchStationDaily(cand.id, start, end);
      if (s.coverage < MIN_COVERAGE) {
        log(`  station ${cand.id} skipped — only ${Math.round(s.coverage * 100)}% of days reported`);
        continue;
      }
      log(`  station ${cand.id} — ${cand.name}, ${Math.round(s.coverage * 100)}% of days, ${cand.miles} mi from the house`);
      return { ...s, label: cand.name, miles: cand.miles };
    } catch (err) {
      log(`  station ${cand.id} unusable (${err.message})`);
    }
  }
  return null;
}

/* Overwrite the model's temperature, precipitation and snow with what the
   station recorded, day by day, leaving every other variable untouched.

   Days the station missed become null rather than falling back to the model:
   a series that is observation on most days and model on the rest would carry
   the model's cool bias on exactly the days nobody can see, and the whole
   point here is threshold counts. The aggregation already reports nulls as
   missing rather than as zero. */
export function mergeStationDaily(daily, station) {
  if (!daily || !daily.time || !station) return { replaced: 0, missing: 0, fields: [], kept: [] };
  const all = Object.values(STATION_FIELDS).filter(k => Array.isArray(daily[k]));
  const reports = station.reports || {};
  /* Only take over the fields this station instruments. Replacing a complete
     model series with a station's blanks is not an improvement, it is deletion:
     it published a Rockaway with no snowfall at all, which is the same defect
     ERA5-Land caused for precipitation and it went in the same way, by assuming
     an absent value meant something. */
  const keys = all.filter(k => k.startsWith('temperature') || reports[k]);
  const kept = all.filter(k => !keys.includes(k));

  /* On a day the station reported at all, a blank rain or snow figure means
     none fell — GHCN omits the zeros. That inference is only safe for a field
     the station is known to measure, which `keys` already guarantees. */
  const ZERO_WHEN_BLANK = ['precipitation_sum', 'snowfall_sum'];
  let replaced = 0, missing = 0;
  daily.time.forEach((t, i) => {
    const rec = station.byDate.get(t);
    if (!rec || rec.temperature_2m_max == null) {
      for (const k of keys) daily[k][i] = null;
      missing++;
      return;
    }
    for (const k of keys) {
      daily[k][i] = rec[k] != null ? rec[k] : (ZERO_WHEN_BLANK.includes(k) ? 0 : null);
    }
    replaced++;
  });
  return { replaced, missing, fields: keys, kept };
}
