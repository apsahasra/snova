# LedgerLine

Money movement with a ledger you can prove: accounts, deposits, withdrawals and
transfers where the books always balance, the same request never pays twice,
and every posting and refused attempt is on an append-only record.

- **Live site:** _add the Render URL here after deploying_
- **Demo video:** _not recorded yet_
- **Threat model:** [THREATS.md](THREATS.md)
- **API reference:** [docs/API.md](docs/API.md)
- **How AI was used:** [PROMPTS.md](PROMPTS.md)

## Demo logins

| Role | Username | Password | What they can do |
|------|----------|----------|------------------|
| Administrator | `admin` | `Admin#Ledger1` | Create users, open accounts for holders, deposit into any account, make adjustments (reason required), freeze accounts, see everything. Cannot withdraw or transfer customers' money. |
| Account holder | `alice` | `Alice#Ledger1` | Owns account **1001**. Deposit, withdraw and transfer from her own accounts only. |
| Account holder | `bob` | `Bob#Ledger1` | Owns account **1002**. Same as alice, for his accounts. |
| Auditor | `auditor` | `Audit#Ledger1` | Read-only: every account, statement, transaction and audit event, the integrity check and the flags. Cannot change anything. |

You can also register a new account holder from the login page.

The free host sleeps when idle: the first request can take up to a minute.

## Run it on your machine

Needs **Node.js 22 or newer**. No database install is needed.

```bash
git clone <this repository>
cd snova
npm install
npm run dev
```

Open http://localhost:3000 and log in with a demo login above.

With no `DATABASE_URL`, `npm run dev` starts its own real PostgreSQL (from the
`embedded-postgres` dev dependency) in `./.pgdata` on port 54329, creates the
schema and seeds the demo users and accounts. To use your own PostgreSQL
instead, copy `.env.example` to `.env` and set `DATABASE_URL`.

If the embedded database cannot start on your machine (it refuses to run as
the Linux `root` user, for example), point `DATABASE_URL` at any PostgreSQL 14+:

```bash
docker run -d --name ledgerline-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17
# Linux/macOS:
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run dev
```

### Run the tests

```bash
npm test
```

43 tests, about 40 seconds. They start a fresh embedded PostgreSQL in
`./.pgdata-test` (port 54330), start the real server on a random port and send
real HTTP requests, including concurrent ones. Set `DATABASE_URL` first to run
them against your own (empty, disposable) database instead.

### Other commands

| Command | What it does |
|---------|--------------|
| `npm run migrate` | Applies [db/schema.sql](db/schema.sql). Safe to repeat. |
| `npm run seed` | Creates the demo users and accounts if missing. Safe to repeat. |
| `npm start` | Starts the server (also migrates and seeds; both are idempotent). |

## Deploy (Render + Neon, both free, no card)

1. **Database.** Create a project at neon.tech. On the project dashboard press
   **Connect**, switch **Connection pooling off**, and copy the connection
   string (it starts with `postgresql://`).
2. **Web service.** At render.com choose **New > Web Service**, connect this
   GitHub repository, and set:
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free
   - Environment variables: `DATABASE_URL` = the Neon string, `NODE_ENV` = `production`
3. Deploy. On first start the server creates the schema and the demo data.
   Check `https://<your-app>.onrender.com/api/health`.

[render.yaml](render.yaml) describes the same service for Render's Blueprint option.

## What works

1. **Roles.** Admin, account holder, auditor - see the table above. Enforced
   on the server for every request; all the rules are in one file, [src/policy.js](src/policy.js).
2. **Accounts.** Open an account, view its balance, view its statement.
3. **Money in and out.** Deposit, withdraw, transfer between two accounts.
4. **Conservation.** Double-entry: every movement is a debit on one account
   and an equal credit on another. Deposits and withdrawals use the single
   "External world" account (id 1000), so the sum of all balances is always 0
   and customers' total changes only by deposits and withdrawals.
   `GET /api/audit/verify` (Audit tab) recomputes this from the raw rows.
5. **Zero floor.** No customer account goes below zero. There is no overdraft.
6. **Idempotency.** Every money request carries an `Idempotency-Key`; the
   same key from the same user moves money once and returns the first answer.
