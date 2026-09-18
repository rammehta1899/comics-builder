import { useState } from "react";
import { requestDriveAccess, getClientId } from "./driveClient";

interface Props {
  onConnected: () => void;
  onSkip: () => void;
}

/**
 * Shown on first open when there is no valid Google Drive access.
 * Explains in plain language why access is needed and asks for it.
 */
export default function DriveConnect({ onConnected, onSkip }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = !!getClientId();

  async function handleConnect() {
    setBusy(true);
    setError(null);
    try {
      await requestDriveAccess();
      onConnected();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="drive-overlay" role="dialog" aria-modal="true">
      <div className="drive-card">
        <h2>Connect Google Drive</h2>
        <p>
          Comic Builder stores your comic's project file and all of its images
          on <strong>your own Google Drive</strong> — nothing is kept on our
          servers. To load, edit, and save your comic, the app needs
          permission to access the Drive files it creates for your projects.
        </p>
        <p className="drive-note">
          It only asks for access to files it creates or that you open with
          it. It cannot see the rest of your Drive.
        </p>
        {!configured && (
          <p className="drive-warning">
            The Google OAuth client ID is not configured yet. Set{" "}
            <code>VITE_GOOGLE_CLIENT_ID</code> (see README) before connecting.
          </p>
        )}
        {error && <p className="drive-error">{error}</p>}
        <div className="drive-actions">
          <button
            className="btn-primary"
            onClick={handleConnect}
            disabled={busy || !configured}
          >
            {busy ? "Connecting…" : "Connect Google Drive"}
          </button>
          <button className="btn-ghost" onClick={onSkip} disabled={busy}>
            Continue without Drive
          </button>
        </div>
      </div>
    </div>
  );
}
