# Comic Builder

A generic comic-builder web app. It renders a comic project — pages, panels,
layers, and speech bubbles — from a JSON project file. It is **not** tied to
any one comic: point it at any project file (local or on Google Drive) and it
renders that.

Comic images and the project file live on **your Google Drive**, not on any
server. The app is a static site; all Drive access happens client-side via
Google OAuth.

## Structure

```
comics-builder/
├── .github/workflows/deploy.yml   # build + deploy to GitHub Pages
├── public/data/sample-project.json# placeholder project shown on first load
├── src/
│   ├── types/comic.ts             # ComicProject / Page / Panel / Layer / Bubble
│   ├── drive/
│   │   ├── driveClient.ts         # GIS OAuth + Drive API (upload/list/download)
│   │   └── DriveConnect.tsx       # first-open "connect Drive" prompt
│   ├── state/project.ts           # load project from file / sample / Drive
│   ├── components/
│   │   ├── PageRail.tsx           # left page navigation (00, 01, 02, …)
│   │   └── PanelView.tsx          # panel canvas: layers + bubbles
│   ├── App.tsx                    # shell: header actions, rail, page view
│   └── main.tsx
└── dist/                          # build output (generated, not committed)
```

## Run locally

```bash
npm install
cp .env.example .env   # then fill in VITE_GOOGLE_CLIENT_ID
npm run dev            # http://localhost:5173
npm run build          # outputs static files to dist/
npm run preview        # serve the built dist/ locally
```

## Google OAuth client ID setup (required for Drive)

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
   → APIs & Services → Credentials.
2. Create Credentials → **OAuth client ID** → type **Web application**.
3. Under **Authorized JavaScript origins** add:
   - `http://localhost:5173` (local dev)
   - `https://<your-github-username>.github.io` (deployed site)
4. Enable the **Google Drive API** for the project
   (APIs & Services → Library → search "Google Drive API" → Enable).
5. Copy the client ID.

Local dev: put it in `.env` as `VITE_GOOGLE_CLIENT_ID=...`.

Deployed site: add it as a GitHub repo secret named `GOOGLE_CLIENT_ID`
(Settings → Secrets and variables → Actions). The deploy workflow passes it
into the build as `VITE_GOOGLE_CLIENT_ID`.

The app requests only the `drive.file` scope: it can see, create, and edit
**only** the Drive files it created or that you opened with it — not the rest
of your Drive.

## Saving

- **Save** (header button) persists the project in the browser's localStorage
  with a visible "Saved HH:MM:SS" state. Reopening the app restores it.
- **Export JSON** downloads the project as a `.json` file.
- **Save to Drive** writes `project.json` into the chosen Drive folder
  (requires Drive connection). Loading from Drive or a file never silently
  discards browser-saved work: the previous local copy is kept as a backup
  under the `cb_local_project_backup` key.

## How Drive is used

- **First open:** the app checks for a valid Drive access token. If there is
  none, it shows a prompt explaining that your comic's images and project
  file live on your Google Drive, with a "Connect Google Drive" button
  (OAuth popup) and a "Continue without Drive" option.
- **Open from Drive:** creates (or finds) a folder with the name you type and
  loads `project.json` from it. Layer images referenced by `driveFileId` are
  downloaded and displayed.
- **Save to Drive:** writes the current project JSON back to `project.json`
  in that folder. Use `uploadImage()` in `src/drive/driveClient.ts` to add
  images to the folder.
- Tokens are stored in `localStorage` with an expiry (~1 hour). When a token
  expires you will be asked to reconnect. "Disconnect Drive" revokes the
  token at Google and clears it locally.

## Deploy action

`.github/workflows/deploy.yml` runs on every push to `main` and can also be
triggered manually from the Actions tab (**workflow_dispatch**). It installs
dependencies, runs `npm run build` (Vite → `dist/`), uploads `dist/` as a
Pages artifact, and deploys it to GitHub Pages.

One-time repo setup for Pages: Settings → Pages → Source → **GitHub Actions**.

Note: `vite.config.ts` sets `base: "/comics-builder/"`. If you name the repo
differently, update that value to `"/<repo-name>/"` so asset URLs resolve on
Pages.

## Project JSON format

A project is a `ComicProject`: `{ id, title, pages[] }`. Each page has
`{ id, number, title, panels[] }`; each panel has `{ id, title?, layers[],
bubbles[] }`. A layer is `{ id, name, kind: "background" | "foreground",
src, driveFileId?, visible, x, y, width, rotation, opacity }` where `x/y/width`
are percentages of the panel. A bubble is `{ id, kind: "speech" | "thought" |
"caption", text, x, y, width, tailX?, tailY? }`.

See `public/data/sample-project.json` for a minimal example and
`src/types/comic.ts` for the full types.
