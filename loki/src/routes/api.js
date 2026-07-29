import { Router } from 'express';
import { googleConfigured } from '../config.js';
import * as google from '../google.js';
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
    },
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
