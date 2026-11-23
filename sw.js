/* Exam Grader service worker: offline cache for the app shell and the CDN libraries */
const VERSION = 'examgrader-v3';
const SHELL = [
  './', './index.html', './style.css', './manifest.webmanifest',
  './js/util.js', './js/db.js', './js/layout.js', './js/cv.js', './js/annot.js', './js/grade.js', './js/export.js', './js/ai.js', './js/app.js',
  './fonts/caveat-400.woff2', './fonts/caveat-600.woff2', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png'
];
const CDN = [
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
];

self.addEventListener('install', ev => {
  ev.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(SHELL);
    await Promise.all(CDN.map(u => c.add(new Request(u, { mode: 'cors' })).catch(() => null)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', ev => {
  ev.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isCdn = url.hostname === 'cdnjs.cloudflare.com';
  const isLocal = url.origin === self.location.origin;
  if (!isCdn && !isLocal) return;
  if (isCdn) {
    // versioned library URLs never change: cache first
    ev.respondWith(caches.match(req, { ignoreVary: true }).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') { const cp = res.clone(); caches.open(VERSION).then(c => c.put(req, cp)); }
      return res;
    })));
    return;
  }
  // app files: network first (so updates arrive), cache fallback when offline
  ev.respondWith(fetch(req).then(res => {
    if (res.ok) { const cp = res.clone(); caches.open(VERSION).then(c => c.put(req, cp)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('./index.html'))));
});
