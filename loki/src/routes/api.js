import { Router } from 'express';
import { googleConfigured } from '../config.js';
import * as google from '../google.js';
import * as ai from '../ai.js';
import { buildWatching, buildBriefing, ccnaDaysLeft } from '../nudges.js';
import { getDb, persist, newId } from '../store.js';

const DAY = 86_400_000;
export const api = Router();

api.get('/api/health', (_req, res) =>
  res.json({ ok: true, service: 'loki', time: new Date().toISOString() }),
);

const withAge = (item) => ({ ...item, ageDays: Math.floor((Date.now() - item.receivedAt) / DAY) });

// A milestone counts as a check mark once it is underway or done.
const isCleared = (m) => m.status === 'cleared' || m.status === 'in progress';

async function liveSchedule(db) {
  let schedule = { source: 'local', syncedAt: null, items: db.scheduleFallback };
  let flagged = { source: 'local', syncedAt: null, items: db.flaggedFallback.map(withAge) };
  if (google.connected()) {
    try {
      const s = await google.scheduleSync();
      schedule = { source: 'google', syncedAt: s.at, items: s.data };
    } catch (err) {
      schedule.error = err.message;
    }
    try {
      const f = await google.flaggedSync();
      flagged = { source: 'google', syncedAt: f.at, items: f.data.map(withAge) };
    } catch (err) {
      flagged.error = err.message;
    }
  }
  return { schedule, flagged };
}

// One payload drives every tab; the frontend polls this once a minute.
api.get('/api/dashboard', async (_req, res) => {
  const db = getDb();
  const { schedule, flagged } = await liveSchedule(db);

  const cleared = db.plan.milestones.filter(isCleared).length;
  const total = db.plan.milestones.length;

  res.json({
    settings: db.settings,
    google: {
      configured: googleConfigured(),
      connected: google.connected(),
      email: db.google?.email || null,
      connectedAt: db.google?.connectedAt || null,
      lastError: db.google?.lastError || null,
      canDraft: google.connected() && google.hasScope('gmail.compose'),
    },
    ai: await ai.aiStatus(),
    focusBlock: db.focusBlock,
    nudgeSnoozed: (db.nudgeSnoozedUntil || 0) > Date.now(),
    watching: buildWatching(db, schedule.items),
    plan: { ...db.plan, cleared, total, percent: Math.round((cleared / total) * 100) },
    ccna: { ...db.ccna, daysLeft: ccnaDaysLeft(db) },
    fund: db.fund,
    schedule,
    workout: db.workout,
    flagged,
    pipeline: db.pipeline,
    tasks: db.tasks,
    sources: db.sources,
  });
});

api.get('/api/briefing', async (_req, res) => {
  const db = getDb();
  const { schedule } = await liveSchedule(db);
  res.json(buildBriefing(db, schedule.items));
});

/* ---------------------------------------------------------------- tasks */

api.post('/api/tasks', (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  const db = getDb();
  const task = { id: newId(), text, done: false, createdAt: Date.now() };
  db.tasks.push(task);
  persist();
  res.status(201).json(task);
});

api.patch('/api/tasks/:id', (req, res) => {
  const db = getDb();
  const task = db.tasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  if (typeof req.body?.done === 'boolean') task.done = req.body.done;
  if (typeof req.body?.text === 'string' && req.body.text.trim()) task.text = req.body.text.trim();
  persist();
  res.json(task);
});

api.delete('/api/tasks/:id', (req, res) => {
  const db = getDb();
  const index = db.tasks.findIndex((t) => t.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'task not found' });
  const [removed] = db.tasks.splice(index, 1);
  persist();
  res.json(removed);
});

/* ------------------------------------------- manual trackers (numbers) */

function patchNumbers(target, body, keys) {
  for (const key of keys) {
    if (body?.[key] === undefined) continue;
    const value = Number(body[key]);
    if (Number.isFinite(value) && value >= 0) target[key] = value;
  }
}

api.patch('/api/pipeline', (req, res) => {
  const db = getDb();
  patchNumbers(db.pipeline, req.body, ['prospects', 'contacted', 'replied', 'booked']);
  db.pipeline.updatedAt = Date.now();
  persist();
  res.json(db.pipeline);
});

api.patch('/api/fund', (req, res) => {
  const db = getDb();
  patchNumbers(db.fund, req.body, ['currentEur', 'goalEur']);
  if (typeof req.body?.reauthNeeded === 'boolean') db.fund.reauthNeeded = req.body.reauthNeeded;
  db.fund.updatedAt = Date.now();
  persist();
  res.json(db.fund);
});

