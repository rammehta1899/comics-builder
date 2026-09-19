import type { ComicProject } from "../types/comic";

/**
 * Project loading sources. The builder is generic: it renders whatever
 * ComicProject JSON it is given — nothing is hardcoded to any one comic.
 * Google Drive is the only project source: the app loads project.json from
 * the user's Drive folder and autosaves every change back to it.
 */

/** Load the bundled placeholder project (used for docs/demos only). */
export async function loadSampleProject(): Promise<ComicProject> {
  const url = `${import.meta.env.BASE_URL}data/sample-project.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load sample project (${res.status}).`);
  return (await res.json()) as ComicProject;
}

/** A fresh, empty project used when the Drive folder has no project.json yet. */
export function createBlankProject(title = "Untitled Comic"): ComicProject {
  const now = new Date().toISOString();
  return {
    id: `comic-${Date.now().toString(36)}`,
    title,
    updatedAt: now,
    pages: [{ id: "page-cover", number: 0, title: "Cover", panels: [] }],
  };
}

/** Download the current project as a .json file. */
export function downloadProject(project: ComicProject): void {
  const blob = new Blob([JSON.stringify(project, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${project.id || "comic-project"}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

const LOCAL_STORAGE_KEY = "cb_local_project";
const LOCAL_BACKUP_KEY = "cb_local_project_backup";

/** Explicitly persist the project in this browser (localStorage). */
export function saveProjectLocal(project: ComicProject): string {
  const stamped = { ...project, updatedAt: new Date().toISOString() };
  try {
    const prev = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (prev) localStorage.setItem(LOCAL_BACKUP_KEY, prev);
  } catch {
    /* best effort */
  }
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(stamped));
  return stamped.updatedAt as string;
}

/** Restore the project previously saved in this browser, if any. */
export function loadProjectLocal(): ComicProject | null {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ComicProject;
    assertValidProject(parsed);
    return parsed;
  } catch {
    return null;
  }
}

/** Discard the browser-saved copy (e.g. after a successful Drive save). */
export function clearProjectLocal(): void {
  localStorage.removeItem(LOCAL_STORAGE_KEY);
}

/**
 * Throw if the value is not a usable ComicProject.
 * Used by file/Drive loading and by the agent API.
 *
 * This is a structural validator that mirrors the required fields,
 * types, enums, and numeric bounds of
 * public/schema/comic-project.schema.json. It reports the failing path
 * (e.g. "project.pages[2].panels[0].layers[1]") so callers can fix the
 * input instead of guessing.
 */
export function assertValidProject(p: unknown): asserts p is ComicProject {
  if (!isRecord(p)) fail("project", "expected an object");
  if (!isString(p.id)) fail("project", 'expected string "id"');
  if (!isString(p.title)) fail("project", 'expected string "title"');
  if (!Array.isArray(p.pages)) fail("project", 'expected array "pages"');
  p.pages.forEach((pg, i) => checkPage(pg, `project.pages[${i}]`));
  if (p.updatedAt !== undefined && !isString(p.updatedAt)) {
    fail("project", 'expected string "updatedAt"');
  }
}

function fail(path: string, detail: string): never {
  throw new Error(`Invalid comic project at ${path}: ${detail}.`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function checkPage(pg: unknown, path: string): void {
  if (!isRecord(pg)) fail(path, "expected an object");
  if (!isString(pg.id)) fail(path, 'expected string "id"');
  if (!isString(pg.title)) fail(path, 'expected string "title"');
  if (!Number.isInteger(pg.number) || (pg.number as number) < 0) {
    fail(path, '"number" must be a non-negative integer');
  }
  if (!Array.isArray(pg.panels)) fail(path, 'expected array "panels"');
  pg.panels.forEach((p, i) => checkPanel(p, `${path}.panels[${i}]`));
}

function checkPanel(p: unknown, path: string): void {
  if (!isRecord(p)) fail(path, "expected an object");
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
  if (!isRecord(l)) fail(path, "expected an object");
  for (const k of ["id", "name", "src"] as const) {
    if (!isString(l[k])) fail(path, `expected string "${k}"`);
  }
  if (l.kind !== "background" && l.kind !== "foreground") {
    fail(path, '"kind" must be "background" or "foreground"');
  }
  if (typeof l.visible !== "boolean") fail(path, 'expected boolean "visible"');
  for (const k of ["x", "y", "width", "rotation"] as const) {
    if (!isFiniteNumber(l[k])) fail(path, `expected finite number "${k}"`);
  }
  const opacity = l.opacity;
  if (!isFiniteNumber(opacity) || opacity < 0 || opacity > 1) {
    fail(path, '"opacity" must be a number between 0 and 1');
  }
  if (l.driveFileId !== undefined && !isString(l.driveFileId)) {
    fail(path, 'expected string "driveFileId"');
  }
}

function checkBubble(b: unknown, path: string): void {
  if (!isRecord(b)) fail(path, "expected an object");
  if (!isString(b.id)) fail(path, 'expected string "id"');
  if (b.kind !== "speech" && b.kind !== "thought" && b.kind !== "caption") {
    fail(path, '"kind" must be "speech", "thought", or "caption"');
  }
  if (!isString(b.text)) fail(path, 'expected string "text"');
  for (const k of ["x", "y", "width"] as const) {
    if (!isFiniteNumber(b[k])) fail(path, `expected finite number "${k}"`);
  }
  for (const k of ["tailX", "tailY"] as const) {
    if (b[k] !== undefined && !isFiniteNumber(b[k])) {
      fail(path, `expected finite number "${k}"`);
    }
  }
}
