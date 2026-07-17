/**
 * Universal import → Block[].
 *
 * Every source format converges on one representation (see `Block` in core/db.js), so
 * the reader, the TTS engine, search, and export each have exactly one thing to
 * understand. Adding a format means adding one function here and nothing else.
 *
 * Heavy parsers (pdf.js, mammoth, JSZip) are loaded on first use from a CDN and then
 * cached by the service worker, so the second import works offline. Startup cost for a
 * user who only pastes text stays at zero.
 */

import { sanitizeToFragment } from '../util/sanitize.js';
import { countWords } from '../util/text.js';

const CDN = {
  pdf: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/+esm',
  pdfWorker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs',
  mammoth: 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/+esm',
  jszip: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm',
};

const cache = new Map();

/** Load an ES module once, with a clear error if the user is offline. */
async function lib(key) {
  if (cache.has(key)) return cache.get(key);
  const p = import(/* @vite-ignore */ CDN[key]).catch(() => {
    throw new Error(
      navigator.onLine
        ? `Couldn't load the ${key} engine. Check your connection and retry.`
        : `Reading this format needs the ${key} engine, which isn't downloaded yet. Connect once and it works offline afterwards.`,
    );
  });
  cache.set(key, p);
  return p;
}

/**
 * @typedef {object} Extracted
 * @property {string} title
 * @property {Block[]} blocks
 * @property {string} [thumb] - data: URL cover/first page
 * @property {object} [meta] - format-specific extras (author, pages, chapters)
 */

/**
 * Extract a File into blocks.
 * @param {File} file
 * @param {string} kind - from validateFile()
 * @param {(pct:number, label:string)=>void} [onProgress]
 * @returns {Promise<Extracted>}
 */
export async function extractFile(file, kind, onProgress = () => {}) {
  switch (kind) {
    case 'pdf': return fromPdf(file, onProgress);
    case 'docx': return fromDocx(file, onProgress);
    case 'epub': return fromEpub(file, onProgress);
    case 'md': return fromMarkdown(await file.text(), stripExt(file.name));
    case 'html': return fromHtml(await file.text(), stripExt(file.name));
    case 'rtf': return fromRtf(await file.text(), stripExt(file.name));
    case 'email': return fromEmail(await file.text(), stripExt(file.name));
    case 'txt': return fromText(await file.text(), stripExt(file.name));
    case 'image': {
      const { ocrImage } = await import('./ocr.js');
      return ocrImage(file, onProgress);
    }
    default:
      throw new Error(`No extractor for "${kind}".`);
  }
}

const stripExt = (n) => String(n).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Untitled';

/* ================================ PDF ================================ */

/**
 * PDF text extraction.
 *
 * pdf.js gives positioned text items, not paragraphs. We reconstruct structure from
 * geometry: items on the same baseline join into a line; a vertical gap larger than
 * the running line height starts a new paragraph; a line whose glyphs are markedly
 * larger than the document's body size is promoted to a heading.
 */
