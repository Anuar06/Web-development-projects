/* LOKI v0.3 — dashboard client. One payload (/api/dashboard) drives every tab. */

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

function toast(msg, ms = 3800) {
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

function gotoTab(name) {
  if (!TABS.includes(name)) name = 'dashboard';
  for (const t of TABS) {
    $(`#tab-${t}`).hidden = t !== name;
  }
  document.querySelectorAll('#nav button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  if (name === 'briefing' && !briefingLoaded) loadBriefing();
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
}

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
    const dotCls = item.tag === 'pipeline' ? 'dot' : 'dot warn';
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
  flag.textContent = D.fund.reauthNeeded ? 'reauth needed' : `updated ${relTime(D.fund.updatedAt)}`;

  // schedule
  const sSync = $('#schedule-sync');
  sSync.textContent = D.schedule.source === 'google'
    ? `synced ${relTime(D.schedule.syncedAt)}`
    : 'local · not synced';
  const sList = $('#schedule-list');
  sList.replaceChildren();
  if (!D.schedule.items.length) {
    sList.append(h('p', 'empty', 'Nothing on the calendar today.'));
  }
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
  const fSync = $('#flagged-sync');
  fSync.textContent = D.flagged.source === 'google'
    ? `synced ${relTime(D.flagged.syncedAt)}`
    : 'local · not synced';
  const fList = $('#flagged-list');
  fList.replaceChildren();
  if (!D.flagged.items.length) {
    fList.append(h('p', 'empty', 'No starred mail.'));
  }
  for (const msg of D.flagged.items.slice(0, 5)) {
    const row = h('div', 'row spread');
    row.append(
      h('span', 'ellip', `${msg.from} — ${msg.subject}`),
      h('span', 'right', `${msg.ageDays}d`),
    );
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
  try {
    await fetch(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ done: task.done }),
    });
  } catch {
    task.done = !task.done;
    renderTasks();
    toast('Could not save — is the LOKI server running?');
  }
}

$('#task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#task-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(() => toast('Could not save task.'));
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
  const snoozed = sessionStorage.getItem('loki-snooze');
  $('#widget-nudge-text').textContent = snoozed
    ? 'Snoozed. I’ll bring it back later.'
    : (D.watching[0]?.text || 'All quiet.');
}

$('#widget-snooze').addEventListener('click', () => {
  sessionStorage.setItem('loki-snooze', '1');
  renderWidget();
  toast('Snoozed for this session.');
});
$('#widget-start').addEventListener('click', () => {
  toast('Logged. Block timer arrives in v0.4 — go start it for real.');
});

/* ---------------------------------------------------------------- voice */

function renderVoice() {
  const study = D.tasks.find((t) => !t.done && /ospf|ccna/i.test(t.text));
  const next = upcomingSchedule()[0];
  let line = 'Channel open. Ask me about the schedule, the pipeline, or the plan.';
  if (next && study) {
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const gap = next.min - nowMin;
    const where = /push|gym/i.test(next.label) ? 'the gym'
      : /ago|shift/i.test(next.label) ? 'your shift'
      : 'your next block';
    line = gap <= 180
      ? `You've got a ${gap}-minute OSPF window before ${where}. Want the flashcard summary, or should I queue the full Packet Tracer lab?`
      : `Clear runway until ${next.time}. Open OSPF work is on the list — flashcards or the full lab?`;
  } else if (study) {
    line = 'No fixed blocks ahead — open OSPF work is still on the list. Flashcards or the full lab?';
  }
  $('#voice-text').textContent = line;
}

$('#voice-flash').addEventListener('click', () =>
  toast('Flashcard module is offline in v0.3 — queued for v0.4.'));
$('#voice-lab').addEventListener('click', () =>
  toast('Packet Tracer lab: open it manually for now — the launcher lands in v0.4.'));
$('#voice-remind').addEventListener('click', async () => {
  await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'After gym: OSPF full lab' }),
  }).catch(() => {});
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

