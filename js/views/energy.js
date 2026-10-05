// EnergyMap — Energy view: the daily energy map, presets, phase editor and learning from check-ins.

import { undoFn } from '../undo.js';
import { getState, undo, uid } from '../state.js';
import * as A from '../actions.js';
import { LEVELS, LEVEL_INFO, PRESETS, normalizePhases, validatePhases, minutesByLevel, phaseAt } from '../scheduler.js';
import { fmtTime, fmtHours, toHM, parseHM, DAY_MIN, minutesOf, todayKey } from '../time.js';
import { esc, icon, LEVEL_ICON, toast, showTip, hideTip, confirmDialog, focusKey, refocus, $, $$ } from '../ui.js';
import { openCheckin } from './dialogs.js';

let root = null;
let showTable = false;

const T = (m) => fmtTime(m, getState().settings.h12);
const Tc = (m) => fmtTime(m, getState().settings.h12, { compact: true });
const lv = (l) => `lvl-${l}`;

export function mount(el) {
  root = el;
  root.innerHTML = `<div class="view"><div class="view-scroll"><div class="view-inner">
    <div class="page-head"><div class="grow"><h1>Your energy map</h1><p>When you’re at your best. EnergyMap plans deep work into your peaks and admin into your dips.</p></div>
      <button class="btn" data-act="checkin">${icon('battery')}Check-in</button></div>
    <div class="card emap" id="emap"></div>
    <div class="section-title">Start from a rhythm</div>
    <div class="presets" id="presets"></div>
    <div class="section-title" style="display:flex;align-items:center;gap:8px">Phases <span style="flex:1"></span>
      <button class="btn small" data-act="shift" data-d="-30" title="Move every phase 30 minutes earlier">${icon('chevron-left')}30 min earlier</button>
      <button class="btn small" data-act="shift" data-d="30" title="Move every phase 30 minutes later">30 min later${icon('chevron-right')}</button>
      <button class="btn small primary" data-act="add-phase">${icon('plus')}Add phase</button></div>
    <div class="card" id="phases"></div>
    <div class="section-title">Learn from your check-ins</div>
    <div class="card chart-card" id="learn"></div>
  </div></div></div>`;
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  // time fields: save when the user leaves the field (Chrome fires "change" on every typed segment)
  root.addEventListener('focusout', (e) => {
    // commit after focus has moved, so the re-render keeps focus where the user went (Tab, click)
    if (e.target.matches && e.target.matches('.phase-row input[type="time"]')) { const t = e.target; setTimeout(() => commitPhaseInput(t), 0); }
  });
  root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches && e.target.matches('.phase-row input')) { e.preventDefault(); e.target.blur(); } });
  update();
}

export function unmount() { hideTip(); root = null; }

export function update() {
  if (!root) return;
  const s = getState();
  const fk = focusKey(root);
  renderMap(s);
  renderPresets(s);
  renderPhases(s);
  renderLearn(s);
  refocus(root, fk);
}

