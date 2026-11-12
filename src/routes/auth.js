import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { query } from '../db.js';
import { recordEvent } from '../audit.js';
import { badRequest, HttpError, unauthenticated } from '../errors.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { createSession, deleteSession } from '../auth/sessions.js';
import { requireLogin } from '../auth/middleware.js';


const USERNAME = /^[a-z0-9_]{3,30}$/;

// Used so a login for an unknown username takes as long as a wrong password.
const DUMMY_HASH = await hashPassword('not-a-real-password');

function readCredentials(body) {
  const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  return { username, password };
}

// loginLimit = how many login/register attempts one IP address may make per
// 15 minutes. It slows down password guessing. The tests pass a high number.
export function createAuthRouter({ loginLimit = 50 } = {}) {
  const authRouter = Router();

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: loginLimit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'rate_limited', message: 'Too many attempts, try again later' },
  });

  // POST /api/auth/register  { username, password }
  // Anyone can register, but only ever as an account holder. The role is fixed
  // here on the server; a "role" field in the request body is ignored.
  authRouter.post('/register', loginLimiter, async (req, res) => {
    const { username, password } = readCredentials(req.body);
    if (!USERNAME.test(username)) throw badRequest('Username must be 3-30 characters: a-z, 0-9 or _');
    if (password.length < 8 || password.length > 200) throw badRequest('Password must be 8-200 characters');

    const result = await query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'holder')
       ON CONFLICT (username) DO NOTHING
       RETURNING id, username, role`,
      [username, await hashPassword(password)],
    );
    if (result.rowCount === 0) throw new HttpError(409, 'username_taken', 'That username is already taken');

    const user = result.rows[0];
    await recordEvent('user_registered', user.id, { username });
    res.status(201).json({ user });
  });

  // POST /api/auth/login  { username, password }  ->  { token, user }
  authRouter.post('/login', loginLimiter, async (req, res) => {
    const { username, password } = readCredentials(req.body);
    if (!username || !password || password.length > 200) throw badRequest('Username and password are required');

    const result = await query(
      'SELECT id, username, role, password_hash, is_active FROM users WHERE username = $1',
      [username],
    );
    const user = result.rows[0];
    const passwordOk = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);

    if (!user || !passwordOk || !user.is_active) {
      await recordEvent('login_failed', user ? user.id : null, { username: username.slice(0, 30) });
      // Same message for every failure, so it does not reveal which usernames exist.
      throw unauthenticated('Wrong username or password');
    }

    const token = await createSession(user.id);
    await recordEvent('login_success', user.id);
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  });

  // POST /api/auth/logout - deletes the session on the server.
  authRouter.post('/logout', requireLogin, async (req, res) => {
    await deleteSession(req.token);
    await recordEvent('logout', req.user.id);
    res.json({ ok: true });
  });

  // GET /api/auth/me - who am I, according to the server.
  authRouter.get('/me', requireLogin, (req, res) => {
    res.json({ user: req.user });
  });

  return authRouter;
}
