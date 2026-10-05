// EnergyMap — domain actions (all state changes go through commit() so they can be undone).

import { getState, commit, uid, presetPhases } from './state.js';
import {
  planTasks, replanInputs, overlapping, blockEndsBefore, blockStartsAfter, taskStatus, freeSegments,
  taskComparator, FALLBACK, normalizePhases, LEVELS, busyForDay, phaseAt,
} from './scheduler.js';
import { todayKey, minutesOf, addDays, clamp, roundUp, DAY_MIN, weekday, makeDeadline, toDate } from './time.js';
import { instancesToBusy } from './ics.js';

const now = () => new Date();
const byStart = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.start - b.start);

// ───────────── selectors ─────────────
export const taskById = (s, id) => s.tasks.find((t) => t.id === id);
export const blocksOf = (s, taskId) => s.blocks.filter((b) => b.taskId === taskId).sort(byStart);
export const statusOf = (s, t, n = now()) => taskStatus(t, s.blocks, n);
export const openTasks = (s) => s.tasks.filter((t) => !t.doneAt);
export const backlogTasks = (s, n = now()) => s.tasks.filter((t) => statusOf(s, t, n) === 'backlog');
export const missedTasks = (s, n = now()) => s.tasks.filter((t) => statusOf(s, t, n) === 'missed');
const ctx = (s) => ({ phases: s.profile.phases, busy: s.busy, settings: s.settings });

/** Dry run: which backlog tasks can't be placed right now, and why. */
export function backlogReasons(s, n = now()) {
  const tasks = [...backlogTasks(s, n), ...missedTasks(s, n)];
  if (!tasks.length) return new Map();
  const ids = new Set(tasks.map((t) => t.id));
  const r = planTasks({ tasks, blocks: s.blocks.filter((b) => !ids.has(b.taskId)), ...ctx(s), now: n });
  const out = new Map();
  for (const u of r.unplaced) out.set(u.taskId, u);
  for (const p of r.placements) if (!out.has(p.taskId)) out.set(p.taskId, { fits: { date: p.date, start: p.start } });
  return out;
}

function newBlock(p, pinned = false) {
  return { id: uid('b'), taskId: p.taskId, date: p.date, start: p.start, end: p.end, pinned, part: p.part || 1, parts: p.parts || 1 };
}

function cleanTaskFields(f) {
  const out = {};
  if ('title' in f) out.title = String(f.title || '').trim().slice(0, 300) || 'Untitled task';
  if ('notes' in f) out.notes = String(f.notes || '').slice(0, 5000);
  if ('load' in f && LEVELS.includes(f.load)) out.load = f.load;
  if ('durationMins' in f) out.durationMins = clamp(Math.round((+f.durationMins || 60) / 5) * 5, 5, 720);
  if ('deadline' in f) out.deadline = f.deadline || null;
  if ('priority' in f) out.priority = f.priority === 'high' ? 'high' : 'normal';
  if ('splittable' in f) out.splittable = !!f.splittable;
  return out;
}

// ───────────── conflict resolution (port of resolveCalendarConflicts) ─────────────
// A block was moved/resized/created by hand: every other not-yet-started block it overlaps is
// displaced. Displaced tasks go back to the backlog, then (optionally) get the next free matching slot.
function resolveOverlaps(s, moved) {
  const n = now(), nk = todayKey(n), nm = minutesOf(n);
  const victims = overlapping(s.blocks, moved, moved.taskId).filter((b) => {
    const t = taskById(s, b.taskId);
    return t && !t.doneAt && blockStartsAfter(b, nk, nm);
  });
  if (!victims.length) return [];
  const ids = [...new Set(victims.map((b) => b.taskId))];
  s.blocks = s.blocks.filter((b) => !(ids.includes(b.taskId) && blockStartsAfter(b, nk, nm)));
  const out = ids.map((id) => ({ taskId: id, title: taskById(s, id).title, to: null }));
  if (s.settings.bumpMode === 'reschedule') {
    // only the minutes the task still needs (parts that already started stay where they are)
    const tasks = ids.map((id) => {
      const t = taskById(s, id);
      const kept = s.blocks.filter((b) => b.taskId === id).reduce((m, b) => m + (b.end - b.start), 0);
      return { ...t, durationMins: Math.max(0, t.durationMins - kept) };
    }).filter((t) => t.durationMins >= 5);
    const r = planTasks({ tasks, blocks: s.blocks, ...ctx(s), now: n });
    for (const p of r.placements) s.blocks.push(newBlock(p));
    for (const o of out) {
      const p = r.placements.find((pp) => pp.taskId === o.taskId);
      if (p) o.to = { date: p.date, start: p.start };
    }
  }
  return out;
}

