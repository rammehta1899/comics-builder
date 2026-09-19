/**
 * Post-Vite build step for the service worker + build metadata.
 *
 *   node scripts/build-meta.mjs
 *
 * 1. Bundles src/sw.ts -> dist/sw.js with esbuild (minified IIFE).
 * 2. Writes dist/buildinfo.js as `self.BUILD_INFO = { commit, builtAt, files }`
 *    where commit comes from `git rev-parse HEAD` and files is the recursive
 *    dist file list (relative paths). The service worker fetches buildinfo.js
 *    with `cache: no-store` on every navigation: when the commit differs from
 *    the cached copy it re-downloads every file and notifies clients.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const require = createRequire(path.join(ROOT, 'package.json'));
const esbuild = require('esbuild');

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT }).toString().trim();
  } catch {
    return 'unknown';
  }
}

function listFiles(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listFiles(path.join(dir, entry.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

async function main() {
  if (!fs.existsSync(DIST)) {
    throw new Error('dist/ does not exist — run vite build first.');
  }

  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'sw.ts')],
    bundle: true,
    minify: true,
    format: 'iife',
    target: 'es2020',
    outfile: path.join(DIST, 'sw.js'),
    logLevel: 'warning',
  });
  console.log('build-meta: bundled src/sw.ts -> dist/sw.js');

  // List files AFTER bundling sw.js so it is included; buildinfo.js itself
  // is written after the listing and cached explicitly by the worker.
  const files = listFiles(DIST)
    .filter((f) => f !== 'buildinfo.js')
    .sort();
  const info = {
    commit: git(['rev-parse', 'HEAD']),
    builtAt: new Date().toISOString(),
    files,
  };
  fs.writeFileSync(path.join(DIST, 'buildinfo.js'), `self.BUILD_INFO=${JSON.stringify(info)};\n`);
  console.log(
    `build-meta: wrote dist/buildinfo.js (${files.length} files, commit ${info.commit.slice(0, 8)})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
