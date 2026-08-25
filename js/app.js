/* ============================================================
   app.js — wiring: chat loop, attachments, cut sheet, settings
   ============================================================ */

import { DEFAULTS, lib } from './config.js';
import {
  state, uid, bytes, count, estTokens, tokenish, ago,
  loadKey, saveKey, clearKey, loadSettings, saveSettings,
  loadModelCache, saveModelCache, setModel,
  loadChats, activeChat, newChat, ensureChat, selectChat, deleteChat, renameChat,
  touch, persist, storageUsed, exportBundle, wipeAll,
} from './store.js';
import { checkKey, fetchModels, pickDefaultModel, findModel, priceLine, sendChat } from './api.js';
import { ingest, buildParts, attachmentTokens } from './ingest.js';
import { md, highlightIn, escapeHtml, collectFiles, pickEntry, stitchPreview, warmRenderer } from './render.js';

/* ------------------------------------------------------------
   element handles
   ------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);
const el = new Proxy({}, { get: (_, k) => $(String(k)) });

/* live, per-session bits that never get persisted */
const live = {
  pending: [],        // attachments staged in the composer
  files: [],          // cut sheet contents for the active chat
  controller: null,   // AbortController for the running turn
  busy: false,
  modelFilter: 'all',
  keyPrompted: false,
};

/* ------------------------------------------------------------
   boot  (called at the very bottom, once every helper exists)
   ------------------------------------------------------------ */

async function boot() {
  loadKey();
  loadSettings();
  loadModelCache();
  loadChats();

  bindChrome();
  bindComposer();
  bindKeyModal();
  bindModelModal();
  bindSettings();
  bindSheet();

  paintKeyStatus();
  paintSettings();
  paintChatList();
  paintModelButton();
  openChat(state.activeId, { silent: true });

  /* On a phone the rail is an overlay drawer, so it starts out of the way. */
  if (isNarrow()) el.app.classList.add('is-railshut');

  warmup();

  if (!state.key) {
    live.keyPrompted = true;
    el.keyModal.showModal();
  }
}

async function warmup() {
  const stale = Date.now() - state.modelsFetchedAt > 12 * 3600e3;
  if (!state.models.length || stale) refreshModels({ quiet: true });
  if (state.key) verifyKey({ quiet: true });

  /* The markdown renderer arrives from a CDN, so an already-open chat is
     first drawn as plain text and upgraded once it lands. */
  try {
    await warmRenderer();
    if (activeChat()?.messages.length && !live.busy) paintStream();
  } catch {
    toast('Markdown styling could not load — replies will show as plain text.', true);
  }
}

/* ------------------------------------------------------------
   toasts
   ------------------------------------------------------------ */

function toast(msg, bad = false) {
  const node = document.createElement('div');
  node.className = `toast${bad ? ' toast--bad' : ''}`;
  node.textContent = msg;
  el.toasts.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .25s';
    setTimeout(() => node.remove(), 260);
  }, bad ? 5200 : 2600);
}

/* ------------------------------------------------------------
   key handling
   ------------------------------------------------------------ */

function paintKeyStatus() {
  const dot = el.keyDot;
  const text = el.keyStatusText;
  if (!state.key) {
    dot.dataset.state = 'off';
    text.textContent = 'Not connected';
    return;
  }
  if (state.keyInfo) {
    dot.dataset.state = 'on';
    const used = state.keyInfo.usage;
    const cap = state.keyInfo.limit;
    text.textContent = cap != null
      ? `$${Number(used || 0).toFixed(2)} of $${Number(cap).toFixed(2)} used`
      : (state.keyInfo.label || 'Connected');
  } else {
    dot.dataset.state = 'on';
    text.textContent = `${state.key.slice(0, 11)}…${state.key.slice(-4)}`;
  }
}

async function verifyKey({ quiet = false } = {}) {
  try {
    await checkKey();
    paintKeyStatus();
    return true;
  } catch (err) {
    el.keyDot.dataset.state = 'bad';
    el.keyStatusText.textContent = err.status === 401 ? 'Key rejected' : 'Could not reach OpenRouter';
    if (!quiet) toast(err.message, true);
    return false;
  }
}

