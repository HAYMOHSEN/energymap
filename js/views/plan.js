// EnergyMap — Plan view: day/week timeline with energy phases, drag & drop, backlog and quick add.

import { undoFn } from '../undo.js';
import { getState, canUndo, undo, undoLabel } from '../state.js';
import * as A from '../actions.js';
import {
  normalizePhases, isWorkDay, LEVEL_INFO, LEVELS, busyForDay, levelFor, phaseAt, overlappingBusy, blockEndsBefore,
  blockStartsAfter, mergedWindows,
} from '../scheduler.js';
import {
  todayKey, addDays, weekKeys, fmtDayLong, fmtWeekdayShort, fmtDayNum, fmtTime, fmtDuration, fmtRelDay, fmtMonthDay,
  minutesOf, clamp, roundTo, DAY_MIN, diffDays, parseKey, fmtDeadline, parseDeadline, cmpKM, fmtHours, weekday,
} from '../time.js';
import { parseQuickAdd } from '../quickadd.js';
import { esc, icon, LEVEL_ICON, toast, openMenu, closeMenu, $, $$ } from '../ui.js';
import { openTaskEditor, openBusyEditor, openExport, openCheckin, showPlanResult, describeBumps } from './dialogs.js';

let root = null;
let app = null;
const view = { day: todayKey(), mode: 'day', scrolledFor: null, focusBlock: null, selectBlock: null };
const draft = { text: '', load: null, duration: null, deadline: '', priority: 'normal', split: null, notes: '', more: false, manual: {} };

const SNAP = 5;
const lv = (l) => `lvl-${l}`;
const h12 = () => getState().settings.h12;
const T = (m) => fmtTime(m, h12());

export function setDay(key) { view.day = key; view.scrolledFor = null; }
export function setMode(mode) { view.mode = mode; view.scrolledFor = null; }
export const currentDay = () => view.day;
export const currentMode = () => view.mode;

export function mount(el, appApi) {
  root = el; app = appApi;
  view.mode = getState().settings.planMode || 'day';
  root.innerHTML = `
  <div class="view" id="plan-view">
    <header class="topbar">
      <div class="title-block"><h1 id="pv-title"></h1><div class="subtitle" id="pv-sub"></div></div>
      <div class="btn-group">
        <button class="btn icon" data-act="prev" aria-label="Previous">${icon('chevron-left')}</button>
        <button class="btn" data-act="today">Today</button>
        <button class="btn icon" data-act="next" aria-label="Next">${icon('chevron-right')}</button>
      </div>
      <div class="seg" role="group" aria-label="Layout">
        <button type="button" data-act="mode" data-mode="day">Day</button>
        <button type="button" data-act="mode" data-mode="week">Week</button>
      </div>
      <button class="btn icon ghost hide-sm" data-act="undo" aria-label="Undo" title="Undo (Ctrl+Z)">${icon('undo')}</button>
      <button class="btn hide-sm" data-act="checkin" title="Log how you feel (E)">${icon('battery')}<span>Check-in</span></button>
      <button class="btn" data-act="export" title="Export to your calendar">${icon('download')}<span class="hide-sm">Export</span></button>
      <div class="btn-group" style="gap:1px">
        <button class="btn primary" data-act="plan" title="Place tasks into matching energy (P)">${icon('sparkles')}<span>Auto-plan</span></button>
        <button class="btn primary icon" data-act="plan-menu" aria-label="More planning options" style="width:30px">${icon('chevron-down')}</button>
      </div>
    </header>
    <div class="plan">
      <aside class="plan-side" aria-label="Add and backlog">
        <section class="card add-card" id="add-card" aria-label="Add a task"></section>
        <section class="card backlog-card" id="backlog" aria-label="Backlog"></section>
      </aside>
      <section class="plan-board" aria-label="Schedule">
        <div id="now-strip"></div>
        <div class="tg" id="tg"></div>
      </section>
    </div>
  </div>`;
  renderAddCard();
  root.addEventListener('click', onClick);
  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('keydown', onKeyDown);
  root.addEventListener('contextmenu', onContextMenu);
  $('#tg', root).addEventListener('wheel', onWheel, { passive: false });
  update();
}

export function unmount() {
  if (!root) return;
  root.removeEventListener('click', onClick);
  root.removeEventListener('pointerdown', onPointerDown);
  root.removeEventListener('keydown', onKeyDown);
  root.removeEventListener('contextmenu', onContextMenu);
  cancelDrag();
  root = null;
}

export function update() {
  if (!root) return;
  const s = getState();
  const days = visibleDays();
  renderTitle(s, days);
  renderBacklog(s);
  renderNow(s);
  renderGrid(s, days);
  $$('.seg [data-mode]', root).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === view.mode)));
  const u = $('[data-act="undo"]', root);
  if (u) { u.disabled = !canUndo(); u.title = canUndo() ? `Undo ${undoLabel()} (Ctrl+Z)` : 'Nothing to undo'; }
  if (view.focusBlock) {
    const el = root.querySelector(`.block[data-block="${view.focusBlock}"]`);
    if (el) el.focus({ preventScroll: false });
    view.focusBlock = null;
  }
}

export function tick() {
  if (!root) return;
  const s = getState();
  renderNow(s);
  const line = $('.now-line', root);
  const range = gridRange(s, visibleDays());
  if (line) {
    const m = minutesOf(new Date());
    line.style.top = `${(m - range.start) * ppm()}px`;
    line.hidden = m < range.start || m > range.end;
  }
}

function visibleDays() {
  const s = getState();
  return view.mode === 'week' ? weekKeys(view.day, s.settings.weekStart) : [view.day];
}

const ppm = () => {
  const z = getState().settings.zoom || 1;
  return (view.mode === 'week' ? 1.15 : 1.6) * z;
};

// ───────────── title ─────────────
function renderTitle(s, days) {
  const title = $('#pv-title', root), sub = $('#pv-sub', root);
  const blocks = s.blocks.filter((b) => days.includes(b.date));
  const tasks = new Set(blocks.map((b) => b.taskId));
  const mins = { peak: 0, steady: 0, low: 0 };
  let done = 0;
  for (const id of tasks) { const t = A.taskById(s, id); if (t && t.doneAt) done++; }
  for (const b of blocks) { const t = A.taskById(s, b.taskId); if (t) mins[t.load] += b.end - b.start; }
  const total = mins.peak + mins.steady + mins.low;
  if (view.mode === 'day') {
    title.textContent = fmtDayLong(view.day);
    const dd = diffDays(todayKey(), view.day);
    const parts = [dd === 0 ? 'Today' : dd === 1 ? 'Tomorrow' : dd === -1 ? 'Yesterday' : dd > 1 ? `In ${dd} days` : `${-dd} days ago`];
    if (!isWorkDay(view.day, s.settings)) parts.push('Day off');
    parts.push(tasks.size ? `${tasks.size} task${tasks.size > 1 ? 's' : ''} · ${fmtDuration(total)}` : 'Nothing planned');
    if (done) parts.push(`${done} done`);
    sub.textContent = parts.join(' · ');
  } else {
    const a = days[0], b = days[days.length - 1];
    const sameMonth = parseKey(a).getMonth() === parseKey(b).getMonth();
    title.textContent = sameMonth ? `${fmtMonthDay(a)} – ${fmtDayNum(b)}, ${parseKey(b).getFullYear()}` : `${fmtMonthDay(a)} – ${fmtMonthDay(b)}, ${parseKey(b).getFullYear()}`;
    sub.textContent = tasks.size
      ? `${tasks.size} tasks · ${fmtHours(total)} planned — Peak ${fmtHours(mins.peak)} · Steady ${fmtHours(mins.steady)} · Low ${fmtHours(mins.low)}`
      : 'Nothing planned this week yet';
  }
}

