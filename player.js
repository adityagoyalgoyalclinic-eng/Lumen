/**
 * The player — a singleton that owns speech for the whole app.
 *
 * A singleton because there is exactly one pair of speakers: two players would fight
 * over the speech engine and the lock screen. It survives navigation, so you can leave
 * the reader, browse the library, and still be listening.
 *
 * Progress is written back to IndexedDB on a throttle (every ~10 sentences and on every
 * pause/stop/unload) — often enough that resume is accurate, rarely enough that we're
 * not doing a database write every two seconds.
 */

import { h, fill, icon, $ } from '../util/dom.js';
import { state, setSetting, set as setState, emit } from '../core/store.js';
import { go } from '../core/router.js';
import * as db from '../core/db.js';
import { Speaker, voices, voiceList, bestVoice, preview, stopPreview, SPEEDS, isSupported, langLabel } from '../services/tts.js';
import * as media from '../services/media.js';
import { sheet, toast, dur } from './kit.js';
import { listenSeconds } from '../util/text.js';

class Player {
  constructor() {
    this.speaker = new Speaker();
    this.doc = null;
    this.root = null; // reader element, when the reader is mounted
    this.el = null; // the mini player
    this.since = 0;
    this.lastSaved = 0;
    this._wire();
  }

  /* ---------------------- Lifecycle ---------------------- */

  /** Called by the reader when a document opens. */
  async attach(doc, root) {
    this.root = root;

    // Already playing this document (user navigated away and back) — just re-bind.
    if (this.doc?.id === doc.id && (this.speaker.playing || this.speaker.paused)) {
      this._paintSentence(this.speaker.idx);
      return;
    }

    this.doc = doc;
    const { sentenceMap } = await import('./reader.js');
    const items = sentenceMap().map((s) => s.text);
    this.speaker.load(items, doc.sentenceIdx || 0);

    await this._applyVoice();
    setState('player', {
      docId: doc.id,
      title: doc.title,
      idx: doc.sentenceIdx || 0,
      total: items.length,
      playing: false,
      rate: state.settings.rate,
    });

    media.setMetadata({ title: doc.title, artist: doc.meta?.author || doc.meta?.site || 'Lumen', artwork: doc.thumb });
    this._paintSentence(this.speaker.idx);
    this.mount();
  }

  detach() {
    this.root = null;
    // Speech deliberately continues — leaving the reader shouldn't stop the audio.
  }

  async _applyVoice() {
    const list = await voices();
    if (!list.length) return;
    let v = list.find((x) => x.voiceURI === state.settings.voiceURI);
    if (!v) {
      const best = await bestVoice(state.settings.lang);
      v = best?.voice || list[0];
      if (v) setSetting('voiceURI', v.voiceURI);
    }
    this.speaker.configure({
      voice: v,
      rate: state.settings.rate,
      pitch: state.settings.pitch,
      volume: state.settings.volume,
      lang: state.settings.lang,
      skipSilence: state.settings.skipSilence,
    });
  }

  /* ---------------------- Controls ---------------------- */

  async play(idx = null) {
    if (!isSupported()) return toast('This browser has no speech engine.', 'err');
    if (!this.doc) return;
    if (!this.speaker.items.length) return toast('Nothing to read in this document.', 'err');

    await this._applyVoice();
    this.since = Date.now();
    this.speaker.play(idx);
    media.setState('playing');
  }

  pause() {
    this.speaker.pause();
    media.setState('paused');
    this._save(true);
  }

  toggle() {
    if (this.speaker.playing) this.pause();
    else this.play();
  }

  stop() {
    this.speaker.stop();
    media.setState('none');
    this._save(true);
    setState('player', { playing: false, docId: null });
    this.unmount();
  }

  seek(i) {
    this.speaker.seek(i);
    if (!this.speaker.playing) this.play(i);
  }

  next() { this.speaker.next(); }
  prev() { this.speaker.prev(); }

  async skipPara(dir) {
    const { blockStartIndices } = await import('./reader.js');
    this.speaker.skipTo(blockStartIndices(), dir);
  }

  async skipChapter(dir) {
    const { chapterStartIndices } = await import('./reader.js');
    const ch = chapterStartIndices();
    if (!ch.length) return this.skipPara(dir);
    this.speaker.skipTo(ch, dir);
  }

