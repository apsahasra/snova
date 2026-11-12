// Read-only views of the whole system for the auditor and the admin.
// There is no POST, PUT or DELETE in this file.
import { Router } from 'express';
import { query } from '../db.js';
import { badRequest } from '../errors.js';
import { requireLogin, requireRole } from '../auth/middleware.js';
import { verifyLedger } from '../ledger/verify.js';

export const auditRouter = Router();
auditRouter.use(requireLogin, requireRole('admin', 'auditor'));

// Amounts at or above this are listed under "large" in the flags report.
const LARGE_AMOUNT = 10_000_000; // Rs 1,00,000.00

export function readLimit(value, fallback = 100) {
  if (value === undefined) return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw badRequest('limit must be between 1 and 500');
  return limit;
}

const TRANSACTION_SELECT = `
  SELECT t.id, t.type, t.status, t.amount, t.from_account_id, t.to_account_id,
         u.username AS initiated_by, t.refusal_reason, t.memo, t.idempotency_key, t.created_at
    FROM transactions t JOIN users u ON u.id = t.initiated_by`;

// GET /api/audit/transactions?status=posted|refused&limit=100
auditRouter.get('/transactions', async (req, res) => {
  const status = req.query.status;
  if (status !== undefined && status !== 'posted' && status !== 'refused') {
    throw badRequest('status must be "posted" or "refused"');
  }
  const result = await query(
    `${TRANSACTION_SELECT} WHERE $1::text IS NULL OR t.status = $1 ORDER BY t.id DESC LIMIT $2`,
    [status ?? null, readLimit(req.query.limit)],
  );
  res.json({ transactions: result.rows });
});

// GET /api/audit/events?limit=100 - logins, replays, freezes, account openings...
auditRouter.get('/events', async (req, res) => {
  const result = await query(
    `SELECT e.id, e.action, u.username AS actor, e.detail, e.created_at
       FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id
      ORDER BY e.id DESC LIMIT $1`,
    [readLimit(req.query.limit)],
  );
  res.json({ events: result.rows });
});

// GET /api/audit/verify - recompute the books from the raw ledger.
auditRouter.get('/verify', async (req, res) => {
  res.json(await verifyLedger());
});

// GET /api/audit/flags - the things worth a second look.
auditRouter.get('/flags', async (req, res) => {
  const transactions = (where, params = []) =>
    query(`${TRANSACTION_SELECT} WHERE ${where} ORDER BY t.id DESC LIMIT 50`, params).then((r) => r.rows);
  const events = (action) =>
    query(
      `SELECT e.id, e.action, u.username AS actor, e.detail, e.created_at
         FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.action = $1 ORDER BY e.id DESC LIMIT 50`,
      [action],
    ).then((r) => r.rows);

  res.json({
    // someone tried to move money on an account they are not entitled to
    unauthorised_attempts: await transactions(`t.refusal_reason = 'not_authorised'`),
    // money created or removed by an admin, with the stated reason
    adjustments: await transactions(`t.type = 'adjustment'`),
    large_movements: await transactions(`t.status = 'posted' AND t.amount >= $1`, [LARGE_AMOUNT]),
    // the same request arriving more than once
    replayed_requests: await events('idempotent_replay'),
    // one key used for two different requests
    key_mismatches: await events('idempotency_key_mismatch'),
    failed_logins: await events('login_failed'),
  });
});
