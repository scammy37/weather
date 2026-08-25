/* =============================================================================
   NOAA GHCN-Daily station observations.

   Why this exists
   ---------------
   ERA5 is a model. For monthly AVERAGES it is close enough — within a degree
   or two. For THRESHOLD counts it is not close at all, because a threshold
   turns a small bias into a large error whenever the threshold sits inside the
   bulk of the distribution. Measured over 2016-2025, days per year at or above
   90°F, with each station's distance from the house:

     Bonita Springs FL   era5  13    Naples 13 mi 123, Fort Myers 18 mi 144
     North Myrtle Beach  era5  24    Grand Strand 2 mi 19
     Rockaway NJ         era5  14    Boonton 6 mi 19, Caldwell 12 mi 30

   Bonita is the case that proves it: the model says 13 and the thermometer
   says 123, a factor of nine, because a 3°F bias moves an average barely and a
   threshold enormously. No other model fixes it — era5_land, era5_ensemble and
   ecmwf_ifs all read colder still.

   Rockaway's row is worth reading carefully, because this file used to claim
   the model was wrong there by half and it was not. The 30 it was compared
   against came from a station 21 miles away and 440 ft lower. Hot days fall
   off steeply with elevation here — Newark at 6 ft counts 35, Caldwell at
   171 ft 30, Boonton at 280 ft 19, and Aeroflex-Andover, the only station at
   this house's own 538 ft, counts 14. At Rockaway the model was about right
   and the station was in the wrong place.

   What is right everywhere is the thermometer, because it is the measurement
   rather than a model of it. So temperature, precipitation and snow come from
   real stations; everything a station has no instrument for (cloud cover,
   sunshine, radiation, humidity, the ocean) stays with the reanalysis, which
   is the right tool for a field rather than a point.

   Which station, per field, per day
   --------------------------------
   Not "the nearest station" — the nearest station THAT MEASURED THIS FIELD ON
   THIS DAY. The three things a house wants measured are not measured in the
   same places:

     - Thermometers are rare. The nearest to Rockaway is 6 miles away.
     - Rain gauges are everywhere. Three sit within 4.4 miles of Rockaway,
       because CoCoRaHS volunteers read a gauge in the garden every morning.
     - Distance matters far more for rain than for temperature, and most of
       all for a house 538 ft up. Over 2016-2025, annual precipitation:

         Rockaway   gauges within 4.4 mi   56-59 in     <- the house
                    Boonton      6.2 mi    52 in
                    Caldwell    12.2 mi    44 in
         Bonita     Naples Park  4.3 mi    61 in        <- the house
                    Naples Muni 12.8 mi    48 in

       Reading Rockaway's rain off an airport 12 miles away understated it by
       a quarter. That was the largest single error on the page, and choosing
       a better single station could not have fixed it: the nearest gauge has
       no thermometer, and the nearest thermometer is six miles from it.

   So each field walks the candidate list independently and takes the first
   station that filed a report that day. Rockaway ends up with its temperature
   from Boonton, 6 miles away, and its rain and snow from a gauge 0.2 miles
   away — which is the honest answer to "what fell on this house".

   The cost is stated on the page: a station is a specific place some distance
   from the house, not the back garden. The page can now say how far, per
   measurement, because the answers differ.
   =========================================================================== */

/* Elements a daily-summaries record can carry, mapped onto the names the
   aggregation already uses. Anything not listed stays with the model. */
export const STATION_FIELDS = {
  TMAX: 'temperature_2m_max',
  TMIN: 'temperature_2m_min',
  PRCP: 'precipitation_sum',
  SNOW: 'snowfall_sum'
};

/* Fields the model supplies that become INVALID once the station's own
   readings are in place, because they are derived from the same quantity by a
   different instrument. Left alone, they read as if nothing had changed:

   * temperature_2m_mean is ERA5's daily mean while the high and low beside it
     are thermometer readings. The two disagreed by up to 1.8°F in opposite
     directions per home, which silently corrupted every degree-day figure —
     Bonita's cooling degree days were out by 11% — and the mean-temperature
     trend chart plotted a model line between two measured ones.
   * rain_sum is the model's rain while precipitation_sum is the station's
     total. Different instruments, so the arithmetic breaks: North Myrtle Beach
     published 52.12 in of rain inside 51.57 in of total precipitation, and
     Bonita a 12.6 in gap in a place where nothing frozen falls.

   Both are recomputed from the observations instead of being carried over. */
