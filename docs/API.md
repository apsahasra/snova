# LedgerLine API

Base URL: the deployed site, or `http://localhost:3000`.

- **Auth:** send `Authorization: Bearer <token>` (the token from login).
- **Money:** every amount is a whole number of **paise** as a JSON number
  (`2500` = Rs 25.00). Limit per request: 1,000,000,000 paise.
- **Idempotency:** every money-moving request must send an `Idempotency-Key`
  header (8-128 characters: letters, digits, `-`, `_`; a UUID is ideal).
  The same key from the same user returns the first answer again with the
  header `Idempotent-Replay: true` and moves nothing.
- **Errors:** `{ "error": "<code>", "message": "<text>" }`.

Roles: **admin**, **holder** (account holder), **auditor** (read-only).

## Authentication

| Endpoint | Who may call | What it does to the money |
|----------|--------------|---------------------------|
| `POST /api/auth/register` `{username, password}` | anyone | Nothing. Creates a user with role `holder` (a `role` field is ignored). |
| `POST /api/auth/login` `{username, password}` | anyone | Nothing. Returns `{token, user}`. Token lasts 8 hours. |
| `POST /api/auth/logout` | logged in | Nothing. Deletes the session. |
| `GET /api/auth/me` | logged in | Nothing. Returns the user and role the server sees. |

Login and register share a limit of 50 requests per IP per 15 minutes (429 after that).

## Accounts

| Endpoint | Who may call | What it does to the money |
|----------|--------------|---------------------------|
| `POST /api/accounts` `{name, owner_id?}` | holder (for self only); admin (for any holder, `owner_id` required) | Nothing. Opens an account with balance 0. Max 10 per holder. |
| `GET /api/accounts` | holder: own accounts; admin, auditor: all | Read only. |
| `GET /api/accounts/:id` | owner, admin, auditor | Read only. Returns the balance. |
| `GET /api/accounts/:id/statement?limit=&before=` | owner, admin, auditor | Read only. Every debit, credit and refused attempt, newest first, with `balance_after` and `initiated_by`. `limit` 1-500 (default 100); `before` = an entry id for the next page. |

## Money movement (all need `Idempotency-Key`)

| Endpoint | Who may call | What it does to the money |
|----------|--------------|---------------------------|
| `POST /api/accounts/:id/deposit` `{amount, memo?}` | the account's owner; admin (any account) | External account -`amount`, this account +`amount`. Customer total rises by `amount`. |
| `POST /api/accounts/:id/withdraw` `{amount, memo?}` | the account's owner only | This account -`amount`, external account +`amount`. Refused if the balance is smaller than `amount`. |
| `POST /api/transfers` `{from_account_id, to_account_id, amount, memo?}` | the owner of `from_account_id` only | `from` -`amount`, `to` +`amount`. Customer total unchanged. Refused if `from` has less than `amount`. |
| `POST /api/admin/adjustments` `{account_id, direction, amount, reason}` | admin only | `direction: "credit"`: external -`amount`, account +`amount`. `direction: "debit"`: the reverse, refused if it would go below zero. `reason` is mandatory. |

Responses:

| Status | Meaning |
|--------|---------|
| `201` | Posted. Body: `{transaction, balance_after}`. |
| `403` `not_authorised` | You may not move money on this account. Recorded as a refused attempt on the account's statement. No balance in the body. |
| `409` `insufficient_funds` / `account_frozen` / `balance_limit` | Refused and recorded on the statement. Nothing moved. |
| `400` | Invalid input (bad amount, missing key, same account twice...). Nothing recorded. |
| `404` | An account does not exist. Nothing recorded. |
| `422` `idempotency_key_reused` | This key was already used for a different request. Nothing moved. |

Every `201`, `403` and `409` is stored under the idempotency key and replayed as-is.

## Administration

| Endpoint | Who may call | What it does to the money |
|----------|--------------|---------------------------|
| `POST /api/admin/users` `{username, password, role}` | admin | Nothing. Creates a user with any role. |
| `GET /api/admin/users` | admin, auditor | Read only. |
| `POST /api/admin/accounts/:id/freeze` | admin | Moves nothing. Afterwards every movement into or out of the account is refused (`account_frozen`). |
| `POST /api/admin/accounts/:id/unfreeze` | admin | Moves nothing. Lifts the freeze. |

## Audit (admin and auditor; all read-only)

| Endpoint | What it returns |
|----------|-----------------|
| `GET /api/audit/verify` | Recomputes the books from raw rows: `{ok, checked, sum_of_all_balances, problems[]}`. `sum_of_all_balances` must be 0. |
| `GET /api/audit/flags` | Unauthorised attempts, admin adjustments, large movements (>= Rs 1,00,000), replayed requests, key mismatches, failed logins (latest 50 each). |
| `GET /api/audit/transactions?status=&limit=` | All transactions, newest first. `status` = `posted` or `refused`. |
| `GET /api/audit/events?limit=` | Audit events: logins, failed logins, replays, accounts opened, freezes, users created. |

## Example: prove a replay does not pay twice

```bash
BASE=http://localhost:3000
TOKEN=$(curl -s -X POST $BASE/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"Alice#Ledger1"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')

# Same key twice: the second answer is identical and has "Idempotent-Replay: true"
for i in 1 2; do
  curl -s -i -X POST $BASE/api/transfers \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -H 'Idempotency-Key: demo-key-0001' \
    -d '{"from_account_id":1001,"to_account_id":1002,"amount":2500}'
done
```
