// EnergyMap — scheduling engine (pure functions, no DOM).
// Port and extension of the energy-matching algorithm:
//   * tasks are matched to energy phases of the same level (Peak / Steady / Low)
//   * earliest deadline first, then priority, then longest first (first-fit decreasing)
//   * a buffer break is kept after every task and around busy time
//   * optional splitting of long tasks across several blocks
//   * optional "flexible" pass: lighter tasks may borrow stronger energy (never the reverse)
//   * overlap resolution when the user moves a block (bumped tasks go to the backlog or a new slot)

import {
  addDays, todayKey, minutesOf, weekday, roundUp, parseDeadline, cmpKM, DAY_MIN, clamp, fmtDuration,
} from './time.js';

export const LEVELS = ['peak', 'steady', 'low'];
export const LEVEL_RANK = { peak: 3, steady: 2, low: 1 };
export const LEVEL_INFO = {
  peak: { name: 'Peak', hint: 'Deep work', desc: 'Deep work — writing, analysis, problem-solving, learning' },
  steady: { name: 'Steady', hint: 'Routine', desc: 'Routine work — reviews, planning, calls, follow-ups' },
  low: { name: 'Low', hint: 'Admin', desc: 'Light work — email, admin, errands, filing' },
};
/** Lighter tasks may use stronger energy when "flexible matching" is on (never the reverse). */
export const FALLBACK = { low: ['steady', 'peak'], steady: ['peak'], peak: [] };

const ph = (h1, m1, h2, m2, level, label) => ({ start: h1 * 60 + m1, end: h2 * 60 + m2, level, label });

export const PRESETS = {
  lark: {
    name: 'Early bird',
    desc: 'Sharpest soon after waking; energy fades by late afternoon.',
    phases: [
      ph(7, 0, 8, 0, 'steady', 'Warm-up'),
      ph(8, 0, 9, 30, 'peak', 'Morning peak'),
      ph(9, 30, 11, 0, 'peak', 'Deep focus'),
      ph(11, 0, 12, 30, 'steady', 'Late-morning routine'),
      ph(13, 0, 14, 30, 'low', 'Post-lunch dip'),
      ph(14, 30, 16, 0, 'steady', 'Afternoon rebound'),
      ph(16, 0, 17, 0, 'low', 'Wind-down admin'),
    ],
  },
  typical: {
    name: 'In-between',
    desc: 'Peak late morning, a dip after lunch, a second wind mid-afternoon.',
    phases: [
      ph(9, 0, 10, 30, 'peak', 'Morning peak'),
      ph(10, 30, 12, 0, 'peak', 'Deep focus'),
      ph(12, 0, 13, 30, 'steady', 'Pre-lunch wrap'),
      ph(13, 30, 15, 0, 'low', 'Post-lunch dip'),
      ph(15, 0, 16, 30, 'steady', 'Afternoon rebound'),
      ph(16, 30, 18, 0, 'low', 'End-of-day admin'),
    ],
  },
  owl: {
    name: 'Night owl',
    desc: 'Slow mornings; strongest from late afternoon into the evening.',
    phases: [
      ph(10, 0, 11, 30, 'steady', 'Morning warm-up'),
      ph(11, 30, 13, 0, 'steady', 'Routine block'),
      ph(14, 0, 15, 30, 'low', 'Afternoon dip'),
      ph(15, 30, 17, 0, 'steady', 'Rebound'),
      ph(17, 0, 18, 30, 'peak', 'Evening peak'),
      ph(18, 30, 20, 0, 'peak', 'Night focus'),
    ],
  },
};

// ───────────────────────── phases ─────────────────────────

/** Valid phases, sorted; overlaps are resolved (an earlier phase keeps its time, a later one is trimmed). */
export function normalizePhases(phases = []) {
  const sorted = phases
    .filter((p) => p && Number.isFinite(p.start) && Number.isFinite(p.end) && LEVELS.includes(p.level))
    .map((p) => ({ ...p, start: clamp(Math.round(p.start), 0, DAY_MIN), end: clamp(Math.round(p.end), 0, DAY_MIN) }))
    .filter((p) => p.end > p.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  let lastEnd = -1;
  for (const p of sorted) {
    const start = Math.max(p.start, lastEnd);
    if (p.end <= start) continue;
    out.push(start === p.start ? p : { ...p, start });
    lastEnd = Math.max(lastEnd, p.end);
  }
  return out;
}

/** Problems with a phase list: [{index, message}] (indexes refer to the sorted list). */
export function validatePhases(phases = []) {
  const problems = [];
  phases.forEach((p, i) => {
    if (!(p.end > p.start)) problems.push({ index: i, message: 'Ends before it starts' });
  });
  const sorted = phases.map((p, i) => ({ ...p, i })).filter((p) => p.end > p.start).sort((a, b) => a.start - b.start);
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k].start < sorted[k - 1].end) problems.push({ index: sorted[k].i, message: 'Overlaps the phase before it' });
  }
  return problems;
}

