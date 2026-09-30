/* =========================================================
   QW3N — app logic
   ========================================================= */

const $ = (sel) => document.querySelector(sel);

const DEFAULTS = {
  temperature: 0.8,
  top_p: 0.9,
  top_k: 40,
  num_ctx: 8192,
  num_predict: 2048,
  repeat_penalty: 1.1,
};

const LS = {
  model: 'qwen.model',
  system: 'qwen.system',
  options: 'qwen.options',
  lastChat: 'qwen.lastChat',
};

const state = {
  models: [],
  online: true,
  model: null,
  system: '',
  options: { ...DEFAULTS },
  chats: [],
  chatId: null,
  messages: [],
  streaming: false,
  controller: null,
  streamEl: null,
  follow: true,
  seq: 0,
  authed: false,
  setupComplete: true,
};

/* message ids must not collide with the ones already on disk */
function syncSeq(messages) {
  const highest = messages.reduce((max, m) => {
    const n = Number(String(m.id || '').replace(/^m/, ''));
    return Number.isFinite(n) ? Math.max(max, n) : max;
  }, 0);
  state.seq = Math.max(state.seq, highest);
}

/* ---------------- prefs ---------------- */

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS.options) || '{}');
    state.options = { ...DEFAULTS, ...saved };
  } catch (_) { /* defaults */ }
  state.system = localStorage.getItem(LS.system) || '';
}

function savePref(key, value) {
  try { localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)); } catch (_) {}
}

/* ---------------- access gate ---------------- */

function lockGate(message) {
  const gate = $('#gate');
  if (!gate) return;
  gate.classList.add('show');
  const input = $('#gateToken');
  if (message) $('#gateErr').textContent = message;
  setTimeout(() => input && input.focus(), 260);
}

function unlockGate() {
  $('#gate').classList.remove('show');
  $('#gateErr').textContent = '';
  $('#gateToken').value = '';
}

async function checkSession() {
  try {
    const res = await fetch('/api/session', { credentials: 'same-origin' });
    const data = await res.json();
    state.authed = !data.authRequired || !!data.authed;
    state.setupComplete = data.setupCompleted !== false;
    if (!state.authed) lockGate();
    return state.authed;
  } catch (_) {
    return true;
  }
}

async function submitGate(event) {
  event.preventDefault();
  const input = $('#gateToken');
  const button = $('#gateSubmit');
  const token = input.value.trim();
  if (!token) return;
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      unlockGate();
      toast('unlocked');
      await checkSession();
      if (!state.setupComplete) {
        await Setup.start();
        return;
      }
      await loadModels();
      await loadChats();
      const last = localStorage.getItem(LS.lastChat);
      if (last && state.chats.some((c) => c.id === last)) await openChat(last);
      else render();
      $('#input').focus();
    } else {
      $('#gateErr').textContent = data.error || 'that token was not accepted';
      input.select();
    }
  } catch (_) {
    $('#gateErr').textContent = 'could not reach the server';
  } finally {
    button.disabled = false;
    button.textContent = 'Unlock';
  }
}

async function shareLink() {
  const url = location.origin;
  const lan = location.hostname === '127.0.0.1' || location.hostname === 'localhost'
    ? null
    : url;
  try {
    await navigator.clipboard.writeText(lan || url);
    toast(lan ? 'LAN address copied' : 'address copied');
  } catch (_) {
    copyText(url);
  }
}

async function showSetupState() {
  const note = $('#setupState');
  const button = $('#rerunSetup');
  if (!note) return;
  try {
    const data = await api('/api/setup');
    const missing = data.pending || [];
    note.textContent = data.completed
      ? `Finished with ${data.model}. ${missing.length} step(s) are missing again.`
      : `${missing.length} step(s) still to do.`;
    if (button) {
      button.disabled = !data.enabled;
      button.title = data.enabled ? '' : 'Restart the server with --setup';
    }
  } catch (_) {
    note.textContent = 'unavailable';
  }
}

