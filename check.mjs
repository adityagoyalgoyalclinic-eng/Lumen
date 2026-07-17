/**
 * Build-time sanity checks. Run with: node check.mjs
 * Verifies that every relative import resolves and that every named import actually
 * exists in the target module — the two failure modes a framework-free ESM app hits.
 */
import fs from 'node:fs';
import path from 'node:path';

const files = new Set();
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.js')) files.add(p.split(path.sep).join('/'));
  }
})('src');

let errors = 0;

// 1. Every relative import points at a file that exists.
const edges = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  // Static `from '...'` and dynamic `import('...')`, but not across newlines or
  // through the /* @vite-ignore */ comments in extract.js.
  const re = /(?:from\s*|import\s*\(\s*)['"](\.[^'"\n]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
    edges.push({ from: f, spec: m[1], target });
    if (!files.has(target)) {
      console.log(`BROKEN IMPORT  ${f} -> ${m[1]}`);
      errors++;
    }
  }
}

// 2. Every named import exists as a named export in the target.
const exportsOf = new Map();
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/g)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  exportsOf.set(f, names);
}

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const re = /import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[2]));
    const have = exportsOf.get(target);
    if (!have) continue;
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (!have.has(name)) {
        console.log(`MISSING EXPORT  ${f} imports { ${name} } from ${m[2]} — not exported there`);
        errors++;
      }
    }
  }
}

// 3. Service worker shell list matches the files that actually exist.
const sw = fs.readFileSync('sw.js', 'utf8');
for (const m of sw.matchAll(/'\.\/(src\/[^']+\.js)'/g)) {
  if (!fs.existsSync(m[1])) {
    console.log(`SW PRECACHE  lists ${m[1]} which does not exist`);
    errors++;
  }
}
for (const f of files) {
  if (!sw.includes(`./${f}`)) {
    console.log(`SW PRECACHE  missing ${f}`);
    errors++;
  }
}

console.log(errors ? `\n${errors} problem(s) found` : '\nAll checks passed.');
process.exit(errors ? 1 : 0);
