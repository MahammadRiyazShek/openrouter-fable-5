/* ============================================================
   render.js — markdown → DOM, and fences → files
   ============================================================ */

import { lib } from './config.js';

let marked = null;
let purify = null;
let hljs = null;

export async function warmRenderer() {
  [marked, purify] = await Promise.all([lib('marked'), lib('purify')]);
  configure();
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ------------------------------------------------------------
   fence info parsing
   ------------------------------------------------------------ */

const LANG_BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', rs: 'rust',
  go: 'go', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', sh: 'bash',
  bash: 'bash', zsh: 'bash', ps1: 'powershell', sql: 'sql', html: 'xml',
  htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', css: 'css', scss: 'scss',
  less: 'less', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini',
  ini: 'ini', cfg: 'ini', env: 'bash', md: 'markdown', markdown: 'markdown',
  dockerfile: 'dockerfile', tf: 'hcl', lua: 'lua', dart: 'dart', r: 'r',
  pl: 'perl', ex: 'elixir', exs: 'elixir', csv: 'plaintext', txt: 'plaintext',
};

const PATHISH = /^[\w.@~+-]+(?:[/\\][\w.@ +-]+)*\.[A-Za-z0-9]{1,12}$/;
const KNOWN_BARE = /^(dockerfile|makefile|procfile|gemfile|rakefile|justfile|readme|license)$/i;

function extOf(p) {
  const b = (p.split(/[/\\]/).pop() || '').toLowerCase();
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1) : b;
}

function cleanToken(t) {
  return t
    .replace(/^(?:path|file|filename|title|name)\s*[:=]\s*/i, '')
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/^\.\//, '')
    .trim();
}

/**
 * Read a fence info string into a language and, when present, a file path.
 * Handles: "js src/app.js", "js:src/app.js", "html title=\"index.html\"",
 * "src/app.js", "python", "".
 *
 * `lang` is what a person should see on the block; `hl` is the grammar name
 * highlight.js knows it by (html is highlighted as xml, for instance).
 */
