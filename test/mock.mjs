/* Synthetic Open-Meteo responses, shaped exactly like the real payloads.
   Values follow a seasonal sine so the charts have realistic structure and the
   assertions can predict which month should win each superlative. */

const DAY = 86400000;
const iso = d => d.toISOString().slice(0, 10);

/* Deterministic pseudo-random so runs are reproducible. */
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

/* A location profile: warm peak, cold trough, wet season, snow. */
export const PROFILES = {
  /* base = annual mean °F, amp = peak-to-trough swing of the monthly mean.
     Chosen to match the real climates closely enough that the mock exercises
     the same branches the live archive will — freezing NJ winters, a Florida
     dry season, snow that only ever falls at one of the three homes. */
  nmb:      { base: 64, amp: 34, precip: 0.14, snow: false, sst: [58, 24] },
  bonita:   { base: 75, amp: 18, precip: 0.16, snow: false, sst: [72, 14] },
  rockaway: { base: 52, amp: 45, precip: 0.12, snow: true,  sst: [54, 22] }
};

function profileFor(lat) {
  if (lat > 38) return PROFILES.rockaway;
  if (lat < 30) return PROFILES.bonita;
  return PROFILES.nmb;
}

/* Seasonal factor: 0 at the coldest point (mid-Jan), 1 at the warmest (mid-Jul). */
const season = doy => (1 - Math.cos((doy - 15) / 365 * 2 * Math.PI)) / 2;

