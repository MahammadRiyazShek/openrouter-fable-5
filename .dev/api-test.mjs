/* Runtime tests for api.js (SSE streaming, error mapping) and store.js
   (persistence, quota pruning). Run with: node api-test.mjs */

import './shim.mjs';
import { state, newChat, activeChat, persist, loadChats, renameChat, deleteChat, wipeAll, estTokens } from '../js/store.js';
import { sendChat, fetchModels, pickDefaultModel, priceLine, checkKey } from '../js/api.js';

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; } else { fail++; console.log(`FAIL ${label}${extra ? '  ' + extra : ''}`); }
};
const eq = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  ok(label, a === b, `\n   got  ${a}\n   want ${b}`);
};

/* ---------- a fake fetch that replays SSE bytes in arbitrary slices ---------- */

function sseResponse(chunks, { status = 200 } = {}) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length
          ? { done: false, value: enc.encode(chunks[i++]) }
          : { done: true, value: undefined }),
      }),
    },
    json: async () => ({}),
    text: async () => '',
  };
}
const jsonResponse = (obj, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

const frame = (o) => `data: ${JSON.stringify(o)}\n\n`;
const delta = (content) => frame({ choices: [{ delta: { content } }] });

async function stream(chunks, opts = {}) {
  const seen = [];
  const reason = [];
  let usage = null;
  globalThis.fetch = async () => sseResponse(chunks);
  const r = await sendChat({
    model: 'x/y', messages: [], stream: true,
    onText: (t) => seen.push(t),
    onReasoning: (t) => reason.push(t),
    onUsage: (u) => { usage = u; },
    ...opts,
  });
  return { ...r, seen, reason, pushedUsage: usage };
}

/* ---------- 1. streaming basics ---------- */

state.key = 'sk-or-test';

{
  const r = await stream([delta('Hel'), delta('lo '), delta('world'), 'data: [DONE]\n\n']);
  eq('stream: text assembled', r.text, 'Hello world');
  eq('stream: onText per chunk', r.seen, ['Hel', 'lo ', 'world']);
  eq('stream: default finish', r.finish, 'stop');
}

/* A frame split across two network reads must still parse. */
{
  const whole = delta('split-ok');
  const cut = Math.floor(whole.length / 2);
  const r = await stream([whole.slice(0, cut), whole.slice(cut), 'data: [DONE]\n\n']);
  eq('stream: frame split mid-JSON', r.text, 'split-ok');
}

/* Several frames arriving in one read. */
{
  const r = await stream([delta('a') + delta('b') + delta('c')]);
  eq('stream: batched frames', r.text, 'abc');
}

/* A multi-byte character split across reads (UTF-8 boundary). */
{
  const whole = new TextEncoder().encode(delta('café ☕'));
  const a = whole.slice(0, 30), b = whole.slice(30);
  const dec = new TextDecoder();
  /* feed raw bytes rather than strings */
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    body: { getReader: () => { let n = 0; const parts = [a, b];
      return { read: async () => (n < parts.length ? { done: false, value: parts[n++] } : { done: true }) }; } },
  });
  const r = await sendChat({ model: 'x/y', messages: [], stream: true });
  eq('stream: utf-8 split across reads', r.text, 'café ☕');
  void dec;
}

/* ---------- 2. streaming odds and ends ---------- */

{
  const r = await stream([': keep-alive\n\n', delta('after ping'), ':\n\n', 'data: [DONE]\n\n']);
  eq('stream: keep-alive ignored', r.text, 'after ping');
}
{
  const r = await stream(['data: {not json}\n\n', delta('survived'), '\n\n']);
  eq('stream: bad JSON skipped', r.text, 'survived');
}
{
  const r = await stream([frame({ choices: [{ delta: { content: [{ type: 'text', text: 'arr' }, { type: 'text', text: 'ay' }] } }] })]);
  eq('stream: array content parts', r.text, 'array');
}
{
  const r = await stream([
    frame({ choices: [{ delta: { reasoning: 'thinking ' } }] }),
    frame({ choices: [{ delta: { reasoning_content: 'harder' } }] }),
    delta('answer'),
  ]);
  eq('stream: reasoning accumulates', r.reasoning, 'thinking harder');
  eq('stream: reasoning kept apart from text', r.text, 'answer');
}
{
  const r = await stream([delta('cut off'), frame({ choices: [{ delta: {}, finish_reason: 'length' }] })]);
  eq('stream: finish_reason captured', r.finish, 'length');
}
{
  const u = { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, cost: 0.0004 };
  const r = await stream([delta('hi'), frame({ choices: [{ delta: {} }], usage: u }), 'data: [DONE]\n\n']);
  eq('stream: usage returned', r.usage, u);
  eq('stream: onUsage fired', r.pushedUsage, u);
}
{
  let threw = null;
  try { await stream([frame({ error: { message: 'provider exploded', code: 502 } })]); }
  catch (e) { threw = e; }
  ok('stream: mid-stream error throws', threw?.message === 'provider exploded', threw?.message);
  ok('stream: error carries status', threw?.status === 502);
}
{
  const r = await stream([delta('no done marker')]); // stream just ends
  eq('stream: ends without [DONE]', r.text, 'no done marker');
}

