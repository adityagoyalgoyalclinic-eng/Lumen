/**
 * HTML sanitizer.
 *
 * Lumen renders HTML that came from files the user imported and pages fetched from
 * the open web, so this module is a hard security boundary. Design rules:
 *
 *  1. Allowlist only. Anything not explicitly permitted is dropped. A blocklist would
 *     be a losing game against mutation XSS and new elements.
 *  2. Parse with DOMParser into an inert document. It has no browsing context, so
 *     scripts never execute and `img` never fetches during parsing.
 *  3. Strip every `on*` attribute and every URL scheme other than http/https/mailto/data:image.
 *  4. Never trust `element.innerHTML` round-trips — we rebuild by walking nodes.
 */

const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'div', 'span', 'section', 'article', 'main', 'header', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'blockquote', 'q', 'cite', 'pre', 'code', 'kbd', 'samp', 'var',
  'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'small', 'mark', 'abbr', 'time',
  'a', 'img', 'figure', 'figcaption', 'picture', 'source',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
]);

/** Attributes permitted per tag. `*` applies to every allowed tag. */
const ALLOWED_ATTRS = {
  '*': ['title', 'lang', 'dir'],
  a: ['href'],
  img: ['src', 'alt', 'width', 'height', 'loading'],
  source: ['srcset', 'type'],
  time: ['datetime'],
  abbr: ['title'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
  col: ['span'],
  colgroup: ['span'],
  ol: ['start', 'reversed'],
};

/** Elements removed together with all their descendants. */
const NUKE = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'link', 'meta', 'base', 'form', 'input', 'button', 'select', 'textarea', 'option',
  'noscript', 'template', 'svg', 'math', 'audio', 'video', 'track', 'canvas', 'dialog',
]);

