// EnergyMap — Settings: appearance, planning rules, reminders, calendars, data, about.

import { undoFn } from '../undo.js';
import { getState, undo, APP_VERSION, exportJSON, parseBackup, replaceState, listBackups, restoreBackup, resetAll } from '../state.js';
import * as A from '../actions.js';
import { LEVELS, LEVEL_INFO } from '../scheduler.js';
import { fmtTime, fmtDayMed, WEEKDAY_SHORT, WEEKDAY_LETTER, todayKey, addDays as addDaysKey } from '../time.js';
import { esc, icon, LEVEL_ICON, toast, confirmDialog, saveFile, pickFile, readText, openModal, focusKey, refocus, $, $$ } from '../ui.js';
import { openImportCalendar, openBusyEditor, openHelp, openOnboarding } from './dialogs.js';

let root = null;
let app = null;

export function mount(el, appApi) {
  root = el; app = appApi;
  root.innerHTML = `<div class="view"><div class="view-scroll"><div class="view-inner" style="max-width:860px">
    <div class="page-head"><div class="grow"><h1>Settings</h1><p>Make EnergyMap fit the way you work.</p></div></div>
    <div id="sbody"></div></div></div></div>`;
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  update();
}

export function unmount() { root = null; }

const sel = (id, opts, value) => `<select class="input" id="${id}">${opts.map(([v, l]) => `<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
const sw = (id, checked, label) => `<label class="switch"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span class="track"></span><span class="sr-only">${esc(label)}</span></label>`;
const row = (title, desc, ctl) => `<div class="set-row"><div class="info"><h3>${title}</h3>${desc ? `<p>${desc}</p>` : ''}</div><div class="ctl">${ctl}</div></div>`;

function notifStatus() {
  if (!('Notification' in window)) return 'Not supported on this device.';
  if (Notification.permission === 'granted') return 'Windows notifications are allowed.';
  if (Notification.permission === 'denied') return 'Notifications are blocked — allow EnergyMap in Windows Settings › System › Notifications.';
  return 'You’ll be asked to allow notifications.';
}

