/* =============================================================================
   Stamp a content hash onto the script URLs.

   GitHub Pages serves js/app.js with Cache-Control: max-age=600, and the URL
   never changes, so a browser that fetched it ten minutes ago keeps using it.
   The service worker does not save us either: its "network-first" fetch goes
   through the browser's HTTP cache by default, so it can be answered without
   the network ever being touched. Between them, a deploy could land and the
   page could keep running the previous code — which is exactly what happened.

   The fix is a URL that changes when the code changes: js/app.js?v=<hash>. No
   build step, no bundler; this script rewrites the tags and the service
   worker's cache name, and test/globals.mjs fails if it has not been re-run
   after a change. Forgetting is therefore a red build rather than a user
   staring at a stale page.

   Run: node scripts/stamp-assets.mjs [--check]
   =========================================================================== */
import fs from 'fs'; import path from 'path'; import crypto from 'crypto';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const INDEX = path.join(ROOT, 'index.html');
const SW = path.join(ROOT, 'sw.js');

/* The hash covers every script the page loads plus index.html's own markup and
   inline CSS, because a stylesheet change is just as invisible behind a stale
   cache as a script change. index.html is hashed with any existing ?v= values
   stripped, or the hash would depend on itself. */
export function assetVersion() {
  const h = crypto.createHash('sha256');
  const html = fs.readFileSync(INDEX, 'utf8').replace(/(<script src="js\/[^"?]+)\?v=[^"]*"/g, '$1"');
  h.update(html);
  for (const f of fs.readdirSync(path.join(ROOT, 'js')).sort()) {
    if (f.endsWith('.js')) h.update(fs.readFileSync(path.join(ROOT, 'js', f)));
  }
  return h.digest('hex').slice(0, 10);
}

const v = assetVersion();
let html = fs.readFileSync(INDEX, 'utf8');
let sw = fs.readFileSync(SW, 'utf8');

const stampedHtml = html.replace(/<script src="(js\/[^"?]+)(\?v=[^"]*)?"><\/script>/g,
  (_, src) => `<script src="${src}?v=${v}"></script>`);
/* The cache name carries the hash too, so a deploy retires the old cache
   instead of leaving a stale copy to be served when the network is away. */
const stampedSw = sw.replace(/const CACHE = '[^']*';/, `const CACHE = 'weather-${v}';`)
  .replace(/'\.\/js\/([a-z-]+\.js)(\?v=[^']*)?'/g, (_, f) => `'./js/${f}?v=${v}'`);

if (CHECK) {
  const stale = [];
  if (stampedHtml !== html) stale.push('index.html');
  if (stampedSw !== sw) stale.push('sw.js');
  if (stale.length) {
    console.error(`\n\x1b[31mAsset stamps are out of date in ${stale.join(' and ')}.\x1b[0m`);
    console.error(`Expected version ${v}. Run: node scripts/stamp-assets.mjs\n`);
    process.exit(1);
  }
  console.log(`asset stamp ${v} is current`);
} else {
  fs.writeFileSync(INDEX, stampedHtml);
  fs.writeFileSync(SW, stampedSw);
  console.log(`stamped assets with ${v}`);
}
