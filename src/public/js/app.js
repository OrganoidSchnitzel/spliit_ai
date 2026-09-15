/* client-side JavaScript – no bundler required */
'use strict';

// ─── Utilities ─────────────────────────────────────────────────────────────────

/**
 * HTML-escape a value for interpolation into markup.
 * Single quotes are escaped too: the previous version omitted them while
 * interpolating IDs into `onclick="fn('...')"` attributes.
 */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmt(amount, currency) {
  const num = (Number(amount || 0) / 100).toFixed(2);
  return currency ? `${num} ${currency}` : num;
}

function fmtDate(isoDate) {
  if (!isoDate) return '—';
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtDateTime(value) {
  if (!value) return '—';
  // SQLite stores "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker.
  const normalized = /^\d{4}-\d{2}-\d{2} /.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function fmtDuration(ms) {
  if (ms == null) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function confidenceBadge(conf) {
  if (conf == null) return '<span class="badge badge-neutral">—</span>';
  const pct = Math.round(conf * 100);
  let cls = 'badge-low';
  if (conf >= 0.7) cls = 'badge-high';
  else if (conf >= 0.45) cls = 'badge-mid';
  return `<span class="badge ${cls}">${pct}%</span>`;
}

const STATUS_LABELS = {
  applied: ['Applied', 'badge-high'],
  low_confidence: ['Needs review', 'badge-mid'],
  manual: ['Manual', 'badge-info'],
  dry_run: ['Dry run', 'badge-neutral'],
  error: ['Error', 'badge-low'],
};

function statusBadge(status) {
  const [label, cls] = STATUS_LABELS[status] || [status || '—', 'badge-neutral'];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function sourceBadge(source) {
  if (!source) return '';
  const label = { wordlist: 'word list', llm: 'LLM', 'llm+wordlist': 'LLM + word list', manual: 'you' }[source] || source;
  return `<span class="badge badge-neutral">${esc(label)}</span>`;
}

/** Fetch JSON and turn a non-2xx into a rejected promise carrying the message. */
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  let payload = {};
  try {
    payload = await res.json();
  } catch {
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  }
  if (!res.ok) throw new Error(payload.error || `${res.status} ${res.statusText}`);
  return payload;
}

// ─── Toasts ────────────────────────────────────────────────────────────────────

function toast(message, type = 'success', timeoutMs = 5000) {
  const stack = document.getElementById('toast-stack');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');

  const text = document.createElement('span');
  text.textContent = message;
  el.appendChild(text);

  const close = document.createElement('button');
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '✕';
  close.addEventListener('click', () => el.remove());
  el.appendChild(close);

  stack.appendChild(el);
  // Errors stay until dismissed; they usually need reading.
  if (type !== 'error') setTimeout(() => el.remove(), timeoutMs);
}

/** Run an async action with a button locked and a spinner label. */
async function withButton(btn, busyLabel, fn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyLabel;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ─── Theme ─────────────────────────────────────────────────────────────────────

const THEMES = ['system', 'light', 'dark'];
const THEME_ICONS = { system: '🌗', light: '☀️', dark: '🌙' };

function readTheme() {
  try {
    const stored = localStorage.getItem('spliit-ai-theme');
    return THEMES.includes(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(theme) {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('theme-icon');
  if (icon) icon.textContent = THEME_ICONS[theme];
  try {
    localStorage.setItem('spliit-ai-theme', theme);
  } catch {
    // Private browsing or blocked site data — the theme just will not persist.
  }
}

applyTheme(readTheme());

document.getElementById('theme-toggle').addEventListener('click', () => {
  const next = THEMES[(THEMES.indexOf(readTheme()) + 1) % THEMES.length];
  applyTheme(next);
  toast(`Theme: ${next}`, 'info', 1800);
});

// ─── Router ────────────────────────────────────────────────────────────────────

const pages = {
  '/': 'page-dashboard',
  '/playground': 'page-playground',
  '/history': 'page-history',
  '/settings': 'page-settings',
};

const loaders = {
  '/': () => loadDashboard(),
  '/playground': () => loadPlayground(),
  '/history': () => loadHistory(),
  '/settings': () => loadSettings(),
};

function showPage(path) {
  const target = pages[path] ? path : '/';
  Object.values(pages).forEach((id) => document.getElementById(id).classList.add('hidden'));
  document.getElementById(pages[target]).classList.remove('hidden');
  document.querySelectorAll('.nav-link').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === target);
  });
  document.getElementById('navbar-links').classList.remove('open');
  document.getElementById('nav-toggle').setAttribute('aria-expanded', 'false');
  return target;
}

function navigate(path) {
  const target = showPage(path);
  if (location.pathname !== target) history.pushState({}, '', target);
  const load = loaders[target];
  if (load) load();
}

document.addEventListener('click', (e) => {
  const link = e.target.closest('.nav-link');
  if (!link) return;
  e.preventDefault();
  navigate(link.getAttribute('href'));
});

window.addEventListener('popstate', () => {
  const target = showPage(location.pathname);
  const load = loaders[target];
  if (load) load();
});

document.getElementById('nav-toggle').addEventListener('click', (e) => {
  const links = document.getElementById('navbar-links');
  links.classList.toggle('open');
  e.currentTarget.setAttribute('aria-expanded', String(links.classList.contains('open')));
});

// ─── Shared state ──────────────────────────────────────────────────────────────

let allCategories = [];

async function ensureCategories(force = false) {
  if (allCategories.length && !force) return allCategories;
  const res = await api('/api/categories');
  allCategories = res.categories || [];
  return allCategories;
}

/**
 * A category <select>, always led by a placeholder.
 *
 * Without the placeholder the browser pre-selects the first category, so
 * clicking Apply on a row with no suggestion silently assigns whatever sorts
 * first — the exact footgun in the original history-tab implementation.
 */
function categoryOptions(selectedId) {
  const options = allCategories
    .map(
      (c) =>
        `<option value="${esc(c.id)}"${Number(c.id) === Number(selectedId) ? ' selected' : ''}>` +
        `[${esc(c.grouping)}] ${esc(c.name)}</option>`
    )
    .join('');
  const placeholderSelected = selectedId == null ? ' selected' : '';
  return `<option value=""${placeholderSelected}>— pick a category —</option>${options}`;
}

// ─── Dashboard ─────────────────────────────────────────────────────────────────

let dashboardPollTimer = null;

async function loadDashboard() {
  try {
    const [health, uncat] = await Promise.all([
      api('/api/health'),
      api('/api/expenses/uncategorized'),
    ]);
    await ensureCategories();

    document.getElementById('app-version').textContent = `v${health.appVersion || '?'}`;
    document.getElementById('dryrun-banner').classList.toggle('hidden', !health.dryRun);

    // Database
    const dbOk = health.database && health.database.ok;
    setStatus('status-db', dbOk ? '✔ Connected' : '✘ Disconnected', dbOk ? 'ok' : 'error');
    document.getElementById('status-db-note').textContent =
      dbOk ? '' : (health.database && health.database.error) || '';

    // Ollama — a reachable server without the configured model is still broken.
    const ollama = health.ollama || {};
    let ollamaState = 'error';
    let ollamaText = '✘ Unreachable';
    let ollamaNote = ollama.error || '';
    if (ollama.ok && ollama.modelAvailable === false) {
      ollamaState = 'warn';
      ollamaText = '⚠ Model missing';
      ollamaNote = `"${ollama.model}" is not pulled. Run: ollama pull ${ollama.model}`;
    } else if (ollama.ok) {
      ollamaState = 'ok';
      ollamaText = `✔ ${ollama.model || 'Ready'}`;
      ollamaNote = `${(ollama.models || []).length} model(s) available`;
    }
    setStatus('status-ollama', ollamaText, ollamaState);
    document.getElementById('status-ollama-note').textContent = ollamaNote;

    // Scheduler
    const sched = health.scheduler || {};
    setStatus(
      'status-scheduler',
      sched.enabled ? `✔ ${sched.cron}` : '⏸ Disabled',
      sched.enabled ? 'ok' : 'warn'
    );
    document.getElementById('status-scheduler-note').textContent = sched.batchRunning
      ? 'A run is in progress…'
      : sched.lastTickAt
        ? `Last tick ${fmtDateTime(sched.lastTickAt)}`
        : 'No tick yet this uptime';

    // Uncategorized
    const total = uncat.total ?? 0;
    setStatus('status-uncategorized', String(total), total > 0 ? 'warn' : 'ok');
    document.getElementById('status-uncategorized-note').textContent =
      total > uncat.shown ? `showing the ${uncat.shown} most recent` : '';

    renderLastRun(sched.lastRun);
    renderUncategorized(uncat.expenses || []);

    document.getElementById('uncategorized-caption').textContent =
      total > 0 ? `${uncat.shown} of ${total} shown` : '';

    // While a batch is running, keep the page live instead of making the user
    // guess when to press refresh.
    clearTimeout(dashboardPollTimer);
    if (sched.batchRunning) dashboardPollTimer = setTimeout(loadDashboard, 4000);
  } catch (err) {
    toast(`Dashboard failed to load: ${err.message}`, 'error');
  }
}

function setStatus(id, text, state) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = `status-value ${state}`;
}

function renderLastRun(lastRun) {
  const card = document.getElementById('last-run-card');
  if (!lastRun) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const cells = [
    ['Processed', lastRun.processed],
    ['Applied', lastRun.applied],
    ['Needs review', lastRun.lowConfidence],
    ['Errors', lastRun.errors],
    ['Waiting on backoff', lastRun.skipped],
    ['Parked', lastRun.parked],
    ['Took', fmtDuration(lastRun.durationMs)],
    ['Finished', fmtDateTime(lastRun.finishedAt)],
  ];
  document.getElementById('last-run-stats').innerHTML = cells
    .map(([k, v]) => `<div><span class="k">${esc(k)}</span><span class="v">${esc(v ?? '—')}</span></div>`)
    .join('');
}

function renderUncategorized(expenses) {
  const tbody = document.getElementById('uncategorized-tbody');
  if (expenses.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">All expenses are categorized 🎉</td></tr>';
    return;
  }

  tbody.innerHTML = expenses
    .map(
      (e) => `
      <tr>
        <td>${esc(fmtDate(e.expenseDate))}</td>
        <td>${esc(e.groupName || '—')}</td>
        <td>${esc(e.title)}</td>
        <td class="num">${esc(fmt(e.amount, e.currency))}</td>
        <td>
          <div class="row-action">
            <select class="form-control js-inline-category" aria-label="Category for ${esc(e.title)}">
              ${categoryOptions(null)}
            </select>
            <button class="btn btn-sm btn-success js-inline-apply" data-expense-id="${esc(e.id)}">Apply</button>
            <button class="btn btn-sm btn-ghost js-playground-for" data-expense-id="${esc(e.id)}" title="Open in playground">🔮</button>
          </div>
        </td>
      </tr>`
    )
    .join('');
}

/**
 * Delegated handler for the inline category pickers on the dashboard.
 *
 * Reading the <select> as a sibling of the clicked button, rather than by a
 * generated element ID, is what keeps this correct when the same expense
 * appears more than once — the bug in the original history-tab branch.
 */
document.getElementById('uncategorized-tbody').addEventListener('click', async (e) => {
  const playgroundBtn = e.target.closest('.js-playground-for');
  if (playgroundBtn) {
    playgroundFor(playgroundBtn.dataset.expenseId);
    return;
  }

  const btn = e.target.closest('.js-inline-apply');
  if (!btn) return;

  const select = btn.closest('.row-action').querySelector('.js-inline-category');
  if (!select.value) {
    toast('Pick a category first.', 'warn');
    select.focus();
    return;
  }

  await withButton(btn, '…', async () => {
    try {
      const res = await api(`/api/expenses/${encodeURIComponent(btn.dataset.expenseId)}/apply`, {
        method: 'POST',
        body: { categoryId: Number(select.value) },
      });
      toast(`Set “${res.categoryName}”.`);
      await loadDashboard();
    } catch (err) {
      toast(`Could not apply: ${err.message}`, 'error');
    }
  });
});

document.getElementById('btn-refresh-dashboard').addEventListener('click', (e) =>
  withButton(e.currentTarget, '↻ …', loadDashboard)
);

document.getElementById('btn-run-batch').addEventListener('click', (e) =>
  withButton(e.currentTarget, '⏳ Running…', async () => {
    try {
      const res = await api('/api/process', { method: 'POST', body: {} });
      const s = res.stats;
      toast(
        `Processed ${s.processed} · applied ${s.applied} · review ${s.lowConfidence} · errors ${s.errors}` +
          (s.skipped ? ` · ${s.skipped} waiting on backoff` : ''),
        s.errors > 0 ? 'warn' : 'success',
        9000
      );
    } catch (err) {
      toast(err.message, 'error');
    }
    await loadDashboard();
  })
);

// ─── Playground ────────────────────────────────────────────────────────────────

let pgMode = 'existing';
let currentExpenseId = null;
let lastSuggestion = null;

function setPlaygroundMode(mode) {
  pgMode = mode;
  const existing = mode === 'existing';
  document.getElementById('pg-pane-existing').classList.toggle('hidden', !existing);
  document.getElementById('pg-pane-adhoc').classList.toggle('hidden', existing);
  document.getElementById('tab-existing').classList.toggle('active', existing);
  document.getElementById('tab-adhoc').classList.toggle('active', !existing);
  document.getElementById('tab-existing').setAttribute('aria-selected', String(existing));
  document.getElementById('tab-adhoc').setAttribute('aria-selected', String(!existing));
  document.getElementById('pg-apply-row').classList.toggle('hidden', !existing);
  updateSuggestEnabled();
}

function updateSuggestEnabled() {
  const ready =
    pgMode === 'existing'
      ? !!currentExpenseId
      : document.getElementById('pg-title').value.trim().length > 0;
  document.getElementById('btn-pg-suggest').disabled = !ready;
}

document.getElementById('tab-existing').addEventListener('click', () => setPlaygroundMode('existing'));
document.getElementById('tab-adhoc').addEventListener('click', () => setPlaygroundMode('adhoc'));
document.getElementById('pg-title').addEventListener('input', updateSuggestEnabled);

async function loadPlayground() {
  try {
    const [uncat] = await Promise.all([api('/api/expenses/uncategorized'), ensureCategories()]);
    const expenses = uncat.expenses || [];

    document.getElementById('pg-expense-select').innerHTML =
      '<option value="">— pick an expense —</option>' +
      expenses
        .map(
          (e) =>
            `<option value="${esc(e.id)}">${esc(e.title)} (${esc(fmt(e.amount, e.currency))})</option>`
        )
        .join('');

    document.getElementById('pg-cat-override').innerHTML = categoryOptions(null);
  } catch (err) {
    toast(`Playground failed to load: ${err.message}`, 'error');
  }
}

document.getElementById('pg-expense-select').addEventListener('change', (e) => {
  currentExpenseId = e.target.value || null;
  updateSuggestEnabled();
  document.getElementById('pg-result-empty').classList.remove('hidden');
  document.getElementById('pg-result-content').classList.add('hidden');
});

document.getElementById('btn-pg-suggest').addEventListener('click', (e) =>
  withButton(e.currentTarget, '⏳ Thinking…', async () => {
    const skipWordLists = document.getElementById('pg-skip-wordlists').checked;
    try {
      const res =
        pgMode === 'existing'
          ? await api(`/api/expenses/${encodeURIComponent(currentExpenseId)}/suggest`, {
              method: 'POST',
              body: { skipWordLists },
            })
          : await api('/api/expenses/preview', {
              method: 'POST',
              body: {
                title: document.getElementById('pg-title').value.trim(),
                amount: Number(document.getElementById('pg-amount').value) || 0,
                currency: document.getElementById('pg-currency').value.trim() || undefined,
                notes: document.getElementById('pg-notes').value.trim(),
                skipWordLists,
              },
            });
      renderSuggestion(res);
    } catch (err) {
      toast(err.message, 'error');
    }
  })
);

function renderSuggestion(res) {
  lastSuggestion = res.suggestion;

  document.getElementById('pg-expense-title').textContent = res.expense.title;
  document.getElementById('pg-expense-amount').textContent = fmt(res.expense.amount, res.expense.currency);
  document.getElementById('pg-cat-name').textContent =
    res.suggestion.categoryName || `ID ${res.suggestion.categoryId}`;
  document.getElementById('pg-confidence').innerHTML =
    confidenceBadge(res.suggestion.confidence) +
    (res.meetsThreshold
      ? ' <span class="pill">would auto-apply</span>'
      : ` <span class="pill">below threshold ${esc(res.threshold)}</span>`);
  document.getElementById('pg-source').innerHTML = sourceBadge(res.suggestion.source);
  document.getElementById('pg-duration').textContent = fmtDuration(res.suggestion.durationMs);
  document.getElementById('pg-reasoning').textContent = res.suggestion.reasoning || '—';

  renderWordListExplanation(res.wordListExplanation);

  document.getElementById('pg-cat-override').innerHTML = categoryOptions(res.suggestion.categoryId);
  document.getElementById('pg-result-empty').classList.add('hidden');
  document.getElementById('pg-result-content').classList.remove('hidden');
}

function renderWordListExplanation(explanation) {
  const body = document.getElementById('pg-wordlist-body');
  if (!explanation) {
    body.innerHTML = '<p class="muted">No analysis available.</p>';
    return;
  }

  const parts = [`<p class="muted">Normalized: <code>${esc(explanation.normalized || '—')}</code></p>`];

  if (explanation.ambiguous) {
    parts.push(
      `<p>Two lists matched equally strongly (${esc(
        (explanation.ambiguousBetween || []).join(' vs ')
      )}), so the decision was handed to the LLM.</p>`
    );
  } else if (explanation.match) {
    parts.push(
      `<p>Matched <code>${esc(explanation.match.keyword)}</code> from ` +
        `<strong>${esc(explanation.match.listName)}</strong> (${esc(explanation.match.kind)}).</p>`
    );
  } else {
    parts.push('<p>No keyword matched — the LLM decided this one.</p>');
  }

  if (explanation.candidates && explanation.candidates.length) {
    parts.push(
      '<ul class="candidate-list">' +
        explanation.candidates
          .map(
            (c) =>
              `<li><span><code>${esc(c.keyword)}</code> → ${esc(c.categoryName)}</span>` +
              `<span class="muted">${esc(c.listName)} · ${esc(c.kind)} · score ${esc(c.score)}</span></li>`
          )
          .join('') +
        '</ul>'
    );
  }

  body.innerHTML = parts.join('');
}

document.getElementById('btn-pg-apply').addEventListener('click', (e) => {
  if (!currentExpenseId) return;
  const select = document.getElementById('pg-cat-override');
  if (!select.value) {
    toast('Pick a category first.', 'warn');
    return;
  }
  return withButton(e.currentTarget, '…', async () => {
    try {
      const res = await api(`/api/expenses/${encodeURIComponent(currentExpenseId)}/apply`, {
        method: 'POST',
        body: {
          categoryId: Number(select.value),
          note:
            lastSuggestion && lastSuggestion.categoryId !== Number(select.value)
              ? `Corrected from "${lastSuggestion.categoryName}" in the playground.`
              : 'Confirmed in the playground.',
        },
      });
      toast(`Set “${res.categoryName}”.`);
      currentExpenseId = null;
      document.getElementById('pg-result-content').classList.add('hidden');
      document.getElementById('pg-result-empty').classList.remove('hidden');
      await loadPlayground();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
});

function playgroundFor(expenseId) {
  navigate('/playground');
  setPlaygroundMode('existing');
  loadPlayground().then(() => {
    const select = document.getElementById('pg-expense-select');
    select.value = expenseId;
    select.dispatchEvent(new Event('change'));
    document.getElementById('btn-pg-suggest').focus();
  });
}

// ─── History ───────────────────────────────────────────────────────────────────

const historyState = { offset: 0, limit: 50, status: 'all', search: '', total: 0 };

async function loadHistory() {
  try {
    await ensureCategories();
    const params = new URLSearchParams({
      limit: String(historyState.limit),
      offset: String(historyState.offset),
      status: historyState.status,
    });
    if (historyState.search) params.set('search', historyState.search);

    const [res, corrections] = await Promise.all([
      api(`/api/history?${params}`),
      api('/api/history/corrections?limit=25'),
    ]);

    historyState.total = res.total;
    renderHistoryStats(res.stats);
    renderHistoryRows(res.history || []);
    renderCorrections(corrections.corrections || []);
    renderPager();
  } catch (err) {
    toast(`History failed to load: ${err.message}`, 'error');
  }
}

function renderHistoryStats(stats = {}) {
  document.getElementById('hist-total').textContent = stats.total ?? '—';
  document.getElementById('hist-applied').textContent = stats.applied ?? '—';
  document.getElementById('hist-low').textContent = stats.lowConfidence ?? '—';
  document.getElementById('hist-errors').textContent = stats.errors ?? '—';

  const viaWordList = stats.viaWordList ?? 0;
  const viaLlm = stats.viaLlm ?? 0;
  document.getElementById('hist-source-note').textContent =
    viaWordList + viaLlm > 0
      ? `${viaWordList} by word list, ${viaLlm} by LLM`
      : '';
  document.getElementById('hist-parked-note').textContent =
    stats.parked > 0 ? `${stats.parked} parked` : '';
  document.getElementById('hist-speed-note').textContent =
    stats.avgLlmMs ? `LLM averages ${fmtDuration(stats.avgLlmMs)}` : '';
}

function renderHistoryRows(rows) {
  const tbody = document.getElementById('history-tbody');
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">Nothing matches these filters.</td></tr>';
    return;
  }

  tbody.innerHTML = rows
    .map((r) => {
      // The action cell carries the expense id on the button and finds its
      // <select> by DOM position. Generating element IDs from expense_id — as
      // the original branch did — collides whenever an expense appears in more
      // than one history row, which happens on every retry.
      const action = r.expense_id
        ? `<div class="row-action">
             <select class="form-control js-history-category" aria-label="Correct category for ${esc(r.title)}">
               ${categoryOptions(r.category_id)}
             </select>
             <button class="btn btn-sm btn-success js-history-apply" data-expense-id="${esc(r.expense_id)}"
                     data-was="${esc(r.category_name || '')}">Apply</button>
             <button class="btn btn-sm btn-ghost js-history-park" data-expense-id="${esc(r.expense_id)}"
                     data-parked="${r.is_parked ? '1' : '0'}"
                     title="${r.is_parked ? 'Resume retrying this expense' : 'Stop retrying this expense'}">
               ${r.is_parked ? 'Resume' : 'Skip'}
             </button>
           </div>`
        : '—';

      return `
      <tr>
        <td>${esc(fmtDateTime(r.processed_at))}</td>
        <td>${esc(r.title)}<br /><span class="muted">${esc(r.group_name || '—')}</span></td>
        <td class="num">${esc(fmt(r.amount, r.currency))}</td>
        <td>${esc(r.category_name || (r.category_id ? `#${r.category_id}` : '—'))} ${sourceBadge(r.source)}</td>
        <td>${confidenceBadge(r.confidence)}</td>
        <td>${statusBadge(r.status)}${r.is_parked ? ' <span class="badge badge-neutral">parked</span>' : ''}</td>
        <td>${action}</td>
      </tr>`;
    })
    .join('');
}

function renderCorrections(corrections) {
  const card = document.getElementById('corrections-card');
  if (!corrections.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  document.getElementById('corrections-tbody').innerHTML = corrections
    .map(
      (c) => `
      <tr>
        <td>${esc(c.title)}</td>
        <td><span class="badge badge-low">${esc(c.suggested)}</span></td>
        <td><span class="badge badge-high">${esc(c.corrected_to)}</span></td>
        <td>${sourceBadge(c.suggested_source)}</td>
      </tr>`
    )
    .join('');
}

function renderPager() {
  const { offset, limit, total } = historyState;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  document.getElementById('history-range').textContent = `${from}–${to} of ${total}`;
  document.getElementById('history-prev').disabled = offset === 0;
  document.getElementById('history-next').disabled = offset + limit >= total;
}

document.getElementById('history-tbody').addEventListener('click', async (e) => {
  const parkBtn = e.target.closest('.js-history-park');
  if (parkBtn) {
    const parked = parkBtn.dataset.parked === '1';
    await withButton(parkBtn, '…', async () => {
      try {
        await api(`/api/expenses/${encodeURIComponent(parkBtn.dataset.expenseId)}/park`, {
          method: parked ? 'DELETE' : 'POST',
          body: parked ? undefined : { reason: 'Parked from the history view.' },
        });
        toast(parked ? 'Retrying this expense again.' : 'Stopped retrying this expense.', 'info');
        await loadHistory();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    return;
  }

  const btn = e.target.closest('.js-history-apply');
  if (!btn) return;

  const select = btn.closest('.row-action').querySelector('.js-history-category');
  if (!select.value) {
    toast('Pick a category first.', 'warn');
    select.focus();
    return;
  }

  await withButton(btn, '…', async () => {
    try {
      const was = btn.dataset.was;
      const res = await api(`/api/expenses/${encodeURIComponent(btn.dataset.expenseId)}/apply`, {
        method: 'POST',
        body: {
          categoryId: Number(select.value),
          note: was ? `Corrected from "${was}" in the history view.` : 'Set from the history view.',
        },
      });
      toast(`Set “${res.categoryName}”. Recorded as a manual correction.`);
      await loadHistory();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
});

let searchTimer = null;
document.getElementById('history-search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const value = e.target.value.trim();
  searchTimer = setTimeout(() => {
    historyState.search = value;
    historyState.offset = 0;
    loadHistory();
  }, 300);
});

document.getElementById('history-status').addEventListener('change', (e) => {
  historyState.status = e.target.value;
  historyState.offset = 0;
  loadHistory();
});

document.getElementById('history-limit').addEventListener('change', (e) => {
  historyState.limit = Number(e.target.value);
  historyState.offset = 0;
  loadHistory();
});

document.getElementById('history-prev').addEventListener('click', () => {
  historyState.offset = Math.max(0, historyState.offset - historyState.limit);
  loadHistory();
});

document.getElementById('history-next').addEventListener('click', () => {
  historyState.offset += historyState.limit;
  loadHistory();
});

document.getElementById('btn-history-refresh').addEventListener('click', (e) =>
  withButton(e.currentTarget, '↻ …', loadHistory)
);

document.getElementById('btn-history-clear').addEventListener('click', async (e) => {
  if (!confirm('Delete the entire processing history? This cannot be undone.')) return;
  await withButton(e.currentTarget, '…', async () => {
    try {
      const res = await api('/api/history', { method: 'DELETE' });
      toast(`Removed ${res.removed} record(s).`, 'info');
      historyState.offset = 0;
      await loadHistory();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
});

// ─── Settings ──────────────────────────────────────────────────────────────────

let settingsSchema = [];
const pendingSettings = new Map();

const GROUP_TITLES = {
  categorization: 'Categorization',
  ollama: 'Ollama',
  scheduler: 'Scheduler & processing',
  history: 'History',
  prompt: 'Prompt',
};

async function loadSettings() {
  try {
    const [settings, prompt, models, wordLists] = await Promise.all([
      api('/api/settings'),
      api('/api/prompt/template'),
      api('/api/models').catch(() => ({ models: [], recommended: [] })),
      api('/api/wordlists'),
    ]);

    settingsSchema = settings.schema;
    pendingSettings.clear();
    renderSettingsForm(settings);
    renderPrompt(prompt);
    renderModels(models, settings.settings['ollama.model']);
    renderWordListPicker(wordLists);
    updateDirtyBar();
    document.getElementById('app-version').textContent = `v${settings.appVersion}`;
  } catch (err) {
    toast(`Settings failed to load: ${err.message}`, 'error');
  }
}

/**
 * The form is generated from the schema the API reports, so adding a setting
 * on the server makes it appear here without touching the frontend.
 */
function renderSettingsForm(payload) {
  const form = document.getElementById('settings-form');
  // The prompt template has its own editor further down the page.
  const fields = settingsSchema.filter((f) => f.group !== 'prompt');

  const groups = {};
  for (const field of fields) (groups[field.group] ||= []).push(field);

  form.innerHTML = Object.entries(groups)
    .map(
      ([group, items]) => `
      <div class="settings-section">
        <h2>${esc(GROUP_TITLES[group] || group)}</h2>
        ${items.map(renderSettingField).join('')}
      </div>`
    )
    .join('') +
    `<div class="settings-section">
       <h2>Read-only</h2>
       <p class="section-desc">Set from the environment at startup; a restart is needed to change these.</p>
       <div class="stat-row">
         <div><span class="k">Port</span><span class="v">${esc(payload.readOnly.port)}</span></div>
         <div><span class="k">Log level</span><span class="v">${esc(payload.readOnly.logLevel)}</span></div>
         <div><span class="k">API auth</span><span class="v">${payload.readOnly.authEnabled ? 'on' : 'off'}</span></div>
         <div><span class="k">Spliit DB</span><span class="v">${esc(payload.readOnly.database.host)}:${esc(payload.readOnly.database.port)}/${esc(payload.readOnly.database.name)}</span></div>
       </div>
     </div>`;
}

function renderSettingField(field) {
  const id = `setting-${field.key.replace(/\./g, '-')}`;
  let control;

  if (field.type === 'boolean') {
    control = `<label class="checkbox-row">
        <input type="checkbox" id="${id}" data-key="${esc(field.key)}" data-type="boolean" ${field.value ? 'checked' : ''} />
        <span>${field.value ? 'On' : 'Off'}</span>
      </label>`;
  } else if (field.type === 'number') {
    const step = field.integer ? '1' : '0.01';
    control = `<input type="number" class="form-control" id="${id}" data-key="${esc(field.key)}" data-type="number"
        value="${esc(field.value)}" min="${esc(field.min)}" max="${esc(field.max)}" step="${step}" />`;
  } else if (field.type === 'numberList') {
    control = `<input type="text" class="form-control" id="${id}" data-key="${esc(field.key)}" data-type="text"
        value="${esc((field.value || []).join(', '))}" />`;
  } else {
    control = `<input type="text" class="form-control" id="${id}" data-key="${esc(field.key)}" data-type="text"
        value="${esc(field.value ?? '')}" />`;
  }

  return `
    <div class="setting-field" data-field="${esc(field.key)}">
      <div class="setting-field-head">
        <label for="${id}">${esc(field.label)}</label>
        ${field.isOverridden ? '<button type="button" class="btn btn-sm btn-ghost js-reset-setting" data-key="' + esc(field.key) + '">Reset to default</button>' : ''}
      </div>
      ${field.help ? `<p class="setting-help">${esc(field.help)}</p>` : ''}
      ${control}
    </div>`;
}

document.getElementById('settings-form').addEventListener('change', (e) => {
  const input = e.target.closest('[data-key]');
  if (!input) return;

  const key = input.dataset.key;
  const value =
    input.dataset.type === 'boolean'
      ? input.checked
      : input.dataset.type === 'number'
        ? input.value
        : input.value;

  pendingSettings.set(key, value);
  input.closest('.setting-field').classList.add('is-dirty');

  if (input.dataset.type === 'boolean') {
    const label = input.parentElement.querySelector('span');
    if (label) label.textContent = input.checked ? 'On' : 'Off';
  }
  updateDirtyBar();
});

document.getElementById('settings-form').addEventListener('click', async (e) => {
  const btn = e.target.closest('.js-reset-setting');
  if (!btn) return;
  e.preventDefault();
  try {
    await api(`/api/settings/${encodeURIComponent(btn.dataset.key)}`, { method: 'DELETE' });
    toast('Reverted to the environment default.', 'info');
    await loadSettings();
  } catch (err) {
    toast(err.message, 'error');
  }
});

function updateDirtyBar() {
  const bar = document.getElementById('settings-save-bar');
  const n = pendingSettings.size;
  bar.classList.toggle('hidden', n === 0);
  document.getElementById('settings-dirty-count').textContent =
    `${n} unsaved change${n === 1 ? '' : 's'}`;
}

document.getElementById('btn-settings-save').addEventListener('click', (e) =>
  withButton(e.currentTarget, '💾 Saving…', async () => {
    try {
      const res = await api('/api/settings', {
        method: 'PATCH',
        body: Object.fromEntries(pendingSettings),
      });
      toast(
        res.changed.length
          ? `Saved ${res.changed.length} setting(s).`
          : 'Nothing changed.',
        'success'
      );
      await loadSettings();
    } catch (err) {
      // All-or-nothing: nothing was written, so the form still holds the edits.
      toast(err.message, 'error');
    }
  })
);

document.getElementById('btn-settings-discard').addEventListener('click', () => {
  pendingSettings.clear();
  loadSettings();
});

document.getElementById('btn-settings-reset-all').addEventListener('click', async (e) => {
  if (!confirm('Reset every setting to its environment default?')) return;
  await withButton(e.currentTarget, '…', async () => {
    try {
      const res = await api('/api/settings', { method: 'DELETE' });
      toast(`Reset ${res.reverted.length} setting(s).`, 'info');
      await loadSettings();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
});

// ─── Models ────────────────────────────────────────────────────────────────────

function renderModels(payload, current) {
  const container = document.getElementById('model-list');
  if (!payload.ok) {
    container.innerHTML = `<p class="muted">Ollama is not reachable: ${esc(payload.error || 'unknown error')}</p>`;
    return;
  }

  const installed = payload.models || [];
  const rows = installed.map(
    (name) => `
    <div class="model-row ${name === current ? 'is-current' : ''}">
      <span class="model-name">${esc(name)}</span>
      ${
        name === current
          ? '<span class="pill">in use</span>'
          : `<button type="button" class="btn btn-sm btn-secondary js-use-model" data-model="${esc(name)}">Use this</button>`
      }
    </div>`
  );

  if (!installed.includes(current)) {
    rows.unshift(
      `<div class="model-row"><span class="model-name">${esc(current)}</span>
        <span class="badge badge-low">configured but not pulled</span></div>`
    );
  }

  const recommended = (payload.recommended || [])
    .filter((r) => !installed.includes(r.name))
    .map(
      (r) => `<div class="model-row">
          <span><span class="model-name">${esc(r.name)}</span><br /><span class="muted">${esc(r.note)}</span></span>
          <code>ollama pull ${esc(r.name)}</code>
        </div>`
    );

  container.innerHTML =
    rows.join('') +
    (recommended.length
      ? `<p class="section-desc" style="margin-top:.85rem">Not pulled yet, but well suited to a CPU-only box:</p>${recommended.join('')}`
      : '');
}

document.getElementById('model-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.js-use-model');
  if (!btn) return;
  try {
    await api('/api/settings', { method: 'PATCH', body: { 'ollama.model': btn.dataset.model } });
    toast(`Now using ${btn.dataset.model}.`);
    await loadSettings();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ─── Prompt template ───────────────────────────────────────────────────────────

function renderPrompt(payload) {
  document.getElementById('prompt-template').value = payload.template;
  const state = document.getElementById('prompt-state');
  state.textContent = payload.isCustom ? 'custom — saved to disk' : 'using the built-in prompt';
}

document.getElementById('btn-save-prompt').addEventListener('click', (e) =>
  withButton(e.currentTarget, '💾 Saving…', async () => {
    try {
      await api('/api/prompt/template', {
        method: 'POST',
        body: { template: document.getElementById('prompt-template').value },
      });
      toast('Prompt saved. It will survive a restart.');
      renderPrompt(await api('/api/prompt/template'));
    } catch (err) {
      toast(err.message, 'error');
    }
  })
);

document.getElementById('btn-preview-prompt').addEventListener('click', (e) =>
  withButton(e.currentTarget, '👁 …', async () => {
    const pre = document.getElementById('prompt-preview');
    try {
      const res = await api('/api/prompt/preview', {
        method: 'POST',
        body: { template: document.getElementById('prompt-template').value },
      });
      pre.textContent = res.prompt;
      pre.classList.remove('hidden');
    } catch (err) {
      pre.textContent = err.message;
      pre.classList.remove('hidden');
      toast(err.message, 'error');
    }
  })
);

document.getElementById('btn-reset-prompt').addEventListener('click', (e) =>
  withButton(e.currentTarget, '…', async () => {
    try {
      const res = await api('/api/prompt/template', { method: 'DELETE' });
      renderPrompt({ template: res.template, isCustom: false });
      toast('Back to the built-in prompt.', 'info');
    } catch (err) {
      toast(err.message, 'error');
    }
  })
);

// ─── Word lists ────────────────────────────────────────────────────────────────

let allWordLists = {};
let currentWordList = null;

function renderWordListPicker(payload) {
  allWordLists = payload.wordLists || {};
  const select = document.getElementById('wordlist-select');
  const previous = select.value;

  select.innerHTML =
    '<option value="">— select a list —</option>' +
    (payload.summary || [])
      .map(
        (s) =>
          `<option value="${esc(s.listName)}">${esc(s.listName)} (${esc(s.keywordCount)}` +
          `${s.manualCount ? `, ${esc(s.manualCount)} yours` : ''})</option>`
      )
      .join('');

  if (previous && allWordLists[previous]) {
    select.value = previous;
    renderKeywords(previous);
  }
}

function renderKeywords(listName) {
  const data = allWordLists[listName];
  if (!data) return;

  currentWordList = listName;
  document.getElementById('wordlist-name').textContent = listName;
  document.getElementById('wordlist-targets').textContent =
    `Maps to: ${data.targetCategoryNames.join(' → ')}`;

  const manual = new Set(data.manualKeywords || []);
  document.getElementById('keyword-list').innerHTML = data.keywords
    .map((kw) => {
      const isManual = manual.has(kw);
      const short = !kw.includes(' ') && kw.length < 5;
      return `
        <span class="keyword-item ${isManual ? 'is-manual' : ''}">
          <span class="keyword-text">${esc(kw)}</span>
          ${short ? '<span class="kw-note" title="Only matches as a whole word">whole word</span>' : ''}
          <button class="btn-remove-keyword js-remove-keyword" data-keyword="${esc(kw)}"
                  aria-label="Remove ${esc(kw)}">✕</button>
        </span>`;
    })
    .join('');

  if (data.removedKeywords && data.removedKeywords.length) {
    document.getElementById('keyword-list').insertAdjacentHTML(
      'beforeend',
      `<span class="muted" style="width:100%">Removed built-ins (kept out after restart): ${esc(
        data.removedKeywords.join(', ')
      )}</span>`
    );
  }

  document.getElementById('wordlist-content').classList.remove('hidden');
}

document.getElementById('wordlist-select').addEventListener('change', (e) => {
  const listName = e.target.value;
  if (!listName) {
    document.getElementById('wordlist-content').classList.add('hidden');
    currentWordList = null;
    return;
  }
  renderKeywords(listName);
});

document.getElementById('keyword-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.js-remove-keyword');
  if (!btn || !currentWordList) return;
  try {
    await api(
      `/api/wordlists/${encodeURIComponent(currentWordList)}/keywords/${encodeURIComponent(btn.dataset.keyword)}`,
      { method: 'DELETE' }
    );
    toast(`Removed “${btn.dataset.keyword}”.`, 'info');
    renderWordListPicker(await api('/api/wordlists'));
  } catch (err) {
    toast(err.message, 'error');
  }
});

async function addKeyword() {
  if (!currentWordList) return;
  const input = document.getElementById('new-keyword');
  const keyword = input.value.trim();
  if (!keyword) return;

  try {
    const res = await api(`/api/wordlists/${encodeURIComponent(currentWordList)}/keywords`, {
      method: 'POST',
      body: { keyword },
    });
    input.value = '';
    toast(`Added “${res.keyword}”.`);
    if (res.warning) toast(res.warning, 'warn', 8000);
    renderWordListPicker(await api('/api/wordlists'));
  } catch (err) {
    toast(err.message, 'error');
  }
}

document.getElementById('btn-add-keyword').addEventListener('click', (e) =>
  withButton(e.currentTarget, '…', addKeyword)
);

document.getElementById('new-keyword').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addKeyword();
  }
});

document.getElementById('btn-wordlist-reset').addEventListener('click', async (e) => {
  if (!currentWordList) return;
  if (!confirm(`Restore the shipped keywords for "${currentWordList}"?`)) return;
  await withButton(e.currentTarget, '…', async () => {
    try {
      await api(`/api/wordlists/${encodeURIComponent(currentWordList)}/reset`, { method: 'POST' });
      toast('List restored.', 'info');
      renderWordListPicker(await api('/api/wordlists'));
    } catch (err) {
      toast(err.message, 'error');
    }
  });
});

async function testWordList() {
  const title = document.getElementById('wordlist-test-input').value.trim();
  const result = document.getElementById('wordlist-test-result');
  if (!title) return;

  try {
    const res = await api('/api/wordlists/test', { method: 'POST', body: { title } });
    let verdict;
    if (res.ambiguous) {
      verdict = `<span class="badge badge-mid">ambiguous</span> ${esc(
        (res.ambiguousBetween || []).join(' vs ')
      )} — the LLM would decide.`;
    } else if (res.match) {
      verdict = `<span class="badge badge-high">${esc(res.match.categoryName)}</span> via ` +
        `<code>${esc(res.match.keyword)}</code> (${esc(res.match.kind)}, ` +
        `${Math.round(res.match.confidence * 100)}% confidence)`;
    } else {
      verdict = '<span class="badge badge-neutral">no match</span> — the LLM would decide.';
    }
    result.innerHTML = `<p>${verdict}</p><p class="muted">Normalized: <code>${esc(res.normalized)}</code></p>`;
  } catch (err) {
    result.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

document.getElementById('btn-wordlist-test').addEventListener('click', (e) =>
  withButton(e.currentTarget, '…', testWordList)
);

document.getElementById('wordlist-test-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    testWordList();
  }
});

// ─── Boot ──────────────────────────────────────────────────────────────────────

/** Chrome that belongs to every page, not just the dashboard. */
async function loadChrome() {
  try {
    const health = await api('/api/health');
    document.getElementById('app-version').textContent = `v${health.appVersion || '?'}`;
    document.getElementById('dryrun-banner').classList.toggle('hidden', !health.dryRun);
  } catch {
    document.getElementById('app-version').textContent = '';
  }
}

loadChrome();
navigate(location.pathname);