const DERIVED_FROM_TEMPERATURE = ['temperature_2m_mean'];

/* Candidates per home, NEAREST FIRST. Every field walks this one list and
   takes the first station that reported it, so the order is the whole policy:
   a nearer station always wins for the days it covers.

   `lat`/`lon` are the station's own coordinates, copied from NOAA's
   authoritative list (ghcnd-stations.txt), and `miles` is the distance from
   them to the home's coordinates in js/config.js. They are here to be
   CHECKED: resolveHomeStations compares them against the coordinates NOAA
   returns with the data and refuses a station that is not where this table
   says it is.

   That check exists because two ids in this table were wrong for months and
   nothing could have noticed. A misplaced station does not look broken — it
   looks perfect. Fort Pierce reported 100% of days for a Bonita Springs 118
   miles away, so a coverage test passed it every single time. Coverage
   measures whether a station is reporting, never whether it is the right
   station. */
export const STATIONS = {
  rockaway: [
    /* Three CoCoRaHS gauges before the first thermometer. Between them they
       cover every one of the 3,653 days of 2016-2025 — the gauge in the next
       street files 3,294 of them and the other two fill the rest — so the rain
       and snow on this page are measured within four miles of the house and
       never fall back to an airport. The three agree closely: 56.3, 55.4 and
       58.9 inches a year, against Caldwell's 44.4. The highlands are wetter
       than the Newark basin, and the old figure simply missed it. */
    { id: 'US1NJMS0006', name: 'Rockaway 0.4 NNW (CoCoRaHS)', miles: 0.2, lat: 40.9018, lon: -74.5189 },
    { id: 'US1NJMS0071', name: 'Denville 1.5 ESE (CoCoRaHS)', miles: 3, lat: 40.8805, lon: -74.4631 },
    { id: 'US1NJMS0023', name: 'Mine Hill 0.4 NE (CoCoRaHS)', miles: 4, lat: 40.8821, lon: -74.5944 },
    /* The nearest thermometer, and a good one: it reported 99.8% of days over
       the decade, so it is not the "co-op that is closed at weekends" this
       file used to warn about — that was checked rather than assumed.

       It replaces Caldwell, 12 miles away, which replaced USW00054785, an id
       labelled "Morristown Municipal, 7 mi" that is really Somerset Airport,
       21 miles south. GHCN-Daily has no Morristown record at all.

       Boonton against Caldwell is worth 11 hot days a year — 19 against 30 —
       and Boonton is the right one for this house: 6 miles instead of 12, and
       280 ft instead of 171 against the house's 538. See the header for the
       full elevation ladder.

       Stated because it is a real weakness: Boonton's summer readings step
       about 1°F cooler from 2021 relative to both Newark and Somerset, which
       is a station change rather than a climate one, and it depresses the
       later years. Its 19 is therefore a little low and the truth for the
       house is probably 19-23 — still far nearer than Caldwell's 30. Andover,
       at the house's exact elevation, cannot be used at all: it reports rain
       on 85% of days and is thinning, 244 days in 2023. */
    { id: 'USC00280907', name: 'Boonton 1 SE, NJ', miles: 6, lat: 40.8917, lon: -74.3964 },
    { id: 'USW00054743', name: 'Caldwell Essex County Airport, NJ', miles: 12, lat: 40.8764, lon: -74.2828 },
    { id: 'USW00014734', name: 'Newark Liberty International, NJ', miles: 24, lat: 40.6828, lon: -74.1692 }
  ],
  nmb: [
    /* The best-served of the three: an airport 2.3 miles away that has not
       missed a day in ten years, so nothing nearer would add anything. It has
       no snow board, so snowfall — about an inch a year — stays with the
       model, which is the honest answer rather than a zero. */
    { id: 'USW00093718', name: 'N. Myrtle Beach Grand Strand Airport, SC', miles: 2, lat: 33.8161, lon: -78.7206 },
    /* GHCN calls this one Myrtle Beach AFB; it is the same field as Myrtle
       Beach International. Its daily record currently starts in 2025, so it
       contributes almost nothing — which costs nothing while Grand Strand
       reports every day. */
    { id: 'USW00013717', name: 'Myrtle Beach International, SC', miles: 17, lat: 33.6833, lon: -78.9333 }
  ],
  bonita: [
    /* A gauge a third of the distance of the nearest thermometer, and it
       matters more here than anywhere: Florida rain is convective and local.
       Naples Park reads 61 inches a year against Naples Muni's 48 over the
       same months, and the rest of the region agrees with the higher figure —
       Page Field 58, Fort Myers RSW 55. The airport's heated tipping bucket
       sits on the coast and undercatches tropical downpours; a volunteer's
       gauge does not. It covers 3,315 of 3,653 days; Naples fills the rest. */
    { id: 'US1FLCR0013', name: 'Naples Park 3.7 ENE (CoCoRaHS)', miles: 4, lat: 26.2798, lon: -81.7583 },
    /* The nearest thermometer. Was USW00012895 — Fort Pierce, on the other
       coast. One transposed digit (12895 for 12897) moved it 118 miles and
       swapped the Gulf rainfall regime for the Atlantic one. */
    { id: 'USW00012897', name: 'Naples Municipal Airport, FL', miles: 13, lat: 26.1550, lon: -81.7753 },
    { id: 'USW00012894', name: 'Fort Myers SW Florida Regional, FL', miles: 14, lat: 26.5381, lon: -81.7567 },
    { id: 'USW00012835', name: 'Fort Myers Page Field, FL', miles: 18, lat: 26.5850, lon: -81.8614 }
  ]
};

