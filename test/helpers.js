// Shared test setup: starts the real app on a random port against a real
// Postgres (DATABASE_URL if set, otherwise an embedded one in ./.pgdata-test).
import { randomUUID } from 'node:crypto';
import { connect, disconnect, resolveDatabaseUrl, stopEmbedded, query } from '../src/db.js';
import { migrate, seedUsers } from '../src/setup.js';
import { createApp } from '../src/app.js';

export { query };

let server;
let baseUrl;

export async function startTestServer() {
  connect(await resolveDatabaseUrl({ dataDir: '.pgdata-test', port: 54330 }));
  await migrate();
  await seedUsers();
  await new Promise((resolve) => {
    // A high login limit: the tests log in far more often than a person would.
    server = createApp({ loginLimit: 100000 }).listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

export async function stopTestServer() {
  await new Promise((resolve) => server.close(resolve));
  await disconnect();
  await stopEmbedded();
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