const SAFE_SCHEME = /^(?:https?:|mailto:|tel:)/i;
const SAFE_DATA_IMG = /^data:image\/(?:png|jpeg|jpg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i;

/**
 * Sanitize an HTML string into a safe DocumentFragment.
 * @param {string} html
 * @param {{baseUrl?: string, allowImages?: boolean}} [opts]
 *   baseUrl resolves relative hrefs/srcs; allowImages=false strips images entirely.
 * @returns {DocumentFragment}
 */
export function sanitizeToFragment(html, opts = {}) {
  const { baseUrl = '', allowImages = true } = opts;
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');

  for (const el of [...doc.querySelectorAll([...NUKE].join(','))]) el.remove();

  const frag = document.createDocumentFragment();
  for (const node of [...doc.body.childNodes]) {
    const clean = cleanNode(node, { baseUrl, allowImages });
    if (clean) frag.append(clean);
  }
  return frag;
}

/** Sanitize and return an HTML string (for storage). */
export function sanitizeHtml(html, opts) {
  const box = document.createElement('div');
  box.append(sanitizeToFragment(html, opts));
  return box.innerHTML;
}

function cleanNode(node, ctx) {
  if (node.nodeType === Node.TEXT_NODE) {
    return document.createTextNode(node.nodeValue);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;

  const tag = node.tagName.toLowerCase();
  if (NUKE.has(tag)) return null;

  // Not on the allowlist: drop the element but keep its text content, so stripping
  // an unknown wrapper never silently deletes the article body.
  if (!ALLOWED_TAGS.has(tag)) {
    const frag = document.createDocumentFragment();
    for (const kid of [...node.childNodes]) {
      const c = cleanNode(kid, ctx);
      if (c) frag.append(c);
    }
    return frag.childNodes.length ? frag : null;
  }

  if (tag === 'img' && !ctx.allowImages) return null;

  const out = document.createElement(tag);
  const allowed = new Set([...(ALLOWED_ATTRS['*'] || []), ...(ALLOWED_ATTRS[tag] || [])]);

  for (const attr of [...node.attributes]) {
    const name = attr.name.toLowerCase();
    // Belt and braces: on* handlers can never survive, allowlist or not.
    if (name.startsWith('on') || name === 'srcdoc' || name === 'style') continue;
    if (!allowed.has(name)) continue;

    let value = attr.value;
    if (name === 'href' || name === 'src') {
      value = safeUrl(value, ctx.baseUrl, name === 'src');
      if (!value) continue;
    }
    if (name === 'srcset') {
      value = value
        .split(',')
        .map((part) => {
          const [u, d] = part.trim().split(/\s+/);
          const safe = safeUrl(u, ctx.baseUrl, true);
          return safe ? [safe, d].filter(Boolean).join(' ') : null;
        })
        .filter(Boolean)
        .join(', ');
      if (!value) continue;
    }
    try {
      out.setAttribute(name, value);
    } catch { /* invalid attribute name for this element — skip */ }
  }

  if (tag === 'a') {
    // Any link we render opens outside the app; deny the opener to prevent
    // reverse tabnabbing, and mark it so the reader can badge external links.
    out.setAttribute('rel', 'noopener noreferrer nofollow ugc');
    out.setAttribute('target', '_blank');
  }
  if (tag === 'img') {
    out.setAttribute('loading', 'lazy');
    out.setAttribute('decoding', 'async');
    out.setAttribute('referrerpolicy', 'no-referrer');
    if (!out.getAttribute('alt')) out.setAttribute('alt', '');
  }

  for (const kid of [...node.childNodes]) {
    const c = cleanNode(kid, ctx);
    if (c) out.append(c);
  }
  return out;
}

/**
 * Resolve and validate a URL.
 * @returns {string|null} A safe absolute URL, or null if the scheme is not permitted.
 */
function safeUrl(raw, baseUrl, isImage) {
  const v = String(raw || '').trim();
  if (!v) return null;

  // Strip control characters — "java\x01script:" is a classic filter bypass.
  const flat = v.replace(/[\x00-\x20\x7F-\xA0​-‍﻿]/g, '');

  if (isImage && SAFE_DATA_IMG.test(flat)) return flat;
  if (/^(?:javascript|data|vbscript|blob|file):/i.test(flat)) return null;

  if (SAFE_SCHEME.test(flat)) return flat;
  if (flat.startsWith('#')) return flat;

  if (baseUrl) {
    try {
      const u = new URL(flat, baseUrl);
      return SAFE_SCHEME.test(u.protocol) ? u.href : null;
    } catch {
      return null;
    }
  }
  // Relative URL with no base to resolve against is meaningless here.
  return null;
}

/**
 * Validate an imported file before we spend memory parsing it.
 * @param {File} file
 * @param {{maxBytes?: number}} [opts]
 * @returns {{ok: true, kind: string} | {ok: false, reason: string}}
 */
export function validateFile(file, opts = {}) {
  const maxBytes = opts.maxBytes ?? 200 * 1024 * 1024;
  if (!file || typeof file.name !== 'string') return { ok: false, reason: 'Not a file.' };
  if (file.size === 0) return { ok: false, reason: 'File is empty.' };
  if (file.size > maxBytes) {
    return { ok: false, reason: `File is ${fmtBytes(file.size)}; the limit is ${fmtBytes(maxBytes)}.` };
  }

  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  const kind = KIND_BY_EXT[ext];
  if (!kind) {
    return { ok: false, reason: `Lumen can't read .${ext} files yet.` };
  }
  return { ok: true, kind };
}

const KIND_BY_EXT = {
  pdf: 'pdf',
  docx: 'docx',
  epub: 'epub',
  txt: 'txt',
  text: 'txt',
  md: 'md',
  markdown: 'md',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  rtf: 'rtf',
  eml: 'email',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  bmp: 'image',
  avif: 'image',
  tif: 'image',
  tiff: 'image',
};

export const kindForExt = (ext) => KIND_BY_EXT[String(ext).toLowerCase()] || null;

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

/**
 * Sniff real file type from magic bytes. Extensions lie; this catches a renamed
 * executable before a parser touches it.
 * @param {File} file
 * @returns {Promise<string|null>} detected kind, or null if unrecognised
 */
export async function sniffKind(file) {
  const buf = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const hex = [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ascii = String.fromCharCode(...buf);

  if (ascii.startsWith('%PDF-')) return 'pdf';
  if (hex.startsWith('504b0304')) return 'zip'; // docx and epub are both zip containers
  if (ascii.startsWith('{\\rtf')) return 'rtf';
  if (hex.startsWith('89504e47')) return 'image';
  if (hex.startsWith('ffd8ff')) return 'image';
  if (ascii.startsWith('GIF8')) return 'image';
  if (ascii.slice(0, 4) === 'RIFF' && ascii.slice(8, 12) === 'WEBP') return 'image';
  if (hex.startsWith('4d4d002a') || hex.startsWith('49492a00')) return 'image';
  // Windows PE / ELF / Mach-O — never legitimate here.
  if (ascii.startsWith('MZ') || hex.startsWith('7f454c46') || hex.startsWith('cffaedfe')) {
    return 'executable';
  }
  return null;
}