  setRate(r) {
    setSetting('rate', r);
    this.speaker.configure({ rate: r });
    setState('player', { rate: r });
    this._updatePosition();
  }

  /* ---------------------- Events ---------------------- */

  _wire() {
    const sp = this.speaker;

    sp.addEventListener('sentence', (e) => {
      const { idx } = e.detail;
      setState('player', { idx, playing: sp.playing });
      this._paintSentence(idx);
      this._updatePosition();
      if (idx - this.lastSaved >= 10) this._save();
    });

    sp.addEventListener('word', (e) => {
      if (!state.settings.wordHighlight) return;
      this._paintWord(e.detail);
    });

    sp.addEventListener('start', () => {
      setState('player', { playing: true });
      this.mount();
    });

    sp.addEventListener('pause', () => setState('player', { playing: false }));
    sp.addEventListener('resume', () => setState('player', { playing: true }));

    sp.addEventListener('end', async () => {
      setState('player', { playing: false });
      media.setState('paused');
      if (this.doc) {
        await db.patchDoc(this.doc.id, { progress: 1, sentenceIdx: 0, listenedMs: this._listened() });
        const { refreshDocs } = await import('../core/store.js');
        refreshDocs();
      }
      this._next();
    });

    sp.addEventListener('error', (e) => toast(e.detail.message, 'err'));

    media.bindControls({
      play: () => this.play(),
      pause: () => this.pause(),
      stop: () => this.stop(),
      next: () => this.next(),
      prev: () => this.prev(),
      forward: () => this.skipPara(1),
      backward: () => this.skipPara(-1),
      seekTo: (t) => {
        // Lock-screen scrubbing: map seconds back onto a sentence index.
        const total = listenSeconds(this.doc?.words || 0, state.settings.rate) || 1;
        this.seek(Math.round((t / total) * this.speaker.items.length));
      },
    });
    media.bindKeys();

    // Never lose a position because a tab closed.
    addEventListener('pagehide', () => this._save(true));
    document.addEventListener('visibilitychange', () => document.hidden && this._save(true));
  }

  /** Advance to the queue's next document, if any. */
  async _next() {
    const queue = state.player.queue;
    if (!queue?.length) {
      toast('Finished', 'ok');
      return;
    }
    const nextId = queue[0];
    setState('player', { queue: queue.slice(1) });
    go(`/read/${nextId}`);
    toast('Playing next in queue');
  }

  /* ---------------------- Highlighting ---------------------- */

  _paintSentence(idx) {
    if (!this.root) return;

    const prev = $('.sn.is-now', this.root);
    if (prev) {
      prev.classList.remove('is-now');
      prev.classList.add('is-done');
      // Word spans only exist inside the active sentence — collapse them back to text.
      if (prev.dataset.wordified) {
        prev.textContent = prev.textContent;
        delete prev.dataset.wordified;
      }
    }

    const el = $(`.sn[data-si="${idx}"]`, this.root);
    if (!el) return;
    el.classList.add('is-now');
    el.classList.remove('is-done');

    if (state.settings.autoScroll) {
      const rect = el.getBoundingClientRect();
      const comfortable = rect.top > innerHeight * 0.22 && rect.bottom < innerHeight * 0.78;
      // Only scroll when the sentence is drifting out of the comfortable band —
      // scrolling on every sentence makes the page jitter and is nauseating.
      if (!comfortable) {
        el.scrollIntoView({
          behavior: state.settings.motion === 'reduced' ? 'auto' : 'smooth',
          block: 'center',
        });
      }
    }
  }

