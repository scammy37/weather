/* =============================================================================
   climate.js — turns raw ERA5 daily series into monthly normals.

   Two kinds of metric, aggregated two different ways:

     Rate metrics  (average high, humidity, sun hours per day)
       averaged over every qualifying day in the period.

     Total metrics (monthly rainfall, snowfall, wet days, degree days)
       summed within each individual year-month, then those yearly totals are
       averaged. Averaging daily values instead would silently answer a
       different question, so the two paths are kept separate.

   A year-month is skipped for the total metrics unless it carries at least
   MIN_DAYS_FOR_MONTH days of data, so a truncated final month can never drag
   a monthly average down.
   =========================================================================== */

const MIN_DAYS_FOR_MONTH = 25;

/* Thresholds, all in the display units requested from the API (°F / inches). */
const TH = {
  wetDay:       0.04,   // the WMO "rain day" convention, in inches
  heavyRainDay: 1.00,
  snowDay:      0.10,
  /* Sky cover in tenths, the convention the published clear/partly/cloudy day
     counts use: 0–3 clear, 4–7 partly cloudy, 8–10 cloudy. */
  clearSky:     30,     // % mean cloud cover
  cloudySky:    80,
  sunnyRatio:   0.70,   // sunshine ÷ daylight — the fallback when cloud cover is absent
  partlyRatio:  0.35,
  hot:          90,
  veryHot:      95,
  freeze:       32,
  hardFreeze:   20,
  beachHighMin: 75, beachHighMax: 95, beachSunRatio: 0.50,
  pleasantHighMin: 65, pleasantHighMax: 85, pleasantLowMin: 45,
  baseHDD: 65, baseCDD: 65, baseGDD: 50
};

/* Wind thresholds. Tropical-storm force is 39 mph, hurricane force 74; the
   Atlantic season runs 1 Jun – 30 Nov. Counting days that reach those gust
   speeds is honest reporting of what the reanalysis actually saw — it is not
   a storm-track record, and the dashboard says so. */
/* Measures that ACCUMULATE over a period rather than averaging over it: a
   month has a total rainfall and a total number of hot days, but an average
   high. Exported so the comparison view derives its "total vs average" choice
   from this list rather than keeping a second copy. The two had already
   drifted — the wind day-counts were summed here and averaged there, so gale
   days read "1.1 avg" beside beach days reading a total. */
const TOTAL_KEYS = ['precipTotal','rainfall','snowfall','precipHours','et0','wetDays',
'heavyRainDays','dryDays','snowDays','sunnyDays','partlyDays','cloudyDays',
'hot90','hot95','freeze32','freeze20','beachDays','pleasantDays',
'breezyDays','strongWindDays','severeWindDays',
'hdd','cdd','gdd'];

const WIND = { breezy: 25, strong: 39, severe: 58, hurricane: 74 };
const ATLANTIC_SEASON = [5, 6, 7, 8, 9, 10];        // Jun–Nov, zero-indexed

const MJ_TO_KWH = 1 / 3.6;
const HPA_TO_INHG = 0.02953;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const mean  = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;

/* Mean of a series, ignoring nulls. */
function meanOf(arr, idxs) {
  let s = 0, n = 0;
  for (const i of idxs) { const v = arr && arr[i]; if (isNum(v)) { s += v; n++; } }
  return n ? s / n : null;
}

/* -----------------------------------------------------------------------------
   aggregateMonthly(daily, sunClim) → 12 rows of monthly normals.
     daily    the merged `daily` object from fetchArchive
     sunClim  output of monthlySunClimatology() for this location
   --------------------------------------------------------------------------- */