function bindKeyModal() {
  el.keyStatusBtn.addEventListener('click', () => {
    el.keyInput.value = state.key;
    el.keyRemember.checked = state.keyRemembered;
    el.keyError.hidden = true;
    el.keyOkay.hidden = true;
    el.keyModal.showModal();
  });
  el.keyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = el.keyInput.value.trim();
    el.keyError.hidden = true;
    el.keyOkay.hidden = true;

    if (!value) {
      el.keyError.textContent = 'Paste a key first — it starts with sk-or-v1-.';
      el.keyError.hidden = false;
      return;
    }

    el.keySave.disabled = true;
    el.keySave.textContent = 'Checking…';
    saveKey(value, el.keyRemember.checked);

    const ok = await verifyKey({ quiet: true });
    el.keySave.disabled = false;
    el.keySave.textContent = 'Connect';

    if (!ok) {
      el.keyError.textContent = 'OpenRouter rejected that key. Copy it again from openrouter.ai/settings/keys.';
      el.keyError.hidden = false;
      return;
    }

    el.keyOkay.textContent = 'Connected. Loading your models…';
    el.keyOkay.hidden = false;
    await refreshModels({ quiet: true });
    paintKeyStatus();
    setTimeout(() => el.keyModal.close(), 550);
  });

  el.keyForget.addEventListener('click', () => {
    clearKey();
    paintKeyStatus();
    el.keyInput.value = '';
    el.keyOkay.hidden = true;
    el.keyError.hidden = true;
    toast('Key removed from this browser');
  });
}

/* ------------------------------------------------------------
   models
   ------------------------------------------------------------ */

async function refreshModels({ quiet = false } = {}) {
  try {
    el.modelList.innerHTML = '<div class="spin"><div class="spin__ring"></div>Loading models…</div>';
    const models = await fetchModels();
    if (!state.model || !models.some((m) => m.id === state.model)) {
      state.model = pickDefaultModel(models);
    }
    saveModelCache();
    paintModelButton();
    paintModelList();
    if (!quiet) toast(`${count(models.length)} models available`);
    return models;
  } catch (err) {
    el.modelList.innerHTML =
      `<div class="spin">Could not load the model list.<br>${escapeHtml(err.message)}</div>`;
    if (!quiet) toast(err.message, true);
    return [];
  }
}

function paintModelButton() {
  const m = findModel(state.model);
  el.modelBtnName.textContent = state.model || 'choose a model';
  el.modelBtn.title = m
    ? `${m.name}\n${count(m.context)} token context · ${priceLine(m)}${m.vision ? ' · vision' : ''}`
    : 'Choose a model';
  paintContextMeta();
}

function modelMatches(m, q) {
  if (!q) return true;
  const hay = `${m.id} ${m.name} ${m.vendor}`.toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}

function passesFilter(m) {
  switch (live.modelFilter) {
    case 'anthropic': return m.vendor === 'anthropic';
    case 'vision': return m.vision;
    case 'long': return m.context >= 200_000;
    case 'free': return m.free;
    default: return true;
  }
}

function paintModelList() {
  const q = el.modelSeek.value.trim().toLowerCase();
  const rows = state.models.filter((m) => passesFilter(m) && modelMatches(m, q));

  if (!state.models.length) {
    el.modelList.innerHTML = '<div class="spin"><div class="spin__ring"></div>Loading models…</div>';
    return;
  }
  if (!rows.length) {
    el.modelList.innerHTML = '<div class="spin">Nothing matches that. Try a shorter search, or type the exact ID below.</div>';
    return;
  }

  /* Keep the list snappy — the catalogue runs to hundreds of entries. */
  const shown = rows.slice(0, 140);
  el.modelList.innerHTML = shown.map((m) => `
    <button class="modelrow${m.id === state.model ? ' is-on' : ''}" data-id="${escapeHtml(m.id)}">
      <span class="modelrow__name">${escapeHtml(m.name)}${m.vision ? '<span class="modelrow__tag">vision</span>' : ''}${m.free ? '<span class="modelrow__tag">free</span>' : ''}</span>
      <span class="modelrow__id">${escapeHtml(m.id)}</span>
      <span class="modelrow__facts"><b>${tokenish(m.context)} ctx</b>${escapeHtml(priceLine(m))}</span>
    </button>`).join('') +
    (rows.length > shown.length
      ? `<div class="spin">${count(rows.length - shown.length)} more — narrow the search to see them.</div>`
      : '');
}

function bindModelModal() {
  el.modelBtn.addEventListener('click', () => {
    el.modelModal.showModal();
    paintModelList();
    if (!state.models.length) refreshModels({ quiet: true });
    el.modelSeek.focus();
  });

  el.modelSeek.addEventListener('input', paintModelList);

  el.modelFilters.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter]');
    if (!chip) return;
    live.modelFilter = chip.dataset.filter;
    [...el.modelFilters.children].forEach((c) => c.classList.toggle('is-on', c === chip));
    paintModelList();
  });

  el.modelList.addEventListener('click', (e) => {
    const row = e.target.closest('.modelrow');
    if (!row) return;
    setModel(row.dataset.id);
    paintModelButton();
    paintModelList();
    el.modelModal.close();
    toast(`Using ${row.dataset.id}`);
  });

  el.modelManualUse.addEventListener('click', () => {
    const id = el.modelManual.value.trim();
    if (!id) return;
    setModel(id);
    paintModelButton();
    el.modelModal.close();
    toast(`Using ${id}`);
  });
  el.modelManual.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.modelManualUse.click(); }
  });
}

