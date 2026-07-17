/**
 * Profiles and device lock.
 *
 * An honest note on what this is and isn't.
 *
 * Lumen is local-first: there is no Lumen server, no account database, and nothing to
 * sync to. Real "Sign in with Google/Apple" is an OAuth flow that exchanges a code for
 * a token *on a server you control*, and then syncs data *to that server*. Without a
 * backend, a Google button could only ever do one useful thing — learn your name and
 * email — while implying a cloud account that doesn't exist. Shipping that button would
 * be a lie told in UI, so we don't.
 *
 * What is real here:
 *   Guest        The default. Everything works.
 *   Profile      A local label so a shared device keeps reading histories apart.
 *   Device lock  A passkey (WebAuthn platform authenticator) or passphrase that gates
 *                access to this browser's library. The passkey genuinely uses the OS
 *                biometric prompt; it is a local gate, not a login to anywhere.
 *
 * Wiring real cloud sign-in later means implementing the `SyncAdapter` interface at the
 * bottom of this file and pointing it at a backend; the UI here already accounts for it.
 */

import { h, fill, icon } from '../util/dom.js';
import { state, setUser } from '../core/store.js';
import * as db from '../core/db.js';
import { sheet, toast } from './kit.js';

/* ------------------------------ Profile ------------------------------ */

export function openAuth(onDone) {
  const name = h('input.input', { placeholder: 'Your name', autocomplete: 'name', 'aria-label': 'Name' });
  const email = h('input.input', { type: 'email', placeholder: 'you@example.com (optional)', autocomplete: 'email', 'aria-label': 'Email' });

  const s = sheet({
    title: 'Create a profile',
    body: h('form.col', {
      onsubmit: async (e) => {
        e.preventDefault();
        const n = name.value.trim();
        if (!n) return toast('A name is needed.', 'err');
        await setUser({
          id: crypto.randomUUID(),
          name: n,
          email: email.value.trim() || '',
          provider: 'local',
          since: Date.now(),
        });
        s.close();
        toast(`Welcome, ${n.split(' ')[0]}`, 'ok');
        onDone?.();
      },
    },
      h('div.card.card--pad', { style: { display: 'grid', gap: 'var(--sp-2)' } },
        h('div.row', null, icon('info', 17), h('strong.small', null, 'This is a local profile')),
        h('p.small.muted', null,
          'Lumen has no accounts server. A profile just labels this device and keeps reading histories separate if you share it. Nothing is uploaded, and there is no password to forget.')),
      h('label.field', null, h('span.field__label', null, 'Name'), name),
      h('label.field', null, h('span.field__label', null, 'Email (optional)'), email),
      h('button.btn.btn--primary.btn--block', { type: 'submit' }, 'Create profile'),
      h('button.btn.btn--ghost.btn--block', { type: 'button', onclick: () => s.close() }, 'Stay a guest'),

      h('div', { style: { borderTop: '1px solid var(--line)', paddingTop: 'var(--sp-4)', marginTop: 'var(--sp-2)' } },
        h('span.field__label', null, 'Lock this device'),
        h('p.small.muted', { style: { marginBottom: 'var(--sp-3)' } },
          'Optional. Requires your fingerprint, face, or device PIN before the library opens.'),
        h('button.btn.btn--outline.btn--block', {
          type: 'button',
          onclick: async () => {
            const ok = await enrollPasskey(name.value.trim() || 'Lumen user');
            if (ok) toast('Device lock is on', 'ok');
          },
        }, icon('key', 16), 'Set up a passkey')),

      h('details', { style: { marginTop: 'var(--sp-2)' } },
        h('summary.small.muted', { style: { cursor: 'pointer' } }, 'Why is there no Google or Apple sign-in?'),
        h('p.small.muted', { style: { marginTop: 'var(--sp-2)' } },
          'Those buttons exist to put your library on a company’s servers so it follows you between devices. Lumen doesn’t have servers, so signing in with Google would hand over your name and email and give you nothing back. To move your library to another device, export a backup from Settings → Storage — it carries everything, and it never touches anyone else’s computer.')),
    ),
  });
  return s;
}

export async function signOut() {
  await setUser(null);
  toast('Signed out. Your library stays on this device.', 'ok');
}

/* ------------------------------ Passkey device lock ------------------------------ */

const rpId = () => location.hostname || 'localhost';

