/**
 * Google Drive integration for the comic builder.
 *
 * Uses Google Identity Services (GIS) OAuth 2.0 entirely client-side —
 * there is no backend. On first open the app checks for a valid Drive
 * access token; if missing (or the OAuth client ID is not configured)
 * the UI shows a prompt explaining why Drive access is needed.
 *
 * Scope requested: https://www.googleapis.com/auth/drive.file
 * ("See, edit, create, and delete only the specific Google Drive files
 *  you use with this app"). The app can only touch files it created
 *  or that the user explicitly opened with it — nothing else in Drive.
 *
 * Tokens are kept in localStorage with an expiry timestamp. Access
 * tokens last ~1 hour; when expired the user is prompted to reconnect.
 */

const GIS_SCRIPT_URL = "https://accounts.google.com/gsi/client";
const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const TOKEN_STORAGE_KEY = "cb_drive_token";
const FOLDER_STORAGE_KEY = "cb_drive_folder";

interface StoredToken {
  access_token: string;
  /** epoch ms */
  expires_at: number;
}

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    google?: any;
  }
}

export function getClientId(): string | null {
  const id = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
  return id && id.trim().length > 0 ? id : null;
}

let gisLoadPromise: Promise<void> | null = null;

function loadGisScript(): Promise<void> {
  if (gisLoadPromise) return gisLoadPromise;
  gisLoadPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(new Error("Failed to load Google Identity Services script."));
    document.head.appendChild(script);
  });
  return gisLoadPromise;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tokenClient: any = null;

function readStoredToken(): StoredToken | null {
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as StoredToken;
    if (!t.access_token || !t.expires_at) return null;
    return t;
  } catch {
    return null;
  }
}

/** True when we have an unexpired Drive access token. */
export function hasDriveAccess(): boolean {
  const t = readStoredToken();
  return !!t && t.expires_at > Date.now() + 60_000;
}

export function getAccessToken(): string | null {
  const t = readStoredToken();
  if (!t || t.expires_at <= Date.now() + 60_000) return null;
  return t.access_token;
}

function storeToken(accessToken: string, expiresInSec: number): void {
  const t: StoredToken = {
    access_token: accessToken,
    expires_at: Date.now() + expiresInSec * 1000,
  };
  localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(t));
}

export function clearDriveAccess(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

/**
 * Prompt the user to grant Drive access. Must be called from a user
 * gesture (button click) — browsers block OAuth popups otherwise.
 * Resolves with the access token.
 */
export async function requestDriveAccess(): Promise<string> {
  const clientId = getClientId();
  if (!clientId) {
    throw new Error(
      "Google OAuth client ID is not configured. Set VITE_GOOGLE_CLIENT_ID."
    );
  }
  await loadGisScript();
  return new Promise((resolve, reject) => {
    try {
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: DRIVE_FILE_SCOPE,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        callback: (resp: any) => {
          if (resp?.error) {
            reject(new Error(resp.error_description || resp.error));
            return;
          }
          const expiresIn = Number(resp.expires_in) || 3600;
          storeToken(resp.access_token, expiresIn);
          resolve(resp.access_token);
        },
        error_callback: (err: unknown) =>
          reject(err instanceof Error ? err : new Error(String(err))),
      });
      tokenClient.requestAccessToken({ prompt: "consent" });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/** Revoke the token at Google and clear local state. */
export async function disconnectDrive(): Promise<void> {
  const token = readStoredToken();
  clearDriveAccess();
  if (token && window.google?.accounts?.oauth2) {
    window.google.accounts.oauth2.revoke(token.access_token, () => undefined);
  }
}

// ---------------------------------------------------------------------------
// Drive API helpers (fetch-based, no gapi needed)
// ---------------------------------------------------------------------------

async function driveFetch(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const token = getAccessToken();
  if (!token) throw new Error("Not connected to Google Drive.");
  const res = await fetch(`https://www.googleapis.com/drive/v3${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Drive API error ${res.status}: ${body.slice(0, 200)}`);
  }
  return res;
}

export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  thumbnailLink?: string;
}

/** Find (or create) the folder that holds this comic's files. */
export async function ensureProjectFolder(
  folderName: string
): Promise<DriveFileMeta> {
  const q = encodeURIComponent(
    `mimeType='application/vnd.google-apps.folder' and name='${folderName.replace(
      /'/g,
      "\\'"
    )}' and trashed=false`
  );
  const res = await driveFetch(
    `/files?q=${q}&fields=files(id,name,mimeType)&pageSize=1`
  );
  const data = await res.json();
  if (data.files?.length) return data.files[0] as DriveFileMeta;

  const create = await driveFetch("/files?fields=id,name,mimeType", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
    }),
  });
  return (await create.json()) as DriveFileMeta;
}

