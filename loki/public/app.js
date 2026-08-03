/* LOKI v0.4 — dashboard client. One payload (/api/dashboard) drives every tab;
   the Voice and Briefing tabs talk to the AI through /api/chat. */

const $ = (sel) => document.querySelector(sel);

let D = null; // last /api/dashboard payload
let briefingLoaded = false;

/* ------------------------------------------------------------- helpers */

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, data };
}

function relTime(ts) {
  if (!ts) return null;
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const clock = (d = new Date()) =>
  d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

function toast(msg, ms = 4200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, ms);
}

// milestone subs may contain live placeholders: {fund} {goal} {ccnaDays}
function fillTemplate(text) {
  if (!D) return text;
  return text
    .replaceAll('{fund}', D.fund.currentEur.toLocaleString('en-US'))
    .replaceAll('{goal}', D.fund.goalEur.toLocaleString('en-US'))
    .replaceAll('{ccnaDays}', D.ccna.daysLeft ?? '?');
}

const parseHM = (t) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

function upcomingSchedule() {
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  return (D?.schedule.items || [])
    .map((s) => ({ ...s, min: parseHM(s.time) }))
    .filter((s) => s.min !== null && s.min > nowMin);
}

/* ---------------------------------------------------------------- tabs */

const TABS = ['dashboard', 'widget', 'voice', 'plan', 'briefing', 'connections'];

function gotoTab(name, { pushHash = true } = {}) {
  if (!TABS.includes(name)) name = 'dashboard';
  for (const t of TABS) $(`#tab-${t}`).hidden = t !== name;
  document.querySelectorAll('#nav button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  if (name === 'briefing' && !briefingLoaded) loadBriefing();
  if (name === 'voice') initVoice();
  if (pushHash && location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
}

// Keep the view in sync with browser back/forward and manual hash edits.
window.addEventListener('hashchange', () => {
  gotoTab(location.hash.replace('#', '') || 'dashboard', { pushHash: false });
});

$('#nav').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (btn) gotoTab(btn.dataset.tab);
});

document.addEventListener('click', (e) => {
  const jump = e.target.closest('[data-goto]');
  if (jump) gotoTab(jump.dataset.goto);
});

/* ------------------------------------------------------------ dashboard */

function renderHero() {
  $('#brand-sub').textContent = `v${D.settings.version} · personal system`;
  const hour = new Date().getHours();
  const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  $('#greeting').textContent = `Good ${part}, ${D.settings.name}`;
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  $('#dateline').textContent = `${date} · ${D.settings.location}`;

  const chip = $('#status-chip');
  if (!D.google.configured) {
    chip.className = 'chip warn';
    chip.textContent = 'Google not configured';
  } else if (!D.google.connected) {
    chip.className = 'chip warn';
    chip.textContent = 'Google not linked';
  } else if (!D.ai.ready) {
    chip.className = 'chip warn';
    chip.textContent = 'AI not linked';
  } else {
    chip.className = 'chip ok';
    chip.textContent = 'All systems nominal';
  }
}

function renderWatching() {
  const wrap = $('#watching');
  wrap.replaceChildren();
  if (!D.watching.length) {
    const row = h('div', 'watch-row');
    row.append(h('span', 'dot off'), h('span', null, 'Nothing needs you right now.'));
    wrap.append(row);
    return;
  }
  for (const item of D.watching) {
    const row = h('div', 'watch-row');
    const dotCls = item.tag === 'pipeline' || item.tag === 'focus' ? 'dot' : 'dot warn';
    row.append(h('span', dotCls), h('span', null, item.text), h('span', 'tag', item.tag));
    wrap.append(row);
  }
}

