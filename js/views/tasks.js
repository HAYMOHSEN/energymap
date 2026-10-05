// EnergyMap — Tasks view: every task in one searchable list.

import { undoFn } from '../undo.js';
import { getState, undo } from '../state.js';
import * as A from '../actions.js';
import { LEVEL_INFO } from '../scheduler.js';
import { fmtDuration, fmtDeadline, fmtRelDay, fmtTime, parseDeadline, cmpKM, todayKey, minutesOf, dateKey } from '../time.js';
import { esc, icon, LEVEL_ICON, toast, openMenu, confirmDialog, focusKey, refocus, $ } from '../ui.js';
import { openTaskEditor } from './dialogs.js';
import { completeTask } from './plan.js';

let root = null;
let app = null;
const st = { q: '', filter: 'open', sort: 'deadline' };

export function mount(el, appApi) {
  root = el; app = appApi;
  root.innerHTML = `<div class="view"><div class="view-scroll"><div class="view-inner">
    <div class="page-head"><div class="grow"><h1>Tasks</h1><p>Everything on your plate — search, filter and edit.</p></div>
      <button class="btn primary" data-act="new">${icon('plus')}New task</button></div>
    <div class="toolbar">
      <div class="search">${icon('search')}<input class="input" id="tq" type="search" placeholder="Search tasks" aria-label="Search tasks" value="${esc(st.q)}"></div>
      <div class="seg" role="group" aria-label="Filter" id="tfilter"></div>
      <select class="input" id="tsort" aria-label="Sort" style="width:auto">
        <option value="deadline">Sort: Deadline</option><option value="energy">Sort: Energy</option>
        <option value="newest">Sort: Newest</option><option value="duration">Sort: Longest</option>
      </select>
      <span style="flex:1"></span>
      <button class="btn ghost" data-act="clear-done" id="tclear">${icon('trash')}Clear completed</button>
    </div>
    <div class="card" id="tlist-card"></div>
  </div></div></div>`;
  $('#tsort', root).value = st.sort;
  $('#tq', root).addEventListener('input', (e) => { st.q = e.target.value; update(); });
  $('#tsort', root).addEventListener('change', (e) => { st.sort = e.target.value; update(); });
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', (e) => {
    const row = e.target.closest('.trow[data-task]');
    if (row && e.target === row && e.key === 'Enter') openTaskEditor(row.dataset.task);
  });
  update();
}

export function unmount() { root = null; }

const STATUS = {
  backlog: ['inbox', 'Backlog'], scheduled: ['calendar', 'Planned'], active: ['play', 'In progress'],
  missed: ['alert', 'Missed'], done: ['check', 'Done'],
};

export function update() {
  if (!root) return;
  const fk = focusKey(root);
  render();
  refocus(root, fk);
}

