// EnergyMap — quick-add parser.
// "Write Q3 report 90m #peak by fri 3pm !!"  ->  title, duration, energy, deadline, priority
// Pure function; recognised tokens are removed from the title.

import { addDays, todayKey, weekday, makeDeadline, isValidKey, pad, DAY_MIN } from './time.js';

const LOAD_WORDS = {
  peak: 'peak', deep: 'peak', focus: 'peak', hard: 'peak',
  steady: 'steady', routine: 'steady', medium: 'steady', normal: 'steady',
  low: 'low', admin: 'low', light: 'low', easy: 'low',
};

const DAY_WORDS = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DAY_RE = '(?:today|tonight|tomorrow|tmrw|tmr|next week|sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:rs?(?:day)?)?|fri(?:day)?|sat(?:urday)?)';
const DATE_RE = `(?:${DAY_RE}|${MONTH_RE}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?|\\d{4}-\\d{2}-\\d{2})`;
const TIME_RE = '(\\d{1,2}(?::\\d{2})?\\s?(?:am|pm)?|noon|midnight)';

function monthIndex(word) {
  return MONTHS.indexOf(word.toLowerCase().slice(0, 3));
}

function resolveDate(word, now) {
  const w = word.toLowerCase().replace(/\./g, '').trim();
  const today = todayKey(now);
  if (w === 'today' || w === 'tonight') return today;
  if (w === 'tomorrow' || w === 'tmrw' || w === 'tmr') return addDays(today, 1);
  if (w === 'next week') return addDays(today, 7);
  if (w in DAY_WORDS) {
    const diff = (DAY_WORDS[w] - weekday(today) + 7) % 7;
    return addDays(today, diff);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) return isValidKey(w) ? w : null;
  let m = /^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?$/.exec(w) || null;
  let mi, d;
  if (m) { mi = monthIndex(m[1]); d = +m[2]; } else {
    m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)$/.exec(w);
    if (m) { d = +m[1]; mi = monthIndex(m[2]); }
  }
  if (m && mi >= 0) {
    let y = now.getFullYear();
    let key = `${y}-${pad(mi + 1)}-${pad(d)}`;
    if (!isValidKey(key)) return null;
    if (key < addDays(today, -1)) { y += 1; key = `${y}-${pad(mi + 1)}-${pad(d)}`; }
    return isValidKey(key) ? key : null;
  }
  return null;
}

function resolveTime(s) {
  if (!s) return null;
  const t = s.toLowerCase().replace(/\s+/g, '');
  if (t === 'noon') return 12 * 60;
  if (t === 'midnight') return DAY_MIN - 1;
  const m = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(t);
  if (!m) return null;
  let h = +m[1];
  const mi = m[2] ? +m[2] : 0;
  if (mi > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    if (m[3] === 'pm' && h !== 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
  } else if (!m[2] && h >= 1 && h <= 7) {
    h += 12; // "by fri 5" -> 5 PM
  }
  if (h > 23) return null;
  return h * 60 + mi;
}

/**
 * @returns {{title:string, durationMins?:number, load?:string, deadline?:string, priority?:string,
 *            splittable?:boolean, found:string[]}}
 */
export function parseQuickAdd(text, now = new Date()) {
  let s = ` ${String(text || '')} `;
  const out = { found: [] };
  const take = (re, fn) => {
    const m = re.exec(s);
    if (!m) return false;
    const ok = fn(m);
    if (ok !== false) s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
    return ok !== false;
  };

  // Deadline: "by fri", "due tomorrow 5pm", "before oct 12 at 9:30"
  take(new RegExp(`\\s(?:by|due|before)\\s+(${DATE_RE})(?:\\s+(?:at\\s+)?${TIME_RE})?(?=[\\s,.;!]|$)`, 'i'), (m) => {
    const key = resolveDate(m[1], now);
    if (!key) return false;
    let min = m[2] ? resolveTime(m[2]) : null;
    if (m[2] && min === null) return false;
    if (/^tonight$/i.test(m[1]) && min === null) min = DAY_MIN - 1;
    out.deadline = makeDeadline(key, min === null ? DAY_MIN - 1 : min);
    out.found.push('deadline');
  });

  // Duration: "1h30", "1h 30m", "1.5h", "90m", "45 min"
  take(/\s(\d{1,2})\s?h(?:rs?|ours?)?\s?(\d{1,2})\s?(?:m|min|mins|minutes?)?(?=\s)/i, (m) => {
    out.durationMins = +m[1] * 60 + +m[2];
  }) ||
  take(/\s(\d{1,2}(?:[.,]\d{1,2})?)\s?(?:h|hr|hrs|hour|hours)(?=\s)/i, (m) => {
    out.durationMins = Math.round(parseFloat(m[1].replace(',', '.')) * 60);
  }) ||
  take(/\s(\d{1,3})\s?(?:m|min|mins|minute|minutes)(?=\s)/i, (m) => {
    out.durationMins = +m[1];
  });
  if (out.durationMins !== undefined) {
    out.durationMins = Math.min(720, Math.max(5, Math.round(out.durationMins / 5) * 5));
    out.found.push('duration');
  }

  // Energy: "#peak", "!deep", "@admin"
  take(/\s[#!@](peak|deep|focus|hard|steady|routine|medium|normal|low|admin|light|easy)(?=[\s,.;]|$)/i, (m) => {
    out.load = LOAD_WORDS[m[1].toLowerCase()];
    out.found.push('load');
  });

  // Priority: "!!", "!high", "#urgent", "#important"
  take(/\s(?:!!+|[#!](?:high|urgent|important|priority))(?=[\s,.;]|$)/i, () => {
    out.priority = 'high';
    out.found.push('priority');
  });

  // Splitting: "#split"
  take(/\s#split(?=[\s,.;]|$)/i, () => {
    out.splittable = true;
    out.found.push('split');
  });

  out.title = s.replace(/\s+/g, ' ').replace(/\s+([,.;:])/g, '$1').replace(/^[\s,.;:–-]+|[\s,;:–-]+$/g, '').trim();
  return out;
}