/* ------------------------------------------------------------
   chrome: rail, sheet, dialogs, shortcuts
   ------------------------------------------------------------ */

const isNarrow = () => matchMedia('(max-width: 860px)').matches;

/** On a phone the rail overlays the conversation, so get it out of the way. */
function shutRailIfNarrow() {
  if (isNarrow()) el.app.classList.add('is-railshut');
}

function bindChrome() {
  el.railClose.addEventListener('click', () => el.app.classList.add('is-railshut'));
  el.railOpen.addEventListener('click', () => el.app.classList.remove('is-railshut'));
  el.newChatBtn.addEventListener('click', () => {
    newChat();
    paintChatList();
    openChat(state.activeId);
    shutRailIfNarrow();
    el.prompt.focus();
  });

  el.settingsBtn.addEventListener('click', () => {
    paintSettings();
    el.settingsModal.showModal();
  });

  document.addEventListener('click', (e) => {
    const closer = e.target.closest('[data-close]');
    if (closer) closer.closest('dialog')?.close();
  });

  /* title editing */
  el.chatTitle.addEventListener('click', () => {
    if (el.chatTitle.isContentEditable) return;
    el.chatTitle.contentEditable = 'true';
    el.chatTitle.focus();
    getSelection()?.selectAllChildren(el.chatTitle);
  });
  el.chatTitle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.chatTitle.blur(); }
    if (e.key === 'Escape') { el.chatTitle.textContent = activeChat()?.title || 'New chat'; el.chatTitle.blur(); }
  });
  el.chatTitle.addEventListener('blur', () => {
    el.chatTitle.contentEditable = 'false';
    const chat = activeChat();
    if (!chat) return;
    const next = el.chatTitle.textContent.trim();
    if (next && next !== chat.title) { renameChat(chat.id, next); paintChatList(); }
    el.chatTitle.textContent = activeChat()?.title || 'New chat';
  });

  document.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === 'k') { e.preventDefault(); el.modelBtn.click(); }
    if (meta && e.key === 'Enter' && !live.busy) { e.preventDefault(); send(); }
  });
}

/* ------------------------------------------------------------
   chat list + workspace files
   ------------------------------------------------------------ */

function paintChatList() {
  el.chatTally.textContent = state.chats.length;
  if (!state.chats.length) {
    el.chatList.innerHTML = '<p class="rail__empty">No chats yet.</p>';
    return;
  }
  el.chatList.innerHTML = state.chats.map((c) => `
    <div class="chatrow${c.id === state.activeId ? ' is-on' : ''}" data-id="${c.id}" role="button" tabindex="0">
      <span class="chatrow__text">
        <span class="chatrow__name">${escapeHtml(c.title || 'Untitled chat')}</span>
        <span class="chatrow__when">${c.messages.length} msg · ${ago(c.updatedAt || c.createdAt)}</span>
      </span>
      <button class="icon-btn chatrow__kill" data-kill="${c.id}" title="Delete chat" aria-label="Delete chat">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>
      </button>
    </div>`).join('');
}

el.chatList?.addEventListener('click', (e) => {
  const kill = e.target.closest('[data-kill]');
  if (kill) {
    const chat = state.chats.find((c) => c.id === kill.dataset.kill);
    if (chat && chat.messages.length && !confirm(`Delete “${chat.title}”? This can't be undone.`)) return;
    deleteChat(kill.dataset.kill);
    paintChatList();
    openChat(state.activeId, { silent: true });
    return;
  }
  const row = e.target.closest('.chatrow');
  if (row) { openChat(row.dataset.id); shutRailIfNarrow(); }
});

function workspaceFiles() {
  const chat = activeChat();
  if (!chat) return [];
  const out = [];
  for (const m of chat.messages) for (const a of m.attachments || []) out.push(a);
  return out;
}

function paintWorkspace() {
  const files = workspaceFiles();
  el.fileTally.textContent = files.length;
  if (!files.length) {
    el.workspaceList.innerHTML =
      '<p class="rail__empty">Files you send stay listed here. Re-attach any of them to a later message.</p>';
    return;
  }
  el.workspaceList.innerHTML = files.map((a) => `
    <div class="filerow">
      <span class="filerow__text">
        <span class="filerow__name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>
        <span class="filerow__meta">${kindLabel(a)} · ${bytes(a.bytes)}${a.dropped ? ' · not kept' : ''}</span>
      </span>
      <button class="icon-btn filerow__act" data-reattach="${a.id}" title="Attach to next message" aria-label="Attach to next message">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
      </button>
    </div>`).join('');
}

