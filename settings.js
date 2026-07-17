/**
 * Settings. Tabbed, deep-linkable (#/settings/ai), and honest about what each toggle
 * actually does.
 */

import { h, fill, icon } from '../util/dom.js';
import { state, setSetting, setSettings, DEFAULT_SETTINGS, refreshDocs } from '../core/store.js';
import { go } from '../core/router.js';
import * as db from '../core/db.js';
import { sheet, toast, confirm as confirmDlg, applyTheme, ago } from './kit.js';
import { openVoices, openSpeed, player } from './player.js';
import { voiceList, isSupported as ttsSupported } from '../services/tts.js';
import { LANGS } from '../services/ai.js';
import { exportLibrary, importBackup } from '../services/export.js';
import { invalidate } from '../services/search.js';
import { fmtBytes } from '../util/sanitize.js';
import { signOut, openAuth } from './auth.js';

const TABS = [
  { id: 'appearance', label: 'Appearance', icon: 'sun' },
  { id: 'reading', label: 'Reading', icon: 'font' },
  { id: 'voice', label: 'Voice', icon: 'voice' },
  { id: 'ai', label: 'AI', icon: 'sparkle' },
  { id: 'access', label: 'Accessibility', icon: 'eye' },
  { id: 'storage', label: 'Storage', icon: 'down' },
  { id: 'privacy', label: 'Privacy', icon: 'shield' },
  { id: 'account', label: 'Account', icon: 'user' },
  { id: 'about', label: 'About', icon: 'info' },
];

export function settingsView() {
  let tab = state.route.params.tab || 'appearance';
  const panel = h('div');

  const chips = h('div', { style: { overflowX: 'auto', marginBottom: 'var(--sp-5)', paddingBottom: '4px' } },
    h('div.chips', { style: { flexWrap: 'nowrap', width: 'max-content' } },
      ...TABS.map((t) =>
        h('button.chip', {
          'aria-pressed': String(t.id === tab),
          onclick: (e) => {
            tab = t.id;
            history.replaceState(null, '', `#/settings/${t.id}`);
            [...e.currentTarget.parentElement.children].forEach((c, i) =>
              c.setAttribute('aria-pressed', String(TABS[i].id === tab)));
            paint();
          },
        }, icon(t.icon, 15), t.label))));

  const paint = () => fill(panel, PANELS[tab]?.(paint) || PANELS.appearance(paint));
  paint();

  return h('div.wrap', null,
    h('header.topbar', null,
      h('div.topbar__row', null,
        h('button.icon-btn', { onclick: () => go('/'), 'aria-label': 'Back' }, icon('chevL', 20)),
        h('h1.topbar__title', null, 'Settings'))),
    chips,
    panel);
}

/* ------------------------------ Controls ------------------------------ */

function toggle(name, desc, key, after) {
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
    h('div.setting__text', null,
      h('div.setting__name', null, name),
      desc && h('div.small.muted', null, desc)),
    sw);
}

function choice(name, desc, key, options, after) {
  return h('div', { style: { padding: 'var(--sp-3) 0', borderBottom: '1px solid var(--line)' } },
    h('div.setting__name', null, name),
    desc && h('div.small.muted', { style: { marginBottom: 'var(--sp-3)' } }, desc),
    h('div.chips', null,
      ...options.map((o) =>
        h('button.chip', {
          'aria-pressed': String(state.settings[key] === o.id),
          onclick: (e) => {
            setSetting(key, o.id);
            [...e.currentTarget.parentElement.children].forEach((c, i) =>
              c.setAttribute('aria-pressed', String(options[i].id === o.id)));
            after?.(o.id);
          },
        }, o.icon && icon(o.icon, 14), o.label))));
}