function renderCards() {
  // independence plan
  $('#plan-pct').textContent = `${D.plan.percent}%`;
  $('#plan-title').textContent = `${D.plan.title} — ${D.plan.target}`;
  $('#plan-progress').textContent = `${D.plan.cleared} of ${D.plan.total} milestones cleared`;

  // ccna
  $('#ccna-days').textContent = D.ccna.daysLeft ?? '—';
  $('#ccna-sub').textContent = `days · last mock ${D.ccna.lastMockPct}%`;
  $('#ccna-sync').textContent = `synced ${relTime(D.ccna.syncedAt) || 'never'}`;

  // fund
  $('#fund-cur').textContent = `€${D.fund.currentEur}`;
  $('#fund-goal').textContent = `/ €${D.fund.goalEur}`;
  $('#fund-bar').style.width = `${Math.min(100, (D.fund.currentEur / D.fund.goalEur) * 100)}%`;
  const flag = $('#fund-flag');
  flag.className = D.fund.reauthNeeded ? 'sync warn' : 'sync';
  flag.textContent = D.fund.reauthNeeded ? 'needs update' : `updated ${relTime(D.fund.updatedAt)}`;

  // schedule
  $('#schedule-sync').textContent = D.schedule.source === 'google'
    ? `synced ${relTime(D.schedule.syncedAt)}`
    : 'local · not synced';
  const sList = $('#schedule-list');
  sList.replaceChildren();
  if (!D.schedule.items.length) sList.append(h('p', 'empty', 'Nothing on the calendar today.'));
  for (const item of D.schedule.items) {
    const row = h('div', 'row');
    row.append(h('span', 'time', item.time), h('span', 'ellip', item.label));
    sList.append(row);
  }

  // workout
  $('#workout-label').textContent = D.workout.day.toUpperCase();
  $('#workout-name').textContent = D.workout.program;
  $('#workout-sub').textContent = `${D.workout.streakDays}-day streak · ${D.workout.focus}`;

  // flagged
  $('#flagged-sync').textContent = D.flagged.source === 'google'
    ? `synced ${relTime(D.flagged.syncedAt)}`
    : 'local · not synced';
  const fList = $('#flagged-list');
  fList.replaceChildren();
  if (!D.flagged.items.length) fList.append(h('p', 'empty', 'No starred mail.'));
  for (const msg of D.flagged.items.slice(0, 5)) {
    const row = h('div', 'row spread');
    row.append(h('span', 'ellip', `${msg.from} — ${msg.subject}`), h('span', 'right', `${msg.ageDays}d`));
    fList.append(row);
  }

  // pipeline
  $('#pipeline-label').textContent = `${D.pipeline.name} · ${D.pipeline.area}`.toUpperCase();
  $('#pipeline-sync').textContent = `${D.pipeline.prospects} prospects · synced ${relTime(D.pipeline.updatedAt)}`;
  const stats = $('#pipeline-stats');
  stats.replaceChildren();
  for (const [key, label] of [
    ['prospects', 'Prospects'], ['contacted', 'Contacted'], ['replied', 'Replied'], ['booked', 'Booked'],
  ]) {
    const tile = h('div', 'stat');
    tile.append(h('b', null, String(D.pipeline[key])), h('span', null, label));
    stats.append(tile);
  }

  renderTasks();
}

function renderTasks() {
  const list = $('#task-list');
  list.replaceChildren();
  for (const task of D.tasks) {
    const row = h('div', task.done ? 'task done' : 'task');
    row.append(h('span', 'box', '✓'), h('span', 'txt', task.text));
    row.addEventListener('click', () => toggleTask(task));
    list.append(row);
  }
}

async function toggleTask(task) {
  task.done = !task.done;
  renderTasks();
  const { ok } = await postJsonPatch(`/api/tasks/${task.id}`, { done: task.done });
  if (!ok) {
    task.done = !task.done;
    renderTasks();
    toast('Could not save — is the LOKI server running?');
  }
}

async function postJsonPatch(url, body) {
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

$('#task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#task-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await postJson('/api/tasks', { text });
  loadDashboard();
});

/* --------------------------------------------------------------- widget */

