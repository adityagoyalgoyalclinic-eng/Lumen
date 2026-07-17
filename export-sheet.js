/**
 * Export sheet. Separate module because Home, Library, and the Reader all open it, and
 * routing it through any one of them would create an import cycle.
 */

import { h, icon } from '../util/dom.js';
import { sheet, toast } from './kit.js';
import * as db from '../core/db.js';
import { state } from '../core/store.js';
import { exportDoc, FORMATS, recordAudio } from '../services/export.js';
import { Speaker } from '../services/tts.js';
import { sentences } from '../util/text.js';

/**
 * @param {object} docMeta - Document metadata; full blocks are loaded on demand.
 */
export function openExport(docMeta) {
  const body = h('div.col');
  const s = sheet({ title: `Export "${docMeta.title}"`, body });

  const rows = FORMATS.map((f) =>
    h(
      'button.btn.btn--ghost',
      {
        style: { justifyContent: 'flex-start', width: '100%' },
        onclick: () => (f.id === 'audio' ? audioFlow(docMeta, s) : run(f)),
      },
      icon(f.icon, 18),
      h('span', { style: { flex: '1', textAlign: 'left' } }, f.label),
      h('span.small.muted', null, `.${f.ext}`),
    ));

  async function run(f) {
    try {
      const doc = await db.getDoc(docMeta.id);
      if (!doc) throw new Error('Document not found.');
      await exportDoc(doc, f.id);
      toast(`Exported as ${f.label}`, 'ok');
      s.close();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  body.append(
    ...rows,
    h('div', { style: { borderTop: '1px solid var(--line)', marginTop: 'var(--sp-3)', paddingTop: 'var(--sp-3)' } },
      h('button.btn.btn--ghost', {
        style: { justifyContent: 'flex-start', width: '100%' },
        onclick: async () => {
          try {
            const doc = await db.getDoc(docMeta.id);
            await exportDoc(doc, 'original');
            s.close();
          } catch (err) {
            toast(err.message, 'err');
          }
        },
      }, icon('down', 18), 'Original file')),
  );

  return s;
}

/**
 * Audio export runs in real time — the speech engine has no offline render path. The
 * UI says so up front, because a 40-minute progress bar with no explanation reads as
 * a hang.
 */
function audioFlow(docMeta, parent) {
  parent.close();

  const controller = new AbortController();
  const bar = h('div.bar__fill', { style: { width: '0%' } });
  const pctLabel = h('span.small.muted', null, '0%');
  const status = h('p.small.muted', null, 'Waiting for you to share this tab’s audio…');

  const start = h('button.btn.btn--primary.btn--block', { onclick: begin }, icon('voice', 18), 'Start recording');
  const cancel = h('button.btn.btn--ghost.btn--block', {
    onclick: () => {
      controller.abort();
      s.close();
    },
  }, 'Cancel');

  const s = sheet({
    title: 'Export audio',
    onClose: () => controller.abort(),
    body: h(
      'div.col',
      null,
      h('div', { style: { display: 'flex', gap: 'var(--sp-3)', padding: 'var(--sp-4)', borderRadius: 'var(--r-md)', background: 'var(--accent-wash)' } },
        icon('info', 18),
        h('div.small', null,
          h('strong', null, 'This records in real time.'),
          ' Your browser can’t render speech to a file directly, so Lumen plays the document and captures the audio. A 20-minute read takes 20 minutes, and this tab must stay open.')),
      h('p.small', null,
        'When prompted, choose ', h('strong', null, 'this tab'), ' and turn on ', h('strong', null, '“Share tab audio”'), '.'),
      h('div', { style: { display: 'grid', gap: '6px' } },
        h('div.row', null, h('span.small', { style: { flex: '1' } }, 'Progress'), pctLabel),
        h('div.bar', null, bar)),
      status,
      start,
      cancel,
    ),
  });

  async function begin() {
    start.disabled = true;
    const speaker = new Speaker();
    try {
      const doc = await db.getDoc(docMeta.id);
      const text = (doc.blocks || []).filter((b) => b.text).map((b) => b.text).join('\n\n');
      const items = sentences(text);
      if (!items.length) throw new Error('Nothing to speak in this document.');

      const { voices } = await import('../services/tts.js');
      const list = await voices();
      const voice = list.find((v) => v.voiceURI === state.settings.voiceURI) || list[0];
      speaker.configure({ voice, rate: state.settings.rate, pitch: state.settings.pitch, volume: 1 });

      status.textContent = 'Recording… keep this tab open and in the foreground.';

      const blob = await recordAudio(items, {
        speaker,
        signal: controller.signal,
        onProgress: (p) => {
          bar.style.width = `${p}%`;
          pctLabel.textContent = `${p}%`;
        },
      });

      const { download } = await import('../services/export.js');
      const ext = blob.type.includes('mp4') ? 'm4a' : 'webm';
      download(blob, `${docMeta.title.replace(/[\\/:*?"<>|]/g, '')}.${ext}`);
      toast('Audio exported', 'ok');
      s.close();
    } catch (err) {
      if (err.name !== 'AbortError') {
        status.textContent = err.message;
        status.style.color = 'var(--danger)';
        start.disabled = false;
      }
    } finally {
      speaker.stop();
    }
  }
}
