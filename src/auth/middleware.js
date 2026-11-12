import { findUserByToken } from './sessions.js';
import { forbidden, unauthenticated } from '../errors.js';

function readBearerToken(req) {
  const header = req.get('authorization') || '';
  const match = /^Bearer ([0-9a-f]{64})$/.exec(header);
  return match ? match[1] : null;
}

// Every protected route goes through this. It sets req.user = { id, username, role }
// from the database, or answers 401.
export async function requireLogin(req, res, next) {
  const token = readBearerToken(req);
  if (!token) throw unauthenticated();
  const user = await findUserByToken(token);
  if (!user) throw unauthenticated('Session is invalid or has expired');
  req.user = user;
  req.token = token;
  next();
}

// requireRole('admin') or requireRole('admin', 'auditor'). Use after requireLogin.
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) throw forbidden(`This needs one of these roles: ${roles.join(', ')}`);
    next();
  };
}
