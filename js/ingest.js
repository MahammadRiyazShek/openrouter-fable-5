/* ============================================================
   ingest.js — turn anything the user drops in into model input
   ============================================================
   zip  → walked with JSZip, text entries inlined, full tree listed
   pdf  → text via pdf.js, or handed to OpenRouter's file parser
   docx → raw text via mammoth
   xlsx → one CSV block per sheet via SheetJS
   img  → data URL sent as a vision part
   else → text if it reads as text, otherwise noted by name and size
   ============================================================ */

import { lib, LIMITS } from './config.js';
import { uid, estTokens } from './store.js';

/* ---------- what counts as text ---------- */

const TEXT_EXT = new Set(`
txt md markdown mdx rst adoc log diff patch csv tsv json jsonl ndjson yaml yml toml ini cfg conf env properties
js jsx mjs cjs ts tsx vue svelte astro html htm xhtml css scss sass less styl
py pyi rb rake go rs java kt kts swift m mm c h cc cpp cxx hpp hh cs php pl pm lua r jl dart scala clj cljs
ex exs erl hs elm nim zig sol vb fs fsx sql graphql gql proto
sh bash zsh fish bat ps1 psm1 cmake mk gradle tf tfvars hcl
svg xml plist xaml cshtml razor ejs hbs handlebars pug jinja jinja2 tpl tex bib
ipynb lock gitignore gitattributes editorconfig npmrc nvmrc prettierrc eslintrc babelrc dockerignore
srt vtt po pot resx sml asm s f90 f95 awk sed
`.trim().split(/\s+/));

const TEXT_NAMES = new Set([
  'dockerfile', 'makefile', 'rakefile', 'gemfile', 'procfile', 'brewfile', 'justfile',
  'license', 'licence', 'readme', 'changelog', 'notice', 'authors', 'contributing', 'codeowners',
  '.gitignore', '.gitattributes', '.env', '.editorconfig', '.npmrc', '.nvmrc', '.prettierrc',
  '.eslintrc', '.babelrc', '.dockerignore', '.gitmodules',
]);

/* ---------- what to skip inside archives ---------- */

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  '.output', '.cache', '.parcel-cache', '.turbo', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.venv', 'venv', 'env', 'site-packages', 'vendor', 'target', 'bin', 'obj', 'pods',
  '.idea', '.gradle', '.terraform', 'coverage', '.nyc_output', '__macosx', '.ds_store', 'bower_components',
]);

const SKIP_FILE_RX = /(\.min\.(js|css)|\.map|\.d\.ts\.map|-lock\.(json|yaml|yml)|\.lock|\.snap)$/i;

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/i;

/* ---------- small utilities ---------- */

function ext(name) {
  const base = name.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function baseName(name) {
  return (name.split('/').pop() || name).toLowerCase();
}

export function looksTextual(name, mime = '') {
  if (mime.startsWith('text/')) return true;
  if (/^application\/(json|xml|javascript|x-ndjson|x-sh|x-yaml|toml|sql|graphql)/i.test(mime)) return true;
  const b = baseName(name);
  if (TEXT_NAMES.has(b)) return true;
  if (TEXT_NAMES.has(b.replace(/\..*$/, ''))) return true;
  return TEXT_EXT.has(ext(name));
}

/** Cheap binary sniff: NUL bytes or a pile of unprintables means binary. */
function binarySniff(u8) {
  const n = Math.min(u8.length, 2048);
  let odd = 0;
  for (let i = 0; i < n; i++) {
    const c = u8[i];
    if (c === 0) return true;
    if (c < 9 || (c > 13 && c < 32)) odd++;
  }
  return n > 0 && odd / n > 0.12;
}

function decodeText(buf) {
  const u8 = new Uint8Array(buf);
  if (binarySniff(u8)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: false })
      .decode(u8)
      .replace(/^\uFEFF/, '')       // drop a byte-order mark
      .replace(/\r\n/g, '\n');      // normalise line endings
  } catch {
    return null;
  }
}