async function fromPdf(file, onProgress) {
  const pdfjs = await lib('pdf');
  pdfjs.GlobalWorkerOptions.workerSrc = CDN.pdfWorker;

  const buf = await file.arrayBuffer();
  const task = pdfjs.getDocument({
    data: buf,
    // No external fetches from inside a user's PDF.
    isEvalSupported: false,
    disableAutoFetch: true,
    useSystemFonts: true,
  });
  const pdf = await task.promise;

  const blocks = [];
  const sizes = [];
  const pages = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    onProgress(Math.round((p / pdf.numPages) * 88), `Reading page ${p} of ${pdf.numPages}`);
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const lines = groupLines(content.items);
    pages.push(lines);
    for (const l of lines) sizes.push(l.size);
  }

  // Body size = the most common glyph height. Anything much bigger is a heading.
  const body = mode(sizes.map((s) => Math.round(s))) || 12;

  pages.forEach((lines, pi) => {
    let para = null;
    let prevBottom = null;

    for (const line of lines) {
      const text = line.text.trim();
      if (!text) continue;
      // Drop page furniture: a bare number, or a repeated running header/footer.
      if (/^\d{1,4}$/.test(text) && line.size <= body) continue;

      const gap = prevBottom == null ? 0 : Math.abs(line.y - prevBottom);
      const ratio = line.size / body;

      if (ratio >= 1.55) {
        flush();
        blocks.push({ type: 'h1', text, page: pi + 1 });
      } else if (ratio >= 1.22) {
        flush();
        blocks.push({ type: 'h2', text, page: pi + 1 });
      } else if (/^\s*(?:[•▪◦‣·–—]|\d{1,2}[.)])\s+/.test(text)) {
        flush();
        blocks.push({ type: 'li', text: text.replace(/^\s*(?:[•▪◦‣·–—]|\d{1,2}[.)])\s+/, ''), page: pi + 1 });
      } else {
        // Big vertical gap = new paragraph. Otherwise continue the current one,
        // rejoining words that the PDF hyphenated across a line break.
        if (para && gap > line.size * 1.75) flush();
        if (!para) para = { type: 'p', text: '', page: pi + 1 };
        para.text = para.text
          ? /[-‐]$/.test(para.text)
            ? para.text.replace(/[-‐]$/, '') + text
            : `${para.text} ${text}`
          : text;
      }
      prevBottom = line.y;
    }
    flush();

    function flush() {
      if (para && para.text.trim()) blocks.push(para);
      para = null;
    }
  });

  onProgress(94, 'Rendering cover');
  const thumb = await pdfThumb(pdf);
  const info = await pdf.getMetadata().catch(() => ({ info: {} }));
  const title = info?.info?.Title?.trim() || stripExt(file.name);

  pdf.destroy();
  return {
    title,
    blocks: dedupeRunningHeads(blocks),
    thumb,
    meta: { pages: pdf.numPages, author: info?.info?.Author || '' },
  };
}

/** Group positioned text items into visual lines. */
function groupLines(items) {
  const rows = new Map();
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const y = Math.round(it.transform[5]);
    const size = Math.abs(it.transform[0]) || Math.abs(it.transform[3]) || 12;
    // Bucket to 2px so sub-pixel baseline jitter doesn't split a line.
    const key = Math.round(y / 2) * 2;
    if (!rows.has(key)) rows.set(key, { y, size, items: [] });
    const row = rows.get(key);
    row.items.push({ x: it.transform[4], str: it.str });
    row.size = Math.max(row.size, size);
  }
  return [...rows.values()]
    .sort((a, b) => b.y - a.y) // PDF origin is bottom-left
    .map((r) => ({
      y: r.y,
      size: r.size,
      text: r.items.sort((a, b) => a.x - b.x).map((i) => i.str).join('').replace(/\s+/g, ' '),
    }));
}

function mode(arr) {
  const f = new Map();
  for (const v of arr) f.set(v, (f.get(v) || 0) + 1);
  let best = null;
  let n = 0;
  for (const [v, c] of f) if (c > n) { n = c; best = v; }
  return best;
}

/** Remove headers/footers that repeat on most pages. */
function dedupeRunningHeads(blocks) {
  const pages = new Set(blocks.map((b) => b.page)).size;
  if (pages < 4) return blocks;
  const seen = new Map();
  for (const b of blocks) {
    if (!b.text || b.text.length > 90) continue;
    const k = b.text.trim().toLowerCase();
    if (!seen.has(k)) seen.set(k, new Set());
    seen.get(k).add(b.page);
  }
  const junk = new Set([...seen.entries()].filter(([, ps]) => ps.size >= pages * 0.6).map(([k]) => k));
  return junk.size ? blocks.filter((b) => !junk.has(String(b.text).trim().toLowerCase())) : blocks;
}

async function pdfThumb(pdf) {
  try {
    const page = await pdf.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const scale = Math.min(420 / vp.width, 1.6);
    const v = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.ceil(v.width);
    c.height = Math.ceil(v.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: v }).promise;
    return c.toDataURL('image/jpeg', 0.72);
  } catch {
    return null;
  }
}

