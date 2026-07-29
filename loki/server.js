import express from 'express';
import { fileURLToPath } from 'node:url';
import { config, googleConfigured } from './src/config.js';
import { getDb } from './src/store.js';
import { auth } from './src/routes/auth.js';
import { api } from './src/routes/api.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json());

app.use(auth);
app.use(api);
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));

app.use((err, _req, res, _next) => {
  console.error('[loki]', err);
  res.status(500).json({ error: err.message || 'internal error' });
});

getDb(); // create data/db.json with the seed on first run

app.listen(config.port, () => {
  console.log(`LOKI backend online → ${config.baseUrl}`);
  console.log(
    googleConfigured()
      ? '  Google OAuth: configured'
      : '  Google OAuth: not configured — set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env (see README)',
  );
});
