// EnergyMap — small UI toolkit: icons, escaping, toasts, dialogs, menus, files, tooltips.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);

/** Remember which control has focus (by id or data-fk) so a re-render can put focus back. */
export function focusKey(root) {
  const a = document.activeElement;
  if (!a || a === document.body || (root && !root.contains(a))) return null;
  if (a.id) return { id: a.id };
  if (a.dataset && a.dataset.fk) return { fk: a.dataset.fk };
  return null;
}
export function refocus(root, key) {
  if (!key || !root) return;
  const esc2 = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, '\\$&'));
  const el = key.id ? root.querySelector('#' + esc2(key.id)) : root.querySelector(`[data-fk="${esc2(key.fk)}"]`);
  if (el && document.activeElement !== el) el.focus({ preventScroll: true });
}
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ───────────── icons (24×24, stroke) ─────────────
const P = {
  plan: '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4M7.5 13.5h3M7.5 17h6"/>',
  tasks: '<path d="M10 6.5h10M10 12h10M10 17.5h10"/><path d="M3.5 6.5l1.4 1.4L7.5 5.2M3.5 12l1.4 1.4 2.6-2.7M3.5 17.5l1.4 1.4 2.6-2.7"/>',
  energy: '<path d="M2.5 12.5h3.8l2.6-7 4.4 13 2.8-6h5.4"/>',
  insights: '<path d="M3 20.5h18"/><rect x="5" y="11" width="3.2" height="6.5" rx="1"/><rect x="10.4" y="5" width="3.2" height="12.5" rx="1"/><rect x="15.8" y="8.5" width="3.2" height="9" rx="1"/>',
  settings: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  'chevron-left': '<path d="M15 6l-6 6 6 6"/>',
  'chevron-right': '<path d="M9 6l6 6-6 6"/>',
  'chevron-down': '<path d="M6 9l6 6 6-6"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  sparkles: '<path d="M11 3.5l1.7 4.6 4.6 1.7-4.6 1.7L11 16.1l-1.7-4.6-4.6-1.7 4.6-1.7z"/><path d="M18.5 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 13.5l5-5 5 5M5 4h14"/>',
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  pin: '<path d="M9 3.5h6l-1 5.5 3 3V14H7v-2l3-3z"/><path d="M12 14v6.5"/>',
  more: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  battery: '<rect x="2.5" y="7" width="17" height="10" rx="2.5"/><path d="M22 10.5v3M6 10.5v3M9.5 10.5v3"/>',
  bell: '<path d="M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.2"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4.5M12 17.3v.2"/>',
  undo: '<path d="M9 5L4 10l5 5"/><path d="M4 10h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="M15 5l5 5-5 5"/><path d="M20 10H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  play: '<path d="M8 5.5v13l10-6.5z"/>',
  coffee: '<path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16M8 3.5v2M12 3.5v2"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7 14h10"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .9-1 1.6v.5M12 17v.2"/>',
  bolt: '<path d="M13 2.5L4.5 13.5H11l-1 8L19.5 10H13z"/>',
  waves: '<path d="M2.5 9.5c2.4-2.3 4.8-2.3 7.2 0s4.8 2.3 7.2 0c1.6-1.5 3-1.9 4.6-1"/><path d="M2.5 15.5c2.4-2.3 4.8-2.3 7.2 0s4.8 2.3 7.2 0c1.6-1.5 3-1.9 4.6-1"/>',
  leaf: '<path d="M5 19C5 10.5 10 5 20 4c-.6 9.6-6 15-15 15z"/><path d="M5 19l8-8"/>',
  grip: '<circle cx="9" cy="6.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="6.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="17.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="17.5" r="1.2" fill="currentColor" stroke="none"/>',
  busy: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M7 9l10 10M3.5 13.5L10 20M13 5l7.5 7.5"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  inbox: '<path d="M3.5 13.5l2.5-8h12l2.5 8v5a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3.5 18.5z"/><path d="M3.5 13.5H8l1.5 2.5h5l1.5-2.5h4.5"/>',
  split: '<path d="M4 6h6l4 6-4 6H4M14 12h6"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
};