// ───────────── tasks ─────────────
export function addTask(fields, { autoSchedule = false } = {}) {
  return commit(autoSchedule ? 'Add & schedule' : 'Add task', (s) => {
    const t = {
      id: uid('t'), title: 'Untitled task', notes: '', load: s.settings.defaultLoad || 'peak',
      durationMins: s.settings.defaultDuration || 60, deadline: null, priority: 'normal', splittable: false,
      doneAt: null, createdAt: new Date().toISOString(), ...cleanTaskFields(fields),
    };
    s.tasks.push(t);
    if (!autoSchedule) return { task: t };
    const r = planTasks({ tasks: [t], blocks: s.blocks, ...ctx(s), now: now() });
    for (const p of r.placements) s.blocks.push(newBlock(p));
    return { task: t, placements: r.placements, unplaced: r.unplaced[0] || null };
  });
}

/** New task placed at a chosen time (one undo step). */
export function addTaskAt(fields, date, start) {
  return commit('Add task here', (s) => {
    const t = {
      id: uid('t'), title: 'Untitled task', notes: '', load: s.settings.defaultLoad || 'peak',
      durationMins: s.settings.defaultDuration || 60, deadline: null, priority: 'normal', splittable: false,
      doneAt: null, createdAt: new Date().toISOString(), ...cleanTaskFields(fields),
    };
    s.tasks.push(t);
    const len = clamp(t.durationMins, 5, DAY_MIN);
    const st = clamp(Math.round(start), 0, DAY_MIN - len);
    const b = { id: uid('b'), taskId: t.id, date, start: st, end: st + len, pinned: true, part: 1, parts: 1 };
    s.blocks.push(b);
    return { task: t, block: { ...b }, bumped: resolveOverlaps(s, b) };
  });
}

export function updateTask(id, fields) {
  return commit('Edit task', (s) => {
    const t = taskById(s, id);
    if (!t) return null;
    const clean = cleanTaskFields(fields);
    const durChanged = clean.durationMins !== undefined && clean.durationMins !== t.durationMins;
    Object.assign(t, clean);
    let note = null;
    if (durChanged && !t.doneAt) {
      const own = blocksOf(s, id);
      const n = now();
      if (own.length === 1 && blockStartsAfter(own[0], todayKey(n), minutesOf(n))) {
        own[0].end = Math.min(DAY_MIN, own[0].start + t.durationMins);
        const bumped = resolveOverlaps(s, own[0]);
        if (bumped.length) note = { bumped };
      } else if (own.length > 1) {
        s.blocks = s.blocks.filter((b) => b.taskId !== id);
        note = { unscheduled: true };
      }
    }
    return { task: t, note };
  });
}

export function deleteTask(id) {
  return commit('Delete task', (s) => {
    const t = taskById(s, id);
    s.tasks = s.tasks.filter((x) => x.id !== id);
    s.blocks = s.blocks.filter((b) => b.taskId !== id);
    return t;
  });
}

export function setDone(id, done = true) {
  return commit(done ? 'Complete task' : 'Reopen task', (s) => {
    const t = taskById(s, id);
    if (!t) return null;
    if (done) {
      const n = now(), nk = todayKey(n), nm = minutesOf(n);
      t.doneAt = n.toISOString();
      // free the time this task no longer needs
      s.blocks = s.blocks.filter((b) => b.taskId !== id || !blockStartsAfter(b, nk, nm));
      for (const b of s.blocks) {
        if (b.taskId === id && b.date === nk && b.start < nm && b.end > nm) b.end = Math.max(b.start + 5, roundUp(nm, 5));
      }
    } else {
      t.doneAt = null;
    }
    return t;
  });
}

