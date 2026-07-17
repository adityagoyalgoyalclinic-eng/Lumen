/**
 * AI panel. One sheet, fourteen actions, three result surfaces (prose, structured,
 * interactive). Every result can be spoken, copied, or exported.
 */

import { h, fill, icon } from '../util/dom.js';
import { state, setSettings } from '../core/store.js';
import { go } from '../core/router.js';
import { ACTIONS, LANGS, run, availability, speakable, ConsentError, NeedsKeyError } from '../services/ai.js';
import { sheet, toast, confirm as confirmDlg } from './kit.js';
import { preview, stopPreview } from '../services/tts.js';

export function openAiPanel(doc, initial = null) {
  let current = initial;
  const body = h('div.col');
  const s = sheet({ title: 'AI tools', body, onClose: stopPreview });

  const menu = () => {
    current = null;
    fill(body,
      h('p.small.muted', null,
        state.settings.aiProvider === 'local'
          ? 'Running on this device. Nothing is sent anywhere.'
          : 'Using cloud AI. The document text is sent to your provider.'),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))', gap: 'var(--sp-3)' } },
        ...ACTIONS.map((a) => {
          const av = availability(a.id);
          return h('button.qa', {
            style: { textAlign: 'left', opacity: av.ok ? '1' : '0.55' },
            onclick: () => (av.ok ? go2(a) : upsell(a)),
          },
            h('div.row', { style: { width: '100%' } },
              h('span.qa__glyph', { style: { justifySelf: 'start' } }, icon(a.icon, 19)),
              h('div.spacer'),
              av.mode === 'local' && av.ok && h('span.badge', { title: 'Runs on this device' }, 'On device')),
            h('span.qa__label', { style: { textAlign: 'left', width: '100%' } }, a.label),
            h('span.small.muted', { style: { textAlign: 'left', width: '100%' } }, a.desc));
        })),
      state.settings.aiProvider === 'local' &&
        h('div.card.card--pad', { style: { display: 'grid', gap: 'var(--sp-2)' } },
          h('div.row', null, icon('sparkle', 17), h('strong.small', null, 'Want the rest?')),
          h('p.small.muted', null,
            'Explain simply, Translate, Q&A, Flashcards, and Quiz need a cloud AI model. Add your own API key in Settings — you stay in control of the key and the cost.'),
          h('button.btn.btn--sm.btn--outline', {
            onclick: () => {
              s.close();
              go('/settings/ai');
            },
          }, 'Set up AI')));
  };

  const go2 = (a) => (a.id === 'ask' ? askView(a) : a.id === 'translate' ? translateView(a) : runView(a));

  function header(a, extra) {
    return h('div.row', { style: { marginBottom: 'var(--sp-3)' } },
      h('button.icon-btn', { onclick: menu, 'aria-label': 'Back to AI tools' }, icon('chevL', 19)),
      h('h3', { style: { flex: '1', fontSize: 'var(--step-1)' } }, a.label),
      extra);
  }

  /* ---------- Generic run ---------- */

  async function runView(a, opts = {}) {
    current = a;
    const out = h('div.col');
    fill(body, header(a), out);
    fill(out, loading(a));

    try {
      const res = await run(a.id, doc, opts);
      if (current !== a) return; // user navigated away mid-request
      fill(out, resultView(res, a, () => runView(a, { ...opts, force: true })));
    } catch (err) {
      if (current !== a) return;
      fill(out, errorView(err, a, () => runView(a, opts)));
    }
  }

  /* ---------- Ask ---------- */

  function askView(a) {
    current = a;
    const input = h('input.input', { placeholder: 'What does this document say about…?', 'aria-label': 'Your question' });
    const out = h('div.col');

    const submit = async (e) => {
      e?.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      fill(out, loading(a));
      try {
        const res = await run('ask', doc, { question: q });
        fill(out, h('div.card.card--pad', null,
          h('p.small.muted', { style: { marginBottom: 'var(--sp-2)' } }, q),
          h('p', null, res.data)),
          actions(res, a));
      } catch (err) {
        fill(out, errorView(err, a, submit));
      }
    };

    fill(body, header(a),
      h('form.row', { onsubmit: submit },
        input,
        h('button.btn.btn--primary', { type: 'submit' }, icon('sparkle', 17))),
      h('div.chips', null,
        ...['What are the main points?', 'What should I do next?', 'What is the conclusion?'].map((q) =>
          h('button.chip', {
            onclick: () => {
              input.value = q;
              submit();
            },
          }, q))),
      out);
    requestAnimationFrame(() => input.focus());
  }

  /* ---------- Translate ---------- */

  function translateView(a) {
    current = a;
    const out = h('div.col');
    fill(body, header(a),
      h('div.chips', null,
        ...LANGS.map((l) =>
          h('button.chip', {
            'aria-pressed': String(l.code === state.settings.translateTo),
            onclick: (e) => {
              setSettings({ translateTo: l.code });
              [...e.currentTarget.parentElement.children].forEach((c, i) =>
                c.setAttribute('aria-pressed', String(LANGS[i].code === l.code)));
              load(l.code);
            },
          }, l.label))),
      out);

    const load = async (code) => {
      fill(out, loading(a));
      try {
        const res = await run('translate', doc, { lang: code });
        fill(out, resultView(res, a, () => load(code)));
      } catch (err) {
        fill(out, errorView(err, a, () => load(code)));
      }
    };
    fill(out, h('p.small.muted.center', { style: { padding: 'var(--sp-5)' } }, 'Pick a language above.'));
  }

  /* ---------- Result surfaces ---------- */

  function resultView(res, a, retry) {
    const node = h('div.col');
    switch (res.kind) {
      case 'prose':
        node.append(h('div.card.card--pad', null,
          ...String(res.data).split(/\n\n+/).map((p) => h('p', { style: { marginBottom: '0.8em' } }, p))));
        break;

      case 'list':
        node.append(res.data.length
          ? h('div.card.card--pad', null,
              h('ul', { style: { paddingLeft: '1.2em', display: 'grid', gap: 'var(--sp-3)' } },
                ...res.data.map((x) => h('li', null, x))))
          : h('p.small.muted.center', { style: { padding: 'var(--sp-5)' } }, 'Nothing found for this one.'));
        break;

      case 'chips':
        node.append(h('div.chips', null, ...res.data.map((t) => h('span.chip', null, t))));
        break;

      case 'pairs':
        node.append(...res.data.map((p) =>
          h('div.card.card--pad', { style: { display: 'grid', gap: '4px' } },
            h('strong', null, p.term),
            h('span.small.muted', null, p.value))));
        break;

      case 'timeline':
        node.append(res.data.length
          ? h('div.col', null, ...res.data.map((t) =>
              h('div.row', { style: { alignItems: 'flex-start', gap: 'var(--sp-4)' } },
                h('span.badge', { style: { flex: 'none', marginTop: '3px' } }, t.when),
                h('span.small', null, t.what))))
          : h('p.small.muted.center', { style: { padding: 'var(--sp-5)' } }, 'No dated events in this document.'));
        break;

      case 'cards':
        node.append(flashcards(res.data));
        break;

      case 'quiz':
        node.append(quiz(res.data));
        break;

      case 'notes':
        node.append(notesView(res.data));
        break;

      default:
        node.append(h('pre', { style: { whiteSpace: 'pre-wrap' } }, String(res.data)));
    }

    node.append(actions(res, a, retry));
    if (res.cached) {
      node.append(h('p.small.muted.center', null, 'Saved from an earlier run · tap regenerate for a fresh one'));
    }
    if (res.mode === 'local') {
      node.append(h('p.small.muted.center', null,
        'Generated on this device by picking out the text’s own key sentences. A cloud model would write something more polished.'));
    }
    return node;
  }

  function actions(res, a, retry) {
    const text = speakable(res);
    return h('div.row', { style: { marginTop: 'var(--sp-3)' } },
      h('button.btn.btn--sm.btn--outline', {
        onclick: () => {
          preview(null, { text: text.slice(0, 4000), rate: state.settings.rate });
          toast('Reading it out…');
        },
      }, icon('voice', 15), 'Listen'),
      h('button.btn.btn--sm.btn--ghost', {
        onclick: async () => {
          await navigator.clipboard.writeText(text).catch(() => {});
          toast('Copied', 'ok');
        },
      }, icon('clip', 15), 'Copy'),
      h('div.spacer'),
      retry && h('button.btn.btn--sm.btn--ghost', { onclick: retry, 'aria-label': 'Regenerate' }, icon('sparkle', 15), 'Redo'));
    void a;
  }

  function loading(a) {
    return h('div.empty', { style: { padding: 'var(--sp-7)' }, role: 'status' },
      h('div.spin', { style: { width: '26px', height: '26px' } }),
      h('p.small', null, `${a.label}…`),
      state.settings.aiProvider !== 'local' && h('p.small.muted', null, 'Talking to your AI provider'));
  }

  function errorView(err, a, retry) {
    if (err instanceof ConsentError) return consentView(a, retry);
    if (err instanceof NeedsKeyError) {
      return h('div.empty', null,
        h('div.empty__glyph', null, icon('key', 26)),
        h('h3', null, 'An API key is needed'),
        h('p.small', null, err.message),
        h('button.btn.btn--primary', {
          onclick: () => {
            s.close();
            go('/settings/ai');
          },
        }, 'Open AI settings'));
    }
    return h('div.empty', null,
      h('div.empty__glyph', { style: { background: 'hsl(354 70% 50% / 0.14)', color: 'var(--danger)' } }, icon('warn', 26)),
      h('h3', null, 'That didn’t work'),
      h('p.small', null, err.message),
      h('button.btn.btn--outline', { onclick: retry }, 'Try again'));
  }

  /**
   * The consent gate. Deliberately concrete: it names what is sent, to whom, and how
   * much of it — a vague "we may share data with partners" is not consent.
   */
  function consentView(a, retry) {
    return h('div.col', null,
      h('div.card.card--pad', { style: { display: 'grid', gap: 'var(--sp-3)' } },
        h('div.row', null, icon('shield', 20), h('strong', null, 'This sends your document off the device')),
        h('p.small.muted', null,
          `To do this, the text of "${doc.title}" (about ${doc.words.toLocaleString()} words) is sent to your configured AI provider over an encrypted connection.`),
        h('ul.small.muted', { style: { paddingLeft: '1.2em', display: 'grid', gap: '4px' } },
          h('li', null, 'It goes to the provider you chose, using your own API key.'),
          h('li', null, 'Lumen has no server and never sees your content.'),
          h('li', null, 'The result is cached on this device so it is only sent once.'),
          h('li', null, 'You can turn this off at any time in Settings → AI.')),
        h('p.small', null, h('strong', null, 'Don’t send anything you wouldn’t want a third party to hold.')),
        h('div.row', null,
          h('button.btn.btn--primary', {
            style: { flex: '1' },
            onclick: async () => {
              const ok = await confirmDlg({
                title: 'Allow sending documents?',
                message: 'Lumen will send document text to your AI provider when you use a cloud feature. This applies until you turn it off.',
                confirmLabel: 'Allow',
              });
              if (!ok) return;
              setSettings({ aiConsent: true });
              toast('Cloud AI enabled', 'ok');
              retry();
            },
          }, icon('check', 16), 'Allow and continue'),
          h('button.btn.btn--ghost', { onclick: menu }, 'Not now'))),
      a.local && h('p.small.muted.center', null, 'This action also has an on-device version — turn the AI provider back to “On device” in Settings to use it without sending anything.'));
  }

  function upsell(a) {
    toast(`${a.label} needs a cloud AI provider — set one up in Settings.`, 'err');
  }

  menu();
  return s;
}