function aggregateMonthly(daily, sunClim) {
  const t = (daily && daily.time) || [];
  if (!t.length) return null;

  const g = k => daily[k] || [];
  const tmax = g('temperature_2m_max'),  tmin = g('temperature_2m_min');
  const tmean0 = g('temperature_2m_mean');
  const appMax = g('apparent_temperature_max'), appMin = g('apparent_temperature_min');
  const daylight = g('daylight_duration'), sunshine = g('sunshine_duration');
  const precip = g('precipitation_sum'), rain = g('rain_sum'), snow = g('snowfall_sum');
  const precipHrs = g('precipitation_hours');
  const windMax = g('wind_speed_10m_max'), windGust = g('wind_gusts_10m_max');
  const windMean = g('wind_speed_10m_mean');
  const rad = g('shortwave_radiation_sum'), et0 = g('et0_fao_evapotranspiration');
  const rh = g('relative_humidity_2m_mean'), dew = g('dew_point_2m_mean');
  const cloud = g('cloud_cover_mean'), pres = g('pressure_msl_mean');

  /* ERA5 usually supplies temperature_2m_mean; fall back to the midpoint. */
  const tmean = i => isNum(tmean0[i]) ? tmean0[i]
                   : (isNum(tmax[i]) && isNum(tmin[i]) ? (tmax[i] + tmin[i]) / 2 : null);

  /* --- pass 1: bucket day indices by month and by year-month --------------- */
  const byMonth = Array.from({ length: 12 }, () => []);
  const byYM = new Map();                       // "2019-06" → [indices]
  for (let i = 0; i < t.length; i++) {
    const s = t[i];
    if (typeof s !== 'string' || s.length < 7) continue;
    const y = +s.slice(0, 4), mo = +s.slice(5, 7) - 1;
    if (!(mo >= 0 && mo < 12)) continue;
    byMonth[mo].push(i);
    const key = s.slice(0, 7);
    let arr = byYM.get(key); if (!arr) byYM.set(key, arr = []);
    arr.push(i);
  }

  /* --- pass 2: per-year monthly totals ------------------------------------ */
  const totalsByMonth = Array.from({ length: 12 }, () => []);
  for (const [key, idxs] of byYM) {
    if (idxs.length < MIN_DAYS_FOR_MONTH) continue;
    const mo = +key.slice(5, 7) - 1;
    let precipSum = 0, rainSum = 0, snowSum = 0, hrsSum = 0, et0Sum = 0;
    /* Counted separately from the sums: a month with no snowfall readings at
       all must report "unknown", not "0 inches". Those are different claims,
       and a model that silently drops a variable made exactly that mistake. */
    let nSnow = 0, nHrs = 0, nEt0 = 0;
    let wet = 0, heavy = 0, snowD = 0, sunny = 0, partly = 0, cloudy = 0;
    let hot = 0, veryHot = 0, freeze = 0, hard = 0, beach = 0, pleasant = 0;
    let breezy = 0, strongWind = 0, severeWind = 0;
    let hdd = 0, cdd = 0, gdd = 0;
    let nPrecip = 0, nSun = 0, nTemp = 0, nSunFallback = 0;

    for (const i of idxs) {
      const p = precip[i], r = rain[i], sn = snow[i];
      if (isNum(p)) { precipSum += p; nPrecip++; if (p >= TH.wetDay) wet++; if (p >= TH.heavyRainDay) heavy++; }
      if (isNum(r)) rainSum += r;
      if (isNum(sn)) { snowSum += sn; nSnow++; if (sn >= TH.snowDay) snowD++; }
      if (isNum(precipHrs[i])) { hrsSum += precipHrs[i]; nHrs++; }
      if (isNum(et0[i])) { et0Sum += et0[i]; nEt0++; }

      const dl = daylight[i], ss = sunshine[i];
      let ratio = null;
      if (isNum(dl) && dl > 0 && isNum(ss)) ratio = Math.min(1, ss / dl);

      /* Sky category from CLOUD COVER, not from sunshine duration.

         ERA5's sunshine_duration counts every hour whose direct beam clears a
         threshold, and over these locations it is systematically generous: on
         that definition Bonita Springs came out at 317 sunny days a year with
         14.7 cloudy ones, which is not a climate that exists anywhere.

         Cloud cover is an analysed field rather than a derived threshold, and
         the boundaries below are the ones the published "clear / partly cloudy
         / cloudy days" figures use — sky cover 0–3 tenths clear, 4–7 partly,
         8–10 cloudy. That makes these counts comparable to the numbers a
         reader would check them against, which the old ones were not.

         Sunshine duration is still used for pctSun and for the beach-day test,
         where a ratio of the day's own daylight is the right question. */
      const cc = cloud[i];
      if (isNum(cc)) {
        nSun++;
        if (cc <= TH.clearSky) sunny++;
        else if (cc < TH.cloudySky) partly++;
        else cloudy++;
      } else if (ratio != null) {
        /* No cloud cover for this day — the extended variable set can fail
           independently. Fall back rather than reporting nothing, and record
           that it happened. */
        nSunFallback++;
        nSun++;
        if (ratio >= TH.sunnyRatio) sunny++;
        else if (ratio >= TH.partlyRatio) partly++;
        else cloudy++;
      }

      const g = windGust[i];
      if (isNum(g)) {
        if (g >= WIND.breezy) breezy++;
        if (g >= WIND.strong) strongWind++;
        if (g >= WIND.severe) severeWind++;
      }

      const hi = tmax[i], lo = tmin[i], mn = tmean(i);
      if (isNum(hi)) { if (hi >= TH.hot) hot++; if (hi >= TH.veryHot) veryHot++; }
      if (isNum(lo)) { if (lo <= TH.freeze) freeze++; if (lo <= TH.hardFreeze) hard++; }
      if (isNum(mn)) {
        nTemp++;
        hdd += Math.max(0, TH.baseHDD - mn);
        cdd += Math.max(0, mn - TH.baseCDD);
        gdd += Math.max(0, mn - TH.baseGDD);
      }
      if (isNum(hi) && isNum(p) && hi >= TH.beachHighMin && hi <= TH.beachHighMax
          && p < TH.wetDay && ratio !== null && ratio >= TH.beachSunRatio) beach++;
      if (isNum(hi) && isNum(lo) && isNum(p) && hi >= TH.pleasantHighMin && hi <= TH.pleasantHighMax
          && lo >= TH.pleasantLowMin && p < TH.wetDay) pleasant++;
    }

    const days = idxs.length;
    totalsByMonth[mo].push({
      days,
      precipTotal: nPrecip ? precipSum : null,
      rainfall:    nPrecip ? rainSum   : null,
      snowfall:    nSnow ? snowSum : null,
      precipHours: nHrs  ? hrsSum  : null,
      et0:         nEt0  ? et0Sum  : null,
      wetDays: nPrecip ? wet : null,
      heavyRainDays: nPrecip ? heavy : null,
      /* Days with a reading and no rain — NOT "the month minus the wet days",
         which quietly counted every day the gauge was silent as a dry one. */
      dryDays: nPrecip ? (nPrecip - wet) * days / nPrecip : null,
      snowDays: nSnow ? snowD : null,
      sunnyDays:  nSun ? sunny  * days / nSun : null,   // scale to a full month
      partlyDays: nSun ? partly * days / nSun : null,
      cloudyDays: nSun ? cloudy * days / nSun : null,
      /* How much of the sky classification fell back to sunshine duration
         because cloud cover was unavailable. Zero is the expected case; a
         large share means the counts are on the optimistic definition again
         and should not be compared against published figures. */
      skyFromSunshine: nSun ? nSunFallback / nSun : null,
      hot90: hot, hot95: veryHot, freeze32: freeze, freeze20: hard,
      beachDays: beach, pleasantDays: pleasant,
      breezyDays: breezy, strongWindDays: strongWind, severeWindDays: severeWind,
      hdd: nTemp ? hdd : null, cdd: nTemp ? cdd : null, gdd: nTemp ? gdd : null
    });
  }


  /* --- pass 3: assemble the 12 rows --------------------------------------- */
  const rows = [];
  for (let mo = 0; mo < 12; mo++) {
    const idxs = byMonth[mo];
    const yearRows = totalsByMonth[mo];
    const row = { month: mo, monthName: MONTHS[mo], monthFull: MONTHS_FULL[mo],
                  sampleDays: idxs.length, sampleYears: yearRows.length };

    /* rate metrics */
    row.avgHigh = meanOf(tmax, idxs);
    row.avgLow  = meanOf(tmin, idxs);
    row.avgMean = (() => { const v = []; for (const i of idxs) { const m = tmean(i); if (isNum(m)) v.push(m); } return mean(v); })();
    row.apparentHigh = meanOf(appMax, idxs);
    row.apparentLow  = meanOf(appMin, idxs);
    row.diurnal = (isNum(row.avgHigh) && isNum(row.avgLow)) ? row.avgHigh - row.avgLow : null;

    row.recordHigh = (() => { let m = -Infinity; for (const i of idxs) if (isNum(tmax[i]) && tmax[i] > m) m = tmax[i]; return m === -Infinity ? null : m; })();
    row.recordLow  = (() => { let m =  Infinity; for (const i of idxs) if (isNum(tmin[i]) && tmin[i] < m) m = tmin[i]; return m ===  Infinity ? null : m; })();
    row.recordRain = (() => { let m = -Infinity; for (const i of idxs) if (isNum(precip[i]) && precip[i] > m) m = precip[i]; return m === -Infinity ? null : m; })();
    row.recordSnow = (() => { let m = -Infinity; for (const i of idxs) if (isNum(snow[i]) && snow[i] > m) m = snow[i]; return m === -Infinity ? null : m; })();

    const sh = meanOf(sunshine, idxs);
    row.sunHours = isNum(sh) ? sh / 3600 : null;
    const dlMean = meanOf(daylight, idxs);
    row.pctSun = (isNum(sh) && isNum(dlMean) && dlMean > 0) ? Math.min(100, sh / dlMean * 100) : null;

    const radMean = meanOf(rad, idxs);
    row.solarKwh = isNum(radMean) ? radMean * MJ_TO_KWH : null;

    row.windSpeed = meanOf(windMean, idxs);
    row.windMax   = meanOf(windMax, idxs);
    row.windGust  = meanOf(windGust, idxs);
    row.humidity  = meanOf(rh, idxs);
    row.dewPoint  = meanOf(dew, idxs);
    row.cloudCover = meanOf(cloud, idxs);
    const pMean = meanOf(pres, idxs);
    row.pressure = isNum(pMean) ? pMean * HPA_TO_INHG : null;

    /* total metrics — mean of the yearly monthly totals */
    for (const k of TOTAL_KEYS) {
      const vals = yearRows.map(r => r[k]).filter(isNum);
      row[k] = vals.length ? mean(vals) : null;
    }
    /* Not a total — a share, averaged over the years. It says how much of the
       sky classification had to fall back to sunshine duration because cloud
       cover was missing, which is the difference between a figure comparable
       to published clear-day counts and one that is not. */
    {
      const f = yearRows.map(r => r.skyFromSunshine).filter(isNum);
      row.skyFromSunshine = f.length ? mean(f) : null;
    }
    /* spread, for the "typical range" band on the rainfall chart */
    const pv = yearRows.map(r => r.precipTotal).filter(isNum).sort((a, b) => a - b);
    row.precipP10 = pv.length ? pv[Math.floor(pv.length * 0.1)] : null;
    /* Nearest-rank 90th percentile. floor(n * 0.9) lands on the LAST element
       whenever n is 10 — it returns the maximum, not a percentile, so this read
       identically to wettestMonthOnRecord in all 36 published rows and the
       tooltip printed the same figure twice under two different names. */
    row.precipP90 = pv.length ? pv[Math.min(pv.length - 1, Math.ceil(pv.length * 0.9) - 1)] : null;
    row.wettestMonthOnRecord = pv.length ? pv[pv.length - 1] : null;
    row.driestMonthOnRecord  = pv.length ? pv[0] : null;

    /* sun-and-sky, computed locally rather than fetched */
    if (sunClim && sunClim[mo]) Object.assign(row, {
      sunriseMin:   sunClim[mo].sunriseMin,
      sunsetMin:    sunClim[mo].sunsetMin,
      solarNoonMin: sunClim[mo].solarNoonMin,
      daylight:     sunClim[mo].daylight,
      shortestDay:  sunClim[mo].shortestDay,
      longestDay:   sunClim[mo].longestDay
    });

    rows.push(row);
  }
  return rows;
}