export function clearCompleted() {
  return commit('Clear completed', (s) => {
    const done = new Set(s.tasks.filter((t) => t.doneAt).map((t) => t.id));
    s.tasks = s.tasks.filter((t) => !done.has(t.id));
    s.blocks = s.blocks.filter((b) => !done.has(b.taskId));
    return done.size;
  });
}

export function unscheduleTask(taskId) {
  return commit('Move to backlog', (s) => {
    s.blocks = s.blocks.filter((b) => b.taskId !== taskId);
  });
}

// ───────────── planning ─────────────
/** Re-plan: keeps pinned / started / done blocks; places everything else by energy. */
export function planAll() {
  return commit('Auto-plan', (s) => {
    const n = now();
    const { keep, toPlace } = replanInputs(s.tasks, s.blocks, n);
    const r = planTasks({ tasks: toPlace, blocks: keep, ...ctx(s), now: n });
    s.blocks = [...keep, ...r.placements.map((p) => newBlock(p))];
    return { placed: new Set(r.placements.map((p) => p.taskId)).size, unplaced: r.unplaced, considered: toPlace.length };
  });
}

/** Gentle plan: only backlog/missed tasks are placed; the current plan stays as it is. */
export function planBacklogOnly() {
  return commit('Plan backlog', (s) => {
    const n = now();
    const tasks = s.tasks.filter((t) => ['backlog', 'missed'].includes(taskStatus(t, s.blocks, n)));
    const ids = new Set(tasks.map((t) => t.id));
    s.blocks = s.blocks.filter((b) => !ids.has(b.taskId));
    const r = planTasks({ tasks, blocks: s.blocks, ...ctx(s), now: n });
    for (const p of r.placements) s.blocks.push(newBlock(p));
    return { placed: new Set(r.placements.map((p) => p.taskId)).size, unplaced: r.unplaced, considered: tasks.length };
  });
}

export function clearPlan({ dayKey = null } = {}) {
  return commit(dayKey ? 'Clear day' : 'Clear plan', (s) => {
    const n = now(), nk = todayKey(n), nm = minutesOf(n);
    const before = s.blocks.length;
    s.blocks = s.blocks.filter((b) => {
      const t = taskById(s, b.taskId);
      if (!t || t.doneAt) return true;
      if (!blockStartsAfter(b, nk, nm)) return true;
      if (dayKey && b.date !== dayKey) return true;
      return false;
    });
    return before - s.blocks.length;
  });
}

export function moveBlock(blockId, date, start) {
  return commit('Move task', (s) => {
    const b = s.blocks.find((x) => x.id === blockId);
    if (!b) return null;
    const len = b.end - b.start;
    b.date = date;
    b.start = clamp(Math.round(start), 0, DAY_MIN - len);
    b.end = b.start + len;
    b.pinned = true;
    return { block: { ...b }, bumped: resolveOverlaps(s, b) };
  });
}

export function resizeBlock(blockId, end) {
  return commit('Change length', (s) => {
    const b = s.blocks.find((x) => x.id === blockId);
    if (!b) return null;
    b.end = clamp(Math.round(end), b.start + 5, DAY_MIN);
    b.pinned = true;
    const t = taskById(s, b.taskId);
    if (t) t.durationMins = clamp(blocksOf(s, t.id).reduce((m, x) => m + (x.end - x.start), 0), 5, 720);
    return { block: { ...b }, bumped: resolveOverlaps(s, b) };
  });
}

export function scheduleAt(taskId, date, start) {
  return commit('Schedule task', (s) => {
    const t = taskById(s, taskId);
    if (!t) return null;
    s.blocks = s.blocks.filter((b) => b.taskId !== taskId);
    const len = clamp(t.durationMins, 5, DAY_MIN);
    const st = clamp(Math.round(start), 0, DAY_MIN - len);
    const b = { id: uid('b'), taskId, date, start: st, end: st + len, pinned: true, part: 1, parts: 1 };
    s.blocks.push(b);
    if (t.doneAt) t.doneAt = null;
    return { block: { ...b }, bumped: resolveOverlaps(s, b) };
  });
}

