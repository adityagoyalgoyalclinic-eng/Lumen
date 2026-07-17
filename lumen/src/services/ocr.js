/**
 * OCR via Tesseract (WASM).
 *
 * Runs entirely on-device — no image ever leaves the machine, which matters because
 * people scan receipts, medical letters, and private notes. The trade-off is a ~12 MB
 * engine + language data download on first use; the service worker caches it, so every
 * later scan works offline.
 *
 * We keep per-word confidence and surface it in the editor: OCR that silently
 * hallucinates is worse than OCR that admits doubt.
 */

const TESS_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/+esm';

let workerPromise = null;
let currentLang = null;

/** Languages Tesseract data is published for; label shown in the picker. */
export const OCR_LANGS = [
  { code: 'eng', label: 'English' },
  { code: 'spa', label: 'Spanish' },
  { code: 'fra', label: 'French' },
  { code: 'deu', label: 'German' },
  { code: 'ita', label: 'Italian' },
  { code: 'por', label: 'Portuguese' },
  { code: 'nld', label: 'Dutch' },
  { code: 'rus', label: 'Russian' },
  { code: 'ara', label: 'Arabic' },
  { code: 'hin', label: 'Hindi' },
  { code: 'chi_sim', label: 'Chinese (Simplified)' },
  { code: 'jpn', label: 'Japanese' },
  { code: 'kor', label: 'Korean' },
];

async function getWorker(lang, onProgress) {
  if (workerPromise && currentLang === lang) return workerPromise;
  if (workerPromise) {
    // Language changed — tear the old worker down so we don't leak a WASM heap.
    try { (await workerPromise).terminate(); } catch { /* already gone */ }
  }
  currentLang = lang;
  workerPromise = (async () => {
    let Tesseract;
    try {
      Tesseract = await import(/* @vite-ignore */ TESS_CDN);
    } catch {
      throw new Error(
        navigator.onLine
          ? "Couldn't load the OCR engine. Check your connection and try again."
          : 'OCR needs a one-time engine download. Connect to the internet once, then it works offline.',
      );
    }
    return Tesseract.createWorker(lang, 1, {
      logger: (m) => {
        if (m.status === 'recognizing text') onProgress?.(Math.round(m.progress * 100), 'Reading text');
        else if (m.status?.includes('loading')) onProgress?.(null, 'Preparing OCR engine');
      },
    });
  })();
  return workerPromise;
}

/**
 * OCR an image file.
 * @param {File|Blob} file
 * @param {(pct:number|null, label:string)=>void} [onProgress]
 * @param {{lang?: string, preprocess?: boolean}} [opts]
 * @returns {Promise<{title, blocks, thumb, meta}>}
 */
export async function ocrImage(file, onProgress = () => {}, opts = {}) {
  const lang = opts.lang || 'eng';
  onProgress(2, 'Preparing image');

  const { canvas, dataUrl } = await prepare(file, opts.preprocess !== false);
  const worker = await getWorker(lang, onProgress);

  onProgress(12, 'Reading text');
  const { data } = await worker.recognize(canvas);

  const blocks = toBlocks(data);
  const conf = Math.round(data.confidence || 0);

  return {
    title: firstLine(blocks) || (file.name ? file.name.replace(/\.[^.]+$/, '') : 'Scan'),
    blocks,
    thumb: dataUrl,
    meta: {
      ocr: true,
      confidence: conf,
      lang,
      lowConfidence: countLow(blocks),
    },
  };
}

/**
 * Downscale + preprocess for accuracy.
 *
 * Tesseract wants ~300 DPI-equivalent text; phone photos are both too large (slow) and
 * unevenly lit (inaccurate). We cap the long edge, convert to greyscale, and apply a
 * local-contrast stretch, which reliably lifts accuracy on photos of pages.
 */
