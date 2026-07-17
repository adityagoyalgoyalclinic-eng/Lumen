/**
 * Export — audio, PDF, text, Markdown, notes, highlights, summaries, flashcards.
 *
 * Everything is generated client-side. The PDF writer is hand-rolled (~150 lines)
 * rather than pulling a 300 KB library for what is, for text documents, a
 * straightforward content stream. Audio uses MediaRecorder to capture real speech
 * output, which is the only way to get a shareable file out of the Web Speech API.
 */

import * as db from '../core/db.js';
import { state } from '../core/store.js';
import { escapeHtml, readMinutes } from '../util/text.js';

/* ------------------------------ Download plumbing ------------------------------ */

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  // Revoke late — Safari needs the URL to survive the click.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Characters Windows and macOS reject in filenames. */
const RESERVED_CHARS = /[<>:"/\\|?*]/g;

/**
 * Filesystem-safe filename.
 *
 * Strips reserved characters, then drops control characters by code point (a regex
 * class covering them is an encoding hazard), collapses whitespace, and caps the
 * length so no OS rejects the download.
 */
const safeName = (s) => {
  const stripped = String(s || 'document')
    .replace(RESERVED_CHARS, '')
    .split('')
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c > 31 && c !== 127;
    })
    .join('');
  return stripped.replace(/\s+/g, ' ').trim().slice(0, 80) || 'document';
};

/* ------------------------------ Text formats ------------------------------ */

export function toText(doc) {
  const lines = [];
  for (const b of doc.blocks || []) {
    switch (b.type) {
      case 'h1': lines.push(`\n${b.text.toUpperCase()}\n${'='.repeat(Math.min(60, b.text.length))}`); break;
      case 'h2': lines.push(`\n${b.text}\n${'-'.repeat(Math.min(60, b.text.length))}`); break;
      case 'h3': lines.push(`\n${b.text}`); break;
      case 'li': lines.push(`  - ${b.text}`); break;
      case 'quote': lines.push(`  "${b.text}"`); break;
      case 'code': lines.push(b.text.split('\n').map((l) => `    ${l}`).join('\n')); break;
      case 'hr': lines.push('\n---\n'); break;
      case 'img': if (b.text) lines.push(`[Image: ${b.text}]`); break;
      default: if (b.text) lines.push(b.text);
    }
  }
  const head = `${doc.title}\n${doc.source ? `Source: ${doc.source}\n` : ''}${'='.repeat(40)}\n`;
  return head + lines.join('\n\n').replace(/\n{4,}/g, '\n\n\n');
}

