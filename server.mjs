#!/usr/bin/env node
/**
 * DailyUs — Personal Growth & Automated Financial Ledger
 * Single-file server: zero dependencies (Node 24+, node:sqlite).
 * Money stored as INTEGER (IDR cents, i.e. rupiah without decimals) — float-free.
 *
 * Core invariants:
 *  - Every financial mutation happens inside ONE SQL transaction.
 *  - Monthly/annual ledgers are updated inside that same transaction (no event race).
 *  - TRANSFER moves balance between accounts, NEVER counted in income/expense.
 *  - All amounts are stored as integer rupiah (no decimals).
 */

import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

const PORT = process.env.PORT || 7878;
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = join(import.meta.dirname, 'dailyus.db');

/* ------------------------------------------------------------------ */
/*  Database                                                           */
/* ------------------------------------------------------------------ */

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS habits (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'CHECKBOX', -- CHECKBOX | COUNTER | SCALE
  target_freq TEXT NOT NULL DEFAULT 'DAILY',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_habit_logs (
  id          TEXT PRIMARY KEY,
  habit_id    TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  log_date    TEXT NOT NULL,                     -- 'YYYY-MM-DD'
  value       TEXT NOT NULL DEFAULT '',          -- '' | '1' | count | 1..5
  notes       TEXT NOT NULL DEFAULT '',
  UNIQUE(habit_id, log_date)
);
CREATE INDEX IF NOT EXISTS idx_habit_logs_date ON daily_habit_logs(log_date);

CREATE TABLE IF NOT EXISTS accounts (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  type       TEXT NOT NULL DEFAULT 'WALLET',     -- BANK | EWALLET | CASH
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_transactions (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  tx_date    TEXT NOT NULL,                      -- 'YYYY-MM-DD'
  type       TEXT NOT NULL CHECK (type IN ('INCOME','EXPENSE','TRANSFER')),
  category   TEXT NOT NULL,                      -- PRIMER | SEKUNDER | TERSIER | TRANSFER
  amount     INTEGER NOT NULL,                   -- integer rupiah
  to_account_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT, -- for TRANSFER
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON daily_transactions(tx_date);
CREATE INDEX IF NOT EXISTS idx_tx_account ON daily_transactions(account_id);

CREATE TABLE IF NOT EXISTS ledgers_checksum (
  bucket     TEXT PRIMARY KEY,                   -- 'M:YYYY-MM'
  income     INTEGER NOT NULL DEFAULT 0,
  expense    INTEGER NOT NULL DEFAULT 0,
  count      INTEGER NOT NULL DEFAULT 0,
  checksum   TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS monthly_financial_ledgers (
  year_month      TEXT PRIMARY KEY,              -- 'YYYY-MM'
  total_income    INTEGER NOT NULL DEFAULT 0,
  total_expense   INTEGER NOT NULL DEFAULT 0,
  net_savings     INTEGER NOT NULL DEFAULT 0,
  tx_count        INTEGER NOT NULL DEFAULT 0,
  habit_adherence REAL NOT NULL DEFAULT 0,
  is_closed       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS annual_financial_ledgers (
  year             INTEGER PRIMARY KEY,          -- YYYY
  total_income     INTEGER NOT NULL DEFAULT 0,
  total_expense    INTEGER NOT NULL DEFAULT 0,
  net_savings      INTEGER NOT NULL DEFAULT 0,
  tx_count         INTEGER NOT NULL DEFAULT 0,
  overall_habit    REAL NOT NULL DEFAULT 0,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const txStmt = {
  insert: db.prepare(`INSERT INTO daily_transactions
    (id, account_id, tx_date, type, category, amount, to_account_id, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  update: db.prepare(`UPDATE daily_transactions SET
    account_id=?, tx_date=?, type=?, category=?, amount=?, to_account_id=?, note=?, updated_at=datetime('now')
    WHERE id=?`),
  del: db.prepare('DELETE FROM daily_transactions WHERE id=?'),
  get: db.prepare('SELECT * FROM daily_transactions WHERE id=?'),
};

/* ------------------------------------------------------------------ */
/*  Financial core                                                     */
/* ------------------------------------------------------------------ */

function ymOf(date) { return date.slice(0, 7); }
function yearOf(date) { return Number(date.slice(0, 4)); }

/** Audit checksum for a time bucket — used to verify displacement = 0 */
function bucketChecksum(totalIncome, totalExpense, txCount) {
  return createHash('sha256')
    .update(`${totalIncome}|${totalExpense}|${txCount}`)
    .digest('hex').slice(0, 16);
}

/** Recompute one monthly ledger from raw transactions, inside caller's transaction. */
function recomputeMonthly(ym) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type='INCOME'  THEN amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN type='EXPENSE' THEN amount ELSE 0 END), 0) AS expense,
      COUNT(*) AS cnt
    FROM daily_transactions WHERE tx_date LIKE ? || '-%'
  `).get(ym);

  const totalIncome = row.income, totalExpense = row.expense;
  const net = totalIncome - totalExpense;
  const check = bucketChecksum(totalIncome, totalExpense, row.cnt);

  db.prepare(`
    INSERT INTO monthly_financial_ledgers
      (year_month, total_income, total_expense, net_savings, tx_count, habit_adherence, is_closed)
    VALUES (?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(year_month) DO UPDATE SET
      total_income=excluded.total_income,
      total_expense=excluded.total_expense,
      net_savings=excluded.net_savings,
      tx_count=excluded.tx_count,
      is_closed=0
  `).run(ym, totalIncome, totalExpense, net, row.cnt, 0);
  refreshHabitAdherence(ym);

  // store checksum in a side table so discrepancy is provable
  db.prepare(`
    INSERT INTO ledgers_checksum (bucket, income, expense, count, checksum, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(bucket) DO UPDATE SET
      income=excluded.income, expense=excluded.expense, count=excluded.count,
      checksum=excluded.checksum, updated_at=excluded.updated_at
  `).run('M:' + ym, totalIncome, totalExpense, row.cnt, check);
}

/** Recompute annual from monthly ledgers (avoids double-counting transfers). */
function recomputeAnnual(year) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(total_income), 0) AS income,
      COALESCE(SUM(total_expense), 0) AS expense,
      COALESCE(SUM(tx_count), 0) AS cnt
    FROM monthly_financial_ledgers WHERE year_month LIKE ? || '-%'
  `).get(String(year));

  db.prepare(`
    INSERT INTO annual_financial_ledgers
      (year, total_income, total_expense, net_savings, tx_count, overall_habit, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
    ON CONFLICT(year) DO UPDATE SET
      total_income=excluded.total_income, total_expense=excluded.total_expense,
      net_savings=excluded.net_savings, tx_count=excluded.tx_count,
      overall_habit=excluded.overall_habit, updated_at=excluded.updated_at
  `).run(year, row.income, row.expense, row.income - row.expense, row.cnt);
}

/** Apply habit adherence for the month too (habit completion rate). */
function refreshHabitAdherence(ym) {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN value NOT IN ('','0') THEN 1 ELSE 0 END), 0) AS done
    FROM daily_habit_logs WHERE log_date LIKE ? || '-%'
  `).get(ym);
  const pct = row.total > 0 ? Math.round((row.done / row.total) * 10000) / 100 : 0;
  db.prepare(`UPDATE monthly_financial_ledgers SET habit_adherence=? WHERE year_month=?`)
    .run(pct, ym);
}

/**
 * Single entry point for ANY financial mutation.
 * Runs the whole thing in one transaction — insert/update/delete + re-aggregate
 * are atomic. This is what makes Discrepancy = 0 structurally guaranteed.
 */
function mutateTransaction(fn) {
  db.exec('BEGIN');
  try {
    const holder = { old: null };
    fn(holder);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function handleAddTx({ account_id, tx_date, type, category, amount, to_account_id = null, note = '' }) {
  if (!tx_date || !/^\d{4}-\d{2}-\d{2}$/.test(tx_date)) throw Object.assign(new Error('Tanggal tidak valid'), { status: 400 });
  if (!['INCOME','EXPENSE','TRANSFER'].includes(type)) throw Object.assign(new Error('Tipe invalid'), { status: 400 });
  const amt = Number(amount);
  if (!Number.isInteger(amt) || amt <= 0) throw Object.assign(new Error('Nominal harus bilangan bulat > 0'), { status: 400 });
  if (type === 'TRANSFER') {
    if (!to_account_id) throw Object.assign(new Error('Transfer butuh akun tujuan'), { status: 400 });
    if (to_account_id === account_id) throw Object.assign(new Error('Tidak bisa transfer ke akun yang sama'), { status: 400 });
  }
  const CATS = ['PRIMER', 'SEKUNDER', 'TERSIER'];
  category = String(category || '');
  if (type !== 'TRANSFER' && !CATS.includes(category)) {
    throw Object.assign(new Error('Kategori harus PRIMER, SEKUNDER, atau TERSIER'), { status: 400 });
  }

  const id = randomUUID();
  mutateTransaction(() => {
    txStmt.insert.run(id, account_id, tx_date, type, category, amt, to_account_id || null, note || '');
    const ym = ymOf(tx_date);
    recomputeMonthly(ym);
    recomputeAnnual(yearOf(tx_date));
  });
  return { id };
}

function handleUpdateTx(id, patch) {
  const existing = txStmt.get.get(id);
  if (!existing) throw Object.assign(new Error('Transaksi tidak ditemukan'), { status: 404 });

  const next = {
    account_id:   patch.account_id   ?? existing.account_id,
    tx_date:      patch.tx_date      ?? existing.tx_date,
    type:         patch.type         ?? existing.type,
    category:     (patch.category !== undefined) ? patch.category : existing.category,
    amount:       patch.amount      ?? existing.amount,
    to_account_id: patch.to_account_id !== undefined ? patch.to_account_id : existing.to_account_id,
    note:         (patch.note !== undefined) ? patch.note : existing.note,
  };

  // re-aggregate old AND new bucket (retroactive edit) inside one transaction
  mutateTransaction(() => {
    txStmt.update.run(next.account_id, next.tx_date, next.type, next.category, next.amount, next.to_account_id, next.note, id);
    const oldYm = ymOf(existing.tx_date), newYm = ymOf(next.tx_date);
    recomputeMonthly(oldYm); recomputeAnnual(yearOf(existing.tx_date));
    if (newYm !== oldYm) { recomputeMonthly(newYm); recomputeAnnual(yearOf(next.tx_date)); }
  });
  return { id };
}

function handleDeleteTx(id) {
  const existing = mutateTransaction ? null : null;
  let found = null;
  mutateTransaction(() => {
    found = txStmt.get.get(id);
    if (!found) return;
    txStmt.del.run(id);
    recomputeMonthly(ymOf(found.tx_date));
    recomputeAnnual(yearOf(found.tx_date));
  });
  if (!found) throw Object.assign(new Error('Transaksi tidak ditemukan'), { status: 404 });
  return { deleted: id };
}

/* ------------------------------------------------------------------ */
/*  Habit helpers                                                      */
/* ------------------------------------------------------------------ */

function handleHabitLog({ habit_id, log_date, value = '', notes = '' }) {
  if (!habit_id || !log_date) throw Object.assign(new Error('habit_id dan log_date wajib'), { status: 400 });
  const habit = db.prepare('SELECT * FROM habits WHERE id=?').get(habit_id);
  if (!habit) throw Object.assign(new Error('Habit tidak ditemukan'), { status: 404 });

  db.prepare(`
    INSERT INTO daily_habit_logs (id, habit_id, log_date, value, notes)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(habit_id, log_date) DO UPDATE SET value=excluded.value, notes=excluded.notes
  `).run(randomUUID(), habit_id, log_date, String(value ?? ''), notes ?? '');
  refreshHabitAdherence(ymOf(log_date));
  return { ok: true };
}

function handleAddAccount({ name, type = 'WALLET' }) {
  if (!name || !name.trim()) throw Object.assign(new Error('Nama akun wajib'), { status: 400 });
  const id = randomUUID();
  db.prepare('INSERT INTO accounts (id, name, type) VALUES (?, ?, ?)').run(id, name.trim(), type);
  return { id };
}

/* ------------------------------------------------------------------ */
/*  API routing                                                        */
/* ------------------------------------------------------------------ */

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) { reject(Object.assign(new Error('Payload terlalu besar'), { status: 413 })); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(Object.assign(new Error('JSON tidak valid'), { status: 400 })); } });
  });
}

