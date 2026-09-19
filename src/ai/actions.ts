/**
 * The window.ComicBuilder command API: a CLI for the whole Comic Builder UI.
 *
 * Every UI control in the app calls these same functions — one code path, no
 * drift between what a human clicks and what an AI agent calls. The JSDoc on
 * every node below is the single source of truth for documentation:
 * scripts/extract-docs.mjs parses it at build time into
 * src/ai/actions.docs.gen.ts, which installComicBuilder() then attaches as
 * each node's toString() and renders as ComicBuilder.help().
 *
 * Conventions used throughout:
 * - Reads return deep-cloned snapshots (structuredClone). Mutating a
 *   snapshot changes nothing; all writes go through the action functions.
 * - A panel has no separate "background" field: the background is the layer
 *   whose kind is "background" (conventionally the first layer).
 * - Bubbles always render above all layers.
 * - Every mutation flows through deps.updateProject, so the app's ~2s
 *   debounced autosave picks it up and writes project.json to Drive.
 */

import type {
  Bubble,
  BubbleKind,
  Character,
  ComicObject,
  ComicPage,
  ComicProject,
  Layer,
  LayerKind,
  MediaItem,
  Panel,
  PageSize,
  Scene,
} from '../types/comic';
import { assertValidProject } from '../state/project';
import { formatPageNumber } from '../types/comic';
import { attachDocs, buildHelpText } from './docs';
import { ACTION_DOCS } from './actions.docs.gen';
import type { DeviceCodeInfo } from '../drive/driveClient';

export const COMIC_BUILDER_VERSION = '2.0.0';

/** Result of an action that can fail. */
export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** Live bindings supplied by App (state lives in React; the API drives it). */
export interface ComicBuilderDeps {
  /** Current project, or null when no project is open. */
  getProject(): ComicProject | null;
  /**
   * Run a mutator against the current project. The app re-renders and the
   * autosave timer restarts afterwards. Throws when no project is open.
   */
  updateProject(mut: (p: ComicProject) => void): void;
  /** Replace the whole project (already validated). */
  replaceProject(p: ComicProject): void;
  getPageIndex(): number;
  setPageIndex(i: number): void;
  setPreview(open: boolean): void;
  setStatus(msg: string): void;
  /** Start the Drive OAuth flow. Must be called from a user gesture. */
  connectStorage(): Promise<void>;
  /**
   * Start the Drive OAuth device flow for headless sessions (no popup).
   * Resolves promptly with { url, code, expiresInSeconds } for the user to
   * approve on any device; the access token lands in memory in the
   * background once they approve.
   */
  connectStorageWithDevice(): Promise<DeviceCodeInfo>;
  /** Revoke the Drive grant at Google and clear local Drive state. */
  disconnectStorage(): Promise<void>;
  getStorageStatus(): { connected: boolean; configured: boolean };
  /** Folders this app created (drive.file scope) — the complete project list. */
  listStorageProjects(): Promise<Array<{ id: string; name: string }>>;
  createStorageProject(name: string, pageSize?: PageSize): Promise<{ id: string; name: string }>;
  openStorageProject(id: string): Promise<ActionResult>;
  closeStorageProject(): void;
  /** Delete a project folder from Drive and refresh the tiles. */
  removeStorageProject(id: string): Promise<ActionResult>;
  /** Refresh the tiles list and show the tiles screen (keeps project open). */
  showProjectTiles(): Promise<Array<{ id: string; name: string }>>;
  /** Flush any pending autosave to Drive now. */
  flushStorageSave(): Promise<ActionResult>;
  /**
   * Upload PNG bytes (data URL) into the current project folder and register
   * the file in metadata.media. Returns the new MediaItem.
   */
  uploadStorageMedia(name: string, dataUrl: string, mimeType: string): Promise<MediaItem>;
}

/** Input for layers.add(). Geometry is in % of panel size. */
export interface LayerInput {
  name: string;
  kind?: LayerKind;
  src?: string;
  mediaId?: string;
  driveFileId?: string;
  visible?: boolean;
  x?: number;
  y?: number;
  width?: number;
  rotation?: number;
  opacity?: number;
}

/** Patch for layers.update(). Only the given fields change. */
export interface LayerPatch {
  name?: string;
  kind?: LayerKind;
  src?: string;
  mediaId?: string;
  driveFileId?: string;
  visible?: boolean;
  x?: number;
  y?: number;
  width?: number;
  rotation?: number;
  opacity?: number;
}

/** Input for bubbles.add(). Position/size in % of panel size. */
export interface BubbleInput {
  kind?: BubbleKind;
  text: string;
  x?: number;
  y?: number;
  width?: number;
  tailX?: number;
  tailY?: number;
}

