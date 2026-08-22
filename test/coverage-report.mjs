/* Which app functions did NO test suite ever execute?

   Each suite's pass count says how much of what it looked at worked. It says
   nothing about what it never looked at. This unions the V8 coverage from the
   crawl and the e2e suite and names the functions neither one entered — the
   places where a defect could sit indefinitely without any test going red.

   Run: node test/crawl.mjs --fast --coverage && node test/e2e.mjs --coverage
        node test/coverage-report.mjs
   =========================================================================== */
import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'test', 'shots');

const dumps = ['coverage-crawl.json', 'coverage-e2e.json']
  .map(f => path.join(SHOTS, f))
  .filter(f => fs.existsSync(f));

/* The browser suites are only half the story: units.mjs and unit.mjs require
   the same files into node and exercise the pure functions there. Counting
   only the browser would report those as untested, and a report that cries
   wolf gets ignored — which is worse than no report. NODE_V8_COVERAGE dumps
   the node side in the same V8 format. */
const NODECOV = path.join(SHOTS, 'nodecov');
const nodeDumps = fs.existsSync(NODECOV)
  ? fs.readdirSync(NODECOV).filter(f => f.endsWith('.json')).map(f => path.join(NODECOV, f))
  : [];

if (!dumps.length && !nodeDumps.length) {
  console.log('\nNo coverage dumps found. Run test/run-coverage.sh first.\n');
  process.exit(0);
}
console.log(`\n\x1b[1mUnion coverage\x1b[0m  ${dumps.length} browser dump(s) + ${nodeDumps.length} node dump(s)`);

/* file -> one range LIST PER PAGE. Keeping the pages separate matters: V8
   emits a count-0 range for a function a given page never called, and merging
   every page's ranges into one pile then picking the smallest match will
   happily return a count-0 range from an unrelated page. That made this report
   claim functions were untested when e2e demonstrably exercises them. A
   function counts as executed if ANY page executed it. */
const byFile = new Map();
const absorb = entries => {
  for (const e of entries) {
    const url = e.url || '';
    const file = url.split('/').pop().split('?')[0];
    if (!/\.js$/.test(file)) continue;
    /* node dumps cover every module it loaded, including the tests themselves
       and node internals — only the app's own files are of interest. */
    if (url.startsWith('file://') && !/\/js\/[^/]+\.js$/.test(url)) continue;
    if (!byFile.has(file)) byFile.set(file, []);
    const ranges = [];
    for (const f of (e.functions || [])) for (const r of f.ranges) ranges.push(r);
    if (ranges.length) byFile.get(file).push(ranges);
  }
};
for (const d of dumps) absorb(JSON.parse(fs.readFileSync(d, 'utf8')));
for (const d of nodeDumps) absorb(JSON.parse(fs.readFileSync(d, 'utf8')).result || []);

const FN = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
let total = 0, cold = 0;
for (const file of ['config.js', 'units.js', 'solar.js', 'api.js', 'climate.js', 'charts.js', 'app.js']) {
  const src = fs.readFileSync(path.join(ROOT, 'js', file), 'utf8');
  const pages = byFile.get(file) || [];
  /* Within ONE page, an offset is executed if the smallest range containing it
     ran. V8 nests ranges: an outer count of 1 with an inner count of 0 means
     parsed but not entered, so the innermost match is the honest answer. */
  const executedOn = (ranges, off) => {
    let best = null;
    for (const r of ranges) {
      if (off >= r.startOffset && off < r.endOffset &&
          (!best || (r.endOffset - r.startOffset) < (best.endOffset - best.startOffset))) best = r;
    }
    return best ? best.count > 0 : false;
  };
  const names = [];
  let m; FN.lastIndex = 0;
  while ((m = FN.exec(src))) {
    total++;
    const bodyAt = src.indexOf('{', m.index + m[0].length - 1);
    if (bodyAt < 0) continue;
    if (!pages.some(r => executedOn(r, bodyAt + 1))) { names.push(m[1]); cold++; }
  }
  if (!pages.length) console.log(`  \x1b[31m${file}\x1b[0m  no coverage recorded at all`);
  else if (names.length) console.log(`  \x1b[33m${file}\x1b[0m  ${names.length} never executed: ${names.join(', ')}`);
  else console.log(`  \x1b[32m${file}\x1b[0m  every declared function executed`);
}
console.log(`\n  \x1b[1m${total - cold}/${total}\x1b[0m declared functions executed by the test suite`);
if (cold) {
  console.log('\n  \x1b[31mUntested code is not necessarily broken — but nothing would tell us if it were.\x1b[0m');
  console.log('  Add a test that runs each function above, or delete it if it is dead.');
  console.log();
  /* A printout nobody is obliged to read is not a check. Failing here is what
     stops the number sliding back down one convenient exception at a time. */
  process.exit(1);
}
console.log();
