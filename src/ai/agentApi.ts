import type { ComicPage, ComicProject } from "../types/comic";
import { assertValidProject } from "../state/project";

/**
 * Command API that lets an AI agent (or any script running in the page)
 * operate Comic Builder programmatically instead of clicking through the UI.
 *
 * Installed once by App as `window.comicBuilder`. Everything here is
 * synchronous except the Drive calls. `loadProject()` is the primary
 * editing path: build a full, schema-valid project object and load it —
 * geometry (x/y/width/rotation/opacity) is preserved exactly.
 */

export interface DriveStatus {
  connected: boolean;
  configured: boolean;
}

export interface AgentResult {
  ok: boolean;
  error?: string;
}

/** Live bindings supplied by App (state lives in React; the API reads it via these). */
export interface AgentApiDeps {
  getProject(): ComicProject | null;
  replaceProject(p: ComicProject): void;
  getPageIndex(): number;
  getPageCount(): number;
  selectPage(index: number): boolean;
  saveLocal(): string | null;
  saveToDrive(): Promise<AgentResult>;
  openFromDrive(): Promise<AgentResult>;
  getStatus(): string;
  driveStatus(): DriveStatus;
}

export interface ComicBuilderAgent {
  /** API version, e.g. "1.0.0". */
  version: string;
  /** One-line description of every command. */
  help(): string[];
  /** Current project, or null if nothing is loaded yet. */
  getProject(): ComicProject | null;
  /** Current project serialized as a JSON string, or null. */
  exportProject(): string | null;
  /**
   * Replace the whole project with validated JSON (object or JSON string).
   * Validation follows public/schema/comic-project.schema.json.
   */
  loadProject(data: ComicProject | string): AgentResult;
  /** 0-based index of the page currently shown. */
  getPageIndex(): number;
  /** Number of pages in the current project. */
  getPageCount(): number;
  /** The page currently shown, or null. */
  getCurrentPage(): ComicPage | null;
  /** Show page `index` (0-based). Returns false when out of range. */
  selectPage(index: number): boolean;
  /** Persist to this browser's localStorage. Returns ISO timestamp, or null. */
  saveLocal(): string | null;
  /**
   * Flush any pending autosave to Drive immediately (the app autosaves on
   * its own ~2s after each change). Needs an active Drive connection.
   */
  saveToDrive(): Promise<AgentResult>;
  /**
   * Reload project.json from the Drive folder, discarding unsaved changes.
   * Needs an active Drive connection.
   */
  openFromDrive(): Promise<AgentResult>;
  /** Last human-readable status line shown in the UI. */
  getStatus(): string;
  /** Drive OAuth state. Connecting still needs a real user click (popup). */
  driveStatus(): DriveStatus;
}

declare global {
  interface Window {
    comicBuilder?: ComicBuilderAgent;
  }
}

export const AGENT_API_VERSION = "1.1.0";

export function installAgentApi(deps: AgentApiDeps): void {
  const api: ComicBuilderAgent = {
    version: AGENT_API_VERSION,

    help: () => [
      "version — API version string",
      "help() — list every command",
      "getProject() — current ComicProject as an object (null when loading)",
      "exportProject() — current project as a JSON string (null when loading)",
      "loadProject(json) — replace the project with validated JSON (object or string); returns { ok, error? }",
      "getPageIndex() — 0-based index of the shown page",
      "getPageCount() — number of pages",
      "getCurrentPage() — the shown page as an object (null when loading)",
      "selectPage(i) — show page i (0-based); returns false when out of range",
      "saveLocal() — persist to browser localStorage; returns ISO timestamp or null",
      "saveToDrive() — async: flush pending autosave to Drive now; returns { ok, error? }",
      "openFromDrive() — async: reload project.json from Drive, discarding unsaved changes; returns { ok, error? }",
      "getStatus() — last status line shown in the UI",
      "driveStatus() — { connected, configured }; OAuth connect needs a real user click",
    ],

    getProject: () => deps.getProject(),

    exportProject: () => {
      const p = deps.getProject();
      return p ? JSON.stringify(p) : null;
    },

    loadProject: (data) => {
      try {
        const parsed: unknown =
          typeof data === "string" ? JSON.parse(data) : data;
        assertValidProject(parsed);
        deps.replaceProject(parsed);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    getPageIndex: () => deps.getPageIndex(),

    getPageCount: () => deps.getPageCount(),

    getCurrentPage: () => {
      const p = deps.getProject();
      return p?.pages[deps.getPageIndex()] ?? null;
    },

    selectPage: (index) => deps.selectPage(index),

    saveLocal: () => deps.saveLocal(),

    saveToDrive: () => deps.saveToDrive(),

    openFromDrive: () => deps.openFromDrive(),

    getStatus: () => deps.getStatus(),

    driveStatus: () => deps.driveStatus(),
  };

  window.comicBuilder = api;
}

export function uninstallAgentApi(): void {
  if (window.comicBuilder) {
    delete window.comicBuilder;
  }
}
