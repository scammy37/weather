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
  wetDay:       0.04,   // 1 mm — the WMO "rain day" convention
  heavyRainDay: 1.00,
  snowDay:      0.10,
  sunnyRatio:   0.70,   // sunshine ÷ daylight
  partlyRatio:  0.35,
  hot:          90,
  veryHot:      95,
  freeze:       32,
  hardFreeze:   20,
  beachHighMin: 75, beachHighMax: 95, beachSunRatio: 0.50,
  pleasantHighMin: 65, pleasantHighMax: 85, pleasantLowMin: 45,
  baseHDD: 65, baseCDD: 65, baseGDD: 50
};

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
    let wet = 0, heavy = 0, snowD = 0, sunny = 0, partly = 0, cloudy = 0;
    let hot = 0, veryHot = 0, freeze = 0, hard = 0, beach = 0, pleasant = 0;
    let hdd = 0, cdd = 0, gdd = 0;
    let nPrecip = 0, nSun = 0, nTemp = 0;

    for (const i of idxs) {
      const p = precip[i], r = rain[i], sn = snow[i];
      if (isNum(p)) { precipSum += p; nPrecip++; if (p >= TH.wetDay) wet++; if (p >= TH.heavyRainDay) heavy++; }
      if (isNum(r)) rainSum += r;
      if (isNum(sn)) { snowSum += sn; if (sn >= TH.snowDay) snowD++; }
      if (isNum(precipHrs[i])) hrsSum += precipHrs[i];
      if (isNum(et0[i])) et0Sum += et0[i];

      const dl = daylight[i], ss = sunshine[i];
      let ratio = null;
      if (isNum(dl) && dl > 0 && isNum(ss)) {
        ratio = Math.min(1, ss / dl);
        nSun++;
        if (ratio >= TH.sunnyRatio) sunny++;
        else if (ratio >= TH.partlyRatio) partly++;
        else cloudy++;
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
      snowfall:    snowSum,
      precipHours: hrsSum,
      et0:         et0Sum,
      wetDays: nPrecip ? wet : null,
      heavyRainDays: nPrecip ? heavy : null,
      dryDays: nPrecip ? days - wet : null,
      snowDays: snowD,
      sunnyDays:  nSun ? sunny  * days / nSun : null,   // scale to a full month
      partlyDays: nSun ? partly * days / nSun : null,
      cloudyDays: nSun ? cloudy * days / nSun : null,
      hot90: hot, hot95: veryHot, freeze32: freeze, freeze20: hard,
      beachDays: beach, pleasantDays: pleasant,
      hdd: nTemp ? hdd : null, cdd: nTemp ? cdd : null, gdd: nTemp ? gdd : null
    });
  }

  const TOTAL_KEYS = ['precipTotal','rainfall','snowfall','precipHours','et0','wetDays',
                      'heavyRainDays','dryDays','snowDays','sunnyDays','partlyDays','cloudyDays',
                      'hot90','hot95','freeze32','freeze20','beachDays','pleasantDays',
                      'hdd','cdd','gdd'];

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
    /* spread, for the "typical range" band on the rainfall chart */
    const pv = yearRows.map(r => r.precipTotal).filter(isNum).sort((a, b) => a - b);
    row.precipP10 = pv.length ? pv[Math.floor(pv.length * 0.1)] : null;
    row.precipP90 = pv.length ? pv[Math.min(pv.length - 1, Math.floor(pv.length * 0.9))] : null;
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
  module.exports = { aggregateMonthly, mergeSST, annualSummary, TH, MIN_DAYS_FOR_MONTH };
}
