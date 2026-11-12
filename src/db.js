import pg from 'pg';
import { config } from './config.js';

// Postgres BIGINT (type id 20) arrives as a string by default. Every BIGINT we
// store is capped below Number.MAX_SAFE_INTEGER by a CHECK constraint, so it is
// safe to read them as JavaScript numbers.
pg.types.setTypeParser(20, (value) => Number(value));

let pool = null;

// Hosted Postgres (Neon, Render) needs TLS; a database on localhost does not.
function needsSsl(connectionString) {
  return !/@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
}

export function connect(connectionString) {
  pool = new pg.Pool({
    connectionString,
    max: 10,
    ssl: needsSsl(connectionString) ? { rejectUnauthorized: true } : false,
    // A request must never wait forever on a lock held by another request.
    options: '-c lock_timeout=10000 -c statement_timeout=15000',
  });
  // An idle client erroring (e.g. the database restarted) must not crash the process.
  pool.on('error', (err) => console.error('idle database client error:', err.message));
  return pool;
}

export function getPool() {
  if (!pool) throw new Error('database not connected - call connect() first');
  return pool;
}

export function query(text, params) {
  return getPool().query(text, params);
}

// Runs `work(client)` inside one database transaction.
// COMMIT if it returns, ROLLBACK if it throws. Nothing is ever half-applied.
export async function withTransaction(work) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function disconnect() {
  if (pool) await pool.end();
  pool = null;
}

// Returns the connection string to use. In development, when DATABASE_URL is
// not set, it starts a real Postgres server from the `embedded-postgres`
// package so the project runs from a clean clone with no database install.
let embedded = null;

export async function resolveDatabaseUrl({ dataDir = '.pgdata', port = 54329 } = {}) {
  if (config.databaseUrl) return config.databaseUrl;
  if (config.isProduction) {
    throw new Error('DATABASE_URL is required when NODE_ENV=production');
  }

  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const { existsSync, readFileSync, rmSync } = await import('node:fs');
  const firstRun = !existsSync(`${dataDir}/PG_VERSION`);

  // If an earlier run was killed, its Postgres process and lock file are still
  // there and would block this start. Stop that process and remove the file.
  const pidFile = `${dataDir}/postmaster.pid`;
  if (existsSync(pidFile)) {
    try {
      // the first line of postmaster.pid is the process id
      process.kill(parseInt(readFileSync(pidFile, 'utf8'), 10));
    } catch {
      // already gone
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    rmSync(pidFile, { force: true });
  }

  embedded = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: true,
    // Postgres 18 starts "io_worker" helper processes. On Windows they can
    // outlive a stopped server and keep the port busy; sync I/O has no workers.
    postgresFlags: ['-c', 'io_method=sync'],
    onLog: () => {},
    onError: () => {},
  });
  if (firstRun) await embedded.initialise();
  await embedded.start();
  if (firstRun) await embedded.createDatabase('ledgerline');
  return `postgres://postgres:postgres@localhost:${port}/ledgerline`;
}

export async function stopEmbedded() {
  if (embedded) await embedded.stop();
  embedded = null;
}
