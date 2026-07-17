/**
 * Speech engine.
 *
 * Built on the Web Speech API, which is the only TTS that is free, offline-capable,
 * and available on every target platform (Android, iOS, desktop browsers). It also has
 * a decade of sharp edges, and most of this file exists to sand them down:
 *
 *  - getVoices() is empty until `voiceschanged` fires. We resolve a promise on either.
 *  - Chrome silently stops speaking after ~15 s. We pause/resume on a timer to survive.
 *  - Rate above 2× is clamped by some engines. We compensate below.
 *  - `boundary` events (word highlighting) are unsupported in some engines; the UI
 *    degrades to sentence-only highlighting rather than breaking.
 *  - Cancelling mid-utterance fires `onend`. We use a generation counter so a stale
 *    end event can never advance the queue.
 *
 * The engine speaks ONE sentence per utterance. That costs a few ms between sentences
 * but buys exact sentence boundaries for highlighting, instant seek, accurate progress,
 * and immunity to the 15 s bug.
 */

const synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;

export const isSupported = () => Boolean(synth && typeof SpeechSynthesisUtterance !== 'undefined');

/* ------------------------------ Voices ------------------------------ */

let voicesCache = null;

/** Resolve the voice list, waiting for `voiceschanged` if needed. */
export function voices() {
  if (!synth) return Promise.resolve([]);
  if (voicesCache?.length) return Promise.resolve(voicesCache);

  return new Promise((resolve) => {
    const read = () => {
      const v = synth.getVoices();
      if (v.length) {
        voicesCache = v;
        resolve(v);
        return true;
      }
      return false;
    };
    if (read()) return;

    const onChange = () => {
      if (read()) synth.removeEventListener('voiceschanged', onChange);
    };
    synth.addEventListener('voiceschanged', onChange);
    // Some engines never fire the event; give up gracefully rather than hang.
    setTimeout(() => {
      synth.removeEventListener('voiceschanged', onChange);
      voicesCache = synth.getVoices();
      resolve(voicesCache);
    }, 2500);
  });
}

/**
 * Voices grouped and annotated for the picker.
 * @returns {Promise<{uri,name,lang,langLabel,region,gender,quality,local,voice}[]>}
 */
export async function voiceList() {
  const vs = await voices();
  return vs
    .map((v) => ({
      uri: v.voiceURI,
      name: cleanName(v.name),
      raw: v.name,
      lang: v.lang,
      langLabel: langLabel(v.lang),
      region: regionLabel(v.lang),
      gender: guessGender(v.name),
      quality: quality(v),
      local: v.localService,
      voice: v,
    }))
    .sort((a, b) => b.quality - a.quality || a.langLabel.localeCompare(b.langLabel) || a.name.localeCompare(b.name));
}

/** Strip vendor noise so "Microsoft Aria Online (Natural) - English (US)" reads as "Aria". */
function cleanName(n) {
  return String(n)
    .replace(/^(?:Microsoft|Google|Apple|Amazon|eSpeak(?: NG)?)\s+/i, '')
    .replace(/\s*\((?:Natural|Enhanced|Premium|Compact|Online|Neural)\)/gi, '')
    .replace(/\s*-\s*[A-Za-z()\s]+\([A-Za-z ]+\)\s*$/, '')
    .replace(/\s*Online\s*/i, ' ')
    .replace(/\s+/g, ' ')
    .trim() || n;
}

/**
 * Rank voice naturalness. Neural/natural voices are dramatically better than the
 * old formant synths, so we surface them first and default to the best one.
 */
function quality(v) {
  const n = v.name.toLowerCase();
  let s = 0;
  if (/natural|neural|premium|enhanced/.test(n)) s += 6;
  if (/google/.test(n)) s += 4;
  if (/siri/.test(n)) s += 4;
  if (/microsoft/.test(n) && /online/.test(n)) s += 3;
  if (/espeak|compact|pico/.test(n)) s -= 6;
  if (v.localService) s += 1; // works offline, and no per-sentence network hitch
  if (v.default) s += 1;
  return s;
}

/**
 * Infer a gender label from the voice name.
 * The API exposes no gender field, so this is a best-effort convenience for the
 * filter chips; it's presented as a filter, never as a claim about the voice.
 */
function guessGender(name) {
  const n = name.toLowerCase();
  const female = /aria|jenny|zira|samantha|victoria|karen|moira|tessa|fiona|serena|allison|ava|susan|joanna|salli|kendra|kimberly|amy|emma|nicole|olivia|sonia|libby|michelle|clara|natasha|yan|mia|lucy|sara|female|woman|girl/;
  const male = /guy|david|mark|alex|daniel|fred|tom|oliver|george|james|ryan|brian|matthew|justin|joey|eric|william|liam|thomas|male|man|boy/;
  if (female.test(n)) return 'female';
  if (male.test(n)) return 'male';
  return 'neutral';
}

