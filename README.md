# LedgerLine

Money movement with a ledger you can prove: accounts, deposits, withdrawals and
transfers where the books always balance and the same request never pays twice.

> Work in progress. This README only lists what exists in the repository today.
> It is extended as each part is built.

## Stack

| Part      | Choice                                   | Why |
|-----------|------------------------------------------|-----|
| Server    | Node.js (>= 20) + Express 5              | Small, no build step, easy to read end to end |
| Database  | PostgreSQL                               | Real transactions, row locks (`SELECT ... FOR UPDATE`), CHECK constraints and triggers |
| Local DB  | `embedded-postgres` (dev dependency)     | A real Postgres server from `npm install`, so a clean clone runs with no database setup |
| Frontend  | Plain HTML + JavaScript served by Express | No framework to explain; the server is what enforces the rules |

## Run it locally

```bash
npm install
npm run dev
```

Then open http://localhost:3000/api/health - it should return `{"status":"ok"}`.

With no `DATABASE_URL` set, the server starts its own Postgres in `./.pgdata`
(port 54329). To use your own Postgres instead, copy `.env.example` to `.env`
and set `DATABASE_URL`.

## What works right now

- Server starts, connects to Postgres, answers `GET /api/health`.
- JSON error responses for unknown routes, invalid JSON and oversized bodies.

Nothing else is built yet.