api.patch('/api/ccna', (req, res) => {
  const db = getDb();
  patchNumbers(db.ccna, req.body, ['lastMockPct']);
  if (typeof req.body?.examDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.examDate)) {
    db.ccna.examDate = req.body.examDate;
  }
  db.ccna.syncedAt = Date.now();
  persist();
  res.json({ ...db.ccna, daysLeft: ccnaDaysLeft(db) });
});

api.patch('/api/plan/milestones/:id', (req, res) => {
  const db = getDb();
  const milestone = db.plan.milestones.find((m) => m.id === req.params.id);
  if (!milestone) return res.status(404).json({ error: 'milestone not found' });
  const allowed = ['cleared', 'in progress', 'building', 'upcoming', 'pending', 'awaiting reply'];
  if (typeof req.body?.status === 'string' && allowed.includes(req.body.status)) {
    milestone.status = req.body.status;
  }
  if (typeof req.body?.sub === 'string') milestone.sub = req.body.sub;
  persist();
  res.json(milestone);
});

/* -------------------------------------------------------- AI endpoints */

// Sanitize a client-sent chat history into API-safe messages.
function cleanHistory(raw, maxTurns = 12) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-maxTurns)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
}

// Conversational LOKI — powers the Voice tab and Briefing follow-ups.
api.post('/api/chat', async (req, res) => {
  const db = getDb();
  const messages = cleanHistory(req.body?.messages);
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'messages must end with a user turn' });
  }
  const { schedule } = await liveSchedule(db);
  const mode = req.body?.mode === 'briefing' ? 'briefing' : 'voice';
  try {
    const result = await ai.chat({
      system: ai.lokiSystemPrompt(db, schedule.items, mode),
      messages,
    });
    res.json(result);
  } catch (err) {
    const { status, body } = ai.chatErrorResponse(err);
    res.status(status).json(body);
  }
});

// Structured-output schemas — both providers constrain generation to these,
// so the response parses instead of needing to be dug out of prose.
const FLASHCARD_SCHEMA = {
  type: 'object',
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: { q: { type: 'string' }, a: { type: 'string' } },
        required: ['q', 'a'],
        additionalProperties: false,
      },
    },
  },
  required: ['cards'],
  additionalProperties: false,
};

const DRAFT_SCHEMA = {
  type: 'object',
  properties: { subject: { type: 'string' }, body: { type: 'string' } },
  required: ['subject', 'body'],
  additionalProperties: false,
};

// Accept either {cards:[...]} or a bare array, whichever the model produced.
function readCards(reply) {
  const parsed = ai.extractJson(reply);
  const list = Array.isArray(parsed) ? parsed : parsed?.cards;
  if (!Array.isArray(list)) return null;
  const cards = list
    .filter((c) => c && typeof c.q === 'string' && typeof c.a === 'string' && c.q.trim() && c.a.trim())
    .slice(0, 8)
    .map((c) => ({ q: c.q.trim(), a: c.a.trim() }));
  return cards.length ? cards : null;
}

// Generate real CCNA flashcards for the Voice tab.
api.post('/api/flashcards', async (req, res) => {
  const db = getDb();
  const topic = String(req.body?.topic || '').trim()
    || (db.tasks.find((t) => !t.done && /ospf|ccna/i.test(t.text))?.text.match(/ospf/i) ? 'OSPF' : 'CCNA exam topics');
  try {
    const result = await ai.chat({
      system: 'You generate CCNA study flashcards. Produce exactly 6 cards. Questions must be exam-realistic and specific; answers 1-2 sentences. Return JSON matching the schema: {"cards": [{"q": "...", "a": "..."}]}.',
      messages: [{ role: 'user', content: `Topic: ${topic}. Last mock score: ${db.ccna.lastMockPct}%. Focus on what commonly trips people up.` }],
      schema: FLASHCARD_SCHEMA,
    });
    const cards = readCards(result.reply);
    if (!cards) return res.json({ topic, cards: null, raw: result.reply, provider: result.provider });
    res.json({ topic, cards, provider: result.provider });
  } catch (err) {
    const { status, body } = ai.chatErrorResponse(err);
    res.status(status).json(body);
  }
});

