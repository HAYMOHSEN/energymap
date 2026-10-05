// EnergyMap — iCalendar (.ics) export and import (RFC 5545 subset).
// Export: planned task blocks -> .ics that Google Calendar, Outlook and Apple Calendar open.
// Import: busy times from a calendar export (time zones, all-day, recurring events,
//         exceptions and moved instances) so EnergyMap plans around meetings.

import { dateKey, minutesOf, pad, DAY_MIN } from './time.js';

// ───────────────────────── export ─────────────────────────

export function icsEscape(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const byteLen = (s) => (encoder ? encoder.encode(s).length : unescape(encodeURIComponent(s)).length);

/** Fold a content line at 75 octets without splitting a UTF-8 character. */
export function foldLine(line) {
  if (byteLen(line) <= 75) return line;
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = byteLen(ch);
    const limit = out.length === 0 ? 75 : 74; // continuation lines begin with one space
    if (bytes + b > limit) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  if (cur) out.push(cur);
  return out.map((l, i) => (i === 0 ? l : ' ' + l)).join('\r\n');
}

export function utcStamp(date) {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/**
 * @param {{calName?:string, events:Array<{uid:string,start:Date,end:Date,summary:string,description?:string,
 *          categories?:string[],alarmMins?:number|null,transparent?:boolean}>, now?:Date}} o
 */
export function buildICS({ calName = 'EnergyMap', events = [], now = new Date() }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//EnergyMap//EnergyMap Planner 1.0//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(calName)}`,
  ];
  const stamp = utcStamp(now);
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${stamp}`,
      `DTSTART:${utcStamp(e.start)}`, `DTEND:${utcStamp(e.end)}`, `SUMMARY:${icsEscape(e.summary)}`);
    if (e.description) lines.push(`DESCRIPTION:${icsEscape(e.description)}`);
    if (e.categories && e.categories.length) lines.push(`CATEGORIES:${e.categories.map(icsEscape).join(',')}`);
    lines.push(`TRANSP:${e.transparent ? 'TRANSPARENT' : 'OPAQUE'}`);
    if (e.alarmMins !== null && e.alarmMins !== undefined && !e.transparent) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(e.summary)}`,
        `TRIGGER:-PT${Math.max(0, Math.round(e.alarmMins))}M`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// ───────────────────────── import: parsing ─────────────────────────

const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

export function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

function splitOutsideQuotes(s, sep) {
  const out = [];
  let cur = '', q = false;
  for (const c of s) {
    if (c === '"') q = !q;
    if (c === sep && !q) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

function parseLine(line) {
  let q = false, i = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ':' && !q) break;
  }
  if (i >= line.length) return null;
  const parts = splitOutsideQuotes(line.slice(0, i), ';');
  const params = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: parts[0].trim().toUpperCase(), params, value: line.slice(i + 1) };
}

export function unescapeText(v) {
  return String(v).replace(/\\n/gi, '\n').replace(/\\([,;\\:])/g, '$1');
}

function parseDT(value, params = {}) {
  const v = String(value).trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) return { y: +m[1], m: +m[2], d: +m[3], h: 0, mi: 0, s: 0, dateOnly: true, tz: null };
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i.exec(v);
  if (!m) return null;
  return {
    y: +m[1], m: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0),
    dateOnly: false, tz: m[7] ? 'UTC' : (params.TZID || null),
  };
}

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(String(v).trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * ((+m[2] || 0) * 604800 + (+m[3] || 0) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
}

function parseOffset(v) {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(String(v).trim());
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * ((+m[2]) * 3600 + (+m[3]) * 60 + (+m[4] || 0)) * 1000;
}

export function parseRRule(v) {
  const r = {};
  for (const part of String(v).split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) r[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1).trim();
  }
  const out = { freq: (r.FREQ || '').toUpperCase(), interval: Math.max(1, parseInt(r.INTERVAL, 10) || 1) };
  if (r.COUNT) out.count = Math.max(1, parseInt(r.COUNT, 10) || 1);
  if (r.UNTIL) out.until = r.UNTIL;
  if (r.BYDAY) {
    out.byday = r.BYDAY.split(',').map((x) => {
      const mm = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(x.trim());
      return mm ? { n: mm[1] ? parseInt(mm[1], 10) : 0, wd: WD[mm[2].toUpperCase()] } : null;
    }).filter(Boolean);
  }
  if (r.BYMONTHDAY) out.bymonthday = r.BYMONTHDAY.split(',').map(Number).filter((n) => n && Math.abs(n) <= 31);
  if (r.BYMONTH) out.bymonth = r.BYMONTH.split(',').map(Number).filter((n) => n >= 1 && n <= 12);
  if (r.BYSETPOS) out.bysetpos = r.BYSETPOS.split(',').map(Number).filter(Boolean);
  if (r.WKST && WD[r.WKST.toUpperCase()] !== undefined) out.wkst = WD[r.WKST.toUpperCase()];
  return out;
}