/* ------------------------------ Interactive results ------------------------------ */

function flashcards(cards) {
  if (!Array.isArray(cards) || !cards.length) return h('p.small.muted', null, 'No cards were generated.');
  let i = 0;

  const card = h('div.fc');
  const counter = h('span.small.muted');

  const paint = () => {
    const c = cards[i];
    card.classList.remove('is-flipped');
    fill(card, h('div.fc__inner', null,
      h('div.fc__face', null, h('p', { style: { fontWeight: '600' } }, c.q)),
      h('div.fc__face.fc__face--back', null, h('p', null, c.a))));
    counter.textContent = `${i + 1} / ${cards.length}`;
  };

  card.addEventListener('click', () => card.classList.toggle('is-flipped'));
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', 'Flashcard — activate to flip');
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      card.classList.toggle('is-flipped');
    }
  });

  const step = (d) => {
    i = (i + d + cards.length) % cards.length;
    paint();
  };

  paint();
  return h('div.col', null,
    card,
    h('div.row', { style: { justifyContent: 'center' } },
      h('button.icon-btn', { onclick: () => step(-1), 'aria-label': 'Previous card' }, icon('prev', 18)),
      counter,
      h('button.icon-btn', { onclick: () => step(1), 'aria-label': 'Next card' }, icon('next', 18))),
    h('p.small.muted.center', null, 'Tap the card to flip it'));
}

