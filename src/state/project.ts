import type { Character, ComicObject, ComicProject, MediaItem, Scene } from '../types/comic';
import { blankMetadata } from '../types/comic';

/**
 * Project loading sources. The builder is generic: it renders whatever
 * ComicProject JSON it is given — nothing is hardcoded to any one comic.
 * Google Drive is the only project source: the app loads project.json from
 * the user's Drive folder and autosaves every change back to it.
 */

/** A fresh, empty project used when a Drive folder has no project.json yet. */
export function createBlankProject(title = 'Untitled Comic'): ComicProject {
  const now = new Date().toISOString();
  return {
    id: `comic-${Date.now().toString(36)}`,
    title,
    updatedAt: now,
    savedAt: now,
    metadata: blankMetadata(),
    pages: [{ id: 'page-cover', number: 0, title: 'Cover', panels: [] }],
  };
}

/**
 * Throw if the value is not a usable ComicProject.
 * Used by Drive loading and by the agent API.
 *
 * This is a structural validator that mirrors the required fields,
 * types, enums, and numeric bounds of
 * public/schema/comic-project.schema.json. It reports the failing path
 * (e.g. "project.pages[2].panels[0].layers[1]") so callers can fix the
 * input instead of guessing.
 */
export function assertValidProject(p: unknown): asserts p is ComicProject {
  if (!isRecord(p)) fail('project', 'expected an object');
  if (!isString(p.id)) fail('project', 'expected string "id"');
  if (!isString(p.title)) fail('project', 'expected string "title"');
  if (!Array.isArray(p.pages)) fail('project', 'expected array "pages"');
  p.pages.forEach((pg, i) => checkPage(pg, `project.pages[${i}]`));
  if (p.updatedAt !== undefined && !isString(p.updatedAt)) {
    fail('project', 'expected string "updatedAt"');
  }
  if (!isString(p.savedAt)) fail('project', 'expected string "savedAt"');
  checkMetadata(p.metadata, 'project.metadata');
}

function checkMetadata(m: unknown, path: string): void {
  if (!isRecord(m)) fail(path, 'expected an object');
  if (!isString(m.outline)) fail(path, 'expected string "outline"');
  if (!Array.isArray(m.characters)) fail(path, 'expected array "characters"');
  if (!Array.isArray(m.scenes)) fail(path, 'expected array "scenes"');
  if (!Array.isArray(m.objects)) fail(path, 'expected array "objects"');
  if (!Array.isArray(m.media)) fail(path, 'expected array "media"');
  m.characters.forEach((c, i) => checkStoryEntry(c, `${path}.characters[${i}]`, 'characters'));
  m.scenes.forEach((s, i) => checkScene(s, `${path}.scenes[${i}]`));
  m.objects.forEach((o, i) => checkStoryEntry(o, `${path}.objects[${i}]`, 'objects'));
  m.media.forEach((item, i) => checkMediaItem(item, `${path}.media[${i}]`));
}

function checkIdNameDesc(
  v: unknown,
  path: string,
  kind: string
): asserts v is { id: string; name: string; description: string } {
  if (!isRecord(v)) fail(path, `expected ${kind} object`);
  if (!isString(v.id)) fail(path, 'expected string "id"');
  if (!isString(v.name)) fail(path, 'expected string "name"');
  if (!isString(v.description)) fail(path, 'expected string "description"');
}

function checkIdArray(v: unknown, path: string, field: string): void {
  if (!Array.isArray(v)) fail(path, `expected array "${field}"`);
  v.forEach((id, i) => {
    if (!isString(id)) fail(`${path}.${field}[${i}]`, 'expected string id');
  });
}

/** Shared shape for characters and objects: id/name/description + image/scene links. */
function checkStoryEntry(
  v: unknown,
  path: string,
  kind: 'characters' | 'objects'
): asserts v is Character | ComicObject {
  checkIdNameDesc(v, path, kind.slice(0, -1));
  const r = v as Record<string, unknown>;
  checkIdArray(r.imageIds, path, 'imageIds');
  checkIdArray(r.sceneIds, path, 'sceneIds');
}

