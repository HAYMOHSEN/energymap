// EnergyMap — app state, persistence (IndexedDB + localStorage safety copy),
// undo/redo, daily automatic backups and multi-window sync.

import { PRESETS } from './scheduler.js';
import { prefers12h, todayKey, isValidKey, parseDeadline } from './time.js';

export const APP_VERSION = '1.0.0';
export const SCHEMA_VERSION = 1;

export function uid(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function defaultSettings() {
  return {
    theme: 'system',            // system | light | dark
    h12: prefers12h(),
    weekStart: 1,               // 0 Sun, 1 Mon, 6 Sat
    workDays: [1, 2, 3, 4, 5],
    bufferMins: 5,
    horizonDays: 7,
    flexibleMatch: false,
    minChunkMins: 30,
    splitDefault: false,
    bumpMode: 'reschedule',     // reschedule | backlog
    reminders: false,
    reminderLead: 0,
    sound: true,
    checkins: true,
    badge: true,
    defaultDuration: 60,
    defaultLoad: 'peak',
    zoom: 1,
    onboarded: false,
    planMode: 'day',
  };
}

export function presetPhases(key) {
  return (PRESETS[key] || PRESETS.typical).phases.map((p) => ({ id: uid('p'), ...p }));
}

export function defaultState() {
  return {
    schema: SCHEMA_VERSION,
    settings: defaultSettings(),
    profile: { preset: 'typical', phases: presetPhases('typical') },
    tasks: [],
    blocks: [],
    busy: [],
    sources: [],
    checkins: [],
    meta: { createdAt: new Date().toISOString(), savedAt: 0 },
  };
}

// ───────────── validation of stored / imported data ─────────────
// Everything read from storage or from a backup file is re-validated, so a damaged
// or hand-edited file can never inject markup or break the app.
const LEVELS = ['peak', 'steady', 'low'];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const arr = (a) => (Array.isArray(a) ? a : []);
const int = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : def; };
const str = (v, max, def = '') => (typeof v === 'string' ? v.slice(0, max) : def);
const iso = (v, def) => (typeof v === 'string' && v.length < 40 && !Number.isNaN(Date.parse(v)) ? v : def);
const bool = (v) => typeof v === 'boolean';
function cleanId(id, prefix, used) {
  const v = typeof id === 'string' && ID_RE.test(id) && !used.has(id) ? id : uid(prefix);
  used.add(v);
  return v;
}