// ───────────── energy map chart ─────────────
function renderMap(s) {
  const el = $('#emap', root);
  const ph = normalizePhases(s.profile.phases);
  const lo = ph.length ? Math.max(0, Math.floor(Math.min(...ph.map((p) => p.start)) / 60) * 60 - 60) : 6 * 60;
  const hi = ph.length ? Math.min(DAY_MIN, Math.ceil(Math.max(...ph.map((p) => p.end)) / 60) * 60 + 60) : 20 * 60;
  const W = 1000, rowH = 34, gap = 10, top = 8, left = 64, H = top + 3 * (rowH + gap) + 26;
  const x = (m) => left + ((m - lo) / (hi - lo)) * (W - left - 8);
  const rows = { peak: 0, steady: 1, low: 2 };
  const y = (l) => top + rows[l] * (rowH + gap);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Energy map: ${ph.map((p) => `${LEVEL_INFO[p.level].name} ${T(p.start)} to ${T(p.end)}`).join('; ')}">`;
  // gridlines + axis
  svg += '<g class="axis">';
  const step = hi - lo > 12 * 60 ? 120 : 60;
  for (let m = Math.ceil(lo / step) * step; m <= hi; m += step) {
    svg += `<line class="gridline" x1="${x(m)}" x2="${x(m)}" y1="${top - 4}" y2="${H - 22}"/>`;
    svg += `<text x="${x(m)}" y="${H - 6}" text-anchor="middle">${esc(Tc(m))}</text>`;
  }
  for (const l of LEVELS) svg += `<text x="0" y="${y(l) + rowH / 2 + 4}">${LEVEL_INFO[l].name}</text>`;
  svg += '</g>';
  for (const l of LEVELS) svg += `<rect x="${left}" y="${y(l)}" width="${W - left - 8}" height="${rowH}" rx="6" fill="var(--panel-2)"/>`;
  for (const p of ph) {
    const x1 = x(p.start), x2 = x(p.end), w = Math.max(2, x2 - x1 - 2);
    svg += `<g class="${lv(p.level)}"><rect x="${x1 + 1}" y="${y(p.level)}" width="${w}" height="${rowH}" rx="6" fill="var(--lvl)" fill-opacity="0.24"><title>${esc(LEVEL_INFO[p.level].name)} · ${esc(p.label || '')} · ${esc(T(p.start))}–${esc(T(p.end))}</title></rect>`;
    svg += `<rect x="${x1 + 1}" y="${y(p.level)}" width="4" height="${rowH}" rx="2" fill="var(--lvl)"/>`;
    const fits = (t) => w > t.length * 6.6 + 18;
    const label = [p.label, LEVEL_INFO[p.level].name].find((t) => t && fits(t));
    if (label) svg += `<text x="${x1 + 12}" y="${y(p.level) + rowH / 2 + 4}" font-size="12" font-weight="600" fill="var(--text)">${esc(label)}</text>`;
    svg += '</g>';
  }
  const n = new Date();
  if (s.settings.workDays.includes(n.getDay())) {
    const nm = minutesOf(n);
    if (nm > lo && nm < hi) svg += `<line x1="${x(nm)}" x2="${x(nm)}" y1="${top - 6}" y2="${H - 22}" stroke="var(--now)" stroke-width="2"/><circle cx="${x(nm)}" cy="${top - 6}" r="4" fill="var(--now)"/>`;
  }
  svg += '</svg>';
  const mins = minutesByLevel(ph);
  const days = s.settings.workDays.length;
  el.innerHTML = `<div class="emap-chart">${svg}</div>
    <div class="legend">${LEVELS.map((l) => `<span class="${lv(l)}"><i></i>${LEVEL_INFO[l].name} — ${esc(LEVEL_INFO[l].hint.toLowerCase())}</span>`).join('')}<span style="margin-left:auto;color:var(--muted)">Red line: now</span></div>
    <div class="tiles" style="margin-top:16px">
      ${LEVELS.map((l) => `<div class="tile card ${lv(l)}" style="box-shadow:none"><div class="k" style="display:flex;align-items:center;gap:6px">${icon(LEVEL_ICON[l]).replace('<svg', '<svg style="width:15px;height:15px;color:var(--lvl)"')}${LEVEL_INFO[l].name} time</div>
        <div class="v">${fmtHours(mins[l] * days)}</div><div class="s">${fmtHours(mins[l])} a day × ${days} work day${days === 1 ? '' : 's'}</div></div>`).join('')}
      <div class="tile card" style="box-shadow:none"><div class="k">Planned break buffer</div><div class="v">${s.settings.bufferMins} min</div><div class="s">between tasks · change in Settings</div></div>
    </div>`;
}

// ───────────── presets ─────────────
function renderPresets(s) {
  const el = $('#presets', root);
  el.innerHTML = Object.entries(PRESETS).map(([k, p]) => {
    const lo = 6 * 60, hi = 21 * 60;
    const segs = normalizePhases(p.phases);
    let bar = '', cur = lo;
    for (const ph of segs) {
      if (ph.start > cur) bar += `<i style="width:${((ph.start - cur) / (hi - lo)) * 100}%;background:transparent"></i>`;
      bar += `<i class="${lv(ph.level)}" style="width:${((ph.end - ph.start) / (hi - lo)) * 100}%"></i>`;
      cur = ph.end;
    }
    return `<button type="button" class="preset" data-act="preset" data-k="${k}" aria-pressed="${s.profile.preset === k}">
      <h3>${esc(p.name)}${s.profile.preset === k ? `<span class="hint" style="font-weight:600">· current</span>` : ''}</h3>
      <div class="mini" aria-hidden="true">${bar}</div>
      <p>${esc(p.desc)} ${esc(Tc(segs[0].start))} – ${esc(Tc(segs[segs.length - 1].end))}.</p></button>`;
  }).join('');
}