/** Patch for bubbles.update(). Only the given fields change. */
export interface BubblePatch {
  kind?: BubbleKind;
  text?: string;
  x?: number;
  y?: number;
  width?: number;
  tailX?: number;
  tailY?: number;
}

/** Input for characters.create() / scenes.create() / objects.create(). */
export interface StoryEntryInput {
  name: string;
  description?: string;
  /** MediaItem ids (reference art). */
  imageIds?: string[];
  /** Linked entry ids: sceneIds for characters/objects, characterIds for scenes. */
  linkIds?: string[];
}

/** Patch for characters.update() / scenes.update() / objects.update(). */
export interface StoryEntryPatch {
  name?: string;
  description?: string;
  imageIds?: string[];
  linkIds?: string[];
}

declare global {
  interface Window {
    ComicBuilder?: ComicBuilderApi;
  }
}

function newId(prefix: string): string {
  try {
    return `${prefix}-${crypto.randomUUID()}`;
  } catch {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Deep-clone a value for snapshot (read-only) semantics. */
function snapshot<T>(v: T): T {
  return structuredClone(v);
}

function requireProject(deps: ComicBuilderDeps): ComicProject {
  const p = deps.getProject();
  if (!p) throw new Error('No project is open. Open a project first.');
  return p;
}

function findPanel(p: ComicProject, panelId: string): Panel | undefined {
  for (const page of p.pages) {
    const panel = page.panels.find((pl) => pl.id === panelId);
    if (panel) return panel;
  }
  return undefined;
}

function findLayer(panel: Panel, layerId: string): Layer | undefined {
  return panel.layers.find((l) => l.id === layerId);
}

function findBubble(panel: Panel, bubbleId: string): Bubble | undefined {
  return panel.bubbles.find((b) => b.id === bubbleId);
}

function checkLayerKind(kind: unknown): asserts kind is LayerKind {
  if (kind !== 'background' && kind !== 'foreground') {
    throw new Error('Layer kind must be "background" or "foreground".');
  }
}

function checkBubbleKind(kind: unknown): asserts kind is BubbleKind {
  if (kind !== 'speech' && kind !== 'thought' && kind !== 'caption') {
    throw new Error('Bubble kind must be "speech", "thought", or "caption".');
  }
}

/**
 * Build the ComicBuilder action tree bound to the given deps.
 * The extractor reads the JSDoc off the `ComicBuilder` literal below.
 */
export function createComicBuilder(deps: ComicBuilderDeps) {
  /**
   * Top-level command API for Comic Builder: every UI control calls these same
   * functions (one code path, no drift). Namespaces: storage (Drive OAuth,
   * project folders, project.json IO), project (whole-project replace),
   * page (navigation + preview), layers, bubbles, metadata (story bible),
   * characters, scenes, objects, media. Reads return deep-cloned snapshots;
   * every mutation autosaves to Drive ~2s after the last change.
   */
  const ComicBuilder = {
    /** API version string, e.g. "2.0.0". */
    version: COMIC_BUILDER_VERSION,

    /**
     * Render the full skill-style reference for this API: conventions plus every namespace and function with its description, parameters, and return value. This text is generated at build time from the JSDoc in src/ai/actions.ts, so it never drifts from the code.
     * @returns The complete API reference as plain text.
     */
    help: (): string => {
      const keys = Object.keys(ACTION_DOCS);
      if (keys.length > 0) return buildHelpText(ACTION_DOCS, 'ComicBuilder');
      return [
        'ComicBuilder — AI command API for Comic Builder.',
        'Namespaces: storage, project, page, layers, bubbles, metadata,',
        'characters, scenes, objects, media.',
        'Rebuild the app to regenerate the full reference.',
      ].join('\n');
    },

    /**
     * Google Drive storage: OAuth, project folders, and project.json IO.
     * Drive is the only project store. Scope is drive.file, so the app only
     * sees folders and files it created — listProjects() is the complete list.
     */
    storage: {
      /**
       * Start the Google Drive OAuth flow (GIS popup).
       * MUST be called from a real human click: browsers block OAuth popups
       * from injected scripts, so an agent calling this alone cannot complete
       * the flow. Ask the user to click the "Connect with Google Drive" button.
       * Resolves once the access token is in memory. The token is never
       * written to web storage; reloading the page drops it (one click
       * reconnects).
       * @returns A promise that resolves when Drive access is granted.
       */
      connect: (): Promise<void> => deps.connectStorage(),

      /**
       * Start the Google Drive OAuth device flow — for headless browsers
       * and AI assistants that cannot complete the GIS popup.
       * Resolves promptly with { url, code, expiresInSeconds }: show the
       * user the URL and code (they open the URL on any device — a phone
       * works — enter the code, and approve). Then poll storage.status()
       * until connected is true and continue. The background poll rejects
       * on denial or expiry; status() then stays disconnected.
       * Works from injected scripts: no popup, no user gesture needed.
       * The device client secret ships in the app bundle by design
       * (Google's device-client model: distributed apps cannot keep
       * secrets; scope stays limited to drive.file, and the access token
       * itself is memory-only).
       * @returns The verification URL, user code, and code expiry.
       */
      connectWithDevice: (): Promise<DeviceCodeInfo> => deps.connectStorageWithDevice(),

      /**
       * Disconnect Drive: revoke the grant at Google AND clear the remembered
       * folder id. Full sign-out — the next connect re-prompts for permission.
       * (Reloading the page alone does NOT revoke; it only drops the
       * in-memory token, and one click reconnects silently.)
       * @returns A promise that resolves when disconnection is complete.
       */
      disconnect: (): Promise<void> => deps.disconnectStorage(),

      /**
       * Report Drive connection state.
       * @returns { connected, configured }: connected means an unexpired token is in memory; configured means a Google OAuth client ID is set.
       */
      status: (): { connected: boolean; configured: boolean } => deps.getStorageStatus(),

      /**
       * List every project folder this app created on Drive (files.list under
       * the drive.file scope). This is the complete project list — the app is
       * blind to everything else on the user's Drive.
       * @returns A promise resolving to [{ id, name }] of project folders.
       */
      listProjects: (): Promise<Array<{ id: string; name: string }>> => deps.listStorageProjects(),

      /**
       * Create a new project: create the Drive folder, write a blank
       * project.json (cover page, empty metadata) into it, and open it.
       * The new project appears in listProjects().
       * @param name - The project name; becomes the Drive folder name.
       * @param pageSize - Optional { label, widthIn, heightIn } physical page
       *   dimensions (see PAGE_SIZE_PRESETS in the data model). Defaults to
       *   US Comic (6.625" × 10.25").
       * @returns A promise resolving to { id, name } of the new folder.
       */
      createProject: (name: string, pageSize?: PageSize): Promise<{ id: string; name: string }> =>
        deps.createStorageProject(name, pageSize),

      /**
       * Open a project: load the folder's project.json into the editor.
       * @param idOrName - The folder id from listProjects(), or the project/folder name.
       * @returns A promise resolving to { ok, error? }.
       */
      openProject: (idOrName: string): Promise<ActionResult> =>
        (async (): Promise<ActionResult> => {
          const folders = await deps.listStorageProjects();
          const match =
            folders.find((f) => f.id === idOrName) ?? folders.find((f) => f.name === idOrName);
          if (!match) {
            return { ok: false, error: `No project folder "${idOrName}".` };
          }
          return deps.openStorageProject(match.id);
        })(),

      /**
       * Close the current project: drop it from the editor and return to the
       * project tiles. Does not delete anything on Drive.
       */
      closeProject: (): void => deps.closeStorageProject(),

      /**
       * Remove a project: permanently delete the project folder
       * (project.json and all artwork) from Google Drive. Cannot be undone.
       * @param idOrName - The folder id from listProjects(), or the project/folder name.
       * @returns A promise resolving to { ok, error? }.
       */
      removeProject: (idOrName: string): Promise<ActionResult> =>
        (async (): Promise<ActionResult> => {
          const folders = await deps.listStorageProjects();
          const match =
            folders.find((f) => f.id === idOrName) ?? folders.find((f) => f.name === idOrName);
          if (!match) {
            return { ok: false, error: `No project folder "${idOrName}".` };
          }
          return deps.removeStorageProject(match.id);
        })(),

      /**
       * Go back to the project tiles page, refreshing the folder list.
       * The current project (if any) stays open in the background.
       * @returns A promise resolving to [{ id, name }] of project folders.
       */
      showProjects: (): Promise<Array<{ id: string; name: string }>> => deps.showProjectTiles(),

      /**
       * Flush any pending autosave to Drive immediately. The app autosaves
       * ~2s after each change on its own; this only hurries it.
       * @returns A promise resolving to { ok, error? }.
       */
      save: (): Promise<ActionResult> => deps.flushStorageSave(),
    },

    /**
     * Whole-project operations on the currently open project.
     */
    project: {
      /**
       * Replace the whole project with validated JSON (object or JSON string).
       * Validation follows public/schema/comic-project.schema.json; the error
       * names the failing path (e.g. project.pages[2].panels[0].layers[1]).
       * This is the primary editing path for bulk changes: read snapshots via
       * page/layers/bubbles/metadata, modify client-side, load the result.
       * Geometry (x/y/width/rotation/opacity) is preserved exactly.
       * @param data - A ComicProject object or its JSON string.
       * @returns { ok, error? }.
       */
      load: (data: ComicProject | string): ActionResult => {
        try {
          const parsed: unknown = typeof data === 'string' ? JSON.parse(data) : data;
          assertValidProject(parsed);
          deps.replaceProject(parsed);
          deps.setStatus(`Project "${parsed.title}" loaded.`);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },

    /**
     * Page navigation and preview for the open project.
     */
    page: {
      /**
       * Show page i and return it. Pages are 0-based; the UI displays them as
       * 00, 01, 02, …
       * @param i - 0-based page index.
       * @returns A deep-cloned ComicPage snapshot (panels with layers and bubbles), or null when i is out of range or no project is open. Snapshots are read-only: mutating them changes nothing.
       */
      select: (i: number): ComicPage | null => {
        const p = deps.getProject();
        if (!p) return null;
        if (!Number.isInteger(i) || i < 0 || i >= p.pages.length) return null;
        deps.setPageIndex(i);
        return snapshot(p.pages[i]);
      },

      /**
       * Number of pages in the open project.
       * @returns The page count, or 0 when no project is open.
       */
      count: (): number => deps.getProject()?.pages.length ?? 0,

      /**
       * The currently shown page.
       * @returns A deep-cloned ComicPage snapshot, or null when no project is open. Read-only.
       */
      current: (): ComicPage | null => {
        const p = deps.getProject();
        if (!p) return null;
        return snapshot(p.pages[deps.getPageIndex()] ?? null);
      },

      /**
       * Add a blank page at the end of the project and show it.
       * @param title - Optional page title (defaults to "Page 01", "Page 02", …).
       * @returns A promise resolving to { ok, index?, error? } with the new
       *   0-based page index.
       */
      add: (title?: string): Promise<ActionResult & { index?: number }> =>
        (async (): Promise<ActionResult & { index?: number }> => {
          const p = deps.getProject();
          if (!p) return { ok: false, error: 'No project is open.' };
          let index = -1;
          deps.updateProject((proj) => {
            index = proj.pages.length;
            proj.pages.push({
              id: newId('page'),
              number: index,
              title: title?.trim() || `Page ${formatPageNumber(index)}`,
              panels: [],
            });
          });
          deps.setPageIndex(index);
          return { ok: true, index };
        })(),

      /**
       * Open preview mode: the current page rendered full-bleed with all its
       * panels, minimal chrome, for visual review. An agent can screenshot the
       * preview and show it to the user.
       */
      openPreview: (): void => deps.setPreview(true),

      /**
       * Close preview mode and return to the editor.
       */
      closePreview: (): void => deps.setPreview(false),
    },

    /**
     * Image layers inside a panel, addressed by panel id (see the id fields
     * of the ComicPage snapshot from page.select). Layers composite
     * bottom-to-top in array order. There is no separate background field:
     * the background is the layer whose kind is "background".
     * Every mutation autosaves (~2s debounce) to Drive.
     */
    layers: {
      /**
       * List the layers of a panel, bottom-to-top.
       * @param panelId - The panel id.
       * @returns Deep-cloned Layer snapshots, or null when the panel is not found. Read-only.
       */
      list: (panelId: string): Layer[] | null => {
        const p = deps.getProject();
        const panel = p ? findPanel(p, panelId) : undefined;
        return panel ? snapshot(panel.layers) : null;
      },

      /**
       * Get one layer.
       * @param panelId - The panel id.
       * @param layerId - The layer id.
       * @returns A deep-cloned Layer snapshot, or null when not found. Read-only.
       */
      get: (panelId: string, layerId: string): Layer | null => {
        const p = deps.getProject();
        const panel = p ? findPanel(p, panelId) : undefined;
        const layer = panel ? findLayer(panel, layerId) : undefined;
        return layer ? snapshot(layer) : null;
      },

      /**
       * Add an image layer (e.g. a transparent PNG) to a panel. It is appended
       * on top. Position it afterwards with update().
       * @param panelId - The panel id.
       * @param input - { name, kind?, src?, mediaId?, driveFileId?, visible?, x?, y?, width?, rotation?, opacity? }. x/y/width are % of panel size; kind defaults to "foreground"; geometry defaults to x:0, y:0, width:100, rotation:0, opacity:1, visible:true.
       * @returns The new Layer (live reference inside the project).
       */
      add: (panelId: string, input: LayerInput): Layer => {
        checkLayerKind(input.kind ?? 'foreground');
        const layer: Layer = {
          id: newId('layer'),
          name: input.name,
          kind: input.kind ?? 'foreground',
          src: input.src ?? '',
          mediaId: input.mediaId,
          driveFileId: input.driveFileId,
          visible: input.visible ?? true,
          x: input.x ?? 0,
          y: input.y ?? 0,
          width: input.width ?? 100,
          rotation: input.rotation ?? 0,
          opacity: input.opacity ?? 1,
        };
        deps.updateProject((p) => {
          const panel = findPanel(p, panelId);
          if (!panel) throw new Error(`Panel "${panelId}" not found.`);
          panel.layers.push(layer);
        });
        deps.setStatus(`Layer "${input.name}" added.`);
        return snapshot(layer);
      },

      /**
       * Update a layer: move (x/y), resize (width), rotate, change opacity or
       * visibility, rename, or relink its artwork (src/mediaId/driveFileId).
       * Only the given fields change.
       * @param panelId - The panel id.
       * @param layerId - The layer id.
       * @param patch - Partial layer fields.
       * @returns A deep-cloned Layer snapshot of the updated layer, or null when the panel/layer is not found.
       */
      update: (panelId: string, layerId: string, patch: LayerPatch): Layer | null => {
        if (patch.kind !== undefined) checkLayerKind(patch.kind);
        let updated: Layer | undefined;
        deps.updateProject((p) => {
          const panel = findPanel(p, panelId);
          const layer = panel ? findLayer(panel, layerId) : undefined;
          if (!layer) throw new Error(`Layer "${layerId}" not found.`);
          if (patch.name !== undefined) layer.name = patch.name;
          if (patch.kind !== undefined) layer.kind = patch.kind;
          if (patch.src !== undefined) layer.src = patch.src;
          if (patch.mediaId !== undefined) layer.mediaId = patch.mediaId;
          if (patch.driveFileId !== undefined) layer.driveFileId = patch.driveFileId;
          if (patch.visible !== undefined) layer.visible = patch.visible;
          if (patch.x !== undefined) layer.x = patch.x;
          if (patch.y !== undefined) layer.y = patch.y;
          if (patch.width !== undefined) layer.width = patch.width;
          if (patch.rotation !== undefined) layer.rotation = patch.rotation;
          if (patch.opacity !== undefined) layer.opacity = patch.opacity;
          updated = layer;
        });
        return updated ? snapshot(updated) : null;
      },

      /**
       * Delete a layer from a panel.
       * @param panelId - The panel id.
       * @param layerId - The layer id.
       * @returns True when a layer was removed, false when not found.
       */
      delete: (panelId: string, layerId: string): boolean => {
        let removed = false;
        deps.updateProject((p) => {
          const panel = findPanel(p, panelId);
          if (!panel) throw new Error(`Panel "${panelId}" not found.`);
          const idx = panel.layers.findIndex((l) => l.id === layerId);
          if (idx >= 0) {
            panel.layers.splice(idx, 1);
            removed = true;
          }
        });
        return removed;
      },
    },

    /**
     * Speech/thought/caption bubbles inside a panel, addressed by panel id.
     * Bubbles always render above all layers. Every mutation autosaves
     * (~2s debounce) to Drive.
     */
    bubbles: {
      /**
       * List the bubbles of a panel.
       * @param panelId - The panel id.
       * @returns Deep-cloned Bubble snapshots, or null when the panel is not found. Read-only.
       */
      list: (panelId: string): Bubble[] | null => {
        const p = deps.getProject();
        const panel = p ? findPanel(p, panelId) : undefined;
        return panel ? snapshot(panel.bubbles) : null;
      },

      /**
       * Add a bubble to a panel.
       * @param panelId - The panel id.
       * @param input - { kind?, text, x?, y?, width?, tailX?, tailY? }. kind defaults to "speech"; x/y/width are % of panel size.
       * @returns The new Bubble.
       */
      add: (panelId: string, input: BubbleInput): Bubble => {
        checkBubbleKind(input.kind ?? 'speech');
        const bubble: Bubble = {
          id: newId('bubble'),
          kind: input.kind ?? 'speech',
          text: input.text,
          x: input.x ?? 10,
          y: input.y ?? 10,
          width: input.width ?? 40,
          tailX: input.tailX,
          tailY: input.tailY,
        };
        deps.updateProject((p) => {
          const panel = findPanel(p, panelId);
          if (!panel) throw new Error(`Panel "${panelId}" not found.`);
          panel.bubbles.push(bubble);
        });
        return snapshot(bubble);
      },

      /**
       * Update a bubble: text, kind, position, size, or tail target.
       * Only the given fields change.
       * @param panelId - The panel id.
       * @param bubbleId - The bubble id.
       * @param patch - Partial bubble fields.
       * @returns A deep-cloned Bubble snapshot of the updated bubble, or null when not found.
       */
      update: (panelId: string, bubbleId: string, patch: BubblePatch): Bubble | null => {
        if (patch.kind !== undefined) checkBubbleKind(patch.kind);
        let updated: Bubble | undefined;
        deps.updateProject((p) => {
          const panel = findPanel(p, panelId);
          const bubble = panel ? findBubble(panel, bubbleId) : undefined;
          if (!bubble) throw new Error(`Bubble "${bubbleId}" not found.`);
          if (patch.kind !== undefined) bubble.kind = patch.kind;
          if (patch.text !== undefined) bubble.text = patch.text;
          if (patch.x !== undefined) bubble.x = patch.x;
          if (patch.y !== undefined) bubble.y = patch.y;
          if (patch.width !== undefined) bubble.width = patch.width;
          if (patch.tailX !== undefined) bubble.tailX = patch.tailX;
          if (patch.tailY !== undefined) bubble.tailY = patch.tailY;
          updated = bubble;
        });
        return updated ? snapshot(updated) : null;
      },

      /**
       * Delete a bubble from a panel.
       * @param panelId - The panel id.
       * @param bubbleId - The bubble id.
       * @returns True when a bubble was removed, false when not found.
       */
      delete: (panelId: string, bubbleId: string): boolean => {
        let removed = false;
        deps.updateProject((p) => {
          const panel = findPanel(p, panelId);
          if (!panel) throw new Error(`Panel "${panelId}" not found.`);
          const idx = panel.bubbles.findIndex((b) => b.id === bubbleId);
          if (idx >= 0) {
            panel.bubbles.splice(idx, 1);
            removed = true;
          }
        });
        return removed;
      },
    },

    /**
     * The project's story bible: outline plus the media registry.
     * Use characters/scenes/objects for the individual entries.
     */
    metadata: {
      /**
       * Read the whole metadata block (outline, characters, scenes, objects, media).
       * @returns A deep-cloned metadata snapshot. Read-only: mutate via the dedicated functions.
       */
      get: () => snapshot(requireProject(deps).metadata),

      /**
       * Set the story outline / synopsis.
       * @param text - The new outline text.
       * @returns { ok: true }.
       */
      setOutline: (text: string): ActionResult => {
        deps.updateProject((p) => {
          p.metadata.outline = text;
        });
        return { ok: true };
      },

      /**
       * Set the physical page dimensions for the comic.
       * @param pageSize - { label, widthIn, heightIn }, e.g. one of
       *   PAGE_SIZE_PRESETS from the data model.
       * @returns { ok: true }.
       */
      setPageSize: (pageSize: PageSize): ActionResult => {
        if (
          !pageSize ||
          typeof pageSize.label !== 'string' ||
          !(pageSize.widthIn > 0) ||
          !(pageSize.heightIn > 0)
        ) {
          return { ok: false, error: 'pageSize needs { label, widthIn, heightIn }.' };
        }
        deps.updateProject((p) => {
          p.metadata.pageSize = { ...pageSize };
        });
        return { ok: true };
      },
    },

    /**
     * Characters in the story bible. A character's description sets its visual
     * look (appearance, outfit, distinctive features) plus continuity notes;
     * imageIds point at transparent PNG reference art in metadata.media. An
     * LLM reads a character (description + images) together with a scene to
     * build image-generation prompts.
     */
    characters: {
      /**
       * List characters.
       * @returns [{ id, name }] for every character.
       */
      list: (): Array<{ id: string; name: string }> =>
        requireProject(deps).metadata.characters.map((c) => ({
          id: c.id,
          name: c.name,
        })),

      /**
       * Get one character with its full description and image/scene links.
       * @param id - The character id.
       * @returns A deep-cloned Character snapshot, or null when not found. Read-only.
       */
      get: (id: string): Character | null => {
        const c = requireProject(deps).metadata.characters.find((ch) => ch.id === id);
        return c ? snapshot(c) : null;
      },

      /**
       * Create a character.
       * @param input - { name, description?, imageIds?, linkIds? }: linkIds are scene ids the character appears in.
       * @returns The new Character.
       */
      create: (input: StoryEntryInput): Character => {
        const c: Character = {
          id: newId('char'),
          name: input.name,
          description: input.description ?? '',
          imageIds: input.imageIds ?? [],
          sceneIds: input.linkIds ?? [],
        };
        deps.updateProject((p) => {
          p.metadata.characters.push(c);
        });
        return snapshot(c);
      },

      /**
       * Update a character's name, description, or image/scene links.
       * Only the given fields change.
       * @param id - The character id.
       * @param patch - { name?, description?, imageIds?, linkIds? }.
       * @returns A deep-cloned Character snapshot, or null when not found.
       */
      update: (id: string, patch: StoryEntryPatch): Character | null => {
        let updated: Character | undefined;
        deps.updateProject((p) => {
          const c = p.metadata.characters.find((ch) => ch.id === id);
          if (!c) throw new Error(`Character "${id}" not found.`);
          if (patch.name !== undefined) c.name = patch.name;
          if (patch.description !== undefined) c.description = patch.description;
          if (patch.imageIds !== undefined) c.imageIds = patch.imageIds;
          if (patch.linkIds !== undefined) c.sceneIds = patch.linkIds;
          updated = c;
        });
        return updated ? snapshot(updated) : null;
      },

      /**
       * Delete a character. References from scenes are left dangling and
       * documented as such; clean them with scenes.update if needed.
       * @param id - The character id.
       * @returns True when a character was removed, false when not found.
       */
      delete: (id: string): boolean => {
        let removed = false;
        deps.updateProject((p) => {
          const idx = p.metadata.characters.findIndex((ch) => ch.id === id);
          if (idx >= 0) {
            p.metadata.characters.splice(idx, 1);
            removed = true;
          }
        });
        return removed;
      },
    },

    /**
     * Scenes/locations in the story bible. A scene's description covers the
     * setting, time of day, mood, and lighting — the other half (with a
     * character) of an image-generation prompt.
     */
    scenes: {
      /**
       * List scenes.
       * @returns [{ id, name }] for every scene.
       */
      list: (): Array<{ id: string; name: string }> =>
        requireProject(deps).metadata.scenes.map((s) => ({
          id: s.id,
          name: s.name,
        })),

      /**
       * Get one scene with its full description and character/image links.
       * @param id - The scene id.
       * @returns A deep-cloned Scene snapshot, or null when not found. Read-only.
       */
      get: (id: string): Scene | null => {
        const s = requireProject(deps).metadata.scenes.find((sc) => sc.id === id);
        return s ? snapshot(s) : null;
      },

      /**
       * Create a scene.
       * @param input - { name, description?, imageIds?, linkIds? }: linkIds are character ids appearing in the scene.
       * @returns The new Scene.
       */
      create: (input: StoryEntryInput): Scene => {
        const s: Scene = {
          id: newId('scene'),
          name: input.name,
          description: input.description ?? '',
          characterIds: input.linkIds ?? [],
          imageIds: input.imageIds ?? [],
        };
        deps.updateProject((p) => {
          p.metadata.scenes.push(s);
        });
        return snapshot(s);
      },

      /**
       * Update a scene's name, description, or character/image links.
       * Only the given fields change.
       * @param id - The scene id.
       * @param patch - { name?, description?, imageIds?, linkIds? }.
       * @returns A deep-cloned Scene snapshot, or null when not found.
       */
      update: (id: string, patch: StoryEntryPatch): Scene | null => {
        let updated: Scene | undefined;
        deps.updateProject((p) => {
          const s = p.metadata.scenes.find((sc) => sc.id === id);
          if (!s) throw new Error(`Scene "${id}" not found.`);
          if (patch.name !== undefined) s.name = patch.name;
          if (patch.description !== undefined) s.description = patch.description;
          if (patch.imageIds !== undefined) s.imageIds = patch.imageIds;
          if (patch.linkIds !== undefined) s.characterIds = patch.linkIds;
          updated = s;
        });
        return updated ? snapshot(updated) : null;
      },

      /**
       * Delete a scene. References from characters/objects are left dangling;
       * clean them with characters.update / objects.update if needed.
       * @param id - The scene id.
       * @returns True when a scene was removed, false when not found.
       */
      delete: (id: string): boolean => {
        let removed = false;
        deps.updateProject((p) => {
          const idx = p.metadata.scenes.findIndex((sc) => sc.id === id);
          if (idx >= 0) {
            p.metadata.scenes.splice(idx, 1);
            removed = true;
          }
        });
        return removed;
      },
    },

    /**
     * Props/objects in the story bible. Same shape as characters: a visual
     * description plus reference art, linkable from scenes.
     */
    objects: {
      /**
       * List objects.
       * @returns [{ id, name }] for every object.
       */
      list: (): Array<{ id: string; name: string }> =>
        requireProject(deps).metadata.objects.map((o) => ({
          id: o.id,
          name: o.name,
        })),

      /**
       * Get one object with its full description and image/scene links.
       * @param id - The object id.
       * @returns A deep-cloned ComicObject snapshot, or null when not found. Read-only.
       */
      get: (id: string): ComicObject | null => {
        const o = requireProject(deps).metadata.objects.find((ob) => ob.id === id);
        return o ? snapshot(o) : null;
      },

      /**
       * Create an object.
       * @param input - { name, description?, imageIds?, linkIds? }: linkIds are scene ids where the object appears.
       * @returns The new ComicObject.
       */
      create: (input: StoryEntryInput): ComicObject => {
        const o: ComicObject = {
          id: newId('obj'),
          name: input.name,
          description: input.description ?? '',
          imageIds: input.imageIds ?? [],
          sceneIds: input.linkIds ?? [],
        };
        deps.updateProject((p) => {
          p.metadata.objects.push(o);
        });
        return snapshot(o);
      },

      /**
       * Update an object's name, description, or image/scene links.
       * Only the given fields change.
       * @param id - The object id.
       * @param patch - { name?, description?, imageIds?, linkIds? }.
       * @returns A deep-cloned ComicObject snapshot, or null when not found.
       */
      update: (id: string, patch: StoryEntryPatch): ComicObject | null => {
        let updated: ComicObject | undefined;
        deps.updateProject((p) => {
          const o = p.metadata.objects.find((ob) => ob.id === id);
          if (!o) throw new Error(`Object "${id}" not found.`);
          if (patch.name !== undefined) o.name = patch.name;
          if (patch.description !== undefined) o.description = patch.description;
          if (patch.imageIds !== undefined) o.imageIds = patch.imageIds;
          if (patch.linkIds !== undefined) o.sceneIds = patch.linkIds;
          updated = o;
        });
        return updated ? snapshot(updated) : null;
      },

      /**
       * Delete an object.
       * @param id - The object id.
       * @returns True when an object was removed, false when not found.
       */
      delete: (id: string): boolean => {
        let removed = false;
        deps.updateProject((p) => {
          const idx = p.metadata.objects.findIndex((ob) => ob.id === id);
          if (idx >= 0) {
            p.metadata.objects.splice(idx, 1);
            removed = true;
          }
        });
        return removed;
      },
    },

    /**
     * The project's media registry: image files in the Drive project folder.
     * Layers (via mediaId) and characters/scenes/objects (via imageIds) refer
     * to these entries instead of raw URLs.
     */
    media: {
      /**
       * List every registered media file.
       * @returns Deep-cloned MediaItem snapshots. Read-only.
       */
      list: (): MediaItem[] => snapshot(requireProject(deps).metadata.media),

      /**
       * Get one media entry.
       * @param id - The media id.
       * @returns A deep-cloned MediaItem snapshot, or null when not found. Read-only. Note: fetching media.url bytes needs a valid Drive access token.
       */
      get: (id: string): MediaItem | null => {
        const m = requireProject(deps).metadata.media.find((mm) => mm.id === id);
        return m ? snapshot(m) : null;
      },

      /**
       * Upload image bytes to the current project folder on Drive and register
       * the file in metadata.media. Use this for LLM-generated art: upload the
       * PNG, then wire the returned id into a layer (mediaId) or a character /
       * scene / object (imageIds).
       * @param name - File name, e.g. "hero-front.png".
       * @param dataUrl - The image bytes as a data: URL (e.g. from a generated PNG).
       * @param opts - Optional { mimeType }: defaults to "image/png".
       * @returns A promise resolving to the new MediaItem.
       */
      upload: (name: string, dataUrl: string, opts?: { mimeType?: string }): Promise<MediaItem> =>
        deps.uploadStorageMedia(name, dataUrl, opts?.mimeType ?? 'image/png'),
    },
  };

  return ComicBuilder;
}

/** The window.ComicBuilder API type. */
export type ComicBuilderApi = ReturnType<typeof createComicBuilder>;

/**
 * Install the ComicBuilder API on window. Attaches the extracted JSDoc as
 * each node's toString(). Safe to call once per App mount.
 */
export function installComicBuilder(deps: ComicBuilderDeps): void {
  const api = createComicBuilder(deps);
  try {
    attachDocs(api, ACTION_DOCS, 'ComicBuilder');
  } catch {
    /* docs are best-effort; the API works without them */
  }
  window.ComicBuilder = api;
}

/** Remove the ComicBuilder API from window. */
export function uninstallComicBuilder(): void {
  if (window.ComicBuilder) {
    delete window.ComicBuilder;
  }
}
