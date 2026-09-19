# Comic Builder — Engineering Spec

This is the full design document. The short user-facing overview lives in
`README.md`. The agent-facing runtime API reference is `ComicBuilder.help()`
in the browser console and the static copy in `public/llms.txt`.

## 1. Architecture

Comic Builder is a **static single-page app** (Vite + React + TypeScript)
deployed to GitHub Pages. It has no server and no database of its own.

```
Browser (React UI) ──window.ComicBuilder──> state (React useState + refs)
        │                                          │
        │ actions.ts delegates                     │ ~2s debounce
        ▼                                          ▼
Google Drive API ◄── OAuth token (page memory) ── saveProjectJson()
```

- **One code path.** The UI and any AI agent call the same functions on
  `window.ComicBuilder` (installed by `src/ai/actions.ts`'s
  `installComicBuilder(deps)` in `App.tsx`). Buttons never contain their own
  mutation logic, so the UI can't drift from the agent API.
- **React is the view layer; the API is the model.** `App.tsx` keeps the
  project in `useState` plus mirrors in `useRef` so the installed API
  closures never go stale. `updateProject(mut)` clones the project,
  applies the mutation, stamps `updatedAt`, and sets state.
- **Drive is the only store.** There is no local-storage copy of the comic.
  `drive.file` scope means the app can only see folders/files it created.

## 2. Screens

`App.tsx` has exactly three screens plus one overlay:

