// Statements, the append-only ledger, tamper detection, admin and auditor powers.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  api, assertBooksBalance, balanceOf, deposit, loginAdmin, loginAuditor, newHolder, newHolderWithMoney,
  newKey, query, startTestServer, stopTestServer, transfer, withdraw,
} from './helpers.js';

let admin;
let auditor;

before(async () => {
  await startTestServer();
  admin = { token: await loginAdmin() };
  auditor = { token: await loginAuditor() };
});
after(async () => {
  try {
    await assertBooksBalance();
  } finally {
    await stopTestServer();
  }
});

const adjust = (user, accountId, direction, amount, reason = 'test correction', key = newKey()) =>
  api('POST', '/api/admin/adjustments', {
    token: user.token, key, body: { account_id: accountId, direction, amount, reason },
  });

// ---- statement -------------------------------------------------------------

test('the statement lists every debit, credit and refused attempt with balance and initiator', async () => {
  const owner = await newHolderWithMoney(1_000, 'stmt'); // credit 1000 -> 1000
  const friend = await newHolderWithMoney(0, 'stmt');
  const thief = await newHolder('thief');
  await withdraw(owner, owner.accountId, 300); // debit 300 -> 700
  await withdraw(owner, owner.accountId, 5_000); // refused -> 700
  await transfer(thief, owner.accountId, friend.accountId, 100); // refused (not authorised) -> 700
  await transfer(owner, owner.accountId, friend.accountId, 200); // debit 200 -> 500

  const response = await api('GET', `/api/accounts/${owner.accountId}/statement`, { token: owner.token });
  assert.equal(response.status, 200);
  const rows = response.body.entries.reverse(); // oldest first
  assert.deepEqual(
    rows.map((r) => [r.type, r.direction, r.status, r.amount, r.balance_after, r.initiated_by, r.refusal_reason]),
    [
      ['deposit', 'credit', 'posted', 1_000, 1_000, owner.username, null],
      ['withdrawal', 'debit', 'posted', 300, 700, owner.username, null],
      ['withdrawal', 'debit', 'refused', 5_000, 700, owner.username, 'insufficient_funds'],
      ['transfer', 'debit', 'refused', 100, 700, thief.username, 'not_authorised'],
      ['transfer', 'debit', 'posted', 200, 500, owner.username, null],
    ],
  );
  assert.equal(response.body.account.balance, 500);
});

test('a statement can be read by its owner, the admin and the auditor - nobody else', async () => {
  const owner = await newHolderWithMoney(1_000, 'stmt');
  const stranger = await newHolder('stranger');
  const path = `/api/accounts/${owner.accountId}/statement`;
  assert.equal((await api('GET', path, { token: owner.token })).status, 200);
  assert.equal((await api('GET', path, { token: admin.token })).status, 200);
  assert.equal((await api('GET', path, { token: auditor.token })).status, 200);
  assert.equal((await api('GET', path, { token: stranger.token })).status, 403);
  assert.equal((await api('GET', path)).status, 401);
});

// ---- append-only -----------------------------------------------------------

test('ledger rows cannot be updated, deleted or truncated, even with direct SQL', async () => {
  await newHolderWithMoney(1_000, 'append');
  const forbidden = [
    `UPDATE entries SET amount = 1 WHERE id = (SELECT max(id) FROM entries)`,
    `DELETE FROM entries WHERE id = (SELECT max(id) FROM entries)`,
    `TRUNCATE entries`,
    `UPDATE transactions SET status = 'refused', refusal_reason = 'x' WHERE id = (SELECT max(id) FROM transactions)`,
    `DELETE FROM transactions WHERE id = (SELECT max(id) FROM transactions)`,
    `TRUNCATE transactions CASCADE`,
    `UPDATE audit_events SET action = 'nothing' WHERE id = (SELECT max(id) FROM audit_events)`,
    `DELETE FROM audit_events`,
    `DELETE FROM accounts WHERE id = (SELECT max(id) FROM accounts)`,
  ];
  for (const sql of forbidden) {
    await assert.rejects(query(sql), /append-only/, `must be rejected: ${sql}`);
  }
});