// ───────────── add card ─────────────
function renderAddCard() {
  const s = getState();
  const el = $('#add-card', root);
  const load = draft.load || s.settings.defaultLoad || 'peak';
  const dur = draft.duration || s.settings.defaultDuration || 60;
  const split = draft.split ?? s.settings.splitDefault;
  el.innerHTML = `
    <div class="quick">${icon('plus')}
      <input class="input" id="qa" type="text" autocomplete="off" spellcheck="true" maxlength="300"
        placeholder="Add a task (e.g. Draft memo 45m)" aria-label="Task title" value="${esc(draft.text)}">
    </div>
    <div class="understood" id="qa-understood" aria-live="polite"></div>
    <div class="opts">
      <div>
        <div class="label" style="margin-bottom:6px">Energy it needs</div>
        <div class="energy-pick" role="radiogroup" aria-label="Energy it needs">
          ${LEVELS.map((l) => `<button type="button" role="radio" class="${lv(l)}" data-act="pick-load" data-load="${l}" aria-checked="${l === load}">
            <span class="t">${icon(LEVEL_ICON[l])}${LEVEL_INFO[l].name}</span><span class="s">${LEVEL_INFO[l].hint}</span></button>`).join('')}
        </div>
      </div>
      <div class="opt-row">
        <span class="label">Duration</span>
        <div class="chips" role="group" aria-label="Duration">
          ${[15, 30, 45, 60, 90, 120].map((m) => `<button type="button" class="chip" data-act="pick-dur" data-dur="${m}" aria-pressed="${m === dur}">${m < 60 ? m + 'm' : fmtDuration(m)}</button>`).join('')}
          <input class="input dur-custom" id="qa-dur" type="number" min="5" max="720" step="5" value="${dur}" aria-label="Duration in minutes" title="Minutes">
        </div>
      </div>
      <div>
        <button type="button" class="link-btn" data-act="toggle-more" aria-expanded="${draft.more}">${icon('chevron-down')}More options</button>
      </div>
      <div class="more" id="qa-more" ${draft.more ? '' : 'hidden'}>
        <div class="cols-2">
          <div class="field" style="margin:0"><label for="qa-dl">Deadline</label><input class="input" id="qa-dl" type="date" value="${esc(draft.deadline ? draft.deadline.slice(0, 10) : '')}"></div>
          <div class="field" style="margin:0"><label for="qa-dlt">Time</label><input class="input" id="qa-dlt" type="time" value="${esc(draft.deadline && !/T23:59$/.test(draft.deadline) ? draft.deadline.slice(11, 16) : '')}"></div>
        </div>
        <label class="switch"><input type="checkbox" id="qa-high" ${draft.priority === 'high' ? 'checked' : ''}><span class="track"></span><span>High priority</span></label>
        <label class="switch"><input type="checkbox" id="qa-split" ${split ? 'checked' : ''}><span class="track"></span><span>Allow splitting into sessions</span></label>
        <textarea class="input" id="qa-notes" rows="2" placeholder="Notes (optional)" style="min-height:56px">${esc(draft.notes)}</textarea>
      </div>
    </div>
    <div class="actions">
      <button type="button" class="btn" data-act="add-backlog" title="Shift+Enter">Add to backlog</button>
      <button type="button" class="btn primary" data-act="add-schedule" title="Enter">${icon('sparkles')}Auto-schedule</button>
    </div>`;
  const qa = $('#qa', el);
  qa.addEventListener('input', () => { draft.text = qa.value; applyParse(); });
  qa.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // typing with an IME
    if (e.key === 'Enter') { e.preventDefault(); submitDraft(!e.shiftKey); }
    if (e.key === 'Escape') { qa.value = ''; draft.text = ''; applyParse(); }
  });
  $('#qa-dur', el).addEventListener('input', (e) => { const v = +e.target.value; if (v >= 5) { draft.duration = v; draft.manual.duration = true; syncAddControls(); } });
  $('#qa-dl', el).addEventListener('change', () => { draft.manual.deadline = true; readDeadline(); syncUnderstood(); });
  $('#qa-dlt', el).addEventListener('change', () => { draft.manual.deadline = true; readDeadline(); syncUnderstood(); });
  $('#qa-high', el).addEventListener('change', (e) => { draft.priority = e.target.checked ? 'high' : 'normal'; draft.manual.priority = true; syncUnderstood(); });
  $('#qa-split', el).addEventListener('change', (e) => { draft.split = e.target.checked; draft.manual.split = true; });
  $('#qa-notes', el).addEventListener('input', (e) => { draft.notes = e.target.value; });
  applyParse();
}

function readDeadline() {
  const d = $('#qa-dl', root).value, t = $('#qa-dlt', root).value;
  draft.deadline = d ? `${d}T${t || '23:59'}` : '';
}

function applyParse() {
  const p = parseQuickAdd(draft.text);
  const s = getState();
  if (!draft.manual.load) draft.load = p.load || null;
  if (!draft.manual.duration) draft.duration = p.durationMins || null;
  if (!draft.manual.deadline) draft.deadline = p.deadline || '';
  if (!draft.manual.priority) draft.priority = p.priority || 'normal';
  if (!draft.manual.split && p.splittable) draft.split = true;
  draft.parsed = p;
  if (p.deadline && !draft.manual.deadline) draft.more = draft.more || false;
  syncAddControls(s);
}

function syncAddControls(s = getState()) {
  if (!root) return;
  const el = $('#add-card', root);
  const load = draft.load || s.settings.defaultLoad || 'peak';
  const dur = draft.duration || s.settings.defaultDuration || 60;
  $$('[data-act="pick-load"]', el).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.load === load)));
  $$('[data-act="pick-dur"]', el).forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.dur === dur)));
  const di = $('#qa-dur', el); if (document.activeElement !== di) di.value = dur;
  const dl = $('#qa-dl', el), dlt = $('#qa-dlt', el);
  if (document.activeElement !== dl) dl.value = draft.deadline ? draft.deadline.slice(0, 10) : '';
  if (document.activeElement !== dlt) dlt.value = draft.deadline && !/T23:59$/.test(draft.deadline) ? draft.deadline.slice(11, 16) : '';
  $('#qa-high', el).checked = draft.priority === 'high';
  if (draft.split !== null) $('#qa-split', el).checked = !!draft.split;
  syncUnderstood();
}

function syncUnderstood() {
  const el = $('#qa-understood', root);
  if (!el) return;
  const p = draft.parsed || { found: [] };
  const bits = [];
  if (p.found.includes('duration')) bits.push(`<b>${fmtDuration(p.durationMins)}</b>`);
  if (p.found.includes('load')) bits.push(`<b>${LEVEL_INFO[p.load].name}</b> energy`);
  if (draft.deadline) bits.push(`due <b>${esc(fmtDeadline(draft.deadline, h12()))}</b>`);
  if (draft.priority === 'high') bits.push('<b>high priority</b>');
  el.innerHTML = bits.length && draft.text.trim() ? `Understood: ${bits.join(' · ')}` : (draft.text.trim() ? '' : '<span>Tip: type <b>90m</b>, <b>#peak</b>, <b>by fri 3pm</b> or <b>!!</b> right in the title.</span>');
}

