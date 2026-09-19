/**
 * Extract JSDoc from the `ComicBuilder` object literal in src/ai/actions.ts
 * and generate:
 *   - src/ai/actions.docs.gen.ts — ACTION_DOCS: dotted-path -> doc string,
 *     imported by actions.ts for runtime toString()/help().
 *   - public/llms.txt — the skill-style reference for AI agents.
 *
 * JSDoc in actions.ts is the single source of truth. Run before tsc/vite:
 *   node scripts/extract-docs.mjs
 *
 * Fails loudly (exit 1) when actions.ts cannot be parsed, so docs never go
 * silently stale. Nodes without JSDoc are reported on stderr but do not fail.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ACTIONS_TS = path.join(ROOT, 'src', 'ai', 'actions.ts');
const GEN_TS = path.join(ROOT, 'src', 'ai', 'actions.docs.gen.ts');
const LLMS_TXT = path.join(ROOT, 'public', 'llms.txt');

// Load the repo's own typescript package (devDependency).
const require = createRequire(path.join(ROOT, 'package.json'));
const ts = require('typescript');

function commentText(comment) {
  if (!comment) return '';
  if (typeof comment === 'string') return comment;
  return comment.map((p) => (typeof p === 'string' ? p : p.text || '')).join('');
}

/** @returns {description, params: [[name, desc]], returns} */
function readJsDoc(node) {
  const jsDocs = node.jsDoc || [];
  const out = { description: '', params: [], returns: '' };
  for (const doc of jsDocs) {
    const desc = commentText(doc.comment).trim();
    if (desc) out.description += (out.description ? '\n' : '') + desc;
    for (const tag of doc.tags || []) {
      const tagName = tag.tagName && tag.tagName.text;
      if (tagName === 'param') {
        const name = tag.name ? tag.name.getText() : '';
        out.params.push([name, commentText(tag.comment).trim()]);
      } else if (tagName === 'returns' || tagName === 'return') {
        out.returns = commentText(tag.comment).trim();
      }
    }
  }
  return out;
}

function formatDoc({ description, params, returns }) {
  let out = (description || '').trim();
  if (params.length > 0) {
    out += '\n\nParameters:';
    for (const [name, desc] of params) {
      out += `\n  * ${name}: ${desc}`;
    }
  }
  if (returns) out += `\n\nReturns: ${returns}`;
  return out;
}

function propName(nameNode) {
  if (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode)) {
    return nameNode.text;
  }
  return null;
}