// ───────────── phase editor ─────────────
function renderPhases(s) {
  const el = $('#phases', root);
  const ph = [...s.profile.phases].sort((a, b) => a.start - b.start);
  const problems = validatePhases(ph);
  const byIndex = new Map(problems.map((p) => [p.index, p.message]));
  if (!ph.length) {
    el.innerHTML = `<div class="empty">${icon('energy')}<strong>No phases yet</strong>Pick a rhythm above or add a phase.</div>`;
    return;
  }
  el.innerHTML = `<div class="phase-table">
    <div class="phase-row phase-head" aria-hidden="true"><span>From</span><span></span><span>To</span><span>Energy</span><span class="lbl">Name</span><span></span></div>
    ${ph.map((p, i) => `<div class="phase-row ${byIndex.has(i) ? 'err' : ''}" data-id="${esc(p.id)}">
      <input class="input" type="time" step="300" data-f="start" data-fk="${esc(p.id)}:start" value="${toHM(p.start)}" aria-label="Phase ${i + 1} start">
      <span class="to">–</span>
      <input class="input" type="time" step="300" data-f="end" data-fk="${esc(p.id)}:end" value="${toHM(p.end)}" aria-label="Phase ${i + 1} end">
      <div class="lvl-select" role="radiogroup" aria-label="Phase ${i + 1} energy">${LEVELS.map((l) => `<button type="button" role="radio" class="${lv(l)}" data-act="phase-level" data-l="${l}" data-fk="${esc(p.id)}:lvl:${l}" aria-checked="${p.level === l}" title="${LEVEL_INFO[l].name}" aria-label="${LEVEL_INFO[l].name}">${icon(LEVEL_ICON[l])}</button>`).join('')}</div>
      <input class="input lbl" type="text" data-f="label" data-fk="${esc(p.id)}:label" maxlength="60" value="${esc(p.label || '')}" placeholder="${LEVEL_INFO[p.level].name} phase" aria-label="Phase ${i + 1} name">
      <button class="btn ghost icon small" data-act="del-phase" aria-label="Delete phase ${i + 1}">${icon('trash')}</button>
      ${byIndex.has(i) ? `<div class="err-msg">${esc(byIndex.get(i))} — fix the times so phases don’t overlap.</div>` : ''}
    </div>`).join('')}
  </div>`;
}

function phasesCopy() { return getState().profile.phases.map((p) => ({ ...p })); }

function onChange(e) {
  const inp = e.target.closest('.phase-row [data-f]');
  if (!inp) return;
  if (inp.type === 'time' && document.activeElement === inp) return; // saved on focusout / Enter
  commitPhaseInput(inp);
}

function commitPhaseInput(inp) {
  if (!inp.isConnected) return;
  const id = inp.closest('.phase-row').dataset.id;
  const phases = phasesCopy();
  const p = phases.find((x) => x.id === id);
  if (!p) return;
  const f = inp.dataset.f;
  if (f === 'label') { if (p.label === inp.value.trim()) return; p.label = inp.value.trim(); }
  else {
    let v = parseHM(inp.value);
    if (Number.isNaN(v)) { update(); return; }
    if (f === 'end' && v === 0) v = DAY_MIN;
    if (p[f] === v) return;
    p[f] = v;
    if (p.end <= p.start) { toast('A phase must end after it starts.', { iconName: 'alert', timeout: 3000 }); update(); return; }
  }
  A.setPhases(phases);
}

