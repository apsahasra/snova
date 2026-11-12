import { createHash, randomBytes } from 'node:crypto';
import { query } from '../db.js';
import { config } from '../config.js';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// Creates a session and returns the raw token. Only its hash is stored.
export async function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(hours => $3))`,
    [sha256(token), userId, config.sessionHours],
  );
  return token;
}

// Returns the user for a token, or null. The user row is read from the
// database on every request, so the role is never taken from the client and a
// deactivated user loses access immediately.
export async function findUserByToken(token) {
  const result = await query(
    `SELECT u.id, u.username, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.is_active`,
    [sha256(token)],
  );
  return result.rows[0] || null;
}

export async function deleteSession(token) {
  await query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}