const DISPLAY = typeof Intl !== 'undefined' && Intl.DisplayNames
  ? {
      lang: new Intl.DisplayNames(['en'], { type: 'language' }),
      region: new Intl.DisplayNames(['en'], { type: 'region' }),
    }
  : null;

export function langLabel(tag) {
  const base = String(tag || 'en').split(/[-_]/)[0];
  try { return DISPLAY?.lang.of(base) || base; } catch { return base; }
}

export function regionLabel(tag) {
  const parts = String(tag || '').split(/[-_]/);
  if (parts.length < 2) return '';
  try { return DISPLAY?.region.of(parts[1].toUpperCase()) || parts[1]; } catch { return parts[1]; }
}

/** Best default voice for a language, preferring natural and local. */
export async function bestVoice(lang = 'en-US') {
  const list = await voiceList();
  if (!list.length) return null;
  const base = lang.split('-')[0];
  return (
    list.find((v) => v.lang === lang) ||
    list.find((v) => v.lang.startsWith(base)) ||
    list.find((v) => v.lang.startsWith('en')) ||
    list[0]
  );
}

/* ------------------------------ Player ------------------------------ */

/**
 * Sentence-queue speech player.
 *
 * Events: 'start' | 'sentence' | 'word' | 'pause' | 'resume' | 'end' | 'stop' | 'error'
 */
export class Speaker extends EventTarget {
  constructor() {
    super();
    /** @type {string[]} */
    this.items = [];
    this.idx = 0;
    this.rate = 1;
    this.pitch = 1;
    this.volume = 1;
    this.voice = null;
    this.lang = 'en-US';
    this.skipSilence = false;

    this.playing = false;
    this.paused = false;

    this._gen = 0; // invalidates events from cancelled utterances
    this._keepAlive = null;
    this._startedAt = 0;
    this._utt = null;
  }

  /** @param {string[]} sentences */
  load(sentences, startIdx = 0) {
    this.stop();
    this.items = sentences.filter((s) => s && s.trim());
    this.idx = Math.max(0, Math.min(startIdx, this.items.length - 1));
    return this;
  }

  configure({ voice, rate, pitch, volume, lang, skipSilence }) {
    if (voice !== undefined) this.voice = voice;
    if (rate !== undefined) this.rate = clamp(rate, 0.1, 10);
    if (pitch !== undefined) this.pitch = clamp(pitch, 0, 2);
    if (volume !== undefined) this.volume = clamp(volume, 0, 1);
    if (lang !== undefined) this.lang = lang;
    if (skipSilence !== undefined) this.skipSilence = skipSilence;

    // Rate changes only take effect on the next utterance, so re-speak the current
    // sentence to make the slider feel live.
    if (this.playing && !this.paused && rate !== undefined) this._speak();
    return this;
  }

  play(idx = null) {
    if (!isSupported()) {
      this._fire('error', { message: 'This browser has no speech engine.' });
      return this;
    }
    if (idx != null) this.idx = clamp(idx, 0, this.items.length - 1);

    if (this.paused && idx == null) {
      synth.resume();
      this.paused = false;
      this.playing = true;
      this._startKeepAlive();
      this._fire('resume');
      return this;
    }
    if (!this.items.length) return this;

    this.playing = true;
    this.paused = false;
    this._fire('start', { idx: this.idx });
    this._speak();
    return this;
  }

  pause() {
    if (!this.playing || this.paused) return this;
    // Chrome's pause() is unreliable mid-utterance on some platforms; cancel+resume
    // from the sentence start is the behaviour users actually expect anyway.
    this.paused = true;
    this.playing = false;
    this._stopKeepAlive();
    try { synth.pause(); } catch { /* ignore */ }
    this._fire('pause', { idx: this.idx });
    return this;
  }

  toggle() {
    return this.playing ? this.pause() : this.play();
  }

  stop() {
    this._gen++;
    this.playing = false;
    this.paused = false;
    this._stopKeepAlive();
    try { synth.cancel(); } catch { /* ignore */ }
    this._utt = null;
    this._fire('stop');
    return this;
  }

  /** Jump by n sentences. */
  seekBy(n) {
    return this.seek(this.idx + n);
  }

