/**
 * Website reader — fetch a URL and recover just the article.
 *
 * The scoring model is a content-density approach in the lineage of Readability:
 * paragraphs vote for their parent, weighted by text length and comma count (a proxy
 * for real prose); containers whose class/id look like chrome ("sidebar", "promo",
 * "comments") are penalised; the highest-scoring container wins, plus any sibling that
 * scores close to it (multi-column articles).
 *
 * CORS is the real-world obstacle: most sites don't send Access-Control-Allow-Origin,
 * so a browser fetch fails. We try direct first, then any user-configured proxy, and
 * if both fail we say so plainly and offer paste-instead rather than silently failing.
 */

import { fromHtml } from './extract.js';
import { readability } from '../util/text.js';

const JUNK_RE = /(^|[\s_-])(ad|ads|advert|advertisement|banner|promo|sponsor|share|social|share-bar|comment|comments|disqus|reply|related|recommend|popular|trending|newsletter|subscribe|signup|paywall|modal|popup|cookie|consent|gdpr|nav|navbar|navigation|menu|breadcrumb|sidebar|side-bar|aside|widget|footer|header|masthead|toolbar|utility|meta|byline-social|tags|taxonomy|pagination|pager|skip|hidden|offscreen|sr-only|print|legal|disclaimer|copyright|author-box|more-from|read-next|infinite|outbrain|taboola|zergnet)([\s_-]|$)/i;

const GOOD_RE = /(^|[\s_-])(article|articlebody|article-body|story|story-body|storybody|post|post-body|postbody|entry|entry-content|content|main-content|maincontent|body-content|blog-post|page-content|text|prose|rich-text|markdown)([\s_-]|$)/i;

const STRIP_TAGS = 'script,style,noscript,iframe,form,button,input,select,textarea,svg,canvas,video,audio,nav,aside,footer,header,dialog,template';

/**
 * Fetch and extract an article.
 * @param {string} url
 * @param {{proxy?: string, signal?: AbortSignal}} [opts]
 * @returns {Promise<{title, blocks, thumb, meta}>}
 */
export async function fetchArticle(url, opts = {}) {
  const target = normalizeUrl(url);
  const html = await fetchHtml(target, opts);
  return extractArticle(html, target);
}

function normalizeUrl(raw) {
  let s = String(raw).trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https links can be read.');
  // Drop tracking noise so the same article doesn't import twice under two URLs.
  for (const k of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|mc_|ref|ref_src|igshid|si)$/i.test(k) || /^utm/i.test(k)) {
      u.searchParams.delete(k);
    }
  }
  return u.href;
}