function resetDraft() {
  draft.text = ''; draft.load = null; draft.duration = null; draft.deadline = ''; draft.priority = 'normal';
  draft.split = null; draft.notes = ''; draft.manual = {}; draft.parsed = null;
}

function submitDraft(schedule) {
  const s = getState();
  const p = parseQuickAdd(draft.text);
  const title = (p.title || draft.text).trim();
  if (!title) { $('#qa', root).focus(); toast('Type a task title first.', { iconName: 'info', timeout: 2500 }); return; }
  const fields = {
    title, notes: draft.notes, load: draft.load || s.settings.defaultLoad || 'peak',
    durationMins: draft.duration || s.settings.defaultDuration || 60,
    deadline: draft.deadline || null, priority: draft.priority,
    splittable: draft.split ?? s.settings.splitDefault,
  };
  const r = A.addTask(fields, { autoSchedule: schedule });
  const keepMore = draft.more;
  resetDraft(); draft.more = keepMore;
  renderAddCard();
  $('#qa', root).focus();
  if (!schedule) { toast(`Added “${title}” to the backlog.`, { iconName: 'inbox', action: 'Undo', onAction: undoFn(), timeout: 3500 }); return; }
  if (r.placements && r.placements.length) {
    const p0 = r.placements[0];
    const where = `${fmtRelDay(p0.date)} ${T(p0.start)}`;
    const visible = visibleDays().includes(p0.date);
    const undoIt = undoFn();
    toast(`Scheduled <b>${esc(title)}</b> · ${esc(where)}${r.placements.length > 1 ? ` (+${r.placements.length - 1} more session${r.placements.length > 2 ? 's' : ''})` : ''}`, {
      html: true, iconName: 'check', action: visible ? 'Undo' : 'Show',
      onAction: visible ? undoIt : () => { setDay(p0.date); app.render(); },
    });
    view.selectBlock = null;
  } else {
    toast(`<b>${esc(title)}</b> is in the backlog — ${esc(r.unplaced ? r.unplaced.reason : 'no matching time found.')}`, { html: true, iconName: 'info', timeout: 7000 });
  }
}

// ───────────── backlog ─────────────
function renderBacklog(s) {
  const el = $('#backlog', root);
  const n = new Date();
  const backlog = A.backlogTasks(s, n);
  const missed = A.missedTasks(s, n);
  const reasons = A.backlogReasons(s, n);
  const horizonEnd = addDays(todayKey(n), s.settings.horizonDays - 1);
  const order = (a, b) => {
    const da = a.deadline || '9999', db = b.deadline || '9999';
    if (da !== db) return da < db ? -1 : 1;
    if (a.priority !== b.priority) return a.priority === 'high' ? -1 : 1;
    return (a.createdAt || '') < (b.createdAt || '') ? -1 : 1;
  };
  backlog.sort(order);
  const item = (t, isMissed) => {
    const r = reasons.get(t.id);
    const dl = parseDeadline(t.deadline);
    const overdue = dl && cmpKM(dl.key, dl.min, todayKey(n), minutesOf(n)) < 0;
    return `<div class="task-item ${lv(t.load)} ${t.priority === 'high' ? 'is-high' : ''}" data-task="${esc(t.id)}" tabindex="0" role="listitem"
      aria-label="${esc(t.title)}, ${LEVEL_INFO[t.load].name}, ${fmtDuration(t.durationMins)}. Drag onto the schedule or press Enter to edit.">
      <span class="bar"></span>
      <div class="body">
        <div class="ttl">${esc(t.title)}</div>
        <div class="meta">
          <span>${icon(LEVEL_ICON[t.load])}${LEVEL_INFO[t.load].name}</span>
          <span>${icon('clock')}${fmtDuration(t.durationMins)}</span>
          ${t.deadline ? `<span class="${overdue ? 'overdue' : ''}">${icon('flag')}${esc(fmtDeadline(t.deadline, h12(), n))}</span>` : ''}
          ${t.splittable ? `<span title="Can be split into sessions">${icon('split')}</span>` : ''}
          ${isMissed ? '<span class="overdue">Missed</span>' : ''}
        </div>
        ${r && r.reason ? `<div class="why">${icon('info')}<span>${esc(r.reason)}</span></div>` : ''}
      </div>
      <div class="acts">
        <button class="btn ghost icon small" data-act="schedule-one" data-task="${esc(t.id)}" aria-label="Schedule “${esc(t.title)}”" title="Schedule in the next matching slot">${icon('sparkles')}</button>
        <button class="btn ghost icon small" data-act="task-done" data-task="${esc(t.id)}" aria-label="Mark “${esc(t.title)}” done" title="Mark done">${icon('check')}</button>
      </div>
    </div>`;
  };
  const total = backlog.length + missed.length;
  el.innerHTML = `
    <div class="card-head"><h2>Backlog</h2><span class="count">${total}</span><span class="grow"></span>
      ${backlog.length ? `<button class="btn small" data-act="plan-backlog" title="Place backlog tasks without moving your plan">${icon('sparkles')}Plan backlog</button>` : ''}
    </div>
    ${missed.length ? `<div class="missed-bar">${icon('alert')}<span class="grow">${missed.length} task${missed.length > 1 ? 's' : ''} not done in ${missed.length > 1 ? 'their' : 'its'} slot</span>
      <button class="btn small" data-act="plan-backlog">Re-plan</button></div>` : ''}
    <div class="backlog-list" role="list">
      ${missed.map((t) => item(t, true)).join('')}
      ${backlog.map((t) => item(t, false)).join('')}
      ${total ? '' : `<div class="empty">${icon('inbox')}<strong>Backlog is clear</strong>Add a task above, or drag a block here to unschedule it.</div>`}
    </div>`;
  void horizonEnd;
}

