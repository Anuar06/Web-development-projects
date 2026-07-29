// LOKI's brain: one chat() interface over two providers.
//   - Anthropic (Claude) via the official SDK — needs ANTHROPIC_API_KEY
//   - Ollama (free, local) via its REST API — needs `ollama serve` running
// Provider is picked per AI_PROVIDER, or auto-detected.
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { ccnaDaysLeft } from './nudges.js';

const DAY = 86_400_000;

let anthropicClient = null;
function anthropic() {
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey: config.ai.anthropicKey });
  return anthropicClient;
}

/* ---------------------------------------------------- provider selection */

// Ollama reachability + installed models, cached for a minute.
let ollamaCache = { at: 0, ok: false, models: [] };

async function ollamaInfo() {
  if (Date.now() - ollamaCache.at < 60_000) return ollamaCache;
  try {
    const res = await fetch(`${config.ai.ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(1500),
    });
    const data = res.ok ? await res.json() : { models: [] };
    ollamaCache = { at: Date.now(), ok: res.ok, models: (data.models || []).map((m) => m.name) };
  } catch {
    ollamaCache = { at: Date.now(), ok: false, models: [] };
  }
  return ollamaCache;
}

function ollamaModel() {
  return config.ai.ollamaModel || ollamaCache.models[0] || null;
}

async function resolveProvider() {
  const pref = config.ai.provider;
  if (pref === 'anthropic' || pref === 'claude') return config.ai.anthropicKey ? 'anthropic' : null;
  if (pref === 'ollama') return (await ollamaInfo()).ok ? 'ollama' : null;
  if (pref === 'off' || pref === 'none') return null;
  // auto
  if (config.ai.anthropicKey) return 'anthropic';
  if ((await ollamaInfo()).ok) return 'ollama';
  return null;
}

export async function aiStatus() {
  const provider = await resolveProvider();
  return {
    provider,
    model: provider === 'anthropic' ? config.ai.anthropicModel : provider === 'ollama' ? ollamaModel() : null,
    ready: Boolean(provider && (provider !== 'ollama' || ollamaModel())),
  };
}

/* --------------------------------------------------------------- chat() */

export async function chat({ system, messages, maxTokens = 16000 }) {
  const provider = await resolveProvider();
  if (!provider) {
    const err = new Error('No AI provider configured');
    err.code = 'ai_unconfigured';
    throw err;
  }

  if (provider === 'anthropic') {
    // Server-side fallback: if Claude's safety classifiers decline a request,
    // the API re-runs it on Anthropic's recommended fallback model.
    const response = await anthropic().beta.messages.create({
      model: config.ai.anthropicModel,
      max_tokens: maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      messages,
    });
    if (response.stop_reason === 'refusal') {
      return { provider, model: response.model, reply: "That one I won't touch. Ask me something else." };
    }
    const reply = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    return { provider, model: response.model, reply };
  }

  // Ollama
  const model = ollamaModel();
  if (!model) {
    const err = new Error('Ollama is running but has no models — run `ollama pull <model>`');
    err.code = 'ai_unconfigured';
    throw err;
  }
  const res = await fetch(`${config.ai.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text().catch(() => '')}`.trim());
  const data = await res.json();
  return { provider, model, reply: (data.message?.content || '').trim() };
}

// Translate provider errors into an HTTP status + user-facing message.
export function chatErrorResponse(err) {
  if (err.code === 'ai_unconfigured') {
    return {
      status: 501,
      body: {
        error: 'ai_unconfigured',
        message: err.message === 'No AI provider configured'
          ? 'No AI model is linked. Add ANTHROPIC_API_KEY to loki/.env, or start Ollama — see the Connections tab.'
          : err.message,
      },
    };
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return { status: 502, body: { error: 'ai_auth', message: 'Anthropic rejected the API key — check ANTHROPIC_API_KEY in loki/.env.' } };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { status: 429, body: { error: 'ai_rate_limited', message: 'Claude is rate-limited right now — try again in a minute.' } };
  }
  if (err instanceof Anthropic.APIError) {
    return { status: 502, body: { error: 'ai_error', message: `Claude API error (${err.status}) — try again.` } };
  }
  return { status: 502, body: { error: 'ai_error', message: `AI backend failed: ${err.message}` } };
}

/* ----------------------------------------------- persona + live context */

export function lokiSystemPrompt(db, schedule, mode = 'voice') {
  const name = db.settings.name;
  return [
    `You are LOKI, ${name}'s personal system — the AI behind his dashboard. You can see his live data below and you exist to keep him on plan: a kot in Kortrijk by February 2027, funded by CCNA certification, a student job at Ago, and his web design pipeline.`,
    `Style: direct, terse, a little dry. 2–4 sentences for normal replies — longer only when producing actual content (flashcards, lab plans, drafts, briefings). No pep talk, no filler, no bullet-point spam. Push gently but honestly; call out slipping streaks or stale follow-ups when relevant.`,
    `Never invent data. If something isn't in the context below, say you don't track it yet.`,
    mode === 'briefing'
      ? `You are in the Briefing tab: the user is reacting to today's briefing.`
      : `You are in the Voice tab: quick spoken-style exchanges.`,
    ``,
    `LIVE DATA (${new Date().toLocaleString('en-GB')}):`,
    contextSummary(db, schedule),
  ].join('\n');
}

export function contextSummary(db, schedule = []) {
  const now = Date.now();
  const lines = [];

  const days = ccnaDaysLeft(db);
  lines.push(`CCNA: exam ${db.ccna.examDate} (${days} days away), last mock ${db.ccna.lastMockPct}%`);
  lines.push(`Kot fund: €${db.fund.currentEur} of €${db.fund.goalEur}${db.fund.reauthNeeded ? ' (balance may be stale — bank reauth pending)' : ''}`);

  const milestones = db.plan.milestones.map((m) => `${m.label} [${m.status}]`).join('; ');
  lines.push(`Plan "${db.plan.title}" (${db.plan.targetLong}): ${milestones}`);

  const p = db.pipeline;
  lines.push(`Web design pipeline (${p.area}): ${p.prospects} prospects, ${p.contacted} contacted, ${p.replied} replied, ${p.booked} booked`);

  lines.push(`Today's schedule: ${schedule.length ? schedule.map((s) => `${s.time} ${s.label}`).join('; ') : 'nothing on the calendar'}`);

  const open = db.tasks.filter((t) => !t.done).map((t) => t.text);
  const done = db.tasks.filter((t) => t.done).map((t) => t.text);
  lines.push(`Open tasks: ${open.join('; ') || 'none'}`);
  if (done.length) lines.push(`Done today: ${done.join('; ')}`);

  for (const f of db.followUps) {
    lines.push(`Waiting on reply: ${f.label}, sent ${Math.floor((now - f.sentAt) / DAY)} days ago`);
  }

  const flagged = db.flaggedFallback; // context only; live flagged is in schedule callers
  if (flagged?.length) lines.push(`Flagged mail: ${flagged.map((m) => `${m.from} — ${m.subject}`).join('; ')}`);

  lines.push(`Workout: ${db.workout.day} — ${db.workout.program}, ${db.workout.streakDays}-day streak (${db.workout.focus})`);

  if (db.focusBlock) {
    const left = Math.ceil((db.focusBlock.endsAt - now) / 60_000);
    lines.push(`Focus block "${db.focusBlock.label}": ${left > 0 ? `${left} min left` : 'time is up'}`);
  }

  return lines.join('\n');
}

// Ask the model for strict JSON; tolerate prose around it.
export function extractJson(text) {
  const direct = text.trim();
  for (const candidate of [direct, direct.replace(/^```(?:json)?\s*|\s*```$/g, '')]) {
    try { return JSON.parse(candidate); } catch { /* keep looking */ }
  }
  const match = direct.match(/[[{][\s\S]*[\]}]/);
  if (match) {
    try { return JSON.parse(match[0]); } catch { /* fall through */ }
  }
  return null;
}
