/* =============================================================================
   config.js — locations, metric catalogue and shared constants
   =========================================================================== */

/* Each home. `marine` is the offshore grid point used for sea-surface
   temperature / wave data. Rockaway is ~50 mi inland, so its marine point is
   flagged `proxy:true` and always labelled as a nearest-coast reference
   rather than as "your" ocean. */
/* Order is deliberate and is the order everything follows — tabs, overview
   cards, the quick-reference table, the comparison charts and the CSV. North
   to south, which is also how the homes were asked for. Each home carries its
   own accent colour, so reordering never reassigns a colour to a different
   place. */
const LOCATIONS = [
  {
    id: 'rockaway',
    name: 'Rockaway',
    state: 'NJ',
    short: 'Rockaway',
    lat: 40.9012,
    lon: -74.5143,
    elevationFt: 538,
    tz: 'America/New_York',
    accent: '#1baf7a',
    accentDark: '#199e70',
    emoji: '🍂',
    blurb: 'Morris County highlands — humid continental (Köppen Dfa)',
    marine: {
      lat: 40.08,
      lon: -73.95,
      proxy: true,
      proxyName: 'Point Pleasant Beach',
      proxyDistanceMi: 55,
      label: 'Atlantic Ocean — off Point Pleasant Beach (nearest coast, ~55 mi)',
      body: 'Atlantic Ocean',
      coopsStation: '8531680', coopsName: 'Sandy Hook, NJ'
    }
  },
  {
    id: 'nmb',
    name: 'North Myrtle Beach',
    state: 'SC',
    short: 'N. Myrtle Beach',
    lat: 33.8160,
    lon: -78.6800,
    elevationFt: 16,
    tz: 'America/New_York',
    accent: '#2a78d6',
    accentDark: '#3987e5',
    emoji: '🏖️',
    blurb: 'Atlantic coast — humid subtropical (Köppen Cfa)',
    marine: {
      lat: 33.77,
      lon: -78.62,
      proxy: false,
      label: 'Atlantic Ocean — offshore North Myrtle Beach',
      body: 'Atlantic Ocean',
      /* NOAA CO-OPS tide gauge with a water-temperature sensor: a real
         thermometer in the water, used to cross-check the marine model. */
      coopsStation: '8661070', coopsName: 'Springmaid Pier, SC'
    }
  },
  {
    id: 'bonita',
    name: 'Bonita Springs',
    state: 'FL',
    short: 'Bonita Springs',
    lat: 26.3398,
    lon: -81.7787,
    elevationFt: 10,
    tz: 'America/New_York',
    accent: '#eb6834',
    accentDark: '#d95926',
    emoji: '🌴',
    blurb: 'Gulf coast — tropical savanna (Köppen Aw)',
    marine: {
      lat: 26.34,
      lon: -81.90,
      proxy: false,
      label: 'Gulf of Mexico — offshore Bonita Beach',
      body: 'Gulf of Mexico',
      coopsStation: '8725110', coopsName: 'Naples Bay, FL'
    }
  }
];

/* Categorical slots 1–3 of the validated palette, assigned to locations in a
   fixed order. Never cycled, never reassigned when a filter hides a location —
   colour follows the home, not its rank. Validated all-pairs in both modes:
   worst CVD ΔE 9.2 light / 9.4 dark, worst normal-vision ΔE 24.0 / 20.9.
   Light-mode aqua sits at 2.74:1 on the light surface, so every chart using it
   ships direct labels and the table view as relief. */

const MONTHS      = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_FULL = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];

/* ---------------------------------------------------------------------------
   Normals periods. ERA5 lags real time by ~5 days, so end dates are fixed.
   ------------------------------------------------------------------------- */
const PERIODS = {
  '2016-2025': { start: '2016-01-01', end: '2025-12-31', label: '2016–2025 (recent 10 years)',      years: 10 },
  '2011-2025': { start: '2011-01-01', end: '2025-12-31', label: '2011–2025 (recent 15 years)',      years: 15 },
  '1996-2025': { start: '1996-01-01', end: '2025-12-31', label: '1996–2025 (latest 30 years)',      years: 30 },
  '1991-2020': { start: '1991-01-01', end: '2020-12-31', label: '1991–2020 (WMO standard normals)', years: 30 }
};

/* Ten recent years is the default deliberately. It costs a third of a 30-year
   pull, and it describes the climate these homes have now rather than averaging
   in cooler years from the late 1990s. The trade is precision: a monthly mean
   lands within about ±1.6°F rather than ±0.9°F, and the record high/low charts
   read roughly 2.5°F milder simply because ten years offers fewer chances to
   catch an extreme. The longer windows stay one click away for when the fuller
   record is what you want. */
