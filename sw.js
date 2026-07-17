/**
 * Lumen service worker.
 *
 * Caching strategy, by resource class:
 *
 *   App shell (HTML/CSS/JS)   Stale-while-revalidate. The app opens instantly from
 *                             cache and quietly updates in the background.
 *   Parser engines (CDN)      Cache-first, forever. pdf.js and the Tesseract WASM are
 *                             version-pinned and ~12 MB; re-fetching them would be
 *                             wasteful and would break offline scanning.
 *   Navigations               Network-first with a cache fallback, so a deploy is
 *                             picked up promptly but the app still opens on a plane.
 *   Everything else           Passed through untouched. We never cache a user's
 *                             article fetches or their AI requests — that's their
 *                             content, and it doesn't belong in a shared HTTP cache.
 */

const VERSION = 'v1.0.0';
const SHELL = `lumen-shell-${VERSION}`;
const ENGINES = 'lumen-engines'; // deliberately unversioned: pinned URLs, keep forever

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/tokens.css',
  './styles/base.css',
  './styles/components.css',
  './src/main.js',
  './src/core/db.js',
  './src/core/store.js',
  './src/core/router.js',
  './src/util/dom.js',
  './src/util/text.js',
  './src/util/sanitize.js',
  './src/services/extract.js',
  './src/services/reader-web.js',
  './src/services/ocr.js',
  './src/services/tts.js',
  './src/services/media.js',
  './src/services/ai.js',
  './src/services/search.js',
  './src/services/export.js',
  './src/ui/kit.js',
  './src/ui/shell.js',
  './src/ui/home.js',
  './src/ui/library.js',
  './src/ui/search.js',
  './src/ui/import.js',
  './src/ui/reader.js',
  './src/ui/player.js',
  './src/ui/settings.js',
  './src/ui/ai-panel.js',
  './src/ui/auth.js',
  './src/ui/doc-card.js',
  './src/ui/export-sheet.js',
  './assets/icon.svg',
];

const ENGINE_HOSTS = ['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // addAll is atomic — one 404 fails the whole install. Add individually so a
    // single missing asset can't brick the worker.
    await Promise.all(SHELL_FILES.map((f) =>
      cache.add(new Request(f, { cache: 'reload' })).catch((err) =>
        console.warn('[sw] skipped', f, err.message))));
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((n) => {
      // Drop old shell versions; never drop the engine cache.
      if (n === ENGINES || n === SHELL) return null;
      if (n.startsWith('lumen-shell-')) return caches.delete(n);
      return null;
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never touch the user's own content or third-party APIs.
  if (url.hostname === 'api.anthropic.com') return;
  if (request.headers.get('x-api-key')) return;

  // Parser engines: cache forever, at pinned versions.
  if (ENGINE_HOSTS.includes(url.hostname)) {
    e.respondWith(cacheFirst(request, ENGINES));
    return;
  }

  // Same-origin only from here on.
  if (url.origin !== location.origin) return;

  if (request.mode === 'navigate') {
    e.respondWith(networkFirst(request));
    return;
  }

  e.respondWith(staleWhileRevalidate(request));
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;

  try {
    const res = await fetch(request);
    // `opaque` responses (no-cors cross-origin) have status 0 but are still usable.
    if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
    return res;
  } catch (err) {
    return new Response(
      `/* Lumen: this engine isn't downloaded yet and you're offline. */\nthrow new Error("Engine unavailable offline");`,
      { status: 503, headers: { 'content-type': 'application/javascript' } },
    );
  }
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    return (await cache.match(request)) ||
      (await cache.match('./index.html')) ||
      new Response('<h1>Offline</h1><p>Lumen could not load.</p>', {
        status: 503,
        headers: { 'content-type': 'text/html' },
      });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request);

  const network = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);

  // Serve the cached copy immediately; the refresh lands for the next load.
  return hit || (await network) || new Response('', { status: 504 });
}
