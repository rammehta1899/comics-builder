import type { ComicProject } from "../types/comic";

/**
 * Project loading sources. The builder is generic: it renders whatever
 * ComicProject JSON it is given — nothing is hardcoded to any one comic.
 */

/** Load the bundled placeholder project (used when no Drive project is open). */
export async function loadSampleProject(): Promise<ComicProject> {
  const url = `${import.meta.env.BASE_URL}data/sample-project.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load sample project (${res.status}).`);
  return (await res.json()) as ComicProject;
}

/** Load a project from a local .json file picked by the user. */
export async function loadProjectFromFile(file: File): Promise<ComicProject> {
  const text = await file.text();
  const parsed = JSON.parse(text) as ComicProject;
  assertValidProject(parsed);
  return parsed;
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
 */
export function assertValidProject(p: unknown): asserts p is ComicProject {
  const proj = p as ComicProject;
  if (!proj || !Array.isArray(proj.pages)) {
    throw new Error(
      "Invalid comic project: expected { id, title, pages: [...] }."
    );
  }
}