function getQuery(url) {
  const q = new URL(url, 'http://x');
  const o = {};
  for (const [k, v] of q.searchParams) o[k] = v;
  return o;
}

const api = async (req, res, url) => {
  const q = getQuery(url);
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]

  if (req.method === 'GET' && seg[1] === 'health') return sendJSON(res, 200, { ok: true });

  if (req.method === 'GET' && seg[1] === 'day' && seg[2]) {
    const d = seg[2];
    const txs = db.prepare('SELECT * FROM daily_transactions WHERE tx_date=? ORDER BY created_at').all(d);
    const logs = db.prepare(
      `SELECT l.*, h.name AS habit_name, h.type AS habit_type FROM daily_habit_logs l
       JOIN habits h ON h.id=l.habit_id WHERE l.log_date=? ORDER BY h.created_at`
    ).all(d);
    const agg = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN type='INCOME'  THEN amount ELSE 0 END),0) AS income,
        COALESCE(SUM(CASE WHEN type='EXPENSE' THEN amount ELSE 0 END),0) AS expense,
        COUNT(*) AS cnt
      FROM daily_transactions WHERE tx_date=?
    `).get(d);
    return sendJSON(res, 200, { date: d, txs, logs, day: { income: agg.income, expense: agg.expense, net: agg.income - agg.expense, tx_count: agg.cnt } });
  }

  if (req.method === 'GET' && seg[1] === 'month' && seg[2]) {
    const m = seg[2];
    const agg = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN type='INCOME'  THEN amount ELSE 0 END),0) AS income,
        COALESCE(SUM(CASE WHEN type='EXPENSE' THEN amount ELSE 0 END),0) AS expense,
        COUNT(*) AS cnt
      FROM daily_transactions WHERE tx_date LIKE ? || '-%'
    `).get(m);
    const ledger = db.prepare('SELECT * FROM monthly_financial_ledgers WHERE year_month=?').get(m) || null;
    const daily = db.prepare(`
      SELECT tx_date, COUNT(*) AS txs,
        COALESCE(SUM(CASE WHEN type='INCOME'  THEN amount ELSE 0 END),0) AS income,
        COALESCE(SUM(CASE WHEN type='EXPENSE' THEN amount ELSE 0 END),0) AS expense
      FROM daily_transactions WHERE tx_date LIKE ? || '-%' GROUP BY tx_date ORDER BY tx_date
    `).all(m);
    return sendJSON(res, 200, { month: m, totals: agg, ledger, daily });
  }

  if (req.method === 'GET' && seg[1] === 'year' && seg[2]) {
    const y = Number(seg[2]);
    const ledger = db.prepare('SELECT * FROM annual_financial_ledgers WHERE year=?').get(y) || null;
    const months = db.prepare(`SELECT * FROM monthly_financial_ledgers WHERE year_month LIKE ? || '-%' ORDER BY year_month`).all(String(y));
    return sendJSON(res, 200, { year: y, ledger, months });
  }

  if (req.method === 'GET' && seg[1] === 'backup') {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const body = readFileSync(DB_PATH);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="dailyus-backup-${new Date().toISOString().slice(0,10)}.db"`,
    });
    return res.end(body);
  }

  if (req.method === 'GET' && seg[1] === 'summary') {
    const totals = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN type='INCOME'  THEN amount ELSE 0 END),0) AS income,
        COALESCE(SUM(CASE WHEN type='EXPENSE' THEN amount ELSE 0 END),0) AS expense,
        COUNT(*) AS cnt
      FROM daily_transactions
    `).all();
    const habits = db.prepare('SELECT COUNT(DISTINCT habit_id) AS h FROM habits').get();
    const monthly = db.prepare('SELECT COUNT(*) AS c FROM monthly_financial_ledgers').get();
    const annual = db.prepare('SELECT COUNT(*) AS c FROM annual_financial_ledgers').get();
    return sendJSON(res, 200, { totals: totals[0], habits: habits.h, monthly: monthly.c, annual: annual.c });
  }

  if (req.method === 'GET' && seg[1] === 'habits') {
    const habits = db.prepare('SELECT * FROM habits ORDER BY created_at').all();
    return sendJSON(res, 200, { habits });
  }
  if (req.method === 'GET' && seg[1] === 'accounts') {
    const accounts = db.prepare(`
      SELECT a.*,
        COALESCE((
          SELECT SUM(CASE
            WHEN t.type='INCOME'  THEN t.amount
            WHEN t.type='EXPENSE' THEN -t.amount
            WHEN t.type='TRANSFER' AND t.account_id = a.id     THEN -t.amount
            WHEN t.type='TRANSFER' AND t.to_account_id = a.id  THEN  t.amount
            ELSE 0 END)
          FROM daily_transactions t
          WHERE t.account_id = a.id OR t.to_account_id = a.id
        ), 0) AS balance
      FROM accounts a ORDER BY a.created_at
    `).all();
    return sendJSON(res, 200, { accounts });
  }

  if (req.method === 'GET' && seg[1] === 'all-transactions') {
    const txs = db.prepare('SELECT * FROM daily_transactions ORDER BY tx_date DESC, created_at DESC LIMIT 500').all();
    return sendJSON(res, 200, { txs });
  }

  /* --- mutations --- */
  if (req.method === 'POST' && seg[1] === 'transactions') {
    const body = await readBody(req);
    return sendJSON(res, 201, handleAddTx(body));
  }
  if (req.method === 'PATCH' && seg[1] === 'transactions' && seg[2]) {
    const body = await readBody(req);
    return sendJSON(res, 200, handleUpdateTx(seg[2], body));
  }
  if (req.method === 'DELETE' && seg[1] === 'transactions' && seg[2]) {
    return sendJSON(res, 200, handleDeleteTx(seg[2]));
  }

  if (req.method === 'POST' && seg[1] === 'habit-logs') {
    const body = await readBody(req);
    return sendJSON(res, 201, handleHabitLog(body));
  }
  if (req.method === 'POST' && seg[1] === 'accounts') {
    const body = await readBody(req);
    return sendJSON(res, 201, handleAddAccount(body));
  }
  if (req.method === 'POST' && seg[1] === 'habits') {
    const body = await readBody(req);
    if (!body.name || !body.name.trim()) throw Object.assign(new Error('Nama habit wajib'), { status: 400 });
    const id = randomUUID();
    db.prepare('INSERT INTO habits (id, name, type) VALUES (?, ?, ?)').run(id, body.name.trim(), body.type || 'CHECKBOX');
    return sendJSON(res, 201, { id });
  }
  if (req.method === 'DELETE' && seg[1] === 'habits' && seg[2]) {
    db.prepare('DELETE FROM habits WHERE id=?').run(seg[2]);
    return sendJSON(res, 200, { deleted: seg[2] });
  }

  if (req.method === 'POST' && seg[1] === 'recompute') {
    const months = db.prepare('SELECT DISTINCT tx_date FROM daily_transactions').all().map(r => r.tx_date);
    mutateTransaction(() => {
      for (const d of months) { recomputeMonthly(ymOf(d)); recomputeAnnual(yearOf(d)); }
    });
    return sendJSON(res, 200, { ok: true, recomputed: 'full' });
  }

  // integrity check: does SUM(daily) === monthly ledger?
  if (req.method === 'POST' && seg[1] === 'verify') {
    const bad = db.prepare(`
      SELECT m.year_month, m.total_income, m.total_expense, m.tx_count,
        (SELECT COALESCE(SUM(CASE WHEN type='INCOME' THEN amount ELSE 0 END),0) FROM daily_transactions WHERE tx_date LIKE m.year_month || '-%') AS raw_income,
        (SELECT COALESCE(SUM(CASE WHEN type='EXPENSE' THEN amount ELSE 0 END),0) FROM daily_transactions WHERE tx_date LIKE m.year_month || '-%') AS raw_expense,
        (SELECT COUNT(*) FROM daily_transactions WHERE tx_date LIKE m.year_month || '-%') AS raw_count
      FROM monthly_financial_ledgers m
      WHERE m.total_income != (SELECT COALESCE(SUM(CASE WHEN type='INCOME' THEN amount ELSE 0 END),0) FROM daily_transactions WHERE tx_date LIKE m.year_month || '-%')
         OR m.total_expense != (SELECT COALESCE(SUM(CASE WHEN type='EXPENSE' THEN amount ELSE 0 END),0) FROM daily_transactions WHERE tx_date LIKE m.year_month || '-%')
         OR m.tx_count    != (SELECT COUNT(*) FROM daily_transactions WHERE tx_date LIKE m.year_month || '-%')
    `).all();
    return sendJSON(res, 200, { discrepancies: bad });
  }

  return sendJSON(res, 404, { error: 'Not found' });
};