const DEFAULT_PERIOD = '2016-2025';

/* Sea-surface temperature is an hourly-only variable in the Marine API, so its
   climatology is built from a shorter window to keep the payload sane. */
const SST_PERIOD = { start: '2016-01-01', end: '2025-12-31', years: 10 };

/* ---------------------------------------------------------------------------
   Metric catalogue. Drives the chart grid, the sortable table, the comparison
   selector and the CSV export — one definition, used everywhere.
      key    : property on a monthly-climate row
      unit   : suffix for display
      dec    : decimal places
      better : 'high' | 'low' | null — used for ranking highlights
      group  : section the metric belongs to
      ext    : true if it comes from the optional extended variable request
   ------------------------------------------------------------------------- */
const METRICS = [
  { key:'avgHigh',      label:'Avg High',            unit:'°F',   dec:1, group:'temp',  better:null, color:'#dc2626', desc:'Mean daily maximum temperature' },
  { key:'avgLow',       label:'Avg Low',             unit:'°F',   dec:1, group:'temp',  better:null, color:'#2563eb', desc:'Mean daily minimum temperature' },
  { key:'avgMean',      label:'Avg Mean Temp',       unit:'°F',   dec:1, group:'temp',  better:null, color:'#7c3aed', desc:'Mean of the daily mean temperature' },
  { key:'recordHigh',   label:'Record High',         unit:'°F',   dec:0, group:'temp',  better:null, color:'#b91c1c', desc:'Highest daily maximum in the period' },
  { key:'recordLow',    label:'Record Low',          unit:'°F',   dec:0, group:'temp',  better:null, color:'#1d4ed8', desc:'Lowest daily minimum in the period' },
  { key:'diurnal',      label:'Day/Night Swing',     unit:'°F',   dec:1, group:'temp',  better:null, color:'#0891b2', desc:'Average high minus average low' },
  { key:'apparentHigh', label:'Avg Feels-Like High', unit:'°F',   dec:1, group:'temp',  better:null, color:'#f97316', desc:'Mean daily maximum apparent temperature' },
  { key:'apparentLow',  label:'Avg Feels-Like Low',  unit:'°F',   dec:1, group:'temp',  better:null, color:'#38bdf8', desc:'Mean daily minimum apparent temperature' },

  { key:'precipTotal',  label:'Total Precipitation', unit:'in',   dec:2, group:'water', better:null, color:'#0284c7', desc:'Mean monthly precipitation — rain plus melted snow' },
  { key:'rainfall',     label:'Avg Rainfall',        unit:'in',   dec:2, group:'water', better:null, color:'#38bdf8', desc:'Mean monthly liquid rain only, snow excluded' },
  { key:'wetDays',      label:'Avg Wet Days',        unit:'days', dec:1, group:'water', better:null, color:'#0369a1', desc:'Days with ≥ 0.04 in of precipitation — the WMO rain-day threshold' },
  { key:'heavyRainDays',label:'Heavy Rain Days',     unit:'days', dec:1, group:'water', better:null, color:'#075985', desc:'Days with ≥ 1 in of precipitation' },
  { key:'dryDays',      label:'Avg Dry Days',        unit:'days', dec:1, group:'water', better:null, color:'#ca8a04', desc:'Days with < 0.04 in of precipitation' },
  { key:'precipHours',  label:'Precip Hours',        unit:'hrs',  dec:1, group:'water', better:null, color:'#1e40af', desc:'Mean monthly hours with precipitation falling' },
  { key:'snowfall',     label:'Avg Snowfall',        unit:'in',   dec:2, group:'water', better:null, color:'#64748b', desc:'Mean monthly total snowfall' },
  { key:'snowDays',     label:'Avg Snow Days',       unit:'days', dec:1, group:'water', better:null, color:'#475569', desc:'Days with ≥ 0.1 in of snowfall' },
  { key:'recordRain',   label:'Wettest Single Day',  unit:'in',   dec:2, group:'water', better:null, color:'#1e3a8a', desc:'Heaviest 24-hour precipitation in the period' },

  { key:'sunnyDays',    label:'Avg Sunny Days',      unit:'days', dec:1, group:'sun',   better:'high', color:'#f59e0b', desc:'Days with sunshine ≥ 70% of daylight' },
  { key:'partlyDays',   label:'Partly Sunny Days',   unit:'days', dec:1, group:'sun',   better:null, color:'#fbbf24', desc:'Days with sunshine 35–70% of daylight' },
  { key:'cloudyDays',   label:'Avg Cloudy Days',     unit:'days', dec:1, group:'sun',   better:'low',  color:'#94a3b8', desc:'Days with sunshine < 35% of daylight' },
  { key:'sunHours',     label:'Avg Sun Hours/Day',   unit:'hrs',  dec:1, group:'sun',   better:'high', color:'#d97706', desc:'Mean daily sunshine duration' },
  { key:'pctSun',       label:'% of Possible Sun',   unit:'%',    dec:0, group:'sun',   better:'high', color:'#b45309', desc:'Sunshine duration ÷ daylight duration' },
  { key:'solarKwh',     label:'Solar Energy',        unit:'kWh/m²',dec:2,group:'sun',   better:'high', color:'#eab308', desc:'Mean daily shortwave radiation received' },

  { key:'sst',          label:'Avg Ocean Temp',      unit:'°F',   dec:1, group:'ocean', better:null, color:'#0d9488', desc:'Mean sea-surface temperature at the offshore point' },
  { key:'sstMax',       label:'Ocean Temp High',     unit:'°F',   dec:1, group:'ocean', better:null, color:'#14b8a6', desc:'Mean of daily maximum sea-surface temperature' },
  { key:'sstMin',       label:'Ocean Temp Low',      unit:'°F',   dec:1, group:'ocean', better:null, color:'#0f766e', desc:'Mean of daily minimum sea-surface temperature' },
  { key:'waveHeight',   label:'Avg Wave Height',     unit:'ft',   dec:1, group:'ocean', better:null, color:'#0e7490', desc:'Mean significant wave height offshore' },

  { key:'daylight',     label:'Avg Daylight',        unit:'hrs',  dec:2, group:'sky',   better:null, color:'#f59e0b', desc:'Sunrise-to-sunset duration, monthly mean' },
  { key:'sunriseMin',   label:'Avg Sunrise',         unit:'time', dec:0, group:'sky',   better:null, color:'#fb923c', desc:'Mean sunrise time (local, DST-aware)' },
  { key:'sunsetMin',    label:'Avg Sunset',          unit:'time', dec:0, group:'sky',   better:null, color:'#c2410c', desc:'Mean sunset time (local, DST-aware)' },
  { key:'solarNoonMin', label:'Avg Solar Noon',      unit:'time', dec:0, group:'sky',   better:null, color:'#92400e', desc:'Mean solar noon (sun at its highest)' },

  { key:'humidity',     label:'Avg Humidity',        unit:'%',    dec:0, group:'air',   better:null, color:'#0891b2', desc:'Mean daily relative humidity', ext:true },
  { key:'dewPoint',     label:'Avg Dew Point',       unit:'°F',   dec:1, group:'air',   better:null, color:'#0e7490', desc:'Mean daily dew point — the muggy-ness measure', ext:true },
  { key:'cloudCover',   label:'Avg Cloud Cover',     unit:'%',    dec:0, group:'air',   better:'low',  color:'#64748b', desc:'Mean daily total cloud cover', ext:true },
  { key:'windSpeed',    label:'Avg Wind',            unit:'mph',  dec:1, group:'air',   better:null, color:'#0f766e', desc:'Mean daily mean wind speed at 10 m' },
  { key:'windMax',      label:'Avg Peak Wind',       unit:'mph',  dec:1, group:'air',   better:null, color:'#115e59', desc:'Mean daily maximum wind speed at 10 m' },
  { key:'windGust',     label:'Avg Peak Gust',       unit:'mph',  dec:1, group:'air',   better:null, color:'#134e4a', desc:'Mean daily maximum wind gust' },
  { key:'pressure',     label:'Avg Pressure',        unit:'inHg', dec:2, group:'air',   better:null, color:'#475569', desc:'Mean sea-level pressure', ext:true },

  { key:'hot90',        label:'Days ≥ 90°F',         unit:'days', dec:1, group:'thresh',better:null, color:'#ea580c', desc:'Days reaching 90°F or hotter' },
  { key:'hot95',        label:'Days ≥ 95°F',         unit:'days', dec:1, group:'thresh',better:null, color:'#c2410c', desc:'Days reaching 95°F or hotter' },
  { key:'freeze32',     label:'Days ≤ 32°F',         unit:'days', dec:1, group:'thresh',better:null, color:'#3b82f6', desc:'Days with a low of 32°F or colder' },
  { key:'freeze20',     label:'Days ≤ 20°F',         unit:'days', dec:1, group:'thresh',better:null, color:'#1d4ed8', desc:'Days with a low of 20°F or colder' },
  { key:'beachDays',    label:'Beach Days',          unit:'days', dec:1, group:'thresh',better:'high', color:'#f59e0b', desc:'High 75–95°F, < 0.04 in rain, sunshine ≥ 50% of daylight' },
  { key:'pleasantDays', label:'Pleasant Days',       unit:'days', dec:1, group:'thresh',better:'high', color:'#16a34a', desc:'High 65–85°F, low ≥ 45°F, < 0.04 in rain' },

  { key:'breezyDays',     label:'Breezy Days',        unit:'days', dec:1, group:'wind', better:null, color:'#0e7490', desc:'Days gusting to 25 mph or more' },
  { key:'strongWindDays', label:'Gale-Force Days',    unit:'days', dec:1, group:'wind', better:null, color:'#0f766e', desc:'Days gusting to 39 mph — tropical-storm force' },
  { key:'severeWindDays', label:'Damaging Wind Days', unit:'days', dec:2, group:'wind', better:null, color:'#134e4a', desc:'Days gusting to 58 mph — the severe-thunderstorm threshold' },

  { key:'hdd',          label:'Heating Degree Days', unit:'HDD',  dec:0, group:'energy',better:null, color:'#2563eb', desc:'Σ max(0, 65°F − daily mean) — heating demand' },
  { key:'cdd',          label:'Cooling Degree Days', unit:'CDD',  dec:0, group:'energy',better:null, color:'#dc2626', desc:'Σ max(0, daily mean − 65°F) — cooling demand' },
  { key:'gdd',          label:'Growing Degree Days', unit:'GDD',  dec:0, group:'energy',better:null, color:'#16a34a', desc:'Σ max(0, daily mean − 50°F) — plant growth' },
  { key:'et0',          label:'Evapotranspiration',  unit:'in',   dec:2, group:'energy',better:null, color:'#65a30d', desc:'Reference ET₀ — irrigation demand' }
];