function checkScene(v: unknown, path: string): asserts v is Scene {
  checkIdNameDesc(v, path, 'scene');
  const r = v as Record<string, unknown>;
  checkIdArray(r.characterIds, path, 'characterIds');
  checkIdArray(r.imageIds, path, 'imageIds');
}

function checkMediaItem(v: unknown, path: string): asserts v is MediaItem {
  if (!isRecord(v)) fail(path, 'expected media object');
  for (const k of ['id', 'name', 'driveFileId', 'url', 'mimeType'] as const) {
    if (!isString(v[k])) fail(path, `expected string "${k}"`);
  }
}

function fail(path: string, detail: string): never {
  throw new Error(`Invalid comic project at ${path}: ${detail}.`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function checkPage(pg: unknown, path: string): void {
  if (!isRecord(pg)) fail(path, 'expected an object');
  if (!isString(pg.id)) fail(path, 'expected string "id"');
  if (!isString(pg.title)) fail(path, 'expected string "title"');
  if (!Number.isInteger(pg.number) || (pg.number as number) < 0) {
    fail(path, '"number" must be a non-negative integer');
  }
  if (!Array.isArray(pg.panels)) fail(path, 'expected array "panels"');
  pg.panels.forEach((p, i) => checkPanel(p, `${path}.panels[${i}]`));
}

function checkPanel(p: unknown, path: string): void {
  if (!isRecord(p)) fail(path, 'expected an object');
  if (!isString(p.id)) fail(path, 'expected string "id"');
  if (!Array.isArray(p.layers)) fail(path, 'expected array "layers"');
  if (!Array.isArray(p.bubbles)) fail(path, 'expected array "bubbles"');
  if (p.title !== undefined && !isString(p.title)) {
    fail(path, 'expected string "title"');
  }
  p.layers.forEach((l, i) => checkLayer(l, `${path}.layers[${i}]`));
  p.bubbles.forEach((b, i) => checkBubble(b, `${path}.bubbles[${i}]`));
}

function checkLayer(l: unknown, path: string): void {
  if (!isRecord(l)) fail(path, 'expected an object');
  for (const k of ['id', 'name', 'src'] as const) {
    if (!isString(l[k])) fail(path, `expected string "${k}"`);
  }
  if (l.kind !== 'background' && l.kind !== 'foreground') {
    fail(path, '"kind" must be "background" or "foreground"');
  }
  if (typeof l.visible !== 'boolean') fail(path, 'expected boolean "visible"');
  for (const k of ['x', 'y', 'width', 'rotation'] as const) {
    if (!isFiniteNumber(l[k])) fail(path, `expected finite number "${k}"`);
  }
  const opacity = l.opacity;
  if (!isFiniteNumber(opacity) || opacity < 0 || opacity > 1) {
    fail(path, '"opacity" must be a number between 0 and 1');
  }
  if (l.driveFileId !== undefined && !isString(l.driveFileId)) {
    fail(path, 'expected string "driveFileId"');
  }
  if (l.mediaId !== undefined && !isString(l.mediaId)) {
    fail(path, 'expected string "mediaId"');
  }
}

function checkBubble(b: unknown, path: string): void {
  if (!isRecord(b)) fail(path, 'expected an object');
  if (!isString(b.id)) fail(path, 'expected string "id"');
  if (b.kind !== 'speech' && b.kind !== 'thought' && b.kind !== 'caption') {
    fail(path, '"kind" must be "speech", "thought", or "caption"');
  }
  if (!isString(b.text)) fail(path, 'expected string "text"');
  for (const k of ['x', 'y', 'width'] as const) {
    if (!isFiniteNumber(b[k])) fail(path, `expected finite number "${k}"`);
  }
  for (const k of ['tailX', 'tailY'] as const) {
    if (b[k] !== undefined && !isFiniteNumber(b[k])) {
      fail(path, `expected finite number "${k}"`);
    }
  }
}