/** Parse .ics text into {name, events, timezones}. Tolerant of unknown properties. */
export function parseICS(text) {
  const cal = { name: null, events: [], timezones: {} };
  const stack = [];
  let ev = null, tz = null, tzSub = null;
  for (const raw of unfold(text).split('\n')) {
    if (!raw.trim()) continue;
    const p = parseLine(raw);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      const comp = p.value.trim().toUpperCase();
      stack.push(comp);
      if (comp === 'VEVENT') ev = { exdates: [], rdates: [] };
      else if (comp === 'VTIMEZONE') tz = { id: null, rules: [] };
      else if ((comp === 'STANDARD' || comp === 'DAYLIGHT') && tz) tzSub = { type: comp };
      continue;
    }
    if (p.name === 'END') {
      const comp = p.value.trim().toUpperCase();
      stack.pop();
      if (comp === 'VEVENT' && ev) { cal.events.push(ev); ev = null; }
      else if (comp === 'VTIMEZONE' && tz) { if (tz.id) cal.timezones[tz.id] = tz; tz = null; }
      else if ((comp === 'STANDARD' || comp === 'DAYLIGHT') && tz && tzSub) { tz.rules.push(tzSub); tzSub = null; }
      continue;
    }
    const top = stack[stack.length - 1];
    if (top === 'VCALENDAR') {
      if (p.name === 'X-WR-CALNAME') cal.name = unescapeText(p.value).trim();
    } else if (top === 'VEVENT' && ev) {
      switch (p.name) {
        case 'UID': ev.uid = p.value.trim(); break;
        case 'SUMMARY': ev.summary = unescapeText(p.value).trim(); break;
        case 'DTSTART': ev.start = parseDT(p.value, p.params); break;
        case 'DTEND': ev.end = parseDT(p.value, p.params); break;
        case 'DURATION': ev.duration = parseDuration(p.value); break;
        case 'RRULE': ev.rrule = parseRRule(p.value); break;
        case 'EXDATE':
          for (const v of p.value.split(',')) { const d = parseDT(v, p.params); if (d) ev.exdates.push(d); }
          break;
        case 'RDATE':
          if ((p.params.VALUE || '').toUpperCase() !== 'PERIOD') {
            for (const v of p.value.split(',')) { const d = parseDT(v, p.params); if (d) ev.rdates.push(d); }
          }
          break;
        case 'RECURRENCE-ID': ev.recurrenceId = parseDT(p.value, p.params); break;
        case 'STATUS': ev.status = p.value.trim().toUpperCase(); break;
        case 'TRANSP': ev.transp = p.value.trim().toUpperCase(); break;
        case 'X-MICROSOFT-CDO-BUSYSTATUS': ev.msBusy = p.value.trim().toUpperCase(); break;
        default: break;
      }
    } else if (top === 'VTIMEZONE' && tz) {
      if (p.name === 'TZID') tz.id = p.value.trim();
    } else if ((top === 'STANDARD' || top === 'DAYLIGHT') && tzSub) {
      if (p.name === 'TZOFFSETTO') tzSub.offsetTo = parseOffset(p.value);
      else if (p.name === 'TZOFFSETFROM') tzSub.offsetFrom = parseOffset(p.value);
      else if (p.name === 'DTSTART') tzSub.start = parseDT(p.value);
      else if (p.name === 'RRULE') tzSub.rrule = parseRRule(p.value);
    }
  }
  return cal;
}

