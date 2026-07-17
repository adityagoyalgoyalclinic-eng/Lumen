/**
 * Hash router.
 *
 * Hash routing (not History API) is deliberate: Lumen must run from `file://`, from a
 * static host with no server rewrites, and as an installed PWA, and only hashes work
 * unmodified in all three.
 */

import { state, emit } from './store.js';

const ROUTES = [
  { name: 'home', re: /^\/?$/ },
  { name: 'library', re: /^\/library(?:\/([\w-]+))?$/, keys: ['folder'] },
  { name: 'search', re: /^\/search$/ },
  { name: 'import', re: /^\/import$/ },
  { name: 'settings', re: /^\/settings(?:\/([\w-]+))?$/, keys: ['tab'] },
  { name: 'reader', re: /^\/read\/([\w-]+)$/, keys: ['id'] },
  { name: 'auth', re: /^\/auth$/ },
];

function parse(hash) {
  const raw = decodeURIComponent(String(hash || '').replace(/^#/, '')) || '/';
  const [path, qs] = raw.split('?');
  for (const r of ROUTES) {
    const m = r.re.exec(path);
    if (!m) continue;
    const params = Object.fromEntries(new URLSearchParams(qs || ''));
    (r.keys || []).forEach((k, i) => {
      if (m[i + 1] != null) params[k] = m[i + 1];
    });
    return { name: r.name, params };
  }
  return { name: 'home', params: {} };
}

/** Navigate. Pushes history unless `replace` is set. */
export function go(path, { replace = false } = {}) {
  const target = `#${path.startsWith('/') ? path : `/${path}`}`;
  if (location.hash === target) return;
  if (replace) history.replaceState(null, '', target);
  else location.hash = target;
  if (replace) sync();
}

export const back = () => (history.length > 1 ? history.back() : go('/'));

function sync() {
  const next = parse(location.hash);
  const prev = state.route;
  if (prev.name === next.name && JSON.stringify(prev.params) === JSON.stringify(next.params)) return;
  state.route = next;
  emit('route');
}

export function startRouter() {
  addEventListener('hashchange', sync);
  sync();
}

export const currentRoute = () => parse(location.hash);