async function fetchHtml(url, { proxy = '', signal } = {}) {
  const attempts = [];
  attempts.push({ label: 'direct', url });
  if (proxy) {
    attempts.push({ label: 'proxy', url: proxy.includes('{url}') ? proxy.replace('{url}', encodeURIComponent(url)) : proxy + encodeURIComponent(url) });
  }

  let lastErr = null;
  for (const a of attempts) {
    try {
      const res = await fetch(a.url, {
        signal,
        redirect: 'follow',
        credentials: 'omit', // never send the user's cookies to a third-party site
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
      if (!res.ok) throw new Error(`The site returned ${res.status} ${res.statusText}.`);
      const type = res.headers.get('content-type') || '';
      if (!/text\/html|application\/xhtml|text\/plain/i.test(type)) {
        throw new Error(`That link is ${type.split(';')[0] || 'not a web page'}, not an article.`);
      }
      const text = await res.text();
      if (!text.trim()) throw new Error('The page came back empty.');
      return text;
    } catch (err) {
      lastErr = err;
      if (err.name === 'AbortError') throw err;
    }
  }

  const isCors = lastErr instanceof TypeError || /fetch/i.test(lastErr?.message || '');
  throw new Error(
    isCors
      ? "This site blocks other apps from reading it directly (CORS). Set a reader proxy in Settings → Privacy, or copy the article text and use Paste instead."
      : lastErr?.message || 'Could not load that page.',
  );
}

/**
 * Extract the article from an HTML string.
 * @param {string} html
 * @param {string} baseUrl
 */
export function extractArticle(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const meta = readMeta(doc, baseUrl);

  for (const el of [...doc.querySelectorAll(STRIP_TAGS)]) el.remove();
  for (const el of [...doc.querySelectorAll('[aria-hidden="true"], [hidden], [role="navigation"], [role="banner"], [role="complementary"], [role="contentinfo"], [role="search"], [role="dialog"]')]) {
    el.remove();
  }
  // Elements that are obviously chrome by name.
  for (const el of [...doc.querySelectorAll('[class],[id]')]) {
    const sig = `${el.className || ''} ${el.id || ''}`;
    if (typeof el.className !== 'string') continue;
    if (JUNK_RE.test(sig) && !GOOD_RE.test(sig)) {
      // Keep it if it is or contains the bulk of the text — some sites really do
      // name the article container "main-header-content".
      if (el.textContent.trim().length < doc.body.textContent.trim().length * 0.45) el.remove();
    }
  }

  let root =
    doc.querySelector('article') ||
    doc.querySelector('[itemprop="articleBody"]') ||
    doc.querySelector('main') ||
    scoreBest(doc) ||
    doc.body;

  // <article> can still be a card in a list; if it's tiny, fall back to scoring.
  if (root.textContent.trim().length < 260) root = scoreBest(doc) || doc.body;

  cleanInside(root);

  const out = fromHtml(root.innerHTML, meta.title || 'Article', baseUrl);
  let blocks = out.blocks;

  // Drop a leading duplicate of the title, and any leftover one-word rubble.
  if (blocks[0]?.text && meta.title && sameish(blocks[0].text, meta.title)) blocks = blocks.slice(1);
  blocks = blocks.filter((b) => b.type !== 'p' || (b.text && b.text.length > 2));

  if (!blocks.some((b) => b.text?.length > 40)) {
    throw new Error("Couldn't find an article on that page. It may be a listing page, or need JavaScript to render.");
  }

  const title = meta.title || out.title;
  const text = blocks.map((b) => b.text || '').join(' ');
  const words = text.split(/\s+/).filter(Boolean).length;

  return {
    title,
    blocks: [{ type: 'h1', text: title }, ...blocks],
    thumb: meta.image || out.thumb,
    meta: {
      ...meta,
      words,
      readability: readability(text),
    },
  };
}

function readMeta(doc, baseUrl) {
  const pick = (...sels) => {
    for (const s of sels) {
      const el = doc.querySelector(s);
      const v = el?.getAttribute('content') || el?.textContent;
      if (v && v.trim()) return v.trim();
    }
    return '';
  };
  let image = pick('meta[property="og:image"]', 'meta[name="twitter:image"]', 'link[rel="image_src"]');
  if (image) {
    try { image = new URL(image, baseUrl).href; } catch { image = ''; }
    if (!/^https?:/i.test(image)) image = '';
  }
  let site = pick('meta[property="og:site_name"]');
  if (!site) { try { site = new URL(baseUrl).hostname.replace(/^www\./, ''); } catch { /* ignore */ } }

  return {
    title: pick('meta[property="og:title"]', 'meta[name="twitter:title"]', 'h1', 'title'),
    author: pick('meta[name="author"]', 'meta[property="article:author"]', '[rel="author"]', '.byline'),
    published: pick('meta[property="article:published_time"]', 'time[datetime]'),
    excerpt: pick('meta[name="description"]', 'meta[property="og:description"]'),
    site,
    url: baseUrl,
    image,
  };
}

/** Content-density scoring: paragraphs vote for their ancestors. */
function scoreBest(doc) {
  const scores = new Map();
  const bump = (el, n) => el && scores.set(el, (scores.get(el) || 0) + n);

  for (const p of doc.querySelectorAll('p,pre,blockquote,li')) {
    const text = p.textContent.trim();
    if (text.length < 25) continue;

    // Base score: length (capped) + commas, which distinguish prose from link lists.
    let s = 1 + Math.min(Math.floor(text.length / 100), 3) + (text.match(/[,，、]/g) || []).length;

    // Link density: a "paragraph" that is mostly links is navigation.
    const linkLen = [...p.querySelectorAll('a')].reduce((n, a) => n + a.textContent.length, 0);
    if (linkLen / text.length > 0.5) s -= 4;

    bump(p.parentElement, s);
    bump(p.parentElement?.parentElement, s / 2);
    bump(p.parentElement?.parentElement?.parentElement, s / 4);
  }

  let best = null;
  let bestScore = 0;
  for (const [el, raw] of scores) {
    const sig = `${typeof el.className === 'string' ? el.className : ''} ${el.id || ''}`;
    let s = raw;
    if (GOOD_RE.test(sig)) s *= 1.6;
    if (JUNK_RE.test(sig)) s *= 0.25;
    if (el.tagName === 'ARTICLE' || el.tagName === 'MAIN') s *= 1.4;
    // Penalise containers that are mostly links overall.
    const total = el.textContent.length || 1;
    const links = [...el.querySelectorAll('a')].reduce((n, a) => n + a.textContent.length, 0);
    s *= 1 - Math.min(0.85, links / total);

    if (s > bestScore) { bestScore = s; best = el; }
  }
  return best;
}

/** Remove junk that survived inside the chosen container. */
function cleanInside(root) {
  for (const el of [...root.querySelectorAll('*')]) {
    if (!el.isConnected) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === 'img' || tag === 'br' || tag === 'hr') continue;

    const sig = `${typeof el.className === 'string' ? el.className : ''} ${el.id || ''}`;
    if (JUNK_RE.test(sig) && !GOOD_RE.test(sig)) { el.remove(); continue; }

    // Empty containers left behind by stripping.
    if (!el.textContent.trim() && !el.querySelector('img')) { el.remove(); continue; }

    // Link-farm divs: lots of links, little prose.
    if (/^(div|section|ul|ol)$/.test(tag)) {
      const text = el.textContent.trim();
      const links = [...el.querySelectorAll('a')];
      if (links.length >= 4 && text.length) {
        const linkLen = links.reduce((n, a) => n + a.textContent.length, 0);
        if (linkLen / text.length > 0.7 && !el.querySelector('p')) el.remove();
      }
    }
  }

  // Tiny tracking pixels and spacer gifs.
  for (const img of [...root.querySelectorAll('img')]) {
    const w = parseInt(img.getAttribute('width') || '0', 10);
    const hgt = parseInt(img.getAttribute('height') || '0', 10);
    if ((w && w < 50) || (hgt && hgt < 50)) img.remove();
    // Lazy-loaded images keep the real URL in a data attribute.
    const lazy = img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-lazy-src');
    if (lazy && !img.getAttribute('src')) img.setAttribute('src', lazy);
  }
}

const sameish = (a, b) =>
  a.replace(/\W+/g, '').toLowerCase().slice(0, 60) === b.replace(/\W+/g, '').toLowerCase().slice(0, 60);
