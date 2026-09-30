/* =========================================================
   QW3N — setup & maintenance
   One page serves two jobs:
     · first run   — open automatically until it is finished or skipped
     · maintenance — the Setup button, any time after
   Exposes: window.Setup.boot(), .open(), .close()

   Wrapped in an IIFE on purpose: app.js also has a global render(),
   and two classic scripts cannot both own that name.
   ========================================================= */

(function () {
  const SETUP = {
    overview: null,
    info: null,
    results: {},
    running: false,
    busy: false,
    showToken: false,
    wired: false,
    firstRun: false,
  };

  const esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const ICON = {
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
    missing: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    skip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>',
    bad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    unknown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/></svg>',
  };

  const STATE_TEXT = {
    ok: 'ready',
    missing: 'needs doing',
    skip: 'not needed',
    bad: 'problem',
    unknown: 'unknown',
  };

  const host = () => document.querySelector('#setupPage');
  const inner = () => document.querySelector('#setupPageInner');
  const firstRun = () => SETUP.firstRun === true;

  /* ---------------- data ---------------- */

  async function jget(path) {
    const res = await fetch(path, { credentials: 'same-origin' });
    if (res.status === 401) {
      location.reload();
      return null;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function refresh() {
    const [overview, info] = await Promise.all([jget('/api/setup'), jget('/api/info')]);
    if (!overview) return false;
    SETUP.overview = overview;
    SETUP.info = info;
    return true;
  }

  /* ---------------- sections ---------------- */

  function summaryHtml() {
    const o = SETUP.overview;
    const i = SETUP.info;
    const missing = o.pending.length;
    const headline = missing
      ? `${missing} step${missing === 1 ? '' : 's'} left before you can chat`
      : 'Everything is installed already';

    const state = o.completed
      ? 'finished'
      : o.skipped
      ? 'skipped'
      : missing
      ? 'not finished'
      : 'ready to finish';

    return `
      <div class="msg assistant">
        <div class="msg-head">
          <span class="avatar bot">AI</span>
          <span>Setup &amp; maintenance</span>
        </div>
        <div class="msg-body">
          <p>${esc(headline)}. Each step below is checked against this machine, and the
          ones that are missing can be run from right here — the output appears as it
          goes, exactly like a command window.</p>
          <p>Nothing you type is ever sent to a shell. The server only knows about the
          fixed list of steps in <code class="inline">server.py</code>, and the runner
          disappears the moment you mark setup finished.</p>
          <div class="setup-bar">
            ${missing
              ? `<button class="btn primary" id="setupRunAll">Run the ${missing} remaining step${missing === 1 ? '' : 's'}</button>`
              : ''}
            ${o.completed
              ? '<button class="btn primary" data-close>Back to the chat</button>'
              : `<button class="btn primary" data-close>Skip to the chat</button>
                 <button class="btn" id="setupFinish">Mark setup finished</button>`}
          </div>
          <div class="kv">
            <span>installer</span><b>${esc(state)}</b>
            <span>runner</span><b>${o.enabled ? 'open' : 'closed'}</b>
            <span>model</span><b>${esc(i.setup.model)}</b>
            <span>ollama</span><b>${i.ollamaOnline ? 'online' : 'offline'} · ${esc(i.models)} installed</b>
          </div>
        </div>
      </div>`;
  }

  function modelPickerHtml() {
    const o = SETUP.overview;
    return `
      <label class="setup-field">
        <span>Model</span>
        <select class="model" id="setupModel">
          ${o.models
            .map(
              (m) => `<option value="${esc(m.name)}" ${m.name === o.model ? 'selected' : ''}>
                ${esc(m.name)} · ${esc(m.size)} — ${esc(m.note)}
              </option>`
            )
            .join('')}
        </select>
      </label>`;
  }

  function stepHtml(step) {
    const o = SETUP.overview;
    const result = SETUP.results[step.id];
    const failed = result && result.code !== 0;
    const shown = failed ? 'bad' : step.state;
    const detail = failed ? result.note || 'failed' : step.note || '';
    const canRun = step.runnable && o.enabled;

    let controls = '';
    if (step.runnable) {
      controls = `
        ${step.param === 'model' ? modelPickerHtml() : ''}
        <div class="setup-actions">
          <button class="btn" data-run="${esc(step.id)}" ${canRun ? '' : 'disabled'}>
            ${step.state === 'ok' ? 'Run again' : 'Run this step'}
          </button>
          ${o.enabled ? '' : '<span class="setup-note">runner closed — restart with --setup</span>'}
        </div>`;
    } else if (step.manual) {
      controls = `
        <div class="code">
          <div class="code-bar"><span>run in your terminal</span>
            <button type="button" data-copy="${esc(step.manual)}">copy</button></div>
          <pre><code>${esc(step.manual)}</code></pre>
        </div>
        <div class="setup-actions">
          <button class="btn" data-recheck="${esc(step.id)}">Check again</button>
        </div>`;
    } else {
      controls = '<div class="setup-actions"><button class="btn" data-recheck="' +
        esc(step.id) + '">Check again</button></div>';
    }

    const log = result
      ? `<div class="setup-log${result.log ? '' : ' empty'}">${esc(result.log || result.note || '')}</div>`
      : '';

    return `
      <div class="msg assistant step" data-step="${esc(step.id)}">
        <div class="msg-head">
          <span class="avatar bot">AI</span>
          <span>${esc(step.title)}</span>
        </div>
        <div class="msg-body">
          <p>${esc(step.body)}</p>
          <div class="step-status ${esc(shown)}">
            ${ICON[shown] || ICON.unknown}
            <span>${esc(STATE_TEXT[shown] || shown)}${detail ? ` — ${esc(detail)}` : ''}</span>
          </div>
          ${controls}
          ${log}
        </div>
      </div>`;
  }

  function accessHtml() {
    const i = SETUP.info;
    const lan = location.hostname === '127.0.0.1' || location.hostname === 'localhost'
      ? `http://${location.hostname}:${i.port}`
      : location.origin;
    const shown = i.authEnabled ? (SETUP.showToken ? i.token : '•'.repeat(24)) : 'auth disabled';

    return `
      <div class="msg assistant">
        <div class="msg-head">
          <span class="avatar bot">AI</span>
          <span>Getting to it from another device</span>
        </div>
        <div class="msg-body">
          <p>Same WiFi? Open the address below on your phone. Do not type
          <code class="inline">0.0.0.0</code> — that is a bind address, not a destination.</p>
          <div class="code">
            <div class="code-bar"><span>address</span>
              <button type="button" data-copy="${esc(lan)}">copy</button></div>
            <pre><code>${esc(lan)}</code></pre>
          </div>
          <div class="code">
            <div class="code-bar"><span>access token</span>
              <button type="button" id="setupReveal">${SETUP.showToken ? 'hide' : 'reveal'}</button>
              <button type="button" data-copy-token id="setupTokenCopy" ${SETUP.showToken && i.token ? '' : 'disabled'}>copy</button></div>
            <pre><code>${esc(shown)}</code></pre>
          </div>
          <p class="setup-note">iOS Safari blocks a list of ports it considers risky. If it
          refuses to open the page, restart on another one:
          <code class="inline">./run.sh --port 8000</code></p>
          <div class="setup-actions">
            ${i.authEnabled
              ? '<button class="btn" id="setupRotate">Generate a new token</button>'
              : '<span class="setup-note">auth is off (--no-auth) — there is no token</span>'}
          </div>
        </div>
      </div>`;
  }

  function serverHtml() {
    const i = SETUP.info;
    const rows = [
      ['bound to', i.host === '0.0.0.0' ? 'every interface (LAN + localhost)' : i.host],
      ['port', String(i.port)],
      ['password gate', i.authEnabled ? 'on' : 'OFF — anyone on the network can read your chats'],
      ['ollama', `${i.ollamaUrl} · ${i.ollamaOnline ? 'online' : 'offline'}`],
      ['models installed', String(i.models)],
      ['conversations', `${i.data.chats} saved · ${i.data.trash} in the trash`],
      ['data folder', i.data.dir],
      ['token file', i.data.tokenFile || 'none (auth disabled)'],
    ];
    return `
      <div class="msg assistant">
        <div class="msg-head">
          <span class="avatar bot">AI</span>
          <span>This server</span>
        </div>
        <div class="msg-body">
          <div class="kv">
            ${rows
              .map(
                ([k, v]) => `<span>${esc(k)}</span><b class="${k === 'password gate' && !i.authEnabled ? 'warn' : ''}">${esc(v)}</b>`
              )
              .join('')}
          </div>
          <p class="setup-note">Changing how the server starts means restarting it — the banner
          in the terminal lists every flag. <code class="inline">--tunnel</code> puts Tailscale or
          Cloudflare in front of this port; <code class="inline">./run.sh --setup</code> reopens the
          runner.</p>
        </div>
      </div>`;
  }

  function logHtml() {
    const lines = (SETUP.info && SETUP.info.log) || [];
    if (!lines.length) return '';
    return `
      <div class="msg assistant">
        <div class="msg-head">
          <span class="avatar bot">AI</span>
          <span>Installer log</span>
        </div>
        <div class="msg-body">
          <div class="setup-log">${esc(lines.join('\n'))}</div>
        </div>
      </div>`;
  }

  function render() {
    const o = SETUP.overview;
    inner().innerHTML =
      summaryHtml() +
      o.steps.map(stepHtml).join('') +
      accessHtml() +
      serverHtml() +
      logHtml();
  }

  /* ---------------- running a step ---------------- */

  function bubbleFor(id) {
    return document.querySelector(`#setupPageInner [data-step="${id}"]`);
  }

  function appendLog(id, text) {
    const bubble = bubbleFor(id);
    if (!bubble) return;
    let box = bubble.querySelector('.setup-log');
    if (!box) {
      box = document.createElement('div');
      box.className = 'setup-log';
      bubble.querySelector('.msg-body').appendChild(box);
    }
    box.classList.remove('empty');
    const line = document.createElement('div');
    line.className = 'log-line';
    line.textContent = text;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  function setBusy(id, busy) {
    const bubble = bubbleFor(id);
    if (!bubble) return;
    const button = bubble.querySelector(`[data-run="${id}"]`);
    if (button) {
      button.disabled = busy || !SETUP.overview.enabled;
      button.textContent = busy ? 'Running…' : 'Run this step';
    }
    bubble.classList.toggle('running', busy);
  }

  async function runStep(id) {
    if (SETUP.running) return null;
    const params = {};
    if (id === 'model') {
      const select = inner().querySelector('#setupModel');
      if (select) params.model = select.value;
    }

    SETUP.running = true;
    setBusy(id, true);
    const lines = [];
    const shown = id === 'model' ? `ollama pull ${params.model}` : id;
    appendLog(id, `$ ${shown}`);

    let code = 1;
    let note = '';
    try {
      const res = await fetch('/api/setup/run', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, params }),
      });
      if (res.status === 401) {
        location.reload();
        return null;
      }
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.error || `HTTP ${res.status}`);
      }
      if (!res.body) throw new Error('no response stream');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const parts = pending.split('\n');
        pending = parts.pop() || '';

        for (const raw of parts) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          let event;
          try {
            event = JSON.parse(line.slice(5).trim());
          } catch (_) {
            continue;
          }
          if (event.type === 'cmd') appendLog(id, `$ ${event.command}`);
          else if (event.type === 'line') {
            lines.push(event.text);
            appendLog(id, event.text);
          } else if (event.type === 'manual') {
            appendLog(id, event.note);
            appendLog(id, 'copy this into your terminal:');
            appendLog(id, event.command);
          } else if (event.type === 'done') {
            code = event.code;
            note = event.note;
          }
        }
      }
    } catch (err) {
      appendLog(id, String(err.message || err));
      note = String(err.message || err);
    }

    SETUP.results[id] = { code, note, log: lines.join('\n') };
    setBusy(id, false);
    SETUP.running = false;
    await refresh();
    render();
    toast(code === 0 ? 'step finished' : `step failed: ${note || 'see the output'}`);
    return code;
  }

  async function runAll() {
    if (SETUP.busy) return;
    SETUP.busy = true;
    try {
      for (const id of [...SETUP.overview.pending]) {
        const fresh = SETUP.overview.steps.find((s) => s.id === id);
        if (!fresh || fresh.state !== 'missing') continue;
        await runStep(id);
      }
    } finally {
      SETUP.busy = false;
    }
  }

  /* ---------------- actions ---------------- */

  async function finish() {
    if (!confirm('Mark setup finished?\n\nThe command runner closes for the rest of this server process, and the installer will not open on launch again. You can bring it back with ./run.sh --setup.')) return;
    try {
      await fetch('/api/setup/finish', { method: 'POST', credentials: 'same-origin' });
    } catch (_) { /* the reload below is what matters */ }
    location.reload();
  }

  async function skip() {
    // one-time: the server remembers it, the chat opens, the runner stays open
    if (firstRun() && !confirm('Skip the installer?\n\nYou can bring it back any time with the Setup button, or ./run.sh --setup.')) return;
    try {
      await fetch('/api/setup/skip', { method: 'POST', credentials: 'same-origin' });
    } catch (_) { /* the reload below is what matters */ }
    location.reload();
  }

  async function recheck(id) {
    await refresh();
    render();
    const step = SETUP.overview.steps.find((s) => s.id === id);
    toast(step ? `${step.title}: ${STATE_TEXT[step.state] || step.state}` : 'rechecked');
  }

  async function rotate() {
    if (!confirm('Generate a new access token?\n\nEvery signed-in browser and phone will be locked out until you enter the new one. This device stays signed in.')) return;
    try {
      const res = await fetch('/api/token/rotate', { method: 'POST', credentials: 'same-origin' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      SETUP.showToken = true;
      await refresh();
      render();
      toast('new token generated — other devices are now locked out');
    } catch (err) {
      toast(`could not rotate: ${err.message}`);
    }
  }

  function copy(text) {
    if (!text) return toast('nothing to copy');
    navigator.clipboard
      .writeText(text)
      .then(() => toast('copied'))
      .catch(() => toast('copy failed — select it manually'));
  }

  /* ---------------- events ---------------- */

  function wire() {
    inner().addEventListener('click', async (e) => {
      const run = e.target.closest('[data-run]');
      if (run) return runStep(run.dataset.run);

      const copyBtn = e.target.closest('[data-copy]');
      if (copyBtn) return copy(copyBtn.dataset.copy);

      const plain = e.target.closest('[data-copy-token]');
      if (plain) {
        if (plain.disabled) return toast('reveal the token first');
        return copy(SETUP.info ? SETUP.info.token || '' : '');
      }
      const again = e.target.closest('[data-recheck]');
      if (again) return recheck(again.dataset.recheck);

      if (e.target.closest('#setupReveal')) {
        SETUP.showToken = !SETUP.showToken;
        return render();
      }
      if (e.target.closest('#setupRotate')) return rotate();
      if (e.target.closest('#setupRunAll')) return runAll();
      if (e.target.closest('#setupFinish')) return finish();
      if (e.target.closest('[data-close]')) return firstRun() ? skip() : close();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && host().classList.contains('show') && !firstRun() && !SETUP.running) {
        e.preventDefault();
        close();
      }
    });  }

  /* ---------------- open / close ---------------- */

  async function open(isFirstRun) {
    SETUP.firstRun = !!isFirstRun;
    const page = host();
    page.classList.add('show');
    document.body.classList.add('setup-open');
    document.querySelector('#setupPageBody').scrollTop = 0;
    if (!SETUP.wired) {
      SETUP.wired = true;
      wire();
    }
    try {
      if (!(await refresh())) return;
      render();
    } catch (err) {
      inner().innerHTML =
        `<div class="msg error"><div class="msg-body">Could not read the setup state: ${esc(err.message)}</div></div>`;
    }
  }

  function close() {
    // on first run the chat has not been initialised yet, so hiding the
    // page would leave a dead screen — skipping is the only way out
    if (firstRun()) return skip();
    host().classList.remove('show');
    document.body.classList.remove('setup-open');
  }
  async function boot(session) {
    if (session.setupCompleted || session.setupSkipped) return false;
    // first run: hide the composer, the chat is not usable yet
    const dock = document.querySelector('.composer-dock');
    if (dock) dock.style.display = 'none';
    const model = document.querySelector('#model');
    if (model) model.parentElement.style.display = 'none';
    const meta = document.querySelector('#modelMeta');
    if (meta) meta.textContent = '';
    const brand = document.querySelector('.brand-sub');
    if (brand) brand.textContent = 'setup · ollama';
    await open(true);
    return true;
  }

  window.Setup = { boot, open, close, loadOverview: refresh };
})();
