/**
 * Minimal static server for local development.
 *
 * Lumen ships as plain ES modules with no build step, but it still can't run from
 * file:// — modules, the service worker, and IndexedDB all need a real origin. This
 * serves the folder over http://localhost with the correct MIME types and no caching,
 * which is all the app needs to run exactly as it would in production.
 *
 *   node server.mjs [port]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2]) || 4321;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';

  // Contain path traversal: resolve, then verify the result is still inside ROOT.
  const filePath = path.join(ROOT, rel);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      // Always fresh in development, so a reload really reloads.
      'cache-control': 'no-store',
      'service-worker-allowed': '/',
    });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`Lumen running at http://localhost:${PORT}`);
});