export function update() {
  if (!root) return;
  const s = getState();
  const st = s.settings;
  const manual = s.busy.filter((b) => !b.sourceId);
  const fk = focusKey(root);
  $('#sbody', root).innerHTML = `
  <section class="set-group"><h2>Appearance</h2><div class="card">
    ${row('Theme', 'Follow Windows, or choose light or dark.', `<div class="seg" role="radiogroup" aria-label="Theme">${[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<button type="button" role="radio" data-act="theme" data-v="${v}" aria-checked="${st.theme === v}">${l}</button>`).join('')}</div>`)}
    ${row('Time format', `Example: ${esc(fmtTime(14 * 60 + 30, st.h12))}`, `<div class="seg" role="radiogroup" aria-label="Time format"><button type="button" role="radio" data-act="h12" data-v="1" aria-checked="${st.h12}">12-hour</button><button type="button" role="radio" data-act="h12" data-v="0" aria-checked="${!st.h12}">24-hour</button></div>`)}
    ${row('Week starts on', '', sel('s-weekstart', [[1, 'Monday'], [0, 'Sunday'], [6, 'Saturday']], st.weekStart))}
  </div></section>

  <section class="set-group"><h2>Planning</h2><div class="card">
    ${row('Work days', 'Auto-plan only uses these days. Your energy phases apply to them.', `<div class="daypick" role="group" aria-label="Work days">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<button type="button" data-act="workday" data-d="${d}" aria-pressed="${st.workDays.includes(d)}" title="${WEEKDAY_SHORT[d]}">${WEEKDAY_LETTER[d]}</button>`).join('')}</div>
      <button class="chip" data-act="workdays" data-v="1,2,3,4,5">Mon–Fri</button><button class="chip" data-act="workdays" data-v="0,1,2,3,4">Sun–Thu</button>`)}
    ${row('Break between tasks', 'A short buffer after every task and around busy time.', sel('s-buffer', [[0, 'No break'], [5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [20, '20 minutes']], st.bufferMins))}
    ${row('Plan ahead', 'How far ahead Auto-plan looks for matching time.', sel('s-horizon', [[3, '3 days'], [5, '5 days'], [7, '7 days'], [10, '10 days'], [14, '2 weeks'], [21, '3 weeks']], st.horizonDays))}
    ${row('Flexible matching', 'When a level is full, lighter tasks may use stronger energy (Low → Steady → Peak). Never the other way round.', sw('s-flex', st.flexibleMatch, 'Flexible matching'))}
    ${row('Split long tasks by default', 'New tasks may be split into several sessions.', sw('s-splitdef', st.splitDefault, 'Split long tasks by default'))}
    ${row('Shortest session', 'When a task is split, no session is shorter than this.', sel('s-minchunk', [[20, '20 minutes'], [30, '30 minutes'], [45, '45 minutes'], [60, '1 hour']], st.minChunkMins))}
    ${row('When a moved task lands on another', 'The task you drop always wins its spot.', sel('s-bump', [['reschedule', 'Move the other to its next free slot'], ['backlog', 'Send the other to the backlog']], st.bumpMode))}
    ${row('New task defaults', '', `${sel('s-defdur', [[15, '15 min'], [30, '30 min'], [45, '45 min'], [60, '1 hour'], [90, '1.5 hours'], [120, '2 hours']], st.defaultDuration)}
      <div class="seg" role="radiogroup" aria-label="Default energy">${LEVELS.map((l) => `<button type="button" role="radio" data-act="defload" data-v="${l}" aria-checked="${st.defaultLoad === l}" class="lvl-${l}">${LEVEL_INFO[l].name}</button>`).join('')}</div>`)}
  </div></section>

  <section class="set-group"><h2>Reminders</h2><div class="card">
    ${row('Task reminders', `A Windows notification when a planned task is about to start, while EnergyMap is open (minimized is fine). ${esc(notifStatus())}`, `<button class="btn small" data-act="test-notif">Test</button>${sw('s-rem', st.reminders, 'Task reminders')}`)}
    ${row('Remind me', '', sel('s-remlead', [[0, 'When the task starts'], [5, '5 minutes before'], [10, '10 minutes before'], [15, '15 minutes before']], st.reminderLead))}
    ${row('Reminder sound', 'A soft chime with each reminder.', sw('s-sound', st.sound, 'Reminder sound'))}
    ${row('Ask about my energy after a task', 'One tap (1–5) helps EnergyMap learn your real rhythm.', sw('s-checkins', st.checkins, 'Ask about energy'))}
    ${row('Taskbar badge', 'Show how many planned tasks are left today on the EnergyMap icon.', sw('s-badge', st.badge, 'Taskbar badge'))}
  </div></section>

  <section class="set-group"><h2>Calendars &amp; busy time</h2><div class="card">
    ${row('Import busy times', 'Add a calendar file (.ics) exported from Outlook or Google Calendar. EnergyMap plans around those events. Nothing leaves your PC.', `<button class="btn" data-act="import-ics">${icon('upload')}Import .ics</button>`)}
    ${s.sources.map((src) => `<div class="source-row">${icon('calendar')}<div class="grow"><div class="n">${esc(src.name)}</div><div class="d">${Number(src.count) || 0} busy block${src.count === 1 ? '' : 's'} · imported ${esc(fmtDayMed(todayKeyOf(src.importedAt)))}${src.until ? ` · covers until ${esc(fmtDayMed(src.until))}` : ''}${src.fileName ? ` · ${esc(src.fileName)}` : ''}</div>
        ${src.until && src.until < addDaysKey(todayKey(), 21) ? `<div class="d" style="color:var(--danger)">Update soon with a fresh export to keep planning around these events.</div>` : ''}</div>
      <button class="btn small" data-act="refresh-src" data-id="${esc(src.id)}">${icon('refresh')}Update</button><button class="btn small ghost danger" data-act="remove-src" data-id="${esc(src.id)}">${icon('trash')}Remove</button></div>`).join('')}
    ${row('Your own busy time', manual.length ? `${manual.length} item${manual.length === 1 ? '' : 's'} — meetings, classes, gym…` : 'Block time for meetings, classes or the gym. You can also click an empty spot on the timeline.', `<button class="btn" data-act="add-busy">${icon('plus')}Add busy time</button>`)}
    ${manual.map((b) => `<div class="source-row">${icon('busy')}<div class="grow"><div class="n">${esc(b.title)}</div><div class="d">${b.repeat ? `Every ${b.repeat.days.map((d) => WEEKDAY_SHORT[d]).join(', ')}` : esc(fmtDayMed(b.date))} · ${esc(fmtTime(b.start, st.h12))} – ${esc(fmtTime(b.end, st.h12))}</div></div>
      <button class="btn small ghost" data-act="edit-busy" data-id="${esc(b.id)}">${icon('edit')}Edit</button></div>`).join('')}
  </div></section>

  <section class="set-group"><h2>Your data</h2><div class="card">
    ${row('Back up', 'Save everything (tasks, plan, energy map, settings) to a file you keep.', `<button class="btn" data-act="backup">${icon('download')}Save backup</button>`)}
    ${row('Restore', 'Replace current data with a backup file.', `<button class="btn" data-act="restore">${icon('upload')}Restore…</button>`)}
    ${row('Automatic backups', 'EnergyMap keeps a daily snapshot of the last 7 days on this PC.', `<button class="btn" data-act="auto-backups">${icon('refresh')}View…</button>`)}
    ${row('Example data', A.hasSample(s) ? 'Example tasks are loaded.' : 'Load example tasks to explore.', A.hasSample(s) ? `<button class="btn" data-act="remove-sample">${icon('trash')}Remove examples</button>` : `<button class="btn" data-act="load-sample">${icon('plus')}Load examples</button>`)}
    ${row('Reset everything', 'Delete all tasks, plans and settings on this PC.', `<button class="btn danger" data-act="reset">${icon('trash')}Reset…</button>`)}
  </div></section>

  <section class="set-group"><h2>About</h2><div class="card">
    ${row(`EnergyMap ${APP_VERSION}`, 'Plan your day around your energy. Works offline — your data stays on this PC.', `<button class="btn" data-act="help">${icon('help')}Help &amp; shortcuts</button><button class="btn" data-act="tour">Welcome tour</button>`)}
    ${row('Privacy', 'No account, no tracking, no ads. Nothing is sent anywhere.', `<a class="btn" href="privacy.html" target="_blank" rel="noopener">Privacy policy</a>`)}
    ${row('Support', 'Questions or ideas? We read every message.', `<a class="btn" href="mailto:haymohsen@gmail.com?subject=EnergyMap%20${APP_VERSION}">Email support</a>`)}
  </div></section>`;
  // every button gets a stable focus key so keyboard users keep their place after a change
  $$('#sbody [data-act]', root).forEach((b) => { if (!b.dataset.fk) b.dataset.fk = [b.dataset.act, b.dataset.v, b.dataset.d, b.dataset.id].filter((x) => x !== undefined).join(':'); });
  refocus(root, fk);
}