export function toMarkdown(doc) {
  const out = [`# ${doc.title}`, ''];
  if (doc.source) out.push(`> Source: ${doc.source}`, '');
  for (const b of doc.blocks || []) {
    switch (b.type) {
      case 'h1': out.push(`# ${b.text}`, ''); break;
      case 'h2': out.push(`## ${b.text}`, ''); break;
      case 'h3': out.push(`### ${b.text}`, ''); break;
      case 'li': out.push(`- ${b.text}`); break;
      case 'quote': out.push(`> ${b.text}`, ''); break;
      case 'code': out.push('```', b.text, '```', ''); break;
      case 'hr': out.push('---', ''); break;
      case 'img': out.push(`![${b.text || ''}](${b.src || ''})`, ''); break;
      default: if (b.text) out.push(b.text, '');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function toHtmlDoc(doc) {
  const body = (doc.blocks || []).map((b) => {
    const t = escapeHtml(b.text || '');
    switch (b.type) {
      case 'h1': return `<h1>${t}</h1>`;
      case 'h2': return `<h2>${t}</h2>`;
      case 'h3': return `<h3>${t}</h3>`;
      case 'li': return `<li>${t}</li>`;
      case 'quote': return `<blockquote>${t}</blockquote>`;
      case 'code': return `<pre><code>${t}</code></pre>`;
      case 'hr': return '<hr>';
      case 'img': return b.src ? `<img src="${escapeHtml(b.src)}" alt="${t}">` : '';
      default: return `<p>${t}</p>`;
    }
  }).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(doc.title)}</title>
<style>
  body{max-width:70ch;margin:3rem auto;padding:0 1.25rem;font:17px/1.7 Georgia,serif;color:#1a1a1a}
  h1,h2,h3{font-family:system-ui,sans-serif;line-height:1.2}
  blockquote{border-left:3px solid #ccc;margin:0;padding-left:1rem;color:#555;font-style:italic}
  pre{background:#f4f4f6;padding:1rem;border-radius:8px;overflow-x:auto}
  img{max-width:100%;border-radius:8px}
  .meta{color:#777;font:14px system-ui,sans-serif;border-bottom:1px solid #eee;padding-bottom:1rem}
</style></head>
<body>
<h1>${escapeHtml(doc.title)}</h1>
<p class="meta">${doc.words} words, ${readMinutes(doc.words)} min read${doc.source ? ` &middot; <a href="${escapeHtml(doc.source)}">Source</a>` : ''}</p>
${body}
</body></html>`;
}

/* ------------------------------ Notes & highlights ------------------------------ */

export async function toNotesMarkdown(doc) {
  const marks = await db.marksFor(doc.id);
  if (!marks.length) return `# ${doc.title}\n\n_No notes or highlights yet._\n`;

  const out = [
    `# ${doc.title}`,
    '',
    `_${marks.length} annotation${marks.length > 1 ? 's' : ''}, exported ${new Date().toLocaleDateString()}_`,
    '',
  ];
  const label = { hl: 'Highlight', ul: 'Underline', note: 'Note', bookmark: 'Bookmark' };

  for (const m of marks) {
    const block = doc.blocks?.[m.blockIdx];
    out.push(`### ${label[m.type] || 'Mark'}${block?.page ? ` (page ${block.page})` : ''}`);
    if (m.text) out.push('', `> ${m.text}`);
    if (m.note) out.push('', `**Note:** ${m.note}`);
    out.push('', '---', '');
  }
  return out.join('\n');
}

export async function exportNotes(doc, format = 'md') {
  const md = await toNotesMarkdown(doc);
  const base = `${safeName(doc.title)} - notes`;
  if (format === 'txt') {
    download(new Blob([md.replace(/[#>*_]/g, '')], { type: 'text/plain;charset=utf-8' }), `${base}.txt`);
  } else {
    download(new Blob([md], { type: 'text/markdown;charset=utf-8' }), `${base}.md`);
  }
}

export async function exportFlashcards(doc, format = 'csv') {
  const hit = await db.getAi(doc.id, 'flashcards', 'en');
  const cards = hit?.payload?.data;
  if (!Array.isArray(cards) || !cards.length) {
    throw new Error('Generate flashcards first, then export them.');
  }
  const base = `${safeName(doc.title)} - flashcards`;

  if (format === 'csv') {
    // Anki and Quizlet both import this: quoted CSV, front then back. The BOM makes
    // Excel read it as UTF-8 instead of mangling every accented character.
    const BOM = String.fromCharCode(0xfeff);
    const csv = cards.map((c) => `${csvCell(c.q)},${csvCell(c.a)}`).join('\n');
    download(new Blob([BOM + csv], { type: 'text/csv;charset=utf-8' }), `${base}.csv`);
  } else {
    download(new Blob([JSON.stringify(cards, null, 2)], { type: 'application/json' }), `${base}.json`);
  }
}

const csvCell = (s) => `"${String(s).replace(/"/g, '""')}"`;

/* ------------------------------ PDF ------------------------------ */

/**
 * Minimal PDF writer.
 *
 * Emits a valid PDF 1.4 using the base-14 Helvetica/Times fonts (no font embedding, so
 * no file bloat and no licensing questions). Handles pagination, headings, wrapping,
 * and a proper xref table.
 */
export function toPdf(doc) {
  const PAGE = { w: 595.28, h: 841.89 }; // A4 in points
  const M = { top: 64, bottom: 60, left: 62, right: 62 };
  const width = PAGE.w - M.left - M.right;

  const pages = [];
  let ops = [];
  let y = PAGE.h - M.top;

  const newPage = () => {
    pages.push(ops.join('\n'));
    ops = [];
    y = PAGE.h - M.top;
  };
  const need = (n) => { if (y - n < M.bottom) newPage(); };

  const write = (text, { size = 11, font = 'F1', lead = 1.45, gap = 6, indent = 0 } = {}) => {
    // 0.5em is a fair average advance for Helvetica at text sizes; erring narrow means
    // slightly early wraps, never overflow off the page edge.
    const maxChars = Math.max(8, Math.floor((width - indent) / (size * 0.5)));
    for (const line of wrap(text, maxChars)) {
      need(size * lead);
      ops.push(
        'BT',
        `/${font} ${size} Tf`,
        `${(size * lead).toFixed(2)} TL`,
        `1 0 0 1 ${(M.left + indent).toFixed(2)} ${y.toFixed(2)} Tm`,
        `(${esc(line)}) Tj`,
        'ET',
      );
      y -= size * lead;
    }
    y -= gap;
  };

  write(doc.title, { size: 22, font: 'F2', gap: 4 });
  write(
    `${doc.words} words, ${readMinutes(doc.words)} min read${doc.source ? `, ${doc.source}` : ''}`,
    { size: 8.5, gap: 16 },
  );

  for (const b of doc.blocks || []) {
    if (b.type === 'hr') { need(16); y -= 10; continue; }
    if (!b.text) continue;
    switch (b.type) {
      case 'h1': need(40); write(b.text, { size: 17, font: 'F2', gap: 8 }); break;
      case 'h2': need(34); write(b.text, { size: 14, font: 'F2', gap: 7 }); break;
      case 'h3': need(28); write(b.text, { size: 12, font: 'F2', gap: 6 }); break;
      case 'li': write(`-  ${b.text}`, { size: 11, indent: 14, gap: 3 }); break;
      case 'quote': write(b.text, { size: 10.5, font: 'F3', indent: 20, gap: 8 }); break;
      case 'code': write(b.text.replace(/\t/g, '  '), { size: 9, font: 'F4', indent: 14, gap: 8 }); break;
      case 'img': if (b.text) write(`[Image: ${b.text}]`, { size: 9, font: 'F3', gap: 8 }); break;
      default: write(b.text, { size: 11, gap: 9 });
    }
  }
  pages.push(ops.join('\n'));

  return buildPdf(pages, PAGE, doc.title);
}

function wrap(text, maxChars) {
  const out = [];
  for (const para of String(text).split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!line) { line = word; continue; }
      if ((line + ' ' + word).length > maxChars) { out.push(line); line = word; }
      else line += ' ' + word;
    }
    if (line) out.push(line);
  }
  return out.length ? out : [''];
}

/**
 * Escape a PDF string literal and reduce text to WinAnsi.
 *
 * The base-14 fonts are WinAnsi-encoded, so anything outside that range renders as
 * garbage. Fold the common typographic characters to ASCII first (so quotes and dashes
 * survive), then drop the rest by code point.
 */
function esc(s) {
  const folded = String(s)
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[      ]/g, ' ')
    .replace(/[•▪◦]/g, '-');

  let out = '';
  for (const ch of folded) {
    const c = ch.charCodeAt(0);
    if (ch === '\\' || ch === '(' || ch === ')') out += '\\' + ch;
    else if ((c >= 32 && c <= 126) || (c >= 161 && c <= 255)) out += ch;
    // Everything else (control characters, CJK, emoji) has no WinAnsi glyph.
  }
  return out;
}

function buildPdf(pageStreams, PAGE, title) {
  /** @type {string[]} object bodies; PDF object numbers are 1-based */
  const objs = [];
  const push = (s) => {
    objs.push(s);
    return objs.length;
  };

  const FONTS = [
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
  ];

  const catalogNo = push(''); // 1 — body filled in once the pages object number is known
  const pagesNo = push('');   // 2
  const fontNos = FONTS.map((f) => push(f));
  const infoNo = push(
    `<< /Title (${esc(title)}) /Producer (Lumen) /Creator (Lumen) /CreationDate (D:${pdfDate()}) >>`,
  );

  const kids = [];
  for (const stream of pageStreams) {
    const contentNo = push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const pageNo = push(
      `<< /Type /Page /Parent ${pagesNo} 0 R /MediaBox [0 0 ${PAGE.w.toFixed(2)} ${PAGE.h.toFixed(2)}] ` +
      `/Resources << /Font << /F1 ${fontNos[0]} 0 R /F2 ${fontNos[1]} 0 R ` +
      `/F3 ${fontNos[2]} 0 R /F4 ${fontNos[3]} 0 R >> >> ` +
      `/Contents ${contentNo} 0 R >>`,
    );
    kids.push(`${pageNo} 0 R`);
  }

  objs[catalogNo - 1] = `<< /Type /Catalog /Pages ${pagesNo} 0 R >>`;
  objs[pagesNo - 1] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.join(' ')}] >>`;

  let out = '%PDF-1.4\n';
  const offsets = [0];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogNo} 0 R /Info ${infoNo} 0 R >>\n`;
  out += `startxref\n${xref}\n%%EOF`;

  // esc() guarantees every character is <= 255, so a byte-per-char copy is exact and
  // the xref offsets computed from string length stay correct.
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return new Blob([bytes], { type: 'application/pdf' });
}

function pdfDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ------------------------------ Audio ------------------------------ */

/**
 * Record the document as an audio file.
 *
 * The Web Speech API has no "render to buffer" — audio goes straight to the output
 * device. The only way to capture it is to record while it plays, so the export runs in
 * real time (a 20-minute article takes 20 minutes) and the tab must stay open. The UI
 * states that cost up front rather than showing a progress bar that looks stuck.
 *
 * Capturing tab audio requires getDisplayMedia and an explicit user share — a browser
 * security rule with no workaround.
 */
export async function recordAudio(sentences, { onProgress, signal, speaker }) {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('Audio export needs a desktop browser that can capture tab audio.');
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true, // the API requires it even though we discard the track immediately
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  }).catch(() => {
    throw new Error('Audio export was cancelled.');
  });

  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('No audio was shared. Run the export again and tick "Share tab audio".');
  }
  stream.getVideoTracks().forEach((t) => t.stop());

  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
    .find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) {
    audioTracks.forEach((t) => t.stop());
    throw new Error('This browser cannot record audio.');
  }

  const rec = new MediaRecorder(new MediaStream(audioTracks), {
    mimeType: mime,
    audioBitsPerSecond: 128000,
  });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const stopped = new Promise((resolve) => { rec.onstop = resolve; });
  rec.start(1000);

  try {
    await new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => {
        speaker.stop();
        reject(new DOMException('Export cancelled.', 'AbortError'));
      }, { once: true });

      speaker.load(sentences, 0);
      const onSentence = (e) => onProgress?.(Math.round((e.detail.idx / sentences.length) * 100));
      speaker.addEventListener('sentence', onSentence);
      speaker.addEventListener('end', () => {
        speaker.removeEventListener('sentence', onSentence);
        resolve();
      }, { once: true });
      speaker.addEventListener('error', (e) => reject(new Error(e.detail.message)), { once: true });
      speaker.play(0);
    });
  } finally {
    if (rec.state !== 'inactive') rec.stop();
    await stopped;
    audioTracks.forEach((t) => t.stop());
  }

  return new Blob(chunks, { type: mime.split(';')[0] });
}

