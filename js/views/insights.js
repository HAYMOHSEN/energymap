// EnergyMap — Insights: completed work by energy, alignment with your map, completion rate.

import { getState } from '../state.js';
import * as A from '../actions.js';
import { LEVELS, LEVEL_INFO, levelFor, isWorkDay } from '../scheduler.js';
import {
  todayKey, addDays, weekKeys, fmtWeekdayShort, fmtMonthDay, fmtDayMed, fmtHours, fmtDuration, minutesOf, cmpKM, diffDays, dateKey,
} from '../time.js';
import { esc, icon, LEVEL_ICON, showTip, hideTip, $, $$ } from '../ui.js';

let root = null;
const st = { range: '7', table: false };
const lv = (l) => `lvl-${l}`;

export function mount(el) {
  root = el;
  root.innerHTML = `<div class="view"><div class="view-scroll"><div class="view-inner">
    <div class="page-head"><div class="grow"><h1>Insights</h1><p>How your finished work lines up with your energy.</p></div></div>
    <div class="toolbar"><div class="seg" role="group" aria-label="Period" id="irange">
      <button type="button" data-r="week">This week</button><button type="button" data-r="7">Last 7 days</button><button type="button" data-r="30">Last 30 days</button>
    </div></div>
    <div id="ibody"></div>
  </div></div></div>`;
  $('#irange', root).addEventListener('click', (e) => { const b = e.target.closest('[data-r]'); if (b) { st.range = b.dataset.r; update(); } });
  root.addEventListener('click', (e) => { if (e.target.closest('[data-act="table"]')) { st.table = !st.table; update(); } });
  update();
}

export function unmount() { hideTip(); root = null; }

function rangeDays(s) {
  const t = todayKey();
  if (st.range === 'week') return weekKeys(t, s.settings.weekStart);
  const n = st.range === '30' ? 30 : 7;
  return Array.from({ length: n }, (_, i) => addDays(t, i - n + 1));
}

export function computeInsights(s, days) {
  const set = new Set(days);
  const n = new Date(), nk = todayKey(n), nm = minutesOf(n);
  const perDay = new Map(days.map((d) => [d, { peak: 0, steady: 0, low: 0 }]));
  const align = { peak: { m: 0, ok: 0 }, steady: { m: 0, ok: 0 }, low: { m: 0, ok: 0 } };
  let doneCount = 0, focusMins = 0;
  const doneIds = new Set();
  for (const t of s.tasks) {
    if (t.doneAt && set.has(dateKey(new Date(t.doneAt)))) { doneCount++; doneIds.add(t.id); }
  }
  for (const b of s.blocks) {
    if (!set.has(b.date)) continue;
    const t = A.taskById(s, b.taskId);
    if (!t || !t.doneAt) continue;
    const mins = b.end - b.start;
    perDay.get(b.date)[t.load] += mins;
    focusMins += mins;
    const lvl = isWorkDay(b.date, s.settings) ? levelFor(s.profile.phases, b.start, b.end) : null;
    align[t.load].m += mins;
    if (lvl === t.load) align[t.load].ok += mins;
  }
  // completion: tasks whose scheduled time in range is over
  let due = 0, finished = 0;
  for (const t of s.tasks) {
    const own = s.blocks.filter((b) => b.taskId === t.id && set.has(b.date));
    if (!own.length) continue;
    if (!own.every((b) => cmpKM(b.date, b.end, nk, nm) <= 0) && !t.doneAt) continue;
    due++;
    if (t.doneAt) finished++;
  }
  const allMins = align.peak.m + align.steady.m + align.low.m;
  const okMins = align.peak.ok + align.steady.ok + align.low.ok;
  const backlog = [...A.backlogTasks(s, n), ...A.missedTasks(s, n)];
  const oldest = backlog.reduce((m, t) => Math.max(m, diffDays(dateKey(new Date(t.createdAt || n)), nk)), 0);
  return { perDay, align, doneCount, focusMins, due, finished, alignPct: allMins ? Math.round((okMins / allMins) * 100) : null, backlog: backlog.length, oldest };
}