/* -----------------------------------------------------------------------------
   Frost dates and the growing season.

   For each year: the last spring freeze (latest low ≤ 32°F before 1 July) and
   the first fall freeze (earliest one after). The gap between them is the
   growing season. Years with no freeze at all — every year in Bonita Springs —
   are counted separately rather than folded in as zeros, which would invent a
   frost that never happened.
   --------------------------------------------------------------------------- */
function frostStats(daily, threshold = 32) {
  const t = (daily && daily.time) || [], tmin = (daily && daily.temperature_2m_min) || [];
  if (!t.length) return null;

  const years = new Map();      // year → { lastSpring, firstFall, freezeDays }
  for (let i = 0; i < t.length; i++) {
    const s = t[i];
    if (typeof s !== 'string') continue;
    const y = +s.slice(0, 4);
    const doy = dayOfYear(s);
    const v = tmin[i];
    if (!isNum(v)) continue;
    let rec = years.get(y);
    if (!rec) years.set(y, rec = { lastSpring: null, firstFall: null, freezeDays: 0, days: 0 });
    rec.days++;
    if (v <= threshold) {
      rec.freezeDays++;
      if (doy < 183) rec.lastSpring = Math.max(rec.lastSpring ?? 0, doy);
      else if (rec.firstFall === null) rec.firstFall = doy;
    }
  }

  const spring = [], fall = [], season = [];
  let freezeFreeYears = 0, total = 0;
  for (const [, r] of years) {
    if (r.days < 300) continue;                    // ignore truncated years
    total++;
    if (!r.freezeDays) { freezeFreeYears++; continue; }
    if (r.lastSpring != null) spring.push(r.lastSpring);
    if (r.firstFall != null) fall.push(r.firstFall);
    if (r.lastSpring != null && r.firstFall != null) season.push(r.firstFall - r.lastSpring);
  }
  if (!total) return null;

  const avg = a => a.length ? Math.round(mean(a)) : null;
  /* Same nearest-rank correction as precipP90. With ten years floor(9) is the
     last element, so "9 years in 10 are frost-free by now" was really the
     latest freeze ever recorded — a planting date a full year of risk later
     than it claimed. */
  const pct = a => a.length
    ? Math.round(a.slice().sort((x, y2) => x - y2)[Math.min(a.length - 1, Math.ceil(a.length * 0.9) - 1)])
    : null;
  return {
    threshold,
    yearsAnalysed: total,
    freezeFreeYears,
    everFreezes: freezeFreeYears < total,
    lastSpringFreezeDoy: avg(spring),
    firstFallFreezeDoy:  avg(fall),
    growingSeasonDays:   avg(season),
    latestSpringFreezeDoy: pct(spring),
    shortestSeasonDays: season.length ? Math.min(...season) : null,
    longestSeasonDays:  season.length ? Math.max(...season) : null
  };
}

