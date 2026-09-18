import { useEffect, useRef, useState } from "react";
import PageRail from "./components/PageRail";
import PanelView from "./components/PanelView";
import DriveConnect from "./drive/DriveConnect";
import {
  hasDriveAccess,
  getAccessToken,
  ensureProjectFolder,
  loadProjectJson,
  saveProjectJson,
  downloadFile,
  getStoredFolderId,
  storeFolderId,
  disconnectDrive,
} from "./drive/driveClient";
import {
  loadSampleProject,
  loadProjectFromFile,
  downloadProject,
  saveProjectLocal,
  loadProjectLocal,
} from "./state/project";
import type { ComicProject } from "./types/comic";
import "./App.css";

export default function App() {
  const [project, setProject] = useState<ComicProject | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [driveReady, setDriveReady] = useState(hasDriveAccess());
  const [showDrivePrompt, setShowDrivePrompt] = useState(false);
  const [folderName, setFolderName] = useState("My Comic");
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // First open: restore browser-saved work if present, else the placeholder
  // project. Then check Drive access.
  useEffect(() => {
    const local = loadProjectLocal();
    if (local) {
      setProject(local);
      setLastSaved(local.updatedAt ?? null);
      setStatus("Restored your last saved work from this browser.");
    } else {
      loadSampleProject()
        .then(setProject)
        .catch((e) => setStatus(`Could not load sample project: ${e.message}`));
    }
    if (!hasDriveAccess()) {
      setShowDrivePrompt(true); // first-open Drive prompt
    }
  }, []);

  const currentPage = project?.pages[pageIndex] ?? null;

  async function handleOpenFromDrive() {
    if (!getAccessToken()) {
      setShowDrivePrompt(true);
      return;
    }
    setBusy(true);
    setStatus("");
    try {
      const folder = await ensureProjectFolder(folderName || "My Comic");
      storeFolderId(folder.id);
      const loaded = (await loadProjectJson(folder.id)) as ComicProject;
      // Resolve Drive-hosted layer images to blob URLs for display.
      for (const page of loaded.pages) {
        for (const panel of page.panels) {
          for (const layer of panel.layers) {
            if (layer.driveFileId && !layer.src) {
              const blob = await downloadFile(layer.driveFileId);
              layer.src = URL.createObjectURL(blob);
            }
          }
        }
      }
      setProject(loaded);
      setPageIndex(0);
      setStatus(`Loaded "${loaded.title}" from Google Drive.`);
    } catch (e) {
      setStatus(`Drive open failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveToDrive() {
    if (!project) return;
    if (!getAccessToken()) {
      setShowDrivePrompt(true);
      return;
    }
    setBusy(true);
    setStatus("");
    try {
      const folderId =
        getStoredFolderId() ??
        (await ensureProjectFolder(folderName || "My Comic")).id;
      storeFolderId(folderId);
      await saveProjectJson(folderId, {
        ...project,
        updatedAt: new Date().toISOString(),
      });
      setStatus("Project saved to Google Drive.");
    } catch (e) {
      setStatus(`Drive save failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const loaded = await loadProjectFromFile(file);
      setProject(loaded);
      setPageIndex(0);
      setStatus(`Loaded "${loaded.title}" from file.`);
    } catch (err) {
      setStatus(
        `Could not open file: ${err instanceof Error ? err.message : err}`
      );
    }
    e.target.value = "";
  }

  async function handleDisconnect() {
    await disconnectDrive();
    setDriveReady(false);
    setStatus("Disconnected from Google Drive.");
  }

  function handleSaveLocal() {
    if (!project) return;
    try {
      const at = saveProjectLocal(project);
      setLastSaved(at);
      setStatus(`Saved locally at ${new Date(at).toLocaleTimeString()}.`);
    } catch (e) {
      setStatus(`Local save failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>{project?.title ?? "Comic Builder"}</h1>
        <div className="app-actions">
          <button onClick={handleSaveLocal} disabled={busy || !project}>
            Save
          </button>
          {lastSaved && (
            <span className="save-state" title={lastSaved}>
              Saved {new Date(lastSaved).toLocaleTimeString()}
            </span>
          )}
          <input
            className="folder-input"
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            placeholder="Drive folder name"
            aria-label="Drive folder name"
          />
          <button onClick={handleOpenFromDrive} disabled={busy}>
            Open from Drive
          </button>
          <button onClick={handleSaveToDrive} disabled={busy || !project}>
            Save to Drive
          </button>
          <button onClick={() => fileInputRef.current?.click()}>
            Load file
          </button>
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
            <button
              className="btn-ghost"
              onClick={() => setShowDrivePrompt(true)}
            >
              Connect Drive
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            hidden
            onChange={handleFilePicked}
          />
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

      {showDrivePrompt && (
        <DriveConnect
          onConnected={() => {
            setDriveReady(true);
            setShowDrivePrompt(false);
            setStatus("Connected to Google Drive.");
          }}
          onSkip={() => setShowDrivePrompt(false)}
        />
      )}
    </div>
  );
}
