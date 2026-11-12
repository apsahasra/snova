// Usage: npm test
// Starts ONE Postgres for the whole test run (unless DATABASE_URL is already
// set), runs every test file against it, then stops it.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolveDatabaseUrl, stopEmbedded } from '../src/db.js';

// Start from an empty database every time, so that a run with a deliberately
// broken build (see PROMPTS.md) cannot leave bad rows behind for the next run.
if (!process.env.DATABASE_URL) rmSync('.pgdata-test', { recursive: true, force: true });

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