async function loadBriefing() {
  briefingLoaded = true;
  try {
    const res = await fetch('/api/briefing');
    const brief = await res.json();
    $('#briefing-label').textContent = `${brief.label} · ${brief.time}`;
    $('#briefing-text').textContent = brief.text;

    const actions = $('#briefing-actions');
    actions.replaceChildren();
    $('#briefing-thread').replaceChildren();
    for (const action of brief.actions) {
      const btn = h('button', 'btn pill', action.label);
      btn.addEventListener('click', () => onBriefingAction(action.id, brief, btn));
      actions.append(btn);
    }
  } catch {
    $('#briefing-text').textContent = 'Briefing unavailable — is the LOKI server running?';
  }
}

function onBriefingAction(id, brief, btn) {
  if (id === 'callbacks') {
    gotoTab('dashboard');
    toast('Callbacks are in the watching feed.');
  } else if (id === 'dismiss') {
    $('#briefing-actions').replaceChildren();
    toast('Noted. Same time tomorrow.');
  } else if (id === 'draft' && brief.draftDemo) {
    btn.disabled = true;
    const thread = $('#briefing-thread');
    thread.replaceChildren(
      h('div', 'brief-divider', 'a moment later'),
      h('div', 'user-bubble', brief.draftDemo.userLine),
    );
    const reply = h('div', 'brief-reply', brief.draftDemo.reply);
    setTimeout(() => thread.append(reply), 650);
  }
}

/* ---------------------------------------------------------- connections */

function renderConnections() {
  const wrap = $('#conn-list');
  wrap.replaceChildren();
  const g = D.google;

  const googleRows = [
    {
      name: 'Google Calendar',
      desc: 'Ago shifts, gym blocks, study sessions',
      syncedAt: D.schedule.source === 'google' ? D.schedule.syncedAt : null,
    },
    {
      name: 'Gmail',
      desc: 'Starred threads → flagged messages',
      syncedAt: D.flagged.source === 'google' ? D.flagged.syncedAt : null,
    },
  ];

  for (const row of googleRows) {
    if (g.connected) {
      wrap.append(connRow({
        dot: 'dot', state: 'Connected', stateCls: 'conn-state',
        when: row.syncedAt ? `synced ${relTime(row.syncedAt)}` : 'sync pending',
        name: row.name, desc: row.desc,
        btn: 'Manage', btnCls: 'btn',
        onClick: disconnectGoogle,
      }));
    } else {
      wrap.append(connRow({
        dot: 'dot off', state: g.configured ? 'Not linked' : 'Needs setup',
        stateCls: g.configured ? 'conn-state off' : 'conn-state warn',
        when: 'read-only access',
        name: row.name, desc: row.desc,
        btn: 'Connect', btnCls: 'btn primary',
        onClick: connectGoogle,
      }));
    }
  }

  for (const src of D.sources) {
    const reauth = src.status === 'reauth';
    wrap.append(connRow({
      dot: reauth ? 'dot warn' : 'dot',
      state: reauth ? 'Needs reauth' : 'Connected',
      stateCls: reauth ? 'conn-state warn' : 'conn-state',
      when: reauth ? `token expired ${relTime(src.statusAt)}` : `synced ${relTime(src.syncedAt)}`,
      name: src.name, desc: src.desc,
      btn: 'Manage', btnCls: 'btn',
      onClick: () => toast(
        src.key === 'bank'
          ? 'Bank sync is manual for now — update the fund via the API (see README).'
          : `${src.name} is a stub source — real integration is on the roadmap.`,
      ),
    }));
  }

  $('#conn-note').textContent = g.configured
    ? (g.connected && g.email ? `Google account: ${g.email} · read-only scopes (calendar, gmail)` : '')
    : 'Google OAuth is not configured yet. Copy loki/.env.example to loki/.env, add your Google client ID + secret, restart the server. Full steps in the README.';
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
  await fetch('/api/auth/disconnect', { method: 'POST' }).catch(() => {});
  toast('Google disconnected.');
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
    renderVoice();
    renderPlanPage();
    renderConnections();
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
    connected: 'Google linked — calendar and starred mail are syncing.',
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
