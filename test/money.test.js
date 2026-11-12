// Conservation, the zero floor under concurrency, and per-account authorisation.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  api, assertBooksBalance, balanceOf, deposit, loginAdmin, loginAuditor, newHolder, newHolderWithMoney,
  newKey, query, startTestServer, stopTestServer, transfer, withdraw,
} from './helpers.js';

before(startTestServer);
after(async () => {
  try {
    await assertBooksBalance(); // whatever the tests did, the books must still balance
  } finally {
    await stopTestServer(); // always stop, or a failed check would leave the run hanging
  }
});

const count = (responses, status) => responses.filter((r) => r.status === status).length;

// ---- basic behaviour -----------------------------------------------------

test('deposit, withdraw and transfer change balances by exactly the amount', async () => {
  const alice = await newHolderWithMoney(10_000, 'basic');
  const bob = await newHolderWithMoney(0, 'basic');

  assert.equal((await withdraw(alice, alice.accountId, 2_500)).status, 201);
  const sent = await transfer(alice, alice.accountId, bob.accountId, 4_000);
  assert.equal(sent.status, 201);
  assert.equal(sent.body.balance_after, 3_500);

  assert.equal(await balanceOf(alice.accountId), 3_500);
  assert.equal(await balanceOf(bob.accountId), 4_000);
  await assertBooksBalance();
});

test('total of customer balances changes only by deposits minus withdrawals', async () => {
  const customerTotal = async () =>
    (await query(`SELECT COALESCE(SUM(balance),0)::bigint AS t FROM accounts WHERE kind = 'customer'`)).rows[0].t;
  const before = await customerTotal();

  const a = await newHolderWithMoney(50_000, 'cons'); // +50,000
  const b = await newHolderWithMoney(20_000, 'cons'); // +20,000
  await transfer(a, a.accountId, b.accountId, 12_345); // internal: +0
  await transfer(b, b.accountId, a.accountId, 999); // internal: +0
  await withdraw(b, b.accountId, 7_000); // -7,000
  await withdraw(a, a.accountId, 99_999_999); // refused: +0

  assert.equal((await customerTotal()) - before, 50_000 + 20_000 - 7_000);
  await assertBooksBalance();
});

test('a withdrawal larger than the balance is refused and recorded', async () => {
  const user = await newHolderWithMoney(1_000, 'floor');
  const response = await withdraw(user, user.accountId, 1_001);
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'insufficient_funds');
  assert.equal(await balanceOf(user.accountId), 1_000);

  const refused = await query(
    `SELECT balance_after FROM entries WHERE account_id = $1 AND status = 'refused'`, [user.accountId]);
  assert.equal(refused.rowCount, 1);
  assert.equal(refused.rows[0].balance_after, 1_000);
});

// ---- concurrency: these fire real overlapping requests --------------------

test('RACE: 20 simultaneous withdrawals of 100 from a balance of 1000 - exactly 10 succeed', async () => {
  const user = await newHolderWithMoney(1_000, 'race');
  const responses = await Promise.all(
    Array.from({ length: 20 }, () => withdraw(user, user.accountId, 100)),
  );
  assert.equal(count(responses, 201), 10, 'exactly ten withdrawals fit in the balance');
  assert.equal(count(responses, 409), 10, 'the other ten are refused cleanly, not crashed');
  assert.equal(await balanceOf(user.accountId), 0);
  await assertBooksBalance();
});

