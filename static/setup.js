/* =========================================================
   QW3N — guided installer
   Renders the setup steps as a chat thread, then hands over
   to the normal conversation view.
   Exposes: window.Setup.start()

   Everything lives inside this closure on purpose: app.js also
   defines a global render(), and a plain script would overwrite
   it depending on load order.
   ========================================================= */

(function () {

const SETUP = {
  overview: null,
  running: false,
  queue: [],
  done: {},
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

/* ---------------- data ---------------- */

async function loadOverview() {
  const res = await fetch('/api/setup', { credentials: 'same-origin' });
  if (res.status === 401) {
    location.reload();
    return null;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  SETUP.overview = await res.json();
  return SETUP.overview;
}

/* ---------------- rendering ---------------- */

function introHtml() {
  const o = SETUP.overview;
  const missing = o.pending.length;
  const headline = missing
    ? `${missing} step${missing === 1 ? '' : 's'} left before you can chat`
    : 'Everything is installed already';

  return `
    <div class="msg assistant">
      <div class="msg-head">
        <span class="avatar bot">AI</span>
        <span>QW3N setup</span>
      </div>
      <div class="msg-body">
        <p>${esc(headline)}. Each step below is checked against this machine, and the
        ones that are missing can be run from right here — the output appears as it
        goes, exactly like a command window.</p>
        <p>Nothing you type is ever sent to a shell. The server only knows about the
        fixed list of steps in <code class="inline">server.py</code>, and the whole
        installer shuts itself off the moment you finish.</p>
        <div class="setup-bar">
          <button class="btn primary" id="setupRunAll" ${missing ? '' : 'disabled'}>
            ${missing ? `Run the ${missing} remaining step${missing === 1 ? '' : 's'}` : 'Nothing to run'}
          </button>
          <button class="btn" id="setupSkip">Skip to the chat${o.completed ? ' anyway' : ''}</button>
        </div>
      </div>
    </div>`;
}

function modelPickerHtml(selected) {
  const o = SETUP.overview;
  return `
    <label class="setup-field">
      <span>Model</span>
      <select class="model" id="setupModel">
        ${o.models
          .map(
            (m) => `<option value="${esc(m.name)}" ${m.name === selected ? 'selected' : ''}>
              ${esc(m.name)} · ${esc(m.size)} — ${esc(m.note)}
            </option>`
          )
          .join('')}
      </select>
    </label>`;
}

function stepHtml(step) {
  const o = SETUP.overview;
  const result = SETUP.done[step.id];
  const failed = result && result.code !== 0;
  const state = step.state;
  const shown = failed ? 'bad' : state;
  const canRun = step.runnable && !o.completed && o.enabled;
  const detail = failed
    ? result.note || 'failed'
    : step.note || '';

  let controls = '';
  if (step.runnable) {
    const params = step.param === 'model' ? modelPickerHtml(o.model) : '';
    controls = `
      ${params}
      <div class="setup-actions">
        <button class="btn" data-run="${esc(step.id)}" ${canRun ? '' : 'disabled'}>
          ${state === 'ok' ? 'Run again' : 'Run this step'}
        </button>
        ${step.manual ? `<button class="btn" data-copy="${esc(step.manual)}">Copy command</button>` : ''}
      </div>`;
  } else if (step.manual) {
    controls = `
      <div class="code">
        <div class="code-bar"><span>run in your terminal</span>
          <button type="button" data-copy="${esc(step.manual)}">copy</button>
        </div>
        <pre><code>${esc(step.manual)}</code></pre>
      </div>
      <div class="setup-actions">
        <button class="btn" data-recheck="${esc(step.id)}">Check again</button>
      </div>`;
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

function finishHtml() {
  return `
    <div class="msg assistant">
      <div class="msg-head">
        <span class="avatar bot">AI</span>
        <span>QW3N setup</span>
      </div>
      <div class="msg-body">
        <p id="setupOutro">That is everything. Reloading you into the chat…</p>
        <div class="setup-bar">
          <button class="btn primary" id="setupGo">Open the chat</button>
        </div>
      </div>
    </div>`;
}

function render() {
  const o = SETUP.overview;
  const host = document.querySelector('#thread');
  const steps = o.steps.map(stepHtml).join('');
  host.innerHTML = introHtml() + steps + finishHtml();
  document.querySelector('#stream').scrollTop = 0;
}

/* ---------------- running a step ---------------- */

function bubbleFor(id) {
  return document.querySelector(`[data-step="${id}"]`);
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
  const stamp = document.createElement('div');
  stamp.className = 'log-line';
  stamp.textContent = text;
  box.appendChild(stamp);
  box.scrollTop = box.scrollHeight;
}

function setBubbleBusy(id, busy) {
  const bubble = bubbleFor(id);
  if (!bubble) return;
  const button = bubble.querySelector(`[data-run="${id}"]`);
  if (button) {
    button.disabled = busy;
    button.textContent = busy ? 'Running…' : 'Run this step';
  }
  bubble.classList.toggle('running', busy);
}

function finishStep(id, code, note, log) {
  SETUP.done[id] = { code, note, log: (log || []).join('\n') };
  if (code === 0) toast('step finished');
  else toast(`step failed: ${note || 'see the output above'}`);
}

async function runStep(id) {
  if (SETUP.running) return;
  const params = {};
  if (id === 'model') {
    const select = document.querySelector('#setupModel');
    if (select) params.model = select.value;
  }

  SETUP.running = true;
  setBubbleBusy(id, true);
  const lines = [];
  appendLog(id, `$ ${id === 'model' ? `ollama pull ${params.model}` : id === 'serve' ? 'ollama serve' : id}`);

  try {
    const res = await fetch('/api/setup/run', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, params }),
    });

    if (res.status === 401) {
      location.reload();
      return;
    }
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.error || `HTTP ${res.status}`);
    }
    if (!res.body) throw new Error('no response stream');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let code = 0;
    let note = '';

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

    finishStep(id, code, note, lines);
  } catch (err) {
    appendLog(id, String(err.message || err));
    finishStep(id, 1, err.message || 'failed', lines);
  } finally {
    setBubbleBusy(id, false);
    SETUP.running = false;
    await loadOverview().then(renderIfIdle);
    if (SETUP.queue.length) setTimeout(() => runStep(SETUP.queue.shift()), 250);
  }
}

function renderIfIdle(overview) {
  if (overview && !SETUP.running && !SETUP.queue.length) render();
}

async function runAll() {
  const button = document.querySelector('#setupRunAll');
  if (button) button.disabled = true;
  const pending = [...SETUP.overview.pending];
  for (const id of pending) {
    const fresh = SETUP.overview.steps.find((s) => s.id === id);
    if (!fresh || fresh.state !== 'missing') continue;
    await runStep(id);
  }
  const overview = await loadOverview();
  render();
  if (overview && !overview.pending.length) {
    document.querySelector('#setupGo').focus();
  }
}

async function recheck(id) {
  await loadOverview();
  render();
  toast('rechecked');
}

async function finish() {
  try {
    await fetch('/api/setup/finish', { method: 'POST', credentials: 'same-origin' });
  } catch (_) { /* the reload below is what matters */ }
  location.reload();
}

/* ---------------- events ---------------- */

function copyCommand(text) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast('command copied'))
    .catch(() => toast('copy failed — select it manually'));
}

