import { useEffect, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import PanelView from './components/PanelView';
import { installComicBuilder, uninstallComicBuilder } from './ai/actions';
import type { ComicBuilderDeps } from './ai/actions';
import {
  awaitDeviceAccess,
  cancelDeviceAccess,
  clearStoredFolderId,
  deleteProjectFolder,
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
import { assertValidProject, createBlankProject, normalizeProject } from './state/project';
import type { ComicProject, MediaItem } from './types/comic';
import { DEFAULT_PAGE_SIZE, formatPageNumber, PAGE_SIZE_PRESETS } from './types/comic';

type Screen = 'splash' | 'tiles' | 'editor';
type EditorTab = 'outline' | 'characters' | 'scenes' | 'pages';

const EDITOR_TABS: Array<{ id: EditorTab; label: string }> = [
  { id: 'outline', label: 'Outline' },
  { id: 'characters', label: 'Characters' },
  { id: 'scenes', label: 'Scenes' },
  { id: 'pages', label: 'Pages' },
];

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
  const toastTimerRef = useRef<number | null>(null);
  /** Drag-and-drop page reorder: index being dragged, and drop-target index. */
  const [dragPageIdx, setDragPageIdx] = useState<number | null>(null);
  const [dropPageIdx, setDropPageIdx] = useState<number | null>(null);

  // Follow the OS light/dark setting for all Bootstrap chrome.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.setAttribute('data-bs-theme', mq.matches ? 'dark' : 'light');
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  /**
   * Show a transient popup message (toast) instead of an inline banner, so
   * notifications never take up page real estate. Auto-dismisses after 5s.
   */
  const flashStatus = (msg: string) => {
    setStatus(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = null;
    if (msg) {
      toastTimerRef.current = window.setTimeout(() => setStatus(''), 5000);
    }
  };
  const statusToast = status ? (
    <div
      className="toast show position-fixed bottom-0 start-50 translate-middle-x mb-3"
      role="status"
      style={{ zIndex: 1080, minWidth: 280, maxWidth: '90vw' }}
    >
      <div className="toast-body d-flex align-items-center gap-2">
        <span className="flex-grow-1">{status}</span>
        <button
          type="button"
          className="btn-close"
          aria-label="Dismiss"
          onClick={() => flashStatus('')}
        />
      </div>
    </div>
  ) : null;
  const [deviceCode, setDeviceCode] = useState<DeviceCodeInfo | null>(null);
  const [tab, setTab] = useState<EditorTab>('pages');
  const [menuOpen, setMenuOpen] = useState(false);
  const [tabMenuOpen, setTabMenuOpen] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [showNewModal, setShowNewModal] = useState(false);
  const [newName, setNewName] = useState('');
  const [whyOpen, setWhyOpen] = useState(false);
  const [pageSizeIdx, setPageSizeIdx] = useState(0);

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
      flashStatus(`Autosave failed: ${e instanceof Error ? e.message : e}`);
      return false;
    } finally {
      savingRef.current = false;
    }
  }

  /** Load project.json from a folder into the editor. */
  async function openFolder(id: string, name: string): Promise<{ ok: boolean; error?: string }> {
    flashStatus('Loading project…');
    try {
      const raw = await loadProjectJson(id);
      assertValidProject(raw);
      normalizeProject(raw);
      await hydrateDriveImages(raw);
      folderIdRef.current = id;
      storeFolderId(id);
      projectRef.current = raw;
      setProject(raw);
      pageIndexRef.current = 0;
      setPageIndex(0);
      setPreview(false);
      setTab('pages');
      setScreen('editor');
      flashStatus(`Opened "${raw.title}".`);
      return { ok: true };
    } catch (e) {
      const msg = `Could not open "${name}": ${e instanceof Error ? e.message : e}`;
      flashStatus(msg);
      return { ok: false, error: msg };
    }
  }

  async function refreshTiles(): Promise<Array<{ id: string; name: string }>> {
    try {
      const list = await listProjectFolders();
      setFolders(list);
      return list;
    } catch (e) {
      flashStatus(`Could not list Drive folders: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  async function removeTileProject(id: string, name: string): Promise<void> {
    if (
      !window.confirm(
        `Remove "${name}"? This permanently deletes the project folder from Google Drive and cannot be undone.`
      )
    ) {
      return;
    }
    const res = await cb().storage.removeProject(id);
    if (res.ok) {
      flashStatus(`Removed "${name}".`);
    } else {
      flashStatus(`Could not remove project: ${res.error ?? 'unknown error'}`);
    }
  }

  /**
   * Drag-and-drop props for a page button in the rail/footer. Dropping page A
   * onto page B moves A to B's position via page.move().
   */
  const pageDragProps = (idx: number) => ({
    draggable: true,
    onDragStart: (e: DragEvent<HTMLButtonElement>) => {
      e.dataTransfer.effectAllowed = 'move';
      setDragPageIdx(idx);
    },
    onDragOver: (e: DragEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropPageIdx(idx);
    },
    onDragLeave: () => setDropPageIdx((d) => (d === idx ? null : d)),
    onDrop: (e: DragEvent<HTMLButtonElement>) => {
      e.preventDefault();
      if (dragPageIdx !== null && dragPageIdx !== idx) {
        void cb().page.move(dragPageIdx, idx);
      }
      setDragPageIdx(null);
      setDropPageIdx(null);
    },
    onDragEnd: () => {
      setDragPageIdx(null);
      setDropPageIdx(null);
    },
  });

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

      setStatus: (msg) => flashStatus(msg),

      connectStorage: async () => {
        try {
          await requestDriveAccess();
          await refreshTiles();
          setScreen('tiles');
          flashStatus('');
        } catch (e) {
          flashStatus(`Could not connect: ${e instanceof Error ? e.message : e}`);
        }
      },

      connectStorageWithDevice: async () => {
        const info = await requestDeviceAccess();
        setDeviceCode(info);
        flashStatus(`Go to ${info.url} and enter code ${info.code} to connect.`);
        void (async () => {
          try {
            await awaitDeviceAccess();
            await refreshTiles();
            setDeviceCode(null);
            setScreen('tiles');
            flashStatus('');
          } catch (e) {
            setDeviceCode(null);
            flashStatus(`Could not connect: ${e instanceof Error ? e.message : e}`);
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
        setTab('pages');
        setSaveState('idle');
        setScreen('splash');
        flashStatus('Disconnected from Google Drive.');
      },

      getStorageStatus: () => ({
        connected: hasDriveAccess(),
        configured: true,
      }),

      listStorageProjects: () => listProjectFolders(),

      createStorageProject: async (name, pageSize) => {
        const clean = name.trim();
        if (!clean) throw new Error('Project name is required.');
        const folder = await ensureProjectFolder(clean);
        let raw: ComicProject;
        try {
          const existing = await loadProjectJson(folder.id);
          assertValidProject(existing);
          raw = existing;
          normalizeProject(raw);
          await hydrateDriveImages(raw);
        } catch {
          raw = createBlankProject(clean, pageSize ?? DEFAULT_PAGE_SIZE);
          await saveProjectJson(folder.id, raw);
        }
        folderIdRef.current = folder.id;
        storeFolderId(folder.id);
        projectRef.current = raw;
        setProject(raw);
        pageIndexRef.current = 0;
        setPageIndex(0);
        setPreview(false);
        setTab('pages');
        setScreen('editor');
        flashStatus(`Created "${clean}".`);
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
        setTab('pages');
        setSaveState('idle');
        void refreshTiles().then(() => setScreen('tiles'));
        flashStatus('Project closed.');
      },

      removeStorageProject: async (id) => {
        try {
          await deleteProjectFolder(id);
          await refreshTiles();
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
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
      <div className="min-vh-100 d-flex align-items-center justify-content-center bg-body-tertiary p-3">
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
              <div className="card card-body bg-body-tertiary small mb-3">
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
            {statusToast}
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
    const createNewProject = () => {
      if (!newName.trim()) return;
      void cb()
        .storage.createProject(newName.trim(), PAGE_SIZE_PRESETS[pageSizeIdx] ?? DEFAULT_PAGE_SIZE)
        .then(() => {
          setShowNewModal(false);
          setNewName('');
          setPageSizeIdx(0);
        })
        .catch((err: unknown) => flashStatus(err instanceof Error ? err.message : String(err)));
    };
    return (
      <div className="min-vh-100 bg-body">
        <div className="container py-4">
          <div className="d-flex justify-content-between align-items-center mb-4">
            <h1 className="h4 mb-0">Your comics</h1>
          </div>
          {statusToast}
          <div className="row g-3">
            {folders.map((f) => (
              <div className="col-12 col-sm-6 col-md-4" key={f.id}>
                <div className="card h-100 shadow-sm">
                  <div className="card-body d-flex flex-column">
                    <h2 className="card-title h6 text-truncate">{f.name}</h2>
                    <div className="mt-auto d-flex gap-2">
                      <button
                        className="btn btn-primary btn-sm"
                        title="Open project"
                        aria-label={`Open ${f.name}`}
                        onClick={() => void cb().storage.openProject(f.id)}
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h4.5A1.5 1.5 0 0 1 14 6.5v5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7z" />
                        </svg>
                      </button>
                      <button
                        className="btn btn-outline-danger btn-sm"
                        title="Remove project"
                        aria-label={`Remove ${f.name}`}
                        onClick={() => void removeTileProject(f.id, f.name)}
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.8 9.2a1 1 0 0 0 1 .8h4.4a1 1 0 0 0 1-.8L12 4M6.5 6.5v4M9.5 6.5v4" />
                        </svg>
                      </button>
                    </div>
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
                          createNewProject();
                        }
                      }}
                    />
                    <label className="form-label mt-3" htmlFor="new-project-size">
                      Page size
                    </label>
                    <select
                      id="new-project-size"
                      className="form-select"
                      value={pageSizeIdx}
                      onChange={(e) => setPageSizeIdx(Number(e.target.value))}
                    >
                      {PAGE_SIZE_PRESETS.map((p, i) => (
                        <option key={p.label} value={i}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="modal-footer">
                    <button className="btn btn-secondary" onClick={() => setShowNewModal(false)}>
                      Cancel
                    </button>
                    <button
                      className="btn btn-primary"
                      disabled={!newName.trim()}
                      onClick={createNewProject}
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
      <div className="bg-body min-vh-100">
        {statusToast}
        <div className="d-flex justify-content-between align-items-center p-3">
          <span className="text-body">
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
    <div className="min-vh-100 d-flex flex-column bg-body">
      <nav className="navbar px-3 bg-body-tertiary">
        <span className="navbar-brand mb-0 h1 fs-5 text-truncate" style={{ maxWidth: '42vw' }}>
          {project?.title ?? 'Comic Builder'}
        </span>
        <div className="d-flex align-items-center gap-2">
          {saveLabel && (
            <span className="navbar-text small text-nowrap d-none d-sm-inline">{saveLabel}</span>
          )}
          <button
            className="btn btn-outline-light btn-sm d-md-none"
            onClick={() => {
              setTabMenuOpen((v) => !v);
              setMenuOpen(false);
            }}
            aria-expanded={tabMenuOpen}
          >
            {EDITOR_TABS.find((t) => t.id === tab)?.label ?? 'Tabs'}
          </button>
          <button
            className="btn btn-outline-light btn-sm"
            onClick={() => {
              setMenuOpen((v) => !v);
              setTabMenuOpen(false);
            }}
            aria-expanded={menuOpen}
          >
            Menu
          </button>
        </div>
      </nav>

      {tabMenuOpen && (
        <FixedMenu onClose={() => setTabMenuOpen(false)}>
          {EDITOR_TABS.map((t) => (
            <li key={t.id}>
              <button
                className={`dropdown-item${t.id === tab ? ' active' : ''}`}
                onClick={() => {
                  setTabMenuOpen(false);
                  setTab(t.id);
                }}
              >
                {t.label}
              </button>
            </li>
          ))}
        </FixedMenu>
      )}
      {menuOpen && (
        <FixedMenu onClose={() => setMenuOpen(false)}>
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
              Preview this page
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
        </FixedMenu>
      )}

      <ul className="nav nav-tabs px-3 pt-2 bg-body border-bottom d-none d-md-flex mb-0">
        {EDITOR_TABS.map((t) => (
          <li className="nav-item" key={t.id}>
            <button
              className={`nav-link${t.id === tab ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          </li>
        ))}
      </ul>

      {statusToast}

      {tab === 'pages' && (
        <div className="d-flex flex-column flex-grow-1" style={{ minHeight: 0 }}>
          <div className="d-flex flex-grow-1" style={{ minHeight: 0 }}>
            <div
              className="d-none d-md-flex flex-column align-items-stretch border-end bg-body py-2"
              style={{ width: 64, flexShrink: 0, overflowY: 'auto' }}
            >
              {(project?.pages ?? []).map((pg, idx) => (
                <button
                  key={pg.id}
                  title={`${pg.title} — drag to reorder`}
                  {...pageDragProps(idx)}
                  style={{ cursor: 'grab' }}
                  className={`btn btn-sm mx-2 mb-1 px-0${
                    idx === pageIndex ? ' btn-primary' : ' btn-outline-secondary'
                  }${dropPageIdx === idx ? ' border-primary border-2' : ''}${
                    dragPageIdx === idx ? ' opacity-50' : ''
                  }`}
                  onClick={() => cb().page.select(idx)}
                >
                  {formatPageNumber(pg.number)}
                </button>
              ))}
              <button
                title="Add page"
                aria-label="Add page"
                className="btn btn-sm btn-outline-primary mx-2 mb-1 px-0"
                onClick={() => void cb().page.add()}
              >
                +
              </button>
            </div>
            <main className="flex-grow-1 p-3 overflow-auto">
              {currentPage ? (
                <>
                  <div className="d-flex align-items-center gap-2 mb-3">
                    <h2 className="h5 mb-0">
                      Page {formatPageNumber(currentPage.number)} — {currentPage.title}
                    </h2>
                    <div
                      className="btn-group btn-group-sm ms-auto"
                      role="group"
                      aria-label="Reorder pages"
                    >
                      <button
                        className="btn btn-outline-secondary"
                        title="Move page earlier"
                        aria-label="Move page earlier"
                        disabled={pageIndex <= 0}
                        onClick={() => void cb().page.move(pageIndex, pageIndex - 1)}
                      >
                        ↑
                      </button>
                      <button
                        className="btn btn-outline-secondary"
                        title="Move page later"
                        aria-label="Move page later"
                        disabled={pageIndex >= (project?.pages.length ?? 1) - 1}
                        onClick={() => void cb().page.move(pageIndex, pageIndex + 1)}
                      >
                        ↓
                      </button>
                    </div>
                  </div>
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
          <div className="d-md-none border-top bg-body py-2">
            <div className="d-flex gap-2 px-3" style={{ overflowX: 'auto' }}>
              {(project?.pages ?? []).map((pg, idx) => (
                <button
                  key={pg.id}
                  title={`${pg.title} — drag to reorder`}
                  {...pageDragProps(idx)}
                  style={{ cursor: 'grab' }}
                  className={`btn btn-sm px-3 flex-shrink-0${
                    idx === pageIndex ? ' btn-primary' : ' btn-outline-secondary'
                  }${dropPageIdx === idx ? ' border-primary border-2' : ''}${
                    dragPageIdx === idx ? ' opacity-50' : ''
                  }`}
                  onClick={() => cb().page.select(idx)}
                >
                  {formatPageNumber(pg.number)}
                </button>
              ))}
              <button
                title="Add page"
                aria-label="Add page"
                className="btn btn-sm btn-outline-primary px-3 flex-shrink-0"
                onClick={() => void cb().page.add()}
              >
                +
              </button>
            </div>
          </div>
        </div>
      )}
      {tab === 'outline' && project && <OutlineTab key={project.id} project={project} />}
      {tab === 'characters' && project && <CharactersTab key={project.id} project={project} />}
      {tab === 'scenes' && project && <ScenesTab key={project.id} project={project} />}
    </div>
  );
}

/** Dropdown menu rendered fixed to the viewport so it can never create page scrollbars. */
function FixedMenu({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <>
      <div
        className="position-fixed top-0 start-0 w-100 h-100"
        style={{ zIndex: 1040 }}
        onClick={onClose}
      />
      <ul
        className="dropdown-menu show"
        style={{ position: 'fixed', top: 56, right: 8, zIndex: 1041, minWidth: 200 }}
      >
        {children}
      </ul>
    </>
  );
}

/** Outline tab: project title, page size, and the story outline. All edits go through window.ComicBuilder. */
function OutlineTab({ project }: { project: ComicProject }) {
  const [outline, setOutline] = useState(project.metadata.outline);
  const [note, setNote] = useState('');
  const ps = project.metadata.pageSize ?? DEFAULT_PAGE_SIZE;
  const presetIdx = PAGE_SIZE_PRESETS.findIndex(
    (p) => p.widthIn === ps.widthIn && p.heightIn === ps.heightIn
  );

  return (
    <div className="container py-4 overflow-auto" style={{ maxWidth: 800 }}>
      <h2 className="h5 mb-1">Outline</h2>
      <p className="text-muted small mb-4">{project.title}</p>

      <div className="mb-4">
        <label className="form-label fw-semibold" htmlFor="outline-pagesize">
          Page size
        </label>
        <select
          id="outline-pagesize"
          className="form-select"
          style={{ maxWidth: 340 }}
          value={presetIdx >= 0 ? presetIdx : 'custom'}
          onChange={(e) => {
            const p = PAGE_SIZE_PRESETS[Number(e.target.value)];
            if (p) {
              cb().metadata.setPageSize({ ...p });
              setNote(`Page size set to ${p.label}.`);
            }
          }}
        >
          {presetIdx < 0 && (
            <option value="custom">
              {ps.label} — {ps.widthIn}&quot; × {ps.heightIn}&quot;
            </option>
          )}
          {PAGE_SIZE_PRESETS.map((p, i) => (
            <option key={p.label} value={i}>
              {p.label}
            </option>
          ))}
        </select>
        <div className="form-text">
          {ps.widthIn}&quot; × {ps.heightIn}&quot; — stored in the project metadata.
        </div>
      </div>

      <div className="mb-2 d-flex justify-content-between align-items-center">
        <label className="form-label fw-semibold mb-0" htmlFor="outline-text">
          Story outline
        </label>
        {note && <span className="text-success small">{note}</span>}
      </div>
      <textarea
        id="outline-text"
        className="form-control"
        rows={12}
        value={outline}
        onChange={(e) => setOutline(e.target.value)}
        placeholder="Story outline / synopsis…"
      />
      <button
        className="btn btn-primary mt-3"
        onClick={() => {
          cb().metadata.setOutline(outline);
          setNote('Outline saved.');
        }}
      >
        Save outline
      </button>
    </div>
  );
}

/** One editable story-bible entry (character or scene card). */
function StoryCard({
  id,
  name,
  description,
  kind,
  onUpdate,
  onDelete,
}: {
  id: string;
  name: string;
  description: string;
  kind: 'character' | 'scene';
  onUpdate: (id: string, patch: { name?: string; description?: string }) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="card mb-3">
      <div className="card-body">
        <div className="d-flex gap-2 align-items-center mb-2">
          <input
            className="form-control fw-semibold"
            defaultValue={name}
            aria-label={`${kind} name`}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== name) onUpdate(id, { name: v });
              else e.target.value = name;
            }}
          />
          <button
            className="btn btn-outline-danger btn-sm flex-shrink-0"
            onClick={() => {
              if (window.confirm(`Delete ${kind} "${name}"?`)) onDelete(id);
            }}
          >
            Delete
          </button>
        </div>
        <textarea
          className="form-control"
          rows={3}
          defaultValue={description}
          aria-label={`${kind} description`}
          placeholder={
            kind === 'character'
              ? 'Visual description + continuity notes…'
              : 'Setting, time of day, mood, lighting…'
          }
          onBlur={(e) => {
            if (e.target.value !== description) onUpdate(id, { description: e.target.value });
          }}
        />
      </div>
    </div>
  );
}