function renderWidget() {
  $('#widget-clock').textContent = clock();
  const next = upcomingSchedule()[0];
  if (next) {
    $('#widget-next').textContent = next.label;
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const gap = next.min - nowMin;
    $('#widget-when').textContent = gap <= 90 ? `in ${gap} min` : `at ${next.time}`;
  } else {
    $('#widget-next').textContent = 'Nothing else today';
    $('#widget-when').textContent = 'clear runway';
  }

  const dot = $('#widget-dot');
  const nudgeText = $('#widget-nudge-text');
  const actions = $('#widget-actions');
  actions.replaceChildren();

  if (D.focusBlock) {
    const left = Math.ceil((D.focusBlock.endsAt - Date.now()) / 60_000);
    dot.className = 'dot';
    nudgeText.textContent = left > 0
      ? `${D.focusBlock.label} — ${left} min left.`
      : `${D.focusBlock.label} — time's up. Done?`;
    actions.append(
      widgetBtn('Finish block', () => stopBlock(true), 'btn primary'),
      widgetBtn('Abandon', () => stopBlock(false)),
      widgetBtn('Dashboard', () => gotoTab('dashboard')),
    );
  } else {
    const nudge = D.watching.find((w) => w.tag === 'nudge');
    dot.className = nudge ? 'dot warn' : 'dot off';
    nudgeText.textContent = D.nudgeSnoozed
      ? 'Nudges snoozed. Back later.'
      : (nudge?.text || D.watching[0]?.text || 'All quiet.');
    actions.append(
      widgetBtn('Snooze', snoozeNudges),
      widgetBtn('Start block', startBlock, 'btn primary'),
      widgetBtn('Dashboard', () => gotoTab('dashboard')),
    );
  }
}

function widgetBtn(label, onClick, cls = 'btn') {
  const b = h('button', cls, label);
  b.addEventListener('click', onClick);
  return b;
}

async function startBlock() {
  const { ok, data } = await postJson('/api/block/start', { minutes: 40 });
  if (ok) toast(`Block started: ${data.label} — 40 minutes. Go.`);
  loadDashboard();
}

async function stopBlock(complete) {
  await postJson('/api/block/stop', { complete });
  toast(complete ? 'Block finished — task checked off.' : 'Block abandoned.');
  loadDashboard();
}

async function snoozeNudges() {
  await postJson('/api/nudges/snooze', { hours: 4 });
  toast('Nudges snoozed for 4 hours.');
  loadDashboard();
}

/* ---------------------------------------------------------------- voice */

const voiceHistory = [];
let voiceBusy = false;
let voiceInited = false;
let ttsOn = localStorage.getItem('loki-tts') === '1';

function setVoiceState(state) {
  const labels = { open: 'CHANNEL OPEN', listening: 'LISTENING', thinking: 'THINKING', speaking: 'SPEAKING' };
  $('#voice-state').textContent = labels[state] || 'CHANNEL OPEN';
  $('#wave').classList.toggle('idle', state === 'open' || state === 'thinking');
}

function voiceOpener() {
  const study = D?.tasks.find((t) => !t.done && /ospf|ccna/i.test(t.text));
  const next = upcomingSchedule()[0];
  if (next && study) {
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const gap = next.min - nowMin;
    const where = /push|gym/i.test(next.label) ? 'the gym'
      : /ago|shift/i.test(next.label) ? 'your shift'
      : 'your next block';
    return gap <= 180
      ? `You've got a ${gap}-minute OSPF window before ${where}. Want the flashcard summary, or should I queue the full Packet Tracer lab?`
      : `Clear runway until ${next.time}. Open OSPF work is on the list — flashcards or the full lab?`;
  }
  if (study) return 'No fixed blocks ahead — open OSPF work is still on the list. Flashcards or the full lab?';
  return 'Channel open. Ask me about the schedule, the pipeline, or the plan.';
}

function initVoice() {
  setVoiceState('open');
  $('#voice-tts').textContent = ttsOn ? '🔊' : '🔇';
  if (voiceInited || !D) return;
  voiceInited = true;
  const opener = voiceOpener();
  voiceHistory.push({ role: 'assistant', content: opener });
  appendVoiceMsg('assistant', opener);
}

function appendVoiceMsg(role, text, pending = false) {
  const thread = $('#voice-thread');
  const msg = h('div', `voice-msg${role === 'user' ? ' user' : ''}${pending ? ' pending' : ''}`);
  if (role === 'assistant') msg.append(h('span', 'loki-tag small', 'LOKI'));
  msg.append(document.createTextNode(text));
  thread.append(msg);
  thread.scrollTop = thread.scrollHeight;
  return msg;
}

