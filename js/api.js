/* ============================================================
   api.js — the only file that talks to OpenRouter
   ============================================================
   The key travels from the browser straight to openrouter.ai.
   Nothing here touches any other origin.
   ============================================================ */

import { API, APP_TITLE, MODEL_PREFERENCE, FALLBACK_MODEL } from './config.js';
import { state } from './store.js';

function headers(json = true) {
  const h = {
    Authorization: `Bearer ${state.key}`,
    'HTTP-Referer': location.origin === 'null' ? 'https://localhost' : location.origin,
    'X-Title': APP_TITLE,
  };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

/** Pull a human-readable reason out of whatever OpenRouter returned. */
async function readError(res) {
  let detail = '';
  try {
    const body = await res.json();
    detail =
      body?.error?.message ||
      body?.error?.metadata?.raw ||
      body?.message ||
      JSON.stringify(body).slice(0, 300);
  } catch {
    try { detail = (await res.text()).slice(0, 300); } catch { /* empty body */ }
  }

  const hint = {
    401: 'That key was rejected. Check it at openrouter.ai/settings/keys.',
    402: 'Out of credit for this model. Top up at openrouter.ai/credits or pick a cheaper model.',
    403: 'This key is not allowed to use that model — some need extra permissions on your account.',
    404: 'No model with that ID. Open the model picker and choose from the live list.',
    408: 'The request timed out on OpenRouter’s side. Try again.',
    413: 'The request was too large. Trim the attached files or lower the history depth in settings.',
    429: 'Rate limited. Wait a moment, or switch off the free variant of this model.',
    502: 'The upstream provider failed. Try again or switch models.',
    503: 'No provider is available for that model right now.',
  }[res.status];

  const err = new Error(detail || hint || `Request failed (${res.status})`);
  err.status = res.status;
  err.hint = hint;
  return err;
}

/* ------------------------------------------------------------
   key + catalogue
   ------------------------------------------------------------ */

/** Validate the current key. Resolves with account info, or throws. */
export async function checkKey() {
  const res = await fetch(`${API}/key`, { headers: headers(false) });
  if (!res.ok) throw await readError(res);
  const { data } = await res.json();
  state.keyInfo = data || null;
  return state.keyInfo;
}

/** The full public model catalogue, normalised into what the UI needs. */
export async function fetchModels() {
  const res = await fetch(`${API}/models`, { headers: state.key ? headers(false) : undefined });
  if (!res.ok) throw await readError(res);
  const { data } = await res.json();

  const models = (data || [])
    .map((m) => {
      const inputs = m.architecture?.input_modalities || [];
      const promptPrice = Number(m.pricing?.prompt ?? 0);
      const outPrice = Number(m.pricing?.completion ?? 0);
      return {
        id: m.id,
        name: m.name || m.id,
        context: m.context_length || m.top_provider?.context_length || 0,
        maxOut: m.top_provider?.max_completion_tokens || null,
        vision: inputs.includes('image'),
        files: inputs.includes('file'),
        promptPrice,
        outPrice,
        free: promptPrice === 0 && outPrice === 0,
        vendor: (m.id.split('/')[0] || '').toLowerCase(),
        params: m.supported_parameters || [],
        blurb: (m.description || '').slice(0, 400),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  state.models = models;
  state.modelsFetchedAt = Date.now();
  return models;
}

/**
 * Pick a sensible model when the user hasn't chosen one.
 * Honours MODEL_PREFERENCE, so "claude fable 5" is taken if the
 * catalogue has it and something reasonable is used if it doesn't.
 */
export function pickDefaultModel(models) {
  for (const rx of MODEL_PREFERENCE) {
    const hit = models.find((m) => rx.test(m.id) || rx.test(m.name));
    if (hit) return hit.id;
  }
  return models[0]?.id || FALLBACK_MODEL.id;
}

export function findModel(id) {
  return state.models.find((m) => m.id === id) || null;
}

export function priceLine(m) {
  if (!m) return '';
  if (m.free) return 'free';
  const inM = m.promptPrice * 1e6;
  const outM = m.outPrice * 1e6;
  const fmt = (v) => (v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`);
  return `${fmt(inM)} in · ${fmt(outM)} out /M`;
}

/* ------------------------------------------------------------
   chat completions
   ------------------------------------------------------------ */

/**
 * Send a turn. Streams by default and reports progress through callbacks.
 *
 * @param {object} opts
 * @param {string} opts.model
 * @param {Array} opts.messages          OpenAI-shaped messages
 * @param {number} [opts.temperature]
 * @param {number|null} [opts.maxTokens]
 * @param {boolean} [opts.stream]
 * @param {Array} [opts.plugins]         e.g. the file-parser plugin for PDFs
 * @param {AbortSignal} [opts.signal]
 * @param {(chunk:string)=>void} [opts.onText]
 * @param {(chunk:string)=>void} [opts.onReasoning]
 * @param {(usage:object)=>void} [opts.onUsage]
 * @returns {Promise<{text:string, reasoning:string, usage:object|null, finish:string}>}
 */
export async function sendChat(opts) {
  const {
    model, messages, temperature = 0.7, maxTokens = null,
    stream = true, plugins, signal, onText, onReasoning, onUsage,
  } = opts;

  const body = {
    model,
    messages,
    stream,
    usage: { include: true },
  };
  if (typeof temperature === 'number') body.temperature = temperature;
  if (maxTokens) body.max_tokens = maxTokens;
  if (plugins?.length) body.plugins = plugins;

  const res = await fetch(`${API}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) throw await readError(res);

  /* ---- non-streaming ---- */
  if (!stream) {
    const data = await res.json();
    if (data.error) {
      const e = new Error(data.error.message || 'The model returned an error.');
      e.status = data.error.code;
      throw e;
    }
    const choice = data.choices?.[0] || {};
    const msg = choice.message || {};
    const text = typeof msg.content === 'string'
      ? msg.content
      : (msg.content || []).map((p) => p.text || '').join('');
    const reasoning = msg.reasoning || msg.reasoning_content || '';
    if (text) onText?.(text);
    if (reasoning) onReasoning?.(reasoning);
    if (data.usage) onUsage?.(data.usage);
    return { text, reasoning, usage: data.usage || null, finish: choice.finish_reason || 'stop' };
  }

  /* ---- streaming (server-sent events) ---- */
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';
  let usage = null;
  let finish = 'stop';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    /* Frames are separated by a blank line; keep any partial tail.
       The SSE spec allows LF, CRLF or CR line endings and proxies do rewrite
       them, so accept either rather than trusting OpenRouter's plain \n.
       A separator straddling two reads stays in the buffer and splits on the
       next pass, which is the same path a half-received frame already takes. */
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || '';

    for (const frame of frames) {
      for (const line of frame.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;      // keep-alive comment
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') { buffer = ''; continue; }

        let json;
        try { json = JSON.parse(payload); } catch { continue; }

        if (json.error) {
          const e = new Error(json.error.message || 'The model stopped with an error.');
          e.status = json.error.code;
          throw e;
        }

        const choice = json.choices?.[0];
        const delta = choice?.delta || {};

        if (typeof delta.content === 'string' && delta.content) {
          text += delta.content;
          onText?.(delta.content);
        } else if (Array.isArray(delta.content)) {
          for (const part of delta.content) {
            if (part?.text) { text += part.text; onText?.(part.text); }
          }
        }

        const r = delta.reasoning ?? delta.reasoning_content;
        if (typeof r === 'string' && r) { reasoning += r; onReasoning?.(r); }

        if (choice?.finish_reason) finish = choice.finish_reason;
        if (json.usage) { usage = json.usage; onUsage?.(usage); }
      }
    }
  }

  return { text, reasoning, usage, finish };
}
