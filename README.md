# Comic Builder

Build and edit a comic (or graphic novel) in your browser. Your comic is
stored as a `project.json` plus artwork files in a folder on **your Google
Drive** — the app is a static site with no server of its own.

## Run it locally

```bash
npm install
npm run dev
```

Open the printed URL. Connect your Google Drive once per session, then open
an existing project folder or create a new one. Every edit autosaves to Drive
about two seconds after you stop typing.

## Google Drive setup

The app talks to Drive through an OAuth web client:

1. Create a Google Cloud project, enable the Google Drive API, and create an
   **OAuth client ID** of type "Web application".
2. Add your origins as Authorized JavaScript origins (e.g.
   `https://rammehta1899.github.io` and `http://localhost:5173`). No redirect
   URIs and no client secret are needed.
3. For local dev: `VITE_GOOGLE_CLIENT_ID=<your-client-id> npm run dev`
   (put it in `.env.local`, which is gitignored).
4. For the deployed site: store the same value as the `GOOGLE_CLIENT_ID`
   repository secret — the deploy workflow reads it into
   `VITE_GOOGLE_CLIENT_ID` at build time.

For headless browsers and AI assistants, the app also offers the OAuth
device flow ("Connect with a code"):

1. In the same Cloud project, create a second **OAuth client ID** of type
   "TVs and Limited Input devices".
2. Store its client ID as the `GOOGLE_DEVICE_CLIENT_ID` repository secret
   and its client secret as `GOOGLE_DEVICE_CLIENT_SECRET` — the deploy
   workflow reads them into `VITE_GOOGLE_DEVICE_CLIENT_ID` and
   `VITE_GOOGLE_DEVICE_CLIENT_SECRET` at build time. The secret ships in
   the app bundle by design: Google's device-client model assumes
   distributed apps cannot keep secrets (the same model rclone uses).

The app asks for the `drive.file` scope only: it can see and touch just the
files and folders it created, nothing else on your Drive. The token lives only
in page memory — reloading the page drops it, one click reconnects, and
disconnecting revokes the grant at Google.

## Deploy

Pushing to `main` runs the `Deploy to GitHub Pages` workflow, which builds
`dist/` (including the service worker and build metadata) and publishes it.

## For AI agents

Open the browser console on any page of the app and type:

```js
ComicBuilder.help();
```

That prints the full skill: every action is documented via JSDoc-derived
`.toString()` docs on the runtime API. A static copy lives at `llms.txt`
(next to this README). The engineering design — architecture, data model,
Drive scope, autosave, service worker, build pipeline — is in `spec.md`.