function clip(text, cap = LIMITS.charsPerFile) {
  if (text.length <= cap) return { text, truncated: false };
  return {
    text: `${text.slice(0, cap)}\n\n…[truncated — ${(text.length - cap).toLocaleString()} more characters not sent]`,
    truncated: true,
  };
}

const readBuffer = (file) => file.arrayBuffer();

function readDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('Could not read that file.'));
    fr.readAsDataURL(blob);
  });
}

/* ---------- format-specific extraction ---------- */

async function fromPdf(file) {
  const pdfjs = await lib('pdfjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await readBuffer(file)) }).promise;
  const pages = Math.min(doc.numPages, LIMITS.pdfPages);
  const out = [];
  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();

    /* Rebuild lines from positioned text runs so tables stay legible. */
    let line = '';
    let lastY = null;
    const lines = [];
    for (const item of content.items) {
      const y = Math.round(item.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 2) { lines.push(line.trimEnd()); line = ''; }
      line += item.str + (item.hasEOL ? '' : ' ');
      lastY = y;
    }
    if (line.trim()) lines.push(line.trimEnd());
    out.push(`--- page ${p} ---\n${lines.join('\n').replace(/[ \t]+\n/g, '\n')}`);
    page.cleanup?.();
  }
  const tail = doc.numPages > pages ? `\n\n…[${doc.numPages - pages} further pages not read]` : '';
  const text = out.join('\n\n') + tail;
  const noText = text.replace(/--- page \d+ ---/g, '').trim().length < 40;
  return {
    text,
    note: noText
      ? `${doc.numPages} pages, but almost no extractable text — likely a scan. Switch PDF handling to "send the PDF itself" in settings.`
      : `${doc.numPages} page${doc.numPages === 1 ? '' : 's'} of text extracted in the browser`,
  };
}

async function fromDocx(file) {
  const mammoth = await lib('mammoth');
  const { value } = await mammoth.extractRawText({ arrayBuffer: await readBuffer(file) });
  return { text: value || '', note: 'Word document, text extracted' };
}

async function fromSheet(file) {
  const XLSX = await lib('xlsx');
  const wb = XLSX.read(await readBuffer(file), { type: 'array' });
  const parts = wb.SheetNames.map((n) => {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false });
    return `--- sheet: ${n} ---\n${csv.trim()}`;
  });
  return {
    text: parts.join('\n\n'),
    note: `${wb.SheetNames.length} sheet${wb.SheetNames.length === 1 ? '' : 's'} converted to CSV`,
  };
}

async function fromZip(file, report) {
  const JSZip = await lib('jszip');
  const zip = await JSZip.loadAsync(await readBuffer(file));

  const all = [];
  zip.forEach((path, entry) => { if (!entry.dir) all.push({ path, entry }); });

  const keep = [];
  const skipped = [];
  for (const item of all) {
    const parts = item.path.split('/');
    const inSkipDir = parts.slice(0, -1).some((p) => SKIP_DIRS.has(p.toLowerCase()));
    const size = item.entry._data?.uncompressedSize ?? 0;
    if (inSkipDir || SKIP_FILE_RX.test(item.path) || baseName(item.path).startsWith('._')) {
      skipped.push({ path: item.path, size, why: 'ignored' });
    } else if (!looksTextual(item.path)) {
      skipped.push({ path: item.path, size, why: 'binary' });
    } else if (size > LIMITS.zipEntryBytes) {
      skipped.push({ path: item.path, size, why: 'too big' });
    } else {
      keep.push({ ...item, size });
    }
  }

  /* Shallow, small, source-looking files first — the useful ones. */
  const rank = (p) => {
    const depth = p.split('/').length;
    const b = baseName(p);
    let score = depth;
    if (/^(readme|package\.json|index\.|main\.|app\.|requirements\.txt|pyproject\.toml|cargo\.toml|go\.mod|dockerfile|makefile)/.test(b)) score -= 4;
    if (/\.(md|txt)$/.test(b)) score -= 1;
    return score;
  };
  keep.sort((a, b) => rank(a.path) - rank(b.path) || a.size - b.size);

  const children = [];
  let used = 0;
  let entriesRead = 0;
  for (const item of keep) {
    if (entriesRead >= LIMITS.zipEntries || used >= LIMITS.charsTotal) {
      skipped.push({ path: item.path, size: item.size, why: 'over the limit' });
      continue;
    }
    let raw;
    try {
      raw = await item.entry.async('uint8array');
    } catch {
      skipped.push({ path: item.path, size: item.size, why: 'unreadable' });
      continue;
    }
    const text = decodeText(raw.buffer);
    if (text == null) { skipped.push({ path: item.path, size: item.size, why: 'binary' }); continue; }
    const room = Math.max(2000, Math.min(LIMITS.charsPerFile, LIMITS.charsTotal - used));
    const cut = clip(text, room);
    children.push({ path: item.path, text: cut.text, chars: cut.text.length, bytes: item.size, truncated: cut.truncated });
    used += cut.text.length;
    entriesRead++;
    if (entriesRead % 12 === 0) report?.(`Reading ${item.path.split('/').pop()}…`);
  }

  const tree = all
    .slice(0, 1200)
    .map((i) => i.path)
    .sort()
    .join('\n');

  const manifest =
    `Archive: ${file.name} — ${all.length} entries, ${children.length} text files included.\n\n` +
    `Full listing:\n${tree}${all.length > 1200 ? `\n…and ${all.length - 1200} more` : ''}` +
    (skipped.length
      ? `\n\nNot included (${skipped.length}): ${[...new Set(skipped.map((s) => s.why))].join(', ')}. ` +
        `Binaries, build output, lockfiles and dependency folders are left out on purpose — ask for any of them by path and re-attach if needed.`
      : '');

  return {
    children,
    manifest,
    note: `${children.length} of ${all.length} files read`,
    entries: all.length,
  };
}

