/**
 * Runtime documentation for the window.ComicBuilder command API.
 *
 * The JSDoc in src/ai/actions.ts is the single source of truth. At build
 * time, scripts/extract-docs.mjs parses it into src/ai/actions.docs.gen.ts
 * (a dotted-path -> doc-string map). At startup, installComicBuilder calls
 * attachDocs() so every node of the action tree answers `.toString()` with
 * its documentation, and buildHelpText() renders the whole map as the
 * skill-style text returned by ComicBuilder.help().
 */

/** Attach each doc string as the toString() of its action-tree node. */
export function attachDocs(root: unknown, docs: Record<string, string>, rootPath: string): void {
  const seen = new Set<object>();
  function visit(node: unknown, path: string): void {
    if (node === null || node === undefined) return;
    if (typeof node !== 'object' && typeof node !== 'function') return;
    const obj = node as Record<string, unknown>;
    if (seen.has(obj)) return;
    seen.add(obj);
    const doc = docs[path];
    if (doc) {
      Object.defineProperty(obj, 'toString', {
        value: () => doc,
        enumerable: false,
        configurable: true,
      });
    }
    for (const key of Object.keys(obj)) {
      if (key === 'toString') continue;
      visit(obj[key], path ? `${path}.${key}` : key);
    }
  }
  visit(root, rootPath);
}

/**
 * Render the extracted docs as the skill-style help text for
 * ComicBuilder.help(). Conventions first, then one section per namespace.
 */
export function buildHelpText(docs: Record<string, string>, rootPath: string): string {
  const lines: string[] = [];
  lines.push(`${rootPath} — AI command API for Comic Builder.`);
  const rootDoc = docs[rootPath];
  if (rootDoc) lines.push('', rootDoc);
  lines.push(
    '',
    'Conventions (read before acting):',
    '- The first Drive connect needs a REAL HUMAN CLICK on the connect',
    '  button: ComicBuilder.storage.connect() starts the OAuth flow but',
    '  browsers block popups from injected scripts, so an agent cannot',
    '  complete it alone. Ask the user to click.',
    '- Reads (page.select, layers.list, characters.get, …) return deep-cloned',
    '  snapshots: inspect them freely, but mutating a snapshot changes',
    '  nothing. All writes go through the action functions.',
    '- A panel has no separate background field: the background is the layer',
    '  whose kind is "background" (conventionally the first layer).',
    '- Bubbles render above all layers.',
    '- Every mutation autosaves: project.json is written to Drive ~2s after',
    '  the last change. storage.save() flushes immediately.',
    '- Drive file scope is drive.file: the app only sees folders and files',
    '  IT created. listProjects() is the complete project list.',
    '- MediaItem.url values need a valid Drive access token to fetch bytes;',
    '  hand them to <img> or image models, never guess URLs.',
    ''
  );

  // Group doc paths by top-level namespace, preserving insertion order.
  const groups = new Map<string, string[]>();
  for (const path of Object.keys(docs)) {
    if (path === rootPath) continue;
    const rel = path.startsWith(`${rootPath}.`) ? path.slice(rootPath.length + 1) : path;
    const top = rel.split('.')[0] ?? rel;
    const list = groups.get(top);
    if (list) list.push(path);
    else groups.set(top, [path]);
  }

  for (const [ns, paths] of groups) {
    const nsDoc = docs[`${rootPath}.${ns}`];
    lines.push(`## ${ns}${nsDoc ? ` — ${firstLine(nsDoc)}` : ''}`, '');
    const sorted = [...paths].sort((a, b) => a.length - b.length);
    for (const p of sorted) {
      if (p === `${rootPath}.${ns}`) continue;
      const rel = p.slice(rootPath.length + 1);
      const doc = docs[p] ?? '';
      lines.push(`### ${rootPath}.${rel}()`, '', doc, '');
    }
  }
  return lines.join('\n').trimEnd();
}

function firstLine(doc: string): string {
  const i = doc.indexOf('\n');
  return (i < 0 ? doc : doc.slice(0, i)).trim();
}
