import { Router } from 'express';
import { query } from '../db.js';
import { recordEvent } from '../audit.js';
import { badRequest, forbidden, HttpError, notFound } from '../errors.js';
import { requireLogin } from '../auth/middleware.js';
import { canOpenAccountFor, canViewAccount } from '../policy.js';
import { readId, readText } from '../validate.js';
import { readLimit } from './audit.js';

export const accountsRouter = Router();
accountsRouter.use(requireLogin);

const MAX_ACCOUNTS_PER_HOLDER = 10;
const ACCOUNT_COLUMNS = 'a.id, a.name, a.kind, a.status, a.balance, a.owner_id, u.username AS owner, a.created_at';

// Loads an account and checks the caller may see it. Used by every /:id route.
export async function loadViewableAccount(user, accountId) {
  const result = await query(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts a LEFT JOIN users u ON u.id = a.owner_id WHERE a.id = $1`,
    [accountId],
  );
  const account = result.rows[0];
  if (!account) throw notFound('Account not found');
  if (!canViewAccount(user, account)) throw forbidden('This is not your account');
  return account;
}

// POST /api/accounts { name, owner_id? }
// A holder opens an account for themselves. An admin opens one for a holder.
accountsRouter.post('/', async (req, res) => {
  const name = readText(req.body?.name, 'name', { required: true, max: 60 });
  const ownerId = req.body?.owner_id === undefined ? req.user.id : readId(req.body.owner_id, 'owner_id');
  if (!canOpenAccountFor(req.user, ownerId)) throw forbidden('You cannot open an account for this user');

  const owner = await query('SELECT id, role FROM users WHERE id = $1 AND is_active', [ownerId]);
  if (owner.rowCount === 0) throw notFound('Owner not found');
  if (owner.rows[0].role !== 'holder') throw badRequest('Accounts can only belong to account holders');

  // The count and the insert are one statement, so two racing requests cannot
  // both slip under the limit by much; the limit is a spam guard, not a money rule.
  const created = await query(
    `INSERT INTO accounts (owner_id, name)
     SELECT $1, $2 WHERE (SELECT count(*) FROM accounts WHERE owner_id = $1) < $3
     RETURNING id, name, kind, status, balance, owner_id, created_at`,
    [ownerId, name, MAX_ACCOUNTS_PER_HOLDER],
  );
  if (created.rowCount === 0) {
    throw new HttpError(409, 'account_limit', `A holder can have at most ${MAX_ACCOUNTS_PER_HOLDER} accounts`);
  }
  await recordEvent('account_opened', req.user.id, { account_id: created.rows[0].id, owner_id: ownerId });
  res.status(201).json({ account: created.rows[0] });
});

// GET /api/accounts - a holder gets their own accounts; admin and auditor get all.
accountsRouter.get('/', async (req, res) => {
  const seesAll = req.user.role === 'admin' || req.user.role === 'auditor';
  const result = await query(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts a LEFT JOIN users u ON u.id = a.owner_id
      WHERE $1 OR a.owner_id = $2
      ORDER BY a.id`,
    [seesAll, req.user.id],
  );
  res.json({ accounts: result.rows });
});

// GET /api/accounts/:id - one account with its balance.
accountsRouter.get('/:id', async (req, res) => {
  const account = await loadViewableAccount(req.user, readId(req.params.id));
  res.json({ account });
});

// GET /api/accounts/:id/statement?limit=100&before=<entry id>
// Every debit, credit and refused attempt on the account, newest first, each
// with the balance right after it and who initiated it.
accountsRouter.get('/:id/statement', async (req, res) => {
  const account = await loadViewableAccount(req.user, readId(req.params.id));
  const limit = readLimit(req.query.limit);
  const before = req.query.before === undefined ? null : readId(req.query.before, 'before');

  const result = await query(
    `SELECT e.id, e.created_at, e.direction, e.amount, e.status, e.balance_after,
            t.id AS transaction_id, t.type, t.refusal_reason, t.memo,
            u.username AS initiated_by,
            CASE WHEN t.from_account_id = e.account_id THEN t.to_account_id ELSE t.from_account_id END
              AS other_account_id
       FROM entries e
       JOIN transactions t ON t.id = e.transaction_id
       JOIN users u ON u.id = t.initiated_by
      WHERE e.account_id = $1 AND ($2::bigint IS NULL OR e.id < $2)
      ORDER BY e.id DESC
      LIMIT $3`,
    [account.id, before, limit],
  );
  res.json({ account, entries: result.rows });
});