// ───────────────────────── time zones ─────────────────────────

/** Common Windows (Outlook / Exchange) time-zone names -> IANA. */
export const WINDOWS_ZONES = {
  'Dateline Standard Time': 'Etc/GMT+12', 'UTC-11': 'Etc/GMT+11', 'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage', 'Pacific Standard Time': 'America/Los_Angeles',
  'Pacific Standard Time (Mexico)': 'America/Tijuana', 'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time': 'America/Denver', 'Mountain Standard Time (Mexico)': 'America/Chihuahua',
  'Central America Standard Time': 'America/Guatemala', 'Central Standard Time': 'America/Chicago',
  'Central Standard Time (Mexico)': 'America/Mexico_City', 'Canada Central Standard Time': 'America/Regina',
  'SA Pacific Standard Time': 'America/Bogota', 'Eastern Standard Time': 'America/New_York',
  'Eastern Standard Time (Mexico)': 'America/Cancun', 'US Eastern Standard Time': 'America/Indiana/Indianapolis',
  'Cuba Standard Time': 'America/Havana', 'Haiti Standard Time': 'America/Port-au-Prince',
  'Venezuela Standard Time': 'America/Caracas', 'Paraguay Standard Time': 'America/Asuncion',
  'Atlantic Standard Time': 'America/Halifax', 'SA Western Standard Time': 'America/La_Paz',
  'Pacific SA Standard Time': 'America/Santiago', 'Newfoundland Standard Time': 'America/St_Johns',
  'E. South America Standard Time': 'America/Sao_Paulo', 'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  'SA Eastern Standard Time': 'America/Cayenne', 'Greenland Standard Time': 'America/Nuuk',
  'Montevideo Standard Time': 'America/Montevideo', 'UTC-02': 'Etc/GMT+2', 'Azores Standard Time': 'Atlantic/Azores',
  'Cape Verde Standard Time': 'Atlantic/Cape_Verde', UTC: 'Etc/UTC', 'Coordinated Universal Time': 'Etc/UTC',
  'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'Morocco Standard Time': 'Africa/Casablanca', 'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest', 'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw', 'W. Central Africa Standard Time': 'Africa/Lagos',
  'Jordan Standard Time': 'Asia/Amman', 'GTB Standard Time': 'Europe/Bucharest',
  'Middle East Standard Time': 'Asia/Beirut', 'Egypt Standard Time': 'Africa/Cairo',
  'E. Europe Standard Time': 'Europe/Chisinau', 'Syria Standard Time': 'Asia/Damascus',
  'West Bank Standard Time': 'Asia/Hebron', 'South Africa Standard Time': 'Africa/Johannesburg',
  'FLE Standard Time': 'Europe/Kyiv', 'Israel Standard Time': 'Asia/Jerusalem',
  'Kaliningrad Standard Time': 'Europe/Kaliningrad', 'Libya Standard Time': 'Africa/Tripoli',
  'Sudan Standard Time': 'Africa/Khartoum', 'Arabic Standard Time': 'Asia/Baghdad',
  'Turkey Standard Time': 'Europe/Istanbul', 'Arab Standard Time': 'Asia/Riyadh',
  'Belarus Standard Time': 'Europe/Minsk', 'Russian Standard Time': 'Europe/Moscow',
  'E. Africa Standard Time': 'Africa/Nairobi', 'Iran Standard Time': 'Asia/Tehran',
  'Arabian Standard Time': 'Asia/Dubai', 'Azerbaijan Standard Time': 'Asia/Baku',
  'Mauritius Standard Time': 'Indian/Mauritius', 'Georgian Standard Time': 'Asia/Tbilisi',
  'Caucasus Standard Time': 'Asia/Yerevan', 'Afghanistan Standard Time': 'Asia/Kabul',
  'West Asia Standard Time': 'Asia/Tashkent', 'Ekaterinburg Standard Time': 'Asia/Yekaterinburg',
  'Pakistan Standard Time': 'Asia/Karachi', 'India Standard Time': 'Asia/Kolkata',
  'Sri Lanka Standard Time': 'Asia/Colombo', 'Nepal Standard Time': 'Asia/Kathmandu',
  'Central Asia Standard Time': 'Asia/Almaty', 'Bangladesh Standard Time': 'Asia/Dhaka',
  'Myanmar Standard Time': 'Asia/Yangon', 'SE Asia Standard Time': 'Asia/Bangkok',
  'N. Central Asia Standard Time': 'Asia/Novosibirsk', 'North Asia Standard Time': 'Asia/Krasnoyarsk',
  'China Standard Time': 'Asia/Shanghai', 'North Asia East Standard Time': 'Asia/Irkutsk',
  'Singapore Standard Time': 'Asia/Singapore', 'W. Australia Standard Time': 'Australia/Perth',
  'Taipei Standard Time': 'Asia/Taipei', 'Ulaanbaatar Standard Time': 'Asia/Ulaanbaatar',
  'Tokyo Standard Time': 'Asia/Tokyo', 'Korea Standard Time': 'Asia/Seoul', 'Yakutsk Standard Time': 'Asia/Yakutsk',
  'Cen. Australia Standard Time': 'Australia/Adelaide', 'AUS Central Standard Time': 'Australia/Darwin',
  'E. Australia Standard Time': 'Australia/Brisbane', 'AUS Eastern Standard Time': 'Australia/Sydney',
  'West Pacific Standard Time': 'Pacific/Port_Moresby', 'Tasmania Standard Time': 'Australia/Hobart',
  'Vladivostok Standard Time': 'Asia/Vladivostok', 'Central Pacific Standard Time': 'Pacific/Guadalcanal',
  'New Zealand Standard Time': 'Pacific/Auckland', 'Fiji Standard Time': 'Pacific/Fiji',
  'Tonga Standard Time': 'Pacific/Tongatapu', 'Samoa Standard Time': 'Pacific/Apia',
};

