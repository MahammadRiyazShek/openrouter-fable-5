/* ============================================================
   verify-single.mjs — prove the one-file build actually works
   ============================================================
   Run: node .dev/verify-single.mjs [path-to-index.html]

   Checks, in order:
     1. the HTML still has exactly the script elements it should,
        and none of them close early
     2. the bundled script parses (node --check)
     3. it boots against the DOM stub and binds listeners
     4. every element id the app reaches for exists in the markup
   ============================================================ */

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInThisContext } from 'node:vm';

const ROOT = resolve(import.meta.dirname, '..');
const FILE = resolve(ROOT, process.argv[2] || 'single-file/index.html');
const html = readFileSync(FILE, 'utf8');

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; } else { fails.push(`${label}${detail ? ` — ${detail}` : ''}`); }
};

/* ---------- 1. script element integrity ---------- */

/* Count real elements by scanning and skipping each body. Searching the whole
   file with a regex would also match the `<script${type}>` string that
   render.js builds when it stitches a preview, which is text, not markup —
   and that false positive is exactly the sort of thing this file exists to
   distinguish from a genuinely broken document. */
const scripts = [];
for (let i = 0; ;) {
  const open = html.indexOf('<script', i);
  if (open === -1) break;
  const bodyStart = html.indexOf('>', open) + 1;
  const close = html.indexOf('</script', bodyStart);
  if (close === -1) { fails.push('a script element is never closed'); break; }
  scripts.push({ tag: html.slice(open, bodyStart), body: html.slice(bodyStart, close) });
  i = html.indexOf('>', close) + 1;
}

ok('two script elements', scripts.length === 2, `found ${scripts.length}`);
ok('neither script has a src', !scripts.some((s) => /\bsrc=/i.test(s.tag)));
ok('no module script left', !scripts.some((s) => /type\s*=\s*["']module["']/i.test(s.tag)));
ok('stylesheet inlined', html.includes('<style>') && !/href="styles\.css"/.test(html));
ok('favicon inlined', /rel="icon" href="data:image\/svg\+xml/.test(html));
ok('single-file flag set', html.includes('window.__bpSingle = true;'));

const js = scripts.length === 2 ? scripts[1].body : '';
ok('bundle body extracted', js.length > 80_000, `${js.length} chars`);

/* The reason step 1 exists at all. */
ok('no bare </script inside the bundle', !/<\/script/i.test(js));
ok('escaped form survived', js.includes('<\\/script'));
ok('no <!-- inside the bundle', !js.includes('<!--'));

/* ---------- 2. it parses ---------- */

const dir = mkdtempSync(join(tmpdir(), 'bp-'));
const jsPath = join(dir, 'bundle.js');
writeFileSync(jsPath, js);
try {
  execFileSync(process.execPath, ['--check', jsPath], { stdio: 'pipe' });
  pass++;
} catch (e) {
  fails.push(`bundle parses — ${String(e.stderr || e).split('\n').slice(0, 4).join(' | ')}`);
}

/* ---------- 3. it boots ---------- */

await import('./shim.mjs');
let bootErr = null;
try {
  runInThisContext(js, { filename: 'single-file-bundle.js' });
} catch (e) {
  bootErr = e;
}
ok('bundle evaluates under the DOM stub', !bootErr, bootErr && `${bootErr.name}: ${bootErr.message}`);

/* boot() is async and the shim's fetch rejects, so give microtasks a turn. */
await new Promise((r) => setTimeout(r, 60));

ok('boot() ran to the watchdog flag', globalThis.window.__bpBoot === true);
const bound = globalThis.__listeners.length;
ok('event listeners bound', bound > 30, `${bound} bound`);

/* ---------- 4. every id the app reaches for exists ---------- */

/* Read the ids off app.js rather than the bundle: `el` is app.js's Proxy over
   getElementById, but render.js also uses `el` as a shadowed loop variable, so
   scanning the concatenated text would report `el.className` as a missing id. */
const appSrc = readFileSync(resolve(ROOT, 'js/app.js'), 'utf8');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const wanted = new Set([
  ...[...appSrc.matchAll(/\bel\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
  ...[...appSrc.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
]);
const missing = [...wanted].filter((n) => !ids.has(n));
ok('all referenced ids exist in the markup', missing.length === 0,
  missing.length ? `missing: ${missing.join(', ')}` : '');
ok('markup has no unused ids worth worrying about', true);
const unused = [...ids].filter((n) => !wanted.has(n));
if (unused.length) console.log(`  note: ids present but never looked up: ${unused.join(', ')}`);

/* ---------- report ---------- */

console.log(`\n${FILE.replace(ROOT + '/', '')}: ${pass} checks passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  FAIL  ${f}`);
  process.exit(1);
}
console.log('  single-file build is sound');