test('the database refuses a one-sided posting (money from nowhere)', async () => {
  const user = await newHolderWithMoney(1_000, 'onesided');
  const tx = await query('SELECT id FROM transactions ORDER BY id DESC LIMIT 1');
  await assert.rejects(
    query(
      `INSERT INTO entries (transaction_id, account_id, direction, amount, status, balance_after, prev_hash, hash)
       VALUES ($1, $2, 'credit', 500, 'posted', 1500, 'x', 'y')`,
      [tx.rows[0].id, user.accountId],
    ),
    /does not balance/,
  );
});

test('the database refuses a negative customer balance, whatever the application does', async () => {
  const user = await newHolderWithMoney(1_000, 'negative');
  await assert.rejects(
    query('UPDATE accounts SET balance = -1 WHERE id = $1', [user.accountId]),
    /customer_balance_not_negative/,
  );
});

test('verify passes on honest data and detects a row edited behind the triggers', async () => {
  const user = await newHolderWithMoney(4_000, 'tamper');
  await withdraw(user, user.accountId, 1_500);

  const clean = await api('GET', '/api/audit/verify', { token: auditor.token });
  assert.equal(clean.status, 200);
  assert.deepEqual(clean.body.problems, []);
  assert.equal(clean.body.ok, true);
  assert.equal(clean.body.sum_of_all_balances, 0);

  // Simulate someone with database-owner access hiding a withdrawal:
  // switch the trigger off, shrink the amount, switch it back on.
  const target = await query(
    `SELECT id, amount FROM entries WHERE account_id = $1 AND direction = 'debit' ORDER BY id DESC LIMIT 1`,
    [user.accountId],
  );
  const { id, amount } = target.rows[0];
  await query('ALTER TABLE entries DISABLE TRIGGER entries_append_only');
  try {
    await query('UPDATE entries SET amount = 1 WHERE id = $1', [id]);
    const tampered = await api('GET', '/api/audit/verify', { token: auditor.token });
    assert.equal(tampered.body.ok, false);
    assert.ok(tampered.body.problems.some((p) => p.includes(`hash chain broken at entry ${id}`)));
  } finally {
    await query('UPDATE entries SET amount = $2 WHERE id = $1', [id, amount]); // put the truth back
    await query('ALTER TABLE entries ENABLE TRIGGER entries_append_only');
  }
  assert.equal((await api('GET', '/api/audit/verify', { token: auditor.token })).body.ok, true);
});

// ---- admin -----------------------------------------------------------------

test('only an admin can adjust; adjustments obey the zero floor and are recorded', async () => {
  const user = await newHolderWithMoney(1_000, 'adj');

  assert.equal((await adjust(user, user.accountId, 'credit', 1_000_000)).status, 403, 'holder cannot mint money');
  assert.equal((await adjust(auditor, user.accountId, 'credit', 500)).status, 403);
  assert.equal(await balanceOf(user.accountId), 1_000);

  assert.equal((await adjust(admin, user.accountId, 'credit', 500)).status, 201);
  assert.equal((await adjust(admin, user.accountId, 'debit', 200)).status, 201);
  assert.equal(await balanceOf(user.accountId), 1_300);

  const tooMuch = await adjust(admin, user.accountId, 'debit', 5_000);
  assert.equal(tooMuch.status, 409, 'even an admin cannot push an account below zero');
  assert.equal(await balanceOf(user.accountId), 1_300);

  const noReason = await api('POST', '/api/admin/adjustments', {
    token: admin.token, key: newKey(), body: { account_id: user.accountId, direction: 'credit', amount: 1 },
  });
  assert.equal(noReason.status, 400, 'a reason is mandatory');

  const key = newKey();
  await adjust(admin, user.accountId, 'credit', 100, 'retry test', key);
  await adjust(admin, user.accountId, 'credit', 100, 'retry test', key);
  assert.equal(await balanceOf(user.accountId), 1_400, 'a replayed adjustment is applied once');
});

test('a frozen account refuses movements in both directions until unfrozen', async () => {
  const user = await newHolderWithMoney(1_000, 'freeze');
  const other = await newHolderWithMoney(1_000, 'freeze');

  assert.equal((await api('POST', `/api/admin/accounts/${user.accountId}/freeze`, { token: user.token })).status, 403);
  assert.equal((await api('POST', `/api/admin/accounts/${user.accountId}/freeze`, { token: auditor.token })).status, 403);
  assert.equal((await api('POST', `/api/admin/accounts/${user.accountId}/freeze`, { token: admin.token })).status, 200);

  const out = await withdraw(user, user.accountId, 100);
  assert.equal(out.status, 409);
  assert.equal(out.body.error, 'account_frozen');
  assert.equal((await transfer(other, other.accountId, user.accountId, 100)).status, 409);
  assert.equal(await balanceOf(user.accountId), 1_000);
  assert.equal(await balanceOf(other.accountId), 1_000);

  await api('POST', `/api/admin/accounts/${user.accountId}/unfreeze`, { token: admin.token });
  assert.equal((await withdraw(user, user.accountId, 100)).status, 201);
});

test('only an admin can create users; holders and auditors cannot', async () => {
  const holder = await newHolder('nouser');
  const body = { username: `made_${Date.now()}`, password: 'Test#Password1', role: 'admin' };
  assert.equal((await api('POST', '/api/admin/users', { token: holder.token, body })).status, 403);
  assert.equal((await api('POST', '/api/admin/users', { token: auditor.token, body })).status, 403);
  assert.equal((await api('POST', '/api/admin/users', { body })).status, 401);

  const created = await api('POST', '/api/admin/users', { token: admin.token, body: { ...body, role: 'auditor' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.user.role, 'auditor');
  assert.equal((await api('POST', '/api/admin/users', { token: admin.token, body: { ...body, role: 'root' } })).status, 400);
});

// ---- auditor ---------------------------------------------------------------

test('audit views are open to admin and auditor and closed to holders', async () => {
  const holder = await newHolder('noaudit');
  for (const path of ['/api/audit/transactions', '/api/audit/events', '/api/audit/verify', '/api/audit/flags', '/api/admin/users']) {
    assert.equal((await api('GET', path, { token: auditor.token })).status, 200, path);
    assert.equal((await api('GET', path, { token: admin.token })).status, 200, path);
    assert.equal((await api('GET', path, { token: holder.token })).status, 403, path);
    assert.equal((await api('GET', path)).status, 401, path);
  }
});

test('the flags report shows unauthorised attempts and adjustments', async () => {
  const victim = await newHolderWithMoney(1_000, 'flag');
  const thief = await newHolder('flagthief');
  await withdraw(thief, victim.accountId, 999);
  await adjust(admin, victim.accountId, 'credit', 123, 'flag test');

  const flags = (await api('GET', '/api/audit/flags', { token: auditor.token })).body;
  assert.ok(flags.unauthorised_attempts.some((t) => t.initiated_by === thief.username && t.amount === 999));
  assert.ok(flags.adjustments.some((t) => t.amount === 123 && t.memo === 'flag test'));
});

test('the auditor cannot change anything through any write endpoint', async () => {
  const target = await newHolderWithMoney(1_000, 'ro');
  const other = await newHolderWithMoney(0, 'ro');
  const attempts = [
    ['POST', '/api/accounts', { name: 'mine' }],
    ['POST', `/api/accounts/${target.accountId}/deposit`, { amount: 100 }],
    ['POST', `/api/accounts/${target.accountId}/withdraw`, { amount: 100 }],
    ['POST', '/api/transfers', { from_account_id: target.accountId, to_account_id: other.accountId, amount: 100 }],
    ['POST', '/api/admin/adjustments', { account_id: target.accountId, direction: 'debit', amount: 100, reason: 'x' }],
    ['POST', `/api/admin/accounts/${target.accountId}/freeze`, {}],
    ['POST', '/api/admin/users', { username: 'zzz_new', password: 'Test#Password1', role: 'admin' }],
  ];
  for (const [method, path, body] of attempts) {
    const response = await api(method, path, { token: auditor.token, key: newKey(), body });
    assert.equal(response.status, 403, `${method} ${path}`);
  }
  assert.equal(await balanceOf(target.accountId), 1_000);
  assert.equal((await query('SELECT status FROM accounts WHERE id = $1', [target.accountId])).rows[0].status, 'active');
});