/** Contiguous same-level phases merged into windows. */
export function mergedWindows(phases) {
  const merged = [];
  for (const p of normalizePhases(phases)) {
    const last = merged[merged.length - 1];
    if (last && last.level === p.level && p.start <= last.end) last.end = Math.max(last.end, p.end);
    else merged.push({ start: p.start, end: p.end, level: p.level });
  }
  return merged;
}

export function phaseAt(phases, min) {
  return normalizePhases(phases).find((p) => p.start <= min && min < p.end) || null;
}

export function levelAt(phases, min) {
  const p = phaseAt(phases, min);
  return p ? p.level : null;
}

/** Dominant level for an interval (level covering most of it), or null. */
export function levelFor(phases, start, end) {
  const cover = { peak: 0, steady: 0, low: 0 };
  for (const p of normalizePhases(phases)) {
    const o = Math.min(end, p.end) - Math.max(start, p.start);
    if (o > 0) cover[p.level] += o;
  }
  let best = null, bestV = 0;
  for (const l of LEVELS) if (cover[l] > bestV) { best = l; bestV = cover[l]; }
  return best;
}

export function minutesByLevel(phases) {
  const out = { peak: 0, steady: 0, low: 0 };
  for (const p of normalizePhases(phases)) out[p.level] += p.end - p.start;
  return out;
}

export function isWorkDay(key, settings) {
  return (settings.workDays || []).includes(weekday(key));
}

// ───────────────────────── busy time ─────────────────────────

/** Busy items that apply to a day: one-off items on that date + weekly repeating items. */
export function busyForDay(busy = [], key) {
  const wd = weekday(key);
  const out = [];
  for (const b of busy) {
    if (!b || !(b.end > b.start)) continue;
    if (b.repeat && Array.isArray(b.repeat.days)) {
      if (!b.repeat.days.includes(wd)) continue;
      if (b.date && key < b.date) continue;
      if (b.repeat.until && key > b.repeat.until) continue;
      if (Array.isArray(b.repeat.except) && b.repeat.except.includes(key)) continue;
    } else if (b.date !== key) continue;
    out.push(b);
  }
  return out.sort((a, b) => a.start - b.start);
}

// ───────────────────────── free time ─────────────────────────

export function planningDays(now, settings) {
  const start = todayKey(now);
  const days = [];
  const n = clamp(settings.horizonDays || 7, 1, 60);
  for (let i = 0; i < n; i++) {
    const k = addDays(start, i);
    if (isWorkDay(k, settings)) days.push(k);
  }
  return days;
}

/** Windows (merged phases) of a day; today's windows start at "now" (rounded up). */
export function dayWindows(key, phases, { nowKey = null, nowMin = 0, step = 5 } = {}) {
  if (nowKey && key < nowKey) return [];
  let wins = mergedWindows(phases);
  if (nowKey && key === nowKey) {
    const from = roundUp(nowMin, step);
    wins = wins.map((w) => ({ ...w, start: Math.max(w.start, from) })).filter((w) => w.end > w.start);
  }
  return wins.map((w) => ({ ...w, date: key }));
}

/** windows minus occupied intervals. Both lists hold {start,end}; windows keep their other fields. */
export function subtract(windows, occupied) {
  const occ = occupied.filter((o) => o.end > o.start).map((o) => ({ start: o.start, end: o.end }))
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const w of windows) {
    let cur = w.start;
    for (const o of occ) {
      if (o.end <= cur) continue;
      if (o.start >= w.end) break;
      if (o.start > cur) out.push({ ...w, start: cur, end: Math.min(o.start, w.end) });
      cur = Math.max(cur, o.end);
      if (cur >= w.end) break;
    }
    if (cur < w.end) out.push({ ...w, start: cur, end: w.end });
  }
  return out.filter((s) => s.end > s.start);
}

export function freeSegments({ days, phases, blocks = [], busy = [], bufferMins = 0, now, step = 5 }) {
  const nowKey = todayKey(now), nowMin = minutesOf(now);
  const segs = [];
  for (const key of days) {
    const wins = dayWindows(key, phases, { nowKey, nowMin, step });
    if (!wins.length) continue;
    const occ = [];
    for (const b of busyForDay(busy, key)) occ.push({ start: b.start - bufferMins, end: b.end + bufferMins });
    for (const bl of blocks) if (bl.date === key) occ.push({ start: bl.start - bufferMins, end: bl.end + bufferMins });
    segs.push(...subtract(wins, occ));
  }
  return segs;
}

// ───────────────────────── ordering ─────────────────────────