1. **Splash** (`splash`) — hard gate. Title "Connect to Google Drive",
   a two-line reason, a React-controlled expander ("Why do we need this
   access?") that explains `drive.file` scope, memory-only tokens, and —
   explicitly — that the app cannot work at all without connecting. Two
   buttons: "Connect with Google Drive", which calls
   `ComicBuilder.storage.connect()` (GIS popup, human click), and
   "Connect with a code (for AI assistants)", which calls
   `ComicBuilder.storage.connectWithDevice()` — the OAuth device flow
   for headless browsers, showing a verification URL + user code for the
   user to approve on any other device.
2. **Tiles** (`tiles`) — one Bootstrap card per Drive project folder plus a
   dashed "New project" tile. The new-project name and page size (preset:
   US Comic, US Trade, Manga B5, A4, Square, Portrait 4:5, Landscape 16:9)
   are collected in a Bootstrap modal and stored in
   `metadata.pageSize`. Each tile opens through
   `ComicBuilder.storage.openProject(id)`. Connection is implicit — no
   connected-status indicator and no disconnect button anywhere in the UI
   (disconnect stays available as `ComicBuilder.storage.disconnect()`).
3. **Editor** (`editor`) — Bootstrap dark navbar with the project title
   from `project.json`, a Saving/Saved indicator derived from `savedAt`,
   and a dropdown menu: Open project (back to tiles), Preview this page,
   Close project. All dropdowns are `position: fixed` so they can never
   create page scrollbars. Below the navbar the editor has four tabs —
   **Outline** (metadata: title, page-size preset, story outline),
   **Characters**, **Scenes**, **Pages**. On desktop the tabs are a tab bar;
   on mobile they are picked from a menu. The Pages tab has a thin
   page-number rail on the left for desktop and a horizontal scrolling
   page-number footer on mobile; page buttons call
   `ComicBuilder.page.select(i)`; the main area renders the current page's
   panels.
4. **Preview overlay** (`preview` boolean) — the current page's panels with
   minimal chrome (page number/title + "Close preview"), rendered on a dark
   background so an agent can screenshot a finished page. Preview is always
   per-page, never the whole project. Entered via
   `ComicBuilder.page.openPreview()`, exited via `closePreview()`.

## 3. Data model

TypeScript source of truth: `src/types/comic.ts`. JSON Schema:
`public/schema/comic-project.schema.json` (draft 2020-12). Every Drive
project folder holds exactly one `project.json`.

- `ComicProject` — `{ id, title, pages[], updatedAt, savedAt, metadata }`.
  `savedAt` is stamped on every successful Drive write and drives the
  Saving/Saved indicator.
- `ComicPage` — `{ id, number, title, panels[] }`. `number` is 0-based and
  displayed zero-padded (`00` = cover, `01` = page one).
- `Panel` — `{ id, title?, layers[], bubbles[] }`.
- `Layer` — `{ id, name, kind: "background" | "foreground", src,
driveFileId?, mediaId?, visible, x, y, width, rotation, opacity }`.
  There is **no separate background field**: the background is the layer
  whose `kind` is `"background"` (conventionally the first layer). `x`/`y`/
  `width` are percentages of panel size; aspect ratio is preserved, never
  stretched.
- `Bubble` — `{ id, kind: "speech" | "thought" | "caption", text, x, y,
width, tailX?, tailY? }`. Bubbles always render above all layers.
- `ProjectMetadata` — `{ outline, pageSize, characters[], scenes[],
objects[], media[] }`: the story bible plus the media registry.
`pageSize` is `{ label, widthIn, heightIn }`, chosen at creation from
`PAGE_SIZE_PRESETS` (old projects without it load with the US Comic
default).
- `Character` / `ComicObject` — `{ id, name, description, imageIds[],
sceneIds[] }`. The description carries visual continuity guidance.
- `Scene` — `{ id, name, description, characterIds[], imageIds[] }`.
- `MediaItem` — `{ id, name, driveFileId, url, mimeType }`. `url` values
  require a valid Drive access token to fetch bytes.

Structural validation lives in `src/state/project.ts` (`assertValidProject`,
`createBlankProject`).

## 4. The `window.ComicBuilder` API

Defined in `src/ai/actions.ts` as a nested object literal with JSDoc on
every node and method. `createComicBuilder(deps)` wires the object to the
host app through `ComicBuilderDeps` (getProject, updateProject,
replaceProject, page index, preview, status, storage, media). The API is
also the app's **LLM skill**: see §5.

Namespaces:

- `version`, `help()`
- `storage` — `connect()`, `connectWithDevice()`, `disconnect()`, `status()`, `listProjects()`,
  `createProject(name)`, `openProject(idOrName)`, `closeProject()`,
  `showProjects()`, `save()`
- `project` — `load(data)` (replace the whole project from JSON, validated)
- `page` — `count()`, `select(i)`, `current()`, `openPreview()`,
  `closePreview()`
- `layers` — `list(panelId)`, `get(panelId, layerId)`, `add(panelId, layer)`,
  `update(panelId, layerId, patch)`, `delete(panelId, layerId)`
- `bubbles` — `list/add/update/delete`, addressed by panel id
- `metadata` — `get()`, `setOutline(text)`, `setPageSize(pageSize)`
- `characters` / `scenes` / `objects` — `list/get/create/update/delete`
- `media` — `list()`, `get(id)`, `upload(name, dataUrl, mimeType)` (data URL
  → File → Drive upload → registry entry)

Semantics:

- **Snapshots.** Reads return `structuredClone` deep copies — inspect them
  freely; mutating a snapshot changes nothing. All writes go through the
  action functions.
- **Ids.** Every created entity gets `crypto.randomUUID()` with a
  timestamp/random fallback.
- **One mutation path.** Every mutation goes through `deps.updateProject`,
  which restarts the ~2s debounced Drive autosave. There is no separate
  "save button" path anywhere.
- **Two OAuth flows.** The GIS popup (`storage.connect()`) requires a real
  human click — browsers block popups from injected scripts, so an agent
  calling it alone cannot complete the flow. The device flow
  (`storage.connectWithDevice()`) works headless: it returns a
  verification URL + user code for the user to approve on any device, and
  the agent polls `storage.status()` until connected.

## 5. Runtime docs generation (the LLM skill)

`scripts/extract-docs.mjs` (run by both `npm run dev` and `npm run build`)
parses `src/ai/actions.ts` with the TypeScript compiler API, extracting the
JSDoc above every namespace and method (object properties, shorthand
properties, and methods are all handled). It emits two artifacts:

1. `src/ai/actions.docs.gen.ts` — a path-keyed docs table (gitignored;
   generated locally before `tsc` runs).
2. `public/llms.txt` — a static skill document: conventions + every
   namespace/function with description, parameters, and return value + the
   data model + key URLs. This file is **deployed with the site** at
   `/comics-builder/llms.txt`.

At runtime, `src/ai/docs.ts` (`attachDocs`, `buildHelpText`) walks the API
object and sets a non-enumerable `toString()` on every node with its docs,
so `ComicBuilder.help()` prints the same skill text inside the console —
generated from the same JSDoc, so it can never drift from the code.

## 6. Google Drive

- **Scope:** `drive.file` only. The app sees exactly the folders and files
  it created; `storage.listProjects()` is the complete project list.
- **Token storage:** the OAuth access token lives only in a JS module
  variable (page memory). It is never written to localStorage,
  sessionStorage, or cookies. Reloading the page drops the token — one
  click reconnects. `storage.disconnect()` revokes the grant at Google and
  clears the remembered folder id (full sign-out).
- **Folder layout:** one folder per project (`comics-builder-<name>`),
  containing `project.json` and uploaded artwork. Artwork is uploaded via
  `uploadImage()` and registered as `MediaItem`s; layers reference files
  by `driveFileId` and are hydrated to blob URLs on open.
- **Client IDs:** `VITE_GOOGLE_CLIENT_ID` (Web application, GIS popup) and
  `VITE_GOOGLE_DEVICE_CLIENT_ID` + `VITE_GOOGLE_DEVICE_CLIENT_SECRET`
  ("TVs and Limited Input devices", device flow) at build time (from the
  `GOOGLE_CLIENT_ID`, `GOOGLE_DEVICE_CLIENT_ID`,
  `GOOGLE_DEVICE_CLIENT_SECRET` repo secrets in CI, `.env.local` locally).
  The web client is a public OAuth client with no secret anywhere. The
  device client secret ships in the bundle by design: Google's
  device-client model assumes distributed apps cannot keep secrets (the
  same model rclone uses); it only identifies the client, scope stays
  `drive.file`, and access tokens remain memory-only.

## 7. Autosave

Every state mutation flows through `updateProject()`, which stamps
`updatedAt` and sets React state. A `useEffect` in `App.tsx` watches the
project and writes `project.json` to Drive **~2s after the last change**
(debounced, restartable). The write stamps both `updatedAt` and `savedAt`;
the navbar shows "Saving…" while the write is in flight and "Saved
<time>" after, reading `savedAt`. `storage.save()` cancels the timer and
flushes immediately. The timer is cleared on close/disconnect/unmount so no
write escapes after the project is gone.

## 8. Service worker & updates

Pattern: cache-first with commit-based update detection.

- `src/sw.ts` is bundled to `dist/sw.js` by `scripts/build-meta.mjs`
  (esbuild, minified IIFE) after `vite build`.
- `build-meta.mjs` also writes `dist/buildinfo.js` as
  `self.BUILD_INFO = { commit, builtAt, files }`, where `commit` is the
  current git HEAD and `files` is the recursive `dist/` listing (taken
  **after** bundling so `sw.js` is included; `buildinfo.js` itself is
  cached explicitly, not listed).
- The worker installs by fetching `buildinfo.js` and precaching every
  listed file under cache name `comics-builder-v1`; old caches are deleted
  on activate.
- On every navigation it fetches `buildinfo.js` with `cache: "no-store"`;
  if the commit differs, it re-downloads all files and posts
  `UPDATE_READY` to clients.
- `src/sw-register.ts` registers `./sw.js` **only in production builds**
  (never in dev), polls hourly and on visibility change, and shows a
  Bootstrap "new version available" banner with a Reload button when an
  update lands.

## 9. Build pipeline

`npm run build`:

```
node scripts/extract-docs.mjs   # actions.ts -> actions.docs.gen.ts + public/llms.txt
tsc -b                          # TypeScript (project references)
vite build                      # -> dist/
node scripts/build-meta.mjs     # bundle src/sw.ts -> dist/sw.js; write dist/buildinfo.js
```

`npm run dev` runs the extractor first for the same reason. Formatting:
Prettier config in `.prettierrc.json` (single quotes, semicolons, 2-space,
100 col, es5 trailing commas); `npm run format` / `npm run format:check`;
a Husky pre-commit hook runs `lint-staged` on
`*.{js,ts,json,css,html,md}`. `src/ai/actions.docs.gen.ts` is gitignored.

CI (`.github/workflows/ci.yml`): `npm ci`, `npm run format:check`,
`npm run build`. Deploy (`.github/workflows/deploy.yml`): on pushes to
`main` touching code/build paths, configure Pages, `npm ci`, `npm run
build` with `VITE_GOOGLE_CLIENT_ID` from the repo secret, upload `dist/`,
deploy.

## 10. Styling rule

**Bootstrap owns all app chrome** — splash card, tiles, modal, navbar,
dropdown, banners, buttons, forms. Custom CSS (`src/App.css`) exists **only
for the comic canvas**: `.panels` grid, `.panel*` presentation,
`.panel-canvas` / `.panel-layer` positioning, `.bubble` variants, and a
small mobile adjustment. If it's UI chrome, it's a Bootstrap class; if
it's drawn comic content, it's custom CSS.

## 11. Agent testing constraints

- Drive OAuth during automated testing: the GIS popup (`storage.connect()`)
  needs the user's real click and cannot be completed headless. The device
  flow (`storage.connectWithDevice()`) is the headless path — the agent
  relays the URL + code to the user, who approves on any device; no
  throwaway credentials exist, so use the real user gesture.
- Static checks (tsc, vite build, prettier, extractor) are the automated
  gate. Live-browser verification — visual inspection and console
  injection of `window.ComicBuilder` — needs a real browser session and is
  done by the supervising agent, not the build subagent.
- After `npm run build` goes green and the deploy workflow is green,
  report OAuth-gated paths as unverified unless the user performed the
  gesture.