function todayKeyOf(iso) {
  if (!iso) return todayKey();
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function onChange(e) {
  const t = e.target;
  const map = {
    's-weekstart': ['weekStart', +t.value], 's-buffer': ['bufferMins', +t.value], 's-horizon': ['horizonDays', +t.value],
    's-flex': ['flexibleMatch', t.checked], 's-splitdef': ['splitDefault', t.checked], 's-minchunk': ['minChunkMins', +t.value],
    's-bump': ['bumpMode', t.value], 's-defdur': ['defaultDuration', +t.value], 's-remlead': ['reminderLead', +t.value],
    's-sound': ['sound', t.checked], 's-checkins': ['checkins', t.checked], 's-badge': ['badge', t.checked],
  };
  if (t.id === 's-rem') {
    if (t.checked && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then(() => update());
    }
    A.setSetting('reminders', t.checked);
    return;
  }
  if (map[t.id]) A.setSetting(map[t.id][0], map[t.id][1]);
}

async function onClick(e) {
  const a = e.target.closest('[data-act]');
  if (!a) return;
  const s = getState();
  switch (a.dataset.act) {
    case 'theme': A.setSetting('theme', a.dataset.v); break;
    case 'h12': A.setSetting('h12', a.dataset.v === '1'); break;
    case 'defload': A.setSetting('defaultLoad', a.dataset.v); break;
    case 'workday': {
      const d = +a.dataset.d;
      const days = s.settings.workDays.includes(d) ? s.settings.workDays.filter((x) => x !== d) : [...s.settings.workDays, d].sort();
      if (!days.length) { toast('Keep at least one work day.', { iconName: 'alert', timeout: 2500 }); break; }
      A.setSetting('workDays', days, { undoable: true });
      break;
    }
    case 'workdays': A.setSetting('workDays', a.dataset.v.split(',').map(Number), { undoable: true }); break;
    case 'test-notif': {
      if (!('Notification' in window)) { toast('Notifications aren’t available here.', { iconName: 'alert' }); break; }
      let perm = Notification.permission;
      if (perm === 'default') perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast('Notifications are blocked. Allow EnergyMap in Windows Settings › System › Notifications.', { iconName: 'alert', timeout: 7000 }); update(); break; }
      app.notify('Up next: Write Q3 strategy report', 'Peak energy · 9:00 – 10:30 · this is a test', 'test');
      update();
      break;
    }
    case 'import-ics': openImportCalendar(); break;
    case 'refresh-src': openImportCalendar({ sourceId: a.dataset.id }); break;
    case 'remove-src': {
      const src = s.sources.find((x) => x.id === a.dataset.id);
      const ok = await confirmDialog({ title: `Remove “${src ? src.name : 'calendar'}”?`, message: 'Its busy times are removed from EnergyMap. Your original calendar isn’t touched.', confirmLabel: 'Remove', danger: true });
      if (ok) { A.removeSource(a.dataset.id); toast('Calendar removed.', { action: 'Undo', onAction: undoFn() }); }
      break;
    }
    case 'add-busy': openBusyEditor({ date: todayKey(), start: 9 * 60, end: 10 * 60 }); break;
    case 'edit-busy': openBusyEditor({ id: a.dataset.id }); break;
    case 'backup': {
      const r = await saveFile(`energymap-backup-${todayKey()}.json`, exportJSON(), 'application/json', 'EnergyMap backup');
      if (r.saved) toast(`Backup saved: ${r.name}`, { iconName: 'download' });
      break;
    }
    case 'restore': {
      const f = await pickFile('.json,application/json');
      if (!f) break;
      try {
        const next = parseBackup(await readText(f));
        const ok = await confirmDialog({ title: 'Restore this backup?', message: `It has <b>${next.tasks.length}</b> tasks. Your current data will be replaced (you can undo).`, confirmLabel: 'Restore' });
        if (ok) { replaceState(next, 'Restore backup'); toast('Backup restored.', { iconName: 'check', action: 'Undo', onAction: undoFn() }); }
      } catch (err) { toast(err.message || 'Could not restore that file.', { iconName: 'alert', timeout: 6000 }); }
      break;
    }
    case 'auto-backups': {
      const list = await listBackups();
      const m = openModal({
        title: 'Automatic backups',
        body: list.length ? `<p class="prose" style="margin-bottom:10px">A snapshot is taken the first time you open EnergyMap each day.</p>${list.map((b) => `<div class="source-row" style="padding:10px 0">${icon('refresh')}<div class="grow"><div class="n">${esc(new Date(b.at).toLocaleString())}</div><div class="d">${b.tasks} tasks</div></div><button class="btn small" data-key="${esc(b.key)}">Restore</button></div>`).join('')}`
          : '<p class="prose">No automatic backups yet — the first one is made tomorrow when you open EnergyMap.</p>',
        actions: [{ label: 'Close' }],
      });
      m.body.querySelectorAll('[data-key]').forEach((b) => b.addEventListener('click', async () => {
        m.close();
        const ok = await confirmDialog({ title: 'Restore this snapshot?', message: 'Your current data will be replaced (you can undo).', confirmLabel: 'Restore' });
        if (ok) { await restoreBackup(b.dataset.key); toast('Snapshot restored.', { iconName: 'check', action: 'Undo', onAction: undoFn() }); }
      }));
      break;
    }
    case 'load-sample': { const r = A.loadSample(); toast(`Added ${r.tasks} example tasks and planned them.`, { iconName: 'sparkles', action: 'Undo', onAction: undoFn() }); break; }
    case 'remove-sample': { const n = A.removeSample(); toast(`Removed ${n} example tasks.`, { action: 'Undo', onAction: undoFn() }); break; }
    case 'reset': {
      const ok = await confirmDialog({ title: 'Reset everything?', message: 'All tasks, plans, busy times, check-ins and settings on this PC will be deleted. Save a backup first if you might need them. Automatic backups are kept.', confirmLabel: 'Delete everything', danger: true });
      if (ok) { await resetAll(); app.applyTheme(); app.go('plan'); openOnboarding({ onDone: () => app.render() }); }
      break;
    }
    case 'help': openHelp(); break;
    case 'tour': openOnboarding({ onDone: () => app.render() }); break;
    default: break;
  }
}

export { LEVEL_ICON };
