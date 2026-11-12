import { readFile } from 'node:fs/promises';
import { query } from './db.js';
import { hashPassword } from './auth/passwords.js';
import { EXTERNAL_ACCOUNT_ID, moveMoney } from './ledger/engine.js';

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

// Gives alice and bob one account each with an opening deposit, so the demo
// has something to look at. The deposits go through the normal ledger engine
// (as the admin user, with fixed idempotency keys), so running this twice
// never deposits twice.
const DEMO_ACCOUNTS = [
  { owner: 'alice', name: 'Alice main', opening: 5_000_000 }, // Rs 50,000.00
  { owner: 'bob', name: 'Bob main', opening: 2_000_000 }, // Rs 20,000.00
];

export async function seedDemoAccounts() {
  const admin = (await query(`SELECT id, username, role FROM users WHERE username = 'admin'`)).rows[0];
  for (const demo of DEMO_ACCOUNTS) {
    const owner = (await query('SELECT id FROM users WHERE username = $1', [demo.owner])).rows[0];
    if (!admin || !owner) continue;
    const existing = await query('SELECT id FROM accounts WHERE owner_id = $1 ORDER BY id LIMIT 1', [owner.id]);
    if (existing.rowCount > 0) continue;
    const created = await query('INSERT INTO accounts (owner_id, name) VALUES ($1, $2) RETURNING id', [owner.id, demo.name]);
    await moveMoney({
      user: admin,
      type: 'deposit',
      fromId: EXTERNAL_ACCOUNT_ID,
      toId: created.rows[0].id,
      amount: demo.opening,
      memo: 'Opening balance (demo seed)',
      idempotencyKey: `seed-opening-${demo.owner}`,
    });
  }
}