export function archiveResponse(url) {
  const u = new URL(url);
  const lat = +u.searchParams.get('latitude');
  const start = u.searchParams.get('start_date'), end = u.searchParams.get('end_date');
  const vars = (u.searchParams.get('daily') || '').split(',').filter(Boolean);
  const p = profileFor(lat);
  const r = rng(Math.round(lat * 1000) + start.length);

  const daily = { time: [] };
  vars.forEach(v => daily[v] = []);

  for (let t = Date.parse(start + 'T00:00:00Z'); t <= Date.parse(end + 'T00:00:00Z'); t += DAY) {
    const d = new Date(t);
    const doy = Math.floor((t - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY) + 1;
    const s = season(doy), jitter = (r() - 0.5) * 8;
    const mean = p.base - p.amp / 2 + p.amp * s + jitter;
    const hi = mean + 11, lo = mean - 11;
    const daylight = (10 + 4 * s) * 3600;
    const sunFrac = 0.35 + 0.4 * r();
    const wet = r() < 0.32;
    const precip = wet ? +(r() * 1.4).toFixed(3) : 0;
    const snowing = p.snow && mean < 34 && wet;

    daily.time.push(iso(d));
    const put = (k, v) => { if (k in daily) daily[k].push(v); };
    put('weather_code', wet ? 61 : 1);
    put('temperature_2m_max', +hi.toFixed(1));
    put('temperature_2m_min', +lo.toFixed(1));
    put('temperature_2m_mean', +mean.toFixed(1));
    put('apparent_temperature_max', +(hi + 3).toFixed(1));
    put('apparent_temperature_min', +(lo - 2).toFixed(1));
    put('daylight_duration', +daylight.toFixed(0));
    put('sunshine_duration', +(daylight * sunFrac).toFixed(0));
    put('precipitation_sum', precip);
    put('rain_sum', snowing ? 0 : precip);
    put('snowfall_sum', snowing ? +(precip * 7).toFixed(2) : 0);
    put('precipitation_hours', wet ? Math.round(r() * 8) : 0);
    put('wind_speed_10m_max', +(9 + r() * 14).toFixed(1));
    put('wind_gusts_10m_max', +(18 + r() * 22).toFixed(1));
    put('wind_direction_10m_dominant', Math.round(r() * 360));
    put('shortwave_radiation_sum', +(6 + 16 * s).toFixed(2));
    put('et0_fao_evapotranspiration', +(0.04 + 0.16 * s).toFixed(3));
    put('relative_humidity_2m_mean', +(62 + r() * 22).toFixed(0));
    put('dew_point_2m_mean', +(mean - 12).toFixed(1));
    put('cloud_cover_mean', +(100 - sunFrac * 90).toFixed(0));
    put('pressure_msl_mean', +(1010 + r() * 14).toFixed(1));
    put('wind_speed_10m_mean', +(5 + r() * 8).toFixed(1));
  }
  return { latitude: lat, longitude: +u.searchParams.get('longitude'), elevation: 12, daily };
}

/* Local wall-clock ISO string in a zone, matching Open-Meteo's offset-free format. */
const localISO = (d, tz) => d.toLocaleString('sv-SE', { timeZone: tz }).slice(0, 16).replace(' ', 'T');

export function forecastResponse(url) {
  const u = new URL(url);
  const tz = u.searchParams.get('timezone') || 'UTC';
  const lat = +u.searchParams.get('latitude');
  const p = profileFor(lat), r = rng(Math.round(lat * 100));
  const now = new Date();
  const doy = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / DAY);
  const s = season(doy);
  const mean = p.base - p.amp / 2 + p.amp * s;

  const days = 9;                                   // past_days=2 + forecast_days=7
  const d0 = new Date(now.getTime() - 2 * DAY);
  const daily = { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [],
    apparent_temperature_max: [], apparent_temperature_min: [], sunrise: [], sunset: [],
    daylight_duration: [], sunshine_duration: [], uv_index_max: [], precipitation_sum: [],
    rain_sum: [], showers_sum: [], snowfall_sum: [], precipitation_hours: [],
    precipitation_probability_max: [], wind_speed_10m_max: [], wind_gusts_10m_max: [],
    wind_direction_10m_dominant: [] };
  for (let i = 0; i < days; i++) {
    const d = new Date(d0.getTime() + i * DAY);
    daily.time.push(localISO(d, tz).slice(0, 10));
    daily.weather_code.push([0, 1, 2, 3, 61, 80, 95][Math.floor(r() * 7)]);
    daily.temperature_2m_max.push(+(mean + 10 + r() * 5).toFixed(1));
    daily.temperature_2m_min.push(+(mean - 10 + r() * 5).toFixed(1));
    daily.apparent_temperature_max.push(+(mean + 13).toFixed(1));
    daily.apparent_temperature_min.push(+(mean - 12).toFixed(1));
    daily.sunrise.push(localISO(d, tz).slice(0, 10) + 'T06:30');
    daily.sunset.push(localISO(d, tz).slice(0, 10) + 'T19:45');
    daily.daylight_duration.push(47700); daily.sunshine_duration.push(32000);
    daily.uv_index_max.push(+(2 + r() * 8).toFixed(1));
    daily.precipitation_sum.push(+(r() * 0.9).toFixed(2));
    daily.rain_sum.push(+(r() * 0.7).toFixed(2));
    daily.showers_sum.push(+(r() * 0.2).toFixed(2));
    daily.snowfall_sum.push(p.snow && mean < 34 ? +(r() * 3).toFixed(1) : 0);
    daily.precipitation_hours.push(Math.round(r() * 9));
    daily.precipitation_probability_max.push(Math.round(r() * 100));
    daily.wind_speed_10m_max.push(+(8 + r() * 16).toFixed(1));
    daily.wind_gusts_10m_max.push(+(16 + r() * 24).toFixed(1));
    daily.wind_direction_10m_dominant.push(Math.round(r() * 360));
  }

  const hourly = { time: [], temperature_2m: [], relative_humidity_2m: [], dew_point_2m: [],
    apparent_temperature: [], precipitation_probability: [], precipitation: [], weather_code: [],
    cloud_cover: [], visibility: [], wind_speed_10m: [], wind_gusts_10m: [], wind_direction_10m: [],
    uv_index: [], is_day: [] };
  const h0 = new Date(d0); h0.setHours(0, 0, 0, 0);
  for (let i = 0; i < days * 24; i++) {
    const t = new Date(h0.getTime() + i * 3600000);
    const hr = t.getHours();
    const diurnal = -Math.cos((hr - 4) / 24 * 2 * Math.PI) * 9;
    hourly.time.push(localISO(t, tz));
    hourly.temperature_2m.push(+(mean + diurnal + r() * 2).toFixed(1));
    hourly.relative_humidity_2m.push(Math.round(55 + r() * 40));
    hourly.dew_point_2m.push(+(mean - 12 + r() * 4).toFixed(1));
    hourly.apparent_temperature.push(+(mean + diurnal + 3).toFixed(1));
    hourly.precipitation_probability.push(Math.round(r() * 100));
    hourly.precipitation.push(+(r() * 0.1).toFixed(2));
    hourly.weather_code.push([0, 1, 2, 3, 61][Math.floor(r() * 5)]);
    hourly.cloud_cover.push(Math.round(r() * 100));
    hourly.visibility.push(Math.round(30000 + r() * 40000));
    hourly.wind_speed_10m.push(+(4 + r() * 18).toFixed(1));
    hourly.wind_gusts_10m.push(+(9 + r() * 26).toFixed(1));
    hourly.wind_direction_10m.push(Math.round(r() * 360));
    hourly.uv_index.push(hr > 8 && hr < 18 ? +(r() * 10).toFixed(1) : 0);
    hourly.is_day.push(hr >= 7 && hr < 19 ? 1 : 0);
  }

  return {
    latitude: lat, longitude: +u.searchParams.get('longitude'), elevation: 12,
    timezone: u.searchParams.get('timezone'),
    current: {
      time: localISO(new Date(), tz),
      temperature_2m: +(mean + 8).toFixed(1), relative_humidity_2m: 64,
      apparent_temperature: +(mean + 11).toFixed(1), is_day: 1, precipitation: 0,
      rain: 0, showers: 0, snowfall: 0, weather_code: 2, cloud_cover: 42,
      pressure_msl: 1015.3, surface_pressure: 1013.1, wind_speed_10m: 9.4,
      wind_direction_10m: 214, wind_gusts_10m: 17.2
    },
    current_units: { temperature_2m: '°F' },
    daily, hourly
  };
}