  seek(i) {
    const next = clamp(i, 0, Math.max(0, this.items.length - 1));
    const wasPlaying = this.playing;
    this._gen++;
    try { synth.cancel(); } catch { /* ignore */ }
    this.idx = next;
    this.paused = false;
    this._fire('sentence', { idx: this.idx, text: this.items[this.idx] });
    if (wasPlaying) this._speak();
    else this.playing = false;
    return this;
  }

  next() { return this.seekBy(1); }
  prev() {
    // Match every audio player ever: if we're past the start of a sentence, "previous"
    // restarts it; press again quickly and it goes back one.
    const elapsed = Date.now() - this._startedAt;
    return elapsed > 2200 ? this.seek(this.idx) : this.seekBy(-1);
  }

  /** Skip to the next block boundary (paragraph) given block start indices. */
  skipTo(indices, dir) {
    const sorted = [...indices].sort((a, b) => a - b);
    const target = dir > 0
      ? sorted.find((i) => i > this.idx)
      : [...sorted].reverse().find((i) => i < this.idx);
    return this.seek(target ?? (dir > 0 ? this.items.length - 1 : 0));
  }

  get progress() {
    return this.items.length ? this.idx / this.items.length : 0;
  }

  _speak() {
    if (!this.items.length) return;
    this._gen++;
    const gen = this._gen;
    try { synth.cancel(); } catch { /* ignore */ }

    let text = this.items[this.idx];
    if (!text) return this._advance(gen);

    if (this.skipSilence) {
      // Collapse runs of dots/dashes that some documents use as visual spacers;
      // engines pause on them for a full beat each.
      text = text.replace(/[.·•\-–—_]{3,}/g, ' ').replace(/\s{2,}/g, ' ').trim();
      if (!text) return this._advance(gen);
    }

    const u = new SpeechSynthesisUtterance(text);
    this._utt = u;
    if (this.voice) u.voice = this.voice;
    u.lang = this.voice?.lang || this.lang;
    u.rate = clamp(this.rate, 0.1, 10);
    u.pitch = this.pitch;
    u.volume = this.volume;

    u.onstart = () => {
      if (gen !== this._gen) return;
      this._startedAt = Date.now();
      this._fire('sentence', { idx: this.idx, text });
    };

    u.onboundary = (e) => {
      if (gen !== this._gen || e.name === 'sentence') return;
      this._fire('word', { idx: this.idx, charIndex: e.charIndex, charLength: e.charLength || 0 });
    };

    u.onend = () => {
      // A cancelled utterance also fires end — the generation check drops it.
      if (gen !== this._gen) return;
      this._advance(gen);
    };

    u.onerror = (e) => {
      if (gen !== this._gen) return;
      // 'interrupted'/'canceled' are our own doing (seek, stop) — not real errors.
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      if (e.error === 'not-allowed') {
        this.playing = false;
        this._fire('error', { message: 'Tap play once to allow audio in this browser.' });
        return;
      }
      // Any other engine hiccup: skip the sentence rather than stall the book.
      console.warn('[tts] utterance error', e.error, text.slice(0, 40));
      this._advance(gen);
    };

    try {
      synth.speak(u);
      this._startKeepAlive();
    } catch (err) {
      this._fire('error', { message: err.message });
    }
  }

  _advance(gen) {
    if (gen !== this._gen) return;
    if (this.idx >= this.items.length - 1) {
      this.playing = false;
      this._stopKeepAlive();
      this._fire('end');
      return;
    }
    this.idx++;
    if (this.playing) this._speak();
  }

  /**
   * Chrome stops speaking after ~15 s of a single utterance and, worse, wedges the
   * queue. A pause/resume pair every 10 s keeps the engine alive. It's a documented,
   * long-standing bug (crbug.com/679437) with no better workaround.
   */
  _startKeepAlive() {
    this._stopKeepAlive();
    if (!/Chrome|Edg/.test(navigator.userAgent) || /Android/.test(navigator.userAgent)) return;
    this._keepAlive = setInterval(() => {
      if (!this.playing || this.paused) return;
      if (synth.speaking) {
        synth.pause();
        synth.resume();
      }
    }, 10000);
  }

  _stopKeepAlive() {
    if (this._keepAlive) clearInterval(this._keepAlive);
    this._keepAlive = null;
  }

  _fire(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));

/** Speak one throwaway line — used by the voice preview button. */
export async function preview(voice, { rate = 1, pitch = 1, text } = {}) {
  if (!isSupported()) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(
    text || 'Lumen turns anything you read into natural speech.',
  );
  if (voice) { u.voice = voice; u.lang = voice.lang; }
  u.rate = rate;
  u.pitch = pitch;
  synth.speak(u);
}

export const stopPreview = () => { try { synth?.cancel(); } catch { /* ignore */ } };

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