// ───────────── now strip ─────────────
function renderNow(s) {
  const el = $('#now-strip', root);
  const n = new Date(), nk = todayKey(n), nm = minutesOf(n);
  const days = visibleDays();
  if (!days.includes(nk)) { el.innerHTML = ''; return; }
  const work = isWorkDay(nk, s.settings);
  const phase = work ? phaseAt(s.profile.phases, nm) : null;
  const todays = s.blocks.filter((b) => b.date === nk).sort((a, b) => a.start - b.start);
  const cur = todays.find((b) => b.start <= nm && b.end > nm && !A.taskById(s, b.taskId)?.doneAt);
  const next = todays.find((b) => b.start > nm && !A.taskById(s, b.taskId)?.doneAt);
  const doneCount = new Set(todays.filter((b) => A.taskById(s, b.taskId)?.doneAt).map((b) => b.taskId)).size;
  const totalCount = new Set(todays.map((b) => b.taskId)).size;
  const busyToday = busyForDay(s.busy, nk);
  const busyNow = !cur ? busyToday.find((b) => b.start <= nm && b.end > nm) : null;
  let html;
  if (cur) {
    const t = A.taskById(s, cur.taskId);
    const pct = Math.round(((nm - cur.start) / (cur.end - cur.start)) * 100);
    const lvl = phase ? phase.level : t.load;
    html = `<div class="now-strip ${lv(lvl)}">
      <div class="ico">${icon(LEVEL_ICON[t.load])}</div>
      <div class="txt"><div class="k">Now · ${phase ? `${LEVEL_INFO[phase.level].name} energy` : 'Focus'} · ${fmtDuration(cur.end - nm)} left</div>
        <div class="v">${esc(t.title)}</div><div class="progress"><i style="width:${pct}%"></i></div></div>
      <button class="btn small" data-act="extend" data-block="${esc(cur.id)}" title="Add 15 minutes">+15m</button>
      <button class="btn small primary" data-act="task-done" data-task="${esc(t.id)}">${icon('check')}Done</button>
    </div>`;
  } else if (busyNow) {
    html = `<div class="now-strip">
      <div class="ico">${icon('busy')}</div>
      <div class="txt"><div class="k">Busy until ${esc(T(busyNow.end))}</div>
        <div class="v">${esc(busyNow.title || 'Busy')}${next ? ` · Next: ${esc(A.taskById(s, next.taskId)?.title || '')} at ${esc(T(next.start))}` : ''}</div></div>
      ${totalCount ? `<span class="hint">${doneCount}/${totalCount} done today</span>` : ''}
    </div>`;
  } else if (phase) {
    const nextBusy = busyToday.find((b) => b.start > nm);
    const freeTill = Math.min(phase.end, next ? next.start : DAY_MIN, nextBusy ? nextBusy.start : DAY_MIN);
    const free = freeTill - nm;
    html = `<div class="now-strip ${lv(phase.level)}">
      <div class="ico">${icon(LEVEL_ICON[phase.level])}</div>
      <div class="txt"><div class="k">Now · ${LEVEL_INFO[phase.level].name} energy until ${esc(T(phase.end))}</div>
        <div class="v">${free >= 10 ? `${fmtDuration(free)} free — good for ${LEVEL_INFO[phase.level].hint.toLowerCase()}` : 'Short gap — take a breather'}${next ? ` · Next: ${esc(A.taskById(s, next.taskId)?.title || '')} at ${esc(T(next.start))}` : ''}</div></div>
      ${free >= 10 ? `<button class="btn small" data-act="fill-now">${icon('play')}Start a task now</button>` : ''}
    </div>`;
  } else {
    const upcoming = work ? normalizePhases(s.profile.phases).find((p) => p.start > nm) : null;
    html = `<div class="now-strip">
      <div class="ico">${icon('coffee')}</div>
      <div class="txt"><div class="k">${work ? 'Outside your energy map' : 'Day off'}</div>
        <div class="v">${next ? `Next: ${esc(A.taskById(s, next.taskId)?.title || '')} at ${esc(T(next.start))}` : upcoming ? `${LEVEL_INFO[upcoming.level].name} energy starts at ${esc(T(upcoming.start))}` : totalCount ? 'That’s a wrap for today.' : 'Rest and recharge.'}</div></div>
      ${totalCount ? `<span class="hint">${doneCount}/${totalCount} done today</span>` : ''}
    </div>`;
  }
  el.innerHTML = html;
}

// ───────────── grid ─────────────
function gridRange(s, days) {
  let lo = Infinity, hi = -Infinity;
  const anyWork = days.some((d) => isWorkDay(d, s.settings));
  if (anyWork) for (const p of normalizePhases(s.profile.phases)) { lo = Math.min(lo, p.start); hi = Math.max(hi, p.end); }
  for (const b of s.blocks) if (days.includes(b.date)) { lo = Math.min(lo, b.start); hi = Math.max(hi, b.end); }
  for (const d of days) for (const b of busyForDay(s.busy, d)) { if (b.allDay || (b.start === 0 && b.end === DAY_MIN)) continue; lo = Math.min(lo, b.start); hi = Math.max(hi, b.end); }
  if (!Number.isFinite(lo)) { lo = 8 * 60; hi = 18 * 60; }
  lo = clamp(Math.floor(lo / 60) * 60 - 60, 0, DAY_MIN);
  hi = clamp(Math.ceil(hi / 60) * 60 + 60, 0, DAY_MIN);
  if (hi - lo < 6 * 60) hi = clamp(lo + 6 * 60, 0, DAY_MIN);
  return { start: lo, end: hi };
}

function layoutLanes(items) {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const out = new Map();
  let cluster = [], clusterEnd = -1, lanesEnd = [];
  const flush = () => { for (const it of cluster) out.get(it).lanes = lanesEnd.length; cluster = []; lanesEnd = []; clusterEnd = -1; };
  for (const it of sorted) {
    if (cluster.length && it.start >= clusterEnd) flush();
    let lane = lanesEnd.findIndex((e) => e <= it.start);
    if (lane < 0) { lane = lanesEnd.length; lanesEnd.push(it.end); } else lanesEnd[lane] = it.end;
    out.set(it, { lane, lanes: 1 });
    cluster.push(it); clusterEnd = Math.max(clusterEnd, it.end);
  }
  flush();
  return out;
}

