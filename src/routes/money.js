// The money-moving endpoints. They only validate input and call the ledger
// engine; whether the caller is allowed is decided inside the engine
// (src/policy.js), under the account locks, so that a refused attempt is
// recorded on the statement like everything else.
import { Router } from 'express';
import { badRequest } from '../errors.js';
import { requireLogin } from '../auth/middleware.js';
import { EXTERNAL_ACCOUNT_ID, moveMoney } from '../ledger/engine.js';
import { readAmount, readId, readIdempotencyKey, readText } from '../validate.js';

export const moneyRouter = Router();

async function move(req, res, type, fromId, toId) {
  if (fromId === toId) throw badRequest('The two accounts must be different');
  const result = await moveMoney({
    user: req.user,
    type,
    fromId,
    toId,
    amount: readAmount(req.body?.amount),
    memo: readText(req.body?.memo, 'memo'),
    idempotencyKey: readIdempotencyKey(req),
  });
  res.status(result.status).json(result.body);
}

// POST /api/accounts/:id/deposit { amount, memo? } - money in from outside.
moneyRouter.post('/accounts/:id/deposit', requireLogin, async (req, res) => {
  await move(req, res, 'deposit', EXTERNAL_ACCOUNT_ID, readId(req.params.id));
});

// POST /api/accounts/:id/withdraw { amount, memo? } - money out to outside.
moneyRouter.post('/accounts/:id/withdraw', requireLogin, async (req, res) => {
  await move(req, res, 'withdrawal', readId(req.params.id), EXTERNAL_ACCOUNT_ID);
});

// POST /api/transfers { from_account_id, to_account_id, amount, memo? }
moneyRouter.post('/transfers', requireLogin, async (req, res) => {
  const fromId = readId(req.body?.from_account_id, 'from_account_id');
  const toId = readId(req.body?.to_account_id, 'to_account_id');
  await move(req, res, 'transfer', fromId, toId);
});