function main() {
  const source = fs.readFileSync(ACTIONS_TS, 'utf8');
  const sf = ts.createSourceFile('actions.ts', source, ts.ScriptTarget.ESNext, true);

  // Find `const ComicBuilder = { ... }` anywhere in the file.
  let rootLiteral = null;
  function find(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'ComicBuilder' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      rootLiteral = node.initializer;
      return;
    }
    ts.forEachChild(node, find);
  }
  find(sf);

  if (!rootLiteral) {
    console.error('extract-docs: no `const ComicBuilder = {...}` found in src/ai/actions.ts');
    process.exit(1);
  }

  /** @type {Map<string,string>} */
  const docs = new Map();
  const missing = [];

  function visit(objLiteral, path) {
    for (const member of objLiteral.properties) {
      let name = null;
      let value = null;
      let docNode = member;
      if (ts.isPropertyAssignment(member)) {
        name = propName(member.name);
        value = member.initializer;
      } else if (ts.isMethodDeclaration(member)) {
        name = propName(member.name);
        value = null; // leaf
      } else if (ts.isShorthandPropertyAssignment(member)) {
        name = member.name.text;
        value = null;
      } else if (ts.isGetAccessorDeclaration(member)) {
        name = propName(member.name);
        value = null;
      } else {
        continue;
      }
      if (!name) continue;
      const childPath = path ? `${path}.${name}` : name;
      const jd = readJsDoc(docNode);
      const formatted = formatDoc(jd);
      if (!jd.description) missing.push(childPath);
      docs.set(childPath, formatted);
      if (value && ts.isObjectLiteralExpression(value)) {
        visit(value, childPath);
      }
    }
  }

  // Root doc comes from the JSDoc above `const ComicBuilder`.
  let rootDecl = null;
  function findDecl(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'ComicBuilder'
    ) {
      rootDecl = node;
      return;
    }
    ts.forEachChild(node, findDecl);
  }
  findDecl(sf);
  const rootJd = rootDecl ? readJsDoc(rootDecl) : { description: '', params: [], returns: '' };
  docs.set('ComicBuilder', formatDoc(rootJd));

  visit(rootLiteral, 'ComicBuilder');

  for (const p of missing) {
    console.error(`extract-docs: warning: no JSDoc on ${p}`);
  }

  // --- write actions.docs.gen.ts ---
  const genTs =
    '// GENERATED by scripts/extract-docs.mjs — do not edit by hand.\n' +
    '// Source of truth: JSDoc in src/ai/actions.ts.\n' +
    `export const ACTION_DOCS: Record<string, string> = ${JSON.stringify(
      Object.fromEntries(docs),
      null,
      2
    )};\n`;
  fs.writeFileSync(GEN_TS, genTs);
  console.log(`extract-docs: wrote ${GEN_TS} (${docs.size} entries)`);

  // --- write public/llms.txt ---
  const lines = [];
  lines.push('# ComicBuilder — AI command API for Comic Builder', '');
  const rootDesc = rootJd.description || 'Command API for Comic Builder.';
  lines.push(`> ${rootDesc.split('\n').join('\n> ')}`, '');
  lines.push(
    'The app exposes this API on `window.ComicBuilder` once it has loaded.',
    'Every UI control calls the same functions — one code path, no drift.',
    'In the browser console (or via automation), start with `ComicBuilder.help()`.',
    '',
    '## Conventions — read before acting',
    '',
    '- The first Drive connect needs a REAL HUMAN CLICK on the connect button:',
    '  `ComicBuilder.storage.connect()` starts the OAuth flow but browsers block',
    '  popups from injected scripts, so an agent cannot complete it alone.',
    '- Reads (`page.select`, `layers.list`, `characters.get`, …) return deep-cloned',
    '  snapshots: inspect them freely, but mutating a snapshot changes nothing.',
    '  All writes go through the action functions.',
    '- A panel has no separate background field: the background is the layer',
    '  whose `kind` is `"background"` (conventionally the first layer).',
    '- Bubbles always render above all layers.',
    '- Every mutation autosaves: `project.json` is written to Drive ~2s after the',
    '  last change. `storage.save()` flushes immediately.',
    '- Drive scope is `drive.file`: the app only sees folders and files IT created.',
    '  `storage.listProjects()` is the complete project list.',
    '- `media.url` values need a valid Drive access token to fetch bytes; hand them',
    '  to `<img>` or image models, never invent URLs.',
    ''
  );

  // Group by top-level namespace, in source order.
  const groups = new Map();
  for (const p of docs.keys()) {
    if (p === 'ComicBuilder') continue;
    const rel = p.slice('ComicBuilder.'.length);
    const top = rel.split('.')[0];
    if (!groups.has(top)) groups.set(top, []);
    groups.get(top).push(p);
  }
  for (const [ns, paths] of groups) {
    const nsDoc = docs.get(`ComicBuilder.${ns}`) || '';
    const firstLine = nsDoc.split('\n')[0];
    lines.push(`## ${ns}${firstLine ? ` — ${firstLine}` : ''}`, '');
    const sorted = [...paths].sort((a, b) => a.length - b.length);
    for (const p of sorted) {
      if (p === `ComicBuilder.${ns}`) continue;
      lines.push(`### ${p}()`, '', docs.get(p) || '', '');
    }
  }
  lines.push(
    '## Data model',
    '',
    '- `ComicProject`: `{ id, title, pages[], updatedAt, savedAt, metadata }`',
    '- `ComicPage`: `{ id, number, title, panels[] }` — `number` is 0-based, shown as 00, 01, …',
    '- `Panel`: `{ id, title?, layers[], bubbles[] }`',
    '- `Layer`: `{ id, name, kind: "background" | "foreground", src, driveFileId?, mediaId?, visible, x, y, width, rotation, opacity }` — `x`/`y`/`width` are % of panel size; aspect ratio preserved, never stretched',
    '- `Bubble`: `{ id, kind: "speech" | "thought" | "caption", text, x, y, width, tailX?, tailY? }`',
    '- `ProjectMetadata`: `{ outline, characters[], scenes[], objects[], media[] }`',
    '- `Character` / `ComicObject`: `{ id, name, description, imageIds[], sceneIds[] }`',
    '- `Scene`: `{ id, name, description, characterIds[], imageIds[] }`',
    '- `MediaItem`: `{ id, name, driveFileId, url, mimeType }`',
    '',
    'Machine-readable schema: `schema/comic-project.schema.json` (JSON Schema, draft 2020-12).',
    '',
    '## Key URLs (relative to the app root)',
    '',
    'The app is served under `/comics-builder/` on GitHub Pages:',
    '',
    '- `/comics-builder/` — the app',
    '- `/comics-builder/llms.txt` — this file',
    '- `/comics-builder/schema/comic-project.schema.json` — JSON Schema of the project model',
    ''
  );
  fs.writeFileSync(LLMS_TXT, lines.join('\n'));
  console.log(`extract-docs: wrote ${LLMS_TXT}`);
}

main();