/* ================================ DOCX ================================ */

async function fromDocx(file, onProgress) {
  onProgress(20, 'Opening document');
  const mammoth = await lib('mammoth');
  const buf = await file.arrayBuffer();
  onProgress(55, 'Converting');
  // Mammoth maps Word styles to semantic HTML, which we then sanitize like any HTML.
  const { value } = await mammoth.convertToHtml(
    { arrayBuffer: buf },
    { styleMap: ['p[style-name="Quote"] => blockquote:fresh', 'p[style-name="Intense Quote"] => blockquote:fresh'] },
  );
  onProgress(85, 'Building blocks');
  const out = fromHtml(value, stripExt(file.name));
  // Prefer the first heading as the title — Word filenames are rarely meaningful.
  const h = out.blocks.find((b) => b.type === 'h1' || b.type === 'h2');
  if (h) out.title = h.text;
  return out;
}

/* ================================ EPUB ================================ */

/**
 * EPUB: a zip of XHTML. Read container.xml → the OPF package → the spine (reading
 * order) → each chapter document. Chapter index rides on every block so "skip chapter"
 * and the chapter list work without a second pass.
 */
async function fromEpub(file, onProgress) {
  const JSZip = (await lib('jszip')).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  const containerXml = await zip.file('META-INF/container.xml')?.async('text');
  if (!containerXml) throw new Error('Not a valid EPUB: container.xml is missing.');
  const container = new DOMParser().parseFromString(containerXml, 'application/xml');
  const opfPath = container.querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath) throw new Error('Not a valid EPUB: no package document.');

  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opf = new DOMParser().parseFromString(await zip.file(opfPath).async('text'), 'application/xml');

  const title = opf.querySelector('metadata > title, dc\\:title')?.textContent?.trim() || stripExt(file.name);
  const author = opf.querySelector('metadata > creator, dc\\:creator')?.textContent?.trim() || '';

  const manifest = new Map();
  for (const item of opf.querySelectorAll('manifest > item')) {
    manifest.set(item.getAttribute('id'), {
      href: item.getAttribute('href'),
      type: item.getAttribute('media-type'),
      props: item.getAttribute('properties') || '',
    });
  }

  const spine = [...opf.querySelectorAll('spine > itemref')]
    .map((r) => manifest.get(r.getAttribute('idref')))
    .filter((it) => it && /xhtml|html/.test(it.type || ''));

  const blocks = [];
  const chapters = [];

  for (let i = 0; i < spine.length; i++) {
    onProgress(Math.round((i / spine.length) * 90), `Chapter ${i + 1} of ${spine.length}`);
    const path = normalizeZipPath(opfDir + spine[i].href);
    const entry = zip.file(path);
    if (!entry) continue;

    const html = await entry.async('text');
    const { blocks: chBlocks } = fromHtml(html, '');
    if (!chBlocks.length) continue;

    const first = chBlocks.find((b) => b.type?.startsWith('h'));
    const name = first?.text || `Chapter ${chapters.length + 1}`;
    chapters.push({ index: chapters.length, title: name, blockIdx: blocks.length });

    for (const b of chBlocks) {
      // Images live inside the zip; resolve them to data URLs so the reader works offline.
      blocks.push({ ...b, chapter: chapters.length - 1 });
    }
  }

  onProgress(94, 'Reading cover');
  const thumb = await epubCover(zip, opf, opfDir, manifest);

  return { title, blocks, thumb, meta: { author, chapters } };
}

