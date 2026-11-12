// Exactly-once: the same Idempotency-Key never moves money twice.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  api, assertBooksBalance, balanceOf, deposit, newHolderWithMoney, newKey, query,
  startTestServer, stopTestServer, transfer, withdraw,
} from './helpers.js';

before(startTestServer);
after(async () => {
  try {
    await assertBooksBalance();
  } finally {
    await stopTestServer();
  }
});

const movementsWithKey = async (key) =>
  (await query('SELECT count(*)::int AS n FROM transactions WHERE idempotency_key = $1', [key])).rows[0].n;

test('RETRY: the same transfer sent twice pays once and returns the same answer', async () => {
  const payer = await newHolderWithMoney(10_000, 'idem');
  const vendor = await newHolderWithMoney(0, 'idem');
  const key = newKey();

  const first = await transfer(payer, payer.accountId, vendor.accountId, 3_000, key);
  const second = await transfer(payer, payer.accountId, vendor.accountId, 3_000, key);

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.deepEqual(second.body, first.body, 'the replay returns exactly the first answer');
  assert.equal(first.headers.get('idempotent-replay'), null);
  assert.equal(second.headers.get('idempotent-replay'), 'true');

  assert.equal(await balanceOf(payer.accountId), 7_000);
  assert.equal(await balanceOf(vendor.accountId), 3_000, 'the vendor is paid once, not twice');
  assert.equal(await movementsWithKey(key), 1);
});

test('RACE: ten copies of the same request at the same instant move money once', async () => {
  const payer = await newHolderWithMoney(10_000, 'idem');
  const vendor = await newHolderWithMoney(0, 'idem');
  const key = newKey();

  const responses = await Promise.all(
    Array.from({ length: 10 }, () => transfer(payer, payer.accountId, vendor.accountId, 1_000, key)),
  );

  for (const response of responses) {
    assert.equal(response.status, 201);
    assert.deepEqual(response.body, responses[0].body, 'every copy gets the same transaction back');
  }
  assert.equal(responses.filter((r) => r.headers.get('idempotent-replay') === 'true').length, 9);
  assert.equal(await balanceOf(payer.accountId), 9_000);
  assert.equal(await balanceOf(vendor.accountId), 1_000);
  assert.equal(await movementsWithKey(key), 1);
});

test('RACE: double-clicked deposits and withdrawals are applied once each', async () => {
  const user = await newHolderWithMoney(5_000, 'idem');
  const depositKey = newKey();
  const withdrawKey = newKey();
  await Promise.all([
    deposit(user, user.accountId, 700, depositKey),
    deposit(user, user.accountId, 700, depositKey),
    deposit(user, user.accountId, 700, depositKey),
    withdraw(user, user.accountId, 200, withdrawKey),
    withdraw(user, user.accountId, 200, withdrawKey),
    withdraw(user, user.accountId, 200, withdrawKey),
  ]);
  assert.equal(await balanceOf(user.accountId), 5_000 + 700 - 200);
});

test('a refused request replays as the same refusal, even if it would now succeed', async () => {
  const user = await newHolderWithMoney(100, 'idem');
  const key = newKey();

  const first = await withdraw(user, user.accountId, 500, key);
  assert.equal(first.status, 409);

  await deposit(user, user.accountId, 1_000); // now there would be enough
  const second = await withdraw(user, user.accountId, 500, key);
  assert.equal(second.status, 409);
  assert.deepEqual(second.body, first.body);
  assert.equal(await balanceOf(user.accountId), 1_100, 'the replay did not withdraw');
});

test('the same key with a different amount or account is rejected and moves nothing', async () => {
  const payer = await newHolderWithMoney(10_000, 'idem');
  const vendor = await newHolderWithMoney(0, 'idem');
  const key = newKey();

  assert.equal((await transfer(payer, payer.accountId, vendor.accountId, 1_000, key)).status, 201);
  const changedAmount = await transfer(payer, payer.accountId, vendor.accountId, 9_000, key);
  assert.equal(changedAmount.status, 422);
  assert.equal(changedAmount.body.error, 'idempotency_key_reused');
  assert.equal((await withdraw(payer, payer.accountId, 1_000, key)).status, 422);

  assert.equal(await balanceOf(payer.accountId), 9_000);
  assert.equal(await balanceOf(vendor.accountId), 1_000);
});

test('keys belong to a user: another user reusing the key gets their own result, not a replay', async () => {
  const a = await newHolderWithMoney(1_000, 'idem');
  const b = await newHolderWithMoney(1_000, 'idem');
  const key = newKey();

  const first = await withdraw(a, a.accountId, 300, key);
  const other = await withdraw(b, b.accountId, 300, key);
  assert.equal(other.status, 201);
  assert.equal(other.headers.get('idempotent-replay'), null);
  assert.notEqual(other.body.transaction.id, first.body.transaction.id);
  assert.equal(await balanceOf(a.accountId), 700);
  assert.equal(await balanceOf(b.accountId), 700);
});

test('every duplicate is visible in the data as an audit event', async () => {
  const user = await newHolderWithMoney(1_000, 'idem');
  const key = newKey();
  const first = await withdraw(user, user.accountId, 100, key);
  await withdraw(user, user.accountId, 100, key);
  await withdraw(user, user.accountId, 100, key);

  const replays = await query(
    `SELECT detail FROM audit_events WHERE action = 'idempotent_replay' AND actor_id = $1 AND detail->>'key' = $2`,
    [user.id, key],
  );
  assert.equal(replays.rowCount, 2);
  assert.equal(replays.rows[0].detail.transaction_id, first.body.transaction.id);
});

test('a request rejected before it reaches the ledger does not burn the key', async () => {
  const user = await newHolderWithMoney(1_000, 'idem');
  const key = newKey();
  const bad = await api('POST', `/api/accounts/${user.accountId}/withdraw`, {
    token: user.token, key, body: { amount: -5 },
  });
  assert.equal(bad.status, 400);
  assert.equal((await withdraw(user, user.accountId, 400, key)).status, 201);
  assert.equal(await balanceOf(user.accountId), 600);
});