async function onClick(e) {
  const a = e.target.closest('[data-act]');
  if (!a) return;
  const s = getState();
  switch (a.dataset.act) {
    case 'checkin': openCheckin(); break;
    case 'preset': {
      const k = a.dataset.k;
      if (s.profile.preset === k) break;
      const ok = s.profile.preset === 'custom'
        ? await confirmDialog({ title: `Use “${PRESETS[k].name}”?`, message: 'Your custom phases will be replaced. You can undo this.', confirmLabel: 'Use rhythm' })
        : true;
      if (ok) { A.applyPreset(k); toast(`Energy map set to “${PRESETS[k].name}”. Auto-plan to re-fit your tasks.`, { iconName: 'energy', action: 'Undo', onAction: undoFn() }); }
      break;
    }
    case 'shift': {
      const d = +a.dataset.d;
      if (!A.shiftPhases(d)) toast('Can’t move phases past midnight.', { iconName: 'alert', timeout: 3000 });
      break;
    }
    case 'add-phase': {
      const ph = normalizePhases(s.profile.phases);
      const last = ph[ph.length - 1];
      const start = last ? Math.min(last.end, DAY_MIN - 60) : 9 * 60;
      const phases = phasesCopy();
      phases.push({ id: uid('p'), start, end: Math.min(DAY_MIN, start + 60), level: 'steady', label: '' });
      A.setPhases(phases, 'Add phase');
      break;
    }
    case 'del-phase': {
      const id = a.closest('.phase-row').dataset.id;
      A.setPhases(phasesCopy().filter((p) => p.id !== id), 'Delete phase');
      toast('Phase deleted.', { action: 'Undo', onAction: undoFn(), timeout: 3500 });
      break;
    }
    case 'phase-level': {
      const id = a.closest('.phase-row').dataset.id;
      const phases = phasesCopy();
      const p = phases.find((x) => x.id === id);
      if (p && p.level !== a.dataset.l) { p.level = a.dataset.l; A.setPhases(phases); }
      break;
    }
    case 'toggle-table': showTable = !showTable; renderLearn(s); break;
    case 'apply-suggestion': {
      const st = +a.dataset.s, en = +a.dataset.e, l = a.dataset.l;
      A.setLevelRange(st, en, l);
      toast(`${T(st)}–${T(en)} is now ${LEVEL_INFO[l].name}.`, { iconName: 'energy', action: 'Undo', onAction: undoFn() });
      break;
    }
    default: break;
  }
}

// ───────────── learning from check-ins ─────────────
export function checkinStats(s, days = 42) {
  const since = Date.now() - days * 86400000;
  const byHour = Array.from({ length: 24 }, () => ({ n: 0, sum: 0 }));
  let count = 0;
  for (const c of s.checkins) {
    const d = new Date(c.at);
    if (d.getTime() < since) continue;
    byHour[d.getHours()].n++;
    byHour[d.getHours()].sum += c.level;
    count++;
  }
  return { count, byHour: byHour.map((h, i) => ({ hour: i, n: h.n, avg: h.n ? h.sum / h.n : null })) };
}

export const levelFromAvg = (avg) => (avg >= 3.8 ? 'peak' : avg >= 2.8 ? 'steady' : 'low');

