/**
 * Service worker registration. Only active in production builds: the dev
 * server has no sw.js, and registering one there would cache stale modules.
 *
 * Shows a Bootstrap "new version available" banner when the worker reports
 * UPDATE_READY (a new build's commit was detected in buildinfo.js).
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        reg.addEventListener('updatefound', () => {
          const worker = reg.installing;
          worker?.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateBanner();
            }
          });
        });

        navigator.serviceWorker.addEventListener('message', (event) => {
          if (event.data && event.data.type === 'UPDATE_READY') {
            showUpdateBanner();
          }
        });

        const check = () => {
          reg.update().catch(() => {});
        };
        check();
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') check();
        });
        window.setInterval(check, 60 * 60 * 1000);
      })
      .catch(() => {
        /* service workers unavailable (e.g. insecure context) */
      });
  });
}

function showUpdateBanner(): void {
  if (document.getElementById('sw-update-banner')) return;
  const el = document.createElement('div');
  el.id = 'sw-update-banner';
  el.className =
    'alert alert-info alert-dismissible position-fixed top-0 start-50 translate-middle-x mt-2 shadow';
  (el as HTMLElement).style.zIndex = '1050';
  el.setAttribute('role', 'alert');

  const text = document.createElement('span');
  text.textContent = 'A new version of Comic Builder is available.';
  const btn = document.createElement('button');
  btn.className = 'btn btn-sm btn-primary ms-2';
  btn.textContent = 'Reload';
  btn.addEventListener('click', () => window.location.reload());
  el.appendChild(text);
  el.appendChild(btn);
  document.body.appendChild(el);
}
