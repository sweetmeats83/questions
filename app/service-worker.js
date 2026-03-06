// Minimal service worker — satisfies PWA installability requirement.
// Network-first: no caching (app runs on LAN, always fresh data wanted).

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

self.addEventListener('fetch', e => {
  // Let all requests go straight to the network.
  // Intercept navigations so we can show a friendly offline page if LAN drops.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request, { signal: AbortSignal.timeout(10000) }).catch(() =>
        new Response(
          '<html><body style="font-family:sans-serif;text-align:center;padding:4rem;background:#0c0c20;color:#aaa">' +
          '<h2 style="color:#e040fb">Question Roller</h2>' +
          '<p>Can\'t reach the server right now.<br>Make sure you\'re on the home network.</p>' +
          '</body></html>',
          { headers: { 'Content-Type': 'text/html' } }
        )
      )
    );
    return;
  }
  // API/media requests pass through without a timeout (transcription can take up to 60s)
  e.respondWith(fetch(e.request));
});