function speak(text) {
  if (!ttsOn || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.05;
  utterance.onstart = () => setVoiceState('speaking');
  utterance.onend = () => setVoiceState('open');
  speechSynthesis.speak(utterance);
}

async function sendVoiceMessage(text) {
  if (voiceBusy || !text.trim()) return;
  voiceBusy = true;
  setVoiceState('thinking');
  appendVoiceMsg('user', text);
  voiceHistory.push({ role: 'user', content: text });
  const pending = appendVoiceMsg('assistant', '…', true);

  const { ok, data } = await postJson('/api/chat', { mode: 'voice', messages: voiceHistory });
  pending.remove();
  const reply = ok ? data.reply : (data?.message || 'Something broke on the AI side — try again.');
  appendVoiceMsg('assistant', reply);
  voiceHistory.push({ role: 'assistant', content: reply });
  setVoiceState('open');
  if (ok) speak(reply); // flips state to SPEAKING while talking
  voiceBusy = false;
}

$('#voice-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#voice-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  sendVoiceMessage(text);
});

$('#voice-tts').addEventListener('click', () => {
  ttsOn = !ttsOn;
  localStorage.setItem('loki-tts', ttsOn ? '1' : '0');
  $('#voice-tts').textContent = ttsOn ? '🔊' : '🔇';
  if (!ttsOn) speechSynthesis?.cancel();
  toast(ttsOn ? 'LOKI will speak replies aloud.' : 'Spoken replies off.');
});

// Real microphone input via the browser's speech recognition (Chrome/Edge).
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!Recognition) {
  $('#voice-mic').hidden = true;
} else {
  let rec = null;
  $('#voice-mic').addEventListener('click', () => {
    if (rec) { rec.stop(); return; }
    rec = new Recognition();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    $('#voice-mic').classList.add('live');
    setVoiceState('listening');
    rec.onresult = (e) => sendVoiceMessage(e.results[0][0].transcript);
    rec.onerror = () => toast('Mic failed — check browser permission.');
    rec.onend = () => {
      $('#voice-mic').classList.remove('live');
      if (!voiceBusy) setVoiceState('open');
      rec = null;
    };
    rec.start();
  });
}

$('#voice-flash').addEventListener('click', async () => {
  if (voiceBusy) return;
  voiceBusy = true;
  setVoiceState('thinking');
  appendVoiceMsg('user', 'Flashcard summary.');
  const pending = appendVoiceMsg('assistant', 'Building flashcards…', true);
  const { ok, data } = await postJson('/api/flashcards', {});
  pending.remove();
  if (!ok) {
    appendVoiceMsg('assistant', data?.message || 'Flashcards failed — try again.');
  } else if (data.cards) {
    renderFlashcards(data.topic, data.cards);
    voiceHistory.push(
      { role: 'user', content: 'Give me a flashcard summary.' },
      { role: 'assistant', content: `Served ${data.cards.length} flashcards on ${data.topic}.` },
    );
  } else {
    appendVoiceMsg('assistant', data.raw || 'Got nothing usable back — try again.');
  }
  setVoiceState('open');
  voiceBusy = false;
});

function renderFlashcards(topic, cards) {
  const thread = $('#voice-thread');
  const msg = h('div', 'voice-msg');
  msg.append(h('span', 'loki-tag small', 'LOKI'));
  msg.append(document.createTextNode(`${cards.length} on ${topic}. Tap to flip.`));
  const grid = h('div', 'flashcards');
  for (const card of cards) {
    const el = h('div', 'flashcard');
    el.append(h('q', null, card.q), h('span', 'ans', card.a), h('span', 'hint', 'tap to flip'));
    el.addEventListener('click', () => el.classList.toggle('open'));
    grid.append(el);
  }
  msg.append(grid);
  thread.append(msg);
  thread.scrollTop = thread.scrollHeight;
}

$('#voice-lab').addEventListener('click', () =>
  sendVoiceMessage('Queue the full Packet Tracer lab: give me a topology, an addressing table, and step-by-step OSPF tasks I can build in about 40 minutes.'));

$('#voice-remind').addEventListener('click', async () => {
  await postJson('/api/tasks', { text: 'After gym: OSPF full lab' });
  toast('Added to today’s tasks.');
  loadDashboard();
});

/* ------------------------------------------------------------ plan page */

