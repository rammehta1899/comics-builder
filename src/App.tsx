import { useEffect, useRef, useState } from "react";
import PageRail from "./components/PageRail";
import PanelView from "./components/PanelView";
import DriveConnect from "./drive/DriveConnect";
import { installAgentApi, uninstallAgentApi } from "./ai/agentApi";
import {
  hasDriveAccess,
  getAccessToken,
  getClientId,
  ensureProjectFolder,
  loadProjectJson,
  saveProjectJson,
  downloadFile,
  getStoredFolderId,
  storeFolderId,
  disconnectDrive,
} from "./drive/driveClient";
import {
  createBlankProject,
  downloadProject,
  saveProjectLocal,
  assertValidProject,
} from "./state/project";
import type { ComicProject } from "./types/comic";
import "./App.css";

/**
 * Drive-gated, autosaving app shell.
 *
 * - The editor is unreachable until the user connects Google Drive
 *   (the connect dialog is a hard gate, not a dismissible prompt).
 * - Google Drive is the only project source: on connect the app loads
 *   project.json from the project folder, creating a blank project when
 *   the folder is empty.
 * - Every project change autosaves to Drive a couple of seconds after
 *   the last edit. There are no manual save/open buttons.
 */
export default function App() {
  const [project, setProject] = useState<ComicProject | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [driveReady, setDriveReady] = useState(hasDriveAccess());
  const [showGate, setShowGate] = useState(false);
  const [folderName, setFolderName] = useState("My Comic");
  const [status, setStatus] = useState<string>("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [lastSaved, setLastSaved] = useState<string | null>(null);

  // Refs mirror state so callbacks and the agent API always see
  // the latest values.
  const projectRef = useRef<ComicProject | null>(null);
  const pageIndexRef = useRef(0);
  const statusRef = useRef("");
  const folderIdRef = useRef<string | null>(null);
  const savingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  projectRef.current = project;
  pageIndexRef.current = pageIndex;
  statusRef.current = status;

  // First open: Drive is required before anything else.
  useEffect(() => {
    if (hasDriveAccess()) {
      setDriveReady(true);
      void loadFromDrive();
    } else {
      setShowGate(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  /** Load project.json from the project folder (blank project if none). */
  async function loadFromDrive(): Promise<{ ok: boolean; error?: string }> {
    setProject(null);
    setStatus("Loading your comic from Google Drive…");
    try {
      const folderId =
        folderIdRef.current ??
        getStoredFolderId() ??
        (await ensureProjectFolder(folderName || "My Comic")).id;
      folderIdRef.current = folderId;
      storeFolderId(folderId);
      let loaded: ComicProject;
      try {
        const raw = (await loadProjectJson(folderId)) as unknown;
        assertValidProject(raw);
        loaded = raw;
        await hydrateDriveImages(loaded);
        setStatus(`Loaded "${loaded.title}" from Google Drive.`);
      } catch (e) {
        if (e instanceof Error && e.message.includes("No project.json")) {
          loaded = createBlankProject();
          setStatus("Created a new comic — it will save to Google Drive automatically.");
        } else {
          throw e;
        }
      }
      setProject(loaded);
      setPageIndex(0);
      return { ok: true };
    } catch (e) {
      const msg = `Could not load from Drive: ${e instanceof Error ? e.message : e}`;
      setStatus(msg);
      return { ok: false, error: msg };
    }
  }

  /** Write the current project to Drive now. Returns false when skipped. */
  async function flushSave(): Promise<boolean> {
    const p = projectRef.current;
    if (!p || savingRef.current || !getAccessToken()) return false;
    savingRef.current = true;
    setSaveState("saving");
    try {
      const folderId =
        folderIdRef.current ??
        getStoredFolderId() ??
        (await ensureProjectFolder(folderName || "My Comic")).id;
      folderIdRef.current = folderId;
      storeFolderId(folderId);
      const at = new Date().toISOString();
      await saveProjectJson(folderId, { ...p, updatedAt: at });
      setLastSaved(at);
      setSaveState("saved");
      return true;
    } catch (e) {
      setSaveState("error");
      setStatus(`Autosave failed: ${e instanceof Error ? e.message : e}`);
      return false;
    } finally {
      savingRef.current = false;
    }
  }

  // Autosave: every project change is written to Drive ~2s after the
  // last edit. No manual save button.
  useEffect(() => {
    if (!project || !driveReady) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void flushSave();
    }, 2000);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, driveReady]);

  async function handleConnected() {
    setDriveReady(true);
    setShowGate(false);
    setStatus("Connected to Google Drive.");
    await loadFromDrive();
  }

  async function handleDisconnect() {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    await disconnectDrive();
    folderIdRef.current = null;
    setDriveReady(false);
    setProject(null);
    setLastSaved(null);
    setSaveState("idle");
    setShowGate(true);
    setStatus("Disconnected from Google Drive.");
  }

  /** Switch to a different Drive folder (from the folder name input). */
  async function handleFolderCommit() {
    const name = folderName.trim() || "My Comic";
    folderIdRef.current = null;
    try {
      const folder = await ensureProjectFolder(name);
      folderIdRef.current = folder.id;
      storeFolderId(folder.id);
      await loadFromDrive();
    } catch (e) {
      setStatus(`Could not switch folder: ${e instanceof Error ? e.message : e}`);
    }
  }

  function handleSaveLocal(): string | null {
    const p = projectRef.current;
    if (!p) return null;
    try {
      return saveProjectLocal(p);
    } catch (e) {
      setStatus(`Local backup failed: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  // Always-latest handler bindings for the agent API.
  const handlersRef = useRef({
    handleSaveLocal,
    flushSave,
    loadFromDrive,
  });
  handlersRef.current = { handleSaveLocal, flushSave, loadFromDrive };

  // Expose the command API for AI agents / automation on window.comicBuilder.
  // See public/llms.txt and src/ai/agentApi.ts for the contract.
  useEffect(() => {
    installAgentApi({
      getProject: () => projectRef.current,
      replaceProject: (p) => {
        setProject(p);
        setPageIndex(0);
        setStatus(`Loaded "${p.title}" via agent API.`);
      },
      getPageIndex: () => pageIndexRef.current,
      getPageCount: () => projectRef.current?.pages.length ?? 0,
      selectPage: (i) => {
        const count = projectRef.current?.pages.length ?? 0;
        if (!Number.isInteger(i) || i < 0 || i >= count) return false;
        setPageIndex(i);
        return true;
      },
      saveLocal: () => handlersRef.current.handleSaveLocal(),
      saveToDrive: async () => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        const ok = await handlersRef.current.flushSave();
        return ok
          ? { ok: true }
          : { ok: false, error: "Nothing to save, or Drive is not connected." };
      },
      openFromDrive: () => handlersRef.current.loadFromDrive(),
      getStatus: () => statusRef.current,
      driveStatus: () => ({
        connected: hasDriveAccess(),
        configured: !!getClientId(),
      }),
    });
    return () => uninstallAgentApi();
  }, []);

  const currentPage = project?.pages[pageIndex] ?? null;

  const saveLabel =
    saveState === "saving"
      ? "Saving…"
      : saveState === "saved" && lastSaved
        ? `Saved ${new Date(lastSaved).toLocaleTimeString()}`
        : saveState === "error"
          ? "Save failed — retrying on next change"
          : null;

  return (
    <div className="app">
      <header className="app-header">
        <h1>{project?.title ?? "Comic Builder"}</h1>
        <div className="app-actions">
          {saveLabel && (
            <span
              className={`save-state${saveState === "error" ? " save-error" : ""}`}
              title={lastSaved ?? undefined}
            >
              {saveLabel}
            </span>
          )}
          <input
            className="folder-input"
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            onBlur={handleFolderCommit}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleFolderCommit();
            }}
            placeholder="Drive folder name"
            aria-label="Drive folder name"
            title="Project folder on Google Drive — changing it loads that folder's comic"
          />
          <button
            onClick={() => project && downloadProject(project)}
            disabled={!project}
          >
            Export JSON
          </button>
          {driveReady ? (
            <button className="btn-ghost" onClick={handleDisconnect}>
              Disconnect Drive
            </button>
          ) : (
            <button className="btn-ghost" onClick={() => setShowGate(true)}>
              Connect Drive
            </button>
          )}
        </div>
      </header>

      {status && (
        <div className="status-bar" role="status">
          {status}
        </div>
      )}

      <div className="app-body">
        {project && (
          <PageRail
            pages={project.pages}
            currentIndex={pageIndex}
            onSelect={setPageIndex}
          />
        )}
        <main className="page-view">
          {currentPage ? (
            <>
              <h2 className="page-heading">
                Page {currentPage.number.toString().padStart(2, "0")} —{" "}
                {currentPage.title}
              </h2>
              <div className="panels">
                {currentPage.panels.map((panel) => (
                  <PanelView key={panel.id} panel={panel} />
                ))}
              </div>
            </>
          ) : (
            <p>Loading…</p>
          )}
        </main>
      </div>

      {showGate && (
        <DriveConnect
          onConnected={handleConnected}
          onSkip={() => setShowGate(false)}
        />
      )}
    </div>
  );
}
