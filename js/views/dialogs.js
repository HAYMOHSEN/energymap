// EnergyMap — dialogs: task editor, busy time, export, calendar import, check-in, help, onboarding.

import { undoFn } from '../undo.js';
import { getState, undo, APP_VERSION } from '../state.js';
import * as A from '../actions.js';
import { LEVELS, LEVEL_INFO, PRESETS, normalizePhases, busyForDay } from '../scheduler.js';
import {
  todayKey, addDays, weekKeys, fmtTime, fmtDuration, fmtRelDay, fmtDayMed, toHM, parseHM, toDate, clamp, DAY_MIN,
  WEEKDAY_SHORT, WEEKDAY_LETTER, parseDeadline, dateKey,
} from '../time.js';
import { buildICS, parseICS, expandEvents } from '../ics.js';
import { esc, icon, LEVEL_ICON, openModal, toast, saveFile, pickFile, readText, copyText, logoSVG, $, $$ } from '../ui.js';

const h12 = () => getState().settings.h12;
const T = (m) => fmtTime(m, h12());
const lv = (l) => `lvl-${l}`;

// ───────────── helpers shared with views ─────────────
export function describeBumps(bumped, hh = h12()) {
  const parts = bumped.map((b) => `<b>${esc(b.title)}</b> → ${b.to ? esc(`${fmtRelDay(b.to.date)} ${fmtTime(b.to.start, hh)}`) : 'backlog'}`);
  return `Made room by moving ${parts.join(', ')}.`;
}

export function showPlanResult(r, kind, goto) {
  if (!r || !r.considered) {
    toast(kind === 'backlog' ? 'Backlog is empty — nothing to place.' : 'Nothing to plan yet — add a few tasks first.', { iconName: 'info', timeout: 3500 });
    return;
  }
  const left = r.unplaced.length;
  const msg = `Planned <b>${r.placed}</b> task${r.placed === 1 ? '' : 's'} by energy.` +
    (left ? ` ${left} stay${left === 1 ? 's' : ''} in the backlog — see why there.` : ' Everything fits.');
  toast(msg, { html: true, iconName: left ? 'info' : 'sparkles', action: 'Undo', onAction: undoFn(), timeout: 6500 });
  void goto;
}

function energyPicker(name, value) {
  return `<div class="energy-pick" role="radiogroup" aria-label="Energy it needs" data-name="${name}">
    ${LEVELS.map((l) => `<button type="button" role="radio" class="${lv(l)}" data-load="${l}" aria-checked="${l === value}">
      <span class="t">${icon(LEVEL_ICON[l])}${LEVEL_INFO[l].name}</span><span class="s">${LEVEL_INFO[l].hint}</span></button>`).join('')}
  </div>`;
}

