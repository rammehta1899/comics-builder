// Generic comic project data model.
// A comic project is loaded from a JSON data file (local or on Google Drive),
// never hardcoded. Page numbers are formatted as 00, 01, 02, ... in the UI.

export type LayerKind = 'background' | 'foreground';
export type BubbleKind = 'speech' | 'thought' | 'caption';

export interface Layer {
  id: string;
  name: string;
  kind: LayerKind;
  /** Image URL (https URL, blob URL, or data URL). Optional driveFileId lets us re-fetch from Drive. */
  src: string;
  driveFileId?: string;
  /**
   * Optional link into project metadata.media: the id of the MediaItem this
   * layer's artwork came from. Lets an agent resolve the Drive file, the
   * character reference, or the prompt that produced the art.
   */
  mediaId?: string;
  visible: boolean;
  /** Position as percentages of panel size */
  x: number;
  y: number;
  width: number;
  rotation: number;
  opacity: number;
}

export interface Bubble {
  id: string;
  kind: BubbleKind;
  text: string;
  x: number;
  y: number;
  width: number;
  /** Optional tail target, percentages of panel size */
  tailX?: number;
  tailY?: number;
}

export interface Panel {
  id: string;
  title?: string;
  /**
   * Image layers, composited bottom-to-top in array order. There is no
   * separate "background" field: the background is the layer whose
   * `kind` is "background" (conventionally the first layer).
   */
  layers: Layer[];
  /** Speech/thought/caption bubbles. Bubbles always render above all layers. */
  bubbles: Bubble[];
}

export interface ComicPage {
  id: string;
  /** Zero-based page index. Displayed as 00, 01, 02, ... */
  number: number;
  title: string;
  panels: Panel[];
}

// ---------------------------------------------------------------------------
// Project metadata: story bible + media registry
// ---------------------------------------------------------------------------

/** One file in the project's media registry (lives in the Drive project folder). */
export interface MediaItem {
  id: string;
  name: string;
  driveFileId: string;
  /**
   * Drive URL for the file (thumbnail/download link). Requires a valid Drive
   * access token to fetch the bytes; safe to hand to an image model or <img>.
   */
  url: string;
  /** e.g. "image/png" */
  mimeType: string;
}

/** A character in the story bible: visual description + reference art. */
export interface Character {
  id: string;
  name: string;
  /**
   * Visual description of the character: appearance, outfit, distinctive
   * features, plus continuity notes (things that must stay consistent
   * across panels). An LLM reads this (and the referenced images) to build
   * image-generation prompts.
   */
  description: string;
  /** MediaItem ids (transparent PNG reference art for this character). */
  imageIds: string[];
  /** Scene ids this character appears in. */
  sceneIds: string[];
}

/** A scene/location in the story bible. */
export interface Scene {
  id: string;
  name: string;
  /** Setting description: location, time of day, mood, lighting. */
  description: string;
  /** Character ids that appear in this scene. */
  characterIds: string[];
  /** MediaItem ids (reference art for the scene). */
  imageIds: string[];
}

/** A prop/object in the story bible. */
export interface ComicObject {
  id: string;
  name: string;
  /** Visual description + continuity notes, like Character.description. */
  description: string;
  /** MediaItem ids (reference art for the object). */
  imageIds: string[];
  /** Scene ids where the object appears. */
  sceneIds: string[];
}

export interface ProjectMetadata {
  /** Story outline / synopsis. */
  outline: string;
  /** Physical page dimensions for the comic. */
  pageSize: PageSize;
  characters: Character[];
  scenes: Scene[];
  objects: ComicObject[];
  /** Registry of image files in the Drive project folder. */
  media: MediaItem[];
}

export interface ComicProject {
  id: string;
  title: string;
  pages: ComicPage[];
  updatedAt: string;
  /** ISO timestamp of the last autosave write. Shown in the header as "Saved …". */
  savedAt: string;
  metadata: ProjectMetadata;
}

export function formatPageNumber(n: number): string {
  return n.toString().padStart(2, '0');
}

// ---------------------------------------------------------------------------
// Page size: physical comic dimensions, chosen at project creation.
// ---------------------------------------------------------------------------

/** Physical page dimensions for the comic. */
export interface PageSize {
  /** Preset label, e.g. 'US Comic (6.625" × 10.25")'. */
  label: string;
  /** Width in inches. */
  widthIn: number;
  /** Height in inches. */
  heightIn: number;
}

/** Page-size presets offered when creating a project. */
export const PAGE_SIZE_PRESETS: PageSize[] = [
  { label: 'US Comic (6.625" × 10.25")', widthIn: 6.625, heightIn: 10.25 },
  { label: 'US Trade (6" × 9")', widthIn: 6, heightIn: 9 },
  { label: 'Manga B5 (6.93" × 9.84")', widthIn: 6.93, heightIn: 9.84 },
  { label: 'A4 (8.27" × 11.69")', widthIn: 8.27, heightIn: 11.69 },
  { label: 'Square (8" × 8")', widthIn: 8, heightIn: 8 },
  { label: 'Portrait 4:5 (8" × 10")', widthIn: 8, heightIn: 10 },
  { label: 'Landscape 16:9 (12" × 6.75")', widthIn: 12, heightIn: 6.75 },
];

/** Default page size for new projects (and old projects that predate pageSize). */
export const DEFAULT_PAGE_SIZE: PageSize = PAGE_SIZE_PRESETS[0];

/** An empty metadata block for new projects. */
export function blankMetadata(pageSize: PageSize = DEFAULT_PAGE_SIZE): ProjectMetadata {
  return {
    outline: '',
    pageSize: { ...pageSize },
    characters: [],
    scenes: [],
    objects: [],
    media: [],
  };
}
