// Usage: npm run migrate
// Applies db/schema.sql to the database in DATABASE_URL (or the embedded dev database).
import { connect, disconnect, resolveDatabaseUrl, stopEmbedded } from '../src/db.js';
import { migrate } from '../src/setup.js';

connect(await resolveDatabaseUrl());
await migrate();
console.log('Schema applied.');
await disconnect();
await stopEmbedded();