function deadlineSortValue(t, horizonEndKey) {
  const d = parseDeadline(t.deadline);
  if (!d) return '9';
  if (horizonEndKey && d.key > horizonEndKey) return '9'; // far deadlines don't jump the queue
  return `${d.key}T${String(d.min).padStart(4, '0')}`;
}

export function taskComparator(horizonEndKey) {
  return (a, b) => {
    const da = deadlineSortValue(a, horizonEndKey), db = deadlineSortValue(b, horizonEndKey);
    if (da !== db) return da < db ? -1 : 1;
    const pa = a.priority === 'high' ? 0 : 1, pb = b.priority === 'high' ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if ((a.durationMins || 0) !== (b.durationMins || 0)) return (b.durationMins || 0) - (a.durationMins || 0);
    const ca = a.createdAt || '', cb = b.createdAt || '';
    return ca < cb ? -1 : ca > cb ? 1 : 0;
  };
}

// ───────────────────────── placement ─────────────────────────

function usable(seg, dl) {
  if (!dl) return seg.end - seg.start;
  if (seg.date > dl.key) return 0;
  if (seg.date < dl.key) return seg.end - seg.start;
  return Math.max(0, Math.min(seg.end, dl.min) - seg.start);
}

function tryPlace(task, segs, levels, opts) {
  const dur = Math.max(5, Math.round(task.durationMins || 0));
  const dl = parseDeadline(task.deadline);
  // 1) the whole task in one block — earliest fit
  for (const seg of segs) {
    if (!levels.includes(seg.level)) continue;
    if (dl && seg.date > dl.key) break;
    if (usable(seg, dl) >= dur) {
      const piece = { date: seg.date, start: seg.start, end: seg.start + dur, level: seg.level };
      seg.start = Math.min(piece.end + opts.buffer, seg.end);
      return [piece];
    }
  }
  // 2) split across several blocks (each at least minChunk long)
  const minChunk = Math.max(15, opts.minChunk || 30);
  if (task.splittable && dur >= minChunk * 2) {
    const pieces = [], undo = [];
    let remaining = dur;
    for (const seg of segs) {
      if (!levels.includes(seg.level)) continue;
      if (dl && seg.date > dl.key) break;
      const avail = Math.floor(usable(seg, dl) / 5) * 5;
      if (avail < minChunk) continue;
      let take = Math.min(avail, remaining);
      const rest = remaining - take;
      if (rest > 0 && rest < minChunk) take = remaining - minChunk;
      if (take < minChunk) continue;
      pieces.push({ date: seg.date, start: seg.start, end: seg.start + take, level: seg.level });
      undo.push([seg, seg.start]);
      seg.start = Math.min(seg.start + take + opts.buffer, seg.end);
      remaining -= take;
      if (remaining <= 0) break;
    }
    if (remaining <= 0) return pieces;
    for (const [seg, s] of undo) seg.start = s;
  }
  return null;
}

/** Why a task could not be placed — a short code and a human sentence. */
export function explain(task, { days, phases, settings, now, free = null }) {
  const name = LEVEL_INFO[task.load]?.name || 'matching';
  const dl = parseDeadline(task.deadline);
  if (dl && cmpKM(dl.key, dl.min, todayKey(now), minutesOf(now)) <= 0) {
    return { code: 'deadline-passed', reason: 'Its deadline has passed — change the deadline or do it now.' };
  }
  if (!days.length) {
    return { code: 'no-days', reason: 'No work days in your planning window — check Settings › Work days.' };
  }
  const wins = mergedWindows(phases).filter((w) => w.level === task.load);
  if (!wins.length) {
    return { code: 'no-level', reason: `Your energy map has no ${name} time. Add a ${name} phase or change this task's energy.` };
  }
  const longest = Math.max(...wins.map((w) => w.end - w.start));
  const minChunk = Math.max(15, settings.minChunkMins || 30);
  const canSplit = task.splittable && task.durationMins >= minChunk * 2;
  if (task.durationMins > longest && !canSplit) {
    return { code: 'too-long', reason: `Longer than your longest ${name} block (${fmtDuration(longest)}). Allow splitting or shorten it.` };
  }
  if (free && !canSplit) {
    // free stretches of this level anywhere in the planning window (ignoring the deadline)
    const longestFree = free.filter((sg) => sg.level === task.load).reduce((m, sg) => Math.max(m, sg.end - sg.start), 0);
    if (longestFree > 0 && longestFree < task.durationMins) {
      return { code: 'fragmented', reason: `Busy time breaks up your ${name} time — the longest free stretch is ${fmtDuration(longestFree)}. Allow splitting or shorten it.` };
    }
  }
  if (dl && dl.key <= days[days.length - 1]) {
    return { code: 'deadline', reason: `Not enough free ${name} time before its deadline.` };
  }
  return { code: 'full', reason: `All ${name} time in the next ${settings.horizonDays} days is taken.` };
}

