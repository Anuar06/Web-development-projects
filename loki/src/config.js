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
  ai: {
    // 'auto' picks Anthropic when a key is set, else a running Ollama, else off.
    provider: (process.env.AI_PROVIDER || 'auto').toLowerCase(),
    anthropicKey: process.env.ANTHROPIC_API_KEY || '',
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
    ollamaUrl: (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, ''),
    ollamaModel: process.env.OLLAMA_MODEL || '', // empty = first installed model
  },
  dataFile: process.env.LOKI_DATA_FILE || fileURLToPath(new URL('../data/db.json', import.meta.url)),
};

export const googleConfigured = () =>
  Boolean(config.google.clientId && config.google.clientSecret);