const MILESTONE_ICON = {
  'cleared': 'm-icon done',
  'in progress': 'm-icon active',
  'upcoming': 'm-icon warn',
  'awaiting reply': 'm-icon warn',
};
const MILESTONE_COLOR = {
  'cleared': 'm-status green',
  'in progress': 'm-status green',
  'upcoming': 'm-status warn',
  'awaiting reply': 'm-status warn',
};

function renderPlanPage() {
  $('#plan-page-label').textContent = D.plan.label.toUpperCase();
  $('#plan-page-title').textContent = `${D.plan.title}, ${D.plan.targetLong}`;
  $('#plan-bar').style.width = `${D.plan.percent}%`;

  const wrap = $('#milestones');
  wrap.replaceChildren();
  for (const m of D.plan.milestones) {
    const row = h('div', 'milestone');
    const icon = h('span', MILESTONE_ICON[m.status] || 'm-icon', '✓');
    const body = h('div');
    body.append(h('p', 'm-label', m.label), h('p', 'm-sub', fillTemplate(m.sub)));
    row.append(icon, body, h('span', MILESTONE_COLOR[m.status] || 'm-status', m.status));
    wrap.append(row);
  }

  for (const [sel, items] of [['#cert-list', D.plan.certRoadmap], ['#driving-list', D.plan.drivingTrack]]) {
    const list = $(sel);
    list.replaceChildren();
    for (const item of items) {
      const row = h('div', 'row spread');
      row.append(h('span', null, item.name), h('span', 'right', item.when));
      list.append(row);
    }
  }
}

/* ------------------------------------------------------------- briefing */

const briefHistory = [];

async function loadBriefing() {
  briefingLoaded = true;
  try {
    const res = await fetch('/api/briefing');
    const brief = await res.json();
    $('#briefing-label').textContent = `${brief.label} · ${brief.time}`;
    $('#briefing-text').textContent = brief.text;
    briefHistory.length = 0;
    briefHistory.push({ role: 'assistant', content: brief.text });

    const actions = $('#briefing-actions');
    actions.replaceChildren();
    $('#briefing-thread').replaceChildren();
    for (const action of brief.actions) {
      const btn = h('button', 'btn pill', action.label);
      btn.addEventListener('click', () => onBriefingAction(action.id, btn));
      actions.append(btn);
    }
  } catch {
    $('#briefing-text').textContent = 'Briefing unavailable — is the LOKI server running?';
  }
}

function briefBubble(role, text, pending = false) {
  const thread = $('#briefing-thread');
  const el = role === 'user'
    ? h('div', 'user-bubble', text)
    : h('div', `brief-reply${pending ? ' pending' : ''}`, text);
  thread.append(el);
  el.scrollIntoView({ block: 'nearest' });
  return el;
}

async function onBriefingAction(id, btn) {
  if (id === 'callbacks') {
    gotoTab('dashboard');
    toast('Callbacks are in the watching feed.');
    return;
  }
  if (id === 'dismiss') {
    $('#briefing-actions').replaceChildren();
    toast('Noted. Same time tomorrow.');
    return;
  }
  if (id === 'draft') {
    btn.disabled = true;
    const thread = $('#briefing-thread');
    thread.append(h('div', 'brief-divider', 'a moment later'));
    briefBubble('user', 'Draft the follow-up, keep it short.');
    briefHistory.push({ role: 'user', content: 'Draft the follow-up, keep it short.' });
    const pending = briefBubble('assistant', 'Writing it…', true);
    const { ok, data } = await postJson('/api/briefing/draft', {});
    pending.remove();
    const reply = ok ? data.reply : (data?.message || 'Drafting failed — try again.');
    briefBubble('assistant', reply);
    briefHistory.push({ role: 'assistant', content: reply });
    if (ok && !data.inGmail) briefBubble('assistant', `Subject: ${data.subject}\n\n${data.body}`);
    if (!ok) btn.disabled = false;
    loadDashboard();
  }
}

$('#briefing-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#briefing-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  briefBubble('user', text);
  briefHistory.push({ role: 'user', content: text });
  const pending = briefBubble('assistant', '…', true);
  const { ok, data } = await postJson('/api/chat', { mode: 'briefing', messages: briefHistory });
  pending.remove();
  const reply = ok ? data.reply : (data?.message || 'Something broke on the AI side — try again.');
  briefBubble('assistant', reply);
  briefHistory.push({ role: 'assistant', content: reply });
});