/**
 * Place tasks into free energy-matched time.
 * @returns {{placements: Array<{taskId,date,start,end,level,part,parts}>, unplaced: Array<{taskId,code,reason}>}}
 */
export function planTasks({ tasks, blocks = [], phases, busy = [], settings, now = new Date() }) {
  const days = planningDays(now, settings);
  const segs = freeSegments({ days, phases, blocks, busy, bufferMins: settings.bufferMins || 0, now });
  const initialFree = segs.map((sg) => ({ ...sg }));
  const horizonEnd = addDays(todayKey(now), (settings.horizonDays || 7) - 1);
  const ordered = [...tasks].sort(taskComparator(horizonEnd));
  const opts = { buffer: settings.bufferMins || 0, minChunk: settings.minChunkMins || 30 };
  const placed = new Map();
  for (const t of ordered) {
    const pieces = tryPlace(t, segs, [t.load], opts);
    if (pieces) placed.set(t.id, pieces);
  }
  if (settings.flexibleMatch) {
    for (const t of ordered) {
      if (placed.has(t.id)) continue;
      for (const lvl of FALLBACK[t.load] || []) {
        const pieces = tryPlace(t, segs, [lvl], opts);
        if (pieces) { placed.set(t.id, pieces); break; }
      }
    }
  }
  const placements = [], unplaced = [];
  for (const t of ordered) {
    const pieces = placed.get(t.id);
    if (pieces) pieces.forEach((p, i) => placements.push({ taskId: t.id, ...p, part: i + 1, parts: pieces.length }));
    else unplaced.push({ taskId: t.id, ...explain(t, { days, phases, settings, now, free: initialFree }) });
  }
  return { placements, unplaced };
}

// ───────────────────────── task status ─────────────────────────

export const blockEndsBefore = (b, nowKey, nowMin) => cmpKM(b.date, b.end, nowKey, nowMin) <= 0;
export const blockStartsAfter = (b, nowKey, nowMin) => cmpKM(b.date, b.start, nowKey, nowMin) > 0;

/** 'done' | 'backlog' | 'missed' | 'active' | 'scheduled' */
export function taskStatus(task, blocks, now = new Date()) {
  if (task.doneAt) return 'done';
  const own = blocks.filter((b) => b.taskId === task.id);
  if (!own.length) return 'backlog';
  const nk = todayKey(now), nm = minutesOf(now);
  if (own.every((b) => blockEndsBefore(b, nk, nm))) return 'missed';
  if (own.some((b) => !blockStartsAfter(b, nk, nm) && !blockEndsBefore(b, nk, nm))) return 'active';
  return 'scheduled';
}

/**
 * Split the current plan for a re-plan: which blocks stay fixed and which tasks get (re)placed.
 * Fixed: done tasks' blocks, pinned future blocks, anything already started.
 * Re-placed: backlog tasks, missed tasks (all blocks in the past), unpinned future-only tasks.
 */
export function replanInputs(tasks, blocks, now = new Date(), { includeTaskIds = null } = {}) {
  const nk = todayKey(now), nm = minutesOf(now);
  const byTask = new Map();
  for (const b of blocks) {
    if (!byTask.has(b.taskId)) byTask.set(b.taskId, []);
    byTask.get(b.taskId).push(b);
  }
  const keep = [], toPlace = [];
  const taskIds = new Set(tasks.map((t) => t.id));
  for (const b of blocks) if (!taskIds.has(b.taskId)) { /* orphan block: drop */ }
  for (const t of tasks) {
    const own = byTask.get(t.id) || [];
    if (t.doneAt) { keep.push(...own); continue; }
    const eligible = !includeTaskIds || includeTaskIds.has(t.id);
    if (!own.length) { if (eligible) toPlace.push(t); continue; }
    const allPast = own.every((b) => blockEndsBefore(b, nk, nm));
    const anyStarted = own.some((b) => !blockStartsAfter(b, nk, nm));
    const anyPinned = own.some((b) => b.pinned);
    if (eligible && allPast) { toPlace.push(t); continue; }
    if (!eligible || anyStarted || anyPinned) { keep.push(...own); continue; }
    toPlace.push(t);
  }
  return { keep, toPlace };
}

/** Blocks (not of `excludeTaskId`) on the same day that overlap the interval. */
export function overlapping(blocks, { date, start, end }, excludeTaskId) {
  return blocks.filter((b) => b.date === date && b.taskId !== excludeTaskId && b.start < end && b.end > start);
}

/** Busy items on the day overlapping the interval. */
export function overlappingBusy(busy, { date, start, end }) {
  return busyForDay(busy, date).filter((b) => b.start < end && b.end > start);
}
