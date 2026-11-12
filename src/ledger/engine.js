// The ledger engine: the ONLY code that changes an account balance.
//
// One money movement = one database transaction that
//   1. locks both account rows (SELECT ... FOR UPDATE, always in id order),
//   2. decides: allowed? frozen? enough money?
//   3. either posts it (two balance updates + a debit entry + a credit entry)
//      or records it as a refused attempt (no balance change),
//   4. stores the answer under the request's idempotency key,
//   5. commits. If anything throws, everything is rolled back.
//
// Because the rows are locked before the balance is read, a second request for
// the same account waits at step 1 until the first has committed, and then
// sees the new balance. Two racing withdrawals cannot both "see enough".

import { withTransaction } from '../db.js';
import { config } from '../config.js';
import { notFound } from '../errors.js';
import { canMoveMoney, canViewAccount } from '../policy.js';
import { entryHash, GENESIS_HASH } from './hash.js';
import { claimKey, requestHash, saveResult } from './idempotency.js';

export const EXTERNAL_ACCOUNT_ID = 1000;

// Why a movement was refused -> HTTP status and message for the client.
const REFUSALS = {
  not_authorised: { http: 403, message: 'You are not allowed to move money on this account' },
  account_frozen: { http: 409, message: 'One of the accounts is frozen' },
  insufficient_funds: { http: 409, message: 'Insufficient funds' },
  balance_limit: { http: 409, message: 'The receiving account would exceed the maximum balance' },
};

// Locks the two accounts and returns them. Locking in ascending id order means
// a transfer A->B and a transfer B->A always take the locks in the same order,
// so they cannot deadlock each other.
async function lockAccounts(client, fromId, toId) {
  const result = await client.query(
    'SELECT id, owner_id, kind, status, balance FROM accounts WHERE id = ANY($1) ORDER BY id FOR UPDATE',
    [[fromId, toId]],
  );
  const from = result.rows.find((row) => row.id === fromId);
  const to = result.rows.find((row) => row.id === toId);
  if (!from || !to) throw notFound('Account not found');
  return { from, to };
}

// Returns null if the movement may go ahead, otherwise the refusal reason.
function decide(user, type, from, to, amount) {
  if (!canMoveMoney(user, type, from, to)) return 'not_authorised';
  if (from.status === 'frozen' || to.status === 'frozen') return 'account_frozen';
  // The floor: a customer account never goes below zero. No overdraft exists.
  if (from.kind === 'customer' && from.balance < amount) return 'insufficient_funds';
  if (to.kind === 'customer' && to.balance + amount > config.maxAccountBalance) return 'balance_limit';
  return null;
}

async function insertEntry(client, tx, accountId, direction, status, balanceAfter) {
  const last = await client.query('SELECT hash FROM entries WHERE account_id = $1 ORDER BY id DESC LIMIT 1', [
    accountId,
  ]);
  const prevHash = last.rows[0]?.hash ?? GENESIS_HASH;
  const hash = entryHash(prevHash, {
    transactionId: tx.id,
    type: tx.type,
    initiatedBy: tx.initiated_by,
    accountId,
    direction,
    amount: tx.amount,
    status,
    balanceAfter,
  });
  await client.query(
    `INSERT INTO entries (transaction_id, account_id, direction, amount, status, balance_after, prev_hash, hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tx.id, accountId, direction, tx.amount, status, balanceAfter, prevHash, hash],
  );
}

async function changeBalance(client, accountId, delta) {
  const result = await client.query('UPDATE accounts SET balance = balance + $2 WHERE id = $1 RETURNING balance', [
    accountId,
    delta,
  ]);
  return result.rows[0].balance;
}

// Moves `amount` paise from account `fromId` to account `toId` on behalf of `user`.
// Returns { status, body } - the HTTP status and JSON body to send.
// A duplicate request (same user, same Idempotency-Key) gets the stored answer
// of the first one and moves nothing.
export async function moveMoney(request) {
  const { user, idempotencyKey } = request;
  return withTransaction(async (client) => {
    const duplicate = await claimKey(client, user.id, idempotencyKey, requestHash(request));
    if (duplicate) return duplicate;

    const result = await postMovement(client, request);
    // Round-trip through JSON so the first answer and every replay are identical.
    result.body = JSON.parse(JSON.stringify(result.body));
    await saveResult(client, user.id, idempotencyKey, result);
    return result;
  });
}

// Does the actual movement. Runs inside the open database transaction.
async function postMovement(client, { user, type, fromId, toId, amount, memo, idempotencyKey }) {
  const { from, to } = await lockAccounts(client, fromId, toId);
  const refusal = decide(user, type, from, to, amount);

  const inserted = await client.query(
    `INSERT INTO transactions
       (type, status, amount, from_account_id, to_account_id, initiated_by, refusal_reason, memo, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, type, status, amount, from_account_id, to_account_id, initiated_by, refusal_reason, memo, created_at`,
    [type, refusal ? 'refused' : 'posted', amount, fromId, toId, user.id, refusal, memo, idempotencyKey],
  );
  const tx = inserted.rows[0];

  // The customer account this request was aimed at. A refused attempt is
  // written on its statement, and its new balance is what we report back.
  const subject = from.kind === 'customer' ? from : to;
  let subjectBalance = subject.balance;

  if (refusal) {
    const direction = subject === from ? 'debit' : 'credit';
    await insertEntry(client, tx, subject.id, direction, 'refused', subject.balance);
  } else {
    const fromBalance = await changeBalance(client, from.id, -amount);
    const toBalance = await changeBalance(client, to.id, amount);
    await insertEntry(client, tx, from.id, 'debit', 'posted', fromBalance);
    await insertEntry(client, tx, to.id, 'credit', 'posted', toBalance);
    subjectBalance = subject === from ? fromBalance : toBalance;
  }

  const body = { transaction: tx };
  // Only tell the caller a balance they are allowed to see anyway.
  if (canViewAccount(user, subject)) body.balance_after = subjectBalance;

  if (refusal) {
    body.error = refusal;
    body.message = REFUSALS[refusal].message;
    return { status: REFUSALS[refusal].http, body };
  }
  return { status: 201, body };
}
