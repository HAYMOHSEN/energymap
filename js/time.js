// EnergyMap — date & time helpers.
// Times inside a day are stored as minutes from local midnight (0–1440).
// Days are stored as local date keys "YYYY-MM-DD".

export const DAY_MIN = 1440;

export const pad = (n) => String(n).padStart(2, '0');

export function dateKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function isValidKey(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const d = parseKey(key);
  return dateKey(d) === key;
}

export function addDays(key, n) {
  const d = parseKey(key);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

export function diffDays(aKey, bKey) {
  // whole days from a to b (b - a), DST-safe
  const a = parseKey(aKey), b = parseKey(bKey);
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) -
    Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
}

export const todayKey = (now = new Date()) => dateKey(now);
export const minutesOf = (d) => d.getHours() * 60 + d.getMinutes();
export const weekday = (key) => parseKey(key).getDay(); // 0 = Sunday

export function startOfWeek(key, weekStart = 1) {
  const diff = (weekday(key) - weekStart + 7) % 7;
  return addDays(key, -diff);
}

export function weekKeys(key, weekStart = 1) {
  const s = startOfWeek(key, weekStart);
  return Array.from({ length: 7 }, (_, i) => addDays(s, i));
}

/** Local Date for a day key + minutes (handles DST like the OS clock does). */
export function toDate(key, min = 0) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 0, min, 0, 0);
}

export function fromDate(d) {
  return { key: dateKey(d), min: minutesOf(d) };
}

/** Compare (keyA,minA) with (keyB,minB). */
export function cmpKM(aKey, aMin, bKey, bMin) {
  if (aKey !== bKey) return aKey < bKey ? -1 : 1;
  return aMin - bMin;
}

export const roundUp = (min, step) => Math.ceil(min / step) * step;
export const roundTo = (min, step) => Math.round(min / step) * step;
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** "09:30" -> 570. Returns NaN when invalid. "24:00" is allowed (end of day). */
export function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return NaN;
  const h = +m[1], mi = +m[2];
  if (mi > 59 || h > 24 || (h === 24 && mi > 0)) return NaN;
  return h * 60 + mi;
}

/** 570 -> "09:30" (for <input type=time>). */
export function toHM(min) {
  min = clamp(Math.round(min), 0, DAY_MIN);
  if (min === DAY_MIN) return '23:59';
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

// English UI, but keep the user's English region (en-GB, en-AU…) for date order when it is valid.
let LOCALE = 'en-US';
try {
  const langs = (typeof navigator !== 'undefined' && navigator.languages) || [];
  for (const l of langs) {
    if (!/^en([-_]|$)/i.test(l)) continue;
    try {
      const canon = Intl.getCanonicalLocales(l.replace(/_/g, '-').replace(/[@.].*$/, ''))[0];
      new Intl.DateTimeFormat(canon); // throws on anything Intl can't use
      LOCALE = canon;
      break;
    } catch { /* try the next one */ }
  }
} catch { LOCALE = 'en-US'; }
export const locale = () => LOCALE;

export function prefers12h() {
  try {
    const o = new Intl.DateTimeFormat(LOCALE, { hour: 'numeric' }).resolvedOptions();
    return o.hour12 !== false && o.hourCycle !== 'h23' && o.hourCycle !== 'h24';
  } catch { return true; }
}

/** 570 -> "9:30 AM" (12h) or "09:30" (24h). */
export function fmtTime(min, h12 = true, { compact = false } = {}) {
  min = Math.round(min);
  if (min >= DAY_MIN) min = DAY_MIN;
  let h = Math.floor(min / 60) % 24;
  const m = min % 60;
  if (min === DAY_MIN && !h12) return '24:00';
  if (!h12) return `${pad(h)}:${pad(m)}`;
  const ap = h < 12 ? 'AM' : 'PM';
  let hh = h % 12; if (hh === 0) hh = 12;
  if (compact) return m === 0 ? `${hh} ${ap}` : `${hh}:${pad(m)} ${ap}`;
  return `${hh}:${pad(m)} ${ap}`;
}

export function fmtRange(a, b, h12 = true) {
  return `${fmtTime(a, h12)} – ${fmtTime(b, h12)}`;
}

/** 95 -> "1h 35m", 60 -> "1h", 45 -> "45m" */
export function fmtDuration(mins) {
  mins = Math.max(0, Math.round(mins));
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/** Hours with one decimal: 90 -> "1.5h" */
export function fmtHours(mins) {
  const h = mins / 60;
  return (Math.round(h * 10) / 10).toString().replace(/\.0$/, '') + 'h';
}

const dtfCache = new Map();
function dtf(opts) {
  const k = JSON.stringify(opts);
  if (!dtfCache.has(k)) dtfCache.set(k, new Intl.DateTimeFormat(LOCALE, opts));
  return dtfCache.get(k);
}

export const fmtDayLong = (key) => dtf({ weekday: 'long', month: 'long', day: 'numeric' }).format(parseKey(key));
export const fmtDayMed = (key) => dtf({ weekday: 'short', month: 'short', day: 'numeric' }).format(parseKey(key));
export const fmtWeekdayShort = (key) => dtf({ weekday: 'short' }).format(parseKey(key));
export const fmtMonthDay = (key) => dtf({ month: 'short', day: 'numeric' }).format(parseKey(key));
export const fmtMonthYear = (key) => dtf({ month: 'long', year: 'numeric' }).format(parseKey(key));
export const fmtDayNum = (key) => String(parseKey(key).getDate());

/** Friendly day: Today / Tomorrow / Yesterday / Wed / Oct 14 */
export function fmtRelDay(key, now = new Date()) {
  const t = todayKey(now);
  const dd = diffDays(t, key);
  if (dd === 0) return 'Today';
  if (dd === 1) return 'Tomorrow';
  if (dd === -1) return 'Yesterday';
  if (dd > 1 && dd < 7) return dtf({ weekday: 'short' }).format(parseKey(key));
  return fmtMonthDay(key);
}

/** Deadline string "YYYY-MM-DDTHH:mm" -> {key, min} or null */
export function parseDeadline(s) {
  if (!s || typeof s !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?$/.exec(s);
  if (!m || !isValidKey(m[1])) return null;
  const min = m[2] ? parseHM(m[2]) : DAY_MIN - 1;
  return { key: m[1], min: Number.isNaN(min) ? DAY_MIN - 1 : min };
}

export function makeDeadline(key, min = DAY_MIN - 1) {
  return `${key}T${toHM(Math.min(min, DAY_MIN - 1))}`;
}

export function fmtDeadline(s, h12 = true, now = new Date()) {
  const d = parseDeadline(s);
  if (!d) return '';
  const day = fmtRelDay(d.key, now);
  return d.min >= DAY_MIN - 1 ? day : `${day} ${fmtTime(d.min, h12, { compact: true })}`;
}

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAY_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
