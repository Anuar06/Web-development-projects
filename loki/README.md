# LOKI v0.3 — personal system

Backend + dashboard for LOKI. Node.js/Express server, JSON file storage, and a
Google integration (OAuth 2.0) that feeds two dashboard cards with real data:

| Card | Source |
| --- | --- |
| Today's Schedule | Google Calendar (primary calendar, today's events) |
| Flagged Messages | Gmail (starred threads) |

Everything else (plan, CCNA countdown, kot fund, pipeline, tasks, nudges) is
stored locally in `data/db.json` and editable through the API.

> Note: Google's APIs don't expose browser history — Calendar + Gmail is what
> Google makes available, and it's exactly what the dashboard uses. More
> sources (Tasks, Drive, bank, Notion) can be added the same way later.

## Quick start

```bash
cd loki
npm install
cp .env.example .env   # optional until you want Google sync
npm start              # → http://localhost:3000
```

The dashboard works immediately with local seed data. The "Google not
configured" chip disappears once you finish the setup below.

## Connect LOKI to Google (one-time, ~5 minutes)

1. Go to <https://console.cloud.google.com/> and create a project (e.g. `loki`).
2. **Enable the two APIs** — in *APIs & Services → Library*, enable:
   - *Google Calendar API*
   - *Gmail API*
3. **Consent screen** — *APIs & Services → OAuth consent screen*:
   - User type: **External**, then fill in app name `LOKI` and your email.
   - Add yourself (your Gmail address) under **Test users**.
4. **Credentials** — *APIs & Services → Credentials → Create credentials →
   OAuth client ID*:
   - Application type: **Web application**
   - Authorized redirect URI: `http://localhost:3000/auth/google/callback`
5. Copy the **Client ID** and **Client secret** into `loki/.env`:
   ```
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   ```
6. Restart the server, open the **Connections** tab, hit **Connect**, approve
   the consent screen. Done — Schedule and Flagged Messages now sync (cached
   for 2 minutes, dashboard polls every minute).

Scopes requested are **read-only**: `calendar.readonly`, `gmail.readonly`,
plus `openid email profile` for the account label. LOKI never writes to your
Google account.

⚠️ While the Google app is in *Testing* mode, Google expires the refresh token
after 7 days — you'll need to hit Connect again weekly. Publishing the app
(no verification needed for personal use) removes that limit.

## What's real vs. stubbed in v0.3

- **Real:** Google Calendar + Gmail sync, tasks, pipeline/fund/CCNA/plan data,
  the "LOKI is watching" nudge engine, the generated Briefing text.
- **Stubs (design-complete, integration pending):** Bank / budgeting app,
  VIVES portal, Notion rows on Connections; the Briefing "draft the follow-up"
  exchange; Voice/Widget action buttons that promise v0.4 modules.

## API

| Method & path | What it does |
| --- | --- |
| `GET /api/dashboard` | Everything the UI needs (all tabs) |
| `GET /api/briefing` | Generated briefing paragraph + actions |
| `GET /api/health` | Liveness check |
| `POST /api/tasks` `{text}` | Add a task |
| `PATCH /api/tasks/:id` `{done?, text?}` | Toggle/rename a task |
| `DELETE /api/tasks/:id` | Remove a task |
| `PATCH /api/pipeline` `{prospects?, contacted?, replied?, booked?}` | Update pipeline counters |
| `PATCH /api/fund` `{currentEur?, goalEur?, reauthNeeded?}` | Update kot fund |
| `PATCH /api/ccna` `{lastMockPct?, examDate?}` | Update CCNA tracker (`examDate` = `YYYY-MM-DD`) |
| `PATCH /api/plan/milestones/:id` `{status?, sub?}` | Move a milestone (`cleared`, `in progress`, `building`, `upcoming`, `pending`, `awaiting reply`) |
| `POST /api/activity` `{type?, text}` | Log an event into the watching feed |
| `GET /auth/google` | Start the OAuth flow |
| `POST /api/auth/disconnect` | Revoke + forget the Google grant |

Example — log today's mock exam score:

```bash
curl -X PATCH localhost:3000/api/ccna -H 'content-type: application/json' -d '{"lastMockPct":86}'
```

## Project layout

```
loki/
├── server.js            Express entry point
├── src/
│   ├── config.js        env + paths
│   ├── store.js         JSON file store + first-run seed
│   ├── google.js        OAuth flow, token refresh, Calendar/Gmail clients
│   ├── nudges.js        "LOKI is watching" rules + briefing generator
│   └── routes/          auth.js (OAuth), api.js (REST)
├── public/              the dashboard (vanilla HTML/CSS/JS, six tabs)
└── data/db.json         your data + Google tokens (gitignored, created on first run)
```

## Security notes

- `data/db.json` holds your Google refresh token — it is gitignored; keep it
  on your own machine.
- The server binds to localhost and has no login of its own: don't expose the
  port to the internet as-is.
- Disconnect (Connections tab) revokes the grant at Google, not just locally.
