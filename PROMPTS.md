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

**Commit:** `"Project skeleton: Express server, Postgres pool, health check"`

---

## Entry 2 - 2026-11-12 - Login, sessions and role checks (authorisation)

**What I asked for.** Authentication with three roles (admin, account holder,
auditor), enforced on the server.

**What the tool produced.** scrypt password hashing, random session tokens
(only the SHA-256 is stored), a `requireLogin` middleware that re-reads the user
and role from the database on every request, `requireRole(...)`, register /
login / logout / me endpoints, and 8 tests.

**What was wrong.**

1. *The test command did not run at all.* The tool wrote
   `"test": "node --test test/"` in `package.json`. On Node 24 this fails with
   `Cannot find module '...\test'` - Node treats the folder as a file to run.
   Zero tests executed, and the only signal was one line of red output. Fixed to
   `node --test "test/*.test.js"` and raised `engines.node` to `>=22`, because
   the glob form needs a recent Node.
2. *The login rate limiter was hard-coded.* The first version created the
   limiter (50 attempts / 15 min / IP) at module level. The test suite logs in
   and registers far more than 50 times from one IP, so later tests would have
   started failing with 429 for a reason unrelated to what they test. Changed
   `authRouter` into `createAuthRouter({ loginLimit })` so production keeps 50
   and the tests pass a high limit explicitly - instead of switching the limiter
   off with a hidden `if (NODE_ENV === 'test')`.

**Decisions I want to be able to defend.**

- Opaque session tokens in the database instead of JWT: logout and
  "deactivate user" take effect on the very next request, and there is no
  signing secret to leak or algorithm to confuse.
- Self-registration always creates a `holder`. The role is a literal in the
  SQL, not read from the request body; there is a test that sends
  `role: "admin"` and checks the stored role.

**Commit:** `Authentication: scrypt passwords, server-side sessions, role middleware, tests`

---

## Entry 3 - 2026-11-12 - The ledger engine, row locks, and checking that the tests really test them (access control + concurrency)

**What I asked for.** Accounts, deposit / withdraw / transfer, with per-account
authorisation decided on the server and safety under concurrent requests.

**What the tool produced.** `src/policy.js` (every authorisation decision in
one file), `src/ledger/engine.js` (one database transaction per movement:
lock both account rows with `SELECT ... FOR UPDATE` in id order, decide, post
or record a refusal), and 15 tests including races fired with `Promise.all`.

**How it was checked.** The problem statement says the judges will remove one
lock or one check and re-run the tests. So that was done here, one at a time:

| Removed from `engine.js`                 | Result                     |
| ------------------------------------------ | -------------------------- |
| `FOR UPDATE` (the row lock)              | 3 race tests fail          |
| the `insufficient_funds` check           | 4 tests fail               |
| the `canMoveMoney` (authorisation) check | 4 authorisation tests fail |

**What was wrong.**

1. *One race test does not detect the missing lock.* With `FOR UPDATE`
   removed, "20 simultaneous withdrawals of 100 from 1000" still passed. The
   other race tests caught it, but that test alone would have given false
   confidence. I have not pinned down exactly why that one run passed (it was
   run once; timing decides whether the reads overlap). Kept the test, but it
   is not the one that proves the lock - the "two withdrawals of the full
   balance, 20 rounds" test is, and it failed immediately.
2. *A failed check could hang the whole test run.* The `after()` hook ran
   `assertBooksBalance()` and then stopped the server. If the assertion threw,
   the server was never stopped and the run never exited. Fixed with
   `try { ... } finally { stopTestServer() }`.
3. *The embedded test database was started and stopped once per test file.*
   On Windows the Postgres process does not always exit fully before the next
   file starts, and a killed run left a half-dead `postgres.exe` plus a
   `postmaster.pid` that blocked every later run (all tests failing in the
   `before` hook after 10 s). The tool's first fix - "if something already
   answers on the port, reuse it" - made it worse: the next file connected to a
   server that was in the middle of shutting down and hung for 279 s. Rejected
   that approach. Now `scripts/test.js` starts ONE Postgres for the whole run
   and passes `DATABASE_URL` to the test files, and startup removes a stale
   `postmaster.pid` left by a killed run.
4. *The router applied the login check too broadly.* The first version of
   `routes/money.js` used `moneyRouter.use(requireLogin)` on a router mounted
   at `/api`, which silently put a login check in front of every later `/api`
   route. It happened to be harmless, but access control that works by accident
   is the kind I cannot explain in an interview. Changed to `requireLogin` on
   each of the three routes explicitly.

**Commit:** "Ledger engine: accounts, deposit/withdraw/transfer with row locks, policy module, race tests"
