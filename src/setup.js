import { readFile } from 'node:fs/promises';
import { query } from './db.js';
import { hashPassword } from './auth/passwords.js';

const schemaFile = new URL('../db/schema.sql', import.meta.url);

// Creates tables, constraints and triggers. Idempotent.
export async function migrate() {
  const sql = await readFile(schemaFile, 'utf8');
  await query(sql);
}

// Demo users, one per role (two holders so cross-user attacks can be tried).
// Passwords can be overridden with environment variables; the defaults are the
// public demo passwords printed in the README.
const SEED_USERS = [
  { username: 'admin', role: 'admin', env: 'SEED_ADMIN_PASSWORD', fallback: 'Admin#Ledger1' },
  { username: 'auditor', role: 'auditor', env: 'SEED_AUDITOR_PASSWORD', fallback: 'Audit#Ledger1' },
  { username: 'alice', role: 'holder', env: 'SEED_ALICE_PASSWORD', fallback: 'Alice#Ledger1' },
  { username: 'bob', role: 'holder', env: 'SEED_BOB_PASSWORD', fallback: 'Bob#Ledger1' },
];

// Inserts the demo users if they are missing. Never changes an existing user.
export async function seedUsers() {
  const created = [];
  for (const user of SEED_USERS) {
    const password = process.env[user.env] || user.fallback;
    const result = await query(
      `INSERT INTO users (username, password_hash, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (username) DO NOTHING
       RETURNING id`,
      [user.username, await hashPassword(password), user.role],
    );
    if (result.rowCount === 1) created.push(user.username);
  }
  return created;
}
