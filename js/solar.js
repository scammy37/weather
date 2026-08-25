/* =============================================================================
   solar.js — sunrise / sunset / solar-noon / daylight from first principles.

   Implements the NOAA Solar Calculator equations (Astronomical Algorithms,
   Jean Meeus). Computing these locally rather than fetching them means the
   sun-and-sky charts render instantly, work offline, and can be produced for
   any date without an API round-trip.

   All functions return UTC instants; local wall-clock time is derived with
   Intl.DateTimeFormat against the location's IANA zone, so US daylight-saving
   transitions are handled by the platform rather than by hand.
   =========================================================================== */

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

/* Julian Day for 00:00 UTC on the given calendar date. */
function julianDay(y, m, d) {
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
}

/* Core NOAA series, evaluated at a Julian century T. */
function solarTerms(T) {
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M  = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e  = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C  = Math.sin(M * D2R) * (1.914602 - T * (0.004817 + 0.000014 * T))
           + Math.sin(2 * M * D2R) * (0.019993 - 0.000101 * T)
           + Math.sin(3 * M * D2R) * 0.000289;
  const trueLong = L0 + C;
  const appLong  = trueLong - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * T) * D2R);
  const meanObl  = 23 + (26 + ((21.448 - T * (46.815 + T * (0.00059 - T * 0.001813)))) / 60) / 60;
  const oblCorr  = meanObl + 0.00256 * Math.cos((125.04 - 1934.136 * T) * D2R);
  const decl     = Math.asin(Math.sin(oblCorr * D2R) * Math.sin(appLong * D2R)) * R2D;

  const y = Math.tan((oblCorr / 2) * D2R) ** 2;
  const eqTime = 4 * R2D * (
      y * Math.sin(2 * L0 * D2R)
    - 2 * e * Math.sin(M * D2R)
    + 4 * e * y * Math.sin(M * D2R) * Math.cos(2 * L0 * D2R)
    - 0.5 * y * y * Math.sin(4 * L0 * D2R)
    - 1.25 * e * e * Math.sin(2 * M * D2R));

  return { decl, eqTime };
}

/* Hour angle (degrees) at which the sun's centre sits at `zenith`.
   90.833° is the standard sunrise/sunset zenith: it folds in refraction
   (~34') plus the sun's semi-diameter (~16'). */
function hourAngle(latDeg, declDeg, zenith = 90.833) {
  const lat = latDeg * D2R, decl = declDeg * D2R;
  const cosH = (Math.cos(zenith * D2R) / (Math.cos(lat) * Math.cos(decl))) - Math.tan(lat) * Math.tan(decl);
  if (cosH > 1)  return null;   // polar night — sun never rises
  if (cosH < -1) return NaN;    // midnight sun — sun never sets
  return Math.acos(cosH) * R2D;
}

/* The location's own calendar day, as a Date whose UTC Y/M/D fields hold the
   LOCAL date in `tz`. sunTimes reads Y/M/D in UTC, so passing a bare `new
   Date()` computed tomorrow's sun times after ~8pm Eastern — once the instant
   crosses midnight UTC, its UTC date is already the next day. Deriving the date
   in the home's own zone is what the sun tiles actually mean by "today". */
function localCalendarDate(tz, at = new Date()) {
  /* en-CA renders as YYYY-MM-DD; sv-SE would too. Either gives the local date
     without having to parse a localized month name. */
  const iso = at.toLocaleDateString('en-CA', { timeZone: tz });
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/* Sun event times for a calendar date at a location.
   `date` is interpreted as a calendar day (Y/M/D taken in UTC).
   Returns UTC Date objects plus daylight length in minutes. */
function sunTimes(date, lat, lon, zenith = 90.833) {
  const y = date.getUTCFullYear(), m = date.getUTCMonth() + 1, d = date.getUTCDate();
  const jd = julianDay(y, m, d);

  // Two passes: the first uses the day's mean terms, the second re-evaluates
  // at the approximate event time so fast-moving declination is accounted for.
  let T = (jd - 2451545) / 36525;
  let { decl, eqTime } = solarTerms(T);
  let noonMin = 720 - 4 * lon - eqTime;          // minutes after 00:00 UTC
  T = (jd + noonMin / 1440 - 2451545) / 36525;
  ({ decl, eqTime } = solarTerms(T));
  noonMin = 720 - 4 * lon - eqTime;

  const ha = hourAngle(lat, decl, zenith);
  const base = Date.UTC(y, m - 1, d);
  const at = min => new Date(base + Math.round(min * 60000));

  if (ha === null) return { sunrise:null, sunset:null, solarNoon:at(noonMin), daylightMinutes:0,    declination:decl, polar:'night' };
  if (Number.isNaN(ha)) return { sunrise:null, sunset:null, solarNoon:at(noonMin), daylightMinutes:1440, declination:decl, polar:'day' };

  return {
    sunrise:         at(noonMin - 4 * ha),
    sunset:          at(noonMin + 4 * ha),
    solarNoon:       at(noonMin),
    daylightMinutes: 8 * ha,
    declination:     decl,
    polar:           null
  };
}

/* Civil twilight (sun 6° below the horizon) — first/last usable light. */
function civilTwilight(date, lat, lon) {
  const t = sunTimes(date, lat, lon, 96);
  return { dawn: t.sunrise, dusk: t.sunset };
}

/* Local wall-clock minutes-after-midnight for a UTC instant in an IANA zone.
   Uses Intl so DST is resolved by the platform's tz database. */
const _fmtCache = new Map();
function localMinutes(utcDate, tz) {
  if (!utcDate) return null;
  let f = _fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    _fmtCache.set(tz, f);
  }
  const parts = f.formatToParts(utcDate);
  const h = +parts.find(p => p.type === 'hour').value;
  const mi = +parts.find(p => p.type === 'minute').value;
  return h * 60 + mi;
}

