// EnergyMap — app shell: navigation, theme, shortcuts, reminders, badge, file drop, service worker.

import { undoFn } from './undo.js';
import { loadState, getState, subscribe, undo, redo, APP_VERSION, lastStorageError, storageReadFailed, parseBackup, replaceState } from './state.js';
import * as A from './actions.js';
import { todayKey, minutesOf, fmtTime, addDays } from './time.js';
import { LEVEL_INFO } from './scheduler.js';
import { icon, logoSVG, toast, anyModalOpen, closeMenu, confirmDialog, readText, $, $$ } from './ui.js';
import * as PlanView from './views/plan.js';
import * as TasksView from './views/tasks.js';
import * as EnergyView from './views/energy.js';
import * as InsightsView from './views/insights.js';
import * as SettingsView from './views/settings.js';
import { openOnboarding, openCheckin, openHelp, openExport, openImportCalendar } from './views/dialogs.js';

const VIEWS = { plan: PlanView, tasks: TasksView, energy: EnergyView, insights: InsightsView, settings: SettingsView };
const NAV = [['plan', 'Plan', 'plan'], ['tasks', 'Tasks', 'tasks'], ['energy', 'Energy', 'energy'], ['insights', 'Insights', 'insights'], ['settings', 'Settings', 'settings']];

let current = null;
let mainEl;
let renderQueued = false;
let lastDay = todayKey();

export const app = {
  go(view, opts = {}) {
    if (!VIEWS[view]) view = 'plan';
    closeMenu();
    if (view === 'plan' && opts.day) PlanView.setDay(opts.day);
    if (current !== view) {
      if (current && VIEWS[current].unmount) VIEWS[current].unmount();
      current = view;
      const host = document.createElement('div');
      host.className = 'view-host';
      mainEl.replaceChildren(host); // fresh element: listeners of the previous view go away with it
      VIEWS[view].mount(host, app);
      try { sessionStorage.setItem('energymap.view', view); } catch { /* ignore */ }
    } else {
      VIEWS[view].update();
    }
    $$('.nav-btn').forEach((b) => b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false'));
    updateBadges();
  },
  render() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      applyTheme();
      if (current) VIEWS[current].update();
      updateBadges();
    });
  },
  applyTheme: () => applyTheme(),
  notify: (title, body, tag) => notify(title, body, tag),
};

// ───────────── theme ─────────────
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = getState().settings.theme;
  const dark = t === 'dark' || (t === 'system' && darkMQ.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try { localStorage.setItem('energymap.theme', t); } catch { /* ignore */ }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0b0b0e' : '#f3f3f6');
}
darkMQ.addEventListener('change', () => { if (getState().settings.theme === 'system') applyTheme(); });

// ───────────── rail ─────────────
function renderRail() {
  const rail = $('#rail');
  rail.innerHTML = `<div class="brand" title="EnergyMap">${logoSVG()}</div>
    ${NAV.map(([v, label, ic], i) => `<button class="nav-btn" data-view="${v}" aria-current="false" title="${label} (Ctrl+${i + 1})">${icon(ic)}<span>${label}</span>${v === 'tasks' ? '<span class="badge-dot" id="tasks-badge" hidden></span>' : ''}</button>`).join('')}
    <span class="spacer"></span>
    <button class="nav-btn" data-cmd="checkin" title="Energy check-in (E)">${icon('battery')}<span>Check-in</span></button>
    <button class="nav-btn" data-cmd="help" title="Help & shortcuts (?)">${icon('help')}<span>Help</span></button>`;
  rail.addEventListener('click', (e) => {
    const b = e.target.closest('.nav-btn');
    if (!b) return;
    if (b.dataset.view) app.go(b.dataset.view);
    else if (b.dataset.cmd === 'checkin') openCheckin();
    else if (b.dataset.cmd === 'help') openHelp();
  });
}

function updateBadges() {
  const s = getState();
  const n = new Date(), nk = todayKey(n), nm = minutesOf(n);
  const backlog = A.backlogTasks(s, n).length + A.missedTasks(s, n).length;
  const tb = $('#tasks-badge');
  if (tb) { tb.hidden = !backlog; tb.textContent = backlog > 99 ? '99+' : String(backlog); tb.title = `${backlog} in backlog`; }
  // taskbar badge: open planned tasks left today
  const left = new Set(s.blocks.filter((b) => b.date === nk && b.end > nm && !A.taskById(s, b.taskId)?.doneAt).map((b) => b.taskId)).size;
  try {
    if (s.settings.badge && 'setAppBadge' in navigator) { if (left) navigator.setAppBadge(left); else navigator.clearAppBadge(); }
    else if ('clearAppBadge' in navigator) navigator.clearAppBadge();
  } catch { /* unsupported */ }
}