/* A field is taken from observations only if the observations actually cover
   it. Below this the series has real holes, and holes deflate every total
   computed from them — a quiet drought, or a winter with less snow than fell.
   Such a field goes back to the model, which is at least complete. */
const MIN_COVERAGE = 0.9;

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

/* On a day a station filed a report, a blank rain or snow figure means none
   fell — GHCN omits the zeros. A blank TEMPERATURE means no reading, which is
   a different thing entirely and has to fall through to the next station. */
const ZERO_WHEN_BLANK = ['precipitation_sum', 'snowfall_sum'];

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
      /* parseFloat rather than unary +, which turns an empty field into 0 — a
         coordinate off West Africa that would reject a good station. */
      const y = parseFloat(r.LATITUDE), x = parseFloat(r.LONGITUDE);
      if (Number.isFinite(y) && Number.isFinite(x)) { lat = y; lon = x; }
    }
    const rec = {};
    for (const [el, key] of Object.entries(STATION_FIELDS)) rec[key] = num(r[el]);
    /* A reading can be wrong as well as absent, and one impossible day is
       enough to publish a wrong annual figure. Snow needs the day to have been
       cold at some point; if it never was, the figure is a keying error rather
       than a measurement. Dropped rather than zeroed, so it reads as "not
       measured" and never as "measured none". */
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

/* Build one observed series per field, each day taken from the nearest station
   that filed a report that day and measures that field.

   Walking the list rather than stopping at the first station is the point: the
   first has a thermometer or a gauge, rarely both, and never a complete
   record. Fetching stops as soon as every field is full, so the usual cost is
   three or four requests rather than the whole list.

   Known limitation, and the reason the default period is the recent decade:
   the CoCoRaHS gauges only start around 2008-2014. Over a 30-year window the
   older years therefore come from the airport or the co-op and the later ones
   from the gauge next door, and those sites do not measure the same rainfall —
   the Rockaway gauge catches a quarter more than Caldwell. The chain still
   fills every day, but a 1991-2020 rainfall normal built this way is a blend
   of two sites rather than one long homogeneous record. The temperature does
   not have this problem: Boonton has reported since 1892. */