function renderLearn(s) {
  const el = $('#learn', root);
  const { count, byHour } = checkinStats(s);
  if (count < 8) {
    el.innerHTML = `<div class="chart-head"><div class="grow"><h3>How you actually feel, hour by hour</h3>
      <div class="sub">Log your energy a few times a day with <b>Check-in</b> (or press <span class="kbd">E</span>). After about 8 check-ins EnergyMap shows your real curve and suggests changes to your map.</div></div></div>
      <div class="empty">${icon('battery')}<strong>${count} of 8 check-ins so far</strong><button class="btn small" data-act="checkin" style="margin-top:8px">Check in now</button></div>`;
    return;
  }
  const hours = byHour.filter((h) => h.n > 0);
  const lo = Math.min(...hours.map((h) => h.hour)), hi = Math.max(...hours.map((h) => h.hour)) + 1;
  const W = 1000, H = 230, L = 74, R = 12, TOP = 12, B = 30;
  const x = (hr) => L + ((hr - lo) / Math.max(1, hi - lo)) * (W - L - R);
  const y = (v) => TOP + (1 - (v - 1) / 4) * (H - TOP - B);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Average check-in energy by hour">`;
  // profile bands
  for (const p of normalizePhases(s.profile.phases)) {
    const a = Math.max(lo * 60, p.start), b = Math.min(hi * 60, p.end);
    if (b <= a) continue;
    svg += `<rect class="${lv(p.level)}" x="${x(a / 60)}" y="${TOP}" width="${x(b / 60) - x(a / 60)}" height="${H - TOP - B}" fill="var(--lvl-wash)"/>`;
  }
  svg += '<g class="axis">';
  const names = ['Drained', 'Low', 'Okay', 'Good', 'Energized'];
  for (let v = 1; v <= 5; v++) svg += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${names[v - 1]}</text>`;
  for (let hr = lo; hr <= hi; hr++) svg += `<text x="${x(hr)}" y="${H - 8}" text-anchor="middle">${esc(Tc(hr * 60))}</text>`;
  svg += '</g>';
  const pts = hours.map((h) => ({ ...h, cx: x(h.hour + 0.5), cy: y(h.avg) }));
  if (pts.length > 1) svg += `<polyline points="${pts.map((p) => `${p.cx},${p.cy}`).join(' ')}" fill="none" stroke="var(--text-2)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  for (const p of pts) {
    svg += `<circle cx="${p.cx}" cy="${p.cy}" r="5" fill="var(--text)" stroke="var(--panel)" stroke-width="2"/>`;
    svg += `<rect class="hit" data-h="${p.hour}" x="${p.cx - 22}" y="${TOP}" width="44" height="${H - TOP - B}" tabindex="0" aria-label="${esc(Tc(p.hour * 60))}: average ${p.avg.toFixed(1)} from ${p.n} check-ins"/>`;
  }
  svg += '</svg>';
  // suggestions: hours inside the map where the felt level differs from the mapped level
  const sugg = [];
  for (const h of hours) {
    if (h.n < 3) continue;
    const ph = phaseAt(s.profile.phases, h.hour * 60 + 30);
    if (!ph) continue;
    const felt = levelFromAvg(h.avg);
    if (felt !== ph.level) {
      const st = Math.max(ph.start, h.hour * 60), en = Math.min(ph.end, h.hour * 60 + 60);
      if (en > st) sugg.push({ st, en, felt, mapped: ph.level, avg: h.avg, n: h.n });
    }
  }
  el.innerHTML = `<div class="chart-head"><div class="grow"><h3>Average check-in energy by hour</h3>
      <div class="sub">Last 6 weeks · ${count} check-ins. Shaded areas are your current map.</div></div>
      <button class="btn small ghost" data-act="toggle-table" aria-pressed="${showTable}">${showTable ? 'Show chart' : 'Show table'}</button></div>
    ${showTable ? `<table class="data-table"><thead><tr><th>Hour</th><th>Check-ins</th><th>Average (1–5)</th><th>Your map says</th></tr></thead><tbody>
        ${hours.map((h) => { const p = phaseAt(s.profile.phases, h.hour * 60 + 30); return `<tr><td>${esc(Tc(h.hour * 60))}</td><td>${h.n}</td><td>${h.avg.toFixed(1)}</td><td>${p ? LEVEL_INFO[p.level].name : '—'}</td></tr>`; }).join('')}
      </tbody></table>` : `<div class="chart">${svg}</div>
      <div class="chart-legend">${LEVELS.map((l) => `<span class="${lv(l)}"><i style="background:var(--lvl-wash);outline:1px solid var(--lvl)"></i>${LEVEL_INFO[l].name} in your map</span>`).join('')}<span><i style="background:var(--text);border-radius:50%"></i>Your average</span></div>`}
    ${sugg.length ? `<div style="margin-top:12px">${sugg.map((g) => `<div class="suggest">${icon('sparkles')}<span class="grow"><b>${esc(T(g.st))}–${esc(T(g.en))}</b>: you feel <b>${LEVEL_INFO[g.felt].name}</b> (avg ${g.avg.toFixed(1)} from ${g.n} check-ins), your map says ${LEVEL_INFO[g.mapped].name}.</span>
        <button class="btn small" data-act="apply-suggestion" data-s="${g.st}" data-e="${g.en}" data-l="${g.felt}">Make it ${LEVEL_INFO[g.felt].name}</button></div>`).join('')}</div>`
      : '<p class="hint" style="margin-top:10px">Your map matches how you feel — no changes suggested.</p>'}`;
  $$('.hit', el).forEach((r) => {
    const h = byHour[+r.dataset.h];
    const html = `<div class="tt-h">${esc(Tc(h.hour * 60))} – ${esc(Tc(h.hour * 60 + 60))}</div><div class="tt-r"><i style="background:var(--text)"></i>Average<b>${h.avg.toFixed(1)}</b></div><div class="tt-r"><i style="background:var(--muted)"></i>Check-ins<b>${h.n}</b></div>`;
    r.addEventListener('pointermove', (ev) => showTip(html, ev.clientX, ev.clientY));
    r.addEventListener('pointerleave', hideTip);
    r.addEventListener('focus', () => { const b = r.getBoundingClientRect(); showTip(html, b.left + b.width / 2, b.top + 20); });
    r.addEventListener('blur', hideTip);
  });
  void todayKey;
}