export function update() {
  if (!root) return;
  const s = getState();
  $$('#irange [data-r]', root).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.r === st.range)));
  const days = rangeDays(s);
  const r = computeInsights(s, days);
  const body = $('#ibody', root);
  const any = r.doneCount || r.due;
  body.innerHTML = `
    <div class="tiles">
      <div class="card tile"><div class="k">Tasks completed</div><div class="v">${r.doneCount}</div><div class="s">${r.focusMins ? `${fmtHours(r.focusMins)} of planned work done` : 'Mark tasks done to see them here'}</div></div>
      <div class="card tile"><div class="k">Energy alignment</div><div class="v">${r.alignPct === null ? '—' : r.alignPct + '%'}</div><div class="s">of finished work happened in matching energy</div></div>
      <div class="card tile"><div class="k">Completion rate</div><div class="v">${r.due ? Math.round((r.finished / r.due) * 100) + '%' : '—'}</div><div class="s">${r.due ? `${r.finished} of ${r.due} planned tasks done` : 'No planned tasks have ended yet'}</div></div>
      <div class="card tile"><div class="k">Backlog</div><div class="v">${r.backlog}</div><div class="s">${r.backlog ? `oldest waiting ${r.oldest} day${r.oldest === 1 ? '' : 's'}` : 'All caught up'}</div></div>
    </div>
    <div class="card chart-card" style="margin-top:14px" id="ichart"></div>
    <div class="card chart-card" style="margin-top:14px" id="ialign"></div>`;
  renderColumns(s, days, r, any);
  renderAlign(r);
}

function renderColumns(s, days, r, any) {
  const el = $('#ichart', root);
  const rows = days.map((d) => ({ d, ...r.perDay.get(d) }));
  const max = Math.max(60, ...rows.map((x) => x.peak + x.steady + x.low));
  const stepH = max > 8 * 60 ? 120 : 60;
  const yMax = Math.ceil(max / stepH) * stepH;
  const W = 1000, H = 260, L = 44, R = 10, TOP = 12, B = 34;
  const band = (W - L - R) / days.length;
  const bw = Math.min(24, band * 0.6);
  const y = (m) => TOP + (1 - m / yMax) * (H - TOP - B);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Completed work by day, hours, stacked by energy">`;
  svg += '<g class="axis">';
  for (let m = 0; m <= yMax; m += stepH) svg += `<line class="${m ? 'gridline' : 'baseline'}" x1="${L}" x2="${W - R}" y1="${y(m)}" y2="${y(m)}"/><text x="${L - 8}" y="${y(m) + 4}" text-anchor="end">${m / 60}h</text>`;
  const every = days.length > 14 ? 5 : 1;
  rows.forEach((x, i) => {
    if (i % every && i !== rows.length - 1) return;
    const cx = L + band * i + band / 2;
    svg += `<text x="${cx}" y="${H - 12}" text-anchor="middle">${esc(days.length > 7 ? fmtMonthDay(x.d) : fmtWeekdayShort(x.d))}</text>`;
  });
  svg += '</g>';
  rows.forEach((x, i) => {
    const cx = L + band * i + band / 2;
    let acc = 0;
    const segs = LEVELS.filter((l) => x[l] > 0);
    segs.forEach((l, k) => {
      const y1 = y(acc + x[l]), y0 = y(acc);
      const h = Math.max(0, y0 - y1 - (k > 0 ? 2 : 0)); // 2px surface gap between stacked segments
      const top = k === segs.length - 1;
      const rx = top ? Math.min(4, h / 2) : 0;
      // rounded data-end on top only, square at the baseline
      svg += `<path class="${lv(l)}" fill="var(--lvl)" d="M${cx - bw / 2},${y0 - (k > 0 ? 2 : 0)} V${y1 + rx} Q${cx - bw / 2},${y1} ${cx - bw / 2 + rx},${y1} H${cx + bw / 2 - rx} Q${cx + bw / 2},${y1} ${cx + bw / 2},${y1 + rx} V${y0 - (k > 0 ? 2 : 0)} Z"/>`;
      acc += x[l];
    });
    svg += `<rect class="hit" data-i="${i}" x="${cx - band / 2}" y="${TOP}" width="${band}" height="${H - TOP - B}" tabindex="0" aria-label="${esc(fmtDayMed(x.d))}: ${LEVELS.map((l) => `${LEVEL_INFO[l].name} ${fmtDuration(x[l])}`).join(', ')}"/>`;
  });
  svg += '</svg>';
  el.innerHTML = `<div class="chart-head"><div class="grow"><h3>Completed work by day</h3><div class="sub">Hours of finished task blocks, by the energy each task needed.</div></div>
      <button class="btn small ghost" data-act="table" aria-pressed="${st.table}">${st.table ? 'Show chart' : 'Show table'}</button></div>
    ${!any ? '<p class="hint" style="margin-bottom:8px">No finished work in this period yet — mark tasks done from the plan and they’ll appear here.</p>' : ''}
    ${st.table ? `<table class="data-table"><thead><tr><th>Day</th>${LEVELS.map((l) => `<th>${LEVEL_INFO[l].name}</th>`).join('')}<th>Total</th></tr></thead><tbody>
      ${rows.map((x) => `<tr><td>${esc(fmtDayMed(x.d))}</td>${LEVELS.map((l) => `<td>${fmtDuration(x[l])}</td>`).join('')}<td>${fmtDuration(x.peak + x.steady + x.low)}</td></tr>`).join('')}</tbody></table>`
      : `<div class="chart-legend" style="margin:0 0 6px">${LEVELS.map((l) => `<span class="${lv(l)}"><i></i>${LEVEL_INFO[l].name}</span>`).join('')}</div><div class="chart">${svg}</div>`}`;
  $$('.hit', el).forEach((h) => {
    const x = rows[+h.dataset.i];
    const html = `<div class="tt-h">${esc(fmtDayMed(x.d))}</div>${LEVELS.map((l) => `<div class="tt-r ${lv(l)}"><i></i>${LEVEL_INFO[l].name}<b>${fmtDuration(x[l])}</b></div>`).join('')}<div class="tt-r"><i style="background:transparent"></i>Total<b>${fmtDuration(x.peak + x.steady + x.low)}</b></div>`;
    h.addEventListener('pointermove', (ev) => showTip(html, ev.clientX, ev.clientY));
    h.addEventListener('pointerleave', hideTip);
    h.addEventListener('focus', () => { const b = h.getBoundingClientRect(); showTip(html, b.left + b.width / 2, b.top + 30); });
    h.addEventListener('blur', hideTip);
  });
}

