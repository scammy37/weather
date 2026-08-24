/* =============================================================================
   NOAA GHCN-Daily station observations.

   Why this exists
   ---------------
   ERA5 is a model. For monthly AVERAGES it is close enough — within a degree
   or two. For THRESHOLD counts it is not close at all, because a threshold
   turns a small bias into a large error whenever the threshold sits inside the
   bulk of the distribution. Measured over 2016–2025 against the station
   records, days per year at or above 90°F:

     Rockaway NJ           era5 14    Caldwell 30, Newark 35
     North Myrtle Beach    era5 24    Grand Strand 19
     Bonita Springs FL     era5 13    Naples 123, Fort Myers 144

   Two of three homes wrong, one of them by a factor of nine. It was only
   noticed at Bonita because Florida fell below New Jersey; Rockaway's 14 looks
   perfectly plausible and is half the real figure.

   Bonita's row read "Naples 80" until 2026-08. It was never Naples: the id in
   the table below was USW00012895, which is Fort Pierce, 118 miles away on the
   Atlantic coast. Naples itself reads 123. The correction makes the case here
   stronger, not weaker, and it is the reason the table now carries each
   station's coordinates to be checked against.

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
   reports five days a week under-counts hot days purely by being closed.

   `lat`/`lon` are the station's own coordinates, copied from NOAA's
   authoritative list (ghcnd-stations.txt), and `miles` is the distance from
   them to the home's coordinates in js/config.js. They are here to be
   CHECKED: firstUsableStation compares them against the coordinates NOAA
   returns with the data and refuses a station that is not where this table
   says it is.

   That check exists because two of these six ids were wrong for months and
   nothing could have noticed. A misplaced station does not look broken — it
   looks perfect. Fort Pierce reported 100% of days for a Bonita Springs that
   is 118 miles away, so MIN_COVERAGE passed it every single time. Coverage
   measures whether a station is reporting, never whether it is the right
   station. */
export const STATIONS = {
  rockaway: [
    /* Was USW00054785, labelled "Morristown Municipal Airport, 7 mi". That id
       is Somerset Airport, 21 miles south; GHCN-Daily has no Morristown record
       at all. Caldwell is the nearest station that clears MIN_COVERAGE on
       every field it carries — 99.6% of days over 2016–2025, against
       Somerset's 99.8% from twice the distance, and the two agree on the
       figure this file exists for (30.2 hot days a year against 30.1) and on
       annual precipitation to within half a tenth of an inch.

       Aeroflex-Andover is nearer at 14 miles and matches the house's elevation
       far better (580 ft against Caldwell's 171), but it reports precipitation
       on 85% of days and is thinning — 244 days in 2023 — so it cannot be the
       primary without manufacturing a drought.

       The one figure that does turn on this choice is nights: Caldwell counts
       94 frost days a year and Somerset 120, from 400 ft below the house.
       Neither is the back garden, which is what the page says. */
    { id: 'USW00054743', name: 'Caldwell Essex County Airport, NJ', miles: 12, lat: 40.8764, lon: -74.2828 },
    { id: 'USW00014734', name: 'Newark Liberty International, NJ',  miles: 24, lat: 40.6828, lon: -74.1692 }
  ],
  nmb: [
    { id: 'USW00093718', name: 'N. Myrtle Beach Grand Strand Airport, SC', miles: 2, lat: 33.8161, lon: -78.7206 },
    /* GHCN calls this one Myrtle Beach AFB; it is the same field as Myrtle
       Beach International. Its daily record currently starts in 2025, so
       MIN_COVERAGE skips it for any longer window — which is the guard doing
       its job, and costs nothing while Grand Strand reports every day. */
    { id: 'USW00013717', name: 'Myrtle Beach International, SC',           miles: 17, lat: 33.6833, lon: -78.9333 }
  ],
  bonita: [
    /* Was USW00012895 — Fort Pierce, on the other coast. One transposed digit
       (12895 for 12897) moved the thermometer 118 miles and swapped the Gulf
       rainfall regime for the Atlantic one. */
    { id: 'USW00012897', name: 'Naples Municipal Airport, FL',    miles: 13, lat: 26.1550, lon: -81.7753 },
    { id: 'USW00012835', name: 'Fort Myers Page Field, FL',       miles: 18, lat: 26.5850, lon: -81.8614 }
  ]
};

const MIN_COVERAGE = 0.9;   // a station with real gaps under-counts everything

/* How far the coordinates NOAA returns may sit from the ones in the table
   before the id is treated as naming a different place. Station coordinates
   are exact and stable, so this is generous: it is here to catch a wrong id,
   not a runway resurfacing. */
const MISPLACED_MI = 2;