export function marineResponse(url) {
  const u = new URL(url);
  const lat = +u.searchParams.get('latitude');
  const p = profileFor(lat), r = rng(Math.round(lat * 77));
  const start = u.searchParams.get('start_date'), end = u.searchParams.get('end_date');
  const dailyVars = (u.searchParams.get('daily') || '').split(',').filter(Boolean);
  const hourlyVars = (u.searchParams.get('hourly') || '').split(',').filter(Boolean);
  const out = { latitude: lat, longitude: +u.searchParams.get('longitude') };

  if (!start) {
    /* live marine */
    out.current = { time: new Date().toISOString().slice(0, 16),
      sea_surface_temperature: +(p.sst[0] + p.sst[1] * 0.6).toFixed(1),
      wave_height: +(1.5 + r() * 3).toFixed(1), wave_period: +(5 + r() * 5).toFixed(1),
      wave_direction: Math.round(r() * 360) };
    out.hourly = { time: [], sea_surface_temperature: [], wave_height: [], wave_period: [] };
    out.daily = { time: [], wave_height_max: [], wave_period_max: [], wave_direction_dominant: [] };
    return out;
  }

  const times = [];
  for (let t = Date.parse(start + 'T00:00:00Z'); t <= Date.parse(end + 'T00:00:00Z'); t += DAY) times.push(iso(new Date(t)));

  if (dailyVars.length) {
    out.daily = { time: times };
    dailyVars.forEach(v => out.daily[v] = []);
    times.forEach(ts => {
      const doy = Math.floor((Date.parse(ts + 'T00:00:00Z') - Date.UTC(+ts.slice(0, 4), 0, 1)) / DAY) + 1;
      /* Sea temperature lags the air by about six weeks. */
      const s = season(doy - 40);
      const sst = p.sst[0] + p.sst[1] * s;
      if ('sea_surface_temperature_mean' in out.daily) out.daily.sea_surface_temperature_mean.push(+sst.toFixed(1));
      if ('sea_surface_temperature_max'  in out.daily) out.daily.sea_surface_temperature_max.push(+(sst + 1.4).toFixed(1));
      if ('sea_surface_temperature_min'  in out.daily) out.daily.sea_surface_temperature_min.push(+(sst - 1.4).toFixed(1));
      if ('wave_height_max'              in out.daily) out.daily.wave_height_max.push(+(1.6 + r() * 4).toFixed(1));
    });
  }
  if (hourlyVars.length) {
    out.hourly = { time: [] };
    hourlyVars.forEach(v => out.hourly[v] = []);
    times.forEach(ts => {
      for (let h = 0; h < 24; h += 1) {
        const doy = Math.floor((Date.parse(ts + 'T00:00:00Z') - Date.UTC(+ts.slice(0, 4), 0, 1)) / DAY) + 1;
        const sst = p.sst[0] + p.sst[1] * season(doy - 40);
        out.hourly.time.push(`${ts}T${String(h).padStart(2, '0')}:00`);
        if ('sea_surface_temperature' in out.hourly) out.hourly.sea_surface_temperature.push(+sst.toFixed(1));
        if ('wave_height' in out.hourly) out.hourly.wave_height.push(+(1.6 + r() * 4).toFixed(1));
      }
    });
  }
  return out;
}

export function airResponse(url) {
  const u = new URL(url);
  return {
    latitude: +u.searchParams.get('latitude'),
    current: { time: new Date().toISOString().slice(0, 16), us_aqi: 38, pm10: 12.4, pm2_5: 6.1,
               ozone: 61, carbon_monoxide: 140, nitrogen_dioxide: 7.2, sulphur_dioxide: 1.1 },
    hourly: { time: [], us_aqi: [] }
  };
}
