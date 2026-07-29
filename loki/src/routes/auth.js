import { Router } from 'express';
import { googleConfigured } from '../config.js';
import * as google from '../google.js';
import { getDb, persist } from '../store.js';

export const auth = Router();

// Kick off the OAuth consent flow.
auth.get('/auth/google', (_req, res) => {
  if (!googleConfigured()) return res.redirect('/?google=unconfigured#connections');
  res.redirect(google.authUrl(google.newState()));
});

// Google redirects back here with a one-time code.
auth.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/?google=denied#connections');
  if (!code || !google.consumeState(String(state || ''))) {
    return res.redirect('/?google=state_mismatch#connections');
  }
  try {
    const tokens = await google.exchangeCode(String(code));
    const me = await google.fetchUserinfo(tokens.accessToken).catch(() => ({}));
    const db = getDb();
    db.google = {
      tokens,
      email: me.email || null,
      name: me.name || null,
      connectedAt: Date.now(),
      lastError: null,
    };
    persist();
    google.clearCache();
    res.redirect('/?google=connected#connections');
  } catch (err) {
    console.error('[auth] Google callback failed:', err.message);
    res.redirect('/?google=error#connections');
  }
});

auth.post('/api/auth/disconnect', async (_req, res) => {
  await google.disconnect();
  res.json({ ok: true });
});
