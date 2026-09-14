/* 5G Training — Public PWA shell and local course content. */
const APP_VERSION = "3.4.1-b4";
const SHELL_CACHE = `5g-public-shell-${APP_VERSION}`;
const COURSE_CACHE = `5g-public-course-assets-${APP_VERSION}`;
const SHELL_URL = "./";
const CRITICAL_SHELL_ASSETS = [
  "./",
  "./src/js/app.js",
  "./src/js/courses-data.js",
  "./src/css/app.css"
];
const OPTIONAL_SHELL_ASSETS = [
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png"
];

async function cleanResponse(response) {
  if (!response || !response.redirected) return response;
  const headers = new Headers(response.headers);
  return new Response(await response.blob(), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function fetchClean(request) {
  const response = await fetch(request, { cache: "no-store", redirect: "follow" });
  if (!response || !response.ok) throw new Error("NETWORK_RESPONSE_NOT_OK");
  return cleanResponse(response);
}

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);

  // Every critical asset must fetch and cache successfully. Any rejection
  // propagates to install, so an incomplete shell cannot become active.
  await Promise.all(CRITICAL_SHELL_ASSETS.map(async function (url) {
    const response = await fetchClean(url);
    await cache.put(url, response);
  }));

  // Optional branding assets should never block activation of the app shell.
  await Promise.allSettled(OPTIONAL_SHELL_ASSETS.map(async function (url) {
    const response = await fetchClean(url);
    await cache.put(url, response);
  }));
}

function isCourseAsset(url) {
  return /\/assets\/courses\//i.test(url.pathname);
}

function isCoreAsset(url) {
  return /\/src\/(?:js|css)\/[a-z0-9._-]+$/i.test(url.pathname) ||
    /\/index\.html$/i.test(url.pathname) ||
    /\/manifest\.webmanifest$/i.test(url.pathname);
}

async function cacheCourseAssets(data, client) {
  const cache = await caches.open(COURSE_CACHE);
  const urls = Array.isArray(data && data.urls) ? data.urls : [];
  const validUrls = [];
  const seen = new Set();

  urls.forEach(function (value) {
    try {
      const url = new URL(String(value));
      if (url.origin !== self.location.origin || !isCourseAsset(url) || seen.has(url.href)) return;
      seen.add(url.href);
      validUrls.push(url.href);
    } catch (_) {}
  });

  const results = await Promise.allSettled(validUrls.map(async function (url) {
    const cached = await cache.match(url);
    if (cached) return true;
    const response = await fetchClean(url);
    await cache.put(url, response);
    return true;
  }));

  const cached = results.filter(function (result) {
    return result.status === "fulfilled" && result.value === true;
  }).length;

  if (client) {
    client.postMessage({
      type: "COURSE_ASSETS_CACHED",
      courseId: String(data && data.courseId || ""),
      total: validUrls.length,
      cached: cached
    });
  }
}

async function networkFirst(request, cacheName, cacheKey) {
  const cache = await caches.open(cacheName);
  try {
    const network = await fetchClean(request);
    await cache.put(cacheKey || request, network.clone());
    return network;
  } catch (_) {
    const cached = await cache.match(cacheKey || request);
    if (cached) return cached;
    return Response.error();
  }
}

self.addEventListener("install", function (event) {
  event.waitUntil((async function () {
    await precacheShell();
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", function (event) {
  event.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys.filter(function (key) {
      const isPreviousAppCache = key.indexOf("5g-public-shell-") === 0 ||
        key.indexOf("5g-public-course-assets-") === 0;
      return isPreviousAppCache && key !== SHELL_CACHE && key !== COURSE_CACHE;
    }).map(function (key) { return caches.delete(key); }));
    await self.clients.claim();
    const windowClients = await self.clients.matchAll({ type: "window" });
    windowClients.forEach(function (client) {
      client.postMessage({ type: "SW_ACTIVATED", version: APP_VERSION });
    });
  })());
});

self.addEventListener("fetch", function (event) {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try { url = new URL(request.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;

  if (isCourseAsset(url)) {
    event.respondWith((async function () {
      const cache = await caches.open(COURSE_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const network = await fetchClean(request);
        await cache.put(request, network.clone());
        return network;
      } catch (_) {
        // Let the browser report a real failed image request; never fabricate
        // an empty or 504 response that can poison the page or its cache.
        return Response.error();
      }
    })());
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, SHELL_CACHE, SHELL_URL));
    return;
  }

  if (isCoreAsset(url)) {
    event.respondWith(networkFirst(request, SHELL_CACHE));
  }
});

self.addEventListener("message", function (event) {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
  if (event.data && event.data.type === "CACHE_COURSE_ASSETS") {
    event.waitUntil(cacheCourseAssets(event.data, event.source));
  }
});