async function rerunSetup() {
  try {
    await api('/api/setup/reset', { method: 'POST' });
    toast('installer reopened');
    setTimeout(() => location.reload(), 400);
  } catch (err) {
    toast(err.message || 'could not reopen the installer');
  }
}

/* ---------------- api ---------------- */

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (res.status === 401) {
    lockGate();
    throw new Error('locked');
  }
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).error || detail; } catch (_) {}
    throw new Error(detail);
  }
  return res.json();
}

/* ---------------- utils ---------------- */

function bytes(n) {
  if (!n) return '';
  const gb = n / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
}

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 1900);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('copied');
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('copied');
  }
}

function deriveTitle(messages) {
  const first = messages.find((m) => m.role === 'user' && m.content.trim());
  if (!first) return 'Untitled';
  return first.content.trim().replace(/\s+/g, ' ').slice(0, 48);
}

/* ---------------- models ---------------- */

async function loadModels() {
  const select = $('#model');
  try {
    const data = await api('/api/models');
    state.online = data.online;
    state.models = data.models || [];
    select.innerHTML = '';
    if (!state.models.length) {
      select.innerHTML = '<option>no models found</option>';
      select.disabled = true;
    } else {
      select.disabled = false;
      state.models.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m.name;
        opt.textContent = m.name;
        select.appendChild(opt);
      });
      const saved = localStorage.getItem(LS.model);
      const wanted = state.models.some((m) => m.name === saved)
        ? saved
        : (state.models.some((m) => m.name === data.default) ? data.default : state.models[0].name);
      setModel(wanted);
    }
  } catch (_) {
    state.online = false;
    select.innerHTML = '<option>ollama unreachable</option>';
    select.disabled = true;
  }
  setConnection(state.online);
  updateModelMeta();
}

function setModel(name) {
  state.model = name;
  $('#model').value = name;
  updateModelMeta();
  savePref(LS.model, name);
}

function updateModelMeta() {
  const m = state.models.find((x) => x.name === state.model);
  $('#modelMeta').textContent = m
    ? [m.params, m.quant, bytes(m.size), `${(m.context / 1024).toFixed(0)}k ctx`].filter(Boolean).join('  ·  ')
    : '';
}

function setConnection(online) {
  const dot = $('#statusDot');
  dot.className = `dot ${online ? 'on' : 'off'}`;
  $('#statusText').textContent = online ? 'ollama online' : 'ollama offline';
}

/* ---------------- threads ---------------- */

async function loadChats() {
  try {
    const data = await api('/api/chats');
    state.chats = data.chats || [];
    renderThreads();
  } catch (_) {}
}

function renderThreads() {
  const list = $('#threads');
  if (!state.chats.length) {
    list.innerHTML = '<div class="thread" style="cursor:default;opacity:.55">No conversations yet</div>';
    return;
  }
  list.innerHTML = state.chats
    .map(
      (c) => `
      <div class="thread ${c.id === state.chatId ? 'active' : ''}" data-id="${c.id}">
        <span class="thread-title">${escapeHtml(c.title)}</span>
        <button class="thread-del" data-del="${c.id}" title="Delete">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>
          </svg>
        </button>
      </div>`
    )
    .join('');
}

async function refreshChatMeta() {
  if (!state.chatId) return;
  const entry = state.chats.find((c) => c.id === state.chatId);
  if (entry) {
    entry.title = deriveTitle(state.messages);
    entry.count = state.messages.length;
    entry.model = state.model;
  }
  renderThreads();
}

let saveTimer = null;
function save() {
  if (!state.chatId) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await api('/api/chats', {
        method: 'PUT',
        body: JSON.stringify({
          id: state.chatId,
          title: deriveTitle(state.messages),
          model: state.model,
          system: state.system,
          messages: state.messages.filter((m) => !m.streaming),
        }),
      });
      await loadChats();
    } catch (_) {}
  }, 500);
}

function saveNow() {
  clearTimeout(saveTimer);
  save();
}

function newChat() {
  state.chatId = null;
  state.messages = [];
  savePref(LS.lastChat, '');
  closeSidebar();
  render();
  $('#input').focus();
}