/* ---------- one dropped file ---------- */

async function ingestOne(file, opts, report) {
  const att = {
    id: uid(),
    name: file.name || 'untitled',
    mime: file.type || '',
    bytes: file.size,
    kind: 'text',
    text: '',
    dataUrl: '',
    manifest: '',
    children: null,
    chars: 0,
    note: '',
    error: '',
    truncated: false,
  };

  if (file.size > LIMITS.fileBytes) {
    att.kind = 'binary';
    att.error = `Too large to read here (${(file.size / 1048576).toFixed(1)} MB). The cap is ${LIMITS.fileBytes / 1048576} MB.`;
    return att;
  }

  const e = ext(file.name);
  const isZip = e === 'zip' || /zip|x-zip-compressed/i.test(file.type);

  try {
    if (IMAGE_MIME.test(file.type) || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'].includes(e)) {
      if (file.size > LIMITS.imageBytes) throw new Error('Image is over 12 MB — shrink it first.');
      att.kind = 'image';
      att.dataUrl = await readDataUrl(file);
      att.note = 'Sent as an image — needs a model with vision';
      return att;
    }

    if (isZip) {
      report?.('Unpacking archive…');
      const z = await fromZip(file, report);
      att.kind = 'archive';
      att.children = z.children;
      att.manifest = z.manifest;
      att.note = z.note;
      att.chars = z.manifest.length + z.children.reduce((n, c) => n + c.chars, 0);
      att.truncated = z.children.some((c) => c.truncated);
      return att;
    }

    if (e === 'pdf' || file.type === 'application/pdf') {
      if (opts.pdfMode === 'native') {
        att.kind = 'pdf-native';
        att.dataUrl = await readDataUrl(file);
        att.note = 'Sent to OpenRouter’s file parser';
        att.chars = 0;
        return att;
      }
      report?.('Reading PDF…');
      const r = await fromPdf(file);
      att.kind = 'pdf';
      const cut = clip(r.text);
      att.text = cut.text;
      att.truncated = cut.truncated;
      att.chars = cut.text.length;
      att.note = r.note;
      return att;
    }

    if (e === 'docx' || file.type.includes('wordprocessingml')) {
      report?.('Reading document…');
      const r = await fromDocx(file);
      att.kind = 'docx';
      const cut = clip(r.text);
      att.text = cut.text;
      att.truncated = cut.truncated;
      att.chars = cut.text.length;
      att.note = r.note;
      return att;
    }

    if (['xlsx', 'xls', 'xlsm', 'ods'].includes(e) || file.type.includes('spreadsheetml')) {
      report?.('Reading spreadsheet…');
      const r = await fromSheet(file);
      att.kind = 'sheet';
      const cut = clip(r.text);
      att.text = cut.text;
      att.truncated = cut.truncated;
      att.chars = cut.text.length;
      att.note = r.note;
      return att;
    }

    /* Everything else: read it and see. */
    const text = decodeText(await readBuffer(file));
    if (text == null) {
      att.kind = 'binary';
      att.note = 'Binary file — only its name, type and size were sent';
      return att;
    }
    const cut = clip(text);
    att.kind = 'text';
    att.text = cut.text;
    att.truncated = cut.truncated;
    att.chars = cut.text.length;
    att.note = att.truncated ? 'Text file, truncated to fit' : 'Text file';
    return att;
  } catch (err) {
    att.error = err.message || 'Could not read that file.';
    att.kind = 'binary';
    return att;
  }
}