/** Place one task (backlog or missed) in its earliest matching slot without moving anything else. */
export function scheduleTask(taskId) {
  return commit('Schedule task', (s) => {
    const t = taskById(s, taskId);
    if (!t) return null;
    s.blocks = s.blocks.filter((b) => b.taskId !== taskId);
    if (t.doneAt) t.doneAt = null;
    const r = planTasks({ tasks: [t], blocks: s.blocks, ...ctx(s), now: now() });
    for (const p of r.placements) s.blocks.push(newBlock(p));
    if (r.placements.length) return { date: r.placements[0].date, start: r.placements[0].start, parts: r.placements.length };
    return { unplaced: r.unplaced[0] || null };
  });
}

export function togglePin(blockId) {
  return commit('Pin', (s) => {
    const b = s.blocks.find((x) => x.id === blockId);
    if (!b) return null;
    const v = !b.pinned;
    for (const x of s.blocks) if (x.taskId === b.taskId) x.pinned = v;
    return v;
  });
}

/** Put the best-fitting backlog task into the free time that starts now. */
export function fillNow() {
  const s = getState();
  const n = now(), nk = todayKey(n), nm = minutesOf(n);
  const segs = freeSegments({ days: [nk], phases: s.profile.phases, blocks: s.blocks.filter((b) => {
    const t = taskById(s, b.taskId); return t && (!t.doneAt || !blockEndsBefore(b, nk, nm));
  }), busy: s.busy, bufferMins: 0, now: n });
  const seg = segs[0];
  if (!seg || seg.start > roundUp(nm, 5) + 10) return { none: 'no-free' };
  const len = seg.end - seg.start;
  const fits = [...backlogTasks(s, n), ...missedTasks(s, n)].filter((t) =>
    (t.load === seg.level || (s.settings.flexibleMatch && (FALLBACK[t.load] || []).includes(seg.level))) && t.durationMins <= len);
  if (!fits.length) return { none: 'no-fit', seg };
  fits.sort(taskComparator(addDays(nk, s.settings.horizonDays - 1)));
  const best = fits[0];
  return commit('Start now', (st) => {
    st.blocks = st.blocks.filter((b) => b.taskId !== best.id);
    st.blocks.push({ id: uid('b'), taskId: best.id, date: nk, start: seg.start, end: seg.start + best.durationMins, pinned: true, part: 1, parts: 1 });
    return { task: best };
  });
}

// ───────────── busy time ─────────────
export function saveBusy(item) {
  return commit(item.id ? 'Edit busy time' : 'Add busy time', (s) => {
    const clean = {
      id: item.id || uid('bz'), title: String(item.title || 'Busy').slice(0, 200), date: item.date,
      start: clamp(Math.round(item.start), 0, DAY_MIN - 5), end: clamp(Math.round(item.end), 5, DAY_MIN),
      repeat: item.repeat && item.repeat.days && item.repeat.days.length ? { days: [...item.repeat.days].sort(), until: item.repeat.until || null } : null,
      sourceId: item.sourceId || null,
    };
    const i = s.busy.findIndex((b) => b.id === clean.id);
    if (i >= 0) {
      const prevExcept = s.busy[i].repeat && Array.isArray(s.busy[i].repeat.except) ? s.busy[i].repeat.except : [];
      if (clean.repeat && prevExcept.length) clean.repeat.except = prevExcept;
      s.busy[i] = { ...s.busy[i], ...clean };
    } else s.busy.push(clean);
    return clean;
  });
}

export function deleteBusy(id, { onlyDate = null } = {}) {
  return commit('Delete busy time', (s) => {
    const b = s.busy.find((x) => x.id === id);
    if (!b) return;
    if (onlyDate && b.repeat) {
      b.repeat.except = [...(b.repeat.except || []), onlyDate];
    } else {
      s.busy = s.busy.filter((x) => x.id !== id);
    }
  });
}

