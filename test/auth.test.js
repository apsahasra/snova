import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, login, loginAdmin, newHolder, query, startTestServer, stopTestServer } from './helpers.js';

before(startTestServer);
after(stopTestServer);

test('a request without a token is refused with 401', async () => {
  assert.equal((await api('GET', '/api/auth/me')).status, 401);
  assert.equal((await api('GET', '/api/auth/me', { token: 'f'.repeat(64) })).status, 401);
  assert.equal((await api('GET', '/api/auth/me', { token: 'not-a-token' })).status, 401);
});

test('login returns a token and /me reports the role stored on the server', async () => {
  const token = await loginAdmin();
  const me = await api('GET', '/api/auth/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.username, 'admin');
  assert.equal(me.body.user.role, 'admin');
});

test('wrong password and unknown user get the same 401 answer', async () => {
  const wrong = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'wrong-password' } });
  const unknown = await api('POST', '/api/auth/login', { body: { username: 'nobody_here', password: 'wrong-password' } });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
});

test('registering with role=admin in the body still creates a holder', async () => {
  const username = `sneaky_${Date.now()}`;
  const response = await api('POST', '/api/auth/register', {
    body: { username, password: 'Test#Password1', role: 'admin', is_admin: true },
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.user.role, 'holder');
  const stored = await query('SELECT role FROM users WHERE username = $1', [username]);
  assert.equal(stored.rows[0].role, 'holder');
});

test('weak passwords, bad usernames and duplicate usernames are rejected', async () => {
  assert.equal((await api('POST', '/api/auth/register', { body: { username: 'okname', password: 'short' } })).status, 400);
  assert.equal((await api('POST', '/api/auth/register', { body: { username: 'a b', password: 'Test#Password1' } })).status, 400);
  assert.equal((await api('POST', '/api/auth/register', { body: { username: 'admin', password: 'Test#Password1' } })).status, 409);
  assert.equal((await api('POST', '/api/auth/login', { body: { username: { $ne: null }, password: ['x'] } })).status, 400);
});

test('logout makes the token useless', async () => {
  const user = await newHolder('logout');
  assert.equal((await api('GET', '/api/auth/me', { token: user.token })).status, 200);
  assert.equal((await api('POST', '/api/auth/logout', { token: user.token })).status, 200);
  assert.equal((await api('GET', '/api/auth/me', { token: user.token })).status, 401);
});

test('a deactivated user loses access immediately, even with a valid token', async () => {
  const user = await newHolder('deact');
  await query('UPDATE users SET is_active = FALSE WHERE id = $1', [user.id]);
  assert.equal((await api('GET', '/api/auth/me', { token: user.token })).status, 401);
  await assert.rejects(login(user.username, 'Test#Password1'));
});

test('passwords are stored hashed and session tokens are stored hashed', async () => {
  const user = await newHolder('hash');
  const row = await query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
  assert.match(row.rows[0].password_hash, /^scrypt\$/);
  const session = await query('SELECT 1 FROM sessions WHERE token_hash = $1', [user.token]);
  assert.equal(session.rowCount, 0);
});