function wireEnergyPicker(root) {
  root.querySelectorAll('.energy-pick').forEach((g) => {
    g.addEventListener('click', (e) => {
      const b = e.target.closest('[data-load]');
      if (!b) return;
      g.querySelectorAll('[data-load]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    });
    g.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      const bs = [...g.querySelectorAll('[data-load]')];
      const i = bs.findIndex((x) => x.getAttribute('aria-checked') === 'true');
      const n = bs[(i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + bs.length) % bs.length];
      bs.forEach((x) => x.setAttribute('aria-checked', String(x === n)));
      n.focus();
    });
  });
}
const pickedLoad = (root) => root.querySelector('.energy-pick [aria-checked="true"]')?.dataset.load || 'peak';

// ───────────── task editor ─────────────
export function openTaskEditor(taskId, { scheduleAt = null } = {}) {
  const s = getState();
  const t = taskId ? A.taskById(s, taskId) : null;
  const v = t || { title: '', notes: '', load: s.settings.defaultLoad, durationMins: s.settings.defaultDuration, deadline: null, priority: 'normal', splittable: s.settings.splitDefault };
  const dl = parseDeadline(v.deadline);
  const blocks = t ? A.blocksOf(s, t.id) : [];
  const body = `
    <div class="field"><label for="te-title">Task</label><input class="input" id="te-title" maxlength="300" value="${esc(v.title)}" placeholder="What needs doing?"></div>
    <div class="field"><span class="label">Energy it needs</span>${energyPicker('load', v.load)}
      <span class="hint" id="te-load-hint">${esc(LEVEL_INFO[v.load].desc)}</span></div>
    <div class="cols-2">
      <div class="field"><label for="te-dur">Duration (minutes)</label><input class="input" id="te-dur" type="number" min="5" max="720" step="5" value="${v.durationMins}"></div>
      <div class="field"><span class="label">&nbsp;</span><div class="chips">${[30, 45, 60, 90, 120].map((m) => `<button type="button" class="chip" data-dur="${m}">${m < 60 ? m + 'm' : fmtDuration(m)}</button>`).join('')}</div></div>
    </div>
    <div class="cols-2">
      <div class="field"><label for="te-dl">Deadline</label><input class="input" id="te-dl" type="date" value="${dl ? dl.key : ''}"></div>
      <div class="field"><label for="te-dlt">Due time (optional)</label><input class="input" id="te-dlt" type="time" value="${dl && dl.min < DAY_MIN - 1 ? toHM(dl.min) : ''}"></div>
    </div>
    <div class="field" style="gap:10px">
      <label class="switch"><input type="checkbox" id="te-high" ${v.priority === 'high' ? 'checked' : ''}><span class="track"></span><span>High priority — placed before other tasks</span></label>
      <label class="switch"><input type="checkbox" id="te-split" ${v.splittable ? 'checked' : ''}><span class="track"></span><span>Allow splitting into sessions (min ${s.settings.minChunkMins} min each)</span></label>
    </div>
    <div class="field"><label for="te-notes">Notes</label><textarea class="input" id="te-notes" rows="3" maxlength="5000">${esc(v.notes || '')}</textarea></div>
    ${blocks.length ? `<div class="field"><span class="label">Scheduled</span>${blocks.map((b) => `<div class="hint" style="color:var(--text-2)">${icon('calendar').replace('<svg', '<svg style="width:14px;height:14px;vertical-align:-2px"')} ${esc(fmtDayMed(b.date))}, ${esc(T(b.start))} – ${esc(T(b.end))}${b.pinned ? ' · pinned' : ''}</div>`).join('')}</div>` : ''}
    ${scheduleAt ? `<p class="hint" style="margin-bottom:10px">Will be placed on ${esc(fmtDayMed(scheduleAt.date))} at ${esc(T(scheduleAt.start))}.</p>` : ''}
    ${t && t.doneAt ? `<p class="hint" style="margin-bottom:10px">Completed ${esc(new Date(t.doneAt).toLocaleString())}.</p>` : ''}`;
  const read = (m) => {
    const title = $('#te-title', m.el).value.trim();
    if (!title) { $('#te-title', m.el).classList.add('error'); $('#te-title', m.el).focus(); return null; }
    const d = $('#te-dl', m.el).value, tm = $('#te-dlt', m.el).value;
    return {
      title, notes: $('#te-notes', m.el).value, load: pickedLoad(m.el),
      durationMins: clamp(+$('#te-dur', m.el).value || 60, 5, 720),
      deadline: d ? `${d}T${tm || '23:59'}` : null,
      priority: $('#te-high', m.el).checked ? 'high' : 'normal',
      splittable: $('#te-split', m.el).checked,
    };
  };
  const actions = [];
  if (t) {
    actions.push({ label: 'Delete', kind: 'danger', left: true, icon: 'trash', onClick: () => { A.deleteTask(t.id); toast(`Deleted “${t.title}”.`, { action: 'Undo', onAction: undoFn() }); } });
    if (blocks.length && !t.doneAt) actions.push({ label: 'Unschedule', icon: 'inbox', onClick: () => { A.unscheduleTask(t.id); toast('Moved to the backlog.', { action: 'Undo', onAction: undoFn() }); } });
    actions.push({ label: 'Cancel' });
    actions.push({ label: 'Save', kind: 'primary', onClick: (m) => {
      const f = read(m); if (!f) return false;
      const r = A.updateTask(t.id, f);
      if (r && r.note && r.note.unscheduled) toast('Length changed — the task went back to the backlog so it can be re-planned.', { iconName: 'info', action: 'Undo', onAction: undoFn() });
      else if (r && r.note && r.note.bumped) toast(describeBumps(r.note.bumped), { html: true, iconName: 'alert', action: 'Undo', onAction: undoFn() });
    } });
  } else if (scheduleAt) {
    actions.push({ label: 'Cancel' });
    actions.push({ label: `Add at ${T(scheduleAt.start)}`, kind: 'primary', onClick: (m) => {
      const f = read(m); if (!f) return false;
      const r2 = A.addTaskAt(f, scheduleAt.date, scheduleAt.start);
      if (r2 && r2.bumped && r2.bumped.length) toast(describeBumps(r2.bumped), { html: true, iconName: 'alert', action: 'Undo', onAction: undoFn() });
      else toast(`Added “${f.title}” at ${T(scheduleAt.start)}.`, { iconName: 'check', action: 'Undo', onAction: undoFn(), timeout: 3500 });
    } });
  } else {
    actions.push({ label: 'Cancel' });
    actions.push({ label: 'Add to backlog', onClick: (m) => { const f = read(m); if (!f) return false; A.addTask(f); toast(`Added “${f.title}”.`, { action: 'Undo', onAction: undoFn() }); } });
    actions.push({ label: 'Auto-schedule', kind: 'primary', icon: 'sparkles', onClick: (m) => {
      const f = read(m); if (!f) return false;
      const r = A.addTask(f, { autoSchedule: true });
      if (r.placements && r.placements.length) toast(`Scheduled “${f.title}” · ${fmtRelDay(r.placements[0].date)} ${T(r.placements[0].start)}`, { iconName: 'check', action: 'Undo', onAction: undoFn() });
      else toast(`“${f.title}” is in the backlog — ${r.unplaced ? r.unplaced.reason : ''}`, { iconName: 'info', timeout: 7000 });
    } });
  }
  const m = openModal({ title: t ? 'Edit task' : 'New task', body, actions, initialFocus: '#te-title' });
  wireEnergyPicker(m.el);
  m.el.querySelector('.energy-pick').addEventListener('click', () => { $('#te-load-hint', m.el).textContent = LEVEL_INFO[pickedLoad(m.el)].desc; });
  $$('[data-dur]', m.el).forEach((b) => b.addEventListener('click', () => { $('#te-dur', m.el).value = b.dataset.dur; }));
  $('#te-title', m.el).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); m.foot.querySelector('.btn.primary')?.click(); } });
}