  /**
   * Word highlight. Split the active sentence into word spans on first boundary event,
   * then just move a class. Splitting once per sentence keeps this off the hot path.
   */
  _paintWord({ idx, charIndex, charLength }) {
    if (!this.root) return;
    const el = $(`.sn[data-si="${idx}"]`, this.root);
    if (!el) return;

    if (!el.dataset.wordified) {
      const text = el.textContent;
      el.replaceChildren();
      // Preserve exact offsets: split on boundaries but keep whitespace as text nodes.
      const re = /\S+/g;
      let last = 0;
      let m;
      while ((m = re.exec(text))) {
        if (m.index > last) el.append(text.slice(last, m.index));
        el.append(h('span.wd', { dataset: { at: String(m.index), len: String(m[0].length) } }, m[0]));
        last = m.index + m[0].length;
      }
      if (last < text.length) el.append(text.slice(last));
      el.dataset.wordified = '1';
    }

    for (const w of el.querySelectorAll('.wd')) {
      const at = Number(w.dataset.at);
      const len = Number(w.dataset.len);
      const hit = charLength
        ? at < charIndex + charLength && at + len > charIndex
        : at <= charIndex && charIndex < at + len;
      w.classList.toggle('is-now', hit);
    }
  }

  /* ---------------------- Persistence ---------------------- */

  _listened() {
    const add = this.since ? Date.now() - this.since : 0;
    return (this.doc?.listenedMs || 0) + add;
  }

  async _save(force = false) {
    if (!this.doc) return;
    const idx = this.speaker.idx;
    if (!force && idx === this.lastSaved) return;
    this.lastSaved = idx;
    const progress = this.speaker.items.length ? idx / this.speaker.items.length : 0;

    await db.patchDoc(this.doc.id, {
      sentenceIdx: idx,
      progress,
      listenedMs: this._listened(),
      openedAt: Date.now(),
    }).catch(() => { /* a failed progress write must never break playback */ });

    this.since = Date.now();
    this.doc.listenedMs = this._listened();
  }

  _updatePosition() {
    if (!this.doc) return;
    const total = listenSeconds(this.doc.words, state.settings.rate);
    const pos = total * (this.speaker.items.length ? this.speaker.idx / this.speaker.items.length : 0);
    media.setPosition({ duration: total, position: pos, rate: state.settings.rate });
  }

  /* ---------------------- Mini player ---------------------- */

  mount() {
    if (this.el) return this._paint();
    this.el = h('div.player.glass', { role: 'region', 'aria-label': 'Player' });
    document.body.append(this.el);
    this._paint();
  }

  unmount() {
    this.el?.remove();
    this.el = null;
  }

  _paint() {
    if (!this.el || !this.doc) return;
    const p = state.player;
    const pct = p.total ? (p.idx / p.total) * 100 : 0;

    const seekBar = h('div.player__seek', {
      role: 'slider',
      tabIndex: 0,
      'aria-label': 'Seek',
      'aria-valuemin': '0',
      'aria-valuemax': String(Math.max(0, p.total - 1)),
      'aria-valuenow': String(p.idx),
      'aria-valuetext': `Sentence ${p.idx + 1} of ${p.total}`,
      onclick: (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        this.seek(Math.round(((e.clientX - r.left) / r.width) * (p.total - 1)));
      },
      onkeydown: (e) => {
        if (e.key === 'ArrowRight') { e.preventDefault(); this.next(); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); this.prev(); }
      },
    }, h('div.player__seek-fill', { style: { width: `${pct}%` } }));

    const left = Math.max(0, this.doc.words * (1 - pct / 100));
    const remain = dur(listenSeconds(left, state.settings.rate));

    fill(this.el,
      seekBar,
      h('div.player__body', null,
        h('button.player__art', {
          onclick: () => go(`/read/${this.doc.id}`),
          'aria-label': 'Open document',
          style: this.doc.thumb ? { padding: '0', overflow: 'hidden' } : {},
        }, this.doc.thumb
          ? h('img', { src: this.doc.thumb, alt: '', style: { width: '100%', height: '100%', objectFit: 'cover' } })
          : icon('book', 20)),

        h('div.player__info', null,
          h('div.player__title', { title: this.doc.title }, this.doc.title),
          h('div.player__sub', null, `${remain} left · ${p.idx + 1} of ${p.total}`)),

        h('div.player__extra', null,
          h('button.icon-btn', { onclick: () => this.skipPara(-1), 'aria-label': 'Previous paragraph' }, icon('back', 17)),
        ),

        h('button.icon-btn', { onclick: () => this.prev(), 'aria-label': 'Previous sentence' }, icon('prev', 18)),
        h('button.player__play', {
          onclick: () => this.toggle(),
          'aria-label': p.playing ? 'Pause' : 'Play',
        }, icon(p.playing ? 'pause' : 'play', 21)),
        h('button.icon-btn', { onclick: () => this.next(), 'aria-label': 'Next sentence' }, icon('next', 18)),

        h('div.player__extra', null,
          h('button.icon-btn', { onclick: () => this.skipPara(1), 'aria-label': 'Next paragraph' }, icon('fwd', 17)),
          h('button.btn.btn--sm.btn--ghost', {
            onclick: () => openSpeed(this),
            'aria-label': `Speed ${state.settings.rate}×`,
            style: { fontVariantNumeric: 'tabular-nums', minWidth: '46px' },
          }, `${state.settings.rate}×`),
          h('button.icon-btn', { onclick: () => openVoices(this), 'aria-label': 'Voice' }, icon('voice', 18))),

        h('button.icon-btn', { onclick: () => this.stop(), 'aria-label': 'Stop' }, icon('close', 18)),
      ),
    );
  }
}

