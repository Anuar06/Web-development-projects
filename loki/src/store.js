import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;

export const newId = () => crypto.randomBytes(5).toString('hex');

// First-run seed. Timestamps are relative to the moment the data file is
// created, so the dashboard shows sensible ages ("6d", "synced 2h ago")
// until real data replaces it. Everything here is editable through the API.
function seed(now = Date.now()) {
  return {
    settings: { name: 'Anuar', location: 'Wevelgem', version: '0.4' },

    plan: {
      label: '19-month plan',
      title: 'Kot in Kortrijk',
      target: 'Feb 2027',
      targetLong: 'by February 2027',
      // status drives the icon/label on the Independence Plan page;
      // 'cleared' and 'in progress' count as a check mark.
      milestones: [
        { id: newId(), label: 'Savings banked', sub: '€{fund} of €{goal} kot deposit target', status: 'in progress' },
        { id: newId(), label: 'Student job stable', sub: 'Interim through Ago, full-time in August', status: 'cleared' },
        { id: newId(), label: 'Web design MRR at target', sub: '40 Kortrijk prospects, 1 booked so far', status: 'building' },
        { id: newId(), label: 'CCNA passed', sub: 'Exam scheduled, {ccnaDays} days out', status: 'upcoming' },
        { id: newId(), label: 'Clean January exam results', sub: 'Semester 2, VIVES', status: 'pending' },
        { id: newId(), label: 'Stage placement near Kortrijk', sub: 'Ago HQ, Thu/Fri, starts October', status: 'awaiting reply' },
      ],
      certRoadmap: [
        { name: 'CCNA', when: 'Aug 2026' },
        { name: 'DevNet', when: 'Mar 2027' },
        { name: 'Security+', when: 'Nov 2027' },
        { name: 'AWS SAA', when: '2028' },
        { name: 'CCNP', when: '2029-2030' },
      ],
      drivingTrack: [
        { name: 'Theory exam', when: 'Sep 2026' },
        { name: 'Rijschool, 30h', when: 'Oct-Nov 2026' },
        { name: 'Practical exam', when: 'Nov-Dec 2026' },
      ],
    },

    ccna: {
      examDate: new Date(now + 12 * DAY).toISOString().slice(0, 10),
      lastMockPct: 82,
      syncedAt: now - 2 * HOUR,
    },

    fund: { currentEur: 2150, goalEur: 4200, reauthNeeded: true, updatedAt: now - 2 * DAY },

    workout: { day: 'Push Day A', program: 'Symmetry & Steel', streakDays: 14, focus: 'lean bulk' },

    // Shown while Google is not connected; replaced by Calendar/Gmail once linked.
    scheduleFallback: [
      { time: '09:00', label: 'Ago Jobs & HR — recruiter shift' },
      { time: '18:00', label: 'Push Day A — Symmetry & Steel' },
      { time: '20:30', label: 'CCNA: OSPF review + practice labs' },
    ],
    flaggedFallback: [
      { from: 'Ago HR', subject: 'stage desk', receivedAt: now - 6 * DAY },
      { from: 'Bert · Eurodecants', subject: 'sample pricing', receivedAt: now - 1 * DAY },
      { from: 'VIVES', subject: 'Stuvo appt.', receivedAt: now - 2 * DAY },
    ],

    pipeline: {
      name: 'Web Design Pipeline',
      area: 'Kortrijk',
      prospects: 40,
      contacted: 14,
      replied: 5,
      booked: 1,
      updatedAt: now - 8 * MIN,
    },

    followUps: [
      { id: newId(), label: 'Ago stage motivation letter', sentAt: now - 6 * DAY, nudgeAfterDays: 3 },
    ],

    activity: [
      { id: newId(), type: 'pipeline', text: 'Kevin logged 2 new callbacks from the Garage Delabie script.', at: now - 50 * MIN },
    ],

    tasks: [
      { id: newId(), text: 'Review OSPF notes (40 min)', done: false, createdAt: now },
      { id: newId(), text: 'Follow up: Ago stage motivation letter', done: false, createdAt: now },
      { id: newId(), text: 'Email Garage Delabie re: quote', done: false, createdAt: now },
      { id: newId(), text: 'Rijschool: book theory exam slot', done: false, createdAt: now },
    ],

    // Non-Google sources on the Connections page. Google Calendar/Gmail and
    // the AI model are real integrations; the bank fund is managed in-app;
    // VIVES and Notion are honestly marked as planned.
    sources: [
      { key: 'bank', name: 'Bank / budgeting app', desc: 'Kot deposit fund — managed in-app', kind: 'manual' },
      { key: 'vives', name: 'VIVES student portal', desc: 'Grades, CCNA progress, semester results', kind: 'planned' },
      { key: 'notion', name: 'Notion', desc: 'Web design pipeline, daily task list', kind: 'planned' },
    ],

    // Active study block: { id, label, taskId, startedAt, minutes, endsAt }
    focusBlock: null,
    // Timestamp until which the CCNA nudge stays quiet
    nudgeSnoozedUntil: 0,

    // Set by the OAuth flow: { tokens, email, name, connectedAt, lastError }
    google: null,
  };
}

// Bring a db.json written by an older LOKI version up to the current shape.
function migrate(db) {
  let changed = false;
  const set = (key, value) => {
    if (db[key] === undefined) { db[key] = value; changed = true; }
  };
  set('focusBlock', null);
  set('nudgeSnoozedUntil', 0);
  if (db.settings.version !== '0.4') { db.settings.version = '0.4'; changed = true; }
  for (const source of db.sources || []) {
    if (source.kind === 'stub') {
      source.kind = source.key === 'bank' ? 'manual' : 'planned';
      changed = true;
    }
  }
  return changed;
}

let db = null;

export function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });
  if (fs.existsSync(config.dataFile)) {
    db = JSON.parse(fs.readFileSync(config.dataFile, 'utf8'));
    if (migrate(db)) persist();
  } else {
    db = seed();
    persist();
  }
  return db;
}

export function persist() {
  fs.writeFileSync(config.dataFile, JSON.stringify(db, null, 2));
}
