# DailyUs — Personal Ledger

Zero-dependency personal finance + habit tracker (Node 24+).

## Run
```bash
./start.sh          # start (or restart) on http://127.0.0.1:7878
node server.mjs     # foreground
```
Open http://127.0.0.1:7878. Install as PWA from browser menu for offline app feel.

## Files
- `server.mjs` — HTTP server + API + SQLite (node:sqlite, no deps)
- `public/` — frontend (pure JS PWA, service worker for offline shell)
- `dailyus.db` — SQLite database (created on first run, auto-seeded)
- `start.sh` — start/restart helper

## API
- `GET /api/day/YYYY-MM-DD`, `/api/month/YYYY-MM`, `/api/year/YYYY`
- `GET /api/accounts`, `/api/habits`, `/api/all-transactions`
- `POST /api/transactions` (INCOME/EXPENSE/TRANSFER), PATCH/DELETE `/api/transactions/:id`
- `POST /api/habit-logs`, `/api/habits`, `/api/accounts`
- `POST /api/verify` — integrity check (SUM(daily) vs monthly ledgers)
- `GET /api/backup` — download the .db file

## Design invariants (why Discrepancy = 0 structurally)
- Money = INTEGER rupiah, no floats.
- Every mutation + re-aggregation runs in ONE SQL transaction.
- TRANSFER never counts toward income/expense; it moves balance between accounts.
- Retroactive edits re-aggregate both the old and new month/year.

## Roadmap ideas (from PRD, P1+)
- Burn-rate / budget alert
- End-of-month PDF report
- On-device backup encryption (GPG)