function renderGrid(s, days) {
  const tg = $('#tg', root);
  const prevScroll = $('.tg-scroll', tg)?.scrollTop;
  const range = gridRange(s, days);
  const k = ppm();
  const height = (range.end - range.start) * k;
  const nk = todayKey(), nm = minutesOf(new Date());
  const isDay = view.mode === 'day';
  tg.className = `tg ${isDay ? 'day' : 'week'}`;
  tg.style.setProperty('--cols', days.length);
  tg.style.setProperty('--colmin', isDay ? '0px' : '118px');
  tg.dataset.start = range.start;

  const head = isDay ? '' : `<div class="tg-head"><div class="corner"></div>${days.map((d) => {
    const work = isWorkDay(d, s.settings);
    const bl = s.blocks.filter((b) => b.date === d);
    const mins = { peak: 0, steady: 0, low: 0 };
    for (const b of bl) { const t = A.taskById(s, b.taskId); if (t) mins[t.load] += b.end - b.start; }
    const cap = work ? mergedWindows(s.profile.phases).reduce((m, w) => m + w.end - w.start, 0) : 0;
    const tot = mins.peak + mins.steady + mins.low;
    const denom = Math.max(cap, tot, 1);
    return `<div class="tg-dayhead ${d === nk ? 'today' : ''} ${work ? '' : 'off'}" data-act="goto-day" data-day="${d}" title="Open ${esc(fmtDayLong(d))}">
      <div class="wd">${esc(fmtWeekdayShort(d))}</div><div class="dn"><span>${fmtDayNum(d)}</span></div>
      <div class="load">${LEVELS.map((l) => (mins[l] ? `<i class="${lv(l)}" style="width:${(mins[l] / denom) * 100}%"></i>` : '')).join('')}</div>
      <div class="load-txt">${tot ? `${fmtHours(tot)} planned${cap ? ` of ${fmtHours(cap)}` : ''}` : work ? 'Free' : 'Day off'}</div></div>`;
  }).join('')}</div>`;

  const hours = [];
  for (let m = Math.ceil(range.start / 60) * 60; m <= range.end; m += 60) {
    if (m === range.start) continue;
    hours.push(`<div class="h" style="top:${(m - range.start) * k}px">${esc(fmtTime(m, h12(), { compact: true }))}</div>`);
  }
  const lines = [];
  for (let m = Math.ceil(range.start / 30) * 30; m < range.end; m += 30) {
    if (m === range.start) continue;
    lines.push(`<div class="tg-line ${m % 60 ? 'half' : ''}" style="top:${(m - range.start) * k}px"></div>`);
  }

  const cols = days.map((d, ci) => {
    const work = isWorkDay(d, s.settings);
    const parts = [];
    // energy phases
    if (work) {
      const phs = normalizePhases(s.profile.phases);
      for (const p of phs) {
        if (p.end <= range.start || p.start >= range.end) continue;
        const top = (Math.max(p.start, range.start) - range.start) * k;
        const h = (Math.min(p.end, range.end) - Math.max(p.start, range.start)) * k;
        let free = '';
        if (isDay) {
          const occ = [...s.blocks.filter((b) => b.date === d), ...busyForDay(s.busy, d)];
          let used = 0;
          for (const o of occ) used += Math.max(0, Math.min(o.end, p.end) - Math.max(o.start, p.start));
          const f = Math.max(0, p.end - p.start - used);
          free = f >= 15 ? `${fmtDuration(f)} free` : '';
        }
        const nm = isDay ? [p.label, free].filter(Boolean).join(' · ') : (p.label ? `· ${p.label}` : '');
        parts.push(`<div class="phase ${lv(p.level)}" style="top:${top}px;height:${h}px" title="${esc(LEVEL_INFO[p.level].name)} energy · ${esc(p.label || '')} · ${esc(T(p.start))}–${esc(T(p.end))}">
          ${h >= 20 ? `<div class="ph-label">${icon(LEVEL_ICON[p.level])}${LEVEL_INFO[p.level].name}${nm ? `<span class="nm">${esc(nm)}</span>` : ''}</div>` : ''}
        </div>`);
      }
    }
    // busy + blocks share lanes
    const busy = busyForDay(s.busy, d).map((b) => ({ kind: 'busy', start: b.start, end: b.end, b }));
    const bl = s.blocks.filter((b) => b.date === d).map((b) => ({ kind: 'block', start: b.start, end: b.end, b }));
    const all = [...busy, ...bl].filter((x) => x.end > range.start && x.start < range.end);
    const lanes = layoutLanes(all);
    const leftPad = 6, rightReserve = isDay ? 190 : 4;
    for (const it of all) {
      const { lane, lanes: L } = lanes.get(it);
      const top = (Math.max(it.start, range.start) - range.start) * k;
      const h = Math.max(16, (Math.min(it.end, range.end) - Math.max(it.start, range.start)) * k - 2);
      const pos = `top:${top}px;height:${h}px;left:calc((100% - ${leftPad + rightReserve}px) * ${lane / L} + ${leftPad + (it.kind === 'block' ? 2 : 0)}px);width:calc((100% - ${leftPad + rightReserve}px) / ${L} - 4px)`;
      if (it.kind === 'busy') {
        const b = it.b;
        parts.push(`<div class="busy" data-busy="${esc(b.id)}" data-date="${d}" style="${pos}" tabindex="0" role="button" aria-label="Busy: ${esc(b.title)}, ${esc(T(b.start))} to ${esc(T(b.end))}">
          <div class="bt">${esc(b.title || 'Busy')}</div>${h >= 30 ? `<div class="bm">${esc(T(b.start))} – ${esc(T(b.end))}${b.repeat ? ' · weekly' : ''}</div>` : ''}</div>`);
      } else {
        parts.push(blockHTML(s, it.b, pos, h, d, nk, nm));
      }
    }
    if (d === nk) {
      const hidden = nm < range.start || nm > range.end;
      parts.push(`<div class="now-line" style="top:${(nm - range.start) * k}px" ${hidden ? 'hidden' : ''}></div>`);
    }
    return `<div class="tg-col ${work ? '' : 'off'}" data-date="${d}" style="grid-row:1;grid-column:${ci + 2};height:${height}px" aria-label="${esc(fmtDayLong(d))}">${parts.join('')}</div>`;
  }).join('');

  tg.innerHTML = `${head}<div class="tg-scroll"><div class="tg-body" style="height:${height}px">
    <div class="tg-hours" style="height:${height}px">${hours.join('')}</div>
    <div class="tg-lines" style="grid-column:2 / -1;grid-row:1;position:relative;height:${height}px;pointer-events:none">${lines.join('')}</div>
    ${cols}
  </div></div>`;

  const sc = $('.tg-scroll', tg);
  const key = `${view.mode}:${days[0]}`;
  if (view.scrolledFor !== key) {
    view.scrolledFor = key;
    const target = days.includes(nk) && nm > range.start && nm < range.end ? nm - 60 : (normalizePhases(s.profile.phases)[0]?.start ?? range.start) - 30;
    sc.scrollTop = Math.max(0, (target - range.start) * k);
  } else if (prevScroll !== undefined) {
    sc.scrollTop = prevScroll;
  }
}

function blockHTML(s, b, pos, h, d, nk, nm) {
  const t = A.taskById(s, b.taskId);
  if (!t) return '';
  const done = !!t.doneAt;
  const phaseLevel = isWorkDay(d, s.settings) ? levelFor(s.profile.phases, b.start, b.end) : null;
  const mismatch = !done && phaseLevel && phaseLevel !== t.load && !(s.settings.flexibleMatch && LEVEL_RANK_OK(t.load, phaseLevel));
  const offMap = !done && !phaseLevel;
  const clash = !done && overlappingBusy(s.busy, b).length > 0;
  const dl = parseDeadline(t.deadline);
  const late = !done && dl && cmpKM(b.date, b.end, dl.key, dl.min) > 0;
  const missed = !done && blockEndsBefore(b, nk, nm);
  const warnings = [];
  if (mismatch) warnings.push(`${LEVEL_INFO[t.load].name} task in a ${LEVEL_INFO[phaseLevel].name} phase`);
  if (offMap) warnings.push('Outside your energy map');
  if (clash) warnings.push('Overlaps busy time');
  if (late) warnings.push('Ends after its deadline');
  if (missed) warnings.push('Not marked done');
  const compact = h < 38;
  const part = b.parts > 1 ? ` · part ${b.part}/${b.parts}` : '';
  const label = `${t.title}, ${T(b.start)} to ${T(b.end)}, ${LEVEL_INFO[t.load].name}${done ? ', done' : ''}${warnings.length ? '. ' + warnings.join('. ') : ''}`;
  return `<div class="block ${lv(t.load)} ${compact ? 'compact' : ''} ${done ? 'done' : ''} ${mismatch ? 'mismatch' : ''} ${view.selectBlock === b.id ? 'selected' : ''}"
    data-block="${esc(b.id)}" data-task="${esc(t.id)}" style="${pos}" tabindex="0" role="button" aria-label="${esc(label)}"
    title="${esc(t.title)}\n${esc(T(b.start))} – ${esc(T(b.end))} · ${fmtDuration(b.end - b.start)}${part}${warnings.length ? '\n⚠ ' + esc(warnings.join(' · ')) : ''}">
    <div class="bt"><span class="done-btn" data-act="toggle-done" data-task="${esc(t.id)}" aria-hidden="true" title="${done ? 'Mark not done' : 'Mark done'}">${icon('check')}</span>
      <span class="t">${esc(t.title)}</span>
      <span class="flags">${warnings.length ? `<span class="warn">${icon('alert')}</span>` : ''}${b.pinned ? `<span class="pin" title="Pinned — Auto-plan keeps it here">${icon('pin')}</span>` : ''}</span></div>
    <div class="bm">${esc(T(b.start))} – ${esc(T(b.end))}${compact ? '' : ` · ${fmtDuration(b.end - b.start)}${part}`}</div>
    ${done ? '' : '<div class="resize" data-resize aria-hidden="true"></div>'}
  </div>`;
}

const RANK = { peak: 3, steady: 2, low: 1 };
const LEVEL_RANK_OK = (taskLoad, phaseLevel) => RANK[phaseLevel] >= RANK[taskLoad];

