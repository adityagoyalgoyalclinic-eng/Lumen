/**
 * System media integration — lock screen, Bluetooth, headphones, Android Auto, CarPlay.
 *
 * Two mechanisms:
 *
 *  1. Media Session API. Publishing metadata + action handlers is what puts Lumen on
 *     the lock screen and notification shade, and it is also what Android Auto and
 *     CarPlay read. The same handlers are what a Bluetooth remote or headphone
 *     play/pause button triggers, so wiring this once covers every remote surface.
 *
 *  2. A silent looping audio element. speechSynthesis alone does not hold audio focus
 *     on mobile: the OS sees no playing media, so it neither shows controls nor keeps
 *     the tab alive when the screen locks. Playing a silent track alongside speech
 *     makes the session real. This is the standard workaround for the gap between the
 *     Speech and Media Session APIs.
 */

/** @type {HTMLAudioElement|null} */
let silent = null;
let handlers = {};

/** A 1-second silent WAV, inlined so it costs no request and works offline. */
const SILENCE =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

function ensureAudio() {
  if (silent) return silent;
  silent = new Audio(SILENCE);
  silent.loop = true;
  silent.volume = 0.0001; // not 0 — some engines treat a muted track as "not playing"
  silent.preload = 'auto';
  silent.setAttribute('aria-hidden', 'true');
  return silent;
}

/**
 * Register control handlers. Call once at startup.
 * @param {{play:Function, pause:Function, next:Function, prev:Function,
 *          stop:Function, seekTo?:Function, forward?:Function, backward?:Function}} h
 */
export function bindControls(h) {
  handlers = h;
  if (!('mediaSession' in navigator)) return;

  const safe = (fn) => (...args) => {
    try { fn?.(...args); } catch (err) { console.error('[media] handler failed', err); }
  };

  const map = {
    play: safe(h.play),
    pause: safe(h.pause),
    stop: safe(h.stop),
    nexttrack: safe(h.next),
    previoustrack: safe(h.prev),
    seekforward: safe(h.forward || h.next),
    seekbackward: safe(h.backward || h.prev),
  };

  for (const [action, fn] of Object.entries(map)) {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported action */ }
  }

  if (h.seekTo) {
    try {
      navigator.mediaSession.setActionHandler('seekto', safe((e) => h.seekTo(e.seekTime)));
    } catch { /* unsupported */ }
  }
}

/**
 * Publish what's playing to the OS.
 * @param {{title:string, artist?:string, album?:string, artwork?:string}} info
 */
export function setMetadata({ title, artist = 'Lumen', album = '', artwork }) {
  if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title || 'Lumen',
      artist,
      album,
      artwork: artwork
        ? [{ src: artwork, sizes: '512x512', type: 'image/jpeg' }]
        : [
            { src: 'assets/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'assets/icon-512.png', sizes: '512x512', type: 'image/png' },
          ],
    });
  } catch (err) {
    console.warn('[media] metadata rejected', err);
  }
}

/** Reflect the scrubber on the lock screen. Durations are estimates from word counts. */
export function setPosition({ duration, position, rate = 1 }) {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  try {
    const d = Math.max(0, Number(duration) || 0);
    navigator.mediaSession.setPositionState({
      duration: d,
      position: Math.min(Math.max(0, Number(position) || 0), d),
      playbackRate: Math.max(0.1, rate),
    });
  } catch { /* position state is strict about ordering; a bad value is not fatal */ }
}

/** @param {'playing'|'paused'|'none'} s */
export async function setState(s) {
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = s;

  const a = ensureAudio();
  if (s === 'playing') {
    try {
      await a.play();
    } catch {
      // Autoplay blocked until the user gestures. The play button is a gesture, so
      // this resolves itself on the first real press; controls just appear a beat late.
    }
  } else if (s === 'none') {
    a.pause();
    a.currentTime = 0;
  } else {
    a.pause();
  }
}

export function release() {
  if (silent) {
    silent.pause();
    silent.src = '';
    silent = null;
  }
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
    for (const a of ['play', 'pause', 'stop', 'nexttrack', 'previoustrack', 'seekforward', 'seekbackward', 'seekto']) {
      try { navigator.mediaSession.setActionHandler(a, null); } catch { /* ignore */ }
    }
  }
  handlers = {};
}

/**
 * Keyboard media keys, for desktop users without a Media Session-aware OS shell.
 * Ignored while typing so a play/pause key in a text field doesn't hijack input.
 */
export function bindKeys() {
  addEventListener('keydown', (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /input|textarea|select/i.test(t.tagName))) return;

    switch (e.key) {
      case 'MediaPlayPause': handlers.play && handlers.pause && (e.preventDefault(), toggle()); break;
      case 'MediaTrackNext': e.preventDefault(); handlers.next?.(); break;
      case 'MediaTrackPrevious': e.preventDefault(); handlers.prev?.(); break;
      case 'MediaStop': e.preventDefault(); handlers.stop?.(); break;
      default: break;
    }
  });
}

function toggle() {
  const playing = navigator.mediaSession?.playbackState === 'playing';
  if (playing) handlers.pause?.();
  else handlers.play?.();
}