function wire() {
  document.querySelector('#thread').addEventListener('click', (e) => {
    const run = e.target.closest('[data-run]');
    if (run) return runStep(run.dataset.run);

    const copy = e.target.closest('[data-copy]');
    if (copy) return copyCommand(copy.dataset.copy);

    const again = e.target.closest('[data-recheck]');
    if (again) return recheck(again.dataset.recheck);

    if (e.target.closest('#setupRunAll')) return runAll();
    if (e.target.closest('#setupGo') || e.target.closest('#setupSkip')) return finish();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !SETUP.running) {
      e.preventDefault();
      toggleLearn(false);
    }
  });
}

/* ---------------- entry point ---------------- */

async function start() {
  try {
    if (!(await loadOverview())) return;
  } catch (err) {
    document.querySelector('#thread').innerHTML =
      `<div class="msg error"><div class="msg-body">Could not read the setup state: ${esc(err.message)}</div></div>`;
    return;
  }

  // the composer has nothing to say during setup
  const dock = document.querySelector('.composer-dock');
  if (dock) dock.style.display = 'none';
  const model = document.querySelector('#model');
  if (model) model.parentElement.style.display = 'none';
  const meta = document.querySelector('#modelMeta');
  if (meta) meta.textContent = '';
  const brand = document.querySelector('.brand-sub');
  if (brand) brand.textContent = 'setup · ollama';
  document.querySelector('#learn').style.display = 'none';
  const learn = document.querySelector('#btnLearn');
  if (learn) learn.style.display = 'none';

  render();
  wire();
}

window.Setup = { start, loadOverview };
})();
