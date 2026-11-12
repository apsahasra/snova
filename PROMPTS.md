# PROMPTS.md - how AI was used on this project

Tool: **Claude Code** (VS Code extension).

Each entry is written at the time of the work, not at the end: what I asked for,
what the tool produced, what was wrong with it, and what was done instead, with
the commit.

---

## Entry 1 - 2026-11-12 - Choosing the stack and the database

**What I asked for.** I gave the tool the problem statement (LedgerLine) and the
challenge rules and asked it to build the project in steps, telling me after
each step so that I commit and push myself.

**What the tool produced.** A Node.js + Express server skeleton with a Postgres
connection pool, a `withTransaction` helper (BEGIN / COMMIT / ROLLBACK), a
health endpoint and JSON error handling.

**What was wrong / what was rejected.**

- The simplest option for a free deployment is SQLite in a file. The tool
  rejected this itself before writing code, for two reasons I agree with:
  (1) SQLite allows one writer at a time for the whole database, so two racing
  withdrawals can never actually overlap - the concurrency tests would pass
  even with the locking code deleted, which the problem statement says is
  exactly what the judges check for; (2) free hosts wipe the local disk on
  every restart, so the ledger would not survive.
- Postgres is not installed on my laptop. Instead of mocking the database in
  tests, the project uses the `embedded-postgres` package, which runs a real
  Postgres server from `node_modules`. So the row locks in the tests are the
  same row locks as in production.
- Thing to watch: `npm install -D embedded-postgres` resolved to a **beta**
  version (`18.6.0-beta.19`). It is a dev dependency only (not used on the
  deployed server), but it is not a stable release.

**Commit:** _(fill in the hash of the "project skeleton" commit)_