// ───────────── busy time editor ─────────────
export function openBusyEditor(item = {}) {
  const s = getState();
  const existing = item.id ? s.busy.find((b) => b.id === item.id) : null;
  const v = existing || { title: '', date: item.date || todayKey(), start: item.start ?? 9 * 60, end: item.end ?? 10 * 60, repeat: null };
  const days = v.repeat ? v.repeat.days : [];
  const body = `
    <div class="field"><label for="bz-title">What is it?</label><input class="input" id="bz-title" maxlength="200" value="${esc(v.title)}" placeholder="Meeting, lecture, gym…"></div>
    <div class="cols-2">
      <div class="field"><label for="bz-start">From</label><input class="input" id="bz-start" type="time" value="${toHM(v.start)}"></div>
      <div class="field"><label for="bz-end">To</label><input class="input" id="bz-end" type="time" value="${toHM(v.end)}"></div>
    </div>
    <div class="field"><label class="switch"><input type="checkbox" id="bz-rep" ${v.repeat ? 'checked' : ''}><span class="track"></span><span>Repeats every week</span></label></div>
    <div class="field" id="bz-once" ${v.repeat ? 'hidden' : ''}><label for="bz-date">Date</label><input class="input" id="bz-date" type="date" value="${esc(v.date || todayKey())}"></div>
    <div id="bz-weekly" ${v.repeat ? '' : 'hidden'}>
      <div class="field"><span class="label">On</span><div class="daypick" role="group" aria-label="Days">
        ${[1, 2, 3, 4, 5, 6, 0].map((d) => `<button type="button" data-day="${d}" aria-pressed="${days.includes(d) || (!v.repeat && d === new Date(toDate(v.date || todayKey())).getDay())}" title="${WEEKDAY_SHORT[d]}">${WEEKDAY_LETTER[d]}</button>`).join('')}
      </div></div>
      <div class="field"><label for="bz-until">Until (optional)</label><input class="input" id="bz-until" type="date" value="${esc(v.repeat && v.repeat.until ? v.repeat.until : '')}"></div>
    </div>
    <p class="hint">EnergyMap keeps tasks out of busy time (plus your break buffer).</p>`;
  const actions = [];
  if (existing) actions.push({ label: 'Delete', kind: 'danger', left: true, icon: 'trash', onClick: () => { A.deleteBusy(existing.id); toast('Busy time deleted.', { action: 'Undo', onAction: undoFn() }); } });
  actions.push({ label: 'Cancel' });
  actions.push({ label: 'Save', kind: 'primary', onClick: (m) => {
    const st = parseHM($('#bz-start', m.el).value), en = parseHM($('#bz-end', m.el).value);
    if (Number.isNaN(st) || Number.isNaN(en) || en <= st) { $('#bz-end', m.el).classList.add('error'); toast('“To” must be after “From”.', { iconName: 'alert', timeout: 3000 }); return false; }
    const rep = $('#bz-rep', m.el).checked;
    const picked = $$('#bz-weekly [data-day]', m.el).filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => +b.dataset.day);
    if (rep && !picked.length) { toast('Pick at least one day.', { iconName: 'alert', timeout: 3000 }); return false; }
    A.saveBusy({
      id: existing ? existing.id : null, title: $('#bz-title', m.el).value.trim() || 'Busy',
      date: rep ? (existing && existing.date) || todayKey() : $('#bz-date', m.el).value || todayKey(),
      start: st, end: en, repeat: rep ? { days: picked, until: $('#bz-until', m.el).value || null } : null,
    });
  } });
  const m = openModal({ title: existing ? 'Edit busy time' : 'Block busy time', body, actions, initialFocus: '#bz-title' });
  $('#bz-rep', m.el).addEventListener('change', (e) => { $('#bz-once', m.el).hidden = e.target.checked; $('#bz-weekly', m.el).hidden = !e.target.checked; });
  $$('#bz-weekly [data-day]', m.el).forEach((b) => b.addEventListener('click', () => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'))));
}

// ───────────── export ─────────────
function exportRange(kind, day, s) {
  const t = todayKey();
  if (kind === 'day') return { from: day, to: day };
  if (kind === 'week') { const w = weekKeys(day, s.settings.weekStart); return { from: w[0], to: w[6] }; }
  if (kind === 'next7') return { from: t, to: addDays(t, 6) };
  return { from: t, to: '9999-12-31' };
}

function collectExport(s, kind, day, includePhases, alarm) {
  const { from, to } = exportRange(kind, day, s);
  const events = [];
  for (const b of s.blocks) {
    if (b.date < from || b.date > to) continue;
    const t = A.taskById(s, b.taskId);
    if (!t || t.doneAt) continue;
    const info = LEVEL_INFO[t.load];
    events.push({
      uid: `${b.id}@energymap.app`, start: toDate(b.date, b.start), end: toDate(b.date, b.end),
      summary: t.title + (b.parts > 1 ? ` (${b.part}/${b.parts})` : ''),
      description: `${info.name} energy · ${info.hint}\n${fmtDuration(b.end - b.start)}${t.notes ? `\n\n${t.notes}` : ''}\n\nPlanned with EnergyMap`,
      categories: [`${info.name} energy`, 'EnergyMap'], alarmMins: alarm,
    });
  }
  if (includePhases) {
    const last = to === '9999-12-31' ? addDays(todayKey(), 13) : to;
    for (let d = from; d <= last; d = addDays(d, 1)) {
      if (!s.settings.workDays.includes(new Date(toDate(d)).getDay())) continue;
      for (const p of normalizePhases(s.profile.phases)) {
        events.push({
          uid: `phase-${d}-${p.start}@energymap.app`, start: toDate(d, p.start), end: toDate(d, p.end),
          summary: `${LEVEL_INFO[p.level].name} energy${p.label ? ` · ${p.label}` : ''}`, description: LEVEL_INFO[p.level].desc,
          categories: ['Energy phase', 'EnergyMap'], transparent: true,
        });
      }
    }
  }
  events.sort((a, b) => a.start - b.start);
  return { events, from, to };
}

function agendaText(s, events) {
  const lines = [];
  let cur = '';
  for (const e of events) {
    if (e.transparent) continue;
    const k = dateKey(e.start);
    if (k !== cur) { cur = k; lines.push('', fmtDayMed(k)); }
    const sm = e.start.getHours() * 60 + e.start.getMinutes(), em = e.end.getHours() * 60 + e.end.getMinutes();
    lines.push(`  ${fmtTime(sm, s.settings.h12)}–${fmtTime(em, s.settings.h12)}  ${e.summary}  [${e.categories[0]}]`);
  }
  return ('EnergyMap plan' + lines.join('\n')).trim();
}

export function openExport({ day = todayKey(), mode = 'day' } = {}) {
  const s = getState();
  let kind = mode === 'week' ? 'week' : 'day';
  const body = `
    <div class="field"><span class="label">What to export</span>
      <div class="seg" role="radiogroup" aria-label="Range" id="ex-range">
        <button type="button" role="radio" data-k="day">This day</button><button type="button" role="radio" data-k="week">This week</button>
        <button type="button" role="radio" data-k="next7">Next 7 days</button><button type="button" role="radio" data-k="all">All upcoming</button>
      </div></div>
    <div class="cols-2">
      <div class="field"><label for="ex-alarm">Reminder in your calendar</label>
        <select class="input" id="ex-alarm"><option value="">None</option><option value="0">At start</option><option value="5" selected>5 minutes before</option><option value="10">10 minutes before</option><option value="15">15 minutes before</option></select></div>
      <div class="field"><label for="ex-name">Calendar name</label><input class="input" id="ex-name" value="EnergyMap" maxlength="80"></div>
    </div>
    <div class="field"><label class="switch"><input type="checkbox" id="ex-phases"><span class="track"></span><span>Also add my energy phases (shown as free time)</span></label></div>
    <p class="hint" id="ex-count" style="margin-bottom:10px"></p>
    <div class="prose" style="font-size:12.5px;background:var(--panel-2);border:1px solid var(--border);border-radius:8px;padding:10px 12px">
      <b>Google Calendar:</b> Settings › Import &amp; export › Import.<br>
      <b>Outlook:</b> double-click the file, or File › Open &amp; Export › Import/Export.<br>
      Tip: import into a separate calendar called “EnergyMap”, so you can replace it after re-planning.
    </div>`;
  const m = openModal({
    title: 'Export to your calendar', body, wide: false,
    actions: [
      { label: 'Copy as text', icon: 'copy', left: true, onClick: (mm) => {
        const { events } = gather(mm);
        copyText(agendaText(getState(), events)).then((ok) => toast(ok ? 'Agenda copied — paste it into an email or chat.' : 'Copy failed.', { iconName: ok ? 'copy' : 'alert', timeout: 3000 }));
        return false;
      } },
      { label: 'Cancel' },
      { label: 'Save .ics file', kind: 'primary', icon: 'download', onClick: (mm) => {
        const { events, from } = gather(mm);
        if (!events.length) { toast('Nothing planned in that range.', { iconName: 'info', timeout: 3000 }); return false; }
        const name = $('#ex-name', mm.el).value.trim() || 'EnergyMap';
        const ics = buildICS({ calName: name, events });
        const file = `energymap-${kind === 'all' ? 'upcoming' : from}.ics`;
        saveFile(file, ics, 'text/calendar', 'Calendar file').then((r) => {
          if (r.saved) toast(`Saved ${events.length} event${events.length > 1 ? 's' : ''} to ${r.name}. Open it with your calendar app.`, { iconName: 'download', timeout: 6000 });
        });
      } },
    ],
  });
  const gather = (mm) => {
    const a = $('#ex-alarm', mm.el).value;
    return collectExport(getState(), kind, day, $('#ex-phases', mm.el).checked, a === '' ? null : +a);
  };
  const refresh = () => {
    $$('#ex-range [data-k]', m.el).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.k === kind)));
    const { events } = gather(m);
    const tasks = events.filter((e) => !e.transparent).length;
    $('#ex-count', m.el).textContent = tasks ? `${tasks} planned task block${tasks > 1 ? 's' : ''} will be exported.` : 'No planned (open) tasks in this range.';
  };
  $('#ex-range', m.el).addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) { kind = b.dataset.k; refresh(); } });
  $('#ex-phases', m.el).addEventListener('change', refresh);
  refresh();
  void s;
}

