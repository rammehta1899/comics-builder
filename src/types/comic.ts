// Generic comic project data model.
// A comic project is loaded from a JSON data file (local or on Google Drive),
// never hardcoded. Page numbers are formatted as 00, 01, 02, ... in the UI.

export type LayerKind = "background" | "foreground";
export type BubbleKind = "speech" | "thought" | "caption";

export interface Layer {
  id: string;
  name: string;
  kind: LayerKind;
  /** Image URL (https URL, blob URL, or data URL). Optional driveFileId lets us re-fetch from Drive. */
  src: string;
  driveFileId?: string;
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
  layers: Layer[];
  bubbles: Bubble[];
}

export interface ComicPage {
  id: string;
  /** Zero-based page index. Displayed as 00, 01, 02, ... */
  number: number;
  title: string;
  panels: Panel[];
}

export interface ComicProject {
  id: string;
  title: string;
  pages: ComicPage[];
  updatedAt: string;
}

export function formatPageNumber(n: number): string {
  return n.toString().padStart(2, "0");
}