async function openChat(id) {
  if (state.streaming) stop();
  try {
    const data = await api(`/api/chats/${id}`);
    state.chatId = data.id;
    state.messages = (data.messages || []).map((m) => ({ ...m, streaming: false }));
    syncSeq(state.messages);
    if (data.model) setModel(data.model);
    savePref(LS.lastChat, id);
    closeSidebar();
    render();
    scrollBottom(true);
  } catch (err) {
    if (err.message !== 'locked') toast(`could not open chat: ${err.message}`);
  }
}

async function removeChat(id) {
  try {
    await api(`/api/chats/${id}`, { method: 'DELETE' });
    if (state.chatId === id) newChat();
    await loadChats();
    toast('moved to data/.trash');
  } catch (err) {
    if (err.message !== 'locked') toast(`delete failed: ${err.message}`);
  }
}

/* ---------------- rendering ---------------- */

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* Qwen3 emits <think>...</think> inline. Surface it as a collapsible
   block instead of dumping it into the answer. */
function renderAssistant(content, streaming) {
  const source = String(content || '');
  const parts = [];
  let rest = source;
  let match;

  while ((match = /<\s*think\s*>([\s\S]*?)(?:<\s*\/\s*think\s*>|$)/i.exec(rest))) {
    if (match.index > 0) parts.push({ think: false, text: rest.slice(0, match.index) });
    const thought = match[1].trim();
    if (thought) parts.push({ think: true, text: thought });
    rest = rest.slice(match.index + match[0].length);
  }
  if (rest) parts.push({ think: false, text: rest });

  return parts
    .map((p) => {
      if (!p.think) return MD.render(p.text.replace(/<\s*\/?\s*think\s*>/gi, ''));
      const open = streaming ? ' open' : '';
      return (
        `<details class="think"${open}>` +
          `<summary><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg>Reasoning</summary>` +
          `<div class="think-body">${MD.render(p.text)}</div>` +
        `</details>`
      );
    })
    .join('');
}

function messageHtml(msg) {
  const isUser = msg.role === 'user';
  const classes = ['msg', isUser ? 'user' : 'assistant'];
  if (msg.error) classes.push('error');

  let body;
  if (msg.error) {
    body = escapeHtml(msg.content);
  } else if (isUser) {
    body = escapeHtml(msg.content).replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>');
  } else {
    body = renderAssistant(msg.content, msg.streaming) + (msg.streaming ? '<span class="caret"></span>' : '');
  }

  const stats = msg.stats && msg.stats.ms
    ? `<div class="msg-stats">${(msg.stats.ms / 1000).toFixed(1)}s · ${msg.stats.tps.toFixed(1)} tok/s · ${msg.stats.tokens} tokens</div>`
    : '';

  const actions = isUser
    ? `<button class="chip" data-act="copy" data-id="${msg.id}">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
         copy
       </button>`
    : `<button class="chip" data-act="regen" data-id="${msg.id}">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>
         regenerate
       </button>
       <button class="chip" data-act="copy" data-id="${msg.id}">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
         copy
       </button>`;

  const name = isUser ? 'You' : (msg.model || state.model || 'model');

  return `
    <div class="${classes.join(' ')}" data-mid="${msg.id}">
      <div class="msg-head">
        <span class="avatar ${isUser ? 'me' : 'bot'}">${isUser ? 'YOU' : 'AI'}</span>
        <span>${escapeHtml(name)}</span>
      </div>
      <div class="msg-body">${body}</div>
      ${stats}
      <div class="msg-actions">${msg.streaming ? '' : actions}</div>
    </div>`;
}

const SUGGESTIONS = [
  ['Explain ports and processes', 'I keep mixing up ports, processes and sockets. Explain the difference with a concrete analogy.'],
  ['Write a bash script', 'Write a bash script that finds the 10 largest files in the current directory and prints their sizes.'],
  ['Debug this Python', 'Explain what causes a RecursionError in Python and show three ways to fix it.'],
  ['Compare my local models', 'I run local LLMs on a Mac. Explain how model size, quantization and RAM interact with generation speed.'],
];