const zoneOk = new Map();
function ianaSupported(tz) {
  if (zoneOk.has(tz)) return zoneOk.get(tz);
  let ok = false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); ok = true; } catch { ok = false; }
  zoneOk.set(tz, ok);
  return ok;
}

export function resolveZone(tzid, cal) {
  if (!tzid) return { kind: 'floating' };
  const clean = String(tzid).replace(/^"|"$/g, '').trim();
  if (/^(utc|gmt|z|etc\/utc|etc\/gmt|etc\/zulu)$/i.test(clean)) return { kind: 'utc' };
  if (ianaSupported(clean)) return { kind: 'iana', tz: clean };
  const win = WINDOWS_ZONES[clean];
  if (win && ianaSupported(win)) return { kind: 'iana', tz: win };
  const segs = clean.split('/').filter(Boolean);
  for (let n = Math.min(3, segs.length); n >= 2; n--) {
    const cand = segs.slice(-n).join('/');
    if (ianaSupported(cand)) return { kind: 'iana', tz: cand };
  }
  const vtz = cal && cal.timezones && cal.timezones[tzid];
  if (vtz && vtz.rules && vtz.rules.length) return { kind: 'vtimezone', vtz };
  return { kind: 'floating' };
}

const dtfCache = new Map();
function zoneDTF(tz) {
  if (!dtfCache.has(tz)) {
    dtfCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return dtfCache.get(tz);
}

function ianaOffset(utcMs, tz) {
  const o = {};
  for (const p of zoneDTF(tz).formatToParts(new Date(utcMs))) o[p.type] = p.value;
  const asUTC = Date.UTC(+o.year, +o.month - 1, +o.day, (+o.hour) % 24, +o.minute, +o.second);
  return asUTC - Math.floor(utcMs / 1000) * 1000;
}

export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dowYMD = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

/** Day of month of the nth weekday (n<0 counts from the end). null if it doesn't exist. */
export function nthWeekday(year, month, wd, n) {
  const dim = daysInMonth(year, month);
  if (n > 0) {
    const d = 1 + ((wd - dowYMD(year, month, 1) + 7) % 7) + (n - 1) * 7;
    return d <= dim ? d : null;
  }
  if (n < 0) {
    const d = dim - ((dowYMD(year, month, dim) - wd + 7) % 7) + (n + 1) * 7;
    return d >= 1 ? d : null;
  }
  return null;
}

function ruleOnsets(r, year) {
  if (!r.start) return [];
  const from = r.offsetFrom || 0;
  const at = (y, m, d) => Date.UTC(y, m - 1, d, r.start.h, r.start.mi, r.start.s) - from;
  if (r.rrule && r.rrule.freq === 'YEARLY') {
    const out = [];
    for (const y of [year - 1, year]) {
      if (y < r.start.y) continue;
      const m = (r.rrule.bymonth && r.rrule.bymonth[0]) || r.start.m;
      let d = r.start.d;
      if (r.rrule.byday && r.rrule.byday.length) d = nthWeekday(y, m, r.rrule.byday[0].wd, r.rrule.byday[0].n || 1);
      else if (r.rrule.bymonthday && r.rrule.bymonthday.length) {
        const md = r.rrule.bymonthday[0];
        d = md > 0 ? md : daysInMonth(y, m) + 1 + md;
      }
      if (d) out.push(at(y, m, d));
    }
    return out;
  }
  return [at(r.start.y, r.start.m, r.start.d)];
}

function vtzOffset(utcMs, vtz) {
  const year = new Date(utcMs).getUTCFullYear();
  let best = null, bestOnset = -Infinity;
  for (const r of vtz.rules) {
    for (const onset of ruleOnsets(r, year)) {
      if (onset <= utcMs && onset > bestOnset) { bestOnset = onset; best = r; }
    }
  }
  if (!best) best = vtz.rules.find((r) => r.type === 'STANDARD') || vtz.rules[0];
  return best.offsetTo || 0;
}

/** Wall-clock time in a zone -> UTC milliseconds. */
export function wallToUtc(w, zone) {
  const h = w.h || 0, mi = w.mi || 0, s = w.s || 0;
  if (!zone || zone.kind === 'floating') return new Date(w.y, w.m - 1, w.d, h, mi, s).getTime();
  const guess = Date.UTC(w.y, w.m - 1, w.d, h, mi, s);
  if (zone.kind === 'utc') return guess;
  const off = zone.kind === 'iana' ? (t) => ianaOffset(t, zone.tz) : (t) => vtzOffset(t, zone.vtz);
  const o1 = off(guess);
  let utc = guess - o1;
  const o2 = off(utc);
  if (o2 !== o1) utc = guess - o2;
  return utc;
}

// ───────────────────────── import: recurrence ─────────────────────────

function addDaysWall(w, n) {
  const t = new Date(Date.UTC(w.y, w.m - 1, w.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
const dow = (w) => dowYMD(w.y, w.m, w.d);
function addMonths(y, m, k) {
  const t = y * 12 + (m - 1) + k;
  return { y: Math.floor(t / 12), m: (t % 12) + 1 };
}

function monthDays(y, m, r, start) {
  const dim = daysInMonth(y, m);
  let days = [];
  if (r.byday && r.byday.length) {
    for (const b of r.byday) {
      if (b.n) { const d = nthWeekday(y, m, b.wd, b.n); if (d) days.push(d); }
      else for (let d = 1; d <= dim; d++) if (dowYMD(y, m, d) === b.wd) days.push(d);
    }
    if (r.bymonthday && r.bymonthday.length) {
      const md = r.bymonthday.map((n) => (n > 0 ? n : dim + 1 + n));
      days = days.filter((d) => md.includes(d));
    }
  } else if (r.bymonthday && r.bymonthday.length) {
    days = r.bymonthday.map((n) => (n > 0 ? n : dim + 1 + n)).filter((d) => d >= 1 && d <= dim);
  } else {
    days = start.d <= dim ? [start.d] : [];
  }
  days = [...new Set(days)].sort((a, b) => a - b);
  if (r.bysetpos && r.bysetpos.length) {
    const sel = [];
    for (const p of r.bysetpos) {
      const d = p > 0 ? days[p - 1] : days[days.length + p];
      if (d) sel.push(d);
    }
    days = [...new Set(sel)].sort((a, b) => a - b);
  }
  return days;
}

function untilToMs(v, zone) {
  const d = parseDT(v);
  if (!d) return Infinity;
  if (d.dateOnly) return wallToUtc({ ...d, h: 23, mi: 59, s: 59 }, zone);
  if (d.tz === 'UTC') return Date.UTC(d.y, d.m - 1, d.d, d.h, d.mi, d.s);
  return wallToUtc(d, zone);
}

/** Expand an RRULE into wall-clock starts (chronological), bounded by COUNT/UNTIL/endMs/cap. */
export function expandRule(start, r, zone, endMs, cap = 3000, fromMs = -Infinity, durMs = 0) {
  const out = [];
  const startMs = wallToUtc(start, zone);
  const until = r.until ? untilToMs(r.until, zone) : Infinity;
  const time = { h: start.h, mi: start.mi, s: start.s };
  const DAY = 86400000;
  const dayMs = (d) => Date.UTC(d.y, d.m - 1, d.d);
  const tooFar = (d) => dayMs(d) > endMs + 2 * DAY || dayMs(d) > until + 2 * DAY;
  const startDay = dayMs(start);
  let produced = 0;
  // Occurrences that ended before the window still count toward COUNT, but are not kept
  // (and don't use up the cap) — long-running series starting years ago still import.
  const emit = (w) => {
    const dm = dayMs(w);
    if (dm > startDay + 2 * DAY && dm + 2 * DAY < fromMs - durMs && dm + 2 * DAY < until) {
      produced++; // clearly after DTSTART and clearly before the window: no time-zone math needed
      return !(r.count && produced >= r.count);
    }
    const ms = wallToUtc(w, zone);
    if (ms < startMs) return true;
    if (ms > until || ms > endMs) return false;
    produced++;
    if (ms + durMs > fromMs) out.push(w);
    if (r.count && produced >= r.count) return false;
    return out.length < cap;
  };
  const interval = r.interval || 1;
  let guard = 0;
  switch (r.freq) {
    case 'DAILY':
      for (let i = 0; guard++ < 200000; i += interval) {
        const d = addDaysWall(start, i);
        if (tooFar(d)) break;
        if (r.bymonth && !r.bymonth.includes(d.m)) continue;
        if (r.byday && r.byday.length && !r.byday.some((b) => b.wd === dow(d))) continue;
        if (r.bymonthday && r.bymonthday.length) {
          const dim = daysInMonth(d.y, d.m);
          if (!r.bymonthday.some((n) => (n > 0 ? n : dim + 1 + n) === d.d)) continue;
        }
        if (!emit({ ...d, ...time })) break;
      }
      break;
    case 'WEEKLY': {
      const wkst = r.wkst ?? 1;
      const days = [...new Set(r.byday && r.byday.length ? r.byday.map((b) => b.wd) : [dow(start)])]
        .sort((a, b) => ((a - wkst + 7) % 7) - ((b - wkst + 7) % 7));
      const week0 = addDaysWall(start, -((dow(start) - wkst + 7) % 7));
      outer: for (let w = 0; guard++ < 40000; w += interval) {
        const ws = addDaysWall(week0, w * 7);
        if (tooFar(ws)) break;
        for (const wd of days) {
          const d = addDaysWall(ws, (wd - wkst + 7) % 7);
          if (r.bymonth && !r.bymonth.includes(d.m)) continue;
          if (!emit({ ...d, ...time })) break outer;
        }
      }
      break;
    }
    case 'MONTHLY':
      outerM: for (let k = 0; guard++ < 5000; k += interval) {
        const ym = addMonths(start.y, start.m, k);
        if (tooFar({ y: ym.y, m: ym.m, d: 1 })) break;
        if (r.bymonth && !r.bymonth.includes(ym.m)) continue;
        for (const day of monthDays(ym.y, ym.m, r, start)) {
          if (!emit({ y: ym.y, m: ym.m, d: day, ...time })) break outerM;
        }
      }
      break;
    case 'YEARLY':
      outerY: for (let k = 0; guard++ < 500; k += interval) {
        const y = start.y + k;
        if (tooFar({ y, m: 1, d: 1 })) break;
        const months = r.bymonth && r.bymonth.length ? [...r.bymonth].sort((a, b) => a - b) : [start.m];
        for (const m of months) {
          const days = (r.byday && r.byday.length) || (r.bymonthday && r.bymonthday.length)
            ? monthDays(y, m, r, start) : (start.d <= daysInMonth(y, m) ? [start.d] : []);
          for (const day of days) {
            if (!emit({ y, m, d: day, ...time })) break outerY;
          }
        }
      }
      break;
    default:
      emit({ ...start });
  }
  return out;
}

const keyOfWall = (w) => `${w.y}-${pad(w.m)}-${pad(w.d)}`;

/**
 * Expand parsed events into concrete instances overlapping [from, to].
 * Skips cancelled and "free" events; all-day events only when includeAllDay.
 * @returns {Array<{uid:string,title:string,start:Date,end:Date,allDay:boolean}>}
 */
export function expandEvents(cal, { from, to, includeAllDay = false, cap = 5000 } = {}) {
  const fromMs = from.getTime(), toMs = to.getTime();
  const masters = [], overrides = [];
  for (const ev of cal.events) {
    if (!ev.start) continue;
    (ev.recurrenceId ? overrides : masters).push(ev);
  }
  const isFree = (ev) => ev.status === 'CANCELLED' || ev.transp === 'TRANSPARENT' || ev.msBusy === 'FREE';
  const out = [];

  const durationOf = (ev, zone, startMs) => {
    if (ev.end) {
      const endZone = ev.end.tz ? resolveZone(ev.end.tz, cal) : zone;
      if (ev.start.dateOnly || ev.end.dateOnly) return Date.UTC(ev.end.y, ev.end.m - 1, ev.end.d) - Date.UTC(ev.start.y, ev.start.m - 1, ev.start.d);
      return wallToUtc(ev.end, endZone) - startMs;
    }
    if (ev.duration !== undefined && ev.duration !== null) return ev.duration;
    return ev.start.dateOnly ? 86400000 : 0;
  };

  const pushInstance = (ev, wall, zone, durMs) => {
    if (out.length >= cap) return;
    if (ev.start.dateOnly) {
      if (!includeAllDay) return;
      const s = new Date(wall.y, wall.m - 1, wall.d);
      const days = Math.max(1, Math.round(durMs / 86400000));
      const e = new Date(wall.y, wall.m - 1, wall.d + days);
      if (e.getTime() <= fromMs || s.getTime() >= toMs) return;
      out.push({ uid: ev.uid || '', title: ev.summary || 'Busy', start: s, end: e, allDay: true });
      return;
    }
    const sMs = wallToUtc(wall, zone);
    const eMs = sMs + Math.max(0, durMs);
    if (eMs <= sMs || eMs <= fromMs || sMs >= toMs) return;
    out.push({ uid: ev.uid || '', title: ev.summary || 'Busy', start: new Date(sMs), end: new Date(eMs), allDay: false });
  };

  // overrides by uid -> set of replaced original starts
  const replaced = new Map();
  for (const o of overrides) {
    const master = masters.find((m) => m.uid === o.uid);
    const mzone = master ? resolveZone(master.start.tz, cal) : resolveZone(o.recurrenceId.tz, cal);
    const rzone = o.recurrenceId.tz ? resolveZone(o.recurrenceId.tz, cal) : mzone;
    let key;
    if (o.recurrenceId.dateOnly) key = 'D' + keyOfWall(o.recurrenceId);
    else key = 'T' + wallToUtc(o.recurrenceId, rzone);
    if (!replaced.has(o.uid)) replaced.set(o.uid, new Set());
    replaced.get(o.uid).add(key);
    if (!isFree(o)) {
      const zone = resolveZone(o.start.tz, cal);
      const sMs = o.start.dateOnly ? 0 : wallToUtc(o.start, zone);
      pushInstance(o, o.start, zone, durationOf(o, zone, sMs));
    }
  }

  for (const ev of masters) {
    if (isFree(ev)) continue;
    const zone = resolveZone(ev.start.tz, cal);
    const startMs = ev.start.dateOnly ? new Date(ev.start.y, ev.start.m - 1, ev.start.d).getTime() : wallToUtc(ev.start, zone);
    const durMs = durationOf(ev, zone, startMs);
    const exT = new Set(), exD = new Set();
    for (const x of ev.exdates) {
      if (x.dateOnly) exD.add(keyOfWall(x));
      else exT.add(wallToUtc(x, x.tz ? resolveZone(x.tz, cal) : zone));
    }
    const rep = replaced.get(ev.uid) || new Set();
    const skip = (w) => {
      if (exD.has(keyOfWall(w)) || rep.has('D' + keyOfWall(w))) return true;
      if (!ev.start.dateOnly) {
        const ms = wallToUtc(w, zone);
        if (exT.has(ms) || rep.has('T' + ms)) return true;
      }
      return false;
    };
    let walls;
    if (ev.rrule && ev.rrule.freq) walls = expandRule(ev.start, ev.rrule, zone, toMs + Math.abs(durMs), 3000, fromMs, Math.max(0, durMs));
    else walls = [ev.start];
    for (const d of ev.rdates) walls.push(d.dateOnly ? { ...d, h: ev.start.h, mi: ev.start.mi, s: ev.start.s } : d);
    for (const w of walls) {
      if (skip(w)) continue;
      // cheap prefilter: instances ending before the window are dropped in pushInstance
      pushInstance(ev, w, zone, durMs);
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** Instances -> EnergyMap busy items, split at local midnight. */
export function instancesToBusy(instances, { sourceId = null, idPrefix = 'b' } = {}) {
  const items = [];
  let n = 0;
  for (const ins of instances) {
    let cur = new Date(ins.start);
    const end = ins.end;
    let guard = 0;
    while (cur < end && guard++ < 400) {
      const key = dateKey(cur);
      const startMin = minutesOf(cur);
      const nextMidnight = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
      const segEnd = end < nextMidnight ? end : nextMidnight;
      const endMin = segEnd.getTime() === nextMidnight.getTime() ? DAY_MIN : minutesOf(segEnd);
      if (endMin > startMin) {
        items.push({ id: `${idPrefix}${Date.now().toString(36)}${(n++).toString(36)}`, title: ins.title, date: key, start: startMin, end: endMin, sourceId, allDay: !!ins.allDay });
      }
      cur = nextMidnight;
    }
  }
  return items;
}