7. **Concurrency safety.** Row locks taken in a fixed order, inside one
   database transaction per movement.
8. **Statement.** Every debit, credit and refused attempt with the balance
   after it and who initiated it.
9. **Per-account authorisation.** A holder can move money only out of their
   own accounts; decided on the server under the account lock.
10. **Tests.** `npm test` - conservation, races, replays, cross-user attempts,
    append-only, tamper detection.

Beyond the list: freeze/unfreeze, admin adjustments with a mandatory reason,
an auditor "flags" report, a per-account hash chain for tamper detection,
and a web UI for all three roles.

## Integrity and concurrency model

**One movement = one database transaction** ([src/ledger/engine.js](src/ledger/engine.js)):

1. Insert the idempotency key (`PRIMARY KEY (user_id, key)`). If it already
   exists, return the stored answer and stop. A duplicate that arrives while
   the first is still running waits here, inside Postgres, until the first commits.
2. Lock both account rows: `SELECT ... FOR UPDATE`, in ascending id order
   (so opposite transfers cannot deadlock).
3. Decide, using the locked rows: authorised? frozen? enough balance?
4. Posted: update both balances, insert a debit entry and a credit entry.
   Refused: insert a refused transaction and one refused entry on the
   account's statement. Balances are not touched.
5. Store the answer under the key. Commit. Any error rolls back everything.

Because the balance is read after the lock is taken, two racing withdrawals
cannot both see "enough". Isolation level is Postgres's default, READ
COMMITTED; the explicit row locks are what make it safe.

**The database enforces the rules a second time**, in case the code is wrong
([db/schema.sql](db/schema.sql)):

- `CHECK`: a customer balance cannot be negative.
- A deferred trigger: at commit, a transaction's debits must equal its credits.
- Triggers: `transactions`, `entries` and `audit_events` reject `UPDATE`,
  `DELETE` and `TRUNCATE`.

**Tamper detection.** Each entry stores a hash of the previous entry on the
same account plus its own facts. Editing or removing an old row breaks the
chain, and the integrity check names the entry. This detects edits made by
someone who can switch the triggers off; it does not prevent them - see THREATS.md.

**Why double-entry and not a single balance column with a rule:** with two
rows per movement, "money was created" is a query (`SUM` is not 0), not an
opinion. The stored balance is a convenience that is checked against the entries.

## What is deliberately not built

Overdrafts, holds, reversals as their own operation, scheduled or batch
transfers, multiple currencies, daily limits, two-person approval, password
reset. Reasons and the known open risks are in [THREATS.md](THREATS.md).

## What is not finished

- **Demo video** is not recorded yet.
- **The web UI has no automated browser tests.** The 43 automated tests are
  all at the API level.
- **A holder's deposit is simulated**: there is no real payment rail behind
  it (THREATS.md, accepted risk 1).
- **No rate limit on money endpoints** (accepted risk 6).
- **The app uses one database role** that owns the tables (accepted risk 3).
- **Users cannot be deactivated from the UI or API** - the `is_active` flag
  is honoured on every request and tested, but only settable in the database.
- **Statements page by `before=<entry id>` in the API only**; the UI shows
  the latest 200 rows.

## Project layout

```
db/schema.sql            tables, constraints, append-only and balance triggers
src/server.js            start: connect, migrate, seed, listen
src/app.js               Express app, routes, error handler
src/db.js                connection pool, withTransaction, embedded dev database
src/policy.js            EVERY authorisation decision
src/validate.js          input checks (ids, amounts, idempotency key)
src/ledger/engine.js     the only code that changes a balance
src/ledger/idempotency.js  exactly-once
src/ledger/hash.js       per-account hash chain
src/ledger/verify.js     recompute and check the whole ledger
src/auth/                password hashing, sessions, login middleware
src/routes/              HTTP endpoints (auth, accounts, money, admin, audit)
public/                  web client (plain HTML, CSS, JavaScript)
test/                    automated tests
scripts/                 migrate, seed, test runner
```

## AI use

Built with Claude Code. [PROMPTS.md](PROMPTS.md) is the log, written as the
work happened, including what the tool got wrong.
