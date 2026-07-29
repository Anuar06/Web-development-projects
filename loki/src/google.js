// Google integration: OAuth 2.0 (authorization code + refresh tokens) and
// thin REST clients for Calendar and Gmail. No SDK — plain fetch against
// Google's documented endpoints, so it is easy to read and to extend.
import crypto from 'node:crypto';
import { config } from './config.js';
import { getDb, persist } from './store.js';

const DAY = 86_400_000;

export const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  // Drafts only — lets LOKI place a draft in Gmail. It can never send mail.
  'https://www.googleapis.com/auth/gmail.compose',
];

// True when the stored grant includes a scope (older grants may lack compose).
export function hasScope(scope) {
  const granted = getDb().google?.tokens?.scope || '';
  return granted.includes(scope);
}

export const redirectUri = () => `${config.baseUrl}/auth/google/callback`;

/* ---------------------------------------------------------------- OAuth */

// CSRF protection for the OAuth round-trip (single-user app → in-memory).
const pendingStates = new Map();

export function newState() {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now() + 10 * 60_000);
  return state;
}

export function consumeState(state) {
  const expiry = pendingStates.get(state);
  pendingStates.delete(state);
  return Boolean(expiry && expiry > Date.now());
}

export function authUrl(state) {
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline', // ask for a refresh token
    prompt: 'consent',      // force re-issue of the refresh token on re-link
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(body) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Google token endpoint ${res.status}: ${json.error || 'unknown_error'} ${json.error_description || ''}`.trim(),
    );
  }
  return json;
}

function normalizeTokens(raw, previous) {
  return {
    accessToken: raw.access_token,
    // Google only returns refresh_token on the first consent — keep the old one.
    refreshToken: raw.refresh_token || previous?.refreshToken || null,
    expiresAt: Date.now() + (raw.expires_in ?? 0) * 1000,
    scope: raw.scope || previous?.scope || SCOPES.join(' '),
  };
}

export async function exchangeCode(code) {
  const raw = await tokenRequest({
    code,
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
  });
  return normalizeTokens(raw, null);
}

async function accessToken() {
  const db = getDb();
  const g = db.google;
  if (!g?.tokens) throw new Error('Google is not connected');

  if (g.tokens.expiresAt - Date.now() > 60_000) return g.tokens.accessToken;

  if (!g.tokens.refreshToken) throw new Error('Google session expired — reconnect from the Connections tab');
  try {
    const raw = await tokenRequest({
      refresh_token: g.tokens.refreshToken,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      grant_type: 'refresh_token',
    });
    g.tokens = normalizeTokens(raw, g.tokens);
    g.lastError = null;
    persist();
    return g.tokens.accessToken;
  } catch (err) {
    g.lastError = String(err.message || err);
    persist();
    throw err;
  }
}

export function connected() {
  return Boolean(getDb().google?.tokens);
}

export async function fetchUserinfo(token) {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Google userinfo ${res.status}`);
  return res.json();
}

export async function disconnect() {
  const db = getDb();
  const tokens = db.google?.tokens;
  db.google = null;
  persist();
  clearCache();
  // Best effort: tell Google to revoke the grant as well.
  const token = tokens?.refreshToken || tokens?.accessToken;
  if (token) {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    }).catch(() => {});
  }
}

/* ------------------------------------------------------------ API calls */

async function gapi(url) {
  const token = await accessToken();
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Google API ${res.status} for ${new URL(url).pathname}`);
  return res.json();
}

const fmtTime = (iso) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

// Today's events from the primary calendar → "Today's Schedule" card.
export async function todaysEvents() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + DAY);
  const params = new URLSearchParams({
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '12',
  });
  const data = await gapi(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`);
  return (data.items || [])
    .filter((e) => e.status !== 'cancelled')
    .map((e) => ({
      time: e.start?.dateTime ? fmtTime(e.start.dateTime) : 'all-day',
      label: e.summary || '(untitled)',
    }));
}

// Starred Gmail messages → "Flagged Messages" card.
export async function flaggedMessages() {
  const list = await gapi(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent('is:starred')}&maxResults=5`,
  );
  const messages = await Promise.all(
    (list.messages || []).map((m) =>
      gapi(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
      ),
    ),
  );
  return messages.map((msg) => {
    const headers = Object.fromEntries(
      (msg.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]),
    );
    return {
      from: parseFrom(headers.from || ''),
      subject: headers.subject || '(no subject)',
      receivedAt: Number(msg.internalDate) || Date.now(),
    };
  });
}

// Create a Gmail draft (never sends). Recipient is left blank on purpose —
// the user picks it in Gmail before sending.
export async function createDraft(subject, body) {
  if (!hasScope('gmail.compose')) {
    const err = new Error('Google was linked before draft access existed — reconnect from the Connections tab to grant it.');
    err.code = 'missing_scope';
    throw err;
  }
  const mime = [
    'To: ',
    `Subject: ${subject.replace(/[\r\n]/g, ' ')}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
  ].join('\r\n');
  const token = await accessToken();
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message: { raw: Buffer.from(mime).toString('base64url') } }),
  });
  if (!res.ok) throw new Error(`Gmail drafts API ${res.status}`);
  return res.json();
}

// '"Bert V." <bert@eurodecants.be>' → 'Bert V.'
function parseFrom(value) {
  const match = value.match(/^\s*"?([^"<]*?)"?\s*(?:<[^>]+>)?\s*$/);
  const name = (match?.[1] || '').trim();
  return name || value.replace(/[<>]/g, '').trim();
}

/* -------------------------------------------------------------- caching */
// The dashboard polls every minute; Google is only asked every 2 minutes.

const TTL = 2 * 60_000;
const cache = new Map();

async function cachedCall(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit;
  const data = await fn();
  const entry = { at: Date.now(), data };
  cache.set(key, entry);
  return entry;
}

export const scheduleSync = () => cachedCall('schedule', todaysEvents);
export const flaggedSync = () => cachedCall('flagged', flaggedMessages);
export const clearCache = () => cache.clear();