function quiz(questions) {
  if (!Array.isArray(questions) || !questions.length) return h('p.small.muted', null, 'No quiz was generated.');

  const answers = new Map();
  const root = h('div.col');
  const score = h('div.card.card--pad.center', { hidden: true });

  questions.forEach((q, qi) => {
    const opts = h('div.col', { style: { gap: '6px' } });
    q.options.forEach((opt, oi) => {
      const btn = h('button.btn.btn--outline', {
        style: { justifyContent: 'flex-start', textAlign: 'left', height: 'auto', padding: 'var(--sp-3)', whiteSpace: 'normal' },
        onclick: () => {
          if (answers.has(qi)) return; // answered — don't let them fish for the answer
          answers.set(qi, oi);
          const right = oi === q.answer;

          [...opts.children].forEach((b, i) => {
            b.disabled = true;
            if (i === q.answer) {
              b.style.borderColor = 'var(--ok)';
              b.style.color = 'var(--ok)';
            } else if (i === oi) {
              b.style.borderColor = 'var(--danger)';
              b.style.color = 'var(--danger)';
            }
          });
          if (q.why) opts.append(h('p.small.muted', { style: { marginTop: '6px' } }, `${right ? '✓' : '✗'} ${q.why}`));

          if (answers.size === questions.length) {
            const n = [...answers.entries()].filter(([i, a]) => questions[i].answer === a).length;
            score.hidden = false;
            fill(score,
              h('div', { style: { fontSize: 'var(--step-3)', fontWeight: '750', color: 'var(--accent)' } }, `${n}/${questions.length}`),
              h('p.small.muted', null, n === questions.length ? 'Perfect.' : n >= questions.length * 0.7 ? 'Solid.' : 'Worth another listen.'));
            score.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        },
      }, opt);
      opts.append(btn);
    });

    root.append(h('div.card.card--pad', { style: { display: 'grid', gap: 'var(--sp-3)' } },
      h('strong', null, `${qi + 1}. ${q.q}`),
      opts));
  });

  root.append(score);
  return root;
}

function notesView(n) {
  return h('div.col', null,
    n.overview && h('div.card.card--pad', null,
      h('span.field__label', null, 'Overview'),
      h('p', null, n.overview)),
    n.outline?.length && h('div.card.card--pad', null,
      h('span.field__label', null, 'Outline'),
      h('ol', { style: { paddingLeft: '1.3em', display: 'grid', gap: '4px', marginTop: '6px' } },
        ...n.outline.map((x) => h('li.small', null, x)))),
    n.key?.length && h('div.card.card--pad', null,
      h('span.field__label', null, 'Key points'),
      h('ul', { style: { paddingLeft: '1.2em', display: 'grid', gap: '6px', marginTop: '6px' } },
        ...n.key.map((x) => h('li.small', null, x)))),
    n.terms?.length && h('div.card.card--pad', null,
      h('span.field__label', { style: { marginBottom: '6px', display: 'block' } }, 'Key terms'),
      h('div.chips', null, ...n.terms.map((t) => h('span.chip', null, t)))));
}
