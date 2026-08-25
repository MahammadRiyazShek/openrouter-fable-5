/* ============================================================
   ingest-test.mjs — the zip path, without a network
   ============================================================
   JSZip is loaded from a CDN at runtime, so `lib('jszip')` is
   satisfied here by planting a stand-in on `window` before
   ingest.js is imported. The stand-in copies the one behaviour
   that actually matters: JSZip returns each entry as a
   Uint8Array *view onto a shared buffer*, not a standalone
   buffer. Decoding `view.buffer` instead of the view reads the
   neighbouring entries too, trips the NUL-byte binary sniff,
   and silently drops every text file in the archive. That was a
   real bug; this is the test that keeps it dead.
   ============================================================ */

import './shim.mjs';

const HELLO = 'hello from the archive\n';
const CODE = 'export const answer = 42;\n';
const PNG = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];

/* One buffer, three entries laid end to end — the shared-buffer shape. */
const enc = new TextEncoder();
const pieces = [
  ['demo/README.md', enc.encode(HELLO)],
  ['demo/src/index.js', enc.encode(CODE)],
  ['demo/logo.png', new Uint8Array(PNG)],
  ['demo/node_modules/dep/index.js', enc.encode('module.exports = 1;\n')],
  ['demo/bundle.min.js', enc.encode('!function(){}();\n')],
];
const total = pieces.reduce((n, [, b]) => n + b.length, 0);
const shared = new ArrayBuffer(total);
const flat = new Uint8Array(shared);
const entries = [];
let at = 0;
for (const [path, bytes] of pieces) {
  flat.set(bytes, at);
  entries.push({ path, view: new Uint8Array(shared, at, bytes.length) });
  at += bytes.length;
}

globalThis.window.JSZip = {
  async loadAsync() {
    return {
      forEach(cb) {
        for (const e of entries) {
          cb(e.path, {
            dir: false,
            _data: { uncompressedSize: e.view.byteLength },
            async: async () => e.view,
          });
        }
      },
    };
  },
};

const { ingest, buildParts, looksTextual } = await import('../js/ingest.js');

const fakeFile = (name, type, bytes) => ({
  name, type, size: bytes,
  arrayBuffer: async () => shared,
});

let pass = 0;
const fails = [];
const is = (label, got, want) => {
  if (got === want) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
};
const ok = (label, cond, detail = '') => {
  if (cond) pass++;
  else fails.push(`${label}${detail ? ` — ${detail}` : ''}`);
};

/* ---------- the archive ---------- */

const [att] = await ingest([fakeFile('demo.zip', 'application/zip', total)], { pdfMode: 'local' });

is('kind is archive', att.kind, 'archive');
is('no error', att.error, '');

const kids = att.children || [];
const byPath = new Map(kids.map((c) => [c.path, c]));

is('two text files kept', kids.length, 2);
ok('README kept', byPath.has('demo/README.md'));
ok('source kept', byPath.has('demo/src/index.js'));
ok('png skipped', !byPath.has('demo/logo.png'));
ok('node_modules skipped', !byPath.has('demo/node_modules/dep/index.js'));
ok('minified file skipped', !byPath.has('demo/bundle.min.js'));

/* The regression itself: text decoded from an offset view must be exactly the
   entry, not the entry plus whatever bytes happen to follow it. */
is('README decodes exactly', byPath.get('demo/README.md')?.text, HELLO);
is('source decodes exactly', byPath.get('demo/src/index.js')?.text, CODE);
ok('no bleed from the next entry', !byPath.get('demo/README.md')?.text.includes('answer'));

/* ---------- the manifest ---------- */

ok('manifest names the archive', att.manifest.includes('demo.zip'));
ok('manifest counts every entry', att.manifest.includes(`${pieces.length} entries`));
ok('manifest lists the skipped png', att.manifest.includes('demo/logo.png'));
ok('manifest explains omissions', /Not included/.test(att.manifest));
ok('char count includes children', att.chars > att.manifest.length);

/* ---------- what the model actually receives ---------- */

const { parts } = buildParts('what does this do?', [att], { vision: true });
const blob = parts.map((p) => p.text || '').join('\n');

ok('archive block present', blob.includes('<archive name="demo.zip">'));
ok('file block is path-qualified', blob.includes('<file path="demo.zip/demo/README.md">'));
ok('file contents inlined', blob.includes(HELLO.trim()));
is('question comes last', parts.at(-1).text, 'what does this do?');

/* ---------- the textual sniff itself ---------- */

ok('.md is textual', looksTextual('a/b/notes.md'));
ok('Dockerfile is textual', looksTextual('Dockerfile'));
ok('.png is not', !looksTextual('logo.png'));
ok('unknown extension is not', !looksTextual('thing.bin'));

/* ---------- report ---------- */

console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  FAIL  ${f}`);
  process.exitCode = 1;
}