/**
 * Ingest a FileList / array of File objects.
 * @param {Iterable<File>} files
 * @param {{pdfMode:string}} opts
 * @param {(att:object|null, msg:string)=>void} [onProgress]
 */
export async function ingest(files, opts, onProgress) {
  const out = [];
  for (const file of files) {
    onProgress?.(null, `Reading ${file.name}…`);
    const att = await ingestOne(file, opts, (msg) => onProgress?.(null, msg));
    out.push(att);
    onProgress?.(att, '');
  }
  return out;
}

/* ---------- attachment → API content parts ---------- */

export function attachmentTokens(att) {
  if (att.kind === 'image') return 800;                 // ballpark for a mid-size image
  if (att.kind === 'pdf-native') return Math.round(att.bytes / 900);
  return estTokens(att.chars || 0);
}

function fence(path, text) {
  return `<file path="${path}">\n${text}\n</file>`;
}

/**
 * Build the content array for one user message.
 * @returns {{parts:Array, plugins:Array, chars:number}}
 */
export function buildParts(text, attachments, { vision = true } = {}) {
  const blocks = [];
  const parts = [];
  let plugins = [];
  let budget = LIMITS.charsTotal;

  for (const att of attachments) {
    if (att.error && !att.text && !att.children) {
      blocks.push(`<file name="${att.name}" unread="${att.error}" />`);
      continue;
    }

    if (att.kind === 'image') {
      if (vision) parts.push({ type: 'image_url', image_url: { url: att.dataUrl } });
      else blocks.push(`<file name="${att.name}" note="image attached, but this model has no vision input" />`);
      continue;
    }

    if (att.kind === 'pdf-native') {
      parts.push({ type: 'file', file: { filename: att.name, file_data: att.dataUrl } });
      plugins = [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }];
      continue;
    }

    if (att.kind === 'archive') {
      blocks.push(`<archive name="${att.name}">\n${att.manifest}\n</archive>`);
      for (const child of att.children || []) {
        if (budget <= 0) break;
        const body = child.text.length > budget ? `${child.text.slice(0, budget)}\n…[truncated]` : child.text;
        blocks.push(fence(`${att.name}/${child.path}`, body));
        budget -= body.length;
      }
      continue;
    }

    if (att.kind === 'binary') {
      blocks.push(`<file name="${att.name}" type="${att.mime || 'unknown'}" size="${att.bytes}" note="binary, contents not sent" />`);
      continue;
    }

    if (att.text) {
      const body = att.text.length > budget ? `${att.text.slice(0, Math.max(0, budget))}\n…[truncated]` : att.text;
      blocks.push(fence(att.name, body));
      budget -= body.length;
    }
  }

  if (blocks.length) {
    parts.unshift({
      type: 'text',
      text: `The user attached these files. Use them as the source of truth for this request.\n\n${blocks.join('\n\n')}`,
    });
  }

  if (text.trim()) parts.push({ type: 'text', text: text.trim() });
  if (!parts.length) parts.push({ type: 'text', text: '(no message)' });

  const chars = parts.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 0), 0);
  return { parts, plugins, chars };
}
