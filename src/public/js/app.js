/* client-side JavaScript – no bundler required */
'use strict';

// ─── SPA router ───────────────────────────────────────────────────────────────
const pages = {
  '/': 'page-dashboard',
  '/playground': 'page-playground',
  '/history': 'page-history',
  '/settings': 'page-settings',
};

function showPage(path) {
  Object.values(pages).forEach((id) => document.getElementById(id).classList.add('hidden'));
  const pageId = pages[path] || 'page-dashboard';
  document.getElementById(pageId).classList.remove('hidden');

  document.querySelectorAll('.nav-link').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === path);
  });
}

document.querySelectorAll('.nav-link').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    const href = a.getAttribute('href');
    history.pushState({}, '', href);
    showPage(href);
    if (href === '/playground') loadPlayground();
    if (href === '/history') loadHistory();
    if (href === '/settings') loadSettings();
  });
});

window.addEventListener('popstate', () => showPage(location.pathname));
showPage(location.pathname);

// ─── Utilities ─────────────────────────────────────────────────────────────────
function fmt(amount, currency) {
  const num = (amount / 100).toFixed(2);
  return currency ? `${num} ${currency}` : num;
}

function fmtDate(isoDate) {
  if (!isoDate) return '—';
  return new Date(isoDate).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function showAlert(containerId, msg, type = 'success') {
  const el = document.getElementById(containerId);
  el.textContent = msg;
  el.className = `alert alert-${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 6000);
}

function confidenceBadge(conf) {
  const pct = Math.round(conf * 100);
  let cls = 'badge-low';
  if (conf >= 0.7) cls = 'badge-high';
  else if (conf >= 0.45) cls = 'badge-mid';
  return `<span class="badge ${cls}">${pct}%</span>`;
}

// ─── Dashboard ──────────────────────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const [healthRes, uncatRes] = await Promise.all([
      fetch('/api/health').then((r) => r.json()),
      fetch('/api/expenses/uncategorized').then((r) => r.json()),
    ]);

    // Status cards
    const dbEl = document.getElementById('status-db');
    dbEl.textContent = healthRes.database?.ok ? '✔ Connected' : '✘ Disconnected';
    dbEl.className = `status-value ${healthRes.database?.ok ? 'ok' : 'error'}`;

    const ollamaEl = document.getElementById('status-ollama');
    const ollamaOk = healthRes.ollama?.ok;
    ollamaEl.textContent = ollamaOk
      ? `✔ ${healthRes.ollama.models?.length ? healthRes.ollama.models[0] : 'Ready'}`
      : '✘ Unreachable';
    ollamaEl.className = `status-value ${ollamaOk ? 'ok' : 'error'}`;

    const schedEl = document.getElementById('status-scheduler');
    schedEl.textContent = healthRes.scheduler?.enabled
      ? `✔ ${healthRes.scheduler.cron}`
      : '⏸ Disabled';
    schedEl.className = `status-value ${healthRes.scheduler?.enabled ? 'ok' : 'warn'}`;

    const uncatEl = document.getElementById('status-uncategorized');
    const count = uncatRes.expenses?.length ?? '?';
    uncatEl.textContent = count;
    uncatEl.className = `status-value ${count > 0 ? 'warn' : 'ok'}`;

    // Table
    const tbody = document.getElementById('uncategorized-tbody');
    const expenses = uncatRes.expenses || [];
    if (expenses.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">All expenses are categorized 🎉</td></tr>';
    } else {
      tbody.innerHTML = expenses.map((e) => `
        <tr>
          <td>${fmtDate(e.expenseDate)}</td>
          <td>${esc(e.groupName || '—')}</td>
          <td>${esc(e.title)}</td>
          <td>${fmt(e.amount, e.currency)}</td>
          <td>
            <button class="btn btn-sm btn-secondary" onclick="playgroundFor('${esc(e.id)}')">
              🔮 Playground
            </button>
          </td>
        </tr>`).join('');
    }
  } catch (err) {
    console.error('Dashboard load error:', err);
  }
}

// Simple HTML escaping
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Batch run ──────────────────────────────────────────────────────────────────
document.getElementById('btn-run-batch').addEventListener('click', async () => {
  const btn = document.getElementById('btn-run-batch');
  btn.disabled = true;
  btn.textContent = '⏳ Running…';
  try {
    const res = await fetch('/api/process', { method: 'POST' }).then((r) => r.json());
    if (res.error) {
      showAlert('batch-result', `Error: ${res.error}`, 'error');
    } else {
      const s = res.stats;
      showAlert(
        'batch-result',
        `Done! Processed: ${s.processed} | Applied: ${s.applied} | Low confidence: ${s.lowConfidence} | Errors: ${s.errors}`,
        'success'
      );
    }
    loadDashboard();
  } catch (err) {
    showAlert('batch-result', `Request failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Run Categorization';
  }
});

