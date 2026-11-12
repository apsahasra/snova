import { query } from './db.js';

// Writes one row to the append-only audit_events table.
// Pass `client` to write inside an open database transaction.
export async function recordEvent(action, actorId, detail = {}, client = null) {
  const run = client ? client.query.bind(client) : query;
  await run('INSERT INTO audit_events (action, actor_id, detail) VALUES ($1, $2, $3)', [
    action,
    actorId,
    JSON.stringify(detail),
  ]);
}