/* ------------------------------------------------------------------ */
/*  Static files                                                        */
/* ------------------------------------------------------------------ */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };

function serveStatic(req, res, url) {
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = join(__dirnamePublic, p);
  if (!file.startsWith(__dirnamePublic)) return sendJSON(res, 403, { error: 'Forbidden' });
  if (!existsSync(file)) return sendJSON(res, 404, { error: 'Not found' });
  const body = readFileSync(file);
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(body);
}

const __dirnamePublic = join(import.meta.dirname, 'public');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await api(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (e) {
    const code = e.status || 500;
    if (code >= 500) console.error('[error]', e);
    sendJSON(res, code, { error: e.message || 'Internal error' });
  }
});

/* ------------------------------------------------------------------ */
/*  Seed initial data (first run only)                                 */
/* ------------------------------------------------------------------ */

const hasData = db.prepare('SELECT COUNT(*) AS c FROM accounts').get().c > 0;
if (!hasData) {
  seedSample();
}

function seedSample() {
  mutateTransaction(() => {
    const acc = {};
    const mk = (name, type) => { const id = randomUUID(); db.prepare('INSERT INTO accounts (id,name,type) VALUES (?,?,?)').run(id, name, type); return id; };
    acc.bca = mk('BCA', 'BANK'); acc.cash = mk('Dompet Fisik', 'CASH'); acc.gopay = mk('GoPay', 'EWALLET');

    const hab = {};
    const mh = (name, type) => { const id = randomUUID(); db.prepare('INSERT INTO habits (id,name,type) VALUES (?,?,?)').run(id, name, type); return id; };
    hab.olahraga = mh('Olahraga 30m', 'CHECKBOX');
    hab.baca = mh('Baca Buku', 'CHECKBOX');
    hab.air = mh('Minum Air 2L', 'COUNTER');

    const base = new Date(); base.setDate(1);
    const today = new Date();
    for (let d = new Date(base); d <= today; d.setDate(d.getDate() + 1)) {
      const ds = d.toISOString().slice(0, 10);
      const day = d.getDate();
      // habits: skip some days to simulate
      if (day % 3 !== 0) db.prepare('INSERT INTO daily_habit_logs (id, habit_id, log_date, value) VALUES (?,?,?,?)').run(randomUUID(), hab.olahraga, ds, '1');
      if (day % 2 === 0) db.prepare('INSERT INTO daily_habit_logs (id, habit_id, log_date, value) VALUES (?,?,?,?)').run(randomUUID(), hab.baca, ds, '1');
      db.prepare('INSERT INTO daily_habit_logs (id, habit_id, log_date, value) VALUES (?,?,?,?)').run(randomUUID(), hab.air, ds, String(2 + (day % 3)));
      // income once (1st), some expenses, occasional transfer
      if (day === 2) {
        // Starting balance via income into BCA
        txStmt.insert.run(randomUUID(), acc.bca, ds, 'INCOME', 'Gaji', 3000000, null, 'Gaji bulanan');
      }
      if (day % 2 === 0) txStmt.insert.run(randomUUID(), acc.gopay, ds, 'EXPENSE', 'PRIMER', 25000, null, `Makan siang h-${day}`);
      if (day % 5 === 0) txStmt.insert.run(randomUUID(), acc.cash, ds, 'EXPENSE', 'SEKUNDER', 15000, null, `Jajan h-${day}`);
      if (day === 3) txStmt.insert.run(randomUUID(), acc.bca, ds, 'TRANSFER', 'TRANSFER', 200000, acc.gopay, 'Top up GoPay');
      if (day === 10) txStmt.insert.run(randomUUID(), acc.bca, ds, 'TRANSFER', 'TRANSFER', 200000, acc.cash, 'Ambil tunai');
    }
    const ym = ymOf(today.toISOString().slice(0, 10));
    recomputeMonthly(ym);
    recomputeAnnual(yearOf(today.toISOString().slice(0, 10)));
  });
  console.log('Seeded sample data (first run)');
}

server.listen(PORT, HOST, () => {
  console.log(`DailyUs running at http://${HOST}:${PORT}`);
});