/* ------------------------------ Dispatcher ------------------------------ */

export const FORMATS = [
  { id: 'txt', label: 'Plain text', ext: 'txt', icon: 'doc' },
  { id: 'md', label: 'Markdown', ext: 'md', icon: 'doc' },
  { id: 'html', label: 'Web page', ext: 'html', icon: 'globe' },
  { id: 'pdf', label: 'PDF', ext: 'pdf', icon: 'doc' },
  { id: 'notes', label: 'Notes & highlights', ext: 'md', icon: 'note' },
  { id: 'summary', label: 'Summary', ext: 'md', icon: 'sparkle' },
  { id: 'flashcards', label: 'Flashcards (CSV)', ext: 'csv', icon: 'cards' },
  { id: 'audio', label: 'Audio', ext: 'webm', icon: 'voice' },
];

export async function exportDoc(doc, format) {
  const name = safeName(doc.title);
  switch (format) {
    case 'txt':
      return download(new Blob([toText(doc)], { type: 'text/plain;charset=utf-8' }), `${name}.txt`);
    case 'md':
      return download(new Blob([toMarkdown(doc)], { type: 'text/markdown;charset=utf-8' }), `${name}.md`);
    case 'html':
      return download(new Blob([toHtmlDoc(doc)], { type: 'text/html;charset=utf-8' }), `${name}.html`);
    case 'pdf':
      return download(toPdf(doc), `${name}.pdf`);
    case 'notes':
      return exportNotes(doc, 'md');
    case 'flashcards':
      return exportFlashcards(doc, 'csv');
    case 'summary': {
      const hit = await db.getAi(doc.id, 'summary', 'en');
      if (!hit) throw new Error('Generate a summary first, then export it.');
      const d = hit.payload.data;
      const body = typeof d === 'string' ? d : (d || []).map((x) => `- ${x}`).join('\n');
      return download(
        new Blob([`# ${doc.title} - Summary\n\n${body}\n`], { type: 'text/markdown;charset=utf-8' }),
        `${name} - summary.md`,
      );
    }
    case 'original': {
      const blob = await db.getBlob(doc.id);
      if (!blob?.data) throw new Error('The original file was not kept for this document.');
      return download(
        new Blob([blob.data], { type: blob.meta?.type || 'application/octet-stream' }),
        blob.meta?.name || name,
      );
    }
    default:
      throw new Error(`Unknown export format "${format}".`);
  }
}

/** Whole-library backup, restorable via importBackup(). */
export async function exportLibrary() {
  const [docs, marks] = await Promise.all([db.allDocsFull(), db.allMarks()]);
  const payload = {
    app: 'lumen',
    version: 1,
    exportedAt: new Date().toISOString(),
    // The API key is a credential, not a preference: it never goes into a backup file.
    settings: { ...state.settings, aiKey: '' },
    docs: docs.map(({ locked, ...d }) => d),
    marks,
  };
  download(
    new Blob([JSON.stringify(payload)], { type: 'application/json' }),
    `lumen-backup-${new Date().toISOString().slice(0, 10)}.json`,
  );
  return payload.docs.length;
}

export async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (data.app !== 'lumen') throw new Error('That is not a Lumen backup file.');

  let n = 0;
  for (const d of data.docs || []) {
    await db.putDoc({ ...d, id: d.id || crypto.randomUUID() });
    n++;
  }
  for (const m of data.marks || []) await db.putMark(m);
  return n;
}