// ───────────── reminders ─────────────
const notified = new Set();
async function notify(title, body, tag) {
  const s = getState();
  if (s.settings.sound) import('./ui.js').then((m) => m.chime());
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    toast(`<b>${title.replace(/</g, '&lt;')}</b><br>${body.replace(/</g, '&lt;')}`, { html: true, iconName: 'bell', timeout: 9000 });
    return;
  }
  try {
    const reg = navigator.serviceWorker && (await navigator.serviceWorker.getRegistration());
    if (reg && reg.showNotification) await reg.showNotification(title, { body, tag, icon: 'icons/icon-192.png', badge: 'icons/icon-96.png', renotify: true });
    else new Notification(title, { body, tag, icon: 'icons/icon-192.png' });
  } catch {
    toast(`<b>${title.replace(/</g, '&lt;')}</b><br>${body.replace(/</g, '&lt;')}`, { html: true, iconName: 'bell', timeout: 9000 });
  }
}

function checkReminders() {
  const s = getState();
  if (!s.settings.reminders) return;
  const n = new Date(), nk = todayKey(n), nm = minutesOf(n);
  const lead = s.settings.reminderLead || 0;
  for (const b of s.blocks) {
    if (b.date !== nk) continue;
    const t = A.taskById(s, b.taskId);
    if (!t || t.doneAt) continue;
    const at = b.start - lead;
    const key = `${b.id}:${b.date}:${b.start}`;
    if (nm >= at && nm < b.start + 2 && !notified.has(key)) {
      notified.add(key);
      const when = lead && nm < b.start ? `in ${b.start - nm} min` : 'now';
      notify(`${lead && nm < b.start ? 'Up next' : 'Time for'}: ${t.title}`, `${LEVEL_INFO[t.load].name} energy · ${fmtTime(b.start, s.settings.h12)} – ${fmtTime(b.end, s.settings.h12)} · starts ${when}`, b.id);
    }
  }
}

// ───────────── keyboard ─────────────
function isTyping(e) {
  const t = e.target;
  return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

function onKey(e) {
  if (anyModalOpen()) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && /^[1-5]$/.test(e.key)) { e.preventDefault(); app.go(NAV[+e.key - 1][0]); return; }
  if (mod && (e.key === 'z' || e.key === 'Z') && !isTyping(e)) {
    e.preventDefault();
    const l = e.shiftKey ? redo() : undo();
    if (l) toast(`${e.shiftKey ? 'Redid' : 'Undid'}: ${l}`, { iconName: e.shiftKey ? 'redo' : 'undo', timeout: 2200 });
    return;
  }
  if (mod && (e.key === 'y' || e.key === 'Y') && !isTyping(e)) { e.preventDefault(); const l = redo(); if (l) toast(`Redid: ${l}`, { iconName: 'redo', timeout: 2200 }); return; }
  if (mod && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); openExport({ day: PlanView.currentDay(), mode: PlanView.currentMode() }); return; }
  if (mod || e.altKey || isTyping(e)) return;
  const k = e.key;
  if (k === '?') { e.preventDefault(); openHelp(); return; }
  if (k === 'n' || k === 'N') { e.preventDefault(); app.go('plan'); requestAnimationFrame(() => PlanView.focusQuickAdd()); return; }
  if (k === 'e' || k === 'E') { e.preventDefault(); openCheckin(); return; }
  if (current !== 'plan') return;
  if (e.target && e.target.closest && e.target.closest('.block')) return; // block keys handled by the plan view
  if (k === 'p' || k === 'P') { e.preventDefault(); $('[data-act="plan"]')?.click(); }
  else if (k === 't' || k === 'T') { e.preventDefault(); PlanView.setDay(todayKey()); app.render(); }
  else if (k === 'd' || k === 'D') { e.preventDefault(); PlanView.setMode('day'); A.setSetting('planMode', 'day'); }
  else if (k === 'w' || k === 'W') { e.preventDefault(); PlanView.setMode('week'); A.setSetting('planMode', 'week'); }
  else if (k === 'ArrowLeft' || k === 'ArrowRight') {
    e.preventDefault();
    const step = (PlanView.currentMode() === 'week' ? 7 : 1) * (k === 'ArrowLeft' ? -1 : 1);
    PlanView.setDay(addDays(PlanView.currentDay(), step));
    app.render();
  }
}

