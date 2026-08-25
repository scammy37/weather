/* Does the staleness check actually fire?

   This guards the one gap no other suite covers: code fixed, data not rebuilt.
   It is worth its own file because the failure it prevents is not a wrong
   number — it is me telling you something is ready when it is not.
   Run: node test/freshness.mjs
   =========================================================================== */
import fs from 'fs'; import path from 'path'; import os from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { pipelineVersion, stalenessOf, PIPELINE_FILES } from '../scripts/pipeline-version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + n); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + n + (e ? '  → ' + e : '')); } };

console.log('\n\x1b[1mwhat the fingerprint covers\x1b[0m');
ok('it covers the files that decide the numbers',
   ['js/config.js', 'js/climate.js', 'js/api.js', 'scripts/build-climate.mjs', 'scripts/stations.mjs']
     .every(f => PIPELINE_FILES.includes(f)), PIPELINE_FILES.join(', '));
/* Listing files that cannot change a number would cry stale on every unrelated
   commit, and a check that cries wolf is worse than no check. */
ok('and nothing that cannot',
   !PIPELINE_FILES.some(f => /charts\.js|units\.js|app\.js|index\.html/.test(f)),
   PIPELINE_FILES.join(', '));
ok('every listed file exists',
   PIPELINE_FILES.every(f => fs.existsSync(path.join(ROOT, f))),
   PIPELINE_FILES.filter(f => !fs.existsSync(path.join(ROOT, f))).join(', '));

console.log('\n\x1b[1mthe verdicts\x1b[0m');
const v = pipelineVersion();
ok('current data reads as current', stalenessOf({ pipeline: v }) === null);
ok('data with no stamp at all reads as stale',
   typeof stalenessOf({ generated: 'x' }) === 'string');
ok('data from a different build reads as stale',
   typeof stalenessOf({ pipeline: 'deadbeef0000' }) === 'string');
ok('a missing snapshot reads as stale rather than fine',
   typeof stalenessOf(null) === 'string');
const msg = stalenessOf({ pipeline: 'deadbeef0000' });
ok('the message says what to do about it', /Rebuild climate normals/.test(msg), msg);
ok('and warns against calling the figures correct meanwhile',
   /do not describe the figures as correct/.test(msg), msg);
ok('the fingerprint is stable across calls', pipelineVersion() === v);

console.log('\n\x1b[1mit fires when the pipeline really changes\x1b[0m');
/* The real scenario, reproduced: change a file that decides the numbers and
   confirm the committed data is called stale. Done on a copy of the tree so
   nothing here can damage the working one. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-'));
spawnSync('cp', ['-r', path.join(ROOT, 'js'), path.join(ROOT, 'scripts'),
                 path.join(ROOT, 'data'), tmp], { encoding: 'utf8' });
const run = (...args) => spawnSync(process.execPath,
  [path.join(tmp, 'scripts', 'pipeline-version.mjs'), ...args], { encoding: 'utf8' });

/* Stamp the copy rather than assuming the committed data happens to be fresh.
   It very often is not — a source change makes it stale immediately, which is
   the whole point of the check — and a test whose precondition depends on that
   fails for the right reason at the wrong time, which reads as a broken test
   rather than a working guard. */
run('--stamp');
ok('a freshly stamped tree reads as current', run().status === 0, run().stdout.trim());

const target = path.join(tmp, 'js', 'climate.js');
fs.appendFileSync(target, '\n/* a change to how a number is computed */\n');
const after = run();
ok('changing the aggregation marks the data stale', after.status === 1, after.stdout.trim());
ok('and says so in words a person can act on',
   /predate the current code/.test(after.stdout), after.stdout.trim());

/* A change that cannot affect a number must NOT trip it, or it becomes noise. */
fs.writeFileSync(target, fs.readFileSync(path.join(ROOT, 'js', 'climate.js')));
run('--stamp');
fs.appendFileSync(path.join(tmp, 'js', 'charts.js'), '\n/* a colour tweak */\n');
ok('a change that cannot move a number does not trip it', run().status === 0, run().stdout.trim());
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);
