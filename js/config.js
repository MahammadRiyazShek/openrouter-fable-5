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

/* CDN libraries, loaded only when a feature actually needs them. */
const CDN = {
  marked:    'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js',
  purify:    'https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js',
  hljs:      'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.9.0/highlight.min.js',
  jszip:     'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
  pdfjs:     'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
  pdfworker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
  mammoth:   'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js',
  xlsx:      'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
};

const pending = new Map();

function injectScript(src) {
  if (pending.has(src)) return pending.get(src);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve();
    s.onerror = () => { pending.delete(src); reject(new Error(`Could not load ${src}`)); };
    document.head.appendChild(s);
  });
  pending.set(src, p);
  return p;
}

/**
 * Load a third-party library on demand and hand back its global.
 * @param {'marked'|'purify'|'hljs'|'jszip'|'pdfjs'|'mammoth'|'xlsx'} name
 */
export async function lib(name) {
  switch (name) {
    case 'marked':
      if (!window.marked) await injectScript(CDN.marked);
      return window.marked;
    case 'purify':
      if (!window.DOMPurify) await injectScript(CDN.purify);
      return window.DOMPurify;
    case 'hljs':
      if (!window.hljs) await injectScript(CDN.hljs);
      return window.hljs;
    case 'jszip':
      if (!window.JSZip) await injectScript(CDN.jszip);
      return window.JSZip;
    case 'pdfjs':
      if (!window.pdfjsLib) await injectScript(CDN.pdfjs);
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = CDN.pdfworker;
      return window.pdfjsLib;
    case 'mammoth':
      if (!window.mammoth) await injectScript(CDN.mammoth);
      return window.mammoth;
    case 'xlsx':
      if (!window.XLSX) await injectScript(CDN.xlsx);
      return window.XLSX;
    default:
      throw new Error(`Unknown library: ${name}`);
  }
}
