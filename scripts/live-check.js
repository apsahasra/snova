// Usage: node scripts/live-check.js https://your-app.onrender.com
// Attacks a RUNNING deployment the way a judge would and prints PASS/FAIL.
// It registers two throw-away holders, so it adds a few rows to that database.
import { randomUUID } from 'node:crypto';

const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
let failures = 0;

async function api(method, path, { token, body, key } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (key) headers['idempotency-key'] = key;
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => ({})), replay: response.headers.get('idempotent-replay') };
}

function check(name, passed, detail = '') {
  if (!passed) failures += 1;
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function newHolder() {
  const username = `live_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const password = `Pw#${randomUUID()}`;
  await api('POST', '/api/auth/register', { body: { username, password } });
  const login = await api('POST', '/api/auth/login', { body: { username, password } });
  const token = login.body.token;
  const account = await api('POST', '/api/accounts', { token, body: { name: 'live check' } });
  return { username, token, accountId: account.body.account.id };
}

const balance = async (user) => (await api('GET', `/api/accounts/${user.accountId}`, { token: user.token })).body.account.balance;
const statuses = (responses) => responses.map((r) => r.status).sort().join(',');

console.log(`Checking ${base}\n`);
const a = await newHolder();
const b = await newHolder();
await api('POST', `/api/accounts/${a.accountId}/deposit`, { token: a.token, key: randomUUID(), body: { amount: 10_000 } });

// 1. overdraw by race
const race = await Promise.all(Array.from({ length: 12 }, () =>
  api('POST', `/api/accounts/${a.accountId}/withdraw`, { token: a.token, key: randomUUID(), body: { amount: 2_500 } })));
const won = race.filter((r) => r.status === 201).length;
check('12 simultaneous withdrawals of 2500 from 10000: exactly 4 succeed', won === 4 && (await balance(a)) === 0, `statuses ${statuses(race)}`);

// 2. replay
await api('POST', `/api/accounts/${a.accountId}/deposit`, { token: a.token, key: randomUUID(), body: { amount: 10_000 } });
const key = randomUUID();
const transfer = () => api('POST', '/api/transfers', { token: a.token, key, body: { from_account_id: a.accountId, to_account_id: b.accountId, amount: 3_000 } });
const burst = await Promise.all(Array.from({ length: 8 }, transfer));
const later = await transfer();
const sameTransaction = [...burst, later].every((r) => r.status === 201 && r.body.transaction.id === burst[0].body.transaction.id);
check('same transfer sent 9 times (8 at once): paid once', sameTransaction && (await balance(b)) === 3_000 && (await balance(a)) === 7_000,
  `replay header on the late copy: ${later.replay}`);

// 3. same key, different amount
const changed = await api('POST', '/api/transfers', { token: a.token, key, body: { from_account_id: a.accountId, to_account_id: b.accountId, amount: 7_000 } });
check('same key with a different amount is rejected', changed.status === 422 && (await balance(a)) === 7_000, `status ${changed.status}`);

// 4. moving someone else's money
const steal = await api('POST', '/api/transfers', { token: b.token, key: randomUUID(), body: { from_account_id: a.accountId, to_account_id: b.accountId, amount: 5_000 } });
const drain = await api('POST', `/api/accounts/${a.accountId}/withdraw`, { token: b.token, key: randomUUID(), body: { amount: 5_000 } });
const peek = await api('GET', `/api/accounts/${a.accountId}/statement`, { token: b.token });
check('another holder cannot transfer, withdraw or read', steal.status === 403 && drain.status === 403 && peek.status === 403 && (await balance(a)) === 7_000,
  `statuses ${steal.status},${drain.status},${peek.status}`);

// 5. bad amounts
const bad = await Promise.all([-100, 0, 0.5, '100', 1e30].map((amount) =>
  api('POST', '/api/transfers', { token: b.token, key: randomUUID(), body: { from_account_id: b.accountId, to_account_id: a.accountId, amount } })));
check('negative, zero, fractional, string and huge amounts are rejected', bad.every((r) => r.status === 400), `statuses ${statuses(bad)}`);

// 6. no login, no key
const anonymous = await api('POST', `/api/accounts/${a.accountId}/withdraw`, { key: randomUUID(), body: { amount: 1 } });
const noKey = await api('POST', `/api/accounts/${a.accountId}/withdraw`, { token: a.token, body: { amount: 1 } });
check('no token -> 401, no Idempotency-Key -> 400', anonymous.status === 401 && noKey.status === 400, `statuses ${anonymous.status},${noKey.status}`);

// 7. the refused theft is on the victim's statement
const statement = await api('GET', `/api/accounts/${a.accountId}/statement`, { token: a.token });
const recorded = statement.body.entries.filter((e) => e.status === 'refused' && e.refusal_reason === 'not_authorised' && e.initiated_by === b.username);
check('both theft attempts are on the victim statement with the attacker name', recorded.length === 2, `${recorded.length} rows`);

// 8. the books, as the auditor sees them (uses the public demo auditor login)
const auditor = await api('POST', '/api/auth/login', { body: { username: 'auditor', password: 'Audit#Ledger1' } });
if (auditor.status === 200) {
  const verify = await api('GET', '/api/audit/verify', { token: auditor.body.token });
  check('ledger verification passes and all balances sum to 0', verify.body.ok === true && verify.body.sum_of_all_balances === 0,
    `${verify.body.checked?.entries} entries checked`);
  const write = await api('POST', `/api/accounts/${a.accountId}/deposit`, { token: auditor.body.token, key: randomUUID(), body: { amount: 1 } });
  check('the auditor cannot deposit', write.status === 403, `status ${write.status}`);
} else {
  check('auditor demo login', false, `status ${auditor.status}`);
}

console.log(failures === 0 ? '\nAll live checks passed.' : `\n${failures} live check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