// ───────────── file drop (.ics / backup .json) ─────────────
function setupDrop() {
  let overlay = null, depth = 0;
  const show = () => { if (!overlay) { overlay = document.createElement('div'); overlay.className = 'drop-overlay'; overlay.innerHTML = '<div>Drop a calendar file (.ics) to import busy times</div>'; document.body.appendChild(overlay); } };
  const hide = () => { depth = 0; overlay?.remove(); overlay = null; };
  addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { depth++; show(); } });
  addEventListener('dragleave', () => { depth--; if (depth <= 0) hide(); });
  addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
  addEventListener('drop', async (e) => {
    const f = e.dataTransfer?.files?.[0];
    hide();
    if (!f) return;
    e.preventDefault();
    if (/\.ics$/i.test(f.name) || f.type === 'text/calendar') openImportCalendar({ file: f });
    else if (/\.json$/i.test(f.name)) {
      try {
        const next = parseBackup(await readText(f));
        if (await confirmDialog({ title: 'Restore this backup?', message: `It has <b>${next.tasks.length}</b> tasks. Your current data will be replaced (you can undo).`, confirmLabel: 'Restore' })) {
          replaceState(next, 'Restore backup');
          toast('Backup restored.', { iconName: 'check', action: 'Undo', onAction: undoFn() });
        }
      } catch (err) { toast(err.message, { iconName: 'alert' }); }
    } else toast('Drop a .ics calendar file or an EnergyMap backup (.json).', { iconName: 'info' });
  });
}

// ───────────── service worker ─────────────
function setupSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  const hadController = !!navigator.serviceWorker.controller;
  let restartRequested = false;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const prompt = (w) => {
      toast('A new version of EnergyMap is ready.', { iconName: 'refresh', action: 'Restart', timeout: 0, onAction: () => { restartRequested = true; w.postMessage('skip-waiting'); } });
    };
    if (reg.waiting && navigator.serviceWorker.controller) prompt(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) prompt(w); });
    });
  }).catch(() => { /* offline-first is optional */ });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // first install takes control silently; reload only when an update was applied
    if (!reloading && (hadController || restartRequested)) { reloading = true; location.reload(); }
  });
}

// ───────────── boot ─────────────
async function boot() {
  mainEl = $('#main');
  await loadState();
  applyTheme();
  renderRail();
  subscribe((info) => {
    if (info.label === 'storage-error') { toast('Couldn’t save to this PC’s storage. Free up disk space, then try again.', { iconName: 'alert', timeout: 0 }); return; }
    if (info.render !== false || info.label === 'Change setting') app.render();
  });
  let start = 'plan';
  try { start = sessionStorage.getItem('energymap.view') || 'plan'; } catch { /* ignore */ }
  const params = new URLSearchParams(location.search);
  if (params.get('view') && VIEWS[params.get('view')]) start = params.get('view');
  app.go(start);
  document.addEventListener('keydown', onKey);
  setupDrop();
  setupSW();
  setInterval(() => {
    const t = todayKey();
    if (t !== lastDay) {
      if (PlanView.currentDay() === lastDay) PlanView.setDay(t);
      lastDay = t;
      app.render();
    } else if (current && VIEWS[current].tick) VIEWS[current].tick();
    checkReminders();
    updateBadges();
  }, 20000);
  checkReminders();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') app.render(); });
  if (storageReadFailed()) {
    toast('EnergyMap couldn’t open your saved data. To protect it, nothing is saved until the app restarts.', { iconName: 'alert', timeout: 0, action: 'Restart', onAction: () => location.reload() });
  } else if (!getState().settings.onboarded) openOnboarding({ onDone: () => app.render() });
  if (lastStorageError()) toast('Storage is not available — changes may not be saved.', { iconName: 'alert', timeout: 0 });
  if (new URLSearchParams(location.search).has('debug')) window.__em = { getState, actions: A };
  document.documentElement.dataset.ready = '1';
  void APP_VERSION;
}

boot().catch((err) => {
  console.error(err);
  document.getElementById('main').innerHTML = `<div class="empty" style="padding:60px 20px"><strong>EnergyMap couldn’t start</strong>${String(err && err.message || err).replace(/</g, '&lt;')}<br><br><button class="btn" onclick="location.reload()">Try again</button></div>`;
});
