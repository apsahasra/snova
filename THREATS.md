# THREATS.md - how the money or the ledger could be broken

For each threat: what an attacker (or a bug) would do, what the system does
about it, which automated test exercises it, and what is still open.
The last section lists the risks that were knowingly accepted.

Test names refer to `test/*.test.js`. Run them all with `npm test`.

## The three promises

1. **The books balance.** The sum of all account balances, including the
   single "External world" account (id 1000), is exactly 0 at every commit.
   Deposits debit the external account, withdrawals credit it, transfers do
   not touch it. So the total held by customers changes only by external
   deposits and withdrawals.
2. **Exactly once.** One `(user, Idempotency-Key)` moves money at most once.
3. **Provable.** Every posting and every refused attempt is a row that cannot
   be updated or deleted through the application, and an edit made behind the
   application is detectable.

## A. Overdraw and lost updates

| # | Threat | What stops it | Test |
|---|--------|---------------|------|
| A1 | Two withdrawals at the same instant both read "enough balance" and both succeed | Each movement first locks the account rows with `SELECT ... FOR UPDATE`; the second request waits and then reads the new balance (`src/ledger/engine.js`, `lockAccounts`) | `RACE: two simultaneous withdrawals of the full balance` (20 rounds), `RACE: 20 simultaneous withdrawals` |
| A2 | Same race using transfers to many different accounts | Same lock - it is on the source account, whatever the destination | `RACE: simultaneous transfers to ten different accounts` |
| A3 | Application bug writes a negative balance anyway | Database constraint `CHECK (kind = 'external' OR balance >= 0)` on `accounts` | `the database refuses a negative customer balance` |
| A4 | Transfers A->B and B->A deadlock; one is killed and money is left half-moved | Locks are always taken in ascending account id order, so the two cannot wait on each other. And a killed transaction is rolled back whole | `RACE: transfers A->B and B->A at the same time` |
| A5 | Negative or zero amount ("transfer -500" pulls money the other way) | Amount must be a JSON integer > 0 (`src/validate.js`); also `CHECK (amount > 0)` in the database | `bad amounts and bad requests are rejected` |
| A6 | Fractions of a paisa, floats, strings, huge numbers, rounding | Money is integer paise in `BIGINT`. Non-integers, strings, values over the per-transaction limit (Rs 1 crore) are rejected. Balances are capped so they stay exact in JavaScript | same test |
| A7 | Transfer from an account to itself | Rejected with 400; also `CHECK (from_account_id <> to_account_id)` | same test |
| A8 | An admin adjustment drives an account below zero | Adjustments are ordinary postings through the same engine and the same floor | `only an admin can adjust; adjustments obey the zero floor` |

I removed `FOR UPDATE` and re-ran the suite: 5 tests fail. I removed the
insufficient-funds check: 4 tests fail. (Details in PROMPTS.md, entries 3 and 4.)

## B. Money created or destroyed

| # | Threat | What stops it | Test |
|---|--------|---------------|------|
| B1 | Request fails halfway: debit written, credit lost | Debit, credit, both ledger entries and the idempotency record are one database transaction. Any error rolls all of it back (`withTransaction` in `src/db.js`) | conservation is re-verified after every test file by `assertBooksBalance()` |
| B2 | Buggy code posts a one-sided entry | Deferred constraint trigger `entries_must_balance`: at COMMIT, posted debits must equal posted credits for the transaction | `the database refuses a one-sided posting` |
| B3 | A holder transfers out of the external account | `canMoveMoney` requires both sides of a transfer to be customer accounts | `nobody can pull money out of the external account` |
| B4 | The stored balance drifts away from the ledger | `GET /api/audit/verify` replays every entry and compares with the stored balance and each row's `balance_after` | `verify passes on honest data...`, `RACE: the running balance on the statement is consistent` |

## C. Paying twice

| # | Threat | What stops it | Test |
|---|--------|---------------|------|
| C1 | Retry after a timeout, or a replayed request | `Idempotency-Key` is mandatory. The key row is inserted in the same transaction as the movement; a duplicate gets the stored response and moves nothing | `RETRY: the same transfer sent twice pays once` |
| C2 | The retry arrives while the first is still running | The duplicate's `INSERT` blocks inside Postgres on the first request's uncommitted key row, then returns the first's answer | `RACE: ten copies of the same request at the same instant`, `RACE: double-clicked deposits and withdrawals` |
| C3 | Reusing a key for a different amount or account, hoping it is waved through | The key stores a hash of the request; a mismatch is a 422 and an audit event | `the same key with a different amount or account is rejected` |
| C4 | A refused request is retried later and now succeeds, surprising the client | The refusal is stored and replayed too | `a refused request replays as the same refusal` |
| C5 | Guessing another user's key to read their response or block their payment | Keys are unique per user (`PRIMARY KEY (user_id, key)`) | `keys belong to a user` |
| C6 | "Which requests were duplicates?" cannot be answered | Each replay writes an `idempotent_replay` audit event with the original transaction id; shown in the auditor's flags | `every duplicate is visible in the data` |

## D. Moving someone else's money

