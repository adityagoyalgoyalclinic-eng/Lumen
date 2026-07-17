/**
 * UI kit — toasts, sheets, confirm dialogs, theme application.
 * Shared chrome that every screen reaches for.
 */

import { h, fill, icon, trapFocus, $ } from '../util/dom.js';
import { state, on } from '../core/store.js';

/* ------------------------------ Toasts ------------------------------ */

let toastHost = null;

function host() {
  if (!toastHost) {
    toastHost = h('div.toasts', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false' });
    document.body.append(toastHost);
  }
  return toastHost;
}

/**
 * Show a toast.
 * @param {string} msg
 * @param {'info'|'ok'|'err'} [kind]
 * @param {{action?:{label:string,fn:Function}, ms?:number}} [opts]
 */
export function toast(msg, kind = 'info', opts = {}) {
  const ms = opts.ms ?? (kind === 'err' ? 6500 : 3400);
  const node = h(
    `div.toast${kind === 'err' ? '.toast--err' : kind === 'ok' ? '.toast--ok' : ''}`,
    // Errors interrupt the screen reader; successes wait their turn.
    { role: kind === 'err' ? 'alert' : 'status' },
    icon(kind === 'err' ? 'warn' : kind === 'ok' ? 'check' : 'info', 17),
    h('span', { style: { flex: '1' } }, msg),
    opts.action &&
      h('button.btn.btn--sm.btn--ghost', {
        onclick: () => {
          opts.action.fn();
          close();
        },
      }, opts.action.label),
  );

  const close = () => {
    node.style.transition = 'opacity .2s, translate .2s';
    node.style.opacity = '0';
    node.style.translate = '0 -12px';
    setTimeout(() => node.remove(), 200);
  };

  host().append(node);
  const timer = setTimeout(close, ms);
  node.addEventListener('pointerenter', () => clearTimeout(timer)); // don't vanish mid-read
  node.addEventListener('click', (e) => {
    if (e.target === node) close();
  });
  return close;
}

/* ------------------------------ Sheets ------------------------------ */

/**
 * Open a modal sheet. Bottom sheet on phones, centred dialog on desktop.
 * @param {{title:string, body:Node|(() => Node), wide?:boolean, onClose?:Function}} opts
 * @returns {{close: Function, el: HTMLElement}}
 */
export function sheet({ title, body, onClose }) {
  const prevFocus = document.activeElement;
  const scrim = h('div.scrim', { onclick: () => close() });

  const bodyNode = typeof body === 'function' ? body() : body;
  const el = h(
    'div.sheet',
    { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div.sheet__grip'),
    h(
      'div.sheet__head',
      null,
      h('h2.sheet__title', null, title),
      h('button.icon-btn', { onclick: () => close(), 'aria-label': 'Close' }, icon('close', 20)),
    ),
    h('div.sheet__body', null, bodyNode),
  );

  const untrap = trapFocus(el);
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  el.addEventListener('keydown', onKey);

  document.body.append(scrim, el);
  document.body.style.overflow = 'hidden';

  // Focus the first control, not the close button — the close button is the last
  // resort, and landing on it makes a sheet feel like an error.
  requestAnimationFrame(() => {
    const first = el.querySelector('.sheet__body input, .sheet__body button, .sheet__body select, .sheet__body textarea');
    (first || el.querySelector('.sheet__head .icon-btn'))?.focus();
  });

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    untrap();
    document.body.style.overflow = '';
    el.style.animation = 'none';
    el.style.transition = 'translate .22s ease, opacity .22s';
    el.style.opacity = '0';
    scrim.style.opacity = '0';
    scrim.style.transition = 'opacity .22s';
    setTimeout(() => {
      el.remove();
      scrim.remove();
    }, 220);
    prevFocus instanceof HTMLElement && prevFocus.focus?.();
    onClose?.();
  }

  return { close, el };
}

/** Confirm dialog. Resolves true/false. Destructive actions get a red button. */
export function confirm({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
      s.close();
    };
    const s = sheet({
      title,
      onClose: () => finish(false),
      body: h(
        'div.col',
        null,
        h('p', { style: { color: 'var(--ink-2)' } }, message),
        h(
          'div.row',
          { style: { justifyContent: 'flex-end', marginTop: 'var(--sp-4)' } },
          h('button.btn.btn--ghost', { onclick: () => finish(false) }, 'Cancel'),
          h(
            `button.btn.${danger ? 'btn--danger' : 'btn--primary'}`,
            { onclick: () => finish(true), style: danger ? { border: '1px solid var(--danger)' } : {} },
            confirmLabel,
          ),
        ),
      ),
    });
  });
}