function render() {
  const host = $('#thread');
  if (!state.messages.length) {
    host.innerHTML = `
      <div class="empty">
        <div class="empty-mark">QW</div>
        <h1>${escapeHtml(state.model || 'Local model')}</h1>
        <p>Runs entirely on your machine. Ollama serves the model, this page handles the conversation.</p>
        <div class="suggestions">
          ${SUGGESTIONS.map(([label, text]) => `<button class="suggestion" data-suggest="${escapeHtml(text)}"><b>${escapeHtml(label)}</b>${escapeHtml(text.slice(0, 62))}…</button>`).join('')}
        </div>
      </div>`;
    return;
  }
  host.innerHTML = state.messages.map(messageHtml).join('');
  state.streamEl = host.querySelector('.msg.streaming') || null;
}

function appendMessage(msg) {
  state.messages.push(msg);
  if ($('#thread').querySelector('.empty')) render();
  $('#thread').insertAdjacentHTML('beforeend', messageHtml(msg));
}

function updateMessageEl(msg) {
  const host = $('#thread');
  if (host.querySelector('.empty')) render();
  const el = host.querySelector(`[data-mid="${msg.id}"]`);
  if (!el) {
    $('#thread').insertAdjacentHTML('beforeend', messageHtml(msg));
    return;
  }
  el.outerHTML = messageHtml(msg);
}

function scrollBottom(force = false) {
  const box = $('#stream');
  if (force || state.follow) box.scrollTop = box.scrollHeight;
}

/* ---------------- generation ---------------- */

function historyFor() {
  const out = [];
  if (state.system.trim()) out.push({ role: 'system', content: state.system.trim() });
  state.messages
    .filter((m) => !m.error && !m.streaming && m.content.trim())
    .forEach((m) => out.push({ role: m.role, content: m.content }));
  return out;
}

async function send(text) {
  if (state.streaming) return;
  const content = (text ?? $('#input').value).trim();
  if (!content) return;

  if (!state.chatId) {
    try {
      const created = await api('/api/chats', {
        method: 'POST',
        body: JSON.stringify({ title: 'Untitled', model: state.model, system: state.system, messages: [] }),
      });
      state.chatId = created.id;
      savePref(LS.lastChat, state.chatId);
      await loadChats();
    } catch (err) {
      toast(`storage error: ${err.message}`);
      return;
    }
  }

  appendMessage({ id: `m${++state.seq}`, role: 'user', content });
  $('#input').value = '';
  autoGrow();
  scrollBottom();
  saveNow();
  await generate();
}

async function regenerate() {
  if (state.streaming) return;
  const last = [...state.messages].reverse().find((m) => m.role === 'assistant');
  if (last) {
    state.messages = state.messages.filter((m) => m !== last);
    render();
  }
  await generate();
}