el.workspaceList?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-reattach]');
  if (!btn) return;
  const att = workspaceFiles().find((a) => a.id === btn.dataset.reattach);
  if (!att) return;
  if (att.dropped) { toast('That file was not kept after the refresh — upload it again.', true); return; }
  live.pending.push({ ...att, id: uid() });
  paintRack();
  toast(`${att.name} attached`);
});

function kindLabel(a) {
  return {
    archive: `zip · ${a.children?.length || 0} files`,
    pdf: 'pdf text',
    'pdf-native': 'pdf (parsed by openrouter)',
    docx: 'word',
    sheet: 'spreadsheet',
    image: 'image',
    binary: 'binary',
    text: 'text',
  }[a.kind] || a.kind;
}

/* ------------------------------------------------------------
   opening a chat
   ------------------------------------------------------------ */

function openChat(id, { silent = false } = {}) {
  if (id) selectChat(id);
  const chat = activeChat();
  el.chatTitle.textContent = chat?.title || 'New chat';
  if (chat?.model) { state.model = chat.model; paintModelButton(); }
  paintChatList();
  paintWorkspace();
  paintStream();
  refreshSheet();
  if (!silent) el.prompt.focus();
}

/* The opening screen lives in index.html so it renders before any JS runs;
   keep a copy of its markup so it can be put back when a chat is emptied. */
const openerMarkup = document.getElementById('opener')?.outerHTML || '';

function paintStream() {
  const chat = activeChat();
  if (!chat || !chat.messages.length) {
    el.stream.innerHTML = openerMarkup;
    return;
  }
  el.stream.innerHTML = '';
  for (const m of chat.messages) el.stream.appendChild(turnNode(m));
  highlightIn(el.stream);
  requestAnimationFrame(() => el.stream.scrollTo({ top: el.stream.scrollHeight, behavior: 'auto' }));
}

/* ------------------------------------------------------------
   rendering one turn
   ------------------------------------------------------------ */

function turnNode(m) {
  const node = document.createElement('article');
  node.className = `turn turn--${m.role === 'user' ? 'user' : 'bot'}`;
  node.dataset.id = m.id;

  const who = m.role === 'user' ? 'You' : (m.model || 'Assistant');
  node.innerHTML = `
    <header class="turn__who"><span>${escapeHtml(who)}</span><span class="dash"></span></header>
    <div class="turn__body ${m.role === 'user' ? '' : 'md'}"></div>
    <div class="turn__acts"></div>`;

  const body = node.querySelector('.turn__body');
  if (m.role === 'user') {
    body.textContent = m.content || '';
    if (m.attachments?.length) body.appendChild(attachNote(m.attachments));
  } else {
    if (m.reasoning && state.settings.showReasoning) body.appendChild(thinkNode(m.reasoning));
    const html = document.createElement('div');
    html.innerHTML = md(m.content || '');
    body.appendChild(html);
    if (m.usage) body.appendChild(usageNode(m.usage, m.model));
  }

  node.querySelector('.turn__acts').innerHTML = actionsHtml(m);
  return node;
}

function attachNote(list) {
  const wrap = document.createElement('div');
  wrap.className = 'attachnote';
  wrap.innerHTML = list.map((a) => `
    <span class="attachnote__item" title="${escapeHtml(a.note || a.error || '')}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3v5h5M6 3h9l5 5v13H6z"/></svg>
      ${escapeHtml(a.name)} <span style="color:var(--paper-far)">${kindLabel(a)}</span>
    </span>`).join('');
  return wrap;
}

function thinkNode(text) {
  const d = document.createElement('details');
  d.className = 'think';
  d.innerHTML = '<summary>Reasoning</summary><div></div>';
  d.querySelector('div').textContent = text;
  return d;
}

function usageNode(u, model) {
  const p = document.createElement('p');
  p.className = 'usage';
  const cost = u.cost != null ? ` · $${Number(u.cost).toFixed(u.cost < 0.01 ? 5 : 4)}` : '';
  p.textContent = `${count(u.prompt_tokens || 0)} in · ${count(u.completion_tokens || 0)} out${cost}${model ? ` · ${model}` : ''}`;
  return p;
}

function actionsHtml(m) {
  const copy = `<button class="icon-btn" data-act="copy-turn" title="Copy" aria-label="Copy message"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h8"/></svg></button>`;
  const drop = `<button class="icon-btn" data-act="drop-turn" title="Delete" aria-label="Delete message"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg></button>`;
  const again = `<button class="icon-btn" data-act="redo" title="Regenerate" aria-label="Regenerate"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 11-2.34-5.66"/><path d="M20 4v5h-5"/></svg></button>`;
  const edit = `<button class="icon-btn" data-act="edit" title="Edit and resend" aria-label="Edit and resend"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10-10-4-4L4 16z"/><path d="M14 6l4 4"/></svg></button>`;
  const more = m.finish === 'length'
    ? `<button class="icon-btn" data-act="continue" title="Continue from the cut-off" aria-label="Continue"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>`
    : '';
  return m.role === 'user' ? copy + edit + drop : copy + again + more + drop;
}

