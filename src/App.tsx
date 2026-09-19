import { useEffect, useRef, useState } from 'react';
import PanelView from './components/PanelView';
import { installComicBuilder, uninstallComicBuilder } from './ai/actions';
import type { ComicBuilderDeps } from './ai/actions';
import {
  awaitDeviceAccess,
  cancelDeviceAccess,
  clearStoredFolderId,
  disconnectDrive,
  downloadFile,
  ensureProjectFolder,
  getAccessToken,
  hasDriveAccess,
  listProjectFolders,
  loadProjectJson,
  requestDeviceAccess,
  requestDriveAccess,
  saveProjectJson,
  storeFolderId,
  uploadImage,
} from './drive/driveClient';
import type { DeviceCodeInfo } from './drive/driveClient';
import { assertValidProject, createBlankProject } from './state/project';
import type { ComicProject, MediaItem } from './types/comic';
import { formatPageNumber } from './types/comic';

type Screen = 'splash' | 'tiles' | 'editor';

/** The installed window.ComicBuilder API. Every UI control calls through here. */
function cb() {
  const api = window.ComicBuilder;
  if (!api) throw new Error('ComicBuilder API is not installed yet.');
  return api;
}

function dataUrlToFile(dataUrl: string, name: string, mimeType: string): File {
  const m = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!m) throw new Error('media.upload expects the image as a data: URL.');
  const mime = m[1] || mimeType;
  const bin = atob(m[3] ?? '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: mime });
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('splash');
  const [preview, setPreview] = useState(false);
  const [project, setProject] = useState<ComicProject | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [folders, setFolders] = useState<Array<{ id: string; name: string }>>([]);
  const [status, setStatus] = useState('');
  const [deviceCode, setDeviceCode] = useState<DeviceCodeInfo | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [showNewModal, setShowNewModal] = useState(false);
  const [newName, setNewName] = useState('');
  const [whyOpen, setWhyOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // Refs mirror state so the ComicBuilder deps always see the latest values.
  const projectRef = useRef<ComicProject | null>(null);
  const pageIndexRef = useRef(0);
  const folderIdRef = useRef<string | null>(null);
  const savingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Resolve Drive-hosted layer images to blob URLs for display. */
  async function hydrateDriveImages(p: ComicProject): Promise<void> {
    for (const page of p.pages) {
      for (const panel of page.panels) {
        for (const layer of panel.layers) {
          if (layer.driveFileId && !layer.src) {
            const blob = await downloadFile(layer.driveFileId);
            layer.src = URL.createObjectURL(blob);
          }
        }
      }
    }
  }

  /** Write the current project to Drive now. Returns false when skipped. */
  async function flushSave(): Promise<boolean> {
    const p = projectRef.current;
    const folderId = folderIdRef.current;
    if (!p || savingRef.current || !getAccessToken() || !folderId) return false;
    savingRef.current = true;
    setSaveState('saving');
    try {
      const at = new Date().toISOString();
      const stamped = { ...p, savedAt: at, updatedAt: at };
      await saveProjectJson(folderId, stamped);
      projectRef.current = stamped;
      setProject(stamped);
      setSaveState('saved');
      return true;
    } catch (e) {
      setSaveState('error');
      setStatus(`Autosave failed: ${e instanceof Error ? e.message : e}`);
      return false;
    } finally {
      savingRef.current = false;
    }
  }

  /** Load project.json from a folder into the editor. */
  async function openFolder(id: string, name: string): Promise<{ ok: boolean; error?: string }> {
    setStatus('Loading project…');
    try {
      const raw = await loadProjectJson(id);
      assertValidProject(raw);
      await hydrateDriveImages(raw);
      folderIdRef.current = id;
      storeFolderId(id);
      projectRef.current = raw;
      setProject(raw);
      pageIndexRef.current = 0;
      setPageIndex(0);
      setPreview(false);
      setScreen('editor');
      setStatus(`Opened "${raw.title}".`);
      return { ok: true };
    } catch (e) {
      const msg = `Could not open "${name}": ${e instanceof Error ? e.message : e}`;
      setStatus(msg);
      return { ok: false, error: msg };
    }
  }

  async function refreshTiles(): Promise<Array<{ id: string; name: string }>> {
    try {
      const list = await listProjectFolders();
      setFolders(list);
      return list;
    } catch (e) {
      setStatus(`Could not list Drive folders: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  // Install window.ComicBuilder once. All helpers above use refs + setState,
  // so the deps never go stale.
  useEffect(() => {
    const deps: ComicBuilderDeps = {
      getProject: () => projectRef.current,

      updateProject: (mut) => {
        const p = projectRef.current;
        if (!p) throw new Error('No project is open.');
        const next = structuredClone(p);
        mut(next);
        next.updatedAt = new Date().toISOString();
        projectRef.current = next;
        setProject(next);
      },

      replaceProject: (p) => {
        projectRef.current = p;
        setProject(p);
        pageIndexRef.current = 0;
        setPageIndex(0);
        setPreview(false);
      },

      getPageIndex: () => pageIndexRef.current,

      setPageIndex: (i) => {
        pageIndexRef.current = i;
        setPageIndex(i);
      },

      setPreview: (open) => setPreview(open),

      setStatus: (msg) => setStatus(msg),

      connectStorage: async () => {
        try {
          await requestDriveAccess();
          await refreshTiles();
          setScreen('tiles');
          setStatus('Connected to Google Drive.');
        } catch (e) {
          setStatus(`Could not connect: ${e instanceof Error ? e.message : e}`);
        }
      },

      connectStorageWithDevice: async () => {
        const info = await requestDeviceAccess();
        setDeviceCode(info);
        setStatus(`Go to ${info.url} and enter code ${info.code} to connect.`);
        void (async () => {
          try {
            await awaitDeviceAccess();
            await refreshTiles();
            setDeviceCode(null);
            setScreen('tiles');
            setStatus('Connected to Google Drive.');
          } catch (e) {
            setDeviceCode(null);
            setStatus(`Could not connect: ${e instanceof Error ? e.message : e}`);
          }
        })();
        return info;
      },

      disconnectStorage: async () => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        cancelDeviceAccess();
        setDeviceCode(null);
        try {
          await disconnectDrive();
        } catch {
          /* revoke is best-effort */
        }
        clearStoredFolderId();
        folderIdRef.current = null;
        projectRef.current = null;
        setProject(null);
        setFolders([]);
        setPreview(false);
        setSaveState('idle');
        setScreen('splash');
        setStatus('Disconnected from Google Drive.');
      },

      getStorageStatus: () => ({
        connected: hasDriveAccess(),
        configured: true,
      }),

      listStorageProjects: () => listProjectFolders(),

      createStorageProject: async (name) => {
        const clean = name.trim();
        if (!clean) throw new Error('Project name is required.');
        const folder = await ensureProjectFolder(clean);
        let raw: ComicProject;
        try {
          const existing = await loadProjectJson(folder.id);
          assertValidProject(existing);
          raw = existing;
          await hydrateDriveImages(raw);
        } catch {
          raw = createBlankProject(clean);
          await saveProjectJson(folder.id, raw);
        }
        folderIdRef.current = folder.id;
        storeFolderId(folder.id);
        projectRef.current = raw;
        setProject(raw);
        pageIndexRef.current = 0;
        setPageIndex(0);
        setPreview(false);
        setScreen('editor');
        setStatus(`Created "${clean}".`);
        return { id: folder.id, name: folder.name };
      },

      openStorageProject: (id) => {
        const f = folders.find((x) => x.id === id);
        return openFolder(id, f?.name ?? id);
      },

      closeStorageProject: () => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        projectRef.current = null;
        setProject(null);
        pageIndexRef.current = 0;
        setPageIndex(0);
        setPreview(false);
        setSaveState('idle');
        void refreshTiles().then(() => setScreen('tiles'));
        setStatus('Project closed.');
      },

      showProjectTiles: async () => {
        const list = await refreshTiles();
        setScreen('tiles');
        return list;
      },

      flushStorageSave: async () => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        const ok = await flushSave();
        return ok
          ? { ok: true }
          : { ok: false, error: 'Nothing to save, or Drive is not connected.' };
      },

      uploadStorageMedia: async (name, dataUrl, mimeType) => {
        const folderId = folderIdRef.current;
        if (!folderId) throw new Error('No project folder is open.');
        const file = dataUrlToFile(dataUrl, name, mimeType);
        const meta = await uploadImage(folderId, file, name);
        const item: MediaItem = {
          id: `media-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          name: meta.name,
          driveFileId: meta.id,
          url: `https://www.googleapis.com/drive/v3/files/${meta.id}?alt=media`,
          mimeType: meta.mimeType || mimeType,
        };
        // `deps` is assigned by the time this runs; the closure is safe.
        deps.updateProject((p) => {
          p.metadata.media.push(item);
        });
        return structuredClone(item);
      },
    };

    installComicBuilder(deps);
    if (hasDriveAccess()) {
      void refreshTiles().then(() => setScreen('tiles'));
    }
    return () => uninstallComicBuilder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autosave: every project change is written to Drive ~2s after the last
  // edit. No manual save button.
  useEffect(() => {
    if (!project || screen !== 'editor') return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void flushSave();
    }, 2000);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, screen]);

  // ------------------------------------------------------------------ UI ---

  if (screen === 'splash') {
    return (
      <div className="min-vh-100 d-flex align-items-center justify-content-center bg-light p-3">
        <div className="card shadow" style={{ maxWidth: 540, width: '100%' }}>
          <div className="card-body p-4">
            <h1 className="card-title h4 mb-3">Connect to Google Drive</h1>
            <p className="card-text">
              Comic Builder keeps your comic — its pages, artwork, and project file — on your Google
              Drive. Nothing is ever uploaded to our servers.
            </p>
            <p className="card-text">Connect once per browser session to open the editor.</p>
            <button
              className="btn btn-link p-0 mb-3"
              onClick={() => setWhyOpen((v) => !v)}
              aria-expanded={whyOpen}
            >
              Why do we need this access?
            </button>
            <div className={`collapse${whyOpen ? ' show' : ''}`}>
              <div className="card card-body bg-light small mb-3">
                <p>
                  Comic Builder is a static website: it has no server and no database of its own.
                  Your comic's <code>project.json</code> and every artwork file live in a folder on{' '}
                  <strong>your</strong> Google Drive, and the app reads and writes them directly
                  from your browser.
                </p>
                <p>
                  The app asks for the <code>drive.file</code> scope only, which means it can see
                  and touch <strong>just</strong> the files and folders it created — it is blind to
                  everything else on your Drive.
                </p>
                <p>
                  Your access token is kept only in the page's memory and is never written to
                  storage or cookies; reloading the page drops it, and one click reconnects.
                  Disconnecting revokes the grant at Google entirely.
                </p>
                <p className="mb-0">
                  <strong>If you can't connect, the app cannot work at all:</strong> there is
                  nowhere else for it to load your comic from or save it to. The editor stays locked
                  until Drive is connected.
                </p>
              </div>
            </div>
            {status && <div className="alert alert-warning">{status}</div>}
            <button
              className="btn btn-primary btn-lg w-100"
              onClick={() => void cb().storage.connect()}
            >
              Connect with Google Drive
            </button>
            <button
              className="btn btn-outline-primary w-100 mt-2"
              onClick={() => void cb().storage.connectWithDevice()}
            >
              Connect with a code (for AI assistants)
            </button>
            {deviceCode && (
              <div className="alert alert-info mt-3">
                <p className="mb-1">
                  <strong>On your phone or another browser, go to:</strong>
                </p>
                <p>
                  <a href={deviceCode.url} target="_blank" rel="noreferrer">
                    {deviceCode.url}
                  </a>
                </p>
                <p className="mb-1">Enter this code:</p>
                <p className="display-6 fw-bold text-center">{deviceCode.code}</p>
                <p className="mb-0 text-muted">
                  The code expires in {Math.round(deviceCode.expiresInSeconds / 60)} minutes. This
                  page connects automatically once you approve.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (screen === 'tiles') {
    return (
      <div className="min-vh-100 bg-light">
        <div className="container py-4">
          <div className="d-flex justify-content-between align-items-center mb-4">
            <h1 className="h4 mb-0">Your comics</h1>
            <button
              className="btn btn-outline-secondary btn-sm"
              onClick={() => void cb().storage.disconnect()}
            >
              Disconnect Drive
            </button>
          </div>
          {status && <div className="alert alert-info">{status}</div>}
          <div className="row g-3">
            {folders.map((f) => (
              <div className="col-12 col-sm-6 col-md-4" key={f.id}>
                <div className="card h-100 shadow-sm">
                  <div className="card-body d-flex flex-column">
                    <h2 className="card-title h6 text-truncate">{f.name}</h2>
                    <button
                      className="btn btn-primary mt-auto align-self-start"
                      onClick={() => void cb().storage.openProject(f.id)}
                    >
                      Open
                    </button>
                  </div>
                </div>
              </div>
            ))}
            <div className="col-12 col-sm-6 col-md-4">
              <button
                className="card h-100 w-100 shadow-sm border-2 text-center p-4"
                style={{ borderStyle: 'dashed', minHeight: 120 }}
                onClick={() => setShowNewModal(true)}
              >
                <span className="h1 mb-1">+</span>
                <span className="fw-semibold">New project</span>
              </button>
            </div>
          </div>
        </div>

        {showNewModal && (
          <>
            <div className="modal show d-block" tabIndex={-1} role="dialog">
              <div className="modal-dialog">
                <div className="modal-content">
                  <div className="modal-header">
                    <h2 className="modal-title h5 mb-0">New project</h2>
                    <button
                      className="btn-close"
                      aria-label="Close"
                      onClick={() => setShowNewModal(false)}
                    />
                  </div>
                  <div className="modal-body">
                    <label className="form-label" htmlFor="new-project-name">
                      Project name
                    </label>
                    <input
                      id="new-project-name"
                      className="form-control"
                      value={newName}
                      autoFocus
                      onChange={(e) => setNewName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && newName.trim()) {
                          void cb()
                            .storage.createProject(newName.trim())
                            .then(() => {
                              setShowNewModal(false);
                              setNewName('');
                            })
                            .catch((err: unknown) =>
                              setStatus(err instanceof Error ? err.message : String(err))
                            );
                        }
                      }}
                    />
                  </div>
                  <div className="modal-footer">
                    <button className="btn btn-secondary" onClick={() => setShowNewModal(false)}>
                      Cancel
                    </button>
                    <button
                      className="btn btn-primary"
                      disabled={!newName.trim()}
                      onClick={() => {
                        void cb()
                          .storage.createProject(newName.trim())
                          .then(() => {
                            setShowNewModal(false);
                            setNewName('');
                          })
                          .catch((err: unknown) =>
                            setStatus(err instanceof Error ? err.message : String(err))
                          );
                      }}
                    >
                      Create
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-backdrop show" onClick={() => setShowNewModal(false)} />
          </>
        )}
      </div>
    );
  }

  // Editor screen.
  const currentPage = project?.pages[pageIndex] ?? null;
  const saveLabel =
    saveState === 'saving'
      ? 'Saving…'
      : saveState === 'saved' && project
        ? `Saved ${new Date(project.savedAt).toLocaleTimeString()}`
        : saveState === 'error'
          ? 'Save failed — retrying on next change'
          : null;

  if (preview && currentPage) {
    return (
      <div className="bg-dark min-vh-100">
        <div className="d-flex justify-content-between align-items-center p-3">
          <span className="text-light">
            Preview — Page {formatPageNumber(currentPage.number)} · {currentPage.title}
          </span>
          <button className="btn btn-outline-light btn-sm" onClick={() => cb().page.closePreview()}>
            Close preview
          </button>
        </div>
        <div className="container pb-5">
          <div className="panels">
            {currentPage.panels.map((panel) => (
              <PanelView key={panel.id} panel={panel} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-vh-100 d-flex flex-column bg-light">
      <nav className="navbar navbar-dark bg-dark px-3">
        <span className="navbar-brand mb-0 h1 fs-5">{project?.title ?? 'Comic Builder'}</span>
        <div className="d-flex align-items-center gap-3">
          {saveLabel && <span className="navbar-text small text-nowrap">{saveLabel}</span>}
          <div className="position-relative">
            <button
              className="btn btn-outline-light btn-sm dropdown-toggle"
              onClick={() => setMenuOpen((v) => !v)}
              aria-expanded={menuOpen}
            >
              Menu
            </button>
            {menuOpen && (
              <>
                <div
                  className="position-fixed top-0 start-0 w-100 h-100"
                  style={{ zIndex: 1040 }}
                  onClick={() => setMenuOpen(false)}
                />
                <ul
                  className="dropdown-menu dropdown-menu-end show"
                  style={{ position: 'absolute', zIndex: 1041 }}
                >
                  <li>
                    <button
                      className="dropdown-item"
                      onClick={() => {
                        setMenuOpen(false);
                        void cb().storage.showProjects();
                      }}
                    >
                      Open project
                    </button>
                  </li>
                  <li>
                    <button
                      className="dropdown-item"
                      onClick={() => {
                        setMenuOpen(false);
                        cb().page.openPreview();
                      }}
                    >
                      Preview
                    </button>
                  </li>
                  <li>
                    <button
                      className="dropdown-item"
                      onClick={() => {
                        setMenuOpen(false);
                        cb().storage.closeProject();
                      }}
                    >
                      Close project
                    </button>
                  </li>
                  <li>
                    <hr className="dropdown-divider" />
                  </li>
                  <li>
                    <button
                      className="dropdown-item text-danger"
                      onClick={() => {
                        setMenuOpen(false);
                        void cb().storage.disconnect();
                      }}
                    >
                      Disconnect Drive
                    </button>
                  </li>
                </ul>
              </>
            )}
          </div>
        </div>
      </nav>

      {status && (
        <div className="alert alert-info alert-dismissible m-2 mb-0 py-2">
          {status}
          <button className="btn-close btn-sm" aria-label="Dismiss" onClick={() => setStatus('')} />
        </div>
      )}

      <div className="d-flex flex-grow-1" style={{ minHeight: 0 }}>
        <div
          className="list-group list-group-flush border-end"
          style={{ width: 220, flexShrink: 0 }}
        >
          {(project?.pages ?? []).map((pg, idx) => (
            <button
              key={pg.id}
              className={`list-group-item list-group-item-action text-truncate${
                idx === pageIndex ? ' active' : ''
              }`}
              onClick={() => cb().page.select(idx)}
            >
              <span className="fw-bold me-2">{formatPageNumber(pg.number)}</span>
              {pg.title}
            </button>
          ))}
        </div>
        <main className="flex-grow-1 p-3 overflow-auto">
          {currentPage ? (
            <>
              <h2 className="h5 mb-3">
                Page {formatPageNumber(currentPage.number)} — {currentPage.title}
              </h2>
              <div className="panels">
                {currentPage.panels.map((panel) => (
                  <PanelView key={panel.id} panel={panel} />
                ))}
              </div>
            </>
          ) : (
            <p className="text-muted">Loading…</p>
          )}
        </main>
      </div>
    </div>
  );
}
