// Usage: npm run seed
// Creates the demo users (admin, auditor, alice, bob) if they do not exist.
import { connect, disconnect, resolveDatabaseUrl, stopEmbedded } from '../src/db.js';
import { migrate, seedUsers } from '../src/setup.js';

connect(await resolveDatabaseUrl());
await migrate();
const created = await seedUsers();
console.log(created.length ? `Created users: ${created.join(', ')}` : 'Seed users already exist.');
await disconnect();
await stopEmbedded();