export function importCalendar({ name, fileName, instances, sourceId = null, until = null }) {
  return commit('Import calendar', (s) => {
    let src = sourceId ? s.sources.find((x) => x.id === sourceId) : null;
    if (!src) { src = { id: uid('src'), name, fileName, importedAt: null, count: 0 }; s.sources.push(src); }
    src.name = name || src.name;
    src.fileName = fileName || src.fileName;
    src.importedAt = new Date().toISOString();
    src.until = until;
    s.busy = s.busy.filter((b) => b.sourceId !== src.id);
    const items = instancesToBusy(instances, { sourceId: src.id });
    s.busy.push(...items);
    src.count = items.length;
    return { source: { ...src }, count: items.length };
  });
}

export function removeSource(id) {
  return commit('Remove calendar', (s) => {
    s.sources = s.sources.filter((x) => x.id !== id);
    s.busy = s.busy.filter((b) => b.sourceId !== id);
  });
}

// ───────────── energy profile ─────────────
export function applyPreset(key) {
  return commit('Apply energy preset', (s) => { s.profile = { preset: key, phases: presetPhases(key) }; });
}

export function setPhases(phases, label = 'Edit energy map', preset = 'custom') {
  return commit(label, (s) => {
    s.profile.phases = phases.map((p) => ({ id: p.id || uid('p'), label: p.label || '', start: p.start, end: p.end, level: p.level }));
    s.profile.preset = preset;
  });
}

export function shiftPhases(delta) {
  const s = getState();
  const ph = s.profile.phases;
  if (!ph.length) return false;
  const min = Math.min(...ph.map((p) => p.start)), max = Math.max(...ph.map((p) => p.end));
  if (min + delta < 0 || max + delta > DAY_MIN) return false;
  commit(delta < 0 ? 'Shift day earlier' : 'Shift day later', (st) => {
    st.profile.phases = st.profile.phases.map((p) => ({ ...p, start: p.start + delta, end: p.end + delta }));
    st.profile.preset = 'custom';
  });
  return true;
}

/** Set the energy level of [start,end) — used by "learn from check-ins" suggestions. */
export function setLevelRange(start, end, level) {
  return commit('Adjust energy map', (s) => {
    const out = [];
    let label = '';
    for (const p of normalizePhases(s.profile.phases)) {
      if (p.end <= start || p.start >= end) { out.push(p); continue; }
      if (!label) label = p.label;
      if (p.start < start) out.push({ ...p, id: uid('p'), end: start });
      if (p.end > end) out.push({ ...p, id: uid('p'), start: end });
    }
    out.push({ id: uid('p'), start, end, level, label: label || 'Adjusted' });
    s.profile.phases = normalizePhases(out);
    s.profile.preset = 'custom';
  });
}

// ───────────── misc ─────────────
export function addCheckin(level) {
  return commit('Energy check-in', (s) => {
    s.checkins.push({ id: uid('c'), at: new Date().toISOString(), level: clamp(Math.round(level), 1, 5) });
    if (s.checkins.length > 5000) s.checkins.splice(0, s.checkins.length - 5000);
  });
}

export function setSetting(key, value, { undoable = false } = {}) {
  return commit('Change setting', (s) => { s.settings[key] = value; }, { undoable });
}

export function setSettings(obj, label = 'Change settings') {
  return commit(label, (s) => { Object.assign(s.settings, obj); });
}