/** List image files inside a folder (newest first). */
export async function listImages(folderId: string): Promise<DriveFileMeta[]> {
  const q = encodeURIComponent(
    `'${folderId}' in parents and mimeType contains 'image/' and trashed=false`
  );
  const res = await driveFetch(
    `/files?q=${q}&fields=files(id,name,mimeType,thumbnailLink)&orderBy=createdTime desc&pageSize=100`
  );
  const data = await res.json();
  return (data.files || []) as DriveFileMeta[];
}

/** Upload an image file into a folder. Returns the created file metadata. */
export async function uploadImage(
  folderId: string,
  file: File,
  name?: string
): Promise<DriveFileMeta> {
  const metadata = { name: name || file.name, parents: [folderId] };
  const boundary = `cb-${Date.now()}`;
  const body = new Blob(
    [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata),
      `\r\n--${boundary}\r\nContent-Type: ${file.type || "image/png"}\r\n\r\n`,
      file,
      `\r\n--${boundary}--`,
    ],
    { type: `multipart/related; boundary=${boundary}` }
  );
  const token = getAccessToken();
  if (!token) throw new Error("Not connected to Google Drive.");
  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType",
    { method: "POST", headers: { Authorization: `Bearer ${token}` }, body }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Drive upload failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json()) as DriveFileMeta;
}

/** Download a file's bytes as a Blob. */
export async function downloadFile(fileId: string): Promise<Blob> {
  const res = await driveFetch(`/files/${fileId}?alt=media`);
  return await res.blob();
}

/** Save the project JSON into the project folder (creates or overwrites project.json). */
export async function saveProjectJson(
  folderId: string,
  project: unknown
): Promise<DriveFileMeta> {
  const json = JSON.stringify(project, null, 2);
  const q = encodeURIComponent(
    `'${folderId}' in parents and name='project.json' and trashed=false`
  );
  const list = await driveFetch(`/files?q=${q}&fields=files(id)&pageSize=1`);
  const existing = (await list.json()).files?.[0];

  const token = getAccessToken();
  if (!token) throw new Error("Not connected to Google Drive.");
  const body = new Blob([json], { type: "application/json" });

  if (existing) {
    const res = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body,
      }
    );
    if (!res.ok) throw new Error(`Drive update failed (${res.status}).`);
    return { id: existing.id, name: "project.json", mimeType: "application/json" };
  }

  const metadata = { name: "project.json", parents: [folderId] };
  const boundary = `cb-${Date.now()}`;
  const multipart = new Blob(
    [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata),
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`,
      json,
      `\r\n--${boundary}--`,
    ],
    { type: `multipart/related; boundary=${boundary}` }
  );
  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType",
    { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: multipart }
  );
  if (!res.ok) throw new Error(`Drive upload failed (${res.status}).`);
  return (await res.json()) as DriveFileMeta;
}

/** Load project.json from the project folder. */
export async function loadProjectJson(folderId: string): Promise<unknown> {
  const q = encodeURIComponent(
    `'${folderId}' in parents and name='project.json' and trashed=false`
  );
  const list = await driveFetch(`/files?q=${q}&fields=files(id)&pageSize=1`);
  const file = (await list.json()).files?.[0];
  if (!file) throw new Error("No project.json found in this Drive folder.");
  const res = await driveFetch(`/files/${file.id}?alt=media`);
  return await res.json();
}

// ---------------------------------------------------------------------------
// Remembered project folder
// ---------------------------------------------------------------------------

export function getStoredFolderId(): string | null {
  return localStorage.getItem(FOLDER_STORAGE_KEY);
}

export function storeFolderId(id: string): void {
  localStorage.setItem(FOLDER_STORAGE_KEY, id);
}