export const player = new Player();

// Repaint the mini player when playback state changes, but not on every word.
let paintQueued = false;
import('../core/store.js').then(({ on }) => {
  on('player', () => {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      player._paint();
    });
  });
});

/* ------------------------------ Sheets ------------------------------ */

export function openSpeed(p) {
  const s = state.settings;
  const label = h('span', { style: { fontWeight: '700', fontSize: 'var(--step-2)', fontVariantNumeric: 'tabular-nums' } }, `${s.rate}×`);

  const chips = h('div.chips', null,
    ...SPEEDS.map((v) =>
      h('button.chip', {
        'aria-pressed': String(v === s.rate),
        onclick: (e) => {
          p.setRate(v);
          label.textContent = `${v}×`;
          [...e.currentTarget.parentElement.children].forEach((c, i) =>
            c.setAttribute('aria-pressed', String(SPEEDS[i] === v)));
          fine.value = String(v);
        },
      }, `${v}×`)));

  const fine = h('input.range', {
    type: 'range', min: '0.5', max: '4', step: '0.05', value: String(s.rate),
    'aria-label': 'Playback speed',
    oninput: (e) => {
      const v = Number(e.target.value);
      p.setRate(v);
      label.textContent = `${v.toFixed(2).replace(/\.?0+$/, '')}×`;
      [...chips.children].forEach((c, i) => c.setAttribute('aria-pressed', String(SPEEDS[i] === v)));
    },
  });

  const slider = (key, min, max, step, name, help) => {
    const out = h('span.small.muted', { style: { minWidth: '40px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' } },
      Number(state.settings[key]).toFixed(2));
    return h('div.col', { style: { gap: '2px', marginTop: 'var(--sp-3)' } },
      h('div.row', null, h('span.field__label', { style: { flex: '1' } }, name), out),
      h('input.range', {
        type: 'range', min, max, step, value: String(state.settings[key]), 'aria-label': name,
        oninput: (e) => {
          const v = Number(e.target.value);
          setSetting(key, v);
          p.speaker.configure({ [key]: v });
          out.textContent = v.toFixed(2);
        },
      }),
      help && h('span.small.muted', null, help));
  };

  sheet({
    title: 'Playback',
    body: h('div.col', null,
      h('div.center', null, label),
      chips,
      fine,
      slider('pitch', '0.5', '2', '0.05', 'Pitch'),
      slider('volume', '0', '1', '0.05', 'Volume'),
      h('div', { style: { marginTop: 'var(--sp-3)' } },
        toggleSetting('Skip silence', 'Collapse long runs of dots and dashes', 'skipSilence', (v) => p.speaker.configure({ skipSilence: v }))),
      h('p.small.muted', null,
        'Speeds above 2× depend on the voice — some engines cap their own rate, so 4× may sound like 2×. Natural voices usually handle it better.')),
  });
}

function toggleSetting(name, desc, key, after) {
  const sw = h('button.switch', {
    role: 'switch',
    'aria-checked': String(Boolean(state.settings[key])),
    'aria-label': name,
    onclick: () => {
      const v = !state.settings[key];
      setSetting(key, v);
      sw.setAttribute('aria-checked', String(v));
      after?.(v);
    },
  });
  return h('div.setting', null,
    h('div.setting__text', null, h('div.setting__name', null, name), desc && h('div.small.muted', null, desc)),
    sw);
}

