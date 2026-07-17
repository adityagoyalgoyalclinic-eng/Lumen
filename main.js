/**
 * Entry point. Boot order matters:
 *
 *   1. Settings load first, so the app never flashes the wrong theme.
 *   2. The device lock (if enrolled) gates everything before content renders.
 *   3. Encryption unlocks before any document read, or decryption throws.
 *   4. Only then do we mount the shell and route.
 */

import { open as openDb, kvGet, unlock } from './core/db.js';
import { loadSettings, state, refreshDocs, busy } from './core/store.js';
import { startRouter, go } from './core/router.js';
import { applyTheme, toast } from './ui/kit.js';
import { mountShell, bindStatus } from './ui/shell.js';
import { bindGlobalDrop, bindGlobalPaste, handleShareTarget } from './ui/import.js';
import { hasPasskey, lockScreen } from './ui/auth.js';
import { h } from './util/dom.js';

async function boot() {
  try {
    await openDb();
  } catch (err) {
    // Private browsing in some engines blocks IndexedDB outright. Say so, rather than
    // throwing a blank screen.
    return fatal(
      'Storage is unavailable',
      'Lumen needs browser storage to keep your library. This usually means private browsing is on, or storage is blocked for this site.',
      err,
    );
  }

  await loadSettings();
  applyTheme();

  if (await hasPasskey()) await lockScreen();

  // Encrypted library: derive the key before anything tries to read a document.
  if (state.settings.encrypt) {
    const salt = await kvGet('salt');
    if (salt) {
      const pass = await askPassphrase();
      if (pass) {
        try {
          await unlock(pass, salt instanceof Uint8Array ? salt : new Uint8Array(Object.values(salt)));
        } catch {
          toast('That passphrase didn’t work. Encrypted documents will stay locked.', 'err');
        }
      }
    }
  }

  mountShell();
  bindStatus();
  startRouter();
  bindGlobalDrop();
  bindGlobalPaste();

  await refreshDocs();

  // A share from the OS beats whatever route the URL says.
  await handleShareTarget();

  registerSw();
  bindInstallPrompt();

  // Warm the search index and the voice list while the user reads the home screen.
  requestIdleCallback?.(() => {
    import('./services/search.js').then((m) => m.build());
    import('./services/tts.js').then((m) => m.voices());
  }, { timeout: 3000 });
}

function askPassphrase() {
  return new Promise((resolve) => {
    const input = h('input.input', { type: 'password', placeholder: 'Passphrase', autocomplete: 'current-password' });
    const veil = h('div', {
      style: {
        position: 'fixed', inset: '0', zIndex: '150', display: 'grid', placeItems: 'center',
        background: 'var(--bg)', padding: 'var(--sp-5)',
      },
    }, h('form.card.card--pad', {
      style: { display: 'grid', gap: 'var(--sp-4)', maxWidth: '380px', width: '100%' },
      onsubmit: (e) => {
        e.preventDefault();
        veil.remove();
        resolve(input.value);
      },
    },
      h('h2', null, 'Unlock your library'),
      h('p.small.muted', null, 'Your documents are encrypted on this device.'),
      input,
      h('button.btn.btn--primary.btn--block', { type: 'submit' }, 'Unlock'),
      h('button.btn.btn--ghost.btn--sm', {
        type: 'button',
        onclick: () => {
          veil.remove();
          resolve(null);
        },
      }, 'Skip for now')));

    document.body.append(veil);
    requestAnimationFrame(() => input.focus());
  });
}

function fatal(title, message, err) {
  console.error(err);
  document.body.append(
    h('div', {
      style: { display: 'grid', placeItems: 'center', minHeight: '100dvh', padding: 'var(--sp-5)' },
    }, h('div.card.card--pad', { style: { maxWidth: '420px', textAlign: 'center', display: 'grid', gap: 'var(--sp-3)' } },
      h('h1', { style: { fontSize: 'var(--step-2)' } }, title),
      h('p.small.muted', null, message),
      h('button.btn.btn--primary', { onclick: () => location.reload() }, 'Try again'))),
  );
}

/* ------------------------------ Service worker ------------------------------ */

function registerSw() {
  if (!('serviceWorker' in navigator)) return;
  // file:// has no service worker scope; skip rather than throw a console error.
  if (location.protocol === 'file:') return;

  addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });

      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        sw?.addEventListener('statechange', () => {
          // A new version is ready, but an old one is still driving this tab.
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('A new version of Lumen is ready.', 'info', {
              ms: 12000,
              action: {
                label: 'Reload',
                fn: () => {
                  sw.postMessage({ type: 'SKIP_WAITING' });
                  location.reload();
                },
              },
            });
          }
        });
      });
    } catch (err) {
      console.warn('[sw] registration failed', err);
    }
  });
}

/* ------------------------------ Install ------------------------------ */

function bindInstallPrompt() {
  let deferred = null;

  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;

    // Don't nag: only offer installation once someone has actually used the app.
    if (state.docs.length < 2) return;
    if (localStorage.getItem('lumen.install.dismissed')) return;

    toast('Install Lumen for offline reading and lock-screen controls.', 'info', {
      ms: 10000,
      action: {
        label: 'Install',
        fn: async () => {
          deferred.prompt();
          const { outcome } = await deferred.userChoice;
          if (outcome === 'dismissed') localStorage.setItem('lumen.install.dismissed', '1');
          deferred = null;
        },
      },
    });
  });

  addEventListener('appinstalled', () => {
    localStorage.removeItem('lumen.install.dismissed');
    toast('Lumen is installed.', 'ok');
  });
}

/* ------------------------------ Global error net ------------------------------ */

addEventListener('unhandledrejection', (e) => {
  // AbortError is normal — it's how we cancel in-flight work.
  if (e.reason?.name === 'AbortError') return;
  console.error('[unhandled]', e.reason);
  busy(null);
  toast(e.reason?.message || 'Something went wrong.', 'err');
});

addEventListener('error', (e) => {
  if (e.message?.includes('ResizeObserver')) return; // benign, spec-level noise
  console.error('[error]', e.error || e.message);
});

boot().catch((err) => fatal('Lumen could not start', err.message, err));

void go;