/* ---------- 3. line endings (proxies rewrite them) ---------- */

{
  const crlf = 'data: {"choices":[{"delta":{"content":"hi"}}]}\r\n\r\ndata: [DONE]\r\n\r\n';
  const r = await stream([crlf]);
  eq('stream: CRLF frame separators', r.text, 'hi');
}
{
  /* The separator itself straddles two reads: "...}\r\n\r" then "\ndata:..." */
  const whole = 'data: {"choices":[{"delta":{"content":"ab"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"cd"}}]}\r\n\r\n';
  const cut = whole.indexOf('\r\n\r\n') + 3;
  const r = await stream([whole.slice(0, cut), whole.slice(cut)]);
  eq('stream: separator split across reads', r.text, 'abcd');
}
{
  const mixed = 'data: {"choices":[{"delta":{"content":"x"}}]}\n\r\ndata: {"choices":[{"delta":{"content":"y"}}]}\r\n\n';
  const r = await stream([mixed]);
  eq('stream: mixed LF/CRLF separators', r.text, 'xy');
}

/* ---------- 4. request body shape ---------- */

{
  let sent = null;
  globalThis.fetch = async (_url, init) => { sent = JSON.parse(init.body); return sseResponse(['data: [DONE]\n\n']); };
  await sendChat({ model: 'anthropic/claude-fable-5', messages: [{ role: 'user', content: 'hi' }], temperature: 0.3, maxTokens: 900, plugins: [{ id: 'file-parser' }] });
  eq('body: model', sent.model, 'anthropic/claude-fable-5');
  eq('body: usage accounting on', sent.usage, { include: true });
  eq('body: temperature', sent.temperature, 0.3);
  eq('body: max_tokens', sent.max_tokens, 900);
  eq('body: plugins passed', sent.plugins, [{ id: 'file-parser' }]);
  ok('body: stream flag', sent.stream === true);
}
{
  let sent = null;
  globalThis.fetch = async (_u, init) => { sent = JSON.parse(init.body); return sseResponse(['data: [DONE]\n\n']); };
  await sendChat({ model: 'm', messages: [], maxTokens: null, plugins: [] });
  ok('body: null maxTokens omitted', !('max_tokens' in sent));
  ok('body: empty plugins omitted', !('plugins' in sent));
}
{
  let hdrs = null;
  globalThis.fetch = async (_u, init) => { hdrs = init.headers; return sseResponse(['data: [DONE]\n\n']); };
  await sendChat({ model: 'm', messages: [] });
  eq('headers: bearer key', hdrs.Authorization, 'Bearer sk-or-test');
  eq('headers: app title', hdrs['X-Title'], 'Blueprint');
  ok('headers: referer set', typeof hdrs['HTTP-Referer'] === 'string' && hdrs['HTTP-Referer'].length > 0);
}

/* ---------- 5. non-streaming path ---------- */

{
  globalThis.fetch = async () => jsonResponse({
    choices: [{ message: { content: 'plain reply', reasoning: 'because' }, finish_reason: 'stop' }],
    usage: { total_tokens: 4 },
  });
  const seen = [];
  const r = await sendChat({ model: 'm', messages: [], stream: false, onText: (t) => seen.push(t) });
  eq('no-stream: text', r.text, 'plain reply');
  eq('no-stream: reasoning', r.reasoning, 'because');
  eq('no-stream: usage', r.usage, { total_tokens: 4 });
  eq('no-stream: onText called once', seen, ['plain reply']);
}
{
  globalThis.fetch = async () => jsonResponse({
    choices: [{ message: { content: [{ text: 'part1 ' }, { text: 'part2' }] } }],
  });
  const r = await sendChat({ model: 'm', messages: [], stream: false });
  eq('no-stream: array content', r.text, 'part1 part2');
  eq('no-stream: finish defaults', r.finish, 'stop');
}
{
  globalThis.fetch = async () => jsonResponse({ error: { message: 'bad model', code: 404 } });
  let threw = null;
  try { await sendChat({ model: 'm', messages: [], stream: false }); } catch (e) { threw = e; }
  eq('no-stream: body error throws', threw?.message, 'bad model');
}

/* ---------- 6. HTTP error mapping ---------- */

for (const [status, needle] of [[401, /rejected/i], [402, /credit/i], [429, /rate limited/i], [404, /model picker/i]]) {
  globalThis.fetch = async () => ({ ok: false, status, json: async () => ({}), text: async () => '' });
  let threw = null;
  try { await sendChat({ model: 'm', messages: [] }); } catch (e) { threw = e; }
  ok(`error ${status}: has hint`, needle.test(threw?.hint || ''), threw?.hint);
  ok(`error ${status}: carries status`, threw?.status === status);
}
{
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'temperature must be <= 2' } }), text: async () => '' });
  let threw = null;
  try { await sendChat({ model: 'm', messages: [] }); } catch (e) { threw = e; }
  eq('error: server message preferred', threw?.message, 'temperature must be <= 2');
}