export async function resolveHomeStations(homeId, start, end, log = () => {}) {
  const want = Object.values(STATION_FIELDS);
  const expected = Math.round((new Date(end) - new Date(start)) / 86400000) + 1;
  const series = Object.fromEntries(want.map(k => [k, new Map()]));
  const sources = [];

  for (const cand of STATIONS[homeId] || []) {
    if (want.every(k => series[k].size >= expected)) break;   // nothing left to fill
    let s;
    try {
      s = await fetchStationDaily(cand.id, start, end);
    } catch (err) {
      log(`  station ${cand.id} unusable (${err.message})`);
      continue;
    }
    /* Is this id the station the table thinks it is? Asked before anything is
       taken from it, because a station in the wrong place has no coverage
       problem — which is precisely what made the wrong ids invisible. */
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
    for (const b of s.snowRejected || []) {
      log(`  ${cand.id}: discarded an impossible reading — ${b.snow} in of snow on ${b.date}, low ${b.low}°F`);
    }

    const took = {};
    for (const [date, rec] of s.byDate) {
      for (const k of want) {
        if (!s.reports[k] || series[k].has(date)) continue;
        let v = rec[k];
        if (v == null) {
          if (!ZERO_WHEN_BLANK.includes(k)) continue;   // no reading: try the next station
          v = 0;                                        // it reported, so none fell
        }
        series[k].set(date, v);
        took[k] = (took[k] || 0) + 1;
      }
    }
    if (!Object.keys(took).length) {
      log(`  station ${cand.id} — ${cand.name}, nothing left for it to add`);
      continue;
    }
    sources.push({ id: cand.id, name: cand.name, miles: cand.miles,
                   fields: Object.keys(took), days: took });
    log(`  station ${cand.id} — ${cand.name}, ${cand.miles} mi: `
      + Object.entries(took).map(([k, n]) => `${k} ${n}`).join(', '));
  }

  /* A field with real holes deflates every total computed from it, so it goes
     back to the model rather than being published with gaps. */
  const fields = [], thin = [];
  for (const k of want) {
    if (!series[k].size) continue;
    if (series[k].size / expected < MIN_COVERAGE) {
      thin.push(`${k} ${Math.round(series[k].size / expected * 100)}%`);
      series[k] = new Map();
      continue;
    }
    fields.push(k);
  }
  if (thin.length) log(`  left on the model, too few days observed: ${thin.join(', ')}`);
  if (!fields.length) {
    log('  no usable observations — everything stays on the model');
    return null;
  }

  /* The station a one-line disclosure should name: the one the temperature
     came from, which is the figure a reader is most likely to check. */
  const primary = sources.find(s => s.days.temperature_2m_max) || sources[0];
  return {
    homeId, series, sources, fields, expected,
    coverage: (series.temperature_2m_max.size || 0) / expected,
    stationId: primary.id, label: primary.name, miles: primary.miles
  };
}

/* Overwrite the model's temperature, precipitation and snow with what the
   stations recorded, day by day, leaving every other variable untouched.

   Days no station covered become null rather than falling back to the model:
   a series that is observation on most days and model on the rest would carry
   the model's cool bias on exactly the days nobody can see, and the whole
   point here is threshold counts. The aggregation already reports nulls as
   missing rather than as zero. */
export function mergeStationDaily(daily, station) {
  if (!daily || !daily.time || !station || !station.series) {
    return { replaced: 0, missing: 0, fields: [], kept: [] };
  }
  const all = Object.values(STATION_FIELDS).filter(k => Array.isArray(daily[k]));
  const keys = all.filter(k => station.series[k] && station.series[k].size);
  const kept = all.filter(k => !keys.includes(k));

  const tookTemp = keys.includes('temperature_2m_max') && keys.includes('temperature_2m_min');
  const tookPrecip = keys.includes('precipitation_sum');
  const derived = [];

  let replaced = 0, missing = 0;
  daily.time.forEach((t, i) => {
    let holes = 0;
    for (const k of keys) {
      const v = station.series[k].get(t);
      if (v === undefined) { daily[k][i] = null; holes++; }
      else daily[k][i] = v;
    }

    /* The model's daily mean cannot sit between two measured extremes. Nulling
       it makes the aggregation fall through to the midpoint of the readings
       actually on the page, which is what every figure derived from it — the
       degree days, the trend line — should have been using all along. */
    if (tookTemp) {
      for (const k of DERIVED_FROM_TEMPERATURE) {
        if (Array.isArray(daily[k])) daily[k][i] = null;
      }
    }

    /* Rainfall is total precipitation minus whatever fell frozen. GHCN reports
       PRCP as liquid-equivalent and SNOW as depth, so the standard 10:1 ratio
       converts one to the other. Approximate, and far better than pairing the
       station's total with the model's rain: that produced more rain than
       precipitation at two of the three homes. */
    if (tookPrecip && Array.isArray(daily.rain_sum)) {
      const pr = daily.precipitation_sum[i];
      if (pr == null) daily.rain_sum[i] = null;
      else {
        const sn = keys.includes('snowfall_sum') ? daily.snowfall_sum[i] : null;
        daily.rain_sum[i] = Math.max(0, pr - (sn != null ? sn / 10 : 0));
      }
    }
    if (holes) missing++; else replaced++;
  });

  if (tookTemp) derived.push(...DERIVED_FROM_TEMPERATURE.filter(k => Array.isArray(daily[k])));
  if (tookPrecip && Array.isArray(daily.rain_sum)) derived.push('rain_sum');
  return { replaced, missing, fields: keys, kept: kept.filter(k => !derived.includes(k)), derived };
}