/** Single-field prompt. Resolves the string, or null if cancelled. */
export function ask({ title, label, value = '', placeholder = '', multiline = false, confirmLabel = 'Save' }) {
  return new Promise((resolve) => {
    let done = false;
    const input = multiline
      ? h('textarea.textarea', { value, placeholder })
      : h('input.input', { type: 'text', value, placeholder });

    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
      s.close();
    };

    const form = h(
      'form.col',
      {
        onsubmit: (e) => {
          e.preventDefault();
          finish(input.value.trim() || null);
        },
      },
      h('label.field', null, label && h('span.field__label', null, label), input),
      h(
        'div.row',
        { style: { justifyContent: 'flex-end', marginTop: 'var(--sp-3)' } },
        h('button.btn.btn--ghost', { type: 'button', onclick: () => finish(null) }, 'Cancel'),
        h('button.btn.btn--primary', { type: 'submit' }, confirmLabel),
      ),
    );

    if (!multiline) {
      input.addEventListener('keydown', (e) => e.key === 'Enter' && e.preventDefault());
    }
    const s = sheet({ title, body: form, onClose: () => finish(null) });
  });
}

/* ------------------------------ Theme ------------------------------ */

const mq = matchMedia('(prefers-color-scheme: dark)');

/** Apply the current settings to the document root. Idempotent. */
export function applyTheme() {
  const s = state.settings;
  const root = document.documentElement;

  const resolved = s.theme === 'system' ? (mq.matches ? 'dark' : 'light') : s.theme;
  root.dataset.theme = resolved;
  root.dataset.contrast = s.contrast;
  root.dataset.motion = s.motion === 'reduced' ? 'reduced' : 'auto';
  root.style.setProperty('--h', String(s.accentHue));
  root.style.fontSize = `${Math.round(16 * (s.uiScale || 1))}px`;

  // Colour the OS browser chrome to match, so the PWA doesn't have a mismatched bar.
  const bar = resolved === 'amoled' ? '#000000' : resolved === 'dark' ? hslHex(s.accentHue, 24, 8) : hslHex(s.accentHue, 40, 98);
  let meta = $('meta[name="theme-color"]');
  if (!meta) {
    meta = h('meta', { name: 'theme-color' });
    document.head.append(meta);
  }
  meta.setAttribute('content', bar);
}

/** Derive the accent hue from a document's thumbnail (dynamic colour). */
export async function accentFromImage(src) {
  if (!src) return null;
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = src;
    await img.decode();

    const c = document.createElement('canvas');
    c.width = c.height = 24; // 576 samples is plenty and costs nothing
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 24, 24);
    const { data } = ctx.getImageData(0, 0, 24, 24);

    // Average hue weighted by saturation — greys shouldn't vote, and one vivid
    // accent in a mostly-white cover is exactly the colour we want to pick up.
    let x = 0;
    let y = 0;
    let weight = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      const [hh, ss, ll] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
      if (ss < 0.18 || ll < 0.12 || ll > 0.92) continue;
      const rad = (hh * Math.PI) / 180;
      const w = ss * (1 - Math.abs(ll - 0.5) * 1.2);
      x += Math.cos(rad) * w;
      y += Math.sin(rad) * w;
      weight += w;
    }
    if (weight < 2) return null; // image is essentially greyscale
    const hue = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    return Math.round(hue);
  } catch {
    return null; // tainted canvas (cross-origin cover) — not worth reporting
  }
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let hh;
  if (max === r) hh = ((g - b) / d + (g < b ? 6 : 0));
  else if (max === g) hh = (b - r) / d + 2;
  else hh = (r - g) / d + 4;
  return [hh * 60, s, l];
}

function hslHex(hue, s, l) {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n) => {
    const k = (n + hue / 30) % 12;
    const v = l / 100 - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * v).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

mq.addEventListener('change', () => state.settings.theme === 'system' && applyTheme());
on('settings', applyTheme);

/* ------------------------------ Misc ------------------------------ */

export function empty(glyph, title, sub, action) {
  return h(
    'div.empty',
    null,
    h('div.empty__glyph', null, icon(glyph, 30)),
    h('h3', { style: { color: 'var(--ink)' } }, title),
    sub && h('p.small', { style: { maxWidth: '38ch' } }, sub),
    action &&
      h('button.btn.btn--primary', { onclick: action.fn, style: { marginTop: 'var(--sp-2)' } },
        icon('add', 18), action.label),
  );
}

export function skeletonGrid(n = 6) {
  return h(
    'div.grid',
    null,
    ...Array.from({ length: n }, () =>
      h('div.skel', { style: { height: '210px' }, 'aria-hidden': 'true' })),
  );
}

/** Relative time that stays readable: "just now", "3h ago", "12 Mar". */
export function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Seconds → "1h 04m" / "4:20". */
export function dur(sec) {
  const s = Math.max(0, Math.round(sec));
  const hrs = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (hrs) return `${hrs}h ${String(m).padStart(2, '0')}m`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export const KIND_ICON = {
  pdf: 'doc', docx: 'doc', txt: 'doc', md: 'doc', rtf: 'doc', html: 'globe',
  epub: 'book', book: 'book', web: 'globe', image: 'image', scan: 'camera',
  clip: 'clip', email: 'note',
};

export const KIND_LABEL = {
  pdf: 'PDF', docx: 'DOCX', epub: 'EPUB', txt: 'TXT', md: 'MD', html: 'HTML',
  rtf: 'RTF', image: 'Scan', web: 'Web', clip: 'Text', email: 'Email',
};

export { fill };
