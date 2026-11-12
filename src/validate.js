// Input validation shared by the routes. Each function returns a clean value
// or throws a 400. Nothing from the client reaches SQL or the ledger unchecked.
import { badRequest } from './errors.js';
import { config } from './config.js';

// An id from the URL or the JSON body: a positive whole number.
export function readId(value, name = 'id') {
  const id = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest(`${name} must be a positive whole number`);
  return id;
}

// Amounts are whole paise sent as a JSON number. Strings, decimals, zero,
// negatives, NaN and anything over the per-transaction limit are rejected.
export function readAmount(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw badRequest('amount must be a positive whole number of paise');
  }
  if (value > config.maxAmountPerTransaction) {
    throw badRequest(`amount is over the per-transaction limit of ${config.maxAmountPerTransaction} paise`);
  }
  return value;
}

export function readText(value, name, { required = false, max = 200 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${name} is required`);
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw badRequest(`${name} must be text of at most ${max} characters`);
  }
  return value.trim();
}

// Every money-moving request must carry a client-chosen Idempotency-Key header.
export function readIdempotencyKey(req) {
  const key = req.get('idempotency-key');
  if (!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) {
    throw badRequest('Idempotency-Key header is required (8-128 characters: letters, digits, - or _)');
  }
  return key;
}
