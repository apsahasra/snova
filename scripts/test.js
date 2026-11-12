// Usage: npm test
// Starts ONE Postgres for the whole test run (unless DATABASE_URL is already
// set), runs every test file against it, then stops it.
import { spawn } from 'node:child_process';
import { resolveDatabaseUrl, stopEmbedded } from '../src/db.js';

const databaseUrl = await resolveDatabaseUrl({ dataDir: '.pgdata-test', port: 54330 });

const runner = spawn(
  process.execPath,
  ['--test', '--test-concurrency=1', '--test-timeout=120000', 'test/*.test.js'],
  { stdio: 'inherit', env: { ...process.env, DATABASE_URL: databaseUrl } },
);

runner.on('exit', async (code) => {
  await stopEmbedded();
  process.exit(code ?? 1);
});
