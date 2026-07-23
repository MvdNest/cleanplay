'use strict';

// Bump this value whenever the app shell changes. A new cache is populated
// before the previous one is removed, so an update never destroys the last
// known-good offline shell.
const CACHE_PREFIX = 'cleanplay-shell-';
const CACHE_VERSION = '2026-07-23-2';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

// registration.scope makes every URL work both at a custom domain and under
// the /cleanplay/ subpath used by GitHub Pages.
const SCOPE_URL = new URL('./', self.registration.scope);
const INDEX_URL = new URL('index.html', SCOPE_URL).href;
const APP_SHELL = [
  new URL('./', SCOPE_URL).href,
  INDEX_URL,
  new URL('manifest.webmanifest', SCOPE_URL).href,
  new URL('icons/icon.svg', SCOPE_URL).href,
  new URL('icons/icon-180.png', SCOPE_URL).href,
  new URL('icons/icon-192.png', SCOPE_URL).href,
  new URL('icons/icon-512.png', SCOPE_URL).href
];
const APP_SHELL_SET = new Set(APP_SHELL);

// OAuth callbacks and any future same-origin API proxies must always bypass
// Cache Storage. Spotify, its SDK, fonts, and lyrics are cross-origin and are
// also deliberately ignored by the fetch handler below.
const PRIVATE_QUERY_KEYS = new Set([
  'code',
  'state',
  'token',
  'access_token',
  'refresh_token',
  'code_verifier'
]);
const PRIVATE_PATH = /(?:^|\/)(?:api|oauth|authorize|callback|token|lyrics)(?:\/|$)/i;

function isPrivateRequest(url) {
  if (PRIVATE_PATH.test(url.pathname)) return true;
  for (const key of url.searchParams.keys()) {
    if (PRIVATE_QUERY_KEYS.has(key.toLowerCase())) return true;
  }
  return false;
}

function canCache(response) {
  return Boolean(
    response &&
    response.ok &&
    response.type === 'basic' &&
    new URL(response.url).origin === self.location.origin
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const requests = APP_SHELL.map((url) => new Request(url, { cache: 'reload' }));
    await cache.addAll(requests);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((name) => {
      if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) {
        return caches.delete(name);
      }
      return undefined;
    }));
    await self.clients.claim();
  })());
});

async function networkFirstNavigation(request) {
  const requestUrl = new URL(request.url);

  try {
    const response = await fetch(request, { cache: 'no-store' });

    // Store every clean navigation under one canonical key. In particular,
    // never persist an OAuth callback URL (or its query parameters).
    if (!isPrivateRequest(requestUrl) && canCache(response)) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(INDEX_URL, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(INDEX_URL, { ignoreSearch: true });
    if (cached) return cached;

    return new Response(
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0d0d0e"><title>CleanPlay offline</title><style>html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0d0e;color:#f4f4ec;font:16px system-ui;padding:24px;text-align:center}strong{color:#d4a449}</style><main><strong>CleanPlay is offline</strong><p>Reconnect, then try again.</p></main>',
      {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      }
    );
  }
}

async function cacheFirstShell(request) {
  const cached = await caches.match(request, { ignoreSearch: false });
  if (cached) return cached;

  const response = await fetch(request);
  if (canCache(response)) {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // No third-party response is ever intercepted or cached. This includes all
  // Spotify Web API/auth/SDK and LRCLIB/lyrics requests.
  if (url.origin !== self.location.origin || isPrivateRequest(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  // Exact allowlist: other same-origin files and dynamic requests stay on the
  // network and can never be accidentally added to this cache.
  if (!url.search && APP_SHELL_SET.has(url.href)) {
    event.respondWith(cacheFirstShell(request));
  }
});

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;

  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (type === 'GET_VERSION' && event.source) {
    event.source.postMessage({ type: 'SW_VERSION', version: CACHE_VERSION });
  }
});