function cleanSettings(raw) {
  const d = defaultSettings();
  const r = isObj(raw) ? raw : {};
  const out = { ...d };
  const pick = (k, ok) => { if (k in r && ok(r[k])) out[k] = r[k]; };
  pick('theme', (v) => ['system', 'light', 'dark'].includes(v));
  pick('h12', bool);
  pick('weekStart', (v) => [0, 1, 6].includes(v));
  const wd = [...new Set(arr(r.workDays).map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].sort();
  if (wd.length) out.workDays = wd;
  out.bufferMins = int(r.bufferMins, 0, 60, d.bufferMins);
  out.horizonDays = int(r.horizonDays, 1, 60, d.horizonDays);
  pick('flexibleMatch', bool);
  out.minChunkMins = int(r.minChunkMins, 15, 120, d.minChunkMins);
  pick('splitDefault', bool);
  pick('bumpMode', (v) => ['reschedule', 'backlog'].includes(v));
  pick('reminders', bool);
  out.reminderLead = int(r.reminderLead, 0, 60, d.reminderLead);
  pick('sound', bool);
  pick('checkins', bool);
  pick('badge', bool);
  out.defaultDuration = int(r.defaultDuration, 5, 720, d.defaultDuration);
  pick('defaultLoad', (v) => LEVELS.includes(v));
  if (Number.isFinite(Number(r.zoom))) out.zoom = Math.min(2.4, Math.max(0.6, Number(r.zoom)));
  pick('onboarded', bool);
  pick('planMode', (v) => ['day', 'week'].includes(v));
  return out;
}

const DEADLINE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;

export function migrate(raw) {
  const base = defaultState();
  if (!isObj(raw)) return base;
  const now = new Date().toISOString();
  const s = { schema: SCHEMA_VERSION };
  s.settings = cleanSettings(raw.settings);

  const usedP = new Set();
  const prof = isObj(raw.profile) ? raw.profile : null;
  const phases = prof ? arr(prof.phases).filter(isObj).map((p) => ({
    id: cleanId(p.id, 'p', usedP), label: str(p.label, 60),
    start: int(p.start, 0, 1440, NaN), end: int(p.end, 0, 1440, NaN), level: LEVELS.includes(p.level) ? p.level : null,
  })).filter((p) => p.level && Number.isFinite(p.start) && Number.isFinite(p.end) && p.end > p.start) : null;
  s.profile = phases
    ? { preset: typeof prof.preset === 'string' && (PRESETS[prof.preset] || prof.preset === 'custom') ? prof.preset : 'custom', phases }
    : base.profile;

  const usedT = new Set(), taskMap = new Map();
  s.tasks = arr(raw.tasks).filter((t) => isObj(t) && typeof t.title === 'string').map((t) => {
    const id = cleanId(t.id, 't', usedT);
    if (typeof t.id === 'string' && !taskMap.has(t.id)) taskMap.set(t.id, id);
    const out = {
      id, title: str(t.title, 300).trim() || 'Untitled task', notes: str(t.notes, 5000),
      load: LEVELS.includes(t.load) ? t.load : 'peak', durationMins: int(t.durationMins, 5, 720, 60),
      deadline: typeof t.deadline === 'string' && DEADLINE_RE.test(t.deadline) && parseDeadline(t.deadline) ? t.deadline : null,
      priority: t.priority === 'high' ? 'high' : 'normal', splittable: t.splittable === true,
      doneAt: iso(t.doneAt, null), createdAt: iso(t.createdAt, now),
    };
    if (t.sample === true) out.sample = true;
    return out;
  });

  const usedB = new Set();
  s.blocks = arr(raw.blocks).filter(isObj).map((b) => ({
    id: cleanId(b.id, 'b', usedB), taskId: taskMap.get(b.taskId) || null, date: isValidKey(b.date) ? b.date : null,
    start: int(b.start, 0, 1440, NaN), end: int(b.end, 0, 1440, NaN), pinned: b.pinned === true,
    part: int(b.part, 1, 99, 1), parts: int(b.parts, 1, 99, 1),
  })).filter((b) => b.taskId && b.date && Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start);

  const usedS = new Set(), srcMap = new Map();
  s.sources = arr(raw.sources).filter(isObj).map((x) => {
    const id = cleanId(x.id, 'src', usedS);
    if (typeof x.id === 'string') srcMap.set(x.id, id);
    return {
      id, name: str(x.name, 80).trim() || 'Calendar', fileName: str(x.fileName, 200), importedAt: iso(x.importedAt, null),
      until: isValidKey(x.until) ? x.until : null, count: int(x.count, 0, 1e6, 0),
    };
  });

  const usedBz = new Set();
  s.busy = arr(raw.busy).filter(isObj).map((b) => {
    let repeat = null;
    if (isObj(b.repeat)) {
      const days = [...new Set(arr(b.repeat.days).map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].sort();
      if (days.length) repeat = { days, until: isValidKey(b.repeat.until) ? b.repeat.until : null, except: arr(b.repeat.except).filter(isValidKey) };
    }
    const out = {
      id: cleanId(b.id, 'bz', usedBz), title: str(b.title, 200).trim() || 'Busy', date: isValidKey(b.date) ? b.date : null,
      start: int(b.start, 0, 1440, NaN), end: int(b.end, 0, 1440, NaN), repeat,
      sourceId: typeof b.sourceId === 'string' ? srcMap.get(b.sourceId) || null : null, allDay: b.allDay === true,
    };
    if (b.sample === true) out.sample = true;
    return out;
  }).filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start && (b.date || b.repeat));

  const usedC = new Set();
  s.checkins = arr(raw.checkins).filter(isObj).map((c) => {
    const out = { id: cleanId(c.id, 'c', usedC), at: iso(c.at, null), level: int(c.level, 1, 5, NaN) };
    if (c.sample === true) out.sample = true;
    return out;
  }).filter((c) => c.at && Number.isFinite(c.level));

  const meta = isObj(raw.meta) ? raw.meta : {};
  s.meta = { createdAt: iso(meta.createdAt, now), savedAt: Number.isFinite(meta.savedAt) ? meta.savedAt : 0 };
  return s;
}

// ───────────── store ─────────────
let state = defaultState();
const listeners = new Set();
const undoStack = [];
const redoStack = [];
const MAX_UNDO = 60;
let seq = 0;
let lastId = 0;

export const getState = () => state;
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(info) { for (const fn of listeners) { try { fn(info); } catch (e) { console.error(e); } } }

/**
 * Apply a change. mutate(state) edits the state in place and may return a result.
 * Every undoable change stores a snapshot for undo (settings changes are tracked per key,
 * so undoing a task change never reverts an unrelated settings change).
 */
export function commit(label, mutate, { undoable = true, render = true } = {}) {
  const before = undoable ? JSON.stringify(state) : null;
  const settingsBefore = undoable ? state.settings : null;
  let result;
  try {
    result = mutate(state);
  } catch (e) {
    if (before) state = JSON.parse(before);
    throw e;
  }
  if (undoable) {
    const prev = JSON.parse(JSON.stringify(settingsBefore));
    const keys = Object.keys({ ...prev, ...state.settings })
      .filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(state.settings[k]));
    undoStack.push({ id: ++seq, label, snapshot: before, keys });
    lastId = seq;
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
  }
  scheduleSave();
  emit({ label, render });
  return result;
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;
export const undoLabel = () => (undoStack.length ? undoStack[undoStack.length - 1].label : '');
/** Id of the most recent undoable change — capture it right after an action to undo exactly that one. */
export const lastCommitId = () => lastId;

function restoreFrom(snapshotJSON, keys) {
  const snap = JSON.parse(snapshotJSON);
  const settings = { ...state.settings };
  for (const k of keys) { if (k in snap.settings) settings[k] = snap.settings[k]; else delete settings[k]; }
  snap.settings = settings;
  state = snap;
}

export function undo() {
  const e = undoStack.pop();
  if (!e) return null;
  redoStack.push({ id: e.id, label: e.label, snapshot: JSON.stringify(state), keys: e.keys });
  restoreFrom(e.snapshot, e.keys);
  scheduleSave();
  emit({ label: 'undo', undone: e.label, render: true });
  return e.label;
}

export function redo() {
  const e = redoStack.pop();
  if (!e) return null;
  undoStack.push({ id: e.id, label: e.label, snapshot: JSON.stringify(state), keys: e.keys });
  restoreFrom(e.snapshot, e.keys);
  scheduleSave();
  emit({ label: 'redo', redone: e.label, render: true });
  return e.label;
}

/** Undo only if the given change is still the most recent one. */
export function undoIf(id) {
  const top = undoStack[undoStack.length - 1];
  if (!top || top.id !== id) return false;
  undo();
  return true;
}

export function replaceState(next, label = 'Replace data') {
  commit(label, () => { state = migrate(next); });
}

// ───────────── persistence ─────────────
const DB_NAME = 'energymap';
const STORE = 'kv';
const LS_KEY = 'energymap.state.v1';
let db = null;
let saveTimer = null;
let saving = Promise.resolve();
let readFailed = false;
const TAB = uid('w');
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('energymap-sync') : null;

function openDB() {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch { return resolve(null); }
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function tx(mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const idbGet = (k) => tx('readonly', (s) => s.get(k));
const idbSet = (k, v) => tx('readwrite', (s) => s.put(v, k));
const idbDel = (k) => tx('readwrite', (s) => s.delete(k));
const idbKeys = () => tx('readonly', (s) => s.getAllKeys());

let storageError = null;
export const lastStorageError = () => storageError;
/** True when saved data exists but could not be read — saving is paused so nothing is overwritten. */
export const storageReadFailed = () => readFailed;

const savedAtOf = (o) => (isObj(o) && isObj(o.meta) && Number.isFinite(o.meta.savedAt) ? o.meta.savedAt : 0);

/** Newest of the IndexedDB copy and the localStorage safety copy. */
async function readStored() {
  let fromDb = null, failed = false;
  if (db) { try { fromDb = await idbGet('state'); } catch { failed = true; } }
  let fromLs = null;
  try { const t = localStorage.getItem(LS_KEY); if (t) fromLs = JSON.parse(t); } catch { fromLs = null; }
  let raw = fromDb;
  if (fromLs && (!raw || savedAtOf(fromLs) > savedAtOf(raw))) raw = fromLs;
  return { raw, failed: failed && !raw };
}

export async function loadState() {
  db = await openDB();
  const { raw, failed } = await readStored();
  readFailed = failed;
  state = migrate(raw);
  if (!readFailed) { try { await autoBackup(); } catch { /* best effort */ } }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* optional */ }
  if (channel) {
    channel.onmessage = async (ev) => {
      if (!ev.data || ev.data.from === TAB || ev.data.type !== 'saved') return;
      const { raw: fresh } = await readStored();
      if (fresh) {
        state = migrate(fresh);
        undoStack.length = 0; redoStack.length = 0;
        emit({ label: 'sync', render: true, external: true });
      }
    };
  }
  const flush = () => { writeSafetyCopy(); saveNow(); };
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  return state;
}

function stamped() {
  const copy = JSON.parse(JSON.stringify(state));
  copy.meta = { ...(copy.meta || {}), savedAt: Date.now() };
  return copy;
}

/** Synchronous copy in localStorage — survives the window closing before IndexedDB finishes. */
function writeSafetyCopy() {
  if (readFailed) return;
  try { localStorage.setItem(LS_KEY, JSON.stringify(stamped())); } catch { /* quota: IndexedDB copy still saves */ }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 250);
}

export function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (readFailed) return saving; // never overwrite data we could not read
  const snapshot = stamped();
  saving = saving.then(async () => {
    try {
      if (db) await idbSet('state', snapshot);
      else localStorage.setItem(LS_KEY, JSON.stringify(snapshot));
      storageError = null;
    } catch (e) {
      try { localStorage.setItem(LS_KEY, JSON.stringify(snapshot)); storageError = null; } catch (e2) {
        storageError = e2 || e;
        emit({ label: 'storage-error', render: false, error: storageError });
      }
    }
    if (channel) channel.postMessage({ type: 'saved', from: TAB });
  });
  return saving;
}

