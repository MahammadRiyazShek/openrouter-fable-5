import { parseInfo, normalizeFences, filesFromMarkdown, collectFiles, pickEntry, stitchPreview } from './render.js';
import { buildParts, looksTextual } from './ingest.js';

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`FAIL ${label}\n  got  ${g}\n  want ${w}`); }
};
const ok = (label, cond, extra='') => { if (cond) pass++; else { fail++; console.log(`FAIL ${label} ${extra}`); } };

/* ---------- fence info ---------- */
eq('info: lang + path',      parseInfo('js src/app.js'),        { lang: 'js', hl: 'javascript', path: 'src/app.js' });
eq('info: html + path',      parseInfo('html index.html'),      { lang: 'html', hl: 'xml', path: 'index.html' });
eq('info: lang only',        parseInfo('python'),               { lang: 'python', hl: 'python', path: '' });
eq('info: path only',        parseInfo('src/deep/mod.ts'),      { lang: 'ts', hl: 'typescript', path: 'src/deep/mod.ts' });
eq('info: colon form',       parseInfo('js:src/app.js'),        { lang: 'js', hl: 'javascript', path: 'src/app.js' });
eq('info: title= form',      parseInfo('jsx title="App.jsx"'),  { lang: 'jsx', hl: 'javascript', path: 'App.jsx' });
eq('info: path= form',       parseInfo('python path=main.py'),  { lang: 'python', hl: 'python', path: 'main.py' });
eq('info: bare Dockerfile',  parseInfo('Dockerfile'),           { lang: 'dockerfile', hl: 'dockerfile', path: 'Dockerfile' });
eq('info: empty',            parseInfo(''),                     { lang: '', hl: '', path: '' });
eq('info: leading ./',       parseInfo('css ./styles/main.css'), { lang: 'css', hl: 'css', path: 'styles/main.css' });
eq('info: bash no path',     parseInfo('bash'),                 { lang: 'bash', hl: 'bash', path: '' });

/* ---------- label promotion ---------- */
const labelled = ['Here you go.', '', '**index.html**', '```html', '<h1>hi</h1>', '```'].join('\n');
ok('promote **bold** label', /```html index\.html/.test(normalizeFences(labelled)), normalizeFences(labelled));
const heading = ['### src/main.py', '```python', 'print(1)', '```'].join('\n');
ok('promote heading label', /```python src\/main\.py/.test(normalizeFences(heading)));
const prose = ['Some prose about things.', '```python', 'print(1)', '```'].join('\n');
ok('no false promotion', !/```python \S/.test(normalizeFences(prose)), normalizeFences(prose));

/* ---------- files out of one message ---------- */
const reply = [
  'Two files:', '',
  '```js src/app.js',
  'export const a = 1;',
  '```',
  '',
  '```css styles.css',
  'body { color: red }',
  '```',
  '',
  'And a shell snippet with no path:',
  '```bash',
  'npm i',
  '```',
].join('\n');
const got = filesFromMarkdown(reply);
eq('files: count + paths', got.map(f => f.path), ['src/app.js', 'styles.css']);
eq('files: body kept',     got[0].code, 'export const a = 1;');

/* nested fences inside a 4-backtick wrapper must not split */
const wrapped = ['````md README.md', '# Title', '```js', 'let x = 1;', '```', 'done', '````'].join('\n');
const w = filesFromMarkdown(wrapped);
eq('files: 4-tick wrapper', w.map(f => f.path), ['README.md']);
ok('files: inner fence intact', w[0].code.includes('```js') && w[0].code.includes('done'), JSON.stringify(w[0]?.code));

/* unterminated stream */
const cut = ['```py app.py', 'x = 1', 'y = 2'].join('\n');
eq('files: partial fence', filesFromMarkdown(cut).map(f => [f.path, f.partial]), [['app.py', true]]);

