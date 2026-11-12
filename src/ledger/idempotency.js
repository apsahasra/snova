// Exactly-once for money-moving requests.
//
// Every such request carries an Idempotency-Key header chosen by the client.
// The key is stored in idempotency_keys with PRIMARY KEY (user_id, key), in
// the SAME database transaction that moves the money. So either both the
// money movement and the key are committed, or neither is.
//
//   first request   -> claimKey() inserts the row, the movement runs,
//                      saveResult() stores the response, COMMIT.
//   later duplicate -> claimKey() finds the row and returns the stored
//                      response. Nothing moves.
//   duplicate that arrives while the first is still running
//                   -> its INSERT waits inside Postgres on the first one's
//                      uncommitted row. When the first commits, it sees the
//                      row and returns the stored response. If the first
//                      rolled back, the INSERT succeeds and it runs normally.
//
// Keys are remembered forever (there is no expiry job) and are per user, so
// one user can never read another user's response by guessing a key.
import { createHash } from 'node:crypto';
import { recordEvent } from '../audit.js';

// A fingerprint of what the request asked for, to detect the same key being
// reused for a different request.
export function requestHash(request) {
  const facts = JSON.stringify([request.type, request.fromId, request.toId, request.amount, request.memo]);
  return createHash('sha256').update(facts).digest('hex');
}

// Returns null if this is the first time we see the key (the caller must go
// on and do the work), or the { status, body } to send back for a duplicate.
export async function claimKey(client, userId, key, hash) {
  const claimed = await client.query(
    'INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [userId, key, hash],
  );
  if (claimed.rowCount === 1) return null;

  const stored = await client.query(
    'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2',
    [userId, key],
  );
  const first = stored.rows[0];

  if (first.request_hash !== hash) {
    await recordEvent('idempotency_key_mismatch', userId, { key }, client);
    return {
      status: 422,
      body: {
        error: 'idempotency_key_reused',
        message: 'This Idempotency-Key was already used for a different request',
      },
    };
  }

  // The data shows which requests were duplicates: one audit row per replay.
  await recordEvent(
    'idempotent_replay',
    userId,
    { key, transaction_id: first.response_body?.transaction?.id ?? null },
    client,
  );
  return { status: first.response_status, body: first.response_body, replayed: true };
}

export async function saveResult(client, userId, key, result) {
  await client.query(
    'UPDATE idempotency_keys SET response_status = $3, response_body = $4 WHERE user_id = $1 AND key = $2',
    [userId, key, result.status, JSON.stringify(result.body)],
  );
}