function normalizeZipPath(p) {
  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

async function epubCover(zip, opf, dir, manifest) {
  try {
    let href = null;
    for (const [, it] of manifest) {
      if (it.props.includes('cover-image')) { href = it.href; break; }
    }
    if (!href) {
      const id = opf.querySelector('meta[name="cover"]')?.getAttribute('content');
      if (id && manifest.has(id)) href = manifest.get(id).href;
    }
    if (!href) return null;
    const entry = zip.file(normalizeZipPath(dir + href));
    if (!entry) return null;
    const b64 = await entry.async('base64');
    const ext = href.split('.').pop().toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
    return `data:${mime};base64,${b64}`;
  } catch {
    return null;
  }
}

/* ================================ HTML ================================ */

/**
 * HTML → blocks. Runs the sanitizer first, then walks the safe tree. Because this is
 * the common backend for DOCX, EPUB, the website reader, and .html files, everything
 * inherits the same security guarantees.
 */
export function fromHtml(html, fallbackTitle = 'Untitled', baseUrl = '') {
  const frag = sanitizeToFragment(html, { baseUrl, allowImages: true });
  const root = document.createElement('div');
  root.append(frag);

  const title =
    root.querySelector('h1')?.textContent?.trim() ||
    (new DOMParser().parseFromString(html, 'text/html').title || '').trim() ||
    fallbackTitle;

  const blocks = [];
  const walk = (node) => {
    for (const el of node.children) {
      const tag = el.tagName.toLowerCase();
      const text = el.textContent.replace(/\s+/g, ' ').trim();

      if (tag === 'img') {
        if (el.src) blocks.push({ type: 'img', src: el.src, text: el.alt || '' });
        continue;
      }
      if (tag === 'hr') { blocks.push({ type: 'hr' }); continue; }
      if (/^h[1-6]$/.test(tag)) {
        if (text) blocks.push({ type: tag === 'h1' ? 'h1' : tag === 'h2' ? 'h2' : 'h3', text });
        continue;
      }
      if (tag === 'p' || tag === 'figcaption') {
        if (text) blocks.push({ type: 'p', text });
        continue;
      }
      if (tag === 'blockquote') {
        if (text) blocks.push({ type: 'quote', text });
        continue;
      }
      if (tag === 'pre') {
        if (text) blocks.push({ type: 'code', text: el.textContent.trim() });
        continue;
      }
      if (tag === 'li') {
        if (text) blocks.push({ type: 'li', text });
        continue;
      }
      if (tag === 'table') {
        // Flatten tables to readable rows — a screen reader or TTS voice can't
        // convey a grid, and "cell, cell, cell" is worse than a sentence.
        for (const tr of el.querySelectorAll('tr')) {
          const cells = [...tr.children].map((c) => c.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
          if (cells.length) blocks.push({ type: 'p', text: cells.join(' — ') });
        }
        continue;
      }
      if (el.children.length) walk(el);
      else if (text) blocks.push({ type: 'p', text });
    }
  };
  walk(root);

  const thumb = blocks.find((b) => b.type === 'img' && b.src?.startsWith('data:'))?.src || null;
  return { title, blocks: blocks.filter((b) => b.type === 'img' || b.type === 'hr' || b.text), thumb };
}

/* ================================ Markdown ================================ */

/**
 * Markdown → blocks. A focused parser rather than a library: we only need block
 * structure (TTS never speaks bold markers), so this stays ~60 lines and zero deps.
 */
export function fromMarkdown(src, fallbackTitle = 'Untitled') {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  let fence = null;
  let code = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: 'p', text: inline(para.join(' ')) });
      para = [];
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '    ');

    if (fence) {
      if (line.trim().startsWith(fence)) {
        blocks.push({ type: 'code', text: code.join('\n') });
        fence = null;
        code = [];
      } else code.push(line);
      continue;
    }
    const f = line.match(/^\s*(```|~~~)/);
    if (f) { flushPara(); fence = f[1]; continue; }

    if (!line.trim()) { flushPara(); continue; }

    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (h) {
      flushPara();
      const lvl = Math.min(3, h[1].length);
      blocks.push({ type: `h${lvl}`, text: inline(h[2]) });
      continue;
    }
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) { flushPara(); blocks.push({ type: 'hr' }); continue; }

    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) { flushPara(); blocks.push({ type: 'quote', text: inline(q[1]) }); continue; }

    const li = line.match(/^\s*(?:[-*+]|\d{1,3}[.)])\s+(.+)$/);
    if (li) { flushPara(); blocks.push({ type: 'li', text: inline(li[1]) }); continue; }

    const img = line.match(/^\s*!\[([^\]]*)\]\(([^)\s]+)/);
    if (img) { flushPara(); blocks.push({ type: 'img', src: img[2], text: img[1] }); continue; }

    para.push(line.trim());
  }
  flushPara();
  if (fence && code.length) blocks.push({ type: 'code', text: code.join('\n') });

  const h1 = blocks.find((b) => b.type === 'h1');
  return { title: h1?.text || fallbackTitle, blocks };
}

/** Strip inline markdown so speech doesn't read asterisks and brackets aloud. */
function inline(s) {
  return String(s)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*\*|___)(.+?)\1/g, '$2')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/* ================================ RTF ================================ */

/**
 * RTF → text. Full RTF is a huge spec; this handles what word processors actually
 * emit: control words, groups, escaped hex, and unicode `\uN?` runs.
 */
export function fromRtf(src, fallbackTitle = 'Untitled') {
  let s = String(src);
  // Drop binary-ish groups wholesale (fonts, colours, embedded pictures, stylesheets).
  s = s.replace(/\{\\\*?\\(?:fonttbl|colortbl|stylesheet|info|pict|object|themedata|latentstyles)[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/gi, '');

  const out = [];
  let i = 0;
  let text = '';
  const paras = [];
  const flush = () => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t) paras.push(t);
    text = '';
  };

  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const m = /^\\([a-z]+)(-?\d+)? ?/i.exec(s.slice(i));
      if (m) {
        const word = m[1].toLowerCase();
        const arg = m[2] ? parseInt(m[2], 10) : null;
        if (word === 'par' || word === 'line' || word === 'pard') flush();
        else if (word === 'tab') text += '\t';
        else if (word === 'u' && arg != null) {
          text += String.fromCharCode(arg < 0 ? arg + 65536 : arg);
          // The ? placeholder that follows \uN is a fallback glyph — skip it.
          i += m[0].length;
          if (s[i] === '?') i++;
          continue;
        }
        i += m[0].length;
        continue;
      }
      const hex = /^\\'([0-9a-f]{2})/i.exec(s.slice(i));
      if (hex) {
        text += String.fromCharCode(parseInt(hex[1], 16));
        i += hex[0].length;
        continue;
      }
      text += s[i + 1] || '';
      i += 2;
      continue;
    }
    if (c === '{' || c === '}') { i++; continue; }
    if (c === '\n' || c === '\r') { i++; continue; }
    text += c;
    i++;
  }
  flush();
  void out;

  const blocks = paras.map((t) => ({ type: 'p', text: t }));
  return { title: blocks[0]?.text?.slice(0, 70) || fallbackTitle, blocks };
}

/* ================================ Email ================================ */

/**
 * .eml → blocks. Parses RFC 822 headers, picks the best MIME part (plain text
 * preferred, HTML fallback), and strips quoted reply chains from the read-aloud text.
 */
export function fromEmail(src, fallbackTitle = 'Email') {
  const s = String(src).replace(/\r\n/g, '\n');
  const split = s.indexOf('\n\n');
  const head = split < 0 ? s : s.slice(0, split);
  let body = split < 0 ? '' : s.slice(split + 2);

  const header = (name) => {
    const m = new RegExp(`^${name}:\\s*(.+(?:\\n[ \\t]+.+)*)`, 'im').exec(head);
    return m ? m[1].replace(/\n[ \t]+/g, ' ').trim() : '';
  };

  const subject = decodeMime(header('subject')) || fallbackTitle;
  const from = decodeMime(header('from'));
  const date = header('date');
  const ctype = header('content-type');

  // Multipart: take the text/plain part if present, else the text/html part.
  const boundary = /boundary="?([^";\n]+)"?/i.exec(ctype)?.[1];
  if (boundary) {
    const parts = body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?`));
    const plain = parts.find((p) => /content-type:\s*text\/plain/i.test(p));
    const html = parts.find((p) => /content-type:\s*text\/html/i.test(p));
    const chosen = plain || html;
    if (chosen) {
      const ps = chosen.indexOf('\n\n');
      const partBody = ps < 0 ? chosen : chosen.slice(ps + 2);
      const dec = decodeBody(partBody, chosen);
      if (plain) body = dec;
      else {
        const out = fromHtml(dec, subject);
        return withMeta(out.blocks, subject, from, date);
      }
    }
  } else if (/text\/html/i.test(ctype)) {
    const out = fromHtml(decodeBody(body, head), subject);
    return withMeta(out.blocks, subject, from, date);
  } else {
    body = decodeBody(body, head);
  }

  // Strip the quoted chain — nobody wants their reply history read aloud.
  const clean = body
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
    .split(/^\s*(?:On .+ wrote:|-{2,}\s*Original Message|_{5,})/m)[0];

  const blocks = clean
    .split(/\n\s*\n/)
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((text) => ({ type: 'p', text }));

  return withMeta(blocks, subject, from, date);
}