function render() {
  const s = getState();
  const n = new Date();
  const all = s.tasks.map((t) => ({ t, status: A.statusOf(s, t, n), blocks: A.blocksOf(s, t.id) }));
  const counts = { open: 0, backlog: 0, planned: 0, done: 0 };
  for (const x of all) {
    if (x.status === 'done') counts.done++; else counts.open++;
    if (x.status === 'backlog' || x.status === 'missed') counts.backlog++;
    if (x.status === 'scheduled' || x.status === 'active') counts.planned++;
  }
  $('#tfilter', root).innerHTML = [['open', 'Open'], ['backlog', 'Backlog'], ['planned', 'Planned'], ['done', 'Done']]
    .map(([k, l]) => `<button type="button" data-act="filter" data-f="${k}" data-fk="filter:${k}" aria-pressed="${st.filter === k}">${l} <span class="hint">${counts[k]}</span></button>`).join('');
  $('#tclear', root).hidden = !counts.done;
  const q = st.q.trim().toLowerCase();
  let rows = all.filter((x) => {
    if (st.filter === 'open' && x.status === 'done') return false;
    if (st.filter === 'backlog' && !(x.status === 'backlog' || x.status === 'missed')) return false;
    if (st.filter === 'planned' && !(x.status === 'scheduled' || x.status === 'active')) return false;
    if (st.filter === 'done' && x.status !== 'done') return false;
    if (q && !(`${x.t.title} ${x.t.notes || ''}`.toLowerCase().includes(q))) return false;
    return true;
  });
  const rank = { peak: 0, steady: 1, low: 2 };
  rows.sort((a, b) => {
    if (st.sort === 'energy') return rank[a.t.load] - rank[b.t.load] || a.t.title.localeCompare(b.t.title);
    if (st.sort === 'newest') return (b.t.createdAt || '').localeCompare(a.t.createdAt || '');
    if (st.sort === 'duration') return b.t.durationMins - a.t.durationMins;
    if (st.filter === 'done') return (b.t.doneAt || '').localeCompare(a.t.doneAt || '');
    const da = a.t.deadline || '9999', db = b.t.deadline || '9999';
    return da < db ? -1 : da > db ? 1 : (a.t.priority === 'high' ? -1 : 0) - (b.t.priority === 'high' ? -1 : 0);
  });
  const card = $('#tlist-card', root);
  if (!rows.length) {
    card.innerHTML = `<div class="empty" style="padding:48px 16px">${icon(q ? 'search' : 'tasks')}<strong>${q ? 'No matching tasks' : st.filter === 'done' ? 'Nothing completed yet' : 'No tasks here'}</strong>${q ? 'Try another word.' : 'Add one with the New task button or press N.'}</div>`;
    return;
  }
  const nk = todayKey(n), nm = minutesOf(n);
  card.innerHTML = `<div class="tlist" role="list">
    <div class="trow head" aria-hidden="true"><span></span><span>Task</span><span class="c-lvl">Energy</span><span class="c-dur">Length</span><span class="c-dl">Deadline</span><span class="c-when">When</span><span></span></div>
    ${rows.map(({ t, status, blocks }) => {
      const dl = parseDeadline(t.deadline);
      const overdue = !t.doneAt && dl && cmpKM(dl.key, dl.min, nk, nm) < 0;
      const [ic, label] = STATUS[status];
      const first = blocks.find((b) => cmpKM(b.date, b.end, nk, nm) > 0) || blocks[0];
      const when = status === 'done' ? `Done ${esc(fmtRelDay(dateKey(new Date(t.doneAt))))}`
        : first && (status === 'scheduled' || status === 'active') ? `${esc(fmtRelDay(first.date))} ${esc(fmtTime(first.start, s.settings.h12))}${blocks.length > 1 ? ` +${blocks.length - 1}` : ''}` : label;
      return `<div class="trow ${t.doneAt ? 'done' : ''}" data-task="${esc(t.id)}" data-fk="row:${esc(t.id)}" role="listitem" tabindex="0" aria-label="${esc(t.title)}">
        <button class="check" data-act="toggle" data-task="${esc(t.id)}" data-fk="toggle:${esc(t.id)}" role="checkbox" aria-checked="${!!t.doneAt}" aria-label="Done: ${esc(t.title)}">${icon('check')}</button>
        <div style="min-width:0"><div class="ttl">${esc(t.title)}${t.priority === 'high' ? ' <span class="hint" style="color:var(--danger);font-weight:700">High</span>' : ''}</div>${t.notes ? `<div class="notes">${esc(t.notes)}</div>` : ''}</div>
        <span class="c-lvl"><span class="lvl-tag lvl-${t.load}">${icon(LEVEL_ICON[t.load])}${LEVEL_INFO[t.load].name}</span></span>
        <span class="c c-dur">${fmtDuration(t.durationMins)}</span>
        <span class="c c-dl ${overdue ? 'overdue' : ''}">${t.deadline ? esc(fmtDeadline(t.deadline, s.settings.h12, n)) : '—'}</span>
        <span class="c c-when"><span class="status-pill">${icon(ic)}${when}</span></span>
        <span class="acts"><button class="btn ghost icon small" data-act="edit" data-task="${esc(t.id)}" aria-label="Edit ${esc(t.title)}">${icon('edit')}</button>
          <button class="btn ghost icon small" data-act="more" data-task="${esc(t.id)}" aria-label="More actions for ${esc(t.title)}">${icon('more')}</button></span>
      </div>`;
    }).join('')}
  </div>`;
}

async function onClick(e) {
  const a = e.target.closest('[data-act]');
  const row = e.target.closest('.trow[data-task]');
  const s = getState();
  if (!a) { if (row) openTaskEditor(row.dataset.task); return; }
  const id = a.dataset.task;
  switch (a.dataset.act) {
    case 'new': openTaskEditor(null); break;
    case 'filter': st.filter = a.dataset.f; update(); break;
    case 'toggle': {
      const t = A.taskById(s, id);
      if (!t) break;
      if (t.doneAt) { A.setDone(id, false); toast(`Reopened “${t.title}”.`, { action: 'Undo', onAction: undoFn(), timeout: 3000 }); }
      else completeTask(id);
      break;
    }
    case 'edit': openTaskEditor(id); break;
    case 'more': {
      const t = A.taskById(s, id);
      if (!t) break;
      const status = A.statusOf(s, t);
      openMenu(a, [
        { label: 'Edit…', icon: 'edit', onClick: () => openTaskEditor(id) },
        ...(status === 'backlog' || status === 'missed' ? [{ label: 'Schedule in next matching slot', icon: 'sparkles', onClick: () => {
          const r = A.scheduleTask(id);
          if (r && r.date) toast(`Scheduled · ${fmtRelDay(r.date)} ${fmtTime(r.start, s.settings.h12)}`, { iconName: 'check', action: 'Show', onAction: () => app.go('plan', { day: r.date }) });
          else toast(`Still in the backlog — ${r && r.unplaced ? r.unplaced.reason : ''}`, { iconName: 'info', timeout: 6000 });
        } }] : []),
        ...(status === 'scheduled' || status === 'active' ? [
          { label: 'Show on plan', icon: 'calendar', onClick: () => app.go('plan', { day: A.blocksOf(s, id)[0].date }) },
          { label: 'Move to backlog', icon: 'inbox', onClick: () => { A.unscheduleTask(id); toast('Moved to the backlog.', { action: 'Undo', onAction: undoFn() }); } },
        ] : []),
        'sep',
        { label: 'Delete', icon: 'trash', danger: true, onClick: () => { A.deleteTask(id); toast(`Deleted “${t.title}”.`, { action: 'Undo', onAction: undoFn() }); } },
      ]);
      break;
    }
    case 'clear-done': {
      const ok = await confirmDialog({ title: 'Clear completed tasks?', message: 'Completed tasks and their history are removed. Insights for past days will no longer include them.', confirmLabel: 'Clear', danger: true });
      if (ok) { const n = A.clearCompleted(); toast(`Removed ${n} completed task${n === 1 ? '' : 's'}.`, { action: 'Undo', onAction: undoFn() }); }
      break;
    }
    default: break;
  }
}