/* ---------------------------------------------------------- connections */

function renderConnections() {
  const wrap = $('#conn-list');
  wrap.replaceChildren();
  const g = D.google;
  const aiInfo = D.ai;

  // AI model — LOKI's brain
  const brandName = aiInfo.provider === 'anthropic' ? 'Claude' : 'Ollama';
  const aiWhen = aiInfo.provider === 'ollama'
    ? `Ollama ${aiInfo.version || '?'} · ${aiInfo.model}`
    : `${brandName} · ${aiInfo.model}`;
  wrap.append(connRow(aiInfo.ready
    ? {
        dot: aiInfo.notice ? 'dot warn' : 'dot',
        state: aiInfo.notice ? 'Update available' : 'Connected',
        stateCls: aiInfo.notice ? 'conn-state warn' : 'conn-state',
        when: aiWhen,
        name: 'AI model', desc: 'Voice chat, briefing replies, flashcards, drafts',
        btn: 'Manage', btnCls: aiInfo.notice ? 'btn primary' : 'btn',
        onClick: () => toast(aiInfo.notice
          || 'Swap the brain in loki/.env: ANTHROPIC_API_KEY / ANTHROPIC_MODEL for Claude, or AI_PROVIDER=ollama with a local model.'),
      }
    : {
        dot: 'dot off', state: 'Needs setup', stateCls: 'conn-state warn',
        when: aiInfo.provider === 'ollama' ? `Ollama ${aiInfo.version || ''} · no models` : 'Claude API key, or local Ollama',
        name: 'AI model', desc: 'Voice chat, briefing replies, flashcards, drafts',
        btn: 'Set up', btnCls: 'btn primary',
        onClick: () => toast(aiInfo.notice
          || 'Add ANTHROPIC_API_KEY to loki/.env (console.anthropic.com), or install Ollama and pull a model — LOKI auto-detects it. Restart the server after.'),
      }));

  // Google Calendar + Gmail (real OAuth state)
  const googleRows = [
    { name: 'Google Calendar', desc: 'Ago shifts, gym blocks, study sessions', syncedAt: D.schedule.source === 'google' ? D.schedule.syncedAt : null },
    { name: 'Gmail', desc: 'Starred → flagged · AI follow-up drafts', syncedAt: D.flagged.source === 'google' ? D.flagged.syncedAt : null, wantsDraft: true },
  ];
  for (const row of googleRows) {
    if (g.connected) {
      const needsRelink = row.wantsDraft && !g.canDraft;
      wrap.append(connRow({
        dot: needsRelink ? 'dot warn' : 'dot',
        state: needsRelink ? 'Re-link for drafts' : 'Connected',
        stateCls: needsRelink ? 'conn-state warn' : 'conn-state',
        when: row.syncedAt ? `synced ${relTime(row.syncedAt)}` : 'sync pending',
        name: row.name, desc: row.desc,
        btn: needsRelink ? 'Re-link' : 'Manage',
        btnCls: needsRelink ? 'btn primary' : 'btn',
        onClick: needsRelink ? connectGoogle : disconnectGoogle,
      }));
    } else {
      wrap.append(connRow({
        dot: 'dot off',
        state: g.configured ? 'Not linked' : 'Needs setup',
        stateCls: g.configured ? 'conn-state off' : 'conn-state warn',
        when: 'calendar read · mail read + drafts',
        name: row.name, desc: row.desc,
        btn: 'Connect', btnCls: 'btn primary',
        onClick: connectGoogle,
      }));
    }
  }

  // Bank fund — managed in-app
  wrap.append(connRow({
    dot: D.fund.reauthNeeded ? 'dot warn' : 'dot',
    state: D.fund.reauthNeeded ? 'Needs update' : 'Up to date',
    stateCls: D.fund.reauthNeeded ? 'conn-state warn' : 'conn-state',
    when: `€${D.fund.currentEur} · updated ${relTime(D.fund.updatedAt)}`,
    name: 'Bank / budgeting app', desc: 'Kot deposit fund — managed in-app',
    btn: 'Update', btnCls: D.fund.reauthNeeded ? 'btn primary' : 'btn',
    onClick: updateFund,
  }));

  // Honest placeholders
  for (const src of D.sources.filter((s) => s.kind === 'planned')) {
    wrap.append(connRow({
      dot: 'dot off', state: 'Planned', stateCls: 'conn-state off',
      when: 'integration on the roadmap',
      name: src.name, desc: src.desc,
      btn: 'Manage', btnCls: 'btn',
      onClick: () => toast(`${src.name} has no public API hook wired yet — on the roadmap.`),
    }));
  }

  const live = wrap.querySelectorAll('.conn-state:not(.off):not(.warn)').length;
  $('#conn-sub').textContent =
    `${live} of ${wrap.children.length} sources are live. Nothing here is written back without asking first.`;

  const notes = [];
  if (!g.configured) notes.push('Google OAuth is not configured: copy loki/.env.example to loki/.env, add your Google client ID + secret, restart. Steps in the README.');
  if (!aiInfo.ready) notes.push('No AI linked: add ANTHROPIC_API_KEY to loki/.env, or run Ollama locally. Steps in the README.');
  if (g.connected && g.email) notes.push(`Google account: ${g.email} · calendar read-only, gmail read + drafts (never sends)`);
  $('#conn-note').textContent = notes.join(' — ');
}

