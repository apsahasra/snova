import { config } from './config.js';
import { connect, disconnect, resolveDatabaseUrl, stopEmbedded } from './db.js';
import { createApp } from './app.js';

const databaseUrl = await resolveDatabaseUrl();
connect(databaseUrl);

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`LedgerLine listening on http://localhost:${config.port}`);
});

// Shut down cleanly so the embedded database is not left running.
async function shutdown() {
  server.close();
  await disconnect();
  await stopEmbedded();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
