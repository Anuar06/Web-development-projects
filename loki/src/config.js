import 'dotenv/config';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT || 3000);

export const config = {
  port,
  baseUrl: (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  },
  dataFile: process.env.LOKI_DATA_FILE || fileURLToPath(new URL('../data/db.json', import.meta.url)),
};

export const googleConfigured = () =>
  Boolean(config.google.clientId && config.google.clientSecret);
