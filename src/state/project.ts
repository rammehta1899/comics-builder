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
  validateProject(parsed);
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

function validateProject(p: ComicProject): void {
  if (!p || !Array.isArray(p.pages)) {
    throw new Error("Invalid comic project file: expected { pages: [...] }.");
  }
}
