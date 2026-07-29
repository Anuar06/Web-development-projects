// "LOKI IS WATCHING" — small rules engine that turns stored data into the
// nudge feed at the top of the dashboard.
const DAY = 86_400_000;
const HOUR = 3_600_000;

export function ccnaDaysLeft(db) {
  if (!db.ccna?.examDate) return null;
  const exam = new Date(`${db.ccna.examDate}T00:00:00`);
  if (Number.isNaN(exam.getTime())) return null;
  return Math.max(0, Math.ceil((exam.getTime() - Date.now()) / DAY));
}

export function buildWatching(db, scheduleItems = []) {
  const items = [];
  const now = Date.now();
  const snoozed = (db.nudgeSnoozedUntil || 0) > now;

  // 0. A running focus block is its own headline (and silences the CCNA nudge).
  if (db.focusBlock) {
    const left = Math.ceil((db.focusBlock.endsAt - now) / 60_000);
    items.push({
      tag: 'focus',
      text: left > 0
        ? `${db.focusBlock.label} — ${left} min left. Locked in.`
        : `${db.focusBlock.label} — time's up. Finish it from the widget.`,
    });
  }

  // 1. CCNA pressure: exam is close and today's study block is still open.
  const daysLeft = ccnaDaysLeft(db);
  const openStudyTask = db.tasks.find((t) => !t.done && /ccna|ospf/i.test(t.text));
  if (daysLeft !== null && openStudyTask && !db.focusBlock && !snoozed) {
    const block = scheduleItems.find((s) => /ccna|ospf/i.test(s.label));
    const what = block
      ? `today's ${block.label.replace(/^ccna:\s*/i, '').split('+')[0].trim()} block`
      : `“${openStudyTask.text}”`;
    items.push({ tag: 'nudge', text: `CCNA in ${daysLeft} days — ${what} hasn't started yet.` });
  }

  // 2. Anything logged in the activity feed in the last 48h.
  for (const entry of [...db.activity].sort((a, b) => b.at - a.at)) {
    if (now - entry.at < 48 * HOUR) items.push({ tag: entry.type || 'event', text: entry.text });
  }

  // 3. Follow-ups that have gone quiet.
  for (const f of db.followUps) {
    const days = Math.floor((now - f.sentAt) / DAY);
    if (days >= (f.nudgeAfterDays ?? 3)) {
      items.push({ tag: 'follow-up', text: `No reply on the ${f.label} in ${days} days — worth a nudge?` });
    }
  }

  return items.slice(0, 5);
}

// Briefing tab: one spoken-style paragraph composed from live data.
export function buildBriefing(db, scheduleItems = []) {
  const now = new Date();
  const hour = now.getHours();
  const bits = [hour < 12 ? 'Morning.' : hour < 18 ? 'Afternoon.' : 'Evening.'];

  const daysLeft = ccnaDaysLeft(db);
  if (daysLeft !== null) {
    const mock = db.ccna.lastMockPct;
    const verdict = mock >= 80 ? "don't get comfortable" : 'tighten it up';
    bits.push(`${daysLeft} days to CCNA — last mock ${mock}%, ${verdict}.`);
  }

  const firstBlock = scheduleItems.find((s) => s.time !== 'all-day');
  if (firstBlock) bits.push(`First block: ${firstBlock.time}, ${firstBlock.label}.`);

  const fresh = [...db.activity].sort((a, b) => b.at - a.at).find((a) => Date.now() - a.at < 24 * HOUR);
  if (fresh) bits.push(`${fresh.text} Worth a look.`);

  const quiet = db.followUps
    .map((f) => ({ ...f, days: Math.floor((Date.now() - f.sentAt) / DAY) }))
    .find((f) => f.days >= (f.nudgeAfterDays ?? 3));
  if (quiet) bits.push(`And the ${quiet.label}'s gone quiet for ${quiet.days} days — I'd chase it today, gently.`);

  return {
    label: hour < 12 ? 'MORNING BRIEFING' : hour < 18 ? 'MIDDAY BRIEFING' : 'EVENING BRIEFING',
    time: now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    text: bits.join(' '),
    followUp: quiet ? { id: quiet.id, label: quiet.label, days: quiet.days } : null,
    actions: [
      ...(quiet ? [{ id: 'draft', label: 'Draft the follow-up' }] : []),
      { id: 'callbacks', label: 'Show callbacks' },
      { id: 'dismiss', label: 'Not now' },
    ],
  };
}