/* Day-of-year (1–366) from an ISO date string. */
function dayOfYear(iso) {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7), d = +iso.slice(8, 10);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000) + 1;
}

/* "April 18" from a day-of-year, using a non-leap reference year. */
function doyToLabel(doy) {
  if (doy == null) return null;
  const d = new Date(Date.UTC(2025, 0, 1) + (doy - 1) * 86400000);
  return `${MONTHS_FULL[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/* -----------------------------------------------------------------------------
   Per-year series — the raw material for the trend charts.

   The monthly normals answer "what is a typical July"; these answer "is July
   changing". Kept deliberately small (one number per year per measure) so the
   committed snapshot stays a few hundred KB.
   --------------------------------------------------------------------------- */
function yearlySeries(daily) {
  const t = (daily && daily.time) || [];
  if (!t.length) return null;
  const g = k => daily[k] || [];
  const tmax = g('temperature_2m_max'), tmin = g('temperature_2m_min');
  const tmean0 = g('temperature_2m_mean'), precip = g('precipitation_sum');
  const snow = g('snowfall_sum'), sunshine = g('sunshine_duration'), daylight = g('daylight_duration');

  const byYear = new Map();
  for (let i = 0; i < t.length; i++) {
    const s = t[i];
    if (typeof s !== 'string') continue;
    const y = +s.slice(0, 4);
    let r = byYear.get(y);
    if (!r) byYear.set(y, r = { year: y, days: 0, tSum: 0, tN: 0, hiSum: 0, hiN: 0,
                                loSum: 0, loN: 0, precip: 0, snow: 0,
                                hot90: 0, freeze32: 0, sunny: 0, sunN: 0 });
    r.days++;
    const mn = isNum(tmean0[i]) ? tmean0[i]
             : (isNum(tmax[i]) && isNum(tmin[i]) ? (tmax[i] + tmin[i]) / 2 : null);
    if (isNum(mn)) { r.tSum += mn; r.tN++; }
    if (isNum(tmax[i])) { r.hiSum += tmax[i]; r.hiN++; if (tmax[i] >= TH.hot) r.hot90++; }
    if (isNum(tmin[i])) { r.loSum += tmin[i]; r.loN++; if (tmin[i] <= TH.freeze) r.freeze32++; }
    if (isNum(precip[i])) r.precip += precip[i];
    if (isNum(snow[i])) r.snow += snow[i];
    if (isNum(daylight[i]) && daylight[i] > 0 && isNum(sunshine[i])) {
      r.sunN++;
      if (sunshine[i] / daylight[i] >= TH.sunnyRatio) r.sunny++;
    }
  }

  return [...byYear.values()]
    .filter(r => r.days >= 300)                    // whole years only
    .sort((a, b) => a.year - b.year)
    .map(r => ({
      year: r.year,
      meanTemp: r.tN ? +(r.tSum / r.tN).toFixed(2) : null,
      meanHigh: r.hiN ? +(r.hiSum / r.hiN).toFixed(2) : null,
      meanLow:  r.loN ? +(r.loSum / r.loN).toFixed(2) : null,
      precip:   +r.precip.toFixed(2),
      snow:     +r.snow.toFixed(2),
      hot90:    r.hot90,
      freeze32: r.freeze32,
      sunnyDays: r.sunN ? Math.round(r.sunny * r.days / r.sunN) : null
    }));
}

/* Least-squares slope of a year series, expressed per decade — the number the
   trend chart actually reports. */
function trendPerDecade(series, key) {
  const pts = (series || []).filter(r => isNum(r[key])).map(r => [r.year, r[key]]);
  if (pts.length < 5) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  let num = 0, den = 0;
  for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  if (!den) return null;
  const slope = num / den;
  /* r², so the chart can say how much of the scatter the line actually explains. */
  let ssTot = 0, ssRes = 0;
  for (const [x, y] of pts) {
    const fit = my + slope * (x - mx);
    ssTot += (y - my) ** 2; ssRes += (y - fit) ** 2;
  }
  return {
    perDecade: +(slope * 10).toFixed(2),
    r2: ssTot ? +(1 - ssRes / ssTot).toFixed(3) : null,
    first: pts[0][0], last: pts[pts.length - 1][0], n
  };
}

/* -----------------------------------------------------------------------------
   Fold the sea-surface temperature day rows into the monthly table.
   --------------------------------------------------------------------------- */
function mergeSST(rows, sstRows) {
  if (!rows || !sstRows || !sstRows.length) return rows;
  const acc = Array.from({ length: 12 }, () => ({ m: [], hi: [], lo: [], w: [] }));
  for (const r of sstRows) {
    if (!r || typeof r.date !== 'string') continue;
    const mo = +r.date.slice(5, 7) - 1;
    if (!(mo >= 0 && mo < 12)) continue;
    if (isNum(r.mean)) acc[mo].m.push(r.mean);
    if (isNum(r.max))  acc[mo].hi.push(r.max);
    if (isNum(r.min))  acc[mo].lo.push(r.min);
    if (isNum(r.wave)) acc[mo].w.push(r.wave);
  }
  rows.forEach((row, mo) => {
    row.sst        = mean(acc[mo].m);
    row.sstMax     = mean(acc[mo].hi);
    row.sstMin     = mean(acc[mo].lo);
    row.waveHeight = mean(acc[mo].w);
    row.sstSample  = acc[mo].m.length;
  });
  return rows;
}

/* -----------------------------------------------------------------------------
   Annual rollup + the headline facts the KPI cards read from.
   --------------------------------------------------------------------------- */
function annualSummary(rows) {
  if (!rows || !rows.length) return null;
  const sum = k => { const v = rows.map(r => r[k]).filter(isNum); return v.length === 12 ? v.reduce((a, b) => a + b, 0) : (v.length ? v.reduce((a, b) => a + b, 0) : null); };
  const avg = k => { const v = rows.map(r => r[k]).filter(isNum); return v.length ? mean(v) : null; };
  const argMax = k => { let best = null; for (const r of rows) if (isNum(r[k]) && (!best || r[k] > best[k])) best = r; return best; };
  const argMin = k => { let best = null; for (const r of rows) if (isNum(r[k]) && (!best || r[k] < best[k])) best = r; return best; };

  return {
    annualPrecip:   sum('precipTotal'),
    annualRain:     sum('rainfall'),
    annualSnow:     sum('snowfall'),
    annualWetDays:  sum('wetDays'),
    annualSunnyDays:sum('sunnyDays'),
    annualCloudyDays:sum('cloudyDays'),
    annualHot90:    sum('hot90'),
    annualHot95:    sum('hot95'),
    annualFreeze:   sum('freeze32'),
    annualBeach:    sum('beachDays'),
    annualPleasant: sum('pleasantDays'),
    annualHDD:      sum('hdd'),
    annualCDD:      sum('cdd'),
    annualGDD:      sum('gdd'),
    annualET0:      sum('et0'),
    meanTemp:       avg('avgMean'),
    meanHigh:       avg('avgHigh'),
    meanLow:        avg('avgLow'),
    meanHumidity:   avg('humidity'),
    meanSunHours:   avg('sunHours'),
    meanSST:        avg('sst'),
    warmest:  argMax('avgHigh'),  coldest:  argMin('avgLow'),
    wettest:  argMax('precipTotal'), driest: argMin('precipTotal'),
    sunniest: argMax('sunnyDays'), cloudiest: argMax('cloudyDays'),
    snowiest: argMax('snowfall'),
    warmestOcean: argMax('sst'),  coldestOcean: argMin('sst'),
    longestDay:  argMax('daylight'), shortestDay: argMin('daylight'),
    bestBeach:   argMax('beachDays'), bestPleasant: argMax('pleasantDays'),
    recordHigh:  argMax('recordHigh'), recordLow: argMin('recordLow'),
    windiest:    argMax('windMax'),
    mostHumid:   argMax('humidity')
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TOTAL_KEYS, aggregateMonthly, mergeSST, annualSummary, frostStats, yearlySeries,
                     trendPerDecade, dayOfYear, doyToLabel, TH, WIND, ATLANTIC_SEASON,
                     MIN_DAYS_FOR_MONTH };
}