// ───────────── events ─────────────
function onClick(e) {
  const a = e.target.closest('[data-act]');
  if (!a || !root.contains(a)) return;
  const act = a.dataset.act;
  const s = getState();
  switch (act) {
    case 'prev': setDay(addDays(view.day, view.mode === 'week' ? -7 : -1)); app.render(); break;
    case 'next': setDay(addDays(view.day, view.mode === 'week' ? 7 : 1)); app.render(); break;
    case 'today': setDay(todayKey()); app.render(); break;
    case 'mode': setMode(a.dataset.mode); A.setSetting('planMode', a.dataset.mode); break;
    case 'goto-day': setDay(a.dataset.day); setMode('day'); A.setSetting('planMode', 'day'); break;
    case 'undo': { const l = undo(); if (l) toast(`Undid: ${l}`, { iconName: 'undo', timeout: 2500 }); break; }
    case 'checkin': openCheckin(a); break;
    case 'export': openExport({ day: view.day, mode: view.mode }); break;
    case 'plan': runPlan('all'); break;
    case 'plan-menu':
      openMenu(a, [
        { label: 'Re-plan everything (keeps pinned)', icon: 'sparkles', shortcut: 'P', onClick: () => runPlan('all') },
        { label: 'Only place backlog tasks', icon: 'inbox', onClick: () => runPlan('backlog') },
        'sep',
        { label: `Clear ${view.mode === 'day' ? 'this day' : 'unpinned plan'}`, icon: 'trash', onClick: () => {
          const n = A.clearPlan({ dayKey: view.mode === 'day' ? view.day : null });
          toast(n ? `Moved ${n} block${n > 1 ? 's' : ''} back to the backlog.` : 'Nothing to clear.', { action: n ? 'Undo' : null, onAction: undoFn() });
        } },
      ]);
      break;
    case 'plan-backlog': runPlan('backlog'); break;
    case 'pick-load': draft.load = a.dataset.load; draft.manual.load = true; syncAddControls(); break;
    case 'pick-dur': draft.duration = +a.dataset.dur; draft.manual.duration = true; syncAddControls(); break;
    case 'toggle-more': draft.more = !draft.more; a.setAttribute('aria-expanded', String(draft.more)); $('#qa-more', root).hidden = !draft.more; break;
    case 'add-backlog': submitDraft(false); break;
    case 'add-schedule': submitDraft(true); break;
    case 'schedule-one': {
      e.stopPropagation();
      const t = A.taskById(s, a.dataset.task);
      if (!t) break;
      const r = A.scheduleTask(t.id);
      if (r && r.date) toast(`Scheduled “${t.title}” · ${fmtRelDay(r.date)} ${T(r.start)}`, { iconName: 'check', action: 'Show', onAction: () => { setDay(r.date); app.render(); } });
      else toast(`“${t.title}” stays in the backlog — ${r && r.unplaced ? r.unplaced.reason : 'no matching time found.'}`, { iconName: 'info', timeout: 7000 });
      break;
    }
    case 'task-done': {
      e.stopPropagation();
      completeTask(a.dataset.task);
      break;
    }
    case 'toggle-done': {
      e.stopPropagation();
      const t = A.taskById(s, a.dataset.task);
      if (!t) break;
      if (t.doneAt) { A.setDone(t.id, false); toast(`Reopened “${t.title}”.`, { action: 'Undo', onAction: undoFn(), timeout: 3000 }); }
      else completeTask(t.id);
      break;
    }
    case 'extend': {
      const b = s.blocks.find((x) => x.id === a.dataset.block);
      if (b) { const r = A.resizeBlock(b.id, b.end + 15); notifyBumps(r && r.bumped, 'Added 15 minutes.'); }
      break;
    }
    case 'fill-now': {
      const r = A.fillNow();
      if (r.task) toast(`Started “${r.task.title}” now.`, { iconName: 'play', action: 'Undo', onAction: undoFn() });
      else if (r.none === 'no-fit') toast(`No backlog task fits the ${fmtDuration(r.seg.end - r.seg.start)} of ${LEVEL_INFO[r.seg.level].name} time left. Add one with a shorter duration.`, { iconName: 'info', timeout: 6000 });
      else toast('No free time right now.', { iconName: 'info' });
      break;
    }
    default: break;
  }
}

export function completeTask(taskId) {
  const s = getState();
  const t = A.taskById(s, taskId);
  if (!t) return;
  A.setDone(taskId, true);
  const prompt = getState().settings.checkins;
  if (prompt) {
    const scale = document.createElement('div');
    scale.className = 'scale';
    scale.setAttribute('role', 'group');
    scale.setAttribute('aria-label', 'How is your energy now, 1 to 5');
    let tt;
    [1, 2, 3, 4, 5].forEach((n) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = String(n); b.title = ['Drained', 'Low', 'Okay', 'Good', 'Energized'][n - 1];
      b.addEventListener('click', () => { A.addCheckin(n); tt.close(); toast('Thanks — logged.', { iconName: 'battery', timeout: 1800 }); });
      scale.appendChild(b);
    });
    tt = toast(`<b>Done:</b> ${esc(t.title)}. Energy now?`, { html: true, iconName: 'check', extra: scale, action: 'Undo', onAction: undoFn(), timeout: 9000 });
  } else {
    toast(`Done: “${t.title}”`, { iconName: 'check', action: 'Undo', onAction: undoFn(), timeout: 4000 });
  }
}

function runPlan(kind) {
  const r = kind === 'backlog' ? A.planBacklogOnly() : A.planAll();
  showPlanResult(r, kind, (date) => { setDay(date); app.render(); });
}

function notifyBumps(bumped, fallbackMsg) {
  if (bumped && bumped.length) {
    toast(describeBumps(bumped, h12()), { html: true, iconName: 'alert', action: 'Undo', onAction: undoFn(), timeout: 8000 });
  } else if (fallbackMsg) {
    toast(fallbackMsg, { iconName: 'check', action: 'Undo', onAction: undoFn(), timeout: 3000 });
  }
}

function onContextMenu(e) {
  if (e.target.closest('input, textarea')) return;
  let at = { x: e.clientX, y: e.clientY };
  if (!e.clientX && !e.clientY && e.target.getBoundingClientRect) { const r = e.target.getBoundingClientRect(); at = { x: r.left + 12, y: r.top + 12 }; }
  const blockEl = e.target.closest('.block');
  const item = e.target.closest('.task-item');
  const busyEl = e.target.closest('.busy');
  const col = e.target.closest('.tg-col');
  if (blockEl) {
    const b = getState().blocks.find((x) => x.id === blockEl.dataset.block);
    if (b) { e.preventDefault(); openBlockMenu(blockEl, b, at); }
  } else if (item) {
    e.preventDefault();
    const t = A.taskById(getState(), item.dataset.task);
    if (!t) return;
    openMenu(at, [
      { header: t.title },
      { label: 'Edit task…', icon: 'edit', onClick: () => openTaskEditor(t.id) },
      { label: 'Schedule in next matching slot', icon: 'sparkles', onClick: () => item.querySelector('[data-act="schedule-one"]')?.click() },
      { label: 'Mark done', icon: 'check', onClick: () => completeTask(t.id) },
      'sep',
      { label: 'Delete task', icon: 'trash', danger: true, onClick: () => deleteWithUndo(t.id) },
    ]);
  } else if (busyEl) {
    e.preventDefault();
    openBusyMenu(busyEl, busyEl.dataset.busy, busyEl.dataset.date);
  } else if (col) {
    e.preventDefault();
    const minute = clamp(minuteAt(col, e.clientY), 0, DAY_MIN - 15);
    openSlotMenu(at, col.dataset.date, Math.floor(minute / 15) * 15);
  }
}