test('RACE: two simultaneous withdrawals of the full balance - exactly one succeeds (20 rounds)', async () => {
  for (let round = 0; round < 20; round += 1) {
    const user = await newHolderWithMoney(5_000, 'race2');
    const responses = await Promise.all([
      withdraw(user, user.accountId, 5_000),
      withdraw(user, user.accountId, 5_000),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
    assert.equal(await balanceOf(user.accountId), 0);
  }
  await assertBooksBalance();
});

test('RACE: simultaneous transfers to ten different accounts cannot overdraw the source', async () => {
  const source = await newHolderWithMoney(500, 'fan');
  const targets = await Promise.all(Array.from({ length: 10 }, () => newHolderWithMoney(0, 'fan')));
  const responses = await Promise.all(
    targets.map((target) => transfer(source, source.accountId, target.accountId, 100)),
  );
  assert.equal(count(responses, 201), 5);
  assert.equal(count(responses, 409), 5);
  assert.equal(await balanceOf(source.accountId), 0);
  const received = await Promise.all(targets.map((t) => balanceOf(t.accountId)));
  assert.equal(received.reduce((sum, b) => sum + b, 0), 500);
  await assertBooksBalance();
});

test('RACE: transfers A->B and B->A at the same time do not deadlock or lose money', async () => {
  const a = await newHolderWithMoney(10_000, 'cross');
  const b = await newHolderWithMoney(10_000, 'cross');
  const requests = [];
  for (let i = 0; i < 15; i += 1) {
    requests.push(transfer(a, a.accountId, b.accountId, 300));
    requests.push(transfer(b, b.accountId, a.accountId, 200));
  }
  const responses = await Promise.all(requests);
  assert.equal(count(responses, 201), 30, 'every transfer completes; none is killed by a deadlock');
  assert.equal(await balanceOf(a.accountId), 10_000 - 15 * 300 + 15 * 200);
  assert.equal(await balanceOf(b.accountId), 10_000 + 15 * 300 - 15 * 200);
  await assertBooksBalance();
});

test('RACE: the running balance on the statement is consistent after concurrent movements', async () => {
  const user = await newHolderWithMoney(2_000, 'chain');
  await Promise.all([
    ...Array.from({ length: 10 }, () => deposit(user, user.accountId, 70)),
    ...Array.from({ length: 10 }, () => withdraw(user, user.accountId, 250)),
  ]);
  const entries = await query(
    'SELECT direction, amount, status, balance_after FROM entries WHERE account_id = $1 ORDER BY id', [user.accountId]);
  let running = 0;
  for (const entry of entries.rows) {
    if (entry.status === 'posted') running += entry.direction === 'credit' ? entry.amount : -entry.amount;
    assert.equal(entry.balance_after, running, 'each row shows the balance right after it');
    assert.ok(entry.balance_after >= 0);
  }
  assert.equal(await balanceOf(user.accountId), running);
});

// ---- authorisation: one user cannot move another user's money --------------

test('a holder cannot withdraw from or transfer out of another holder account', async () => {
  const victim = await newHolderWithMoney(9_000, 'victim');
  const attacker = await newHolderWithMoney(100, 'attacker');

  const stolen = await transfer(attacker, victim.accountId, attacker.accountId, 5_000);
  assert.equal(stolen.status, 403);
  assert.equal(stolen.body.balance_after, undefined, 'the refusal must not leak the victim balance');
  assert.equal((await withdraw(attacker, victim.accountId, 5_000)).status, 403);

  assert.equal(await balanceOf(victim.accountId), 9_000);
  assert.equal(await balanceOf(attacker.accountId), 100);

  // Both attempts are on the victim's statement, with who tried.
  const attempts = await query(
    `SELECT t.initiated_by, t.refusal_reason FROM entries e JOIN transactions t ON t.id = e.transaction_id
      WHERE e.account_id = $1 AND e.status = 'refused'`, [victim.accountId]);
  assert.equal(attempts.rowCount, 2);
  for (const row of attempts.rows) {
    assert.equal(row.initiated_by, attacker.id);
    assert.equal(row.refusal_reason, 'not_authorised');
  }
});

test('a holder cannot deposit into, or view, another holder account', async () => {
  const victim = await newHolderWithMoney(1_000, 'victim');
  const other = await newHolder('other');
  assert.equal((await deposit(other, victim.accountId, 500)).status, 403);
  assert.equal((await api('GET', `/api/accounts/${victim.accountId}`, { token: other.token })).status, 403);
  const listed = await api('GET', '/api/accounts', { token: other.token });
  assert.deepEqual(listed.body.accounts, []);
  assert.equal(await balanceOf(victim.accountId), 1_000);
});

test('nobody can pull money out of the external account with a transfer', async () => {
  const user = await newHolderWithMoney(0, 'ext');
  assert.equal((await transfer(user, 1000, user.accountId, 5_000)).status, 403);
  assert.equal((await transfer(user, user.accountId, 1000, 1)).status, 403);
  assert.equal(await balanceOf(user.accountId), 0);
});

test('the auditor is read-only and the admin cannot move customer money', async () => {
  const victim = await newHolderWithMoney(3_000, 'victim');
  const other = await newHolderWithMoney(0, 'other');
  const auditor = { token: await loginAuditor() };
  const admin = { token: await loginAdmin() };

  assert.equal((await api('GET', `/api/accounts/${victim.accountId}`, { token: auditor.token })).status, 200);
  assert.equal((await deposit(auditor, victim.accountId, 100)).status, 403);
  assert.equal((await withdraw(auditor, victim.accountId, 100)).status, 403);
  assert.equal((await transfer(auditor, victim.accountId, other.accountId, 100)).status, 403);
  assert.equal((await api('POST', '/api/accounts', { token: auditor.token, body: { name: 'x' } })).status, 403);

  assert.equal((await withdraw(admin, victim.accountId, 100)).status, 403);
  assert.equal((await transfer(admin, victim.accountId, other.accountId, 100)).status, 403);
  assert.equal((await deposit(admin, victim.accountId, 100)).status, 201, 'admin may pay a deposit in');

  assert.equal(await balanceOf(victim.accountId), 3_100);
  assert.equal(await balanceOf(other.accountId), 0);
});

test('a holder cannot open an account in another user name', async () => {
  const a = await newHolder('own');
  const b = await newHolder('own');
  const response = await api('POST', '/api/accounts', { token: a.token, body: { name: 'x', owner_id: b.id } });
  assert.equal(response.status, 403);
});

test('money endpoints need a login', async () => {
  const user = await newHolderWithMoney(1_000, 'anon');
  const anonymous = {};
  assert.equal((await withdraw(anonymous, user.accountId, 100)).status, 401);
  assert.equal((await transfer(anonymous, user.accountId, 1001, 100)).status, 401);
  assert.equal(await balanceOf(user.accountId), 1_000);
});

// ---- input validation ------------------------------------------------------

test('bad amounts and bad requests are rejected with 400 and move nothing', async () => {
  const user = await newHolderWithMoney(1_000, 'bad');
  const other = await newHolderWithMoney(0, 'bad');
  const post = (body, key = newKey()) => api('POST', '/api/transfers', { token: user.token, key, body });
  const base = { from_account_id: user.accountId, to_account_id: other.accountId };

  for (const amount of [-100, 0, 0.5, 10.01, '100', null, true, [100], 1e30, 1_000_000_001, Number.MAX_SAFE_INTEGER]) {
    const response = await post({ ...base, amount });
    assert.equal(response.status, 400, `amount ${JSON.stringify(amount)} must be rejected`);
  }
  // A negative transfer would be a way to pull money from the other account.
  assert.equal((await post({ from_account_id: other.accountId, to_account_id: user.accountId, amount: -500 })).status, 400);
  assert.equal((await post({ ...base, to_account_id: user.accountId, amount: 100 })).status, 400, 'same account');
  assert.equal((await post({ ...base, to_account_id: 99_999_999, amount: 100 })).status, 404, 'unknown account');
  assert.equal((await post({ ...base, amount: 100 }, null)).status, 400, 'missing Idempotency-Key');
  assert.equal((await post({ ...base, amount: 100, memo: 'x'.repeat(201) })).status, 400);

  assert.equal(await balanceOf(user.accountId), 1_000);
  assert.equal(await balanceOf(other.accountId), 0);
});