/* ---------- across a whole chat ---------- */
const chat = [
  { role: 'user', content: 'build it' },
  { role: 'assistant', content: '```js a.js\nv1\n```\n```js b.js\nkeep\n```' },
  { role: 'user', content: 'fix a' },
  { role: 'assistant', content: '```js a.js\nv2\n```' },
];
const folded = collectFiles(chat);
eq('collect: unique paths', folded.map(f => f.path).sort(), ['a.js', 'b.js']);
eq('collect: latest wins',  folded.find(f => f.path === 'a.js').code, 'v2');
eq('collect: revision no',  folded.find(f => f.path === 'a.js').revision, 2);

/* ---------- preview stitching ---------- */
const files = [
  { path: 'index.html', code: '<html><head><link rel="stylesheet" href="styles.css"></head><body><div id=r></div><script src="app.js"></script></body></html>' },
  { path: 'styles.css', code: 'body{margin:0}' },
  { path: 'app.js', code: 'console.log("hi")' },
];
const entry = pickEntry(files);
eq('preview: entry', entry.path, 'index.html');
const stitched = stitchPreview(entry, files);
ok('preview: css inlined', stitched.includes('<style>') && stitched.includes('body{margin:0}'), stitched);
ok('preview: js inlined',  stitched.includes('console.log("hi")'), stitched);
ok('preview: no leftover refs', !/href="styles\.css"/.test(stitched) && !/src="app\.js"/.test(stitched));
const nested = [
  { path: 'site/index.html', code: '<link rel=stylesheet href="main.css"><script src="./main.js"></script>' },
  { path: 'site/main.css', code: '.a{}' },
  { path: 'site/main.js', code: 'let z=1' },
];
const st2 = stitchPreview(pickEntry(nested), nested);
ok('preview: nested dir resolve', st2.includes('.a{}') && st2.includes('let z=1'), st2);
ok('preview: cdn left alone', stitchPreview({ path:'i.html', code:'<script src="https://cdn.x/y.js"></script>'}, []).includes('https://cdn.x/y.js'));

/* ---------- message assembly ---------- */
const txt = { id:'1', name:'notes.txt', kind:'text', text:'hello world', chars:11, bytes:11 };
const img = { id:'2', name:'shot.png', kind:'image', dataUrl:'data:image/png;base64,AAA', bytes:3 };
const zip = { id:'3', name:'proj.zip', kind:'archive', manifest:'Archive: proj.zip', bytes:9,
              children:[{path:'src/a.js', text:'let a', chars:5, bytes:5}, {path:'README.md', text:'# hi', chars:4, bytes:4}] };
const pdf = { id:'4', name:'spec.pdf', kind:'pdf-native', dataUrl:'data:application/pdf;base64,BBB', bytes:5 };

let b = buildParts('do the thing', [txt, img, zip], { vision: true });
eq('parts: shape', b.parts.map(p => p.type), ['text', 'image_url', 'text']);
ok('parts: file wrapper', b.parts[0].text.includes('<file path="notes.txt">') && b.parts[0].text.includes('hello world'));
ok('parts: zip manifest',  b.parts[0].text.includes('<archive name="proj.zip">'));
ok('parts: zip children',  b.parts[0].text.includes('<file path="proj.zip/src/a.js">'));
eq('parts: question last', b.parts.at(-1).text, 'do the thing');

b = buildParts('look', [img], { vision: false });
eq('parts: no-vision fallback', b.parts.map(p => p.type), ['text', 'text']);
ok('parts: no-vision note', b.parts[0].text.includes('no vision input'));

b = buildParts('read this', [pdf], { vision: true });
eq('parts: pdf native', b.parts.map(p => p.type), ['file', 'text']);
eq('parts: pdf plugin', b.plugins, [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }]);

b = buildParts('', [], { vision: true });
eq('parts: empty guard', b.parts, [{ type: 'text', text: '(no message)' }]);

/* ---------- text sniffing ---------- */
ok('text: .py',        looksTextual('main.py'));
ok('text: Dockerfile', looksTextual('Dockerfile'));
ok('text: .gitignore', looksTextual('.gitignore'));
ok('text: not .png',   !looksTextual('a.png'));
ok('text: not .woff2', !looksTextual('font.woff2'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