| # | Threat | What stops it | Test |
|---|--------|---------------|------|
| D1 | Put another user's account id in the transfer / withdraw request | Ownership is checked on the server against the locked account row, for every request (`src/policy.js`). The attempt is recorded on the victim's statement with the attacker's name | `a holder cannot withdraw from or transfer out of another holder account` |
| D2 | Read another user's balance or statement | `canViewAccount` on every read; the refusal response does not include the balance | `a holder cannot deposit into, or view, another holder account`, `a statement can be read by its owner...` |
| D3 | Become admin by sending `role: "admin"` when registering | The role is a literal in the SQL, not read from the request | `registering with role=admin in the body still creates a holder` |
| D4 | Tamper with the role or user id on the client | There is nothing to tamper with: the token is a random string; user and role are read from the database on every request | `login returns a token and /me reports the role stored on the server` |
| D5 | Auditor account used to change something | Auditor fails every `canMoveMoney` and every `requireRole('admin')` | `the auditor cannot change anything through any write endpoint` |
| D6 | Admin quietly moves a customer's money to another account | Admin cannot withdraw or transfer at all. Admin can only deposit or adjust, both against the external account, and adjustments need a reason and appear in the auditor's flags | `the auditor is read-only and the admin cannot move customer money` |
| D7 | Open an account in another user's name | `canOpenAccountFor` | `a holder cannot open an account in another user name` |
| D8 | A stolen or old token keeps working | Tokens expire after 8 hours, logout deletes the session, a deactivated user is rejected on the next request | `logout makes the token useless`, `a deactivated user loses access immediately` |
| D9 | SQL injection | Every query uses bound parameters; no SQL is built from input | (by construction; type checks in `bad amounts...`) |
| D10 | Script injection through an account name or memo shown to the auditor | The client writes all data with `textContent`; the Content-Security-Policy forbids inline scripts | (not automated) |
| D11 | Password guessing | scrypt hashes; 50 login/register attempts per IP per 15 minutes; one error message for every failure | `wrong password and unknown user get the same 401 answer` |

## E. Altering the record

| # | Threat | What stops it | Test |
|---|--------|---------------|------|
| E1 | UPDATE / DELETE / TRUNCATE on a ledger row, through any code path or SQL console using the app's connection | Triggers on `transactions`, `entries`, `audit_events` raise an error. There is no endpoint that edits or deletes them | `ledger rows cannot be updated, deleted or truncated` |
| E2 | A database owner disables the trigger, edits an amount, re-enables it | Each account has a hash chain over its entries; `verify` recomputes it and names the first broken entry | `verify passes on honest data and detects a row edited behind the triggers` |
| E3 | A refused attempt leaves no trace | Refusals are committed rows: a `transactions` row with the reason and an `entries` row on the account's statement | `the statement lists every debit, credit and refused attempt` |
| E4 | Freezing an account in the middle of a movement | The freeze `UPDATE` needs the same row lock as the movement, so it happens before or after, never during | `a frozen account refuses movements in both directions` |

## Risks I know about and accepted

These are open. I would rather list them than pretend.

1. **A holder's "deposit" is simulated external money.** A holder can deposit
   any amount (up to Rs 1 crore per request) into their own account. The books
   still balance - the external account goes negative by the same amount - but
   in a real product a deposit must be tied to a confirmed payment from a bank
   or gateway. There is no such integration here.
2. **The hash chain detects edits; it does not stop a determined database
   owner.** Someone with owner access who edits a row *and recomputes every
   later hash for that account* would pass `verify`. Nothing outside the
   database anchors the chain (no signed checkpoint, no secret key). Also
   `created_at` and `memo` are not part of the hash. Closing this needs
   periodic head hashes published somewhere the database owner cannot write.
3. **The application connects as the database owner.** A stricter setup would
   use a second role with only `INSERT`/`SELECT` on the ledger tables. On the
   free hosted database I use one role, so the triggers are the only guard.
4. **`accounts.balance` is a stored column, not derived.** It is changed only
   by the engine, under lock, and checked by `verify`, but it is a second copy
   of the truth. If the two ever disagree, `verify` reports it; nothing
   repairs it automatically.
5. **Every deposit and withdrawal locks the one external account row.** That
   serialises them system-wide. Correct, but a throughput ceiling, and a
   flood of deposits would slow other users. Transfers between customers are
   not affected. Fix: several external accounts or no stored external balance.
6. **No rate limit on money endpoints**, only on login/register. A logged-in
   user can send many requests and fill `transactions` with refused rows or
   `idempotency_keys` with keys. Keys never expire (deliberate: an expired
   key would allow a very late replay to pay twice), so that table only grows.
7. **A retry that waits longer than 10 seconds** for the first request
   (`lock_timeout`) gets a 500 rather than the first answer. It moves no
   money, and retrying again returns the stored answer.
8. **A request for an account id that does not exist is answered 404 and is
   not written anywhere**, because there is no statement to write it on.
9. **Account ids are sequential and existence is visible** (403 vs 404, and a
   transfer to any existing id succeeds). Knowing an id gives no access, but
   ids can be enumerated. Registration also reveals whether a username exists.
10. **An admin is trusted a lot.** An admin can credit any account by
    adjustment and can create another admin. It is recorded and flagged, but
    there is no second-person approval.
11. **The session token is in `sessionStorage`.** A script-injection bug
    would let an attacker steal it. I chose a bearer token over a cookie so
    that cross-site request forgery is not possible at all, and rely on the
    CSP and `textContent` against injection. The login rate limit is in
    memory, per server process: it resets on restart.
12. **`verify` reads the whole ledger** on every call. Fine at this size,
    too slow for a large one; it is restricted to admin and auditor.
13. **No test kills the server process in the middle of a transaction.**
    Atomicity there relies on Postgres rolling back an unfinished
    transaction, which I did not test myself.

## Not built, on purpose

Overdrafts (the floor is zero for every customer account), holds and
authorisations, reversals/refunds as a first-class operation (an admin
adjustment with a reason is the only correction), scheduled or batch
transfers, multiple currencies (everything is INR paise), daily limits,
two-person approval, password reset, and deactivating users from the UI.
A small system whose balances are always right was the priority.
