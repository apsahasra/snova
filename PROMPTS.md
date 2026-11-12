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

**Commit:** [`e80275c`](https://github.com/apsahasra/snova/commit/e80275c) - Project skeleton: Express server, Postgres pool, health check

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

**Commit:** [`fdab0d1`](https://github.com/apsahasra/snova/commit/fdab0d1) - Authentication: scrypt passwords, server-side sessions, role middleware, tests

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

**Commit:** [`86e2ba4`](https://github.com/apsahasra/snova/commit/86e2ba4) - Ledger engine: accounts, deposit/withdraw/transfer with row locks, policy module, race tests

---

## Entry 4 - 2026-11-12 - Statements, tamper detection and the audit views (audit trail)

**What I asked for.** A per-account statement, proof that the ledger is
append-only, and what the admin and the auditor can see and do.

**What the tool produced.** A statement endpoint, `src/ledger/verify.js`
(recomputes conservation, double entry, every running balance and a
per-account hash chain from the raw rows), admin endpoints (create user,
freeze, adjustment with a mandatory reason), read-only audit endpoints, and
12 more tests.

**What was wrong.**

1. *The new verify check exposed damage from my own earlier experiment, and
   proved that an earlier test was too weak.* On its first run the "verify
   passes on honest data" test failed: `account 1072: hash chain broken at entry 375, 376, 378...`. Account 1072 belonged to a `race_...` test user
   created at 08:16 UTC - during the Entry 3 run where `FOR UPDATE` had been
   removed on purpose. Looking at the rows, entries 374/375/376 all had the
   same `prev_hash`: three concurrent requests had each read the same "last
   entry" and forked the chain. So the "20 simultaneous withdrawals" test that
   *passed* without the lock in Entry 3 had in fact corrupted the ledger; it
   just was not checking for it. Two fixes:
   - `assertBooksBalance()` in the test helpers now runs the full
     `verifyLedger()` (hash chains and running balances, not only sums).
     Re-ran the no-lock mutation: **5 tests fail now, including the one that
     used to pass.**
   - `npm test` now deletes `.pgdata-test` and starts from an empty database,
     so a deliberately broken run cannot leave bad rows for the next one. (I
     did not "fix" the test by deleting the bad rows - they were real evidence.)
2. *Leftover Postgres processes, root cause.* The half-dead `postgres.exe`
   from Entry 3 came back. This time I looked at the process instead of
   killing it: its command line was `--forkchild="io_worker"`, a Postgres 18
   helper that survived its parent and kept the listening port open. The tool's
   earlier fix (remove a stale `postmaster.pid`) could never have worked because
   the pid file was already gone. Real fix: start the embedded server with
   `io_method=sync`, which has no worker processes. Three clean runs in a row
   afterwards.

**Decision to defend.** The append-only triggers stop the application (and
anyone using its database login through SQL) from changing a ledger row. They
do not stop the database *owner*, who can disable a trigger. The hash chain is
for that case: the test disables the trigger, edits an amount, and checks that
`/api/audit/verify` reports the exact entry. It detects, it does not prevent.

**Commit:** [`a6c8e17`](https://github.com/apsahasra/snova/commit/a6c8e17) - Statements, ledger verification with hash chain, admin and auditor endpoints, tests

---

## Entry 5 - 2026-11-12 - Deployment (Render + Neon) and attacking the live site

**What I asked for.** Deploy to a free host and check that the deployed
system, not just my laptop, holds up.

**What the tool produced.** `render.yaml`, deployment steps, and
`scripts/live-check.js`, which attacks a running URL (12 simultaneous
withdrawals, the same transfer sent 9 times, cross-user theft, bad amounts)
and finishes by running the auditor's ledger verification.

**What was wrong / rejected.**

1. *Rejected an AI-generated setup prompt.* Neon's onboarding offered a
   ready-made prompt for a coding agent: install a global `neon` CLI, run
   `neon init`, write the connection strings to `.env.local`, and "use them
   in my app's code following the installed Neon agent skills". I asked the
   tool whether to run it and it said no, and I agree: the app reads exactly
   one variable, `DATABASE_URL`, from the host's environment; it does not read
   `.env.local`; and letting a second tool edit the database code of a ledger
   I have to explain line by line is the opposite of what I want. Copied the
   connection string into Render's environment settings by hand instead.
2. *First deploy crashed: `getaddrinfo ENOTFOUND base`.* The build passed and
   the server died in `migrate()`. `base` is not in my code or in Neon's host
   name. The tool recognised it as the placeholder host the `pg` library uses
   when the connection string is not a complete URL - so the `DATABASE_URL`
   value in Render was malformed, not the code. I corrected the value in
   Render and the next deploy went live. The tool's deployment steps had said
   "copy the connection string" without warning that Neon's dialog can show it
   wrapped in a `psql '...'` command; the README step now says to pick the
   bare `postgresql://` URL.
3. *The Node version was left open-ended.* The tool had written
   `"engines": { "node": ">=22" }`. Render read that and installed **Node
   26.13.1** - a major version neither of us had run the tests on (they run on
   Node 24 locally). It worked, but "the newest thing that exists on the day
   of the deploy" is not a version I chose. Pinned `engines.node` to `24.x`,
   the version the 43 tests pass on.

**Result on the live site** (`node scripts/live-check.js https://snova.onrender.com`):
9 of 9 checks pass - exactly 4 of 12 racing withdrawals succeed, the transfer
sent 9 times is paid once, both theft attempts are refused and appear on the
victim's statement, and verification reports the sum of all balances as 0.

**Commit:** _(fill in the hash of the "live check" commit)_