// ───────────── calendar import ─────────────
export async function openImportCalendar({ file = null, sourceId = null } = {}) {
  const f = file || await pickFile('.ics,text/calendar');
  if (!f) return;
  let text;
  try { text = await readText(f); } catch { toast('Could not read that file.', { iconName: 'alert' }); return; }
  if (!/BEGIN:VCALENDAR/i.test(text)) { toast('That file isn’t a calendar (.ics) file.', { iconName: 'alert', timeout: 5000 }); return; }
  let cal;
  try { cal = parseICS(text); } catch { toast('Could not read that calendar file.', { iconName: 'alert' }); return; }
  const from = toDate(addDays(todayKey(), -7)), to = toDate(addDays(todayKey(), 120));
  const s = getState();
  const existing = sourceId ? s.sources.find((x) => x.id === sourceId) : null;
  const defName = existing ? existing.name : (cal.name || f.name.replace(/\.ics$/i, '') || 'Calendar');
  const preview = (allDay) => expandEvents(cal, { from, to, includeAllDay: allDay });
  const body = `
    <p class="prose" style="margin-bottom:12px">EnergyMap reads the events in <b>${esc(f.name)}</b> as <b>busy time</b>, so tasks are never planned on top of your meetings. Nothing is uploaded anywhere.</p>
    <div class="field"><label for="ic-name">Name</label><input class="input" id="ic-name" value="${esc(defName)}" maxlength="80"></div>
    <div class="field"><label class="switch"><input type="checkbox" id="ic-allday"><span class="track"></span><span>Treat all-day events as busy (e.g. holidays, days off)</span></label></div>
    <p class="hint" id="ic-count"></p>`;
  const m = openModal({
    title: existing ? 'Refresh calendar' : 'Import busy times', body,
    actions: [{ label: 'Cancel' }, { label: 'Import', kind: 'primary', icon: 'upload', onClick: (mm) => {
      const inst = preview($('#ic-allday', mm.el).checked);
      const r = A.importCalendar({ name: $('#ic-name', mm.el).value.trim() || defName, fileName: f.name, instances: inst, sourceId, until: addDays(todayKey(), 120) });
      toast(`Imported ${r.count} busy block${r.count === 1 ? '' : 's'} from “${r.source.name}”. Auto-plan will work around them.`, { iconName: 'calendar', action: 'Undo', onAction: undoFn(), timeout: 6500 });
    } }],
  });
  const refresh = () => {
    const inst = preview($('#ic-allday', m.el).checked);
    const series = cal.events.filter((e) => e.rrule && !e.recurrenceId).length;
    $('#ic-count', m.el).textContent = `${inst.length} event${inst.length === 1 ? '' : 's'} between last week and the next 4 months${series ? ` (including ${series} repeating series)` : ''}.`;
  };
  $('#ic-allday', m.el).addEventListener('change', refresh);
  refresh();
}

