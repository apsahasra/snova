import express from 'express';
import { query } from './db.js';

// Builds the Express app. Kept separate from server.js so the tests can start
// the same app on a random port.
export function createApp() {
  const app = express();

  app.use(express.json({ limit: '10kb' }));

  app.get('/api/health', async (req, res) => {
    await query('SELECT 1');
    res.json({ status: 'ok' });
  });

  // Unknown API route
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'not_found', message: 'No such endpoint' });
  });

  // Last-resort error handler: log the detail, never send it to the client.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON' });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'too_large', message: 'Request body is too large' });
    }
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: 'Something went wrong' });
  });

  return app;
}
