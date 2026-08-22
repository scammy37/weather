/* Exhaustive unit-conversion tests. Every figure the dashboard shows passes
   through here, so a wrong factor is a wrong number on the page.
   Run: node test/units.mjs */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const u = require('../js/units.js');

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + n); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + n + (e ? '  → ' + e : '')); } };
const near = (a, b, tol) => a != null && Math.abs(a - b) <= tol;
const eq = (n, got, want, tol = 1e-9) => ok(n, near(got, want, tol), `got ${got}, want ${want}`);

console.log('\n\x1b[1mlength → miles (NIST exact factors)\x1b[0m');
eq('1609.344 m = 1 mi exactly', u.toMiles(1609.344, 'm'), 1);
eq('5280 ft = 1 mi exactly', u.toMiles(5280, 'ft'), 1);
eq('1.609344 km = 1 mi exactly', u.toMiles(1.609344, 'km'), 1);
eq('1760 yd = 1 mi exactly', u.toMiles(1760, 'yd'), 1);
eq('miles pass through', u.toMiles(7.5, 'mi'), 7.5);
eq('16093.44 m = 10 mi', u.toMiles(16093.44, 'meters'), 10);

console.log('\n\x1b[1mlength → feet\x1b[0m');
eq('1 m = 3.280839895 ft', u.toFeet(1, 'm'), 3.280839895, 1e-9);
eq('1 mi = 5280 ft', u.toFeet(1, 'mi'), 5280, 1e-6);
eq('12 in = 1 ft', u.toFeet(12, 'in'), 1, 1e-9);
eq('164 m ≈ 538 ft (Rockaway elevation)', u.toFeet(164, 'm'), 538.06, 0.01);

console.log('\n\x1b[1mpressure → inHg\x1b[0m');
eq('1013.25 hPa = 29.9213 inHg (standard atmosphere)', u.toInHg(1013.25, 'hPa'), 29.9213, 0.0005);
eq('mb behaves as hPa', u.toInHg(1013.25, 'mb'), u.toInHg(1013.25, 'hPa'));
eq('101325 Pa = same as 1013.25 hPa', u.toInHg(101325, 'Pa'), u.toInHg(1013.25, 'hPa'), 1e-9);
eq('inHg passes through', u.toInHg(30.12, 'inHg'), 30.12);

console.log('\n\x1b[1mspeed → mph\x1b[0m');
eq('1 m/s = 2.2369363 mph', u.toMph(1, 'm/s'), 2.2369363, 1e-6);
eq('1 km/h = 0.6213712 mph', u.toMph(1, 'km/h'), 0.62137119, 1e-7);
eq('1 knot = 1.1507794 mph', u.toMph(1, 'kn'), 1.15077945, 1e-7);
eq('mph passes through', u.toMph(15, 'mph'), 15);

console.log('\n\x1b[1mprecipitation → inches\x1b[0m');
eq('25.4 mm = 1 in exactly', u.toInches(25.4, 'mm'), 1);
eq('2.54 cm = 1 in exactly', u.toInches(2.54, 'cm'), 1);
eq('inches pass through', u.toInches(0.75, 'inch'), 0.75);

console.log('\n\x1b[1mtemperature → °F\x1b[0m');
eq('0°C = 32°F', u.toFahrenheit(0, '°C'), 32);
eq('100°C = 212°F', u.toFahrenheit(100, '°C'), 212);
eq('-40°C = -40°F (the crossover)', u.toFahrenheit(-40, 'celsius'), -40);
eq('37°C = 98.6°F', u.toFahrenheit(37, 'degC'), 98.6, 1e-9);
eq('°F passes through', u.toFahrenheit(72.5, '°F'), 72.5);

console.log('\n\x1b[1mNWS unitCode strings\x1b[0m');
eq('wmoUnit:degC', u.toFahrenheit(20, 'wmoUnit:degC'), 68);
eq('wmoUnit:m_s-1', u.toMph(10, 'wmoUnit:m_s-1'), 22.369363, 1e-5);
eq('wmoUnit:km_h-1', u.toMph(100, 'wmoUnit:km_h-1'), 62.137119, 1e-5);
eq('wmoUnit:m for visibility', u.toMiles(16093.44, 'wmoUnit:m'), 10, 1e-6);
eq('wmoUnit:Pa', u.toInHg(101325, 'wmoUnit:Pa'), 29.9213, 0.0005);

console.log('\n\x1b[1mrefuses rather than guesses\x1b[0m');
ok('null unit is rejected', u.toMiles(100, null) === null);
ok('unknown unit is rejected', u.toMiles(100, 'furlongs') === null);
ok('unknown temperature scale is rejected', u.toFahrenheit(20, 'kelvin') === null);
ok('non-numeric value returns null', u.toMiles('abc', 'm') === null);
ok('NaN returns null', u.toMiles(NaN, 'm') === null);
ok('undefined returns null', u.toFeet(undefined, 'm') === null);
ok('every rejection is recorded for the diagnostics panel', u.UNIT_WARNINGS.length > 0,
   JSON.stringify(u.UNIT_WARNINGS.slice(0, 2)));

console.log('\n\x1b[1mthe visibility ambiguity this exists to solve\x1b[0m');
/* The same number means very different things; the API must be believed. */
const asM = u.toMiles(24140, 'm'), asFt = u.toMiles(24140, 'ft');
ok('24140 m reads as 15.0 mi', near(asM, 15.0, 0.05), `${asM}`);
ok('24140 ft reads as 4.6 mi', near(asFt, 4.57, 0.05), `${asFt}`);
ok('the two differ by the 3.28x that a wrong assumption would cost',
   near(asM / asFt, 3.28084, 0.001), `${asM / asFt}`);

console.log('\n\x1b[1munitOf reads the API\'s own declaration\x1b[0m');
const payload = { hourly_units: { visibility: 'ft', temperature_2m: '°F' },
                  current_units: { pressure_msl: 'hPa' } };
ok('finds an hourly unit', u.unitOf(payload, 'hourly', 'visibility') === 'ft');
ok('finds a current unit', u.unitOf(payload, 'current', 'pressure_msl') === 'hPa');
ok('missing block returns null', u.unitOf(payload, 'daily', 'x') === null);
ok('missing key returns null', u.unitOf(payload, 'hourly', 'nope') === null);
ok('missing payload returns null', u.unitOf(null, 'hourly', 'visibility') === null);

console.log('\n\x1b[1mround trips\x1b[0m');
for (const [v, from] of [[1234, 'm'], [42, 'km'], [98765, 'ft']]) {
  const mi = u.toMiles(v, from), ft = u.toFeet(v, from);
  eq(`${v} ${from}: miles and feet agree`, mi * 5280, ft, Math.abs(ft) * 1e-9);
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);
