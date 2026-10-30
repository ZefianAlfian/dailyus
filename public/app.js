/* DailyUs frontend — zero deps, plain JS */
'use strict';

const $ = (s) => document.querySelector(s);
const fmt = (n) => 'Rp' + Number(n).toLocaleString('id-ID');

let state = { date: todayStr(), tab: 'day', accounts: [], habits: [], month: null, year: null };

function todayStr() { return new Date().toISOString().slice(0, 10); }
function currentMonth() { return state.date.slice(0, 7); }
function currentYear() { return Number(state.date.slice(0, 4)); }

/* ---------- low-level API ---------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}
const apiGet = (p) => api(p);
const apiPost = (p, b) => api(p, { method: 'POST', body: b });
const apiPatch = (p, b) => api(p, { method: 'PATCH', body: b });
const apiDel = (p) => api(p, { method: 'DELETE' });

/* ---------- tabs ---------- */
function goTab(name) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('main section').forEach(s => s.classList.toggle('active', s.id === 'tab-' + name));
  state.tab = name;
  if (name === 'day') renderDay();
  if (name === 'month') renderMonth();
  if (name === 'year') renderYear();
  if (name === 'settings') renderSettings();
}

/* ---------- day ---------- */
async function loadDay(date) {
  state.date = date;
  const [day, accounts, habits] = await Promise.all([apiGet('/api/day/' + date), apiGet('/api/accounts'), apiGet('/api/habits')]);
  state.accounts = accounts.accounts;
  state.habits = habits.habits;
  renderDay();
}
function renderDay() {
  $('#day-date').value = state.date;
  const day = null;
  apiGet('/api/day/' + state.date).then(d => {
    renderDayData(d);
  });
}
async function renderDayData(d) {
  const s = d.day;
  $('#day-summary').innerHTML = `
    <div class="cards">
      <div class="card"><div class="label">Masuk</div><div class="value green">${fmt(s.income)}</div></div>
      <div class="card"><div class="label">Keluar</div><div class="value red">${fmt(s.expense)}</div></div>
      <div class="card"><div class="label">Net Hari</div><div class="value">${fmt(s.net)}</div></div>
      <div class="card"><div class="label">Transaksi</div><div class="value">${s.tx_count}</div></div>
    </div>`;

  const hl = $('#habit-list');
  hl.innerHTML = '';
  for (const h of state.habits) {
    const log = d.logs.find(l => l.habit_id === h.id);
    hl.appendChild(habitRow(h, log));
  }

  const tl = $('#tx-list');
  tl.innerHTML = '';
  $('#tx-empty').hidden = d.txs.length > 0;
  for (const t of d.txs) tl.appendChild(txRow(t));
}

function habitRow(h, log) {
  const div = document.createElement('div');
  const val = log ? log.value : '';
  div.className = 'habit-row' + (val && val !== '0' ? ' done' : '');
  const label = document.createElement('span');
  label.className = 'name';
  label.textContent = h.name;

  const save = async (value) => {
    try {
      await apiPost('/api/habit-logs', { habit_id: h.id, log_date: state.date, value });
      div.classList.toggle('done', !!value && value !== '0');
    } catch (e) {
      alert(e.message);
      renderDay();
    }
  };

  if (h.type === 'CHECKBOX') {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = val === '1';
    input.addEventListener('change', () => { input.disabled = true; save(input.checked ? '1' : '0').finally(() => input.disabled = false); });
    div.append(input, label);
  } else if (h.type === 'COUNTER') {
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="">—</option>' +
      [1,2,3,4,5,6,7,8,9,10].map(n => `<option value="${n}" ${val === String(n) ? 'selected' : ''}>${n}×</option>`).join('');
    sel.addEventListener('change', () => { sel.disabled = true; save(sel.value).finally(() => sel.disabled = false); });
    div.append(sel, label);
  } else {
    div.append(label);
  }
  return div;
}