export const passkeySupported = () =>
  typeof PublicKeyCredential !== 'undefined' &&
  typeof navigator.credentials?.create === 'function' &&
  // A passkey over http:// (other than localhost) is not possible.
  (location.protocol === 'https:' || location.hostname === 'localhost');

/**
 * Create a platform passkey and remember its id.
 *
 * With no server there is nothing to verify a signature against, so this is a *local
 * gate*: possession of the authenticator plus a successful OS prompt. That is a real
 * barrier against someone picking up your unlocked laptop, and it is not authentication
 * to a remote service. We say exactly that in the UI rather than implying more.
 */
export async function enrollPasskey(displayName) {
  if (!passkeySupported()) {
    toast('Passkeys need a secure (https) connection and a device with biometrics or a PIN.', 'err');
    return false;
  }
  try {
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'Lumen', id: rpId() },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: displayName,
          displayName,
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },   // ES256
          { type: 'public-key', alg: -257 }, // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'preferred',
        },
        timeout: 60000,
        attestation: 'none', // we have no server to check attestation, so don't ask for it
      },
    });
    if (!cred) return false;
    await db.kvSet('passkey', { id: b64(cred.rawId), at: Date.now() });
    return true;
  } catch (err) {
    if (err.name !== 'NotAllowedError') toast(`Passkey setup failed: ${err.message}`, 'err');
    return false;
  }
}

export async function hasPasskey() {
  return Boolean(await db.kvGet('passkey'));
}

export async function removePasskey() {
  await db.kvDel('passkey');
}

/** Prompt for the passkey. Resolves true when the user verifies. */
export async function verifyPasskey() {
  const saved = await db.kvGet('passkey');
  if (!saved) return true;
  try {
    const got = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId: rpId(),
        allowCredentials: [{ type: 'public-key', id: unb64(saved.id) }],
        userVerification: 'required',
        timeout: 60000,
      },
    });
    return Boolean(got);
  } catch {
    return false;
  }
}

/** Full-screen lock gate shown at startup when a passkey is enrolled. */
export function lockScreen() {
  return new Promise((resolve) => {
    const status = h('p.small.muted');
    const btn = h('button.btn.btn--primary', { onclick: unlock }, icon('key', 18), 'Unlock');

    const veil = h('div', {
      style: {
        position: 'fixed', inset: '0', zIndex: '150', display: 'grid', placeItems: 'center',
        background: 'var(--bg)', padding: 'var(--sp-5)',
      },
    }, h('div.card.card--pad', { style: { display: 'grid', gap: 'var(--sp-4)', textAlign: 'center', maxWidth: '360px' } },
      h('div.empty__glyph', { style: { margin: '0 auto' } }, icon('key', 28)),
      h('h2', null, 'Lumen is locked'),
      h('p.small.muted', null, 'Use your fingerprint, face, or device PIN to open your library.'),
      btn,
      status,
      h('button.btn.btn--ghost.btn--sm', {
        onclick: async () => {
          await removePasskey();
          veil.remove();
          resolve(true);
          toast('Device lock removed', 'ok');
        },
      }, 'Remove the lock instead')));

    document.body.append(veil);

    async function unlock() {
      btn.disabled = true;
      fill(btn, h('span.spin'), 'Waiting…');
      const ok = await verifyPasskey();
      if (ok) {
        veil.remove();
        resolve(true);
      } else {
        status.textContent = 'That didn’t verify. Try again.';
        status.style.color = 'var(--danger)';
        btn.disabled = false;
        fill(btn, icon('key', 18), 'Unlock');
      }
    }
    unlock();
  });
}

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/* ------------------------------ Sync interface ------------------------------ */

/**
 * The contract a real backend would implement to turn Lumen into a syncing app.
 * Documented here so the seam is obvious; no implementation ships because no server
 * exists. `Settings → Storage → Export backup` is the supported way to move a library
 * today.
 *
 * @typedef {object} SyncAdapter
 * @property {() => Promise<{id,name,email,token}>} signIn
 * @property {() => Promise<void>} signOut
 * @property {(since:number) => Promise<{docs:Doc[], marks:object[], cursor:number}>} pull
 * @property {(changes:{docs:Doc[], marks:object[]}) => Promise<{cursor:number}>} push
 */

/** @type {SyncAdapter|null} */
export let syncAdapter = null;

export function registerSync(adapter) {
  syncAdapter = adapter;
}

void state;
