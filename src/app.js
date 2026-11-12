import express from 'express';
import helmet from 'helmet';
import { query } from './db.js';
import { HttpError } from './errors.js';
import { createAuthRouter } from './routes/auth.js';

// Builds the Express app. Kept separate from server.js so the tests can start
// the same app on a random port.
export function createApp(options = {}) {
  const app = express();

  // The app runs behind exactly one reverse proxy on Render. This makes
  // req.ip the real client address (needed by the login rate limiter).
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Security headers, including a Content-Security-Policy that only allows
  // scripts and styles from our own origin (no inline scripts).
  app.use(helmet());
  app.use(express.json({ limit: '10kb' }));

  app.get('/api/health', async (req, res) => {
    await query('SELECT 1');
    res.json({ status: 'ok' });
  });

  app.use('/api/auth', createAuthRouter({ loginLimit: options.loginLimit }));

  // Unknown API route
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'not_found', message: 'No such endpoint' });
  });

  // Central error handler. HttpError = an answer we chose to give the client.
  // Anything else is a bug: log the detail, never send it to the client.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.code, message: err.message });
    }
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
