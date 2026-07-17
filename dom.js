/**
 * Tiny DOM layer.
 *
 * Lumen deliberately has no framework: the whole app is a few thousand lines and a
 * hyperscript helper plus targeted re-renders beat shipping a runtime. `h()` is the
 * only construction primitive; everything in ui/ builds on it.
 */

/**
 * Create an element.
 * @param {string} tag - Tag name, optionally with `.class` and `#id` suffixes ("button.btn.btn--primary").
 * @param {object|null} [props] - Properties. `class`, `style` (object), `dataset`, `on*` handlers,
 *   `aria-*`/`data-*` attributes, and `html` (trusted innerHTML) get special handling.
 * @param {...(Node|string|number|false|null|undefined|Array)} kids - Children; falsy values are skipped.
 * @returns {HTMLElement}
 */
export function h(tag, props, ...kids) {
  const [name, ...classes] = tag.split('.');
  let id = null;
  let tagName = name;
  if (name.includes('#')) {
    const parts = name.split('#');
    tagName = parts[0];
    id = parts[1];
  }
  const node = document.createElement(tagName || 'div');
  if (id) node.id = id;
  if (classes.length) node.classList.add(...classes);

  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.classList.add(...String(v).split(' ').filter(Boolean));
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k.includes('-') || k === 'role' || k === 'for' || k === 'viewBox') {
        node.setAttribute(k === 'for' ? 'htmlFor' in node ? 'for' : k : k, v === true ? '' : v);
      } else {
        node[k] = v;
      }
    }
  }

  add(node, kids);
  return node;
}