function slider(name, desc, key, { min, max, step, fmt }, after) {
  const out = h('span.small', { style: { fontWeight: '640', minWidth: '52px', textAlign: 'right' } }, fmt(state.settings[key]));
  return h('div', { style: { padding: 'var(--sp-3) 0', borderBottom: '1px solid var(--line)' } },
    h('div.row', null,
      h('div.setting__text', null,
        h('div.setting__name', null, name),
        desc && h('div.small.muted', null, desc)),
      out),
    h('input.range', {
      type: 'range', min, max, step, value: String(state.settings[key]), 'aria-label': name,
      oninput: (e) => {
        const v = Number(e.target.value);
        setSetting(key, v);
        out.textContent = fmt(v);
        after?.(v);
      },
    }));
}

const card = (...kids) => h('div.card.card--pad', { style: { marginBottom: 'var(--sp-4)' } }, ...kids);
const label = (t) => h('h3', { style: { fontSize: 'var(--step-0)', marginBottom: 'var(--sp-2)' } }, t);

/* ------------------------------ Panels ------------------------------ */

const PANELS = {
  appearance: () => h('div', null,
    card(
      label('Theme'),
      choice('Appearance', 'AMOLED uses true black to save battery on OLED screens.', 'theme', [
        { id: 'system', label: 'System' },
        { id: 'light', label: 'Light', icon: 'sun' },
        { id: 'dark', label: 'Dark', icon: 'moon' },
        { id: 'amoled', label: 'AMOLED' },
      ], applyTheme),
      hueRow(),
      toggle('Dynamic colour', 'Tint the app to match the cover of whatever you’re reading', 'dynamicColor'),
    ),
    card(
      label('Scale'),
      slider('Interface size', 'Affects the app chrome, not the reading text', 'uiScale',
        { min: '0.85', max: '1.4', step: '0.05', fmt: (v) => `${Math.round(v * 100)}%` }, applyTheme),
    ),
  ),

  reading: () => h('div', null,
    card(
      label('Page'),
      choice('Reading theme', null, 'paper', [
        { id: 'light', label: 'Light' }, { id: 'sepia', label: 'Sepia' }, { id: 'paper', label: 'Paper' },
        { id: 'dark', label: 'Dark' }, { id: 'amoled', label: 'AMOLED' },
      ]),
      choice('Typeface', 'The dyslexia-friendly option uses a font with heavier letter bottoms, if your system has one.', 'fontFamily', [
        { id: 'serif', label: 'Serif' }, { id: 'sans', label: 'Sans' },
        { id: 'mono', label: 'Mono' }, { id: 'dyslexia', label: 'Dyslexia-friendly' },
      ]),
      slider('Text size', null, 'fontSize', { min: '13', max: '34', step: '1', fmt: (v) => `${v}px` }),
      slider('Line spacing', null, 'lineHeight', { min: '1.2', max: '2.6', step: '0.05', fmt: (v) => v.toFixed(2) }),
      slider('Paragraph spacing', null, 'paraSpacing', { min: '0.4', max: '3', step: '0.1', fmt: (v) => `${v.toFixed(1)}em` }),
      slider('Page width', 'Around 60–75 characters per line is easiest to read.', 'pageWidth',
        { min: '40', max: '110', step: '2', fmt: (v) => `${v}ch` }),
      choice('Alignment', 'Justified text can create uneven word spacing.', 'textAlign', [
        { id: 'left', label: 'Left' }, { id: 'justify', label: 'Justified' },
      ]),
    ),
    card(
      label('While listening'),
      toggle('Auto-scroll', 'Keep the sentence being read in view', 'autoScroll'),
      toggle('Highlight sentence', 'Mark the sentence currently being spoken', 'highlightSentence'),
      toggle('Highlight words', 'Follow along word by word, where the voice supports it', 'wordHighlight'),
      toggle('Focus mode', 'Dim everything except the current paragraph', 'focusMode'),
    ),
  ),

  voice: () => {
    const root = h('div');
    const info = h('div.card.card--pad', { style: { marginBottom: 'var(--sp-4)' } }, h('div.spin'));

    if (!ttsSupported()) {
      return card(
        label('No speech engine'),
        h('p.small.muted', null, 'This browser doesn’t provide text-to-speech. Try Chrome, Edge, or Safari.'));
    }

    voiceList().then((list) => {
      const v = list.find((x) => x.uri === state.settings.voiceURI) || list[0];
      fill(info,
        label('Voice'),
        v
          ? h('div.row', null,
              h('div', { style: { flex: '1' } },
                h('div', { style: { fontWeight: '640' } }, v.name),
                h('div.small.muted', null, [v.langLabel, v.region, v.local ? 'On device' : 'Online'].filter(Boolean).join(' · '))),
              h('button.btn.btn--sm.btn--outline', { onclick: () => openVoices(player) }, 'Change'))
          : h('p.small.muted', null, 'No voices are installed on this device.'),
        h('p.small.muted', { style: { marginTop: 'var(--sp-3)' } },
          `${list.length} voice${list.length === 1 ? '' : 's'} available. Voices come from your operating system — install more in your system settings to see them here.`));
    });

    fill(root,
      info,
      card(
        label('Playback'),
        slider('Speed', null, 'rate', { min: '0.5', max: '4', step: '0.05', fmt: (v) => `${Number(v).toFixed(2).replace(/\.?0+$/, '')}×` },
          (v) => player.speaker.configure({ rate: v })),
        slider('Pitch', null, 'pitch', { min: '0.5', max: '2', step: '0.05', fmt: (v) => v.toFixed(2) },
          (v) => player.speaker.configure({ pitch: v })),
        slider('Volume', null, 'volume', { min: '0', max: '1', step: '0.05', fmt: (v) => `${Math.round(v * 100)}%` },
          (v) => player.speaker.configure({ volume: v })),
        toggle('Skip silence', 'Collapse long runs of dots and dashes that make the voice pause', 'skipSilence',
          (v) => player.speaker.configure({ skipSilence: v })),
        h('div.row', { style: { marginTop: 'var(--sp-3)' } },
          h('button.btn.btn--outline', { onclick: () => openSpeed(player) }, icon('speed', 16), 'Playback panel'),
          h('button.btn.btn--outline', { onclick: () => openVoices(player) }, icon('voice', 16), 'Browse voices')),
      ),
      card(
        label('Remote control'),
        h('p.small.muted', null,
          'Lumen publishes what it’s playing to your system, so the lock screen, Bluetooth remotes, headphone buttons, Android Auto, and CarPlay can all control it. Nothing to configure — it works whenever playback is active.')),
    );
    return root;
  },

  ai: (repaint) => {
    const s = state.settings;
    const keyInput = h('input.input', {
      type: 'password',
      value: s.aiKey,
      placeholder: 'sk-ant-…',
      autocomplete: 'off',
      spellcheck: false,
      'aria-label': 'API key',
      onchange: (e) => setSetting('aiKey', e.target.value.trim()),
    });

    return h('div', null,
      card(
        label('Provider'),
        choice('AI runs', null, 'aiProvider', [
          { id: 'local', label: 'On device' },
          { id: 'anthropic', label: 'Claude API' },
        ], repaint),
        s.aiProvider === 'local'
          ? h('p.small.muted', null,
              'Summaries, key points, keywords, definitions, study notes, action items, timelines, and difficult words all run here, offline, by analysing the text itself. Explain simply, Translate, Q&A, Flashcards, and Quiz need a cloud model.')
          : h('p.small.muted', null,
              'Uses your own Anthropic API key. Lumen has no server — requests go straight from this device to the provider, and you are billed by them directly.')),

      s.aiProvider !== 'local' && card(
        label('API key'),
        h('div.field', null, keyInput),
        h('p.small.muted', { style: { marginTop: 'var(--sp-2)' } },
          'Stored only on this device. It is never included in backups or exports.'),
        h('a.btn.btn--sm.btn--ghost', {
          href: 'https://console.anthropic.com/settings/keys',
          target: '_blank',
          rel: 'noopener noreferrer',
          style: { marginTop: 'var(--sp-2)' },
        }, icon('link', 14), 'Get a key'),
        h('div', { style: { marginTop: 'var(--sp-3)' } },
          h('span.field__label', null, 'Model'),
          h('select.select', { onchange: (e) => setSetting('aiModel', e.target.value) },
            ...[
              ['claude-sonnet-5', 'Claude Sonnet 5 — balanced'],
              ['claude-opus-4-8', 'Claude Opus 4.8 — most capable'],
              ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5 — fastest'],
            ].map(([v, l]) => h('option', { value: v, selected: s.aiModel === v }, l)))),
        h('button.btn.btn--outline.btn--block', {
          style: { marginTop: 'var(--sp-3)' },
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            fill(btn, h('span.spin'), 'Testing…');
            try {
              const res = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  'x-api-key': state.settings.aiKey,
                  'anthropic-version': '2023-06-01',
                  'anthropic-dangerous-direct-browser-access': 'true',
                },
                body: JSON.stringify({
                  model: state.settings.aiModel,
                  max_tokens: 8,
                  messages: [{ role: 'user', content: 'Say OK' }],
                }),
              });
              if (res.ok) toast('Key works', 'ok');
              else if (res.status === 401) toast('That key was rejected.', 'err');
              else toast(`Provider returned ${res.status}.`, 'err');
            } catch {
              toast('Could not reach the provider.', 'err');
            } finally {
              btn.disabled = false;
              fill(btn, icon('check', 16), 'Test key');
            }
          },
        }, icon('check', 16), 'Test key')),

      s.aiProvider !== 'local' && card(
        label('Consent'),
        toggle('Allow sending documents', 'Required before any text leaves this device', 'aiConsent'),
        h('p.small.muted', null,
          'With this off, cloud features are blocked and only the on-device ones run. Turning it off does not delete results already generated.')),

      card(
        label('Translation'),
        h('span.field__label', null, 'Default language'),
        h('select.select', { onchange: (e) => setSetting('translateTo', e.target.value) },
          ...LANGS.map((l) => h('option', { value: l.code, selected: s.translateTo === l.code }, l.label)))),
    );
  },

  access: () => h('div', null,
    card(
      label('Sight'),
      choice('Contrast', 'High contrast removes translucency and strengthens borders.', 'contrast', [
        { id: 'normal', label: 'Normal' }, { id: 'high', label: 'High' },
      ], applyTheme),
      slider('Interface size', null, 'uiScale', { min: '0.85', max: '1.4', step: '0.05', fmt: (v) => `${Math.round(v * 100)}%` }, applyTheme),
      slider('Reading text size', null, 'fontSize', { min: '13', max: '34', step: '1', fmt: (v) => `${v}px` }),
    ),
    card(
      label('Motion'),
      choice('Animation', 'Reduced motion removes transitions and makes auto-scroll jump instead of glide.', 'motion', [
        { id: 'auto', label: 'System' }, { id: 'reduced', label: 'Reduced' },
      ], applyTheme),
    ),
    card(
      label('Keyboard'),
      h('p.small.muted', { style: { marginBottom: 'var(--sp-3)' } }, 'Shortcuts work anywhere except in text fields.'),
      ...[
        ['Space', 'Play or pause'],
        ['→ / ←', 'Next / previous sentence'],
        ['↑ / ↓', 'Previous / next paragraph'],
        ['J / L', 'Slower / faster'],
        ['/', 'Search'],
        ['G then H', 'Home'],
        ['G then L', 'Library'],
        ['N', 'Add something'],
        ['F', 'Focus mode'],
        ['?', 'Show this list'],
        ['Esc', 'Close / back'],
      ].map(([k, d]) =>
        h('div.row', { style: { padding: '6px 0' } },
          h('span.kbd', { style: { minWidth: '54px' } }, k),
          h('span.small.muted', null, d))),
    ),
    card(
      label('Screen readers'),
      h('p.small.muted', null,
        'Lumen is built with semantic landmarks, live regions for playback and search, labelled controls, and a visible focus ring throughout. The reader exposes each sentence as its own element, so a screen reader can navigate the text independently of the speech engine.')),
  ),

  storage: (repaint) => {
    const root = h('div');
    const box = h('div.card.card--pad', { style: { marginBottom: 'var(--sp-4)' } }, h('div.spin'));

    db.usage().then((u) => {
      const pct = u.quota ? Math.round((u.used / u.quota) * 100) : 0;
      fill(box,
        label('Storage'),
        h('div.row', { style: { marginBottom: 'var(--sp-2)' } },
          h('span.small.muted', { style: { flex: '1' } }, `${fmtBytes(u.used)} used`),
          h('span.small.muted', null, u.quota ? `of about ${fmtBytes(u.quota)}` : '')),
        h('div.bar', null, h('div.bar__fill', { style: { width: `${Math.min(100, pct)}%` } })),
        h('div', { style: { display: 'grid', gap: '4px', marginTop: 'var(--sp-4)' } },
          row('Documents', String(u.docs)),
          row('Original files kept', fmtBytes(u.blobBytes)),
          row('Cached speech', `${u.audioCount} clip${u.audioCount === 1 ? '' : 's'} · ${fmtBytes(u.audioBytes)}`)),
        h('div.row', { style: { marginTop: 'var(--sp-4)' } },
          h('button.btn.btn--sm.btn--outline', {
            onclick: async () => {
              const ok = await db.persist();
              toast(ok ? 'Your library is protected from automatic cleanup.' : 'The browser declined — your data may be cleared if storage runs low.', ok ? 'ok' : 'err');
            },
          }, icon('shield', 15), 'Protect from cleanup')));
    });

    const row = (k, v) =>
      h('div.row', null, h('span.small.muted', { style: { flex: '1' } }, k), h('span.small', { style: { fontWeight: '600' } }, v));

    fill(root,
      box,
      card(
        label('Offline'),
        h('p.small.muted', null,
          'Everything you import is already stored on this device and works offline: the library, the text, your notes, and system voices. The PDF, Word, EPUB, and scanning engines download once on first use and are then cached for good.'),
        toggle('Download only on Wi-Fi', 'Applies to the one-time format engines', 'wifiOnlyDownloads')),
      card(
        label('Backup'),
        h('p.small.muted', { style: { marginBottom: 'var(--sp-3)' } },
          'Lumen has no server, so a backup file is how you move your library to another device. It contains your documents, notes, and settings — but never your API key.'),
        h('div.row', null,
          h('button.btn.btn--outline', {
            onclick: async () => {
              const n = await exportLibrary();
              toast(`Exported ${n} document${n === 1 ? '' : 's'}`, 'ok');
            },
          }, icon('down', 16), 'Export backup'),
          h('button.btn.btn--outline', {
            onclick: () => {
              const inp = h('input', {
                type: 'file',
                accept: '.json',
                style: { display: 'none' },
                onchange: async (e) => {
                  try {
                    const n = await importBackup(e.target.files[0]);
                    invalidate();
                    await refreshDocs();
                    toast(`Restored ${n} document${n === 1 ? '' : 's'}`, 'ok');
                    repaint();
                  } catch (err) {
                    toast(err.message, 'err');
                  }
                },
              });
              document.body.append(inp);
              inp.click();
              inp.remove();
            },
          }, icon('up', 16), 'Restore backup'))),
      card(
        label('Clear'),
        h('button.btn.btn--outline.btn--block', {
          onclick: async () => {
            const docs = await db.listDocs({});
            for (const d of docs) await db.clearAudio(d.id);
            toast('Cached speech cleared', 'ok');
            repaint();
          },
        }, icon('trash', 16), 'Clear cached speech')),
    );
    return root;
  },

  privacy: () => h('div', null,
    card(
      label('How Lumen handles your data'),
      h('ul.small.muted', { style: { paddingLeft: '1.2em', display: 'grid', gap: 'var(--sp-2)' } },
        h('li', null, h('strong', null, 'There is no Lumen server.'), ' Your documents live in this browser’s storage on this device.'),
        h('li', null, h('strong', null, 'Scanning is local.'), ' Photos are processed on-device and never uploaded.'),
        h('li', null, h('strong', null, 'Websites are fetched without your cookies,'), ' so sites see a logged-out visitor.'),
        h('li', null, h('strong', null, 'Cloud AI is opt-in'), ' and off by default. Nothing is sent without your explicit consent.'),
        h('li', null, h('strong', null, 'No analytics, no tracking, no ads.')))),
    card(
      label('Encryption'),
      toggle('Encrypt documents at rest', 'AES-256 with a passphrase you choose', 'encrypt', async (v) => {
        if (!v) return;
        const pass = await promptPass();
        if (!pass) return setSetting('encrypt', false);
        const salt = crypto.getRandomValues(new Uint8Array(16));
        await db.kvSet('salt', salt);
        await db.unlock(pass, salt);
        toast('New documents will be encrypted on this device.', 'ok');
      }),
      h('p.small.muted', null,
        'The key is derived from your passphrase and kept only in memory, so a copy of the database is useless without it. There is no recovery — if you forget the passphrase, the content is gone.')),
    card(
      label('Website reader'),
      h('span.field__label', null, 'Reader proxy (optional)'),
      h('input.input', {
        value: state.settings.proxy,
        placeholder: 'https://your-proxy.example/?url={url}',
        spellcheck: false,
        onchange: (e) => setSetting('proxy', e.target.value.trim()),
      }),
      h('p.small.muted', { style: { marginTop: 'var(--sp-2)' } },
        'Many sites block other apps from reading them directly. A proxy you run yourself works around that. Use ',
        h('code', null, '{url}'),
        ' where the address goes. Only add a proxy you trust — it will see every page you read through it.')),
    card(
      label('Erase'),
      h('button.btn.btn--danger.btn--block', {
        style: { border: '1px solid var(--danger)' },
        onclick: async () => {
          const ok = await confirmDlg({
            title: 'Erase everything?',
            message: 'Every document, note, highlight, and setting is permanently deleted from this device. This cannot be undone. Export a backup first if you want to keep any of it.',
            confirmLabel: 'Erase everything',
            danger: true,
          });
          if (!ok) return;
          await db.nuke();
          localStorage.clear();
          location.reload();
        },
      }, icon('trash', 16), 'Erase all data')),
  ),

  account: (repaint) => {
    const u = state.user;
    return h('div', null,
      card(
        u
          ? h('div.col', null,
              h('div.row', null,
                h('div', {
                  style: {
                    display: 'grid', placeItems: 'center', width: '52px', height: '52px', borderRadius: '50%',
                    background: 'var(--accent)', color: 'var(--accent-ink)', fontSize: '20px', fontWeight: '700',
                  },
                }, (u.name || '?')[0].toUpperCase()),
                h('div', { style: { flex: '1' } },
                  h('div', { style: { fontWeight: '650' } }, u.name),
                  h('div.small.muted', null, u.email || 'Local profile'),
                  h('div.small.muted', null, `Signed in ${ago(u.since)}`))),
              h('button.btn.btn--outline.btn--block', {
                onclick: async () => {
                  await signOut();
                  repaint();
                },
              }, icon('logout', 16), 'Sign out'))
          : h('div.col', null,
              h('div.row', null,
                h('div.empty__glyph', { style: { width: '52px', height: '52px' } }, icon('user', 22)),
                h('div', { style: { flex: '1' } },
                  h('div', { style: { fontWeight: '650' } }, 'Guest'),
                  h('div.small.muted', null, 'Everything works. Nothing is synced.'))),
              h('button.btn.btn--primary.btn--block', {
                onclick: () => openAuth(repaint),
              }, icon('user', 16), 'Create a profile'))),
      card(
        label('Syncing across devices'),
        h('p.small.muted', null,
          'Lumen is a local-first app with no backend, so there is nothing to sync to. A profile just labels this device and keeps your reading history separate if you share it.'),
        h('p.small.muted', { style: { marginTop: 'var(--sp-2)' } },
          'To move your library to another device, use ',
          h('strong', null, 'Settings → Storage → Export backup'),
          ' and restore the file there. It carries your documents, progress, notes, and highlights.'),
        h('button.btn.btn--sm.btn--outline', {
          style: { marginTop: 'var(--sp-3)' },
          onclick: () => go('/settings/storage'),
        }, icon('down', 15), 'Go to backup')),
    );
  },

  about: () => h('div', null,
    card(
      h('div', { style: { display: 'grid', placeItems: 'center', gap: 'var(--sp-2)', textAlign: 'center', padding: 'var(--sp-4)' } },
        h('h2', { style: { fontSize: 'var(--step-2)' } }, 'Lumen'),
        h('p.small.muted', null, 'Version 1.0.0'),
        h('p.small.muted', { style: { maxWidth: '40ch' } },
          'A reading app that turns anything into natural speech. Local-first, private by default, and built to work offline.'))),
    card(
      label('What powers it'),
      ...[
        ['Speech', 'Your device’s own voices, via the Web Speech API'],
        ['PDF', 'pdf.js — Mozilla, Apache 2.0'],
        ['Word', 'Mammoth — MIT'],
        ['EPUB', 'JSZip — MIT'],
        ['Scanning', 'Tesseract.js — Apache 2.0'],
        ['Everything else', 'Written from scratch for this app'],
      ].map(([k, v]) =>
        h('div.row', { style: { padding: '5px 0' } },
          h('span.small.muted', { style: { minWidth: '110px' } }, k),
          h('span.small', null, v)))),
    card(
      label('Reset'),
      h('button.btn.btn--outline.btn--block', {
        onclick: async () => {
          const ok = await confirmDlg({
            title: 'Reset settings?',
            message: 'Every preference goes back to its default. Your documents and notes are untouched.',
            confirmLabel: 'Reset',
          });
          if (!ok) return;
          setSettings({ ...DEFAULT_SETTINGS, aiKey: state.settings.aiKey });
          applyTheme();
          toast('Settings reset', 'ok');
        },
      }, 'Reset all settings')),
  ),
};