const METRIC_BY_KEY = Object.fromEntries(METRICS.map(m => [m.key, m]));

const GROUPS = {
  temp:   { label:'Temperature',        icon:'🌡️' },
  water:  { label:'Rain & Snow',        icon:'🌧️' },
  sun:    { label:'Sunshine',           icon:'☀️' },
  ocean:  { label:'Ocean',              icon:'🌊' },
  sky:    { label:'Sun & Sky Times',    icon:'🌅' },
  air:    { label:'Air & Wind',         icon:'💨' },
  thresh: { label:'Threshold Days',     icon:'📊' },
  wind:   { label:'Wind & Storms',      icon:'🌀' },
  trend:  { label:'Year-by-Year Trends',icon:'📈' },
  energy: { label:'Energy & Growing',   icon:'⚡' }
};

/* WMO weather interpretation codes → label + emoji (day / night variants). */
const WMO = {
  0:  ['Clear sky','☀️','🌙'],          1:  ['Mainly clear','🌤️','🌙'],
  2:  ['Partly cloudy','⛅','☁️'],       3:  ['Overcast','☁️','☁️'],
  45: ['Fog','🌫️','🌫️'],               48: ['Rime fog','🌫️','🌫️'],
  51: ['Light drizzle','🌦️','🌧️'],      53: ['Drizzle','🌦️','🌧️'],
  55: ['Heavy drizzle','🌧️','🌧️'],      56: ['Freezing drizzle','🌨️','🌨️'],
  57: ['Freezing drizzle','🌨️','🌨️'],   61: ['Light rain','🌦️','🌧️'],
  63: ['Rain','🌧️','🌧️'],               65: ['Heavy rain','🌧️','🌧️'],
  66: ['Freezing rain','🌨️','🌨️'],      67: ['Freezing rain','🌨️','🌨️'],
  71: ['Light snow','🌨️','🌨️'],         73: ['Snow','❄️','❄️'],
  75: ['Heavy snow','❄️','❄️'],          77: ['Snow grains','🌨️','🌨️'],
  80: ['Light showers','🌦️','🌧️'],      81: ['Showers','🌧️','🌧️'],
  82: ['Violent showers','⛈️','⛈️'],     85: ['Snow showers','🌨️','🌨️'],
  86: ['Heavy snow showers','❄️','❄️'],  95: ['Thunderstorm','⛈️','⛈️'],
  96: ['Thunderstorm + hail','⛈️','⛈️'], 99: ['Severe thunderstorm','⛈️','⛈️']
};
function wmoInfo(code, isDay = 1) {
  const e = WMO[code] || ['Unknown','❓','❓'];
  return { label: e[0], icon: isDay ? e[1] : e[2] };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LOCATIONS, MONTHS, MONTHS_FULL, PERIODS, DEFAULT_PERIOD,
                     SST_PERIOD, METRICS, METRIC_BY_KEY, GROUPS, WMO, wmoInfo };
}