export function icon(name, cls = '') {
  const body = P[name] || P.info;
  return `<svg class="${cls}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

export const LEVEL_ICON = { peak: 'bolt', steady: 'waves', low: 'leaf' };

/** The EnergyMap logo mark (inline, theme-independent). */
export function logoSVG(cls = 'logo') {
  return `<svg class="${cls}" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
  <defs><linearGradient id="lg-wave" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#F2B312"/><stop offset=".52" stop-color="#3D8BEF"/><stop offset="1" stop-color="#D45BAE"/></linearGradient>
  <linearGradient id="lg-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1D1D26"/><stop offset="1" stop-color="#0C0C11"/></linearGradient></defs>
  <rect x="2" y="2" width="60" height="60" rx="15" fill="url(#lg-bg)"/>
  <path d="M10 41 C 16 41, 18 15, 25 15 C 32 15, 33 40, 40 40 C 46 40, 47 29, 54 29" fill="none" stroke="url(#lg-wave)" stroke-width="6.5" stroke-linecap="round"/>
  <circle cx="25" cy="15" r="4.2" fill="#F2B312"/></svg>`;
}

// ───────────── toasts ─────────────
let toastRoot;
export function toast(message, { action = null, onAction = null, timeout = 5200, iconName = null, html = false, extra = null } = {}) {
  toastRoot = toastRoot || document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.innerHTML = `${iconName ? icon(iconName, 't-ico') : ''}<div class="msg">${html ? message : esc(message)}</div>`;
  if (extra) el.appendChild(extra);
  let timer = null;
  const close = () => { clearTimeout(timer); el.style.opacity = '0'; el.style.transition = 'opacity .18s'; setTimeout(() => el.remove(), 180); };
  if (action) {
    const b = document.createElement('button');
    b.className = 't-btn'; b.type = 'button'; b.textContent = action;
    b.addEventListener('click', () => { close(); onAction && onAction(); });
    el.appendChild(b);
  }
  const x = document.createElement('button');
  x.className = 't-x'; x.type = 'button'; x.setAttribute('aria-label', 'Dismiss'); x.innerHTML = icon('x');
  x.addEventListener('click', close);
  el.appendChild(x);
  toastRoot.appendChild(el);
  while (toastRoot.children.length > 3) toastRoot.firstElementChild.remove();
  if (timeout) {
    timer = setTimeout(close, timeout);
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('mouseleave', () => { timer = setTimeout(close, 2500); });
  }
  return { el, close };
}

// ───────────── modal dialogs ─────────────
const modalStack = [];
export function openModal({ title, body, actions = [], wide = false, onClose = null, labelledBy = null, initialFocus = null, dismissible = true }) {
  closeMenu();
  const openedAt = Date.now();
  const prevFocus = document.activeElement;
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  const id = 'm' + Math.random().toString(36).slice(2, 8);
  back.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="${labelledBy || id}">
    <div class="modal-head"><h2 id="${id}">${esc(title)}</h2>${dismissible ? `<button class="btn ghost icon small" data-x aria-label="Close">${icon('x')}</button>` : ''}</div>
    <div class="modal-body"></div><div class="modal-foot"></div></div>`;
  const modal = back.querySelector('.modal');
  const bodyEl = back.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
  const foot = back.querySelector('.modal-foot');
  let closed = false;
  const api = {
    el: modal, body: bodyEl, foot,
    close(result) {
      if (closed) return; closed = true;
      back.remove();
      const i = modalStack.indexOf(api); if (i >= 0) modalStack.splice(i, 1);
      document.removeEventListener('keydown', onKey, true);
      if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch { /* gone */ }
      onClose && onClose(result);
    },
  };
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${a.kind || ''} ${a.left ? 'left' : ''}`;
    b.innerHTML = (a.icon ? icon(a.icon) : '') + esc(a.label);
    if (a.id) b.id = a.id;
    b.addEventListener('click', () => { const r = a.onClick ? a.onClick(api) : undefined; if (r !== false) api.close(a.value); });
    foot.appendChild(b);
  }
  if (!actions.length) foot.remove();
  const onKey = (e) => {
    if (modalStack[modalStack.length - 1] !== api) return;
    if (e.key === 'Escape' && dismissible) { e.preventDefault(); e.stopPropagation(); api.close(); }
    if (e.key === 'Tab') {
      const f = $$('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])', modal).filter((n) => n.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', onKey, true);
  // ignore the second click of a double-click that opened the dialog
  back.addEventListener('mousedown', (e) => { if (e.target === back && dismissible && Date.now() - openedAt > 450) api.close(); });
  const x = back.querySelector('[data-x]');
  if (x) x.addEventListener('click', () => api.close());
  document.body.appendChild(back);
  modalStack.push(api);
  requestAnimationFrame(() => {
    // first field, else the main action — never a secondary button like "Skip" or "Cancel"
    const target = (initialFocus && modal.querySelector(initialFocus)) || modal.querySelector('input, select, textarea')
      || modal.querySelector('.modal-foot .btn.primary') || modal.querySelector('button');
    target && target.focus();
  });
  return api;
}

export const anyModalOpen = () => modalStack.length > 0;

export function confirmDialog({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: `<p class="prose">${message}</p>`,
      actions: [
        { label: cancelLabel, value: false },
        { label: confirmLabel, kind: danger ? 'danger solid' : 'primary', value: true },
      ],
      onClose: (v) => resolve(v === true),
      initialFocus: '.btn.primary, .btn.danger',
    });
  });
}

// ───────────── context menus ─────────────
let openMenuEl = null;
export function closeMenu() {
  if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', menuKey, true); }
}
function outside(e) { if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu(); }
function menuKey(e) {
  if (!openMenuEl) return;
  const items = $$('.mi:not([disabled])', openMenuEl);
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const a = openMenuEl._anchor; closeMenu(); a && a.focus && a.focus(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  else if (e.key === 'Tab') closeMenu();
}
/** items: [{label, icon, onClick, danger, disabled, shortcut} | 'sep' | {header}] ; at: element or {x,y} */
export function openMenu(at, items) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'menu';
  m.setAttribute('role', 'menu');
  for (const it of items) {
    if (it === 'sep') { m.appendChild(document.createElement('hr')); continue; }
    if (it.header) { const h = document.createElement('div'); h.className = 'mh'; h.textContent = it.header; m.appendChild(h); continue; }
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'mi' + (it.danger ? ' danger' : ''); b.setAttribute('role', 'menuitem');
    if (it.disabled) b.disabled = true;
    b.innerHTML = `${it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span>${it.shortcut ? `<span class="sc">${esc(it.shortcut)}</span>` : ''}`;
    b.addEventListener('click', () => { closeMenu(); it.onClick && it.onClick(); });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = at instanceof Element ? at.getBoundingClientRect() : { left: at.x, right: at.x, top: at.y, bottom: at.y };
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let x = r.left, y = r.bottom + 4;
  if (x + mw > innerWidth - 8) x = Math.max(8, (at instanceof Element ? r.right : r.left) - mw);
  if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 4);
  m.style.left = `${x}px`; m.style.top = `${y}px`;
  m._anchor = at instanceof Element ? at : null;
  openMenuEl = m;
  setTimeout(() => {
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', menuKey, true);
    m.querySelector('.mi:not([disabled])')?.focus();
  }, 0);
  return m;
}

// ───────────── tooltip (charts) ─────────────
let tipEl;
export function showTip(html, x, y) {
  tipEl = tipEl || Object.assign(document.createElement('div'), { className: 'tooltip' });
  if (!tipEl.isConnected) document.body.appendChild(tipEl);
  tipEl.innerHTML = html;
  const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  let left = x + 14, top = y - h - 10;
  if (left + w > innerWidth - 8) left = x - w - 14;
  if (top < 8) top = y + 16;
  tipEl.style.left = `${left}px`; tipEl.style.top = `${top}px`;
  tipEl.hidden = false;
}
export function hideTip() { if (tipEl) tipEl.hidden = true; }

// ───────────── files ─────────────
export async function saveFile(filename, content, mime, description = 'File') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  if (window.showSaveFilePicker) {
    try {
      const ext = '.' + filename.split('.').pop();
      const handle = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description, accept: { [mime]: [ext] } }] });
      const w = await handle.createWritable();
      await w.write(blob); await w.close();
      return { saved: true, name: handle.name };
    } catch (e) {
      if (e && e.name === 'AbortError') return { saved: false, cancelled: true };
      // fall through to download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return { saved: true, name: filename, downloaded: true };
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const inp = Object.assign(document.createElement('input'), { type: 'file', accept });
    inp.style.display = 'none';
    inp.addEventListener('change', () => { resolve(inp.files && inp.files[0] ? inp.files[0] : null); inp.remove(); });
    inp.addEventListener('cancel', () => { resolve(null); inp.remove(); });
    document.body.appendChild(inp);
    inp.click();
  });
}

export function readText(file) {
  if (file.text) return file.text();
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file); });
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove(); return ok;
  }
}

/** Soft chime (Web Audio) for reminders. */
let audioCtx;
export function chime() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    [660, 880].forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.16);
      g.gain.exponentialRampToValueAtTime(0.18, t + i * 0.16 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.16 + 0.5);
      o.connect(g).connect(audioCtx.destination);
      o.start(t + i * 0.16); o.stop(t + i * 0.16 + 0.55);
    });
  } catch { /* audio unavailable */ }
}
