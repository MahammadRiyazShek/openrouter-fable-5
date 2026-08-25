/* ============================================================
   config.js — constants, defaults, lazy library loader
   ============================================================ */

export const API = 'https://openrouter.ai/api/v1';

export const APP_TITLE = 'Blueprint';

/* Where state lives. Bump the version to invalidate old shapes. */
export const LS = {
  key: 'bp.key.v1',
  chats: 'bp.chats.v1',
  active: 'bp.active.v1',
  settings: 'bp.settings.v1',
  models: 'bp.models.v1',
};

/* The default model is resolved against the live model list at runtime.
   These patterns are tried in order, so "claude fable 5" wins if the
   account has it, and there's always a sane fallback if it doesn't. */
export const MODEL_PREFERENCE = [
  /fable/i,
  /^anthropic\/claude-(sonnet|opus)-4/i,
  /^anthropic\/claude-3\.7-sonnet/i,
  /^anthropic\//i,
];

export const FALLBACK_MODEL = { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' };

export const DEFAULT_SYSTEM = `You are a senior engineer working inside a browser-based workbench. The user attaches files (zips of codebases, PDFs, spreadsheets, images, source files) and asks you to analyse or build things.

When you write files, follow these rules exactly:
- One fenced code block per file. Never split a file across blocks.
- Put the language and then the full relative path on the fence's info line, like: \`\`\`js src/app.js
- Write the complete file contents, never "… rest unchanged …" or elided sections.
- Keep paths consistent between turns so revisions replace the earlier version of a file.

Prefer working, runnable code over explanation. State assumptions in one short paragraph before the files, and keep any closing notes brief. If a request is ambiguous, pick the most reasonable interpretation, say which one you picked in a single line, and build it.`;

export const DEFAULTS = {
  system: DEFAULT_SYSTEM,
  temperature: 0.7,
  maxTokens: null,
  historyDepth: 20,
  stream: true,
  showReasoning: false,
  pdfMode: 'local', // 'local' | 'native'
};

/* Ingestion limits — keeps a careless 400MB zip from locking up the tab. */
export const LIMITS = {
  fileBytes: 48 * 1024 * 1024,   // per uploaded file
  zipEntryBytes: 800 * 1024,     // per file inside a zip
  zipEntries: 400,               // text files pulled from one zip
  charsPerFile: 220_000,         // truncation point for one extracted file
  charsTotal: 900_000,           // truncation point for one message's attachments
  pdfPages: 120,
  imageBytes: 12 * 1024 * 1024,
};

/* Third-party libraries, loaded only when a feature actually needs them.

   Each entry lists mirrors in order. One CDN is not enough in practice:
   cdn.jsdelivr.net is blocked outright by several ISPs (India especially),
   and when that happens a single-CDN build fails silently — no zip reading,
   no PDF text, no syntax highlighting, and no clue why. So try jsDelivr,
   then unpkg, then cdnjs, and only give up when every mirror is unreachable. */
const CDN = {
  marked: [
    'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js',
    'https://unpkg.com/marked@12.0.2/marked.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js',
  ],
  purify: [
    'https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js',
    'https://unpkg.com/dompurify@3.1.6/dist/purify.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js',
  ],
  hljs: [
    'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.9.0/highlight.min.js',
    'https://unpkg.com/@highlightjs/cdn-assets@11.9.0/highlight.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js',
  ],
  jszip: [
    'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
    'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  ],
  pdfjs: [
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
    'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  ],
  pdfworker: [
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
    'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  ],
  mammoth: [
    'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js',
    'https://unpkg.com/mammoth@1.8.0/mammoth.browser.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js',
  ],
  xlsx: [
    'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
    'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  ],
};

/* Which mirror answered, for the diagnostics panel. */
export const cdnLog = [];

const pending = new Map();

function injectScript(src) {
  if (pending.has(src)) return pending.get(src);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve();
    s.onerror = () => { pending.delete(src); s.remove(); reject(new Error(`Could not load ${src}`)); };
    document.head.appendChild(s);
  });
  pending.set(src, p);
  return p;
}

/**
 * Try each mirror in turn until the library's global shows up.
 * @param {string[]} urls
 * @param {() => any} probe returns the global once it exists
 */
async function loadFrom(urls, probe, label) {
  const already = probe();
  if (already) return already;

  const tried = [];
  for (const url of urls) {
    try {
      await injectScript(url);
      const got = probe();
      if (got) {
        cdnLog.push({ label, url, ok: true });
        return got;
      }
      tried.push(`${new URL(url).host}: loaded but no global`);
    } catch (err) {
      tried.push(`${new URL(url).host}: unreachable`);
    }
  }

  cdnLog.push({ label, url: urls[0], ok: false, tried });
  const e = new Error(
    `Could not load ${label} from any mirror (${tried.join('; ')}). ` +
    `Your network or an extension is probably blocking public CDNs.`
  );
  e.cdn = label;
  e.tried = tried;
  throw e;
}

/**
 * Load a third-party library on demand and hand back its global.
 * @param {'marked'|'purify'|'hljs'|'jszip'|'pdfjs'|'mammoth'|'xlsx'} name
 */
export async function lib(name) {
  switch (name) {
    case 'marked':
      return loadFrom(CDN.marked, () => window.marked, 'marked');
    case 'purify':
      return loadFrom(CDN.purify, () => window.DOMPurify, 'DOMPurify');
    case 'hljs':
      return loadFrom(CDN.hljs, () => window.hljs, 'highlight.js');
    case 'jszip':
      return loadFrom(CDN.jszip, () => window.JSZip, 'JSZip');
    case 'pdfjs': {
      const pdfjs = await loadFrom(CDN.pdfjs, () => window.pdfjsLib, 'pdf.js');
      /* The worker has to come from a reachable mirror too. Pair it with
         whichever host served the main library. */
      const served = cdnLog.filter((c) => c.label === 'pdf.js' && c.ok).pop();
      const host = served ? new URL(served.url).host : '';
      pdfjs.GlobalWorkerOptions.workerSrc =
        CDN.pdfworker.find((u) => new URL(u).host === host) || CDN.pdfworker[0];
      return pdfjs;
    }
    case 'mammoth':
      return loadFrom(CDN.mammoth, () => window.mammoth, 'mammoth');
    case 'xlsx':
      return loadFrom(CDN.xlsx, () => window.XLSX, 'SheetJS');
    default:
      throw new Error(`Unknown library: ${name}`);
  }
}
