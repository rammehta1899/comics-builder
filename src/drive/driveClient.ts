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
 * Token lifetime: the Drive access token is held only in this module's
 * memory. It is never written to localStorage, sessionStorage, cookies,
 * or the URL. This matches Google's own guidance for browser-based OAuth
 * 2.0 apps — their web code-model guide keeps the access token "in
 * browser memory" (e.g. via gapi.client.setToken) — and the OAuth 2.0
 * security BCP (RFC 9700), which warns against storing tokens in web
 * storage where an XSS flaw could exfiltrate them.
 *
 * Trade-off: reloading the page drops the token, so Drive is reconnected
 * with one click per browser session (the GIS popup usually re-authorizes
 * silently, and the app prompts for it when the token is missing/expired).
 * The remembered project *folder id* is not a secret, so it stays in
 * localStorage and a reconnect re-opens the same folder.
 *
 * Headless browsers (e.g. an AI assistant driving the page via Playwright)
 * cannot complete the GIS popup, so the module also implements Google's
 * OAuth 2.0 device authorization flow (RFC 8628):
 * `requestDeviceAccess()` returns a verification URL + user code for the
 * user to approve on any other device, then polls Google in the background
 * until the token arrives. The device flow needs the device client's
 * secret at the token exchange — it ships in the app bundle by design.
 * Google's device-client model assumes distributed apps cannot keep
 * secrets (the same model rclone uses); the secret only identifies the
 * client, the scope stays limited to drive.file, and the access token
 * itself is still memory-only.
 */

const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_STORAGE_KEY = 'cb_drive_folder';

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
    const script = document.createElement('script');
    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google Identity Services script.'));
    document.head.appendChild(script);
  });
  return gisLoadPromise;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tokenClient: any = null;

// The access token lives only in module memory (see the header comment);
// there is deliberately no persistent token storage.
let tokenInMemory: StoredToken | null = null;

function readStoredToken(): StoredToken | null {
  return tokenInMemory;
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
  tokenInMemory = {
    access_token: accessToken,
    expires_at: Date.now() + expiresInSec * 1000,
  };
}

export function clearDriveAccess(): void {
  tokenInMemory = null;
}

/**
 * Prompt the user to grant Drive access. Must be called from a user
 * gesture (button click) — browsers block OAuth popups otherwise.
 * Resolves with the access token.
 */