/* stream-level clicks. The opening screen is re-created whenever a chat
   empties out, so everything inside it is delegated from here. */
el.stream?.addEventListener('click', async (e) => {
  if (e.target.closest('#openerKeyBtn')) { el.keyStatusBtn.click(); return; }
  if (e.target.closest('#openerAttachBtn')) { el.fileInput.click(); return; }

  const seed = e.target.closest('[data-prompt]');
  if (seed) {
    el.prompt.value = seed.dataset.prompt;
    autosize();
    el.prompt.focus();
    return;
  }

  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;

  if (act === 'copy-code' || act === 'save-code') {
    const fig = btn.closest('.code');
    const code = fig.querySelector('code')?.textContent || '';
    if (act === 'copy-code') { await copyText(code); toast('Code copied'); }
    else downloadText(fig.dataset.path || 'file.txt', code);
    return;
  }

  const turn = btn.closest('.turn');
  const chat = activeChat();
  if (!turn || !chat) return;
  const idx = chat.messages.findIndex((m) => m.id === turn.dataset.id);
  if (idx < 0) return;
  const m = chat.messages[idx];

  if (act === 'copy-turn') { await copyText(m.content || ''); toast('Copied'); }

  if (act === 'drop-turn') {
    chat.messages.splice(idx, 1);
    persist(); paintStream(); paintWorkspace(); refreshSheet();
  }

  if (act === 'edit') {
    el.prompt.value = m.content || '';
    live.pending = (m.attachments || []).filter((a) => !a.dropped).map((a) => ({ ...a, id: uid() }));
    chat.messages.splice(idx);
    persist(); paintStream(); paintRack(); autosize(); el.prompt.focus();
  }

  if (act === 'redo') {
    chat.messages.splice(idx);
    persist(); paintStream();
    runTurn();
  }

  if (act === 'continue') {
    const carry = {
      id: uid(), role: 'user', at: Date.now(), attachments: [],
      content: 'Continue exactly where you stopped. Do not repeat anything you already wrote. If you were mid-file, restart that one file from its beginning in a fresh code block with the same path on the fence.',
    };
    chat.messages.push(carry);
    persist();
    el.stream.appendChild(turnNode(carry));
    runTurn();
  }
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function downloadText(name, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  downloadBlob(name.split('/').pop() || 'file.txt', blob);
}

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ------------------------------------------------------------
   composer: text, attachments, drag and drop
   ------------------------------------------------------------ */

function autosize() {
  const t = el.prompt;
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, Math.round(innerHeight * 0.44))}px`;
}

function bindComposer() {
  el.prompt.addEventListener('input', () => { autosize(); paintContextMeta(); });
  el.prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });

  el.sendBtn.addEventListener('click', send);
  el.stopBtn.addEventListener('click', () => live.controller?.abort());

  el.attachBtn.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', () => {
    if (el.fileInput.files?.length) take(el.fileInput.files);
    el.fileInput.value = '';
  });

  el.prompt.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); take(files); }
  });

  /* drag and drop over the whole window, veil shown on the composer */
  let depth = 0;
  const show = () => { el.dropveil.hidden = false; };
  const hide = () => { el.dropveil.hidden = true; };

  addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    depth++; show();
  });
  addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
  });
  addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) hide(); });
  addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    depth = 0; hide();
    take(e.dataTransfer.files);
  });
}

async function take(fileList) {
  const files = [...fileList];
  const placeholders = files.map((f) => {
    const stub = { id: uid(), name: f.name, bytes: f.size, kind: 'text', busy: true, note: 'Reading…', chars: 0 };
    live.pending.push(stub);
    return stub;
  });
  paintRack();

  for (let i = 0; i < files.length; i++) {
    const stub = placeholders[i];
    const [att] = await ingest([files[i]], { pdfMode: state.settings.pdfMode }, (_, msg) => {
      if (msg) { stub.note = msg; paintRack(); }
    });
    const at = live.pending.indexOf(stub);
    if (at >= 0) live.pending[at] = att;
    paintRack();
    if (att.error) toast(`${att.name}: ${att.error}`, true);
  }
  paintContextMeta();
}

function paintRack() {
  const list = live.pending;
  el.rack.hidden = !list.length;
  el.rack.innerHTML = list.map((a) => `
    <div class="rackitem${a.busy ? ' is-busy' : ''}${a.error ? ' is-bad' : ''}" title="${escapeHtml(a.note || a.error || '')}">
      ${a.kind === 'image' && a.dataUrl
        ? `<img class="rackitem__thumb" src="${a.dataUrl}" alt="">`
        : `<span class="rackitem__ico">${fileGlyph(a)}</span>`}
      <span class="rackitem__text">
        <span class="rackitem__name">${escapeHtml(a.name)}</span>
        <span class="rackitem__meta">${a.busy ? escapeHtml(a.note || 'reading…') : `${kindLabel(a)} · ~${tokenish(attachmentTokens(a))} tok`}</span>
      </span>
      <button class="icon-btn rackitem__kill" data-unattach="${a.id}" title="Remove" aria-label="Remove attachment">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>`).join('');
  paintContextMeta();
}

function fileGlyph(a) {
  const paths = {
    archive: '<path d="M4 4h16v16H4z"/><path d="M12 4v4M12 10v2M12 14v2"/>',
    pdf: '<path d="M14 3v5h5M6 3h9l5 5v13H6z"/><path d="M9 13h6M9 17h4"/>',
    'pdf-native': '<path d="M14 3v5h5M6 3h9l5 5v13H6z"/><path d="M9 13h6M9 17h4"/>',
    sheet: '<path d="M4 4h16v16H4z"/><path d="M4 10h16M10 4v16"/>',
    docx: '<path d="M14 3v5h5M6 3h9l5 5v13H6z"/>',
    binary: '<path d="M4 6h16v12H4z"/><path d="M8 10h1M12 10h1M16 10h1"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[a.kind] || '<path d="M14 3v5h5M6 3h9l5 5v13H6z"/>'}</svg>`;
}