/** Characters tab: the story-bible character list, editable. */
function CharactersTab({ project }: { project: ComicProject }) {
  const [newName, setNewName] = useState('');
  const chars = project.metadata.characters;
  return (
    <div className="container py-4 overflow-auto" style={{ maxWidth: 800 }}>
      <h2 className="h5 mb-3">Characters</h2>
      <div className="input-group mb-4" style={{ maxWidth: 480 }}>
        <input
          className="form-control"
          placeholder="New character name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newName.trim()) {
              cb().characters.create({ name: newName.trim() });
              setNewName('');
            }
          }}
        />
        <button
          className="btn btn-primary"
          disabled={!newName.trim()}
          onClick={() => {
            cb().characters.create({ name: newName.trim() });
            setNewName('');
          }}
        >
          Add
        </button>
      </div>
      {chars.map((c) => (
        <StoryCard
          key={c.id}
          id={c.id}
          name={c.name}
          description={c.description}
          kind="character"
          onUpdate={(id, patch) => cb().characters.update(id, patch)}
          onDelete={(id) => cb().characters.delete(id)}
        />
      ))}
      {chars.length === 0 && <p className="text-muted">No characters yet.</p>}
    </div>
  );
}

/** Scenes tab: the story-bible scene/location list, editable. */
function ScenesTab({ project }: { project: ComicProject }) {
  const [newName, setNewName] = useState('');
  const scenes = project.metadata.scenes;
  return (
    <div className="container py-4 overflow-auto" style={{ maxWidth: 800 }}>
      <h2 className="h5 mb-3">Scenes</h2>
      <div className="input-group mb-4" style={{ maxWidth: 480 }}>
        <input
          className="form-control"
          placeholder="New scene name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newName.trim()) {
              cb().scenes.create({ name: newName.trim() });
              setNewName('');
            }
          }}
        />
        <button
          className="btn btn-primary"
          disabled={!newName.trim()}
          onClick={() => {
            cb().scenes.create({ name: newName.trim() });
            setNewName('');
          }}
        >
          Add
        </button>
      </div>
      {scenes.map((s) => (
        <StoryCard
          key={s.id}
          id={s.id}
          name={s.name}
          description={s.description}
          kind="scene"
          onUpdate={(id, patch) => cb().scenes.update(id, patch)}
          onDelete={(id) => cb().scenes.delete(id)}
        />
      ))}
      {scenes.length === 0 && <p className="text-muted">No scenes yet.</p>}
    </div>
  );
}
