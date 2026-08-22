/* =============================================================================
   units.js — unit-aware conversion.

   Every Open-Meteo response declares its own units in `current_units`,
   `hourly_units` and `daily_units`. Assuming a unit instead of reading it is
   how a dashboard ends up silently off by 3.28x: visibility is documented in
   different units in different places, and a hard-coded ÷5280 is right only
   if the payload really is in feet.

   So nothing here guesses. Each converter is told the unit string the API
   supplied and returns null — never a wrong number — for a unit it does not
   recognise. A null shows as "—" on the page, which is honest; a silently
   mis-scaled figure is not.
   =========================================================================== */

/* Canonical spellings the API is known to emit, mapped to a factor that
   converts INTO the imperial unit this dashboard displays. */
const LENGTH_TO_MILES = {
  'm': 1 / 1609.344, 'm-1': 1 / 1609.344, 'meter': 1 / 1609.344, 'meters': 1 / 1609.344, 'metre': 1 / 1609.344,
  'km': 1 / 1.609344, 'kilometer': 1 / 1.609344, 'kilometre': 1 / 1.609344,
  'ft': 1 / 5280, 'feet': 1 / 5280, 'foot': 1 / 5280,
  'mi': 1, 'mile': 1, 'miles': 1,
  'yd': 1 / 1760, 'yard': 1 / 1760
};

const LENGTH_TO_FEET = {
  'm': 3.280839895, 'meter': 3.280839895, 'meters': 3.280839895, 'metre': 3.280839895,
  'km': 3280.839895, 'kilometer': 3280.839895, 'kilometre': 3280.839895,
  'ft': 1, 'feet': 1, 'foot': 1,
  'mi': 5280, 'mile': 5280, 'miles': 5280,
  'cm': 0.032808399, 'in': 1 / 12, 'inch': 1 / 12
};

const PRESSURE_TO_INHG = {
  'hpa': 0.029529983, 'mb': 0.029529983, 'millibar': 0.029529983, 'pa': 0.00029529983,
  'inhg': 1, 'in': 1, 'inch': 1, 'kpa': 0.29529983
};

const TEMP_UNITS = { '°f': 'F', 'f': 'F', 'fahrenheit': 'F', '°c': 'C', 'c': 'C', 'celsius': 'C' };

const SPEED_TO_MPH = {
  'mph': 1, 'mp/h': 1,
  'km/h-1': 0.621371192, 'm/s-1': 2.236936292,   /* NWS spellings */
  'km/h': 0.621371192, 'kmh': 0.621371192, 'kph': 0.621371192,
  'm/s': 2.236936292, 'ms': 2.236936292,
  'kn': 1.150779448, 'kt': 1.150779448, 'knots': 1.150779448, 'knot': 1.150779448
};

const PRECIP_TO_INCHES = {
  'inch': 1, 'in': 1, 'inches': 1,
  'mm': 1 / 25.4, 'millimeter': 1 / 25.4, 'millimetre': 1 / 25.4,
  'cm': 1 / 2.54, 'centimeter': 1 / 2.54, 'centimetre': 1 / 2.54,
  'm': 39.3700787
};

/* Normalises "°F", " °F ", "degF" and friends down to a lookup key. */
function normUnit(u) {
  if (u == null) return null;
  return String(u).trim().toLowerCase()
    /* NWS labels units as "wmoUnit:degC", "wmoUnit:m_s-1", "wmoUnit:percent". */
    .replace(/^wmounit:/, '')
    .replace(/^deg(rees)?\s*/, '°')
    .replace(/_/g, '/')
    .replace(/\s+/g, '');
}

/* Named distinctly: every js/ file shares one global scope in the browser, so
   a second top-level `isNum` would collide with climate.js and stop it loading. */
const isFiniteNum = v => typeof v === 'number' && Number.isFinite(v);

/* Every converter follows the same contract: a value plus the unit the API
   named for it. An unknown unit yields null and records why, so a wrong unit
   surfaces in the diagnostics panel instead of on a stat tile. */
const UNIT_WARNINGS = [];
function unknownUnit(kind, unit, ctx) {
  const msg = `${kind}: unrecognised unit ${JSON.stringify(unit)}${ctx ? ` (${ctx})` : ''}`;
  if (!UNIT_WARNINGS.includes(msg)) UNIT_WARNINGS.push(msg);
  return null;
}

function convert(table, kind, value, unit, ctx) {
  if (!isFiniteNum(value)) return null;
  const k = normUnit(unit);
  if (k == null) return unknownUnit(kind, unit, ctx);
  const f = table[k];
  if (f == null) return unknownUnit(kind, unit, ctx);
  return value * f;
}

const toMiles  = (v, u, ctx) => convert(LENGTH_TO_MILES,  'length',   v, u, ctx);
const toFeet   = (v, u, ctx) => convert(LENGTH_TO_FEET,   'length',   v, u, ctx);
const toInHg   = (v, u, ctx) => convert(PRESSURE_TO_INHG, 'pressure', v, u, ctx);
const toMph    = (v, u, ctx) => convert(SPEED_TO_MPH,     'speed',    v, u, ctx);
const toInches = (v, u, ctx) => convert(PRECIP_TO_INCHES, 'precip',   v, u, ctx);

function toFahrenheit(v, u, ctx) {
  if (!isFiniteNum(v)) return null;
  const k = normUnit(u);
  const scale = TEMP_UNITS[k];
  if (!scale) return unknownUnit('temperature', u, ctx);
  return scale === 'F' ? v : v * 9 / 5 + 32;
}

/* Pulls the unit string for one variable out of an Open-Meteo response block,
   e.g. unitOf(wx, 'hourly', 'visibility') → "ft" or "m". */
function unitOf(payload, block, key) {
  const u = payload && payload[`${block}_units`];
  return (u && u[key]) != null ? u[key] : null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { toMiles, toFeet, toInHg, toMph, toInches, toFahrenheit,
                     unitOf, normUnit, UNIT_WARNINGS,
                     LENGTH_TO_MILES, LENGTH_TO_FEET, PRESSURE_TO_INHG,
                     SPEED_TO_MPH, PRECIP_TO_INCHES };
}
