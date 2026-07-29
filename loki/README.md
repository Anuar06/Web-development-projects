# LOKI v0.4 — personal system

Backend + dashboard for LOKI. Node.js/Express server, JSON file storage, a
Google integration (OAuth 2.0), and an AI brain (Claude or a local Ollama
model) that powers the conversational parts.

| Feature | Powered by |
| --- | --- |
| Today's Schedule | Google Calendar (primary calendar, today's events) |
| Flagged Messages | Gmail (starred threads) |
| Voice tab (chat, mic, spoken replies) | AI model + browser speech APIs |
| Briefing text | Generated server-side from your live data |
| Briefing "Draft the follow-up" | AI writes it → **real draft in Gmail** (never sends) |
| Flashcards / Packet Tracer lab | AI, using your CCNA data as context |
| Focus blocks + snooze (Widget) | Real timers stored server-side |
| Kot fund | Managed in-app (Connections → Bank → Update) |

Everything else (plan, CCNA tracker, pipeline, tasks, nudges) lives in
`data/db.json` and is editable through the API or the UI.

## Quick start

```bash
cd loki
npm install
cp .env.example .env   # optional until you add Google / AI
npm start              # → http://localhost:3000
```

The dashboard works immediately with local seed data. Two optional
integrations light up the rest:

## 1. Connect an AI model (the brain)

Pick one — LOKI auto-detects in this order:

**Option A — Claude (best quality).** Create an API key at
<https://console.anthropic.com> → API Keys, and put it in `loki/.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

⚠️ A claude.ai subscription does **not** include API access — the API key is
a separate thing with pay-per-token billing (LOKI's short exchanges cost
cents per day; you can set a monthly spend cap in the console). Default model
is `claude-opus-5`; override with `ANTHROPIC_MODEL=`. Requests opt into
Anthropic's server-side fallback, so if a safety classifier ever declines a
request it is retried on a fallback Claude model automatically.

**Option B — Ollama (free, local, private).** Install from
<https://ollama.com>, then `ollama pull llama3.2` (or any model). LOKI finds
the running server and uses the first installed model — no config needed.
Pin one with `OLLAMA_MODEL=`.

Restart the server; the **Connections** tab shows which brain is linked.
With an AI linked, the Voice tab is a real conversation (type, or use the
mic in Chrome/Edge — 🔊 toggles spoken replies), the Briefing tab answers
follow-ups, "Flashcard summary" generates real CCNA flashcards, and "Full
lab" produces a real Packet Tracer lab plan — all grounded in your live
dashboard data.

## 2. Connect LOKI to Google (~5 minutes)

1. Go to <https://console.cloud.google.com/> and create a project (e.g. `loki`).
2. **Enable the two APIs** — *APIs & Services → Library*: *Google Calendar
   API* and *Gmail API*.
3. **Consent screen** — *OAuth consent screen*: External, app name `LOKI`,
   and add your own Gmail under **Test users**.
4. **Credentials** — *Create credentials → OAuth client ID*: Web
   application, redirect URI `http://localhost:3000/auth/google/callback`.
5. Put the Client ID + secret in `loki/.env`, restart, open
   **Connections → Connect**.

Scopes: `calendar.readonly`, `gmail.readonly`, and `gmail.compose` — the
last one lets LOKI **create drafts** (it can never send mail). If you linked
Google on v0.3, hit **Re-link** once to grant draft access.

⚠️ While the Google app is in *Testing* mode, Google expires the refresh
token after 7 days — reconnect weekly, or publish the app to remove the limit.

## What's real vs. pending in v0.4

- **Real:** everything in the table up top, plus tasks, pipeline/fund/CCNA/
  plan data, the nudge engine, and activity logging (drafting a follow-up
  shows up in the watching feed).
- **Pending (shown honestly as "Planned" on Connections):** VIVES portal and
  Notion — neither has a wired integration yet. The bank row is manual by
  design: no Belgian bank API is practical for a personal app, so you update
  the fund in-app instead.

## API

| Method & path | What it does |
| --- | --- |
| `GET /api/dashboard` | Everything the UI needs (all tabs) |
| `GET /api/briefing` | Generated briefing paragraph + actions |
| `POST /api/chat` `{mode, messages}` | Talk to LOKI (AI, with live data as context) |
| `POST /api/flashcards` `{topic?}` | Generate CCNA flashcards |
| `POST /api/briefing/draft` | AI writes the stale follow-up → Gmail draft |
| `POST /api/block/start` `{minutes?, label?}` | Start a focus block (links to a matching task) |
| `POST /api/block/stop` `{complete?}` | Finish (marks task done + logs) or abandon |
| `POST /api/nudges/snooze` `{hours?}` | Quiet the CCNA nudge for a while |
| `POST /api/tasks` / `PATCH /api/tasks/:id` / `DELETE /api/tasks/:id` | Tasks |
| `PATCH /api/pipeline` `{prospects?, contacted?, replied?, booked?}` | Pipeline counters |
| `PATCH /api/fund` `{currentEur?, goalEur?, reauthNeeded?}` | Kot fund |
| `PATCH /api/ccna` `{lastMockPct?, examDate?}` | CCNA tracker (`YYYY-MM-DD`) |
| `PATCH /api/plan/milestones/:id` `{status?, sub?}` | Move a milestone |
| `POST /api/activity` `{type?, text}` | Log an event into the watching feed |
| `GET /auth/google` / `POST /api/auth/disconnect` | Google OAuth |
| `GET /api/health` | Liveness check |

## Project layout

```
loki/
├── server.js            Express entry point
├── src/
│   ├── config.js        env + paths
│   ├── store.js         JSON file store, seed + migrations
│   ├── ai.js            AI providers (Claude via official SDK / Ollama), persona, live-data context
│   ├── google.js        OAuth, token refresh, Calendar/Gmail read + draft creation
│   ├── nudges.js        watching-feed rules + briefing generator
│   └── routes/          auth.js (OAuth), api.js (REST + AI endpoints)
├── public/              the dashboard (vanilla HTML/CSS/JS, six tabs)
└── data/db.json         your data + Google tokens (gitignored, created on first run)
```

## Security notes

- `data/db.json` holds your Google refresh token; `.env` holds your API
  keys. Both stay on your machine and are gitignored.
- Gmail access is read + **drafts only** — LOKI cannot send mail. Disconnect
  (Connections tab) revokes the grant at Google.
- The server binds to localhost with no login of its own: don't expose the
  port to the internet as-is.
- With Ollama, everything AI stays on your machine. With Claude, chat
  context (your dashboard data summary) is sent to Anthropic's API.