export function parseInfo(info = '') {
  const raw = String(info).trim();
  if (!raw) return { lang: '', hl: '', path: '' };

  let lang = '';
  let path = '';
  const tokens = raw.split(/\s+/).filter(Boolean);

  for (let i = 0; i < tokens.length; i++) {
    let t = cleanToken(tokens[i]);
    if (!t) continue;

    /* "js:src/app.js" style */
    if (!path && /^[A-Za-z0-9+#-]{1,14}:[^:\s]+$/.test(t)) {
      const [l, p] = t.split(':');
      if (PATHISH.test(p) || KNOWN_BARE.test(p)) { lang = lang || l.toLowerCase(); path = p; continue; }
    }

    if (!path && (t.includes('/') || PATHISH.test(t) || KNOWN_BARE.test(t))) {
      path = t;
      continue;
    }
    if (!lang && /^[A-Za-z0-9+#_-]{1,20}$/.test(t)) lang = t.toLowerCase();
  }

  if (path && !lang) lang = extOf(path);
  return { lang, hl: LANG_BY_EXT[lang] || lang, path };
}

/**
 * Models often label a block with a bold or heading line instead of putting
 * the path on the fence. Promote those labels into the fence info so both the
 * renderer and the file extractor see one consistent shape.
 */
export function normalizeFences(md) {
  const lines = String(md).split('\n');
  let inFence = false;
  let fenceMark = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const open = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);

    if (!inFence && open) {
      const [, indent, mark, info] = open;
      const parsed = parseInfo(info);
      if (!parsed.path) {
        /* look back over blank lines for a filename-ish label */
        for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
          const prev = lines[j].trim();
          if (!prev) continue;
          const label = prev
            .replace(/^#{1,6}\s*/, '')
            .replace(/^[-*+][ \t]+/, '')     // list bullet, not the ** of bold
            .replace(/^\d+\.[ \t]+/, '')
            .replace(/^\*\*(.+?)\*\*:?$/, '$1')
            .replace(/^__(.+?)__:?$/, '$1')
            .replace(/^`(.+?)`:?$/, '$1')
            .replace(/^(?:file|filename|path)\s*[:=]\s*/i, '')
            .replace(/:$/, '')
            .trim();
          if (label.length < 120 && (PATHISH.test(label) || (label.includes('/') && PATHISH.test(label.split('/').pop())))) {
            lines[i] = `${indent}${mark}${parsed.lang || extOf(label)} ${label}`;
          }
          break;
        }
      }
      inFence = true;
      fenceMark = mark[0].repeat(3);
      continue;
    }

    if (inFence && new RegExp(`^\\s*${fenceMark[0]}{3,}\\s*$`).test(line)) inFence = false;
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------
   marked configuration
   ------------------------------------------------------------ */

function codeBlockHtml(code, info) {
  const { lang, hl, path } = parseInfo(info);
  const label = path || '';
  const langTag = lang || (info || '').trim().split(/\s+/)[0] || 'text';
  const grammar = hl || langTag;
  return (
    `<figure class="code" data-path="${escapeHtml(label)}" data-lang="${escapeHtml(langTag)}">` +
      `<div class="code__bar">` +
        (label
          ? `<span class="code__path" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`
          : `<span class="code__path code__path--none"></span>`) +
        `<span class="code__lang">${escapeHtml(langTag)}</span>` +
        `<button class="icon-btn" data-act="copy-code" title="Copy" aria-label="Copy code">` +
          `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h8"/></svg>` +
        `</button>` +
        (label
          ? `<button class="icon-btn" data-act="save-code" title="Save this file" aria-label="Save this file">` +
              `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19h14"/></svg>` +
            `</button>`
          : '') +
      `</div>` +
      `<pre><code class="language-${escapeHtml(grammar)}">${escapeHtml(code)}</code></pre>` +
    `</figure>`
  );
}

function configure() {
  if (!marked) return;
  const renderer = {
    /* marked v12 hands over (code, infostring, escaped); v13+ hands an object. */
    code(a, b) {
      if (a && typeof a === 'object') return codeBlockHtml(a.text ?? '', a.lang ?? '');
      return codeBlockHtml(a ?? '', b ?? '');
    },
    link(href, title, text) {
      if (href && typeof href === 'object') {
        const t = href.text ?? '';
        return `<a href="${escapeHtml(href.href || '')}" target="_blank" rel="noopener nofollow">${t}</a>`;
      }
      return `<a href="${escapeHtml(href || '')}"${title ? ` title="${escapeHtml(title)}"` : ''} target="_blank" rel="noopener nofollow">${text}</a>`;
    },
  };
  marked.use({ renderer, gfm: true, breaks: true });
}

/** Markdown → sanitised HTML. Falls back to plain text if the CDN is blocked. */
export function md(text) {
  const src = normalizeFences(text || '');
  if (!marked || !purify) return `<p>${escapeHtml(src).replace(/\n/g, '<br>')}</p>`;
  const html = marked.parse(src);
  return purify.sanitize(html, {
    ADD_ATTR: ['target', 'data-act', 'data-path', 'data-lang', 'aria-hidden', 'aria-label'],
    FORBID_TAGS: ['style', 'form', 'input', 'iframe', 'object', 'embed', 'link'],
  });
}

/** Syntax-highlight any code that hasn't been done yet. */
export async function highlightIn(root) {
  const blocks = root.querySelectorAll('pre code:not([data-hl])');
  if (!blocks.length) return;
  try {
    hljs = hljs || (await lib('hljs'));
  } catch {
    return; // offline is fine, plain code still reads
  }
  for (const el of blocks) {
    el.dataset.hl = '1';
    const lang = (el.className.match(/language-([\w+#-]+)/) || [])[1] || '';
    const code = el.textContent;
    if (code.length > 120_000) continue;
    try {
      const res = hljs.getLanguage(lang)
        ? hljs.highlight(code, { language: lang, ignoreIllegals: true })
        : hljs.highlightAuto(code);
      el.innerHTML = res.value;
    } catch { /* leave it plain */ }
  }
}

/* ------------------------------------------------------------
   fences → files
   ------------------------------------------------------------ */

/**
 * Collect every fenced block that names a file.
 * @param {string} text one assistant message
 * @returns {Array<{path:string, lang:string, code:string}>}
 */
export function filesFromMarkdown(text) {
  const src = normalizeFences(text || '');
  const lines = src.split('\n');
  const out = [];
  let open = null;

  for (const line of lines) {
    const fence = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (!open) {
      if (fence) {
        const info = fence[3].trim();
        open = { mark: fence[2][0], len: fence[2].length, info, body: [], indent: fence[1].length };
      }
      continue;
    }
    const close = line.match(/^\s*(`{3,}|~{3,})\s*$/);
    if (close && close[1][0] === open.mark && close[1].length >= open.len) {
      const { path, lang } = parseInfo(open.info);
      if (path) out.push({ path: path.replace(/^\/+/, ''), lang, code: open.body.join('\n') });
      open = null;
      continue;
    }
    open.body.push(line);
  }

  /* An unterminated fence still counts — streaming replies get cut off mid-file. */
  if (open) {
    const { path, lang } = parseInfo(open.info);
    if (path && open.body.length) out.push({ path: path.replace(/^\/+/, ''), lang, code: open.body.join('\n'), partial: true });
  }
  return out;
}

/**
 * Fold every assistant message in a chat into one file set.
 * Later turns overwrite earlier versions of the same path.
 */
export function collectFiles(messages) {
  const map = new Map();
  messages.forEach((m, turn) => {
    if (m.role !== 'assistant' || !m.content) return;
    for (const f of filesFromMarkdown(m.content)) {
      map.set(f.path, { ...f, turn, revision: (map.get(f.path)?.revision || 0) + 1 });
    }
  });
  return [...map.values()];
}

/* ------------------------------------------------------------
   preview: stitch a generated site into one sandboxed document
   ------------------------------------------------------------ */

export function pickEntry(files) {
  const html = files.filter((f) => /\.html?$/i.test(f.path));
  if (!html.length) return null;
  return (
    html.find((f) => /(^|\/)index\.html?$/i.test(f.path)) ||
    html.sort((a, b) => a.path.split('/').length - b.path.split('/').length)[0]
  );
}

/** Inline sibling css/js so a multi-file site previews without a server. */
export function stitchPreview(entry, files) {
  const byPath = new Map(files.map((f) => [f.path.replace(/^\.?\//, ''), f]));
  const dir = entry.path.includes('/') ? entry.path.replace(/\/[^/]*$/, '/') : '';
  const find = (href) => {
    const clean = href.replace(/^\.?\//, '').replace(/[?#].*$/, '');
    return byPath.get(clean) || byPath.get(dir + clean) || byPath.get(clean.replace(/^\.\.\//, '')) ||
      [...byPath.values()].find((f) => f.path.endsWith(`/${clean}`) || f.path === clean);
  };

  let html = entry.code;

  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/stylesheet/i.test(tag)) return tag;
    const href = (tag.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!href || /^(https?:)?\/\//i.test(href)) return tag;
    const file = find(href);
    return file ? `<style>\n${file.code}\n</style>` : tag;
  });

  html = html.replace(/<script\b([^>]*)>\s*<\/script>/gi, (tag, attrs) => {
    const src = (attrs.match(/src\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!src || /^(https?:)?\/\//i.test(src)) return tag;
    const file = find(src);
    if (!file) return tag;
    const type = /type\s*=\s*["']module["']/i.test(attrs) ? ' type="module"' : '';
    return `<script${type}>\n${file.code}\n</script>`;
  });

  return html;
}