/* ---------- 7. catalogue + default model ---------- */

{
  globalThis.fetch = async () => jsonResponse({ data: [
    { id: 'openai/gpt-4o', name: 'GPT-4o', context_length: 128000,
      architecture: { input_modalities: ['text', 'image'] }, pricing: { prompt: '0.0000025', completion: '0.00001' } },
    { id: 'anthropic/claude-fable-5', name: 'Claude Fable 5', context_length: 200000,
      architecture: { input_modalities: ['text', 'image', 'file'] }, pricing: { prompt: '0.000003', completion: '0.000015' },
      top_provider: { max_completion_tokens: 64000 }, supported_parameters: ['tools', 'reasoning'] },
    { id: 'meta/llama-free', name: 'Llama', context_length: 8192,
      architecture: { input_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' } },
  ] });
  const models = await fetchModels();
  eq('models: sorted by id', models.map((m) => m.id), ['anthropic/claude-fable-5', 'meta/llama-free', 'openai/gpt-4o']);
  const fable = models.find((m) => m.id === 'anthropic/claude-fable-5');
  ok('models: vision detected', fable.vision === true);
  ok('models: file input detected', fable.files === true);
  ok('models: context read', fable.context === 200000);
  ok('models: maxOut read', fable.maxOut === 64000);
  ok('models: vendor derived', fable.vendor === 'anthropic');
  ok('models: free flag', models.find((m) => m.id === 'meta/llama-free').free === true);
  ok('models: paid not free', fable.free === false);

  eq('default model: fable wins', pickDefaultModel(models), 'anthropic/claude-fable-5');
  eq('default model: falls back to sonnet', pickDefaultModel([
    { id: 'openai/gpt-4o', name: 'GPT-4o' }, { id: 'anthropic/claude-sonnet-4', name: 'Sonnet 4' },
  ]), 'anthropic/claude-sonnet-4');
  eq('default model: empty catalogue', pickDefaultModel([]), 'anthropic/claude-sonnet-4');
  eq('price line: paid', priceLine(fable), '$3.00 in · $15.00 out /M');
  eq('price line: free', priceLine(models.find((m) => m.free)), 'free');
}
{
  globalThis.fetch = async () => jsonResponse({ data: { label: 'k', limit: 10, usage: 2 } });
  const info = await checkKey();
  eq('checkKey: returns account info', info.limit, 10);
}

/* ---------- 8. store: chats + persistence ---------- */

wipeAll();
{
  const c = newChat();
  ok('store: newChat becomes active', activeChat()?.id === c.id);
  activeChat().messages.push({ id: 'm1', role: 'user', content: 'hello there', at: Date.now() });
  persist();
  const raw = localStorage.getItem('bp.chats.v1');
  ok('store: persisted to localStorage', !!raw && raw.includes('hello there'));

  state.chats = [];
  loadChats();
  eq('store: reloads from storage', activeChat()?.messages[0]?.content, 'hello there');

  renameChat(c.id, 'Renamed');
  eq('store: rename', activeChat().title, 'Renamed');

  const second = newChat();
  deleteChat(second.id);
  ok('store: delete removes chat', !state.chats.some((x) => x.id === second.id));
  ok('store: something stays active', !!activeChat());
}

/* Quota pressure: attachment payloads should be dropped before transcripts. */
{
  wipeAll();
  const c = newChat();
  c.messages.push({
    id: 'big', role: 'user', content: 'analyse this',
    attachments: [{ name: 'huge.txt', kind: 'text', text: 'x'.repeat(5000), bytes: 5000 }],
    at: Date.now(),
  });

  let attempts = 0;
  const real = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (k, v) => {
    if (k === 'bp.chats.v1' && attempts++ === 0) {
      const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e;
    }
    return real(k, v);
  };
  persist();
  localStorage.setItem = real;

  ok('store: retried after quota error', attempts >= 2, `attempts=${attempts}`);
  const saved = localStorage.getItem('bp.chats.v1') || '';
  ok('store: transcript survived pruning', saved.includes('analyse this'), saved.slice(0, 120));
  ok('store: payload dropped on retry', !saved.includes('x'.repeat(500)));
}

/* Token estimator sanity — it drives the pre-send context meter.
   Note the signature: it takes a character COUNT, not the string itself. */
{
  ok('estTokens: scales with length', estTokens(4000) > estTokens(400));
  ok('estTokens: never returns zero', estTokens(0) === 1);
  const t = estTokens('The quick brown fox jumps over the lazy dog.'.length);
  ok('estTokens: plausible magnitude', t > 6 && t < 24, String(t));
  ok('estTokens: 200k chars fits a 200k window estimate', estTokens(200_000) < 200_000);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