function renderAlign(r) {
  const el = $('#ialign', root);
  el.innerHTML = `<div class="chart-head"><div class="grow"><h3>Did work happen in the right energy?</h3>
    <div class="sub">Share of finished minutes that ran in a phase matching the task’s energy.</div></div></div>
    <div style="display:grid;gap:12px;margin-top:4px">
    ${LEVELS.map((l) => {
      const a = r.align[l];
      const pct = a.m ? Math.round((a.ok / a.m) * 100) : null;
      return `<div class="${lv(l)}" style="display:grid;grid-template-columns:150px 1fr 120px;gap:12px;align-items:center">
        <span style="display:flex;align-items:center;gap:7px;font-weight:600">${icon(LEVEL_ICON[l]).replace('<svg', '<svg style="width:16px;height:16px;color:var(--lvl)"')}${LEVEL_INFO[l].name} tasks</span>
        <span style="height:10px;border-radius:5px;background:var(--lvl-wash);overflow:hidden" role="img" aria-label="${pct === null ? 'No data' : pct + '%'}"><i style="display:block;height:100%;width:${pct || 0}%;background:var(--lvl);border-radius:5px"></i></span>
        <span style="font-variant-numeric:tabular-nums;color:var(--text-2);font-size:13px">${pct === null ? 'No data yet' : `<b style="color:var(--text)">${pct}%</b> of ${fmtDuration(a.m)}`}</span></div>`;
    }).join('')}</div>
    <p class="hint" style="margin-top:12px">Tip: if a level is often off, adjust your phases in <b>Energy</b> or let Auto-plan place those tasks.</p>`;
}