el.rack?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-unattach]');
  if (!btn) return;
  live.pending = live.pending.filter((a) => a.id !== btn.dataset.unattach);
  paintRack();
});

function paintContextMeta() {
  const m = findModel(state.model);
  const attached = live.pending.reduce((n, a) => n + attachmentTokens(a), 0);
  const typed = estTokens(el.prompt.value.length);
  const chat = activeChat();
  const history = (chat?.messages || [])
    .slice(-state.settings.historyDepth)
    .reduce((n, msg) => n + estTokens((msg.content || '').length) +
      (msg.attachments || []).reduce((k, a) => k + attachmentTokens(a), 0), 0);
  const total = attached + typed + history + estTokens(state.settings.system.length);

  const bits = [];
  if (live.pending.length) bits.push(`${live.pending.length} file${live.pending.length === 1 ? '' : 's'}`);
  bits.push(`~${tokenish(total)} tokens this turn`);
  if (m?.context) {
    bits.push(`${tokenish(m.context)} limit`);
    if (total > m.context * 0.9) bits.push('— over the limit, trim files or history');
  }
  el.ctxMeta.textContent = bits.join(' · ');

  const noVision = live.pending.some((a) => a.kind === 'image') && m && !m.vision;
  if (noVision) el.ctxMeta.textContent += ' · this model has no image input';
}

/* ------------------------------------------------------------
   sending
   ------------------------------------------------------------ */

function send() {
  if (live.busy) return;
  const text = el.prompt.value.trim();
  if (!text && !live.pending.length) return;
  if (!state.key) { el.keyModal.showModal(); return; }
  if (live.pending.some((a) => a.busy)) { toast('Still reading your files — one moment.'); return; }

  const chat = ensureChat();
  const msg = {
    id: uid(),
    role: 'user',
    content: text,
    attachments: live.pending,
    at: Date.now(),
  };
  chat.messages.push(msg);

  if (chat.title === 'New chat') {
    const seed = text || live.pending[0]?.name || 'New chat';
    chat.title = seed.replace(/\s+/g, ' ').slice(0, 60) + (seed.length > 60 ? '…' : '');
    el.chatTitle.textContent = chat.title;
  }

  live.pending = [];
  el.prompt.value = '';
  autosize();
  paintRack();
  persist();

  if ($('opener')) el.stream.innerHTML = '';
  el.stream.appendChild(turnNode(msg));
  paintChatList();
  paintWorkspace();
  runTurn();
}