async function generate() {
  const history = historyFor();
  if (!history.length) return;

  const msg = {
    id: `m${++state.seq}`,
    role: 'assistant',
    content: '',
    model: state.model,
    streaming: true,
  };

  appendMessage(msg);
  scrollBottom();

  state.streaming = true;
  state.controller = new AbortController();
  setComposerState('streaming');
  setStatus('generating');
  const t0 = performance.now();

  let pending = '';

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: state.model, messages: history, options: state.options }),
      signal: state.controller.signal,
    });

    if (res.status === 401) {
      lockGate();
      throw new Error('locked');
    }

    if (!res.ok || !res.body) {
      let detail = `HTTP ${res.status}`;
      try { detail = (await res.json()).error || detail; } catch (_) {}
      throw new Error(detail);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });

      const lines = pending.split('\n');
      pending = lines.pop() || '';

      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let json;
        try { json = JSON.parse(payload); } catch (_) { continue; }

        if (json.error) throw new Error(json.error);

        const chunk = json.message && json.message.content;
        if (chunk) {
          msg.content += chunk;
          updateMessageEl(msg);
          scrollBottom();
        }

        if (json.done) {
          const seconds = (json.eval_duration || 0) / 1e9;
          msg.stats = {
            ms: performance.now() - t0,
            tokens: json.eval_count || 0,
            tps: seconds ? (json.eval_count || 0) / seconds : 0,
          };
        }
      }
    }

    if (!msg.content.trim()) throw new Error('empty response from model');
    if (!msg.stats) msg.stats = { ms: performance.now() - t0, tokens: 0, tps: 0 };

    setStatus('ready');
  } catch (err) {
    const stopped = err.name === 'AbortError';
    if (stopped) {
      setStatus('stopped');
      if (!msg.content.trim()) {
        state.messages = state.messages.filter((m) => m !== msg);
        render();
      }
    } else {
      setStatus('error');
      msg.error = true;
      msg.streaming = false;
      msg.content = err.message === 'locked'
        ? ''
        : err.message.includes('fetch')
        ? 'Could not reach the server. Is it still running? (python3 server.py)'
        : err.message;
    }
  }

  msg.streaming = false;
  const inDom = state.messages.includes(msg);
  if (inDom) updateMessageEl(msg);
  if (!msg.error && !msg.content.trim()) state.messages = state.messages.filter((m) => m !== msg);

  state.streaming = false;
  state.controller = null;
  setComposerState('idle');
  scrollBottom();
  saveNow();
  refreshChatMeta();
  $('#input').focus();
}

function stop() {
  if (state.controller) state.controller.abort();
}

/* ---------------- composer ---------------- */

function setComposerState(mode) {
  const btn = $('#send');
  btn.classList.toggle('stop', mode === 'streaming');
  btn.innerHTML = mode === 'streaming'
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13"/><path d="M12 5l7 7-7 7"/></svg>';
  btn.disabled = mode === 'idle' && !$('#input').value.trim();
}

function setStatus(text) {
  $('#genStatus').textContent = text;
}

