/* ============================================================
   store.js — everything that has to survive a page refresh
   ============================================================
   Truth for the live session is the in-memory state object.
   localStorage is a best-effort mirror: if a chat carries so much
   attached text that it blows the quota, attachment payloads get
   pruned oldest-first rather than losing the conversation.
   ============================================================ */

import { LS, DEFAULTS } from './config.js';

/* ---------- tiny helpers ---------- */

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function bytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
}

export function count(n) {
  return new Intl.NumberFormat('en-US').format(n);
}

/** Rough but consistent: ~3.7 chars per token across code and prose. */
export const estTokens = (chars) => Math.max(1, Math.round(chars / 3.7));

export function tokenish(n) {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* ---------- raw storage access ---------- */

function readJSON(store, k, fallback) {
  try {
    const raw = store.getItem(k);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(store, k, v) {
  try {
    store.setItem(k, JSON.stringify(v));
    return true;
  } catch {
    return false;
  }
}

/* ---------- state ---------- */

export const state = {
  key: '',
  keyRemembered: true,
  keyInfo: null,          // { label, usage, limit, free_tier } from /key
  models: [],             // live catalogue from /api/v1/models
  modelsFetchedAt: 0,
  model: '',              // selected model id
  chats: [],
  activeId: '',
  settings: { ...DEFAULTS },
};

/* ---------- api key ---------- */

export function loadKey() {
  const fromLocal = localStorage.getItem(LS.key);
  const fromSession = sessionStorage.getItem(LS.key);
  state.key = fromLocal || fromSession || '';
  state.keyRemembered = Boolean(fromLocal) || !fromSession;
  return state.key;
}

export function saveKey(key, remember) {
  state.key = key.trim();
  state.keyRemembered = remember;
  localStorage.removeItem(LS.key);
  sessionStorage.removeItem(LS.key);
  if (!state.key) return;
  (remember ? localStorage : sessionStorage).setItem(LS.key, state.key);
}

export function clearKey() {
  state.key = '';
  state.keyInfo = null;
  localStorage.removeItem(LS.key);
  sessionStorage.removeItem(LS.key);
}

/* ---------- settings ---------- */

export function loadSettings() {
  state.settings = { ...DEFAULTS, ...readJSON(localStorage, LS.settings, {}) };
  return state.settings;
}

export function saveSettings(patch) {
  Object.assign(state.settings, patch);
  writeJSON(localStorage, LS.settings, state.settings);
}

/* ---------- model catalogue ---------- */

export function loadModelCache() {
  const c = readJSON(localStorage, LS.models, null);
  if (c && Array.isArray(c.models)) {
    state.models = c.models;
    state.modelsFetchedAt = c.at || 0;
    state.model = c.selected || '';
  }
}

export function saveModelCache() {
  writeJSON(localStorage, LS.models, {
    models: state.models,
    at: state.modelsFetchedAt,
    selected: state.model,
  });
}

export function setModel(id) {
  state.model = id;
  const chat = activeChat();
  if (chat) { chat.model = id; persist(); }
  saveModelCache();
}

/* ---------- chats ---------- */

export function loadChats() {
  const chats = readJSON(localStorage, LS.chats, []);
  state.chats = Array.isArray(chats) ? chats : [];
  state.activeId = localStorage.getItem(LS.active) || '';
  if (!state.chats.some((c) => c.id === state.activeId)) {
    state.activeId = state.chats[0]?.id || '';
  }
  return state.chats;
}

export function activeChat() {
  return state.chats.find((c) => c.id === state.activeId) || null;
}

export function newChat() {
  const chat = {
    id: uid(),
    title: 'New chat',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    model: state.model,
    messages: [],
    files: [],           // workspace manifest: everything ever attached here
  };
  state.chats.unshift(chat);
  state.activeId = chat.id;
  persist();
  return chat;
}

export function ensureChat() {
  return activeChat() || newChat();
}

export function selectChat(id) {
  state.activeId = id;
  localStorage.setItem(LS.active, id);
  const chat = activeChat();
  if (chat?.model) state.model = chat.model;
}

export function deleteChat(id) {
  const i = state.chats.findIndex((c) => c.id === id);
  if (i < 0) return;
  state.chats.splice(i, 1);
  if (state.activeId === id) state.activeId = state.chats[0]?.id || '';
  persist();
}

export function renameChat(id, title) {
  const chat = state.chats.find((c) => c.id === id);
  if (!chat) return;
  chat.title = title.trim().slice(0, 90) || 'Untitled chat';
  chat.updatedAt = Date.now();
  persist();
}

export function touch(chat) {
  chat.updatedAt = Date.now();
  const i = state.chats.indexOf(chat);
  if (i > 0) { state.chats.splice(i, 1); state.chats.unshift(chat); }
  persist();
}

/**
 * Mirror chats into localStorage. Attachment text is the first thing
 * sacrificed when the quota complains, since the conversation itself
 * matters more than being able to re-send a zip after a refresh.
 */
export function persist() {
  localStorage.setItem(LS.active, state.activeId);
  if (writeJSON(localStorage, LS.chats, state.chats)) return true;

  const slim = JSON.parse(JSON.stringify(state.chats));
  const carriers = [];
  for (const chat of slim) {
    for (const m of chat.messages || []) {
      for (const a of m.attachments || []) {
        if (a.text || a.dataUrl) carriers.push({ a, at: m.at || chat.createdAt });
      }
    }
  }
  carriers.sort((x, y) => x.at - y.at);
  for (const c of carriers) {
    c.a.text = '';
    c.a.dataUrl = '';
    c.a.dropped = true;
    if (writeJSON(localStorage, LS.chats, slim)) return true;
  }

  /* Still too big — keep the newest handful of chats only. */
  for (let keep = Math.min(8, slim.length); keep >= 1; keep--) {
    if (writeJSON(localStorage, LS.chats, slim.slice(0, keep))) return true;
  }
  return false;
}

export function storageUsed() {
  let n = 0;
  for (const k of Object.values(LS)) n += (localStorage.getItem(k) || '').length;
  return n * 2; // UTF-16 code units
}

/* ---------- export / wipe ---------- */

export function exportBundle() {
  return {
    app: 'blueprint',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    model: state.model,
    chats: state.chats.map((c) => ({
      ...c,
      messages: c.messages.map((m) => ({
        ...m,
        attachments: (m.attachments || []).map(({ dataUrl, ...rest }) => rest),
      })),
    })),
  };
}

export function wipeAll() {
  for (const k of Object.values(LS)) localStorage.removeItem(k);
  sessionStorage.removeItem(LS.key);
  state.chats = [];
  state.activeId = '';
  state.key = '';
  state.keyInfo = null;
  state.settings = { ...DEFAULTS };
}