async function prepare(file, preprocess) {
  const bitmap = await createImageBitmap(file).catch(async () => {
    // Safari/older engines: fall back through an <img>.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  });

  const MAX = 2200;
  const w = bitmap.width;
  const h = bitmap.height;
  const scale = Math.min(1, MAX / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  if (preprocess) {
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;

    // Greyscale with luminance weights, tracking the histogram as we go.
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      d[i] = d[i + 1] = d[i + 2] = g;
      hist[g]++;
    }
    // Contrast stretch between the 2nd and 98th percentile — ignores specular
    // highlights and shadow corners that would otherwise flatten the range.
    const total = canvas.width * canvas.height;
    let lo = 0;
    let hi = 255;
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * 0.02) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > total * 0.02) { hi = v; break; } }
    const range = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.max(0, Math.min(255, ((d[i] - lo) / range) * 255));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
  }

  // Thumbnail is separate and small — we don't want a 2200px data URL in IndexedDB.
  const tc = document.createElement('canvas');
  const ts = Math.min(1, 420 / Math.max(canvas.width, canvas.height));
  tc.width = Math.round(canvas.width * ts);
  tc.height = Math.round(canvas.height * ts);
  tc.getContext('2d').drawImage(canvas, 0, 0, tc.width, tc.height);

  if (bitmap.close) bitmap.close();
  return { canvas, dataUrl: tc.toDataURL('image/jpeg', 0.7) };
}

/**
 * Tesseract paragraphs → blocks, carrying per-word confidence.
 * A short, high-confidence, title-cased line at the top becomes a heading.
 */
function toBlocks(data) {
  const blocks = [];
  const paras = data.paragraphs?.length
    ? data.paragraphs
    : (data.lines || []).map((l) => ({ text: l.text, words: l.words, confidence: l.confidence }));

  for (const p of paras) {
    const text = String(p.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;

    const wordsConf = (p.words || [])
      .filter((w) => w.text?.trim())
      .map((w) => ({ w: w.text, c: Math.round(w.confidence) }));

    const conf = Math.round(p.confidence ?? avg(wordsConf.map((x) => x.c)));
    const isHead = blocks.length < 2 && text.length < 66 && !/[.!?]$/.test(text) && conf > 78;

    blocks.push({ type: isHead ? 'h2' : 'p', text, conf, wordsConf });
  }
  return blocks;
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const firstLine = (blocks) => blocks.find((b) => b.text)?.text?.slice(0, 70) || '';
const countLow = (blocks) =>
  blocks.reduce((n, b) => n + (b.wordsConf || []).filter((w) => w.c < 75).length, 0);

/**
 * OCR several images as one document (multi-page scan).
 * @param {File[]} files
 */
export async function ocrBatch(files, onProgress = () => {}, opts = {}) {
  const blocks = [];
  let thumb = null;
  let confTotal = 0;

  for (let i = 0; i < files.length; i++) {
    const base = (i / files.length) * 100;
    const span = 100 / files.length;
    const res = await ocrImage(
      files[i],
      (pct, label) => onProgress(Math.round(base + ((pct ?? 0) / 100) * span), `Page ${i + 1}/${files.length} · ${label}`),
      opts,
    );
    if (!thumb) thumb = res.thumb;
    confTotal += res.meta.confidence;
    if (files.length > 1) blocks.push({ type: 'h3', text: `Page ${i + 1}` });
    blocks.push(...res.blocks.map((b) => ({ ...b, page: i + 1 })));
  }

  return {
    title: firstLine(blocks) || 'Scan',
    blocks,
    thumb,
    meta: {
      ocr: true,
      confidence: Math.round(confTotal / files.length),
      pages: files.length,
      lowConfidence: countLow(blocks),
    },
  };
}

/** Release the WASM worker — called when leaving the import screen. */
export async function disposeOcr() {
  if (!workerPromise) return;
  try { (await workerPromise).terminate(); } catch { /* ignore */ }
  workerPromise = null;
  currentLang = null;
}