function onWheel(e) {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const s = getState();
  const z = clamp((s.settings.zoom || 1) * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.6, 2.4);
  A.setSetting('zoom', Math.round(z * 100) / 100);
}

function onKeyDown(e) {
  const blockEl = e.target.closest && e.target.closest('.block');
  const item = e.target.closest && e.target.closest('.task-item');
  if (item && (e.key === 'Enter' || e.key === ' ') && e.target === item) { e.preventDefault(); openTaskEditor(item.dataset.task); return; }
  if (item && e.key === 'Delete') { e.preventDefault(); deleteWithUndo(item.dataset.task); return; }
  const busyEl = e.target.closest && e.target.closest('.busy');
  if (busyEl && e.target === busyEl && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openBusyMenu(busyEl, busyEl.dataset.busy, busyEl.dataset.date); return; }
  if (!blockEl || e.target !== blockEl) return;
  const s = getState();
  const b = s.blocks.find((x) => x.id === blockEl.dataset.block);
  if (!b) return;
  const step = e.shiftKey ? 30 : SNAP;
  let handled = true;
  if (e.key === 'Enter' || e.key === ' ') openBlockMenu(blockEl, b);
  else if (e.key === 'ArrowUp') moveWithToast(b.id, b.date, b.start - step);
  else if (e.key === 'ArrowDown') moveWithToast(b.id, b.date, b.start + step);
  else if (e.key === 'ArrowLeft' && e.altKey) moveWithToast(b.id, addDays(b.date, -1), b.start);
  else if (e.key === 'ArrowRight' && e.altKey) moveWithToast(b.id, addDays(b.date, 1), b.start);
  else if (e.key === 'Delete' || e.key === 'Backspace') { A.unscheduleTask(b.taskId); toast('Moved to the backlog.', { action: 'Undo', onAction: undoFn() }); }
  else if (e.key.toLowerCase() === 'd') { const t = A.taskById(s, b.taskId); if (t && !t.doneAt) completeTask(t.id); }
  else handled = false;
  if (handled) { e.preventDefault(); e.stopPropagation(); }
}

function moveWithToast(blockId, date, start) {
  view.focusBlock = blockId;
  if (date !== view.day && view.mode === 'day') setDay(date);
  const r = A.moveBlock(blockId, date, start);
  if (r && r.bumped && r.bumped.length) notifyBumps(r.bumped);
}

function deleteWithUndo(taskId) {
  const t = A.taskById(getState(), taskId);
  if (!t) return;
  A.deleteTask(taskId);
  toast(`Deleted “${t.title}”.`, { iconName: 'trash', action: 'Undo', onAction: undoFn() });
}

function openBlockMenu(anchor, b, at = null) {
  const s = getState();
  const t = A.taskById(s, b.taskId);
  if (!t) return;
  view.selectBlock = b.id;
  $$('.block.selected', root).forEach((x) => x.classList.remove('selected'));
  anchor.classList.add('selected');
  openMenu(at || anchor, [
    { header: `${t.title} · ${T(b.start)}–${T(b.end)}` },
    { label: 'Edit task…', icon: 'edit', onClick: () => openTaskEditor(t.id) },
    { label: t.doneAt ? 'Mark not done' : 'Mark done', icon: 'check', shortcut: 'D', onClick: () => (t.doneAt ? A.setDone(t.id, false) : completeTask(t.id)) },
    { label: b.pinned ? 'Unpin (Auto-plan may move it)' : 'Pin here (Auto-plan keeps it)', icon: 'pin', onClick: () => A.togglePin(b.id) },
    { label: 'Move to backlog', icon: 'inbox', shortcut: 'Del', onClick: () => { A.unscheduleTask(t.id); toast('Moved to the backlog.', { action: 'Undo', onAction: undoFn() }); } },
    'sep',
    { label: 'Delete task', icon: 'trash', danger: true, onClick: () => deleteWithUndo(t.id) },
  ]);
}

function openBusyMenu(anchor, busyId, date) {
  const s = getState();
  const b = s.busy.find((x) => x.id === busyId);
  if (!b) return;
  const src = b.sourceId ? s.sources.find((x) => x.id === b.sourceId) : null;
  const items = [{ header: `${b.title} · ${T(b.start)}–${T(b.end)}` }];
  if (src) items.push({ header: `Imported from “${src.name}”` });
  if (!src) items.push({ label: 'Edit busy time…', icon: 'edit', onClick: () => openBusyEditor(b) });
  if (b.repeat) items.push({ label: 'Remove on this day only', icon: 'x', onClick: () => { A.deleteBusy(b.id, { onlyDate: date }); toast('Removed for this day.', { action: 'Undo', onAction: undoFn() }); } });
  items.push({ label: b.repeat ? 'Delete all repeats' : 'Delete busy time', icon: 'trash', danger: true, onClick: () => { A.deleteBusy(b.id); toast('Busy time deleted.', { action: 'Undo', onAction: undoFn() }); } });
  openMenu(anchor, items);
}

function openSlotMenu(at, date, minute) {
  openMenu(at, [
    { header: `${fmtRelDay(date)} · ${T(minute)}` },
    { label: `New task at ${T(minute)}…`, icon: 'plus', onClick: () => openTaskEditor(null, { scheduleAt: { date, start: minute } }) },
    { label: `Block busy time at ${T(minute)}…`, icon: 'busy', onClick: () => openBusyEditor({ date, start: minute, end: Math.min(DAY_MIN, minute + 60) }) },
  ]);
}

// ───────────── drag & drop ─────────────
let drag = null;
const lastBlockClick = { id: null, at: 0 };