function txRow(t) {
  const div = document.createElement('div');
  div.className = 'tx-row';
  const sign = t.type === 'INCOME' ? '+' : t.type === 'EXPENSE' ? '−' : '→';
  const cls = t.type === 'INCOME' ? 'in' : t.type === 'EXPENSE' ? 'out' : 'tr';
  const catMap = { PRIMER: 'Primer', SEKUNDER: 'Sekunder', TERSIER: 'Tersier', TRANSFER: 'Transfer' };
  div.innerHTML = `
    <div class="tx-main">
      <div>${esc(t.note || catMap[t.category] || t.category)}</div>
      <span class="tx-cat">${catMap[t.category] || t.category} · ${esc(t.type)}</span>
      ${t.to_account_id ? '<br><small>→ ' + esc(state.accounts.find(a => a.id === t.to_account_id)?.name || t.to_account_id) + '</small>' : ''}
    </div>
    <div class="tx-amt ${cls}">${sign} ${fmt(t.amount)}</div>
    <div class="row-actions">
      <button class="ghost" data-edit="${t.id}">✎</button>
      <button class="danger" data-del="${t.id}">✕</button>
    </div>`;
  div.querySelector(`[data-edit="${t.id}"]`).addEventListener('click', () => openTxModal(t));
  div.querySelector(`[data-del="${t.id}"]`).addEventListener('click', async () => {
    if (!confirm('Hapus transaksi ini?')) return;
    await apiDel('/api/transactions/' + t.id);
    loadDay(state.date);
  });
  return div;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/* ---------- month / year ---------- */
async function renderMonth() {
  const m = $('#month-picker').value || currentMonth();
  $('#month-picker').value = m;
  const d = await apiGet('/api/month/' + m);
  const t = d.totals;
  $('#month-cards').innerHTML = `
    <div class="card"><div class="label">Masuk</div><div class="value green">${fmt(t.income)}</div></div>
    <div class="card"><div class="label">Keluar</div><div class="value red">${fmt(t.expense)}</div></div>
    <div class="card"><div class="label">Net</div><div class="value">${fmt(t.income - t.expense)}</div></div>
    <div class="card"><div class="label">Adherence</div><div class="value blue">${(d.ledger?.habit_adherence ?? 0).toFixed(1)}%</div></div>`;
  $('#month-days').innerHTML = d.daily.map(x => `
    <div class="day-cell">
      <div class="d">${Number(x.tx_date.slice(8))}</div>
      <div class="amt ${x.income - x.expense >= 0 ? 'pos' : 'neg'}">${fmt(x.income - x.expense)}</div>
    </div>`).join('') || '<p class="muted">Belum ada data bulan ini.</p>';
}

async function renderYear() {
  const y = $('#year-picker').value || currentYear();
  $('#year-picker').value = y;
  const d = await apiGet('/api/year/' + y);
  const l = d.ledger;
  $('#year-cards').innerHTML = l ? `
    <div class="card"><div class="label">Masuk</div><div class="value green">${fmt(l.total_income)}</div></div>
    <div class="card"><div class="label">Keluar</div><div class="value red">${fmt(l.total_expense)}</div></div>
    <div class="card"><div class="label">Tabungan</div><div class="value blue">${fmt(l.net_savings)}</div></div>
    <div class="card"><div class="label">Habit</div><div class="value amber">${(l.overall_habit ?? 0).toFixed(1)}%</div></div>`
    : '<p class="muted">Tidak ada data untuk tahun ini.</p>';
  if (!d.months.length) return;
  $('#year-matrix').innerHTML = `
    <table class="year-matrix">
      <thead><tr><th>Bulan</th><th>Masuk</th><th>Keluar</th><th>Net</th></tr></thead>
      <tbody>${d.months.map(m => `
        <tr>
          <td class="m">${monthName(m.year_month.slice(5))}</td>
          <td>${fmt(m.total_income)}</td>
          <td>${fmt(m.total_expense)}</td>
          <td class="${m.net_savings >= 0 ? '' : ''}" style="color:${m.net_savings >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt(m.net_savings)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

function monthName(m) {
  const names = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  return names[Number(m) - 1];
}

/* ---------- settings ---------- */
async function renderSettings() {
  const [accs, habs] = await Promise.all([apiGet('/api/accounts'), apiGet('/api/habits')]);
  state.accounts = accs.accounts;
  $('#account-list').innerHTML = accs.accounts.map(a => `
    <div class="tx-row">
      <div class="tx-main"><div>${esc(a.name)}</div><span class="tx-cat">${a.type} · ${a.currency || 'IDR'}</span></div>
      <div class="tx-amt">${fmt(a.balance)}</div>
    </div>`).join('');
  $('#habit-manage').innerHTML = habs.habits.map(h => `
    <div class="habit-row">
      <span class="name">${esc(h.name)} <span class="tx-cat">${h.type}</span></span>
      <button class="danger" data-del="${h.id}">Hapus</button>
    </div>`).join('');
  document.querySelectorAll('#habit-manage [data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Hapus habit ini? (log ikut terhapus)')) return;
    await apiDel('/api/habits/' + b.dataset.del);
    renderSettings();
  }));
}