// ───────────── sample data ─────────────
export function loadSample() {
  return commit('Load sample data', (s) => {
    const n = now(), nk = todayKey(n);
    const ws = s.settings.workDays.length ? s.settings.workDays : [1, 2, 3, 4, 5];
    const nextWork = (k, step = 1) => { let d = k; for (let i = 0; i < 14; i++) { d = addDays(d, step); if (ws.includes(weekday(d))) return d; } return d; };
    const firstWork = ws.includes(weekday(nk)) ? nk : nextWork(nk);
    const in2 = nextWork(nextWork(firstWork));
    const mk = (title, load, durationMins, extra = {}) => ({
      id: uid('t'), title, notes: '', load, durationMins, deadline: null, priority: 'normal', splittable: false,
      doneAt: null, createdAt: new Date(n.getTime() - 3600e3).toISOString(), sample: true, ...extra,
    });
    const tasks = [
      mk('Write Q3 strategy report', 'peak', 90, { deadline: makeDeadline(in2, 17 * 60), priority: 'high', notes: 'Pull numbers from the finance dashboard first.' }),
      mk('Analyze customer survey results', 'peak', 75),
      mk('Draft product roadmap', 'peak', 120, { splittable: true }),
      mk('Code review: billing module', 'steady', 45),
      mk('Prepare client presentation', 'steady', 60, { deadline: makeDeadline(nextWork(firstWork)) }),
      mk('1:1 prep with Sara', 'steady', 20),
      mk('Plan next sprint', 'steady', 40),
      mk('Reply to client emails', 'low', 30),
      mk('Submit expense report', 'low', 20),
      mk('Update CRM records', 'low', 25),
      mk('Book team offsite venue', 'low', 15),
    ];
    s.tasks.push(...tasks);
    // a weekly team meeting on work days 1 and 3 of the week (as busy time)
    s.busy.push({ id: uid('bz'), title: 'Team stand-up', date: addDays(nk, -7), start: 9 * 60, end: 9 * 60 + 15, repeat: { days: ws.slice(0, 5), until: null }, sample: true });
    s.busy.push({ id: uid('bz'), title: 'Lunch', date: addDays(nk, -7), start: 12 * 60 + 45, end: 13 * 60 + 30, repeat: { days: ws.slice(0, 5), until: null }, sample: true });
    // history: completed work on the previous work days + energy check-ins
    const hist = [
      ['Literature review', 'peak', 90, 9 * 60], ['Budget forecast', 'peak', 60, 10 * 60 + 35], ['Design review', 'steady', 45, 12 * 60],
      ['Inbox zero', 'low', 30, 13 * 60 + 35], ['Hiring loop feedback', 'steady', 40, 15 * 60], ['Invoices', 'low', 25, 16 * 60 + 35],
    ];
    let d = nk;
    for (let k = 0; k < 6; k++) {
      d = nextWork(d, -1);
      hist.forEach(([title, load, dur, start0], i) => {
        if ((k + i) % 4 === 3) return; // not every task every day
        // now and then deep work slips into the afternoon dip (shows up in Insights)
        const start = title === 'Budget forecast' && k % 3 === 1 ? 14 * 60 + 15 : start0;
        const t = mk(title, load, dur, { doneAt: toDate(d, start + dur).toISOString() });
        s.tasks.push(t);
        s.blocks.push({ id: uid('b'), taskId: t.id, date: d, start, end: start + dur, pinned: false, part: 1, parts: 1 });
      });
      const curve = { 9: 4, 10: 5, 11: 4, 12: 3, 13: 2, 14: 2, 15: 4, 16: 3, 17: 2 };
      for (const [h, lv] of Object.entries(curve)) {
        if ((+h + k) % 3 === 0) continue;
        const jitter = ((+h * 7 + k * 3) % 3) - 1;
        const at = toDate(d, +h * 60 + 10);
        s.checkins.push({ id: uid('c'), at: at.toISOString(), level: clamp(lv + (jitter > 0 && lv < 5 && +h === 14 ? 1 : 0), 1, 5), sample: true });
      }
    }
    // plan the open sample tasks
    const r = planTasks({ tasks, blocks: s.blocks, ...ctx(s), now: n });
    for (const p of r.placements) s.blocks.push(newBlock(p));
    return { tasks: tasks.length, placed: new Set(r.placements.map((p) => p.taskId)).size };
  });
}

export function removeSample() {
  return commit('Remove sample data', (s) => {
    const ids = new Set(s.tasks.filter((t) => t.sample).map((t) => t.id));
    s.tasks = s.tasks.filter((t) => !t.sample);
    s.blocks = s.blocks.filter((b) => !ids.has(b.taskId));
    s.busy = s.busy.filter((b) => !b.sample);
    s.checkins = s.checkins.filter((c) => !c.sample);
    return ids.size;
  });
}

export const hasSample = (s) => s.tasks.some((t) => t.sample) || s.busy.some((b) => b.sample);

// re-export for views
export { busyForDay, phaseAt };