function onPointerDown(e) {
  if (e.button !== 0 || !root) return;
  if (e.target.closest('button, input, textarea, select, a')) return;
  const blockEl = e.target.closest('.block');
  const itemEl = e.target.closest('.task-item');
  const busyEl = e.target.closest('.busy');
  const colEl = e.target.closest('.tg-col');
  if (blockEl) {
    const s = getState();
    const b = s.blocks.find((x) => x.id === blockEl.dataset.block);
    if (!b) return;
    const t = A.taskById(s, b.taskId);
    const resize = !!e.target.closest('[data-resize]');
    drag = { kind: resize ? 'resize' : 'block', b: { ...b }, t, el: blockEl, x0: e.clientX, y0: e.clientY, started: false };
    const colRect = blockEl.parentElement.getBoundingClientRect();
    const range = +$('#tg', root).dataset.start;
    drag.grab = (e.clientY - colRect.top) / ppm() + range - b.start;
  } else if (itemEl) {
    const t = A.taskById(getState(), itemEl.dataset.task);
    if (!t) return;
    drag = { kind: 'task', t, el: itemEl, x0: e.clientX, y0: e.clientY, started: false, grab: 0 };
  } else if (busyEl) {
    drag = { kind: 'busy-click', el: busyEl, x0: e.clientX, y0: e.clientY, started: false };
  } else if (colEl) {
    drag = { kind: 'slot-click', el: colEl, x0: e.clientX, y0: e.clientY, started: false };
  } else return;
  try { if (drag.kind !== 'slot-click' && drag.kind !== 'busy-click') e.target.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', cancelDrag);
  document.addEventListener('keydown', escDrag, true);
}

function escDrag(e) { if (e.key === 'Escape' && drag) { e.preventDefault(); cancelDrag(); } }

function onPointerMove(e) {
  if (!drag) return;
  if (!drag.started) {
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return;
    if (drag.kind === 'busy-click' || drag.kind === 'slot-click') { cancelDrag(); return; }
    drag.started = true;
    document.body.style.userSelect = 'none';
    closeMenu();
    if (drag.kind === 'block' || drag.kind === 'task') {
      drag.el.classList.add('dragging');
      const g = document.createElement('div');
      g.className = `drag-ghost ${lv(drag.t.load)}`;
      g.textContent = drag.t.title;
      document.body.appendChild(g);
      drag.ghost = g;
    }
  }
  e.preventDefault();
  if (drag.kind === 'resize') return updateResize(e);
  updateMove(e);
  autoScroll(e);
}

function minuteAt(colEl, clientY, grab = 0) {
  const r = colEl.getBoundingClientRect();
  const range = +$('#tg', root).dataset.start;
  return roundTo((clientY - r.top) / ppm() + range - grab, SNAP);
}

function updateMove(e) {
  const g = drag.ghost;
  if (g) { g.style.left = `${e.clientX + 12}px`; g.style.top = `${e.clientY + 10}px`; }
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const col = under && under.closest('.tg-col');
  const backlog = under && under.closest('#backlog');
  $('#backlog', root).classList.toggle('drop-target', !!(backlog && drag.kind === 'block'));
  let prev = $('.drop-preview', root);
  if (!col) { if (prev) prev.remove(); drag.target = backlog && drag.kind === 'block' ? { backlog: true } : null; return; }
  const len = drag.kind === 'block' ? drag.b.end - drag.b.start : drag.t.durationMins;
  let start = minuteAt(col, e.clientY, drag.kind === 'block' ? drag.grab : Math.min(15, len / 2));
  start = clamp(start, 0, DAY_MIN - len);
  drag.target = { date: col.dataset.date, start };
  const range = +$('#tg', root).dataset.start;
  if (!prev || prev.parentElement !== col) { if (prev) prev.remove(); prev = document.createElement('div'); prev.className = `drop-preview ${lv(drag.t.load)}`; col.appendChild(prev); }
  prev.style.top = `${(start - range) * ppm()}px`;
  prev.style.height = `${len * ppm()}px`;
  prev.textContent = `${T(start)} – ${T(start + len)}`;
}

function updateResize(e) {
  const col = drag.el.parentElement;
  const range = +$('#tg', root).dataset.start;
  const r = col.getBoundingClientRect();
  let end = roundTo((e.clientY - r.top) / ppm() + range, SNAP);
  end = clamp(end, drag.b.start + SNAP, DAY_MIN);
  drag.newEnd = end;
  drag.el.style.height = `${Math.max(16, (end - drag.b.start) * ppm() - 2)}px`;
  const bm = $('.bm', drag.el);
  if (bm) bm.textContent = `${T(drag.b.start)} – ${T(end)} · ${fmtDuration(end - drag.b.start)}`;
}

let scrollTimer = null;
function autoScroll(e) {
  const sc = $('.tg-scroll', root);
  if (!sc) return;
  const r = sc.getBoundingClientRect();
  clearInterval(scrollTimer);
  const edge = 40;
  let dy = 0;
  if (e.clientY < r.top + edge && e.clientY > r.top - 60) dy = -12;
  else if (e.clientY > r.bottom - edge && e.clientY < r.bottom + 60) dy = 12;
  if (dy) scrollTimer = setInterval(() => { sc.scrollTop += dy; }, 16);
}

function onPointerUp(e) {
  const d = drag;
  cleanupDrag();
  if (!d) return;
  if (!d.started) {
    if (d.kind === 'block') {
      const now = Date.now();
      if (lastBlockClick.id === d.b.id && now - lastBlockClick.at < 400) { closeMenu(); lastBlockClick.id = null; openTaskEditor(d.b.taskId); }
      else { lastBlockClick.id = d.b.id; lastBlockClick.at = now; openBlockMenu(d.el, d.b, { x: e.clientX, y: e.clientY }); }
    }
    else if (d.kind === 'task') openTaskEditor(d.t.id);
    else if (d.kind === 'busy-click') openBusyMenu(d.el, d.el.dataset.busy, d.el.dataset.date);
    else if (d.kind === 'slot-click') {
      if (e.target.closest('.block, .busy, .task-item')) return;
      const minute = clamp(minuteAt(d.el, e.clientY), 0, DAY_MIN - 15);
      openSlotMenu({ x: e.clientX, y: e.clientY }, d.el.dataset.date, Math.floor(minute / 15) * 15);
    }
    return;
  }
  if (d.kind === 'resize') {
    if (d.newEnd && d.newEnd !== d.b.end) {
      view.focusBlock = d.b.id;
      const r = A.resizeBlock(d.b.id, d.newEnd);
      notifyBumps(r && r.bumped, `Now ${fmtDuration(d.newEnd - d.b.start)}.`);
    } else update();
    return;
  }
  if (!d.target) { update(); return; }
  if (d.target.backlog) {
    A.unscheduleTask(d.b.taskId);
    toast(`“${d.t.title}” moved to the backlog.`, { iconName: 'inbox', action: 'Undo', onAction: undoFn() });
    return;
  }
  if (d.kind === 'block') {
    if (d.target.date === d.b.date && d.target.start === d.b.start) { update(); return; }
    view.focusBlock = d.b.id;
    const r = A.moveBlock(d.b.id, d.target.date, d.target.start);
    notifyBumps(r && r.bumped);
    warnPlacement(r && r.block);
  } else if (d.kind === 'task') {
    const r = A.scheduleAt(d.t.id, d.target.date, d.target.start);
    notifyBumps(r && r.bumped, `Scheduled “${d.t.title}” at ${T(d.target.start)}.`);
    warnPlacement(r && r.block);
  }
}

function warnPlacement(b) {
  if (!b) return;
  const s = getState();
  const t = A.taskById(s, b.taskId);
  if (!t || !isWorkDay(b.date, s.settings)) return;
  const lvl = levelFor(s.profile.phases, b.start, b.end);
  if (lvl && lvl !== t.load && !(s.settings.flexibleMatch && LEVEL_RANK_OK(t.load, lvl))) {
    toast(`Heads-up: “${t.title}” needs ${LEVEL_INFO[t.load].name} energy but sits in a ${LEVEL_INFO[lvl].name} phase.`, { iconName: 'info', timeout: 5000 });
  }
}

function cleanupDrag() {
  clearInterval(scrollTimer);
  document.removeEventListener('pointermove', onPointerMove);
  document.removeEventListener('pointerup', onPointerUp);
  document.removeEventListener('pointercancel', cancelDrag);
  document.removeEventListener('keydown', escDrag, true);
  document.body.style.userSelect = '';
  if (drag) {
    if (drag.ghost) drag.ghost.remove();
    if (drag.el) drag.el.classList.remove('dragging');
  }
  if (root) {
    $('.drop-preview', root)?.remove();
    $('#backlog', root)?.classList.remove('drop-target');
  }
  const d = drag;
  drag = null;
  return d;
}

function cancelDrag() {
  const d = cleanupDrag();
  if (d && d.kind === 'resize' && d.started) update();
}

export function focusQuickAdd() {
  const qa = root && $('#qa', root);
  if (qa) { qa.focus(); qa.select(); }
}

// silence unused-import linters for helpers used conditionally
void blockStartsAfter; void weekday;
