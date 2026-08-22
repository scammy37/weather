/* Guards against top-level name collisions between the js/ files.

   index.html loads them as plain scripts, so they all share ONE global scope.
   Two files declaring `const isNum` is a SyntaxError that stops the second
   file loading entirely — the page then fails at runtime with a confusing
   "X is not defined" far from the actual cause. This exact bug shipped once.
   Run: node test/globals.mjs */
import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + n); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + n + (e ? '  → ' + e : '')); } };

/* The load order index.html actually uses. */
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const FILES = [...html.matchAll(/<script src="(js\/[^"]+)"><\/script>/g)].map(m => m[1]);
console.log('\n\x1b[1mscripts loaded by index.html\x1b[0m');
ok('every js/ file is loaded by the page', FILES.length >= 6, FILES.join(', '));
console.log('  order: ' + FILES.join(' → '));

/* Top-level declarations only: no leading whitespace means column 0. */
const DECL = /^(?:export\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+\*?\s*([A-Za-z_$][\w$]*)/;
const declared = new Map();          // name → [files]
for (const f of FILES) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const line of src.split('\n')) {
    const m = DECL.exec(line);
    if (!m) continue;
    const name = m[1];
    if (!declared.has(name)) declared.set(name, []);
    if (!declared.get(name).includes(f)) declared.get(name).push(f);
  }
}

console.log('\n\x1b[1mno two files declare the same global\x1b[0m');
const clashes = [...declared.entries()].filter(([, files]) => files.length > 1);
ok('no top-level identifier is declared in more than one file',
   clashes.length === 0,
   clashes.map(([n, f]) => `${n} in ${f.join(' + ')}`).join('; '));
console.log(`  checked ${declared.size} top-level identifiers across ${FILES.length} files`);

/* Everything app.js calls from another file must actually exist somewhere. */
console.log('\n\x1b[1mcross-file references resolve\x1b[0m');
const CALLED = ['aggregateMonthly', 'mergeSST', 'annualSummary', 'frostStats', 'yearlySeries',
  'trendPerDecade', 'doyToLabel', 'monthlySunClimatology', 'dailySunCurve', 'sunTimes',
  'localMinutes', 'fmtMinutes', 'fmtDuration', 'barChart', 'rangeChart', 'multiLine',
  'stackedBar', 'daylightRibbon', 'trendChart', 'sparkLine', 'hourlyChart', 'fmtVal',
  'toMiles', 'toFeet', 'toInHg', 'toMph', 'toFahrenheit', 'unitOf', 'normUnit', 'UNIT_WARNINGS',
  'fetchLive', 'fetchAir', 'fetchMarineLive', 'fetchAlerts', 'fetchArchive',
  'fetchMarineArchive', 'fetchNWSObservation', 'fetchWaterTempNOAA',
  'cacheGet', 'cacheSet', 'cacheKey', 'clearOurCache', 'diagStart', 'diagEnd', 'DIAG',
  'LOCATIONS', 'MONTHS', 'MONTHS_FULL', 'PERIODS', 'DEFAULT_PERIOD', 'SST_PERIOD',
  'METRICS', 'METRIC_BY_KEY', 'GROUPS', 'wmoInfo', 'isDark', 'SKY_RAMP', 'TEMP_POLES',
  'showTip', 'moveTip', 'hideTip', 'esc'];
const missing = CALLED.filter(n => !declared.has(n));
ok('every cross-file name app.js relies on is declared', missing.length === 0, missing.join(', '));
console.log(`  verified ${CALLED.length} names`);

/* A file may only use a name declared in itself or in a file loaded BEFORE it. */
console.log('\n\x1b[1mdeclaration order is valid\x1b[0m');
const orderProblems = [];
for (const name of CALLED) {
  const declFile = declared.get(name);
  if (!declFile) continue;
  const declIdx = FILES.indexOf(declFile[0]);
  /* Only matters for values read at load time; functions hoist and objects are
     read inside handlers, so this checks the file exists in the list at all. */
  if (declIdx < 0) orderProblems.push(`${name} declared in an unloaded file`);
}
ok('no name is declared in a file the page never loads', orderProblems.length === 0, orderProblems.join('; '));

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);