function connRow({ dot, state, stateCls, when, name, desc, btn, btnCls, onClick }) {
  const row = h('div', 'conn-row');
  const main = h('div');
  main.append(h('p', 'conn-name', name), h('p', 'conn-desc', desc));
  const status = h('div', 'conn-status');
  status.append(h('p', stateCls, state), h('p', 'conn-when', when));
  const button = h('button', btnCls, btn);
  button.addEventListener('click', onClick);
  row.append(h('span', dot), main, status, button);
  return row;
}

function connectGoogle() {
  if (!D.google.configured) {
    toast('Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to loki/.env first — see the README for the Google Cloud setup.');
    return;
  }
  location.href = '/auth/google';
}

async function disconnectGoogle() {
  if (!confirm('Disconnect Google from LOKI? Schedule and flagged mail go back to local data.')) return;
  await postJson('/api/auth/disconnect', {});
  toast('Google disconnected.');
  loadDashboard();
}

async function updateFund() {
  const value = prompt('Current kot fund balance (€):', String(D.fund.currentEur));
  if (value === null) return;
  const currentEur = Number(value);
  if (!Number.isFinite(currentEur) || currentEur < 0) return toast('That is not an amount.');
  await postJsonPatch('/api/fund', { currentEur, reauthNeeded: false });
  toast(`Kot fund updated: €${currentEur}.`);
  loadDashboard();
}

/* ----------------------------------------------------------- data flow */

async function loadDashboard() {
  try {
    const res = await fetch('/api/dashboard');
    if (!res.ok) throw new Error(String(res.status));
    D = await res.json();
    renderHero();
    renderWatching();
    renderCards();
    renderWidget();
    renderPlanPage();
    renderConnections();
    if (!voiceInited && !$('#tab-voice').hidden) initVoice();
  } catch {
    const chip = $('#status-chip');
    chip.className = 'chip err';
    chip.textContent = 'LOKI offline';
  }
}

// OAuth redirect feedback (?google=...)
(function handleQueryFlags() {
  const flag = new URLSearchParams(location.search).get('google');
  if (!flag) return;
  const messages = {
    connected: 'Google linked — calendar, starred mail, and drafting are live.',
    denied: 'Google link cancelled.',
    unconfigured: 'Google OAuth is not configured — see the README.',
    state_mismatch: 'Google link failed (state mismatch) — try again.',
    error: 'Google link failed — check the server logs and try again.',
  };
  toast(messages[flag] || 'Google: unknown status.');
  history.replaceState(null, '', location.pathname + location.hash);
})();

gotoTab(location.hash.replace('#', '') || 'dashboard');
loadDashboard();
setInterval(loadDashboard, 60_000);
setInterval(() => { if (D) { renderWidget(); renderHero(); } }, 30_000);