/* ---------- modal: transaction ---------- */
function openTxModal(t) {
  const modal = $('#modal');
  $('#modal-title').textContent = t ? 'Edit Transaksi' : 'Catat Transaksi';
  $('#f-date').value = t?.tx_date || state.date;
  $('#f-type').value = t?.type || 'EXPENSE';
  $('#f-account').innerHTML = state.accounts.map(a => `<option value="${a.id}" ${a.id === t?.account_id ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
  $('#f-to').innerHTML = state.accounts.map(a => `<option value="${a.id}" ${a.id === t?.to_account_id ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
  $('#f-category').value = t?.category || 'PRIMER';
  $('#f-amount').value = t?.amount ?? '';
  $('#f-note').value = t?.note || '';
  $('#f-to-wrap').hidden = (t?.type || 'EXPENSE') !== 'TRANSFER';
  $('#f-cat-wrap').hidden = (t?.type || 'EXPENSE') === 'TRANSFER';
  $('#tx-form').dataset.id = t?.id || '';
  modal.hidden = false;
  $('#f-date').focus();
}

function bindModal() {
  $('#add-tx').addEventListener('click', () => openTxModal(null));
  $('#modal-close').addEventListener('click', () => $('#modal').hidden = true);
  $('#f-type').addEventListener('change', (e) => {
    $('#f-to-wrap').hidden = e.target.value !== 'TRANSFER';
    $('#f-cat-wrap').hidden = e.target.value === 'TRANSFER';
    $('#f-type').value === 'TRANSFER';
  });
  $('#tx-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#tx-form').dataset.id;
    const type = $('#f-type').value;
    const body = {
      account_id: $('#f-account').value,
      tx_date: $('#f-date').value,
      type,
      category: type === 'TRANSFER' ? 'TRANSFER' : $('#f-category').value,
      amount: Number($('#f-amount').value),
      to_account_id: type === 'TRANSFER' ? $('#f-to').value : null,
      note: $('#f-note').value.trim(),
    };
    try {
      if (id) await apiPatch('/api/transactions/' + id, body);
      else await apiPost('/api/transactions', body);
      $('#modal').hidden = true;
      loadDay(state.date);
    } catch (err) {
      alert(err.message);
    }
  });
}

/* ---------- prompt ---------- */
function prompt(title, placeholder, cb) {
  $('#prompt-title').textContent = title;
  $('#prompt-input').value = '';
  $('#prompt-input').placeholder = placeholder || '';
  $('#prompt').hidden = false;
  $('#prompt-input').focus();
  const ok = () => { $('#prompt').hidden = true; cb($('#prompt-input').value.trim()); };
  $('#prompt-ok').onclick = ok;
  $('#prompt-cancel').onclick = () => { $('#prompt').hidden = true; };
  $('#prompt-input').onkeydown = (e) => { if (e.key === 'Enter') ok(); };
}

/* ---------- bindings ---------- */
function bindTabs() {
  document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => goTab(b.dataset.tab)));
}
function bindDateNav() {
  $('#day-date').addEventListener('change', (e) => loadDay(e.target.value));
  $('#day-prev').addEventListener('click', () => {
    const d = new Date(state.date + 'T00:00:00');
    d.setDate(d.getDate() - 1);
    loadDay(d.toISOString().slice(0, 10));
  });
  $('#day-next').addEventListener('click', () => {
    const d = new Date(state.date + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    loadDay(d.toISOString().slice(0, 10));
  });
  $('#day-today').addEventListener('click', () => loadDay(todayStr()));
  $('#month-picker').addEventListener('change', renderMonth);
  $('#year-picker').addEventListener('change', renderYear);
}
function bindActions() {
  $('#add-habit').addEventListener('click', () => prompt('Nama Kebiasaan', 'mis. Olahraga 30m', async (name) => {
    if (!name) return;
    await apiPost('/api/habits', { name });
    loadDay(state.date);
  }));
  $('#add-habit-2').addEventListener('click', () => prompt('Nama Kebiasaan', 'mis. Baca Buku', async (name) => {
    if (!name) return;
    await apiPost('/api/habits', { name });
    renderSettings();
  }));
  $('#add-account').addEventListener('click', () => prompt('Nama Dompet', 'mis. BCA / GoPay', async (name) => {
    if (!name) return;
    await apiPost('/api/accounts', { name });
    renderSettings();
  }));
  $('#btn-verify').addEventListener('click', async () => {
    const v = $('#data-verdict');
    v.textContent = 'Memeriksa…';
    try {
      const d = await apiPost('/api/verify', {});
      if (d.discrepancies.length === 0) {
        v.textContent = '✓ Integritas OK — 0 selisih antara transaksi harian dan ledger bulanan.';
        v.className = 'ok';
      } else {
        v.textContent = '⚠ Ditemukan ' + d.discrepancies.length + ' selisih:\n' + JSON.stringify(d.discrepancies, null, 2);
        v.className = 'bad';
      }
    } catch (e) { v.textContent = 'Gagal: ' + e.message; v.className = 'bad'; }
  });
  $('#btn-backup').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = '/api/backup';
    a.download = 'dailyus-backup-' + todayStr() + '.db';
    a.click();
  });
  window.addEventListener('offline', () => $('#offline-dot').hidden = false);
  window.addEventListener('online', () => $('#offline-dot').hidden = true);
}

function refreshData() {
  loadDay(state.date);
  $('#month-picker').value = currentMonth();
  $('#year-picker').value = currentYear();
}

/* ---------- boot ---------- */
window.addEventListener('load', () => {
  bindTabs();
  bindDateNav();
  bindModals();
  bindActions();
  refreshData();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
});