// ───────────── energy check-in ─────────────
export function openCheckin() {
  const labels = ['Drained', 'Low', 'Okay', 'Good', 'Energized'];
  const body = `<p class="prose" style="margin-bottom:10px">A quick tap a few times a day teaches EnergyMap when you really peak. See the pattern in <b>Energy</b> and <b>Insights</b>.</p>
    <div class="checkin-scale" role="group" aria-label="Energy level">${labels.map((l, i) => `<button type="button" data-lv="${i + 1}"><b>${i + 1}</b>${l}</button>`).join('')}</div>`;
  const m = openModal({ title: 'How’s your energy right now?', body, actions: [] });
  m.el.querySelectorAll('[data-lv]').forEach((b) => b.addEventListener('click', () => {
    A.addCheckin(+b.dataset.lv);
    m.close();
    toast(`Logged: ${labels[+b.dataset.lv - 1]} at ${T(new Date().getHours() * 60 + new Date().getMinutes())}.`, { iconName: 'battery', action: 'Undo', onAction: undoFn(), timeout: 3000 });
  }));
}

// ───────────── help ─────────────
export function openHelp() {
  const sc = [
    ['Add a task (focus quick add)', 'N'], ['Auto-plan', 'P'], ['Go to today', 'T'], ['Day / Week layout', 'D / W'],
    ['Previous / next day or week', '← / →'], ['Energy check-in', 'E'], ['Undo / Redo', 'Ctrl+Z / Ctrl+Y'],
    ['Switch section', 'Ctrl+1 … 5'], ['Zoom the timeline', 'Ctrl + mouse wheel'], ['Move a selected block', '↑ / ↓ (Shift = 30 min)'],
    ['Move a block to another day', 'Alt + ← / →'], ['Mark selected block done', 'D'], ['Send selected block to backlog', 'Delete'], ['This help', '?'],
  ];
  const body = `
    <div class="prose" style="margin-bottom:14px">
      <p><b>How EnergyMap works.</b> Your day has energy phases — <b>Peak</b> for deep work, <b>Steady</b> for routine work and <b>Low</b> for admin. Give each task the energy it needs and EnergyMap places it in a matching phase, earliest deadline first, with a short break between tasks.</p>
      <p>Drag blocks to move them. If a block lands on another task, that task is moved to the next free matching slot (or back to the backlog). Blocks you move by hand are <b>pinned</b> — Auto-plan leaves them where they are.</p>
      <p>Your data stays on this PC. Export your plan as a calendar file whenever you like.</p>
    </div>
    <div class="section-title" style="margin-top:0">Keyboard shortcuts</div>
    <div class="help-grid">${sc.map(([a, k]) => `<span>${esc(a)}</span><span>${k.split(' / ').map((x) => `<span class="kbd">${esc(x)}</span>`).join(' / ')}</span>`).join('')}</div>
    <p class="hint" style="margin-top:16px">EnergyMap ${APP_VERSION} · <a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a> · Support: <a href="mailto:haymohsen@gmail.com">haymohsen@gmail.com</a></p>`;
  openModal({ title: 'Help & shortcuts', body, wide: true, actions: [{ label: 'Close', kind: 'primary' }] });
}