function add(parent, kids) {
  for (const kid of kids) {
    if (kid == null || kid === false || kid === '') continue;
    if (Array.isArray(kid)) add(parent, kid);
    else parent.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Replace all children of `node` with `kids`. */
export function fill(node, ...kids) {
  node.replaceChildren();
  add(node, kids);
  return node;
}

/**
 * Icon set. Original 24px line glyphs on a common grid — stroke 1.75, round caps —
 * so they sit together as one family. No third-party icon font is loaded.
 */
const PATHS = {
  home: 'M3 10.2 12 3l9 7.2M5.5 9v10.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9',
  library: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H8v16H5.5A1.5 1.5 0 0 1 4 18.5zM11 4h2.5v16H11zM16.8 4.6l2.4.6a1 1 0 0 1 .7 1.2l-3.2 12.8a1 1 0 0 1-1.2.7l-1-.2',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  add: 'M12 5v14M5 12h14',
  settings: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.5 15h-.3a2 2 0 1 1 0-4h.2A1.6 1.6 0 0 0 4.5 8.2l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 4.5v-.3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.3a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.3 1z',
  play: 'M7 4.8v14.4a.7.7 0 0 0 1.07.6l11.3-7.2a.7.7 0 0 0 0-1.2L8.07 4.2A.7.7 0 0 0 7 4.8z',
  pause: 'M8 4.5h3v15H8zM13 4.5h3v15h-3z',
  stop: 'M6.5 6.5h11v11h-11z',
  next: 'M6 5.5v13l9-6.5zM17 5.5v13',
  prev: 'M18 5.5v13l-9-6.5zM7 5.5v13',
  fwd: 'M4 5.5v13l8-6.5zM12 5.5v13l8-6.5z',
  back: 'M20 5.5v13l-8-6.5zM12 5.5v13l-8-6.5z',
  close: 'M6 6l12 12M18 6 6 18',
  chevL: 'M14.5 5 8 12l6.5 7',
  chevR: 'M9.5 5 16 12l-6.5 7',
  chevD: 'M5 9.5 12 16l7-6.5',
  doc: 'M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5zM13.5 3v5.5H19M9 13h6M9 17h4',
  book: 'M4 4.5h6a3 3 0 0 1 2 2.8V20a2.4 2.4 0 0 0-2-1.6H4zM20 4.5h-6a3 3 0 0 0-2 2.8V20a2.4 2.4 0 0 1 2-1.6h6z',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3.2 9h17.6M3.2 15h17.6M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  image: 'M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18V6A1.5 1.5 0 0 1 5 4.5zM8.5 10.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM20.5 15l-4.5-4.5L6 20.5',
  camera: 'M4.5 8h3l1.5-2.5h6L16.5 8h3A1.5 1.5 0 0 1 21 9.5v9A1.5 1.5 0 0 1 19.5 20h-15A1.5 1.5 0 0 1 3 18.5v-9A1.5 1.5 0 0 1 4.5 8zM12 17a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2z',
  clip: 'M9 3.5h6a1 1 0 0 1 1 1V6H8V4.5a1 1 0 0 1 1-1zM8 5H6.5a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 17.5 5H16',
  link: 'M10.5 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.7 1.7M13.5 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 1 0 5.7 5.7l1.7-1.7',
  star: 'M12 3.6l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z',
  pin: 'M12 21v-6M8 3.5h8l-1 6 2.5 3v2.5H6.5V12.5L9 9.5z',
  folder: 'M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z',
  down: 'M12 3.5v12M7 11l5 5 5-5M4.5 20.5h15',
  up: 'M12 20.5v-12M7 13l5-5 5 5M4.5 3.5h15',
  trash: 'M4.5 6.5h15M9.5 6.5V4.8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.7M6.5 6.5l.8 13a1 1 0 0 0 1 .9h7.4a1 1 0 0 0 1-.9l.8-13M10 10.5v6M14 10.5v6',
  sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5.2l3.4 2',
  bookmark: 'M6.5 4.5h11a1 1 0 0 1 1 1v14.6l-6.5-4-6.5 4V5.5a1 1 0 0 1 1-1z',
  note: 'M5 4.5h14a.5.5 0 0 1 .5.5v10L14.5 20.5H5a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5zM19.5 15h-4.5a.5.5 0 0 0-.5.5v5',
  hl: 'M4 20.5h6M13 3.5 8 8.5l-2.5 5.5 2 2L13 13.5l5-5z M9.5 10 14 5.5',
  ul: 'M4 20.5h16M7.5 3.5v6a4.5 4.5 0 1 0 9 0v-6',
  voice: 'M12 3.5a3 3 0 0 0-3 3v5a3 3 0 1 0 6 0v-5a3 3 0 0 0-3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3',
  speed: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 12l4-4M12 12h.01',
  sun: 'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8',
  moon: 'M20.5 14.3A8.6 8.6 0 0 1 9.7 3.5a8.6 8.6 0 1 0 10.8 10.8z',
  font: 'M4 19 9.5 5h1.6L16.5 19M6.5 14.5h7.6M18 19V9.5M18 19h3M18 9.5h3',
  focus: 'M4 8.5V5.5a1.5 1.5 0 0 1 1.5-1.5h3M15.5 4h3A1.5 1.5 0 0 1 20 5.5v3M20 15.5v3a1.5 1.5 0 0 1-1.5 1.5h-3M8.5 20h-3A1.5 1.5 0 0 1 4 18.5v-3M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  expand: 'M8.5 3.5h-5v5M15.5 3.5h5v5M20.5 15.5v5h-5M3.5 15.5v5h5',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5a7.5 7.5 0 0 1 15 0',
  logout: 'M9 20.5H5.5A1.5 1.5 0 0 1 4 19V5a1.5 1.5 0 0 1 1.5-1.5H9M16 16.5l4.5-4.5L16 7.5M20.5 12H9',
  check: 'M4.5 12.5 9.5 18 20 6.5',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.6v.1',
  warn: 'M10.3 4.3 2.6 17.5a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0zM12 9v4.5M12 17v.1',
  shield: 'M12 3.2l7.5 3v5.3c0 4.5-3 8.5-7.5 9.8-4.5-1.3-7.5-5.3-7.5-9.8V6.2z',
  cards: 'M8.5 3.5h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1zM4.5 7v12a1 1 0 0 0 1 1h12',
  quiz: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.4 9.2a2.7 2.7 0 1 1 3.6 2.5c-.7.3-1 .9-1 1.6v.4M12 17v.1',
  key: 'M15.5 3.5a5 5 0 1 0-4.3 7.5c.4 0 .8 0 1.1-.1L14 12.5h2v2h2v2h2.5l1-1v-2.7l-6.4-6.4',
  scroll: 'M12 4.5v15M8 8l4-4 4 4M8 16l4 4 4-4',
  translate: 'M3.5 5.5h9M8 3.5v2M10.5 5.5c0 4-3 8-7 9M6 9.5c1.2 2.8 3.5 4.8 6 5.8M13 20.5l4.5-11 4.5 11M14.8 17h5.4',
  list: 'M8 6.5h12M8 12h12M8 17.5h12M4 6.5h.01M4 12h.01M4 17.5h.01',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  more: 'M12 6.5h.01M12 12h.01M12 17.5h.01',
  filter: 'M3.5 5.5h17l-6.5 8v6l-4 2v-8z',
  offline: 'M3 3l18 18M8.5 16.5a4 4 0 0 1 .8-7.9M16 8.5a4.5 4.5 0 0 1 1.5 8.4M12 6.5a5.5 5.5 0 0 1 3 1',
  wifi: 'M12 18.5h.01M8.5 15a5 5 0 0 1 7 0M5.5 11.5a9.5 9.5 0 0 1 13 0M2.5 8a14 14 0 0 1 19 0',
};

/**
 * Render an icon.
 * @param {keyof typeof PATHS} name
 * @param {number} [size=22]
 * @returns {SVGSVGElement}
 */
export function icon(name, size = 22) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.flex = 'none';
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', PATHS[name] || PATHS.doc);
  // Play/stop read as solid shapes; the rest are line glyphs.
  if (name === 'play' || name === 'pause' || name === 'stop' || name === 'next' ||
      name === 'prev' || name === 'fwd' || name === 'back' || name === 'bookmark') {
    p.setAttribute('fill', 'currentColor');
  }
  svg.append(p);
  return svg;
}

/** The Lumen wordmark glyph: an aperture ring around a reading bar. Original artwork. */
export function logo(size = 36) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `
    <defs>
      <linearGradient id="lg-${size}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="var(--accent-hi)"/>
        <stop offset="1" stop-color="var(--accent-lo)"/>
      </linearGradient>
    </defs>
    <rect x="2" y="2" width="44" height="44" rx="14" fill="url(#lg-${size})"/>
    <path d="M24 10a14 14 0 1 1 0 28" fill="none" stroke="var(--accent-ink)" stroke-width="3"
          stroke-linecap="round" opacity=".55"/>
    <path d="M17 17h14M17 24h14M17 31h8" stroke="var(--accent-ink)" stroke-width="3" stroke-linecap="round"/>`;
  return svg;
}

/** Trap Tab focus inside `node` until the returned function is called. */
export function trapFocus(node) {
  const sel = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';
  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const items = $$(sel, node).filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  node.addEventListener('keydown', onKey);
  return () => node.removeEventListener('keydown', onKey);
}