function hueRow() {
  const HUES = [262, 218, 190, 152, 96, 42, 18, 350, 320];
  return h('div', { style: { padding: 'var(--sp-3) 0', borderBottom: '1px solid var(--line)' } },
    h('div.setting__name', { style: { marginBottom: 'var(--sp-3)' } }, 'Accent colour'),
    h('div.row', { style: { flexWrap: 'wrap', gap: '10px' } },
      ...HUES.map((hue) =>
        h('button', {
          'aria-label': `Accent hue ${hue}`,
          'aria-pressed': String(state.settings.accentHue === hue),
          style: {
            width: '34px', height: '34px', borderRadius: '50%',
            background: `hsl(${hue} 80% 60%)`,
            border: state.settings.accentHue === hue ? '3px solid var(--ink)' : '3px solid transparent',
            outline: '1px solid var(--line-2)',
          },
          onclick: (e) => {
            setSetting('accentHue', hue);
            applyTheme();
            [...e.currentTarget.parentElement.children].forEach((c, i) => {
              c.style.border = HUES[i] === hue ? '3px solid var(--ink)' : '3px solid transparent';
              c.setAttribute('aria-pressed', String(HUES[i] === hue));
            });
          },
        }))));
}

function promptPass() {
  return new Promise((resolve) => {
    const a = h('input.input', { type: 'password', placeholder: 'Passphrase', autocomplete: 'new-password' });
    const b = h('input.input', { type: 'password', placeholder: 'Confirm passphrase', autocomplete: 'new-password' });
    const err = h('p.small', { style: { color: 'var(--danger)' } });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
      s.close();
    };

    const s = sheet({
      title: 'Choose a passphrase',
      onClose: () => finish(null),
      body: h('form.col', {
        onsubmit: (e) => {
          e.preventDefault();
          if (a.value.length < 8) return (err.textContent = 'Use at least 8 characters.');
          if (a.value !== b.value) return (err.textContent = 'The two passphrases don’t match.');
          finish(a.value);
        },
      },
        h('p.small.muted', null, 'This never leaves your device and cannot be recovered. Write it down somewhere safe.'),
        a, b, err,
        h('button.btn.btn--primary.btn--block', { type: 'submit' }, 'Encrypt my library')),
    });
  });
}