export async function openVoices(p) {
  const list = await voiceList();
  if (!list.length) {
    return sheet({
      title: 'Voices',
      body: h('div.empty', null,
        h('div.empty__glyph', null, icon('warn', 26)),
        h('h3', null, 'No voices found'),
        h('p.small', null, 'Your system has no speech voices installed. On Windows, add them in Settings → Time & Language → Speech. On Android, install Google Text-to-Speech.')),
    });
  }

  let filterLang = 'all';
  let filterGender = 'all';
  let q = '';

  const rows = h('div.col');
  const langs = [...new Set(list.map((v) => v.lang.split('-')[0]))]
    .map((code) => ({ code, label: langLabel(code) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const paint = () => {
    const shown = list.filter((v) =>
      (filterLang === 'all' || v.lang.startsWith(filterLang)) &&
      (filterGender === 'all' || v.gender === filterGender) &&
      (!q || `${v.name} ${v.langLabel} ${v.region}`.toLowerCase().includes(q.toLowerCase())));

    if (!shown.length) {
      return fill(rows, h('p.small.muted.center', { style: { padding: 'var(--sp-5)' } }, 'No voices match those filters.'));
    }

    fill(rows, ...shown.map((v) => {
      const on = v.uri === state.settings.voiceURI;
      return h('div.card', {
        style: {
          display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', padding: 'var(--sp-3)',
          borderColor: on ? 'var(--accent)' : undefined,
        },
      },
        h('button', {
          style: { flex: '1', textAlign: 'left', display: 'grid', gap: '2px', background: 'none' },
          'aria-pressed': String(on),
          onclick: () => {
            setSetting('voiceURI', v.uri);
            setSetting('lang', v.lang);
            p.speaker.configure({ voice: v.voice, lang: v.lang });
            paint();
            toast(`Voice set to ${v.name}`, 'ok');
          },
        },
          h('div.row', null,
            h('span', { style: { fontWeight: '640' } }, v.name),
            on && h('span.badge', null, icon('check', 11), 'Active'),
            v.quality >= 6 && h('span.badge', null, 'Natural'),
            !v.local && h('span.badge.badge--warn', { title: 'Needs an internet connection' }, icon('wifi', 10), 'Online')),
          h('div.small.muted', null,
            [v.langLabel, v.region, v.gender !== 'neutral' ? v.gender : null].filter(Boolean).join(' · '))),
        h('button.icon-btn', {
          'aria-label': `Preview ${v.name}`,
          onclick: () => preview(v.voice, { rate: state.settings.rate, pitch: state.settings.pitch }),
        }, icon('play', 16)));
    }));
  };

  paint();

  sheet({
    title: `Voices (${list.length})`,
    onClose: stopPreview,
    body: h('div.col', null,
      h('div.search', null,
        icon('search', 17),
        h('input', {
          type: 'search', placeholder: 'Search voices…', 'aria-label': 'Search voices',
          oninput: (e) => {
            q = e.target.value;
            paint();
          },
        })),
      h('div.chips', null,
        h('button.chip', {
          'aria-pressed': 'true',
          onclick: (e) => {
            filterLang = 'all';
            markOnly(e.currentTarget);
            paint();
          },
        }, 'All languages'),
        ...langs.map((l) =>
          h('button.chip', {
            'aria-pressed': 'false',
            onclick: (e) => {
              filterLang = l.code;
              markOnly(e.currentTarget);
              paint();
            },
          }, l.label))),
      h('div.chips', null,
        ...[['all', 'Any voice'], ['female', 'Female'], ['male', 'Male']].map(([id, label], i) =>
          h('button.chip', {
            'aria-pressed': String(i === 0),
            onclick: (e) => {
              filterGender = id;
              markOnly(e.currentTarget);
              paint();
            },
          }, label))),
      rows,
      h('p.small.muted', null,
        'Voices come from your device and operating system, so the list differs between phones and computers. “Natural” voices sound best; “Online” ones need a connection.')),
  });
}

/** In a chip group, mark one pressed and the rest not. */
function markOnly(el) {
  [...el.parentElement.children].forEach((c) => c.setAttribute('aria-pressed', String(c === el)));
}

void emit;
