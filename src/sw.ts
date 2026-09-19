/// <reference lib="webworker" />
export {};
declare const self: ServiceWorkerGlobalScope;

// Cache-first service worker with commit-based update detection. Ported from
// the template-game pattern: assets are served from cache first, and every
// page navigation triggers a background check of buildinfo.js — if its commit
// differs from what's cached, every file is re-fetched and clients are told
// an update is ready.
//
// The file list comes from buildinfo.js itself (written at build time by
// scripts/build-meta.mjs), so hashed Vite asset names never go stale.

const CACHE_NAME = 'comics-builder-v1';

interface BuildInfo {
  commit: string;
  builtAt: string;
  files: string[];
}

function log(message: string): void {
  try {
    console.log('[sw]', message);
  } catch {
    // console unavailable in some contexts
  }
}

function notifyClients(msg: Record<string, unknown>): Promise<void> {
  return self.clients
    .matchAll({ includeUncontrolled: true })
    .then((clients) => {
      clients.forEach((c) => c.postMessage(msg));
    })
    .catch(() => {});
}

function parseBuildInfo(text: string): BuildInfo | null {
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    return JSON.parse(text.slice(start, end + 1)) as BuildInfo;
  } catch {
    return null;
  }
}

function fetchBuildInfo(): Promise<BuildInfo | null> {
  return fetch('./buildinfo.js', { cache: 'no-store' })
    .then((res) => (res.ok ? res.text() : null))
    .then((text) => (text ? parseBuildInfo(text) : null))
    .catch(() => null);
}

function cacheKey(file: string): string {
  return file.startsWith('./') ? file : `./${file}`;
}

function precache(info: BuildInfo): Promise<void> {
  const files = ['./buildinfo.js', ...info.files.map(cacheKey)];
  return caches.open(CACHE_NAME).then((cache) =>
    Promise.all(
      files.map((url) =>
        fetch(url, { cache: 'reload' })
          .then((res) => {
            if (res && res.status === 200) return cache.put(url, res);
            log(`precache skipped ${url}: status ${res && res.status}`);
          })
          .catch((e) => log(`precache FAILED: ${url} - ${e}`))
      )
    ).then(() => undefined)
  );
}

function getCachedBuildInfo(): Promise<BuildInfo | null> {
  return caches
    .open(CACHE_NAME)
    .then((cache) => cache.match('./buildinfo.js'))
    .then((cached) => (cached ? cached.text() : null))
    .then((text) => (text ? parseBuildInfo(text) : null));
}

function checkForUpdate(): Promise<void> {
  return fetchBuildInfo().then((remote) => {
    if (!remote) return;
    return getCachedBuildInfo().then((current) => {
      if (!current || current.commit !== remote.commit) {
        log(`new build detected: ${remote.commit} (was ${current && current.commit})`);
        return precache(remote).then(() =>
          notifyClients({ type: 'UPDATE_READY', buildInfo: remote })
        );
      }
      return notifyClients({ type: 'BUILD_STATUS', commit: current.commit });
    });
  });
}

self.addEventListener('install', (event) => {
  log('install: fetching buildinfo and precaching');
  event.waitUntil(
    fetchBuildInfo()
      .then((info) => {
        if (!info) throw new Error('no buildinfo.js');
        return precache(info);
      })
      .then(() => self.skipWaiting())
      .catch((e) => log(`install failed: ${e}`))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Background update check on every navigation.
  if (req.mode === 'navigate') {
    event.waitUntil(checkForUpdate());
  }

  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ??
        fetch(req).then((res) => {
          // Opportunistically cache same-origin GETs (e.g. llms.txt, schema).
          if (res && res.status === 200) {
            const copy = res.clone();
            caches
              .open(CACHE_NAME)
              .then((cache) => cache.put(req, copy))
              .catch(() => {});
          }
          return res;
        })
    )
  );
});