/* Snow that cannot have fallen. Naples reports a 9.0-inch snowfall on
   2024-10-15, a day whose low was 71°F and on which no precipitation was
   recorded at all — a keying slip, and the only non-zero snow figure in ten
   years of that station's record. Left in, it publishes an inch of snow a year
   for Bonita Springs. Real snow days at Newark reach a minimum of 36°F, so the
   threshold sits well clear of anything genuine. */
const SNOW_IMPOSSIBLE_ABOVE_F = 40;

/* Great-circle miles. Only used to ask whether a station is where the table
   says it is, so the spherical earth is plenty. */
export function milesBetween(lat1, lon1, lat2, lon2) {
  const R = 3958.7613, rad = d => d * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export async function fetchStationDaily(stationId, start, end) {
  /* includeStationLocation asks NOAA to repeat the station's name and
     coordinates on every row. Without it the response is dates and readings
     only — which is why an id pointing at the wrong state produced data that
     looked flawless. It costs a few bytes a row and buys the one fact worth
     checking: where the numbers were actually measured. */
  const url = 'https://www.ncei.noaa.gov/access/services/data/v1'
    + `?dataset=daily-summaries&stations=${stationId}`
    + `&startDate=${start}&endDate=${end}&format=json&units=standard`
    + '&includeStationName=true&includeStationLocation=1'
    + `&dataTypes=${Object.keys(STATION_FIELDS).join(',')}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'tri-state-weather-dashboard' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error('no rows returned');

  const num = v => { const n = parseFloat(v); return Number.isFinite(n) && n > -900 ? n : null; };
  const byDate = new Map();
  const seen = Object.fromEntries(Object.values(STATION_FIELDS).map(k => [k, 0]));
  let name = stationId, lat = null, lon = null;
  const snowRejected = [];
  for (const r of rows) {
    if (r.NAME) name = r.NAME;
    if (lat == null) {
      /* parseFloat rather than unary +, which turns an empty field into 0 —
         a coordinate off West Africa that would reject a perfectly good
         station. */
      const y = parseFloat(r.LATITUDE), x = parseFloat(r.LONGITUDE);
      if (Number.isFinite(y) && Number.isFinite(x)) { lat = y; lon = x; }
    }
    const rec = {};
    for (const [el, key] of Object.entries(STATION_FIELDS)) rec[key] = num(r[el]);
    /* A reading can be wrong as well as absent, and one impossible day is
       enough to publish a wrong annual figure. Snow needs the day to have been
       cold at some point; if it never was, the figure is a keying error, not a
       measurement. Dropped rather than zeroed, so it reads as "not measured"
       and never as "measured none". */
    if (rec.snowfall_sum > 0 && rec.temperature_2m_min != null
        && rec.temperature_2m_min > SNOW_IMPOSSIBLE_ABOVE_F) {
      snowRejected.push({ date: r.DATE, snow: rec.snowfall_sum, low: rec.temperature_2m_min });
      rec.snowfall_sum = null;
    }
    for (const key of Object.values(STATION_FIELDS)) if (rec[key] != null) seen[key]++;
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
  return { stationId, name, lat, lon, byDate, coverage: withTemp / expected,
           days: byDate.size, seen, reports, snowRejected };
}

/* The first candidate that actually reports, from the place it claims to be.
   A station that has gone quiet, or that turns out to be somewhere else
   entirely, is reported and skipped rather than silently halving the day
   counts or moving the house to another state. */
export async function firstUsableStation(homeId, start, end, log = () => {}) {
  for (const cand of STATIONS[homeId] || []) {
    try {
      const s = await fetchStationDaily(cand.id, start, end);
      /* Is this id the station the table thinks it is? Checked before coverage
         because a station in the wrong place has no coverage problem — that is
         precisely what made the wrong ids invisible. */
      if (cand.lat != null && s.lat != null) {
        const off = milesBetween(cand.lat, cand.lon, s.lat, s.lon);
        if (off > MISPLACED_MI) {
          log(`  station ${cand.id} skipped — NOAA places it ${off.toFixed(1)} mi from where this`
            + ` table says ${cand.name} is; the id names ${s.name}. Fix the id, do not use it.`);
          continue;
        }
      } else if (cand.lat != null) {
        log(`  station ${cand.id} — NOAA returned no coordinates, so its position is unverified`);
      }
      if (s.coverage < MIN_COVERAGE) {
        log(`  station ${cand.id} skipped — only ${Math.round(s.coverage * 100)}% of days reported`);
        continue;
      }
      log(`  station ${cand.id} — ${cand.name}, ${Math.round(s.coverage * 100)}% of days, ${cand.miles} mi from the house`);
      if (s.snowRejected && s.snowRejected.length) {
        for (const b of s.snowRejected) {
          log(`  discarded an impossible reading: ${b.snow} in of snow on ${b.date}, low ${b.low}°F`);
        }
      }
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
