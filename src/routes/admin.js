// Administrator actions. Every route here requires the admin role, except
// the adjustment, which goes through the ledger engine so that a refused
// attempt by a non-admin is written to the account's statement.
import { Router } from 'express';
import { query } from '../db.js';
import { recordEvent } from '../audit.js';
import { badRequest, HttpError, notFound } from '../errors.js';
import { requireLogin, requireRole } from '../auth/middleware.js';
import { hashPassword } from '../auth/passwords.js';
import { EXTERNAL_ACCOUNT_ID, moveMoney } from '../ledger/engine.js';
import { readAmount, readId, readIdempotencyKey, readText } from '../validate.js';

export const adminRouter = Router();
adminRouter.use(requireLogin);

const ROLES = ['admin', 'holder', 'auditor'];

// POST /api/admin/users { username, password, role } - create a user of any role.
adminRouter.post('/users', requireRole('admin'), async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const role = req.body?.role;
  if (!/^[a-z0-9_]{3,30}$/.test(username)) throw badRequest('Username must be 3-30 characters: a-z, 0-9 or _');
  if (password.length < 8 || password.length > 200) throw badRequest('Password must be 8-200 characters');
  if (!ROLES.includes(role)) throw badRequest(`role must be one of: ${ROLES.join(', ')}`);

  const created = await query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)
     ON CONFLICT (username) DO NOTHING RETURNING id, username, role`,
    [username, await hashPassword(password), role],
  );
  if (created.rowCount === 0) throw new HttpError(409, 'username_taken', 'That username is already taken');
  await recordEvent('user_created', req.user.id, { user_id: created.rows[0].id, username, role });
  res.status(201).json({ user: created.rows[0] });
});

// GET /api/admin/users - list users (admin and auditor).
adminRouter.get('/users', requireRole('admin', 'auditor'), async (req, res) => {
  const result = await query('SELECT id, username, role, is_active, created_at FROM users ORDER BY id LIMIT 500');
  res.json({ users: result.rows });
});

// POST /api/admin/accounts/:id/freeze and /unfreeze
// A frozen account refuses every movement in or out. The UPDATE takes the same
// row lock as a money movement, so it cannot slip in halfway through one.
async function setStatus(req, res, status) {
  const accountId = readId(req.params.id);
  const updated = await query(
    `UPDATE accounts SET status = $2 WHERE id = $1 AND kind = 'customer' RETURNING id, status`,
    [accountId, status],
  );
  if (updated.rowCount === 0) throw notFound('Account not found');
  await recordEvent(status === 'frozen' ? 'account_frozen' : 'account_unfrozen', req.user.id, { account_id: accountId });
  res.json({ account: updated.rows[0] });
}
adminRouter.post('/accounts/:id/freeze', requireRole('admin'), (req, res) => setStatus(req, res, 'frozen'));
adminRouter.post('/accounts/:id/unfreeze', requireRole('admin'), (req, res) => setStatus(req, res, 'active'));

// POST /api/admin/adjustments { account_id, direction: "credit" | "debit", amount, reason }
// A correction against the external account. It is an ordinary ledger posting:
// same locks, same zero floor, same idempotency, and a reason is mandatory.
adminRouter.post('/adjustments', async (req, res) => {
  const accountId = readId(req.body?.account_id, 'account_id');
  const direction = req.body?.direction;
  if (direction !== 'credit' && direction !== 'debit') throw badRequest('direction must be "credit" or "debit"');
  if (accountId === EXTERNAL_ACCOUNT_ID) throw badRequest('The external account cannot be adjusted');

  const result = await moveMoney({
    user: req.user,
    type: 'adjustment',
    fromId: direction === 'credit' ? EXTERNAL_ACCOUNT_ID : accountId,
    toId: direction === 'credit' ? accountId : EXTERNAL_ACCOUNT_ID,
    amount: readAmount(req.body?.amount),
    memo: readText(req.body?.reason, 'reason', { required: true }),
    idempotencyKey: readIdempotencyKey(req),
  });
  if (result.replayed) res.set('Idempotent-Replay', 'true');
  res.status(result.status).json(result.body);
});
