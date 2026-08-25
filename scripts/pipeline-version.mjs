/* =============================================================================
   A fingerprint of the code that produces data/climate.json.

   The dashboard has two halves that ship on different clocks. The page deploys
   in about a minute; the numbers are rebuilt by a workflow that takes the best
   part of an hour and is not run on every push. So there is a window — often a
   long one — where the code is fixed and the published figures are still the
   ones the old code produced.

   That window is where two of today's confusions lived: the snowfall was
   repaired in code while the site still showed blanks, and before that the
   layout was correct while the browser was still running the previous build.
   In both cases every test passed and the site was still wrong, because
   nothing compared the two halves.

   This stamps the built data with a hash of the code that built it. If the
   hash no longer matches, the data predates the current pipeline and must not
   be described as correct, however green the tests are.

   Only files that can change the NUMBERS are included. A stylesheet or a chart
   colour cannot, and listing them would cry stale on every unrelated commit —
   which would train everyone to ignore it.
   =========================================================================== */
import fs from 'fs'; import path from 'path'; import crypto from 'crypto';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PIPELINE_FILES = [
  'js/config.js',                  // which places, which periods, which coordinates
  'js/api.js',                     // which model, what counts as adequate coverage
  'js/climate.js',                 // every threshold and every aggregate
  'js/solar.js',                   // the sun climatology merged into the rows
  'scripts/build-climate.mjs',     // how the above are assembled
  'scripts/stations.mjs'           // which observations override the model
];

/* Deliberately absent: js/radar.js, js/charts.js, js/units.js, js/app.js and
   index.html. None of them can move a number, and js/radar.js exists as a
   separate file largely so that radar work stops landing in config.js and
   api.js, where it used to trip this check on every change. */

/* Hash of an explicit set of files, hex, first 12 chars. The building block
   under pipelineVersion(); exported so validation.json can fingerprint the
   inputs that determine IT — which are not the same as the ones that determine
   the climate numbers. */
export function fingerprintOf(relFiles) {
  const h = crypto.createHash('sha256');
  for (const rel of relFiles) {
    const p = path.join(ROOT, rel);
    h.update(rel);
    h.update(fs.existsSync(p) ? fs.readFileSync(p) : Buffer.from('<missing>'));
  }
  return h.digest('hex').slice(0, 12);
}

/* The files that decide the NOAA-vs-model bias report. Coordinate drift in
   config.js and a changed station list or comparison method both belong here,
   so a validation.json measured against a superseded setup is detectable. */
export const VALIDATION_FILES = ['scripts/validate-climate.mjs', 'js/config.js'];
export const validationVersion = () => fingerprintOf(VALIDATION_FILES);

export function pipelineVersion() {
  const h = crypto.createHash('sha256');
  for (const rel of PIPELINE_FILES) {
    const p = path.join(ROOT, rel);
    h.update(rel);
    h.update(fs.existsSync(p) ? fs.readFileSync(p) : Buffer.from('<missing>'));
  }
  return h.digest('hex').slice(0, 12);
}

/* Returns null when the data is current, or a sentence explaining why not.
   A sentence rather than a boolean because every caller wants to say the same
   thing and none of them should have to word it. */
export function stalenessOf(snapshot) {
  const want = pipelineVersion();
  if (!snapshot || typeof snapshot !== 'object') return 'there is no snapshot to check';
  const got = snapshot.pipeline;
  if (!got) return `built before this check existed — no pipeline stamp (current is ${want})`;
  if (got !== want) {
    return `built by pipeline ${got}, but the code is now ${want} — `
         + 'the published numbers predate the current code. Run the "Rebuild climate '
         + 'normals" workflow, and do not describe the figures as correct until it lands.';
  }
  return null;
}

/* Run directly for a one-line answer. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const p = path.join(ROOT, 'data', 'climate.json');
  if (process.argv.includes('--stamp')) {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    j.pipeline = pipelineVersion();
    fs.writeFileSync(p, JSON.stringify(j));
    console.log(`stamped data/climate.json with pipeline ${j.pipeline}`);
  } else {
    const j = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
    const why = stalenessOf(j);
    console.log(why ? `STALE: ${why}` : `data/climate.json is current (pipeline ${pipelineVersion()})`);
    process.exit(why ? 1 : 0);
  }
}