// ─── Playground ────────────────────────────────────────────────────────────────
let allCategories = [];
let currentExpenseId = null;

async function loadPlayground() {
  const select = document.getElementById('pg-expense-select');
  const override = document.getElementById('pg-cat-override');

  try {
    const [uncatRes, catRes] = await Promise.all([
      fetch('/api/expenses/uncategorized').then((r) => r.json()),
      fetch('/api/categories').then((r) => r.json()),
    ]);

    allCategories = catRes.categories || [];
    const expenses = uncatRes.expenses || [];

    select.innerHTML = '<option value="">— pick an expense —</option>' +
      expenses.map((e) => `<option value="${esc(e.id)}">${esc(e.title)} (${fmt(e.amount, e.currency)})</option>`).join('');

    override.innerHTML = allCategories
      .map((c) => `<option value="${c.id}">[${esc(c.grouping)}] ${esc(c.name)}</option>`)
      .join('');
  } catch (err) {
    console.error('Playground load error:', err);
  }
}

document.getElementById('pg-expense-select').addEventListener('change', (e) => {
  currentExpenseId = e.target.value || null;
  document.getElementById('btn-pg-suggest').disabled = !currentExpenseId;
  // Reset result panel
  document.getElementById('pg-result-empty').classList.remove('hidden');
  document.getElementById('pg-result-content').classList.add('hidden');
});