function autoGrow() {
  const el = $('#input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 220) + 'px';
  setComposerState(state.streaming ? 'streaming' : 'idle');
}

/* ---------------- panels ---------------- */

function toggleDrawer(open) {
  $('#drawer').classList.toggle('show', open);
  $('#scrim').classList.toggle('show', open);
}

function toggleLearn(open) {
  $('#learn').classList.toggle('show', open);
  if (open) $('#learnBody').scrollTop = 0;
}

function closeSidebar() {
  $('#side').classList.remove('show');
  $('#scrim').classList.remove('show');
}

function openSidebar() {
  $('#side').classList.add('show');
  $('#scrim').classList.add('show');
}

/* ---------------- settings ---------------- */

const PARAMS = [
  ['temperature', 'Temperature', 0, 2, 0.05, 'Lower = focused and repetitive, higher = more random.'],
  ['top_p', 'Top-p', 0.05, 1, 0.05, 'Nucleus sampling cutoff.'],
  ['top_k', 'Top-k', 1, 100, 1, 'Restricts sampling to the k most likely tokens.'],
  ['repeat_penalty', 'Repeat penalty', 1, 1.5, 0.01, 'Discourages repeating the same tokens.'],
  ['num_ctx', 'Context window', 1024, 32768, 1024, 'How much conversation the model can hold. More = more RAM.'],
  ['num_predict', 'Max new tokens', 128, 8192, 128, 'Upper bound on reply length.'],
];

function buildParams() {
  $('#params').innerHTML = PARAMS.map(
    ([key, label, min, max, step, hint]) => `
      <div class="field">
        <label for="p-${key}">${label}<span class="val" id="v-${key}"></span></label>
        <input type="range" id="p-${key}" data-param="${key}" min="${min}" max="${max}" step="${step}">
        <div class="hint">${hint}</div>
      </div>`
  ).join('');

  $('#params').addEventListener('input', (e) => {
    const key = e.target.dataset.param;
    if (!key) return;
    state.options[key] = parseFloat(e.target.value);
    $(`#v-${key}`).textContent = formatParam(key, state.options[key]);
    savePref(LS.options, state.options);
  });
}

function formatParam(key, value) {
  if (key === 'num_ctx' || key === 'num_predict') return `${value} tok`;
  if (key === 'top_k') return String(Math.round(value));
  return Number(value).toFixed(2);
}

function syncParams() {
  PARAMS.forEach(([key]) => {
    const el = $(`#p-${key}`);
    if (!el) return;
    el.value = state.options[key];
    $(`#v-${key}`).textContent = formatParam(key, state.options[key]);
  });
  $('#sysPrompt').value = state.system;
}

function resetParams() {
  state.options = { ...DEFAULTS };
  savePref(LS.options, state.options);
  syncParams();
  toast('params reset');
}

/* ---------------- events ---------------- */

function wire() {
  $('#send').addEventListener('click', () => (state.streaming ? stop() : send()));

  $('#input').addEventListener('input', autoGrow);

  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!state.streaming) send();
    }
  });

  $('#model').addEventListener('change', (e) => setModel(e.target.value));
  $('#btnNew').addEventListener('click', newChat);
  $('#btnSettings').addEventListener('click', () => toggleDrawer(!$('#drawer').classList.contains('show')));
  $('#btnLearn').addEventListener('click', () => toggleLearn(true));
  $('#learnClose').addEventListener('click', () => toggleLearn(false));
  $('#drawerClose').addEventListener('click', () => toggleDrawer(false));
  $('#scrim').addEventListener('click', () => { toggleDrawer(false); closeSidebar(); });
  $('#burger').addEventListener('click', openSidebar);
  $('#resetParams').addEventListener('click', resetParams);
  $('#dropChat').addEventListener('click', () => {
    if (state.chatId) removeChat(state.chatId);
    else newChat();
    toggleDrawer(false);
  });

  $('#sysPrompt').addEventListener('input', (e) => {
    state.system = e.target.value;
    savePref(LS.system, state.system);
  });

  $('#threads').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      removeChat(del.dataset.del);
      return;
    }
    const row = e.target.closest('[data-id]');
    if (row) openChat(row.dataset.id);
  });

  $('#gateForm').addEventListener('submit', submitGate);
  $('#btnShare').addEventListener('click', shareLink);
  $('#rerunSetup').addEventListener('click', rerunSetup);
  showSetupState();

  $('#stream').addEventListener('click', (e) => {
    const copyBtn = e.target.closest('[data-copy-code]');
    if (copyBtn) {
      copyText(copyBtn.closest('.code').querySelector('code').textContent);
      return;
    }
    const suggest = e.target.closest('[data-suggest]');
    if (suggest) {
      send(suggest.dataset.suggest);
      return;
    }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const msg = state.messages.find((m) => m.id === act.dataset.id);
    if (!msg) return;
    if (act.dataset.act === 'copy') copyText(msg.content);
    if (act.dataset.act === 'regen') regenerate();
  });

  $('#stream').addEventListener('scroll', () => {
    const box = $('#stream');
    state.follow = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      toggleDrawer(false);
      toggleLearn(false);
      closeSidebar();
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      newChat();
    }
  });
}

/* ---------------- boot ---------------- */

async function init() {
  loadPrefs();
  buildParams();
  syncParams();
  wire();

  if (window.matchMedia('(max-width: 520px)').matches) {
    $('#input').placeholder = 'Send a message…';
  }

  if (!(await checkSession())) {
    autoGrow();
    return;
  }

  // first run: hand over to the guided installer instead of the chat
  if (!state.setupComplete) {
    await Setup.start();
    return;
  }

  await loadModels();
  await loadChats();

  const last = localStorage.getItem(LS.lastChat);
  if (last && state.chats.some((c) => c.id === last)) {
    await openChat(last);
  } else {
    render();
  }

  if (!state.online) {
    toast('Ollama is not reachable — start it with: ollama serve');
  }

  autoGrow();
  $('#input').focus();
}

init();