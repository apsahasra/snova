// Shared test setup: starts the real app on a random port against a real
// Postgres (the one in DATABASE_URL; `npm test` provides an embedded one).
import { randomUUID } from 'node:crypto';
import { connect, disconnect, query } from '../src/db.js';
import { migrate, seedUsers } from '../src/setup.js';
import { createApp } from '../src/app.js';
import { verifyLedger } from '../src/ledger/verify.js';

export { query };

let server;
let baseUrl;

export async function startTestServer() {
  // `npm test` (scripts/test.js) starts the database and passes DATABASE_URL.
  if (!process.env.DATABASE_URL) throw new Error('Run the tests with: npm test');
  connect(process.env.DATABASE_URL);
  await migrate();
  await seedUsers();
  await new Promise((resolve) => {
    // A high login limit: the tests log in far more often than a person would.
    server = createApp({ loginLimit: 100000 }).listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

export async function stopTestServer() {
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnect();
}

// api('POST', '/api/x', { token, body, key }) -> { status, body, headers }
export async function api(method, path, { token, body, key } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (key) headers['idempotency-key'] = key;
  const response = await fetch(baseUrl + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

export const newKey = () => randomUUID();

export async function login(username, password) {
  const response = await api('POST', '/api/auth/login', { body: { username, password } });
  if (response.status !== 200) throw new Error(`login failed for ${username}: ${response.status}`);
  return response.body.token;
}

// Registers a brand-new account holder with a unique name and logs them in.
export async function newHolder(prefix = 'user') {
  const username = `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const password = 'Test#Password1';
  const registered = await api('POST', '/api/auth/register', { body: { username, password } });
  if (registered.status !== 201) throw new Error(`register failed: ${registered.status}`);
  return { id: registered.body.user.id, username, token: await login(username, password) };
}

// The seed users, with the default demo passwords from src/setup.js.
export const loginAdmin = () => login('admin', process.env.SEED_ADMIN_PASSWORD || 'Admin#Ledger1');
export const loginAuditor = () => login('auditor', process.env.SEED_AUDITOR_PASSWORD || 'Audit#Ledger1');

// ---- money helpers -------------------------------------------------------

export async function openAccount(user, name = 'Main') {
  const response = await api('POST', '/api/accounts', { token: user.token, body: { name } });
  if (response.status !== 201) throw new Error(`open account failed: ${response.status}`);
  return response.body.account.id;
}

// A new holder with one account holding `balance` paise.
export async function newHolderWithMoney(balance, prefix = 'user') {
  const user = await newHolder(prefix);
  const accountId = await openAccount(user);
  if (balance > 0) {
    const response = await deposit(user, accountId, balance);
    if (response.status !== 201) throw new Error(`deposit failed: ${response.status}`);
  }
  return { ...user, accountId };
}

export const deposit = (user, accountId, amount, key = newKey()) =>
  api('POST', `/api/accounts/${accountId}/deposit`, { token: user.token, key, body: { amount } });

export const withdraw = (user, accountId, amount, key = newKey()) =>
  api('POST', `/api/accounts/${accountId}/withdraw`, { token: user.token, key, body: { amount } });

export const transfer = (user, fromId, toId, amount, key = newKey()) =>
  api('POST', '/api/transfers', {
    token: user.token,
    key,
    body: { from_account_id: fromId, to_account_id: toId, amount },
  });

export async function balanceOf(accountId) {
  const result = await query('SELECT balance FROM accounts WHERE id = $1', [accountId]);
  return result.rows[0].balance;
}

// The conservation invariant, checked straight from the database.
// Throws if money has been created or destroyed anywhere.
export async function assertBooksBalance() {
  // The same full check the auditor runs: conservation, double entry, running
  // balances and the per-account hash chains.
  const report = await verifyLedger();
  if (!report.ok) throw new Error(`ledger verification failed: ${report.problems.join('; ')}`);

  const total = await query('SELECT COALESCE(SUM(balance), 0)::bigint AS total FROM accounts');
  if (total.rows[0].total !== 0) throw new Error(`sum of all balances is ${total.rows[0].total}, expected 0`);

  const unbalanced = await query(
    `SELECT transaction_id FROM entries WHERE status = 'posted'
      GROUP BY transaction_id
     HAVING SUM(CASE direction WHEN 'credit' THEN amount ELSE -amount END) <> 0`,
  );
  if (unbalanced.rowCount > 0) throw new Error(`${unbalanced.rowCount} transactions do not net to zero`);

  const drift = await query(
    `SELECT a.id FROM accounts a
       LEFT JOIN entries e ON e.account_id = a.id AND e.status = 'posted'
      GROUP BY a.id, a.balance
     HAVING a.balance <> COALESCE(SUM(CASE e.direction WHEN 'credit' THEN e.amount ELSE -e.amount END), 0)`,
  );
  if (drift.rowCount > 0) throw new Error(`${drift.rowCount} accounts have a balance that differs from their entries`);
}