/** Assemble the request from history and stream the answer in. */
async function runTurn() {
  const chat = activeChat();
  if (!chat) return;

  const model = state.model;
  if (!model) { toast('Pick a model first', true); return; }

  const s = state.settings;
  const slice = chat.messages.slice(-s.historyDepth);
  const messages = [{ role: 'system', content: s.system }];
  let plugins = [];
  const vision = findModel(model)?.vision !== false;

  for (const m of slice) {
    if (m.role === 'user') {
      const built = buildParts(m.content || '', m.attachments || [], { vision });
      if (built.plugins.length) plugins = built.plugins;
      messages.push({ role: 'user', content: built.parts });
    } else if (m.content) {
      messages.push({ role: 'assistant', content: m.content });
    }
  }

  const bot = { id: uid(), role: 'assistant', content: '', reasoning: '', model, at: Date.now() };
  chat.messages.push(bot);

  const node = turnNode(bot);
  el.stream.appendChild(node);
  const body = node.querySelector('.turn__body');
  body.innerHTML = '<div class="md"></div>';
  const target = body.querySelector('.md');
  target.innerHTML = '<span class="caret"></span>';

  setBusy(true);
  live.controller = new AbortController();

  /* Repaint on a timer rather than per token: markdown reparsing is the
     expensive part and a long build can stream tens of thousands of chars. */
  let dirty = false;
  let lastPaint = 0;
  const paint = (force = false) => {
    if (!dirty && !force) return;
    const gap = bot.content.length > 24_000 ? 400 : 90;
    const now = performance.now();
    if (!force && now - lastPaint < gap) return;
    lastPaint = now;
    dirty = false;
    const stick = nearBottom();
    target.innerHTML = md(bot.content) + (live.busy ? '<span class="caret"></span>' : '');
    if (stick) el.stream.scrollTop = el.stream.scrollHeight;
  };
  const ticker = setInterval(() => paint(), 90);

  let thinkBox = null;

  try {
    const res = await sendChat({
      model,
      messages,
      temperature: s.temperature,
      maxTokens: s.maxTokens,
      stream: s.stream,
      plugins,
      signal: live.controller.signal,
      onText: (chunk) => { bot.content += chunk; dirty = true; },
      onReasoning: (chunk) => {
        bot.reasoning += chunk;
        if (!s.showReasoning) return;
        if (!thinkBox) { thinkBox = thinkNode(''); thinkBox.open = true; body.prepend(thinkBox); }
        thinkBox.querySelector('div').textContent = bot.reasoning;
      },
      onUsage: (u) => { bot.usage = u; },
    });

    bot.content = res.text || bot.content;
    bot.finish = res.finish;
    if (res.usage) bot.usage = res.usage;
  } catch (err) {
    if (err.name === 'AbortError') {
      bot.content += bot.content ? '\n\n_[stopped]_' : '_[stopped before anything came back]_';
    } else {
      if (!bot.content) chat.messages.pop();
      showFailure(err, node, Boolean(bot.content));
    }
  } finally {
    clearInterval(ticker);
    setBusy(false);
    live.controller = null;

    if (!bot.content) {
      node.remove();
    } else {
      paint(true);
      node.querySelector('.turn__acts').innerHTML = actionsHtml(bot);
      if (bot.usage) target.after(usageNode(bot.usage, bot.model));
      highlightIn(node);
    }

    touch(chat);
    paintChatList();
    refreshSheet();
    paintContextMeta();
  }
}

function showFailure(err, afterNode, partial) {
  const box = document.createElement('div');
  box.className = 'fail';
  box.innerHTML =
    `<strong>${escapeHtml(err.status ? `Error ${err.status}` : 'Request failed')}</strong> — ${escapeHtml(err.message)}` +
    (err.hint && err.hint !== err.message ? `<br><span style="color:var(--paper-dim)">${escapeHtml(err.hint)}</span>` : '') +
    (partial ? '<br><span style="color:var(--paper-dim)">The partial reply above was kept.</span>' : '');
  const retry = document.createElement('button');
  retry.className = 'btn btn--ghost';
  retry.style.marginTop = '10px';
  retry.textContent = 'Try again';
  retry.addEventListener('click', () => { box.remove(); runTurn(); });
  box.appendChild(document.createElement('br'));
  box.appendChild(retry);
  afterNode.after(box);
  el.stream.scrollTop = el.stream.scrollHeight;
}

function nearBottom() {
  return el.stream.scrollHeight - el.stream.scrollTop - el.stream.clientHeight < 140;
}

function setBusy(on) {
  live.busy = on;
  el.sendBtn.hidden = on;
  el.stopBtn.hidden = !on;
  el.sendBtn.disabled = on;
}

/* ------------------------------------------------------------
   cut sheet
   ------------------------------------------------------------ */