// Write the follow-up with AI and put a real draft in Gmail.
api.post('/api/briefing/draft', async (_req, res) => {
  const db = getDb();
  const now = Date.now();
  const quiet = db.followUps
    .map((f) => ({ ...f, days: Math.floor((now - f.sentAt) / DAY) }))
    .find((f) => f.days >= (f.nudgeAfterDays ?? 3));
  if (!quiet) return res.status(400).json({ error: 'no_follow_up', message: 'Nothing is waiting on a follow-up right now.' });

  let draft;
  try {
    const result = await ai.chat({
      system: `You write short follow-up emails for ${db.settings.name}, a student in Wevelgem, Belgium. Return JSON matching the schema: {"subject": "...", "body": "..."}. Three sentences max, polite but confident, zero groveling. Use the language the original message was most likely in (Dutch for Belgian companies unless context says otherwise). Sign with just the first name.`,
      messages: [{ role: 'user', content: `Write the follow-up for: "${quiet.label}" — sent ${quiet.days} days ago with no reply. Context:\n${ai.contextSummary(db)}` }],
      schema: DRAFT_SCHEMA,
    });
    const parsed = ai.extractJson(result.reply);
    draft = parsed?.subject && parsed?.body
      ? { subject: String(parsed.subject), body: String(parsed.body) }
      : { subject: `Opvolging: ${quiet.label}`, body: result.reply };
  } catch (err) {
    const { status, body } = ai.chatErrorResponse(err);
    return res.status(status).json(body);
  }

  // Try to place it in Gmail; fall back to returning the text.
  let inGmail = false;
  let note = null;
  if (google.connected()) {
    try {
      await google.createDraft(draft.subject, draft.body);
      inGmail = true;
    } catch (err) {
      note = err.code === 'missing_scope' ? err.message : `Draft written, but Gmail refused it (${err.message}).`;
    }
  } else {
    note = 'Google is not linked, so the draft could not be placed in Gmail — text is below.';
  }

  db.activity.unshift({
    id: newId(),
    type: 'briefing',
    text: `Drafted a follow-up for the ${quiet.label}${inGmail ? ' — sitting in Gmail drafts.' : '.'}`,
    at: Date.now(),
  });
  db.activity = db.activity.slice(0, 50);
  persist();

  res.json({
    inGmail,
    note,
    subject: draft.subject,
    body: draft.body,
    reply: inGmail
      ? `Done — no groveling. "${draft.subject}" is sitting in your Gmail drafts; add the recipient and hit send. Anything else?`
      : `Draft's written — subject "${draft.subject}". ${note}`,
  });
});

/* --------------------------------------------------- focus blocks + snooze */

api.post('/api/block/start', (req, res) => {
  const db = getDb();
  if (db.focusBlock) return res.status(409).json({ error: 'block_active', focusBlock: db.focusBlock });
  const minutes = Math.min(240, Math.max(5, Number(req.body?.minutes) || 40));
  const task = db.tasks.find((t) => !t.done && /ospf|ccna/i.test(t.text)) || db.tasks.find((t) => !t.done);
  const label = String(req.body?.label || '').trim() || (task ? task.text : 'Focus block');
  const now = Date.now();
  db.focusBlock = {
    id: newId(),
    label,
    taskId: task?.id || null,
    startedAt: now,
    minutes,
    endsAt: now + minutes * 60_000,
  };
  persist();
  res.status(201).json(db.focusBlock);
});

api.post('/api/block/stop', (req, res) => {
  const db = getDb();
  const block = db.focusBlock;
  if (!block) return res.status(404).json({ error: 'no_block' });
  const complete = req.body?.complete === true;
  if (complete) {
    const task = db.tasks.find((t) => t.id === block.taskId);
    if (task) task.done = true;
    const ranMin = Math.max(1, Math.round((Date.now() - block.startedAt) / 60_000));
    db.activity.unshift({ id: newId(), type: 'focus', text: `Finished a ${ranMin}-min block: ${block.label}.`, at: Date.now() });
    db.activity = db.activity.slice(0, 50);
  }
  db.focusBlock = null;
  persist();
  res.json({ ok: true, completed: complete });
});

api.post('/api/nudges/snooze', (req, res) => {
  const db = getDb();
  const hours = Math.min(24, Math.max(1, Number(req.body?.hours) || 4));
  db.nudgeSnoozedUntil = Date.now() + hours * 3_600_000;
  persist();
  res.json({ snoozedUntil: db.nudgeSnoozedUntil });
});

/* ------------------------------------------------------------- activity */

api.post('/api/activity', (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  const db = getDb();
  const entry = {
    id: newId(),
    type: String(req.body?.type || 'event').slice(0, 20),
    text,
    at: Date.now(),
  };
  db.activity.unshift(entry);
  db.activity = db.activity.slice(0, 50);
  persist();
  res.status(201).json(entry);
});