document.getElementById('btn-pg-suggest').addEventListener('click', async () => {
  if (!currentExpenseId) return;
  const btn = document.getElementById('btn-pg-suggest');
  btn.disabled = true;
  btn.textContent = '⏳ Asking AI…';

  try {
    const res = await fetch(`/api/expenses/${currentExpenseId}/suggest`, { method: 'POST' }).then(
      (r) => r.json()
    );

    if (res.error) {
      showAlert('pg-alert', `Error: ${res.error}`, 'error');
      return;
    }

    // Fill result panel
    document.getElementById('pg-expense-title').textContent = res.expense.title;
    document.getElementById('pg-expense-amount').textContent = fmt(res.expense.amount);
    document.getElementById('pg-cat-name').textContent =
      res.suggestion.categoryName || `ID ${res.suggestion.categoryId}`;
    document.getElementById('pg-confidence').innerHTML = confidenceBadge(res.suggestion.confidence);
    document.getElementById('pg-reasoning').textContent = res.suggestion.reasoning || '—';

    // Pre-select suggested category in override dropdown
    const overrideSel = document.getElementById('pg-cat-override');
    overrideSel.value = res.suggestion.categoryId;

    document.getElementById('pg-result-empty').classList.add('hidden');
    document.getElementById('pg-result-content').classList.remove('hidden');
  } catch (err) {
    showAlert('pg-alert', `Request failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔮 Get AI Suggestion';
  }
});

document.getElementById('btn-pg-apply').addEventListener('click', async () => {
  if (!currentExpenseId) return;
  const categoryId = document.getElementById('pg-cat-override').value;
  const btn = document.getElementById('btn-pg-apply');
  btn.disabled = true;

  try {
    const res = await fetch(`/api/expenses/${currentExpenseId}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categoryId: Number(categoryId) }),
    }).then((r) => r.json());

    if (res.error) {
      showAlert('pg-alert', `Error: ${res.error}`, 'error');
    } else {
      showAlert('pg-alert', `✔ Category "${res.categoryName}" applied to expense.`, 'success');
      // Reload to reflect change
      loadPlayground();
      currentExpenseId = null;
      document.getElementById('pg-result-empty').classList.remove('hidden');
      document.getElementById('pg-result-content').classList.add('hidden');
    }
  } catch (err) {
    showAlert('pg-alert', `Request failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
});

// Navigate to playground with a specific expense pre-selected
function playgroundFor(expenseId) {
  history.pushState({}, '', '/playground');
  showPage('/playground');
  loadPlayground().then(() => {
    const select = document.getElementById('pg-expense-select');
    select.value = expenseId;
    select.dispatchEvent(new Event('change'));
  });
}

// ─── History ───────────────────────────────────────────────────────────────────
async function loadHistory() {
  try {
    const res = await fetch('/api/history?limit=100').then((r) => r.json());
    const { history: rows = [], stats = {} } = res;

    document.getElementById('hist-total').textContent   = stats.total ?? '—';
    document.getElementById('hist-applied').textContent = stats.applied ?? '—';
    document.getElementById('hist-low').textContent     = stats.lowConfidence ?? '—';
    document.getElementById('hist-errors').textContent  = stats.errors ?? '—';

    const tbody = document.getElementById('history-tbody');
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">No processing history yet.</td></tr>';
      return;
    }

    const statusBadge = (s) => {
      const map = { applied: 'badge-high', low_confidence: 'badge-mid', error: 'badge-low' };
      const label = { applied: 'Applied', low_confidence: 'Low confidence', error: 'Error' };
      return `<span class="badge ${map[s] || ''}">${label[s] || s}</span>`;
    };

    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td>${fmtDate(r.processed_at)}</td>
        <td>${esc(r.title)}</td>
        <td>${esc(r.group_name || '—')}</td>
        <td>${fmt(r.amount, r.currency)}</td>
        <td>${esc(r.category_name || (r.category_id ? `#${r.category_id}` : '—'))}</td>
        <td>${r.confidence != null ? confidenceBadge(r.confidence) : '—'}</td>
        <td>${statusBadge(r.status)}</td>
      </tr>`).join('');
  } catch (err) {
    console.error('History load error:', err);
  }
}

// ─── Settings ──────────────────────────────────────────────────────────────────
async function loadSettings() {
  const container = document.getElementById('settings-content');
  try {
    const s = await fetch('/api/settings').then((r) => r.json());

    const row = (label, value) =>
      `<div class="settings-row"><span class="settings-label">${esc(label)}</span><span class="settings-val">${esc(String(value))}</span></div>`;

    container.innerHTML = `
      <div class="settings-group">
        <h3>Ollama</h3>
        ${row('Base URL', s.ollama.baseUrl)}
        ${row('Model', s.ollama.model)}
      </div>
      <div class="settings-group">
        <h3>Processing</h3>
        ${row('Confidence threshold', s.confidenceThreshold)}
        ${row('Batch size', s.processing.batchSize)}
        ${row('Scheduler enabled', s.scheduler.enabled)}
        ${row('Cron expression', s.scheduler.cronExpression)}
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<p class="error">Failed to load settings: ${esc(err.message)}</p>`;
  }
}

// ─── App version badge ──────────────────────────────────────────────────────────
async function loadAppVersion() {
  const versionEl = document.getElementById('app-version');
  if (!versionEl) return;
  try {
    const s = await fetch('/api/settings').then((r) => r.json());
    versionEl.textContent = `v${s.appVersion || 'dev'}`;
  } catch {
    versionEl.textContent = 'v?';
  }
}

// ─── Init ───────────────────────────────────────────────────────────────────────
loadDashboard();
if (location.pathname === '/playground') loadPlayground();
if (location.pathname === '/history') loadHistory();
if (location.pathname === '/settings') loadSettings();
loadAppVersion();