function refreshSheet() {
  const chat = activeChat();
  live.files = chat ? collectFiles(chat.messages) : [];
  const n = live.files.length;

  el.sheetBadge.hidden = !n;
  el.sheetBadge.textContent = n;

  if (!n) {
    el.sheetBody.innerHTML =
      `<p class="sheet__empty">Nothing built yet. Ask for code and every file the model writes with a path in its fence <span class="mono">\`\`\`js src/app.js</span> shows up here as its own file.</p>`;
    el.sheetFoot.hidden = true;
    return;
  }

  el.sheetBody.innerHTML = `<div class="cut">${live.files.map((f, i) => `
    <div class="cutitem" data-path="${escapeHtml(f.path)}">
      <div class="cutitem__top">
        <span class="cutitem__num">${String(i + 1).padStart(2, '0')}</span>
        <span class="cutitem__path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>
        <button class="icon-btn cutitem__act" data-sheet="copy" title="Copy" aria-label="Copy file">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h8"/></svg>
        </button>
        <button class="icon-btn cutitem__act" data-sheet="save" title="Save" aria-label="Save file">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19h14"/></svg>
        </button>
      </div>
      <div class="cutitem__meta">
        <span>${f.lang || 'text'}</span>
        <span>${count(f.code.split('\n').length)} lines</span>
        <span>${bytes(new Blob([f.code]).size)}</span>
        ${f.revision > 1 ? `<span>rev ${f.revision}</span>` : ''}
        ${f.partial ? '<span style="color:var(--brass)">incomplete</span>' : ''}
      </div>
    </div>`).join('')}</div>`;

  el.sheetFoot.hidden = false;
  el.previewBtn.hidden = !pickEntry(live.files);
}

function bindSheet() {
  el.sheetToggle.addEventListener('click', () => el.app.classList.toggle('is-sheetopen'));
  el.sheetClose.addEventListener('click', () => el.app.classList.remove('is-sheetopen'));

  el.sheetBody.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sheet]');
    if (!btn) return;
    const path = btn.closest('.cutitem').dataset.path;
    const file = live.files.find((f) => f.path === path);
    if (!file) return;
    if (btn.dataset.sheet === 'copy') { copyText(file.code); toast('Copied'); }
    else downloadText(file.path, file.code);
  });

  el.zipBtn.addEventListener('click', async () => {
    if (!live.files.length) return;
    el.zipBtn.disabled = true;
    try {
      const JSZip = await lib('jszip');
      const zip = new JSZip();
      for (const f of live.files) zip.file(f.path, f.code);
      const chat = activeChat();
      const slug = (chat?.title || 'build').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'build';
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      downloadBlob(`${slug}.zip`, blob);
      toast(`${live.files.length} files zipped`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      el.zipBtn.disabled = false;
    }
  });

  el.previewBtn.addEventListener('click', () => {
    const entry = pickEntry(live.files);
    if (!entry) return;
    el.previewTitle.textContent = entry.path;
    el.previewFrame.srcdoc = stitchPreview(entry, live.files);
    el.previewModal.showModal();
  });

  el.previewModal.addEventListener('close', () => { el.previewFrame.srcdoc = ''; });
}

/* ------------------------------------------------------------
   settings
   ------------------------------------------------------------ */

function paintSettings() {
  const s = state.settings;
  el.setSystem.value = s.system;
  el.setTemp.value = s.temperature;
  el.setTempOut.textContent = Number(s.temperature).toFixed(2);
  el.setMaxTokens.value = s.maxTokens ?? '';
  el.setHistory.value = s.historyDepth;
  el.setHistOut.textContent = s.historyDepth;
  el.setPdfMode.value = s.pdfMode;
  el.setStream.checked = s.stream;
  el.setReasoning.checked = s.showReasoning;
  el.storageMeta.textContent =
    `${state.chats.length} chat${state.chats.length === 1 ? '' : 's'} · about ${bytes(storageUsed())} in this browser. Nothing leaves the device except the requests you send to OpenRouter.`;
}

function bindSettings() {
  el.setSystem.addEventListener('change', () => saveSettings({ system: el.setSystem.value || DEFAULTS.system }));
  el.setTemp.addEventListener('input', () => {
    el.setTempOut.textContent = Number(el.setTemp.value).toFixed(2);
    saveSettings({ temperature: Number(el.setTemp.value) });
  });
  el.setMaxTokens.addEventListener('change', () => {
    const v = parseInt(el.setMaxTokens.value, 10);
    saveSettings({ maxTokens: Number.isFinite(v) && v > 0 ? v : null });
  });
  el.setHistory.addEventListener('input', () => {
    el.setHistOut.textContent = el.setHistory.value;
    saveSettings({ historyDepth: Number(el.setHistory.value) });
    paintContextMeta();
  });
  el.setPdfMode.addEventListener('change', () => saveSettings({ pdfMode: el.setPdfMode.value }));
  el.setStream.addEventListener('change', () => saveSettings({ stream: el.setStream.checked }));
  el.setReasoning.addEventListener('change', () => {
    saveSettings({ showReasoning: el.setReasoning.checked });
    paintStream();
  });

  el.exportBtn.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(exportBundle(), null, 2)], { type: 'application/json' });
    downloadBlob(`blueprint-chats-${new Date().toISOString().slice(0, 10)}.json`, blob);
  });

  el.wipeBtn.addEventListener('click', () => {
    if (!confirm('Delete every chat, your settings and the stored key from this browser?')) return;
    wipeAll();
    location.reload();
  });
}

/* keep the composer sized correctly when the viewport changes */
addEventListener('resize', autosize);

boot();