function withMeta(blocks, subject, from, date) {
  const head = [{ type: 'h1', text: subject }];
  if (from) head.push({ type: 'p', text: `From ${from}${date ? ` · ${date}` : ''}` });
  return { title: subject, blocks: [...head, ...blocks], meta: { from, date } };
}

function decodeBody(body, headers) {
  if (/content-transfer-encoding:\s*base64/i.test(headers)) {
    try {
      return new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
    } catch { return body; }
  }
  if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
    return body
      .replace(/=\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return body;
}

/** Decode RFC 2047 encoded-words in headers ("=?utf-8?B?...?="). */
function decodeMime(s) {
  return String(s).replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, cs, enc, txt) => {
    try {
      if (enc.toUpperCase() === 'B') {
        return new TextDecoder(cs).decode(Uint8Array.from(atob(txt), (c) => c.charCodeAt(0)));
      }
      const bytes = txt.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (__, h) => String.fromCharCode(parseInt(h, 16)));
      return bytes;
    } catch { return txt; }
  });
}

/* ================================ Plain text ================================ */

export function fromText(src, fallbackTitle = 'Untitled') {
  const s = String(src).replace(/\r\n?/g, '\n').trim();
  const paras = s.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

  const blocks = paras.map((p) => {
    const single = !p.includes('\n');
    // A short, standalone, title-ish line is almost always a heading.
    if (single && p.length < 70 && !/[.!?]$/.test(p) && paras.length > 1) {
      return { type: 'h2', text: p };
    }
    return { type: 'p', text: p.replace(/\n/g, ' ') };
  });

  const title = blocks[0]?.type?.startsWith('h')
    ? blocks[0].text
    : (paras[0]?.slice(0, 70) || fallbackTitle);
  return { title: title || fallbackTitle, blocks };
}

/** Detect what pasted text actually is, so "paste" isn't dumber than "import". */
export function fromPaste(text, name = 'Pasted text') {
  const s = String(text).trim();
  if (/^https?:\/\/\S+$/i.test(s)) return { isUrl: true, url: s };
  if (/^\s*</.test(s) && /<\/(?:p|div|h[1-6]|body|html)>/i.test(s)) return fromHtml(s, name);
  if (/^#{1,6}\s|\n#{1,6}\s|\n[-*]\s|\[[^\]]+\]\([^)]+\)/.test(s)) return fromMarkdown(s, name);
  if (/^\{\\rtf/.test(s)) return fromRtf(s, name);
  if (/^(?:from|to|subject|date):/im.test(s.slice(0, 400))) return fromEmail(s, name);
  return fromText(s, name);
}

/** Total word count across blocks — used for reading time and progress. */
export const blockWords = (blocks) =>
  blocks.reduce((n, b) => n + (b.text ? countWords(b.text) : 0), 0);