// ───────────── onboarding ─────────────
export function openOnboarding({ onDone } = {}) {
  const s = getState();
  const curPh = normalizePhases(s.profile.phases);
  const st = {
    step: 0, preset: PRESETS[s.profile.preset] ? s.profile.preset : 'typical',
    startAt: curPh.length && PRESETS[s.profile.preset] ? curPh[0].start : 9 * 60,
    days: [...s.settings.workDays], sample: !s.tasks.length, reminders: s.settings.reminders, changed: !s.settings.onboarded,
  };
  const mini = (phases) => {
    const lo = 6 * 60, hi = 21 * 60;
    let cur = lo, html = '';
    for (const p of normalizePhases(phases)) {
      if (p.start > cur) html += `<i style="width:${((p.start - cur) / (hi - lo)) * 100}%;background:transparent"></i>`;
      html += `<i class="${lv(p.level)}" style="width:${((p.end - p.start) / (hi - lo)) * 100}%"></i>`;
      cur = p.end;
    }
    return `<span class="mini" aria-hidden="true">${html}</span>`;
  };
  const shifted = () => {
    const ph = PRESETS[st.preset].phases;
    const first = Math.min(...ph.map((p) => p.start));
    const delta = st.startAt - first;
    return ph.map((p) => ({ ...p, start: clamp(p.start + delta, 0, DAY_MIN), end: clamp(p.end + delta, 0, DAY_MIN) }));
  };
  const steps = [
    () => `<div class="onb-hero">${logoSVG('logo')}<div><h3 style="font-size:17px">Plan your day around your energy</h3>
        <p class="hint" style="font-size:13px">Hard work in your peaks, routine work when you’re steady, admin in your dips.</p></div></div>
      <div class="onb-levels">
        ${LEVELS.map((l) => `<div class="lv ${lv(l)}">${icon(LEVEL_ICON[l])}<div><b>${LEVEL_INFO[l].name}</b><span>${esc(LEVEL_INFO[l].desc)}</span></div></div>`).join('')}
      </div>
      <p class="prose" style="margin-top:10px">Add tasks with the energy they need. EnergyMap fits them into matching time — deadlines first, with short breaks in between.</p>`,
    () => `<p class="prose" style="margin-bottom:10px">When do you feel sharpest? Pick the closest rhythm — you can fine-tune every phase later.</p>
      <div class="onb-presets" role="radiogroup" aria-label="Your rhythm">
        ${Object.entries(PRESETS).map(([k, p]) => `<button type="button" role="radio" data-preset="${k}" aria-checked="${k === st.preset}">
          <div style="flex:1"><b>${esc(p.name)}</b><span>${esc(p.desc)}</span></div>${mini(p.phases)}</button>`).join('')}
      </div>
      <div class="cols-2" style="margin-top:14px">
        <div class="field"><label for="onb-start">My workday starts at</label><select class="input" id="onb-start">
          ${Array.from({ length: 15 }, (_, i) => 5 * 60 + i * 30).map((m) => `<option value="${m}" ${m === st.startAt ? 'selected' : ''}>${esc(T(m))}</option>`).join('')}</select></div>
        <div class="field"><span class="label">Work days</span><div class="daypick" role="group" aria-label="Work days">
          ${[1, 2, 3, 4, 5, 6, 0].map((d) => `<button type="button" data-day="${d}" aria-pressed="${st.days.includes(d)}" title="${WEEKDAY_SHORT[d]}">${WEEKDAY_LETTER[d]}</button>`).join('')}
        </div><div class="chips" style="margin-top:6px"><button type="button" class="chip" data-days="1,2,3,4,5">Mon–Fri</button><button type="button" class="chip" data-days="0,1,2,3,4">Sun–Thu</button></div></div>
      </div>`,
    () => `<p class="prose" style="margin-bottom:14px">You’re set. A couple of choices to finish:</p>
      <div class="field" style="gap:12px">
        <label class="switch"><input type="checkbox" id="onb-sample" ${st.sample ? 'checked' : ''}><span class="track"></span><span>Add example tasks so I can see how it works <span class="hint">(remove them any time in Settings)</span></span></label>
        <label class="switch"><input type="checkbox" id="onb-rem" ${st.reminders ? 'checked' : ''}><span class="track"></span><span>Remind me when each task starts</span></label>
      </div>
      <p class="hint">Tip: press <span class="kbd">N</span> to add a task and <span class="kbd">P</span> to auto-plan. Press <span class="kbd">?</span> for all shortcuts.</p>`,
  ];
  const titles = ['Welcome to EnergyMap', 'Your daily rhythm', 'Ready to plan'];
  let m;
  const render = () => {
    m.el.querySelector('.modal-head h2').textContent = titles[st.step];
    m.body.innerHTML = `<div class="onb-steps">${steps.map((_, i) => `<i class="${i <= st.step ? 'on' : ''}"></i>`).join('')}</div>${steps[st.step]()}`;
    const back = m.foot.querySelector('[data-role="back"]'), next = m.foot.querySelector('[data-role="next"]');
    back.hidden = false;
    back.textContent = st.step === 0 ? 'Skip' : 'Back';
    next.textContent = st.step === steps.length - 1 ? 'Start planning' : 'Continue';
    if (st.step === 1) {
      m.body.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => { st.preset = b.dataset.preset; st.changed = true; render(); }));
      $('#onb-start', m.body).addEventListener('change', (e) => { st.startAt = +e.target.value; st.changed = true; });
      m.body.querySelectorAll('.daypick [data-day]').forEach((b) => b.addEventListener('click', () => {
        const d = +b.dataset.day;
        st.days = st.days.includes(d) ? st.days.filter((x) => x !== d) : [...st.days, d];
        b.setAttribute('aria-pressed', String(st.days.includes(d)));
      }));
      m.body.querySelectorAll('[data-days]').forEach((b) => b.addEventListener('click', () => { st.days = b.dataset.days.split(',').map(Number); render(); }));
    }
    if (st.step === 2) {
      $('#onb-sample', m.body).addEventListener('change', (e) => { st.sample = e.target.checked; });
      $('#onb-rem', m.body).addEventListener('change', (e) => { st.reminders = e.target.checked; });
    }
    (next).focus();
  };
  m = openModal({ title: titles[0], body: '', dismissible: false, actions: [
    { label: 'Back', onClick: () => {
      if (st.step === 0) { A.setSettings({ onboarded: true }, 'Skip setup'); onDone && onDone(); return true; }
      st.step = Math.max(0, st.step - 1); render(); return false;
    } },
    { label: 'Continue', kind: 'primary', onClick: () => {
      if (st.step === 1 && !st.days.length) { toast('Pick at least one work day.', { iconName: 'alert', timeout: 2500 }); return false; }
      if (st.step < steps.length - 1) { st.step++; render(); return false; }
      finish();
    } },
  ] });
  const [backBtn, nextBtn] = m.foot.querySelectorAll('button');
  backBtn.dataset.role = 'back'; nextBtn.dataset.role = 'next';
  render();
  const finish = async () => {
    if (st.changed) A.setPhases(shifted(), 'Set up energy map', st.preset);
    A.setSettings({ workDays: st.days.sort(), onboarded: true, reminders: st.reminders }, 'Finish setup');
    if (st.sample) A.loadSample();
    if (st.reminders && 'Notification' in window && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch { /* ignore */ }
    }
    onDone && onDone();
  };
}

export { busyForDay };
