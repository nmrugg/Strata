// Strata's service worker (todo #offline-web-assets).  Why it exists: the server answers every asset with
// Cache-Control: no-cache plus an ETag (item asset-validator) so that editing app.js shows on the next reload
// with no restart - which also means every load asks the server, and with nothing listening on the port the
// navigation itself fails.  The conversations already survive (IndexedDB); the page did not.
//
// So: NETWORK-FIRST for everything, and the cache is used only when the network call fails.  That order is the
// whole design - it keeps "edit app.js, reload, no restart" true (LESSONS.md), keeps a running server showing
// the current files, and still opens the page when the server is not running at all.
//
// It is served from / (not /web/) because a worker's scope is its own path: /web/sw.js could never control /.
// It registers only in a secure context, so a page opened from a LAN address over plain http does not get one -
// that is a browser rule, not a Strata one, and it means "opens with no server" means on this PC.

// What "the page" is.  The icon sprite is not in the list: item sprite-inline already puts it in the HTML.
const SHELL = ["/", "/web/app.js", "/web/app.css", "/web/components.css", "/web/tokens.css", "/web/favicon.svg",
               "/fonts/outfit-latin-wght.woff2", "/fonts/outfit-latin-ext-wght.woff2"];
const CACHE = "strata-web-v1";

// Only the page and its own files.  Everything else on this origin is the API - /v1/*, /health, /metrics,
// /settings, /config, /mcp - and answering one of those from a cache would be worse than letting it fail:
// the answer is the model's, it changes every request, and a stale one would look like a reply.
function cacheable(pathname) {
  return pathname === "/" || pathname === "/index.html" || pathname.startsWith("/web/")
      || pathname.startsWith("/fonts/") || pathname === "/favicon.svg";
}

self.addEventListener("install", (e) => {
  // allSettled, not all: one missing file (a Monitor page that this server did not turn on) must not cost the
  // rest of the shell, and an install that rejects leaves the old worker serving forever.
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
              .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()                            // a new version drops the caches the old ones left
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));                // and takes over the page that is already open
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                    // POSTs are the API: never answered from a cache
  const url = new URL(req.url, self.location.href);
  if (url.origin !== self.location.origin) return;     // another origin: not ours to cache
  if (!cacheable(url.pathname)) return;
  e.respondWith(
    fetch(req).then((res) => {
      // online: the network answered, so the cache is updated on the way past - the next offline visit
      // gets the files this server is actually running, not the ones from when the worker was installed.
      if (res && res.ok) {
        const copy = res.clone();
        e.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
      }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit
      // a navigation with no cached copy of that exact URL still gets the page: the app is one file and one
      // stylesheet, so "the page, a little out of date" is the honest offline answer.
      || (req.mode === "navigate" ? caches.match("/") : undefined)))
  );
});