// ───────────── automatic daily backups ─────────────
async function autoBackup() {
  if (!db) return;
  const today = todayKey();
  const keys = (await idbKeys()).map(String).filter((k) => k.startsWith('backup:')).sort();
  if (!keys.includes('backup:' + today) && (state.tasks.length || state.blocks.length || state.busy.length)) {
    await idbSet('backup:' + today, { at: new Date().toISOString(), version: APP_VERSION, state: JSON.parse(JSON.stringify(state)) });
    keys.push('backup:' + today);
  }
  while (keys.length > 7) await idbDel(keys.shift());
}

export async function listBackups() {
  if (!db) return [];
  const keys = (await idbKeys()).map(String).filter((k) => k.startsWith('backup:')).sort().reverse();
  const out = [];
  for (const k of keys) {
    try {
      const v = await idbGet(k);
      if (v && v.state) out.push({ key: k, at: iso(v.at, null), tasks: arr(v.state.tasks).length });
    } catch { /* skip */ }
  }
  return out;
}

export async function restoreBackup(key) {
  const v = await idbGet(key);
  if (!v || !v.state) throw new Error('Backup not found');
  replaceState(v.state, 'Restore automatic backup');
}

// ───────────── export / import ─────────────
export function exportJSON() {
  return JSON.stringify({ app: 'EnergyMap', version: APP_VERSION, exportedAt: new Date().toISOString(), state }, null, 2);
}

export function parseBackup(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('This file is not valid JSON.'); }
  if (!isObj(obj) || obj.app !== 'EnergyMap' || !isObj(obj.state)) throw new Error('This file is not an EnergyMap backup.');
  return migrate(obj.state);
}

export async function resetAll() {
  state = defaultState();
  undoStack.length = 0; redoStack.length = 0;
  readFailed = false;
  await saveNow();
  writeSafetyCopy();
  emit({ label: 'reset', render: true });
}