/* "6:42 AM" from minutes-after-local-midnight. */
function fmtMinutes(mins) {
  if (mins == null || Number.isNaN(mins)) return '—';
  let m = Math.round(mins) % 1440;
  if (m < 0) m += 1440;
  const h24 = Math.floor(m / 60), mm = m % 60;
  const ampm = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${ampm}`;
}

/* "13h 27m" from a duration in minutes. */
function fmtDuration(mins) {
  if (mins == null || Number.isNaN(mins)) return '—';
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/* -----------------------------------------------------------------------------
   Monthly sun-and-sky climatology. Averages every calendar day of a non-leap
   reference year so the result is a true monthly mean rather than a mid-month
   snapshot. DST is applied per-day, which is why e.g. March sunset averages
   jump — that is real, and the chart says so.
   --------------------------------------------------------------------------- */
function monthlySunClimatology(lat, lon, tz, refYear = 2025) {
  const out = [];
  for (let mo = 0; mo < 12; mo++) {
    let nRise = 0, sRise = 0, nSet = 0, sSet = 0, nNoon = 0, sNoon = 0, sDay = 0, nDay = 0;
    let minDay = Infinity, maxDay = -Infinity, minDayDate = null, maxDayDate = null;
    const days = new Date(Date.UTC(refYear, mo + 1, 0)).getUTCDate();
    for (let d = 1; d <= days; d++) {
      const date = new Date(Date.UTC(refYear, mo, d));
      const t = sunTimes(date, lat, lon);
      const rise = localMinutes(t.sunrise, tz);
      const set  = localMinutes(t.sunset,  tz);
      const noon = localMinutes(t.solarNoon, tz);
      if (rise != null) { sRise += rise; nRise++; }
      if (set  != null) { sSet  += set;  nSet++;  }
      if (noon != null) { sNoon += noon; nNoon++; }
      sDay += t.daylightMinutes; nDay++;
      if (t.daylightMinutes < minDay) { minDay = t.daylightMinutes; minDayDate = d; }
      if (t.daylightMinutes > maxDay) { maxDay = t.daylightMinutes; maxDayDate = d; }
    }
    out.push({
      month: mo,
      sunriseMin:   nRise ? sRise / nRise : null,
      sunsetMin:    nSet  ? sSet  / nSet  : null,
      solarNoonMin: nNoon ? sNoon / nNoon : null,
      daylight:     nDay  ? (sDay / nDay) / 60 : null,   // hours
      shortestDay:  minDay / 60, shortestDayDate: minDayDate,
      longestDay:   maxDay / 60, longestDayDate:  maxDayDate
    });
  }
  return out;
}

/* Per-day sun curve for one year — feeds the daylight ribbon chart. */
function dailySunCurve(lat, lon, tz, refYear = 2025, step = 1) {
  const rows = [];
  const start = Date.UTC(refYear, 0, 1), end = Date.UTC(refYear, 11, 31);
  for (let t = start; t <= end; t += step * 86400000) {
    const date = new Date(t);
    const s = sunTimes(date, lat, lon);
    rows.push({
      doy:      Math.round((t - start) / 86400000) + 1,
      month:    date.getUTCMonth(),
      day:      date.getUTCDate(),
      rise:     localMinutes(s.sunrise, tz),
      set:      localMinutes(s.sunset,  tz),
      noon:     localMinutes(s.solarNoon, tz),
      daylight: s.daylightMinutes / 60
    });
  }
  return rows;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { julianDay, sunTimes, civilTwilight, localMinutes, fmtMinutes, localCalendarDate,
                     fmtDuration, monthlySunClimatology, dailySunCurve, hourAngle };
}