export async function requestDriveAccess(): Promise<string> {
  const clientId = getClientId();
  if (!clientId) {
    throw new Error('Google OAuth client ID is not configured. Set VITE_GOOGLE_CLIENT_ID.');
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
      tokenClient.requestAccessToken({ prompt: 'consent' });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/** Revoke the token at Google and clear local state. */
export async function disconnectDrive(): Promise<void> {
  cancelDeviceAccess();
  const token = readStoredToken();
  clearDriveAccess();
  if (token && window.google?.accounts?.oauth2) {
    window.google.accounts.oauth2.revoke(token.access_token, () => undefined);
  }
}

// ---------------------------------------------------------------------------
// OAuth 2.0 device authorization flow (RFC 8628) — for headless browsers and
// AI assistants that cannot complete the GIS popup.
// ---------------------------------------------------------------------------

const DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
const DEVICE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/**
 * What requestDeviceAccess() hands back: show `url` and `code` to the user
 * (an agent relays them to its human), who approves on any other device.
 */
export interface DeviceCodeInfo {
  /** e.g. https://www.google.com/device — the user opens this anywhere. */
  url: string;
  /** e.g. "ABCD-EFGH" — the user types this at the URL above. */
  code: string;
  /** Seconds until the code expires (Google currently sends 1800). */
  expiresInSeconds: number;
}

export function getDeviceClientId(): string | null {
  const id = import.meta.env.VITE_GOOGLE_DEVICE_CLIENT_ID as string | undefined;
  return id && id.trim().length > 0 ? id : null;
}

function getDeviceClientSecret(): string | null {
  const s = import.meta.env.VITE_GOOGLE_DEVICE_CLIENT_SECRET as string | undefined;
  return s && s.trim().length > 0 ? s : null;
}

/** True when the device-flow client ID and secret are both configured. */
export function isDeviceFlowConfigured(): boolean {
  return !!getDeviceClientId() && !!getDeviceClientSecret();
}

async function postForm(url: string, params: Record<string, string>): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Google OAuth error ${res.status}: ${body.slice(0, 200)}`);
  }
  return await res.json();
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll Google's token endpoint until the user approves (or denies / the
 * code expires). Handles authorization_pending, slow_down, access_denied,
 * and expired_token per RFC 8628 §3.5. On success the access token is
 * stored in module memory exactly like the popup flow's token.
 */
async function pollDeviceToken(
  clientId: string,
  clientSecret: string,
  deviceCode: string,
  baseIntervalSec: number,
  expiresInSec: number,
  signal: AbortSignal
): Promise<string> {
  const deadline = Date.now() + expiresInSec * 1000;
  let intervalSec = baseIntervalSec;
  for (;;) {
    if (signal.aborted) throw new Error('Device authorization was cancelled.');
    if (Date.now() >= deadline) {
      throw new Error('The device code expired before approval. Start over.');
    }
    await sleep(intervalSec * 1000);
    let data: any;
    try {
      data = await postForm(DEVICE_TOKEN_URL, {
        client_id: clientId,
        client_secret: clientSecret,
        device_code: deviceCode,
        grant_type: DEVICE_GRANT_TYPE,
      });
    } catch {
      continue; // transient network error — keep polling until the deadline
    }
    if (data?.access_token) {
      storeToken(data.access_token, Number(data.expires_in) || 3600);
      return data.access_token as string;
    }
    const err = data?.error as string | undefined;
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') {
      intervalSec += 5;
      continue;
    }
    if (err === 'access_denied') {
      throw new Error('The user denied the device authorization request.');
    }
    if (err === 'expired_token') {
      throw new Error('The device code expired before approval. Start over.');
    }
    throw new Error(
      `Device authorization failed: ${data?.error_description || err || 'unknown error'}.`
    );
  }
}

let activeDevicePoll: { promise: Promise<string>; cancel: () => void } | null = null;

/** Stop any in-progress device authorization poll. */
export function cancelDeviceAccess(): void {
  activeDevicePoll?.cancel();
  activeDevicePoll = null;
}

/**
 * Start the device flow: request a user code from Google and begin
 * polling for the token in the background. Resolves promptly with the
 * { url, code, expiresInSeconds } to show the user — it does NOT wait
 * for approval. Await awaitDeviceAccess() (or poll hasDriveAccess()) for
 * the token. Starting a new flow cancels any previous one.
 */
export async function requestDeviceAccess(): Promise<DeviceCodeInfo> {
  const clientId = getDeviceClientId();
  const clientSecret = getDeviceClientSecret();
  if (!clientId || !clientSecret) {
    throw new Error('Device connect is not configured (missing Google device OAuth client).');
  }
  cancelDeviceAccess();
  const data: any = await postForm(DEVICE_CODE_URL, {
    client_id: clientId,
    scope: DRIVE_FILE_SCOPE,
  });
  if (data?.error || !data?.device_code) {
    throw new Error(
      `Could not start device authorization: ${data?.error_description || data?.error || 'unknown error'}.`
    );
  }
  const controller = new AbortController();
  const promise = pollDeviceToken(
    clientId,
    clientSecret,
    data.device_code as string,
    Number(data.interval) || 5,
    Number(data.expires_in) || 1800,
    controller.signal
  );
  // Avoid an unhandled rejection if nobody awaits; awaiters still see it.
  promise.catch(() => undefined);
  activeDevicePoll = { promise, cancel: () => controller.abort() };
  return {
    url: data.verification_url as string,
    code: data.user_code as string,
    expiresInSeconds: Number(data.expires_in) || 1800,
  };
}

/**
 * Resolve when the in-progress device authorization completes (token is
 * then in memory). Rejects on denial, expiry, or cancellation.
 */
export function awaitDeviceAccess(): Promise<string> {
  if (!activeDevicePoll) throw new Error('No device authorization in progress.');
  return activeDevicePoll.promise;
}

// ---------------------------------------------------------------------------
// Drive API helpers (fetch-based, no gapi needed)
// ---------------------------------------------------------------------------

async function driveFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getAccessToken();
  if (!token) throw new Error('Not connected to Google Drive.');
  const res = await fetch(`https://www.googleapis.com/drive/v3${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
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

/** List folders this app created (drive.file scope restricts to app-created files). */
export async function listProjectFolders(): Promise<Array<{ id: string; name: string }>> {
  const q = encodeURIComponent("mimeType='application/vnd.google-apps.folder' and trashed=false");
  const res = await driveFetch(`/files?q=${q}&fields=files(id,name)&orderBy=name&pageSize=100`);
  const data = await res.json();
  return (data.files || []) as Array<{ id: string; name: string }>;
}

/** Find (or create) the folder that holds this comic's files. */
export async function ensureProjectFolder(folderName: string): Promise<DriveFileMeta> {
  const q = encodeURIComponent(
    `mimeType='application/vnd.google-apps.folder' and name='${folderName.replace(
      /'/g,
      "\\'"
    )}' and trashed=false`
  );
  const res = await driveFetch(`/files?q=${q}&fields=files(id,name,mimeType)&pageSize=1`);
  const data = await res.json();
  if (data.files?.length) return data.files[0] as DriveFileMeta;

  const create = await driveFetch('/files?fields=id,name,mimeType', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
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
      `\r\n--${boundary}\r\nContent-Type: ${file.type || 'image/png'}\r\n\r\n`,
      file,
      `\r\n--${boundary}--`,
    ],
    { type: `multipart/related; boundary=${boundary}` }
  );
  const token = getAccessToken();
  if (!token) throw new Error('Not connected to Google Drive.');
  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType',
    { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
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
export async function saveProjectJson(folderId: string, project: unknown): Promise<DriveFileMeta> {
  const json = JSON.stringify(project, null, 2);
  const q = encodeURIComponent(
    `'${folderId}' in parents and name='project.json' and trashed=false`
  );
  const list = await driveFetch(`/files?q=${q}&fields=files(id)&pageSize=1`);
  const existing = (await list.json()).files?.[0];

  const token = getAccessToken();
  if (!token) throw new Error('Not connected to Google Drive.');
  const body = new Blob([json], { type: 'application/json' });

  if (existing) {
    const res = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
      }
    );
    if (!res.ok) throw new Error(`Drive update failed (${res.status}).`);
    return { id: existing.id, name: 'project.json', mimeType: 'application/json' };
  }

  const metadata = { name: 'project.json', parents: [folderId] };
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
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType',
    { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: multipart }
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
  if (!file) throw new Error('No project.json found in this Drive folder.');
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

/** Forget the remembered project folder (used on full Drive disconnect). */
export function clearStoredFolderId(): void {
  localStorage.removeItem(FOLDER_STORAGE_KEY);
}
