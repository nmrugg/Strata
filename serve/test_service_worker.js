// serve/test_service_worker.js - the worker's own logic, driven for real.
//
// There is no browser on this box, so web/sw.js is loaded as written and the worker globals are stood in for:
// self.addEventListener, caches, fetch, clients.  What has to be proved is the ORDER, because that is the
// design: online the network answers and the cache is refreshed on the way past, so "edit app.js, reload, no
// restart" (LESSONS.md) stays true; the cache is used only when the network call fails, which is what makes
// the page open with nothing listening on the port.  And the API must never be answered from a cache - a
// stale /metrics or a replayed completion would look like a live answer.
//
//   node serve/test_service_worker.js        (counts ok lines; a hang prints nothing and exits 0)
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ORIGIN = "http://localhost:8080";
const done = [];
const ok = (m) => done.push(m);
const pn = (x) => { const u = typeof x === "string" ? x : x.url; return u.startsWith("http") ? new URL(u).pathname : u; };

// ---------------------------------------------------------------- the worker globals
class Res {
  constructor(body, ok = true) { this.body = body; this.ok = ok; }
  clone() { return new Res(this.body, this.ok); }
}

function makeEnv() {
  const env = {fetches: [], net: null, tag: "network", caches: new Map()};
  env.fetchImpl = (req) => {
    const p = pn(req);
    env.fetches.push(p);
    if (env.net === "down") return Promise.reject(new TypeError("Failed to fetch"));
    if (env.net === "one-missing" && p.startsWith("/fonts/")) return Promise.reject(new TypeError("Failed to fetch"));
    // env.tag changes between the install and the next visit, which is how case 2 can tell network-first from
    // cache-first: the two give different bytes once the cache is not empty
    return Promise.resolve(new Res(env.tag + ":" + p));
  };
  const cacheFor = (name) => {
    if (!env.caches.has(name)) {
      const map = new Map();
      env.caches.set(name, {
        map,
        add: (u) => env.fetchImpl({url: ORIGIN + u, method: "GET"}).then((r) => { if (!r.ok) throw new Error(r.body); map.set(pn(u), r); }),
        put: (req, res) => { map.set(pn(req), res); return Promise.resolve(); },
      });
    }
    return env.caches.get(name);
  };
  env.cachesObj = {
    open: (n) => Promise.resolve(cacheFor(n)),
    keys: () => Promise.resolve([...env.caches.keys()]),
    delete: (n) => Promise.resolve(env.caches.delete(n)),
    match: (req) => {
      for (const c of env.caches.values()) { const hit = c.map.get(pn(req)); if (hit) return Promise.resolve(hit); }
      return Promise.resolve(undefined);
    },
  };
  return env;
}

function loadWorker(env) {
  const src = fs.readFileSync(path.join(__dirname, "web", "sw.js"), "utf8");
  const handlers = {};
  const self = {
    addEventListener: (t, f) => { (handlers[t] = handlers[t] || []).push(f); },
    // a real URL, not a literal: the worker compares url.origin with self.location.origin, and a stub
    // location without an origin makes every request fall through it - which would look like "the worker
    // intercepts nothing" and be the stub's bug, not the worker's
    location: new URL(ORIGIN + "/sw.js"),
    skipWaiting: () => Promise.resolve(),
    clients: {claim: () => Promise.resolve()},
  };
  new Function("self", "caches", "fetch", "URL", src)(self, env.cachesObj, env.fetchImpl, URL);
  return handlers;
}

// drive one event; returns what respondWith was given (undefined when the worker chose not to intercept).
// The response is awaited BEFORE the waitUntil promises are drained: the worker calls waitUntil from inside
// the fetch's .then, so those promises only appear after the handlers have returned - and the cache write the
// tests assert on is one of them.
async function fire(handlers, type, event) {
  const waits = [];
  const e = Object.assign({}, event, {waitUntil: (p) => { waits.push(p); }, _r: undefined,
                                      respondWith: (p) => { e._r = p; }});
  for (const h of (handlers[type] || [])) h(e);
  if (e._r) e.response = await e._r;
  while (waits.length) { const batch = waits.splice(0); await Promise.all(batch); }
  return e;
}

const req = (url, method = "GET", mode) => ({url: ORIGIN + url, method, mode});

(async () => {
  // 1. install puts the shell in the cache, and one missing file does not cost the rest
  {
    const env = makeEnv(); env.net = "one-missing";
    const h = loadWorker(env);
    await fire(h, "install", {});
    const cached = [...(env.caches.get("strata-web-v1") || {map: new Map()}).map.keys()];
    for (const need of ["/", "/web/app.js", "/web/app.css", "/web/components.css", "/web/tokens.css"])
      assert.ok(cached.includes(need), "installed " + need + " from " + JSON.stringify(cached));
    assert.ok(!cached.includes("/fonts/outfit-latin-wght.woff2"), "the file that failed is simply not there");
    ok("install: the shell is cached, and one file failing costs only that file");
  }

  // 2. online: the network answers AND the cache is refreshed with what it answered, so an edited app.js
  // reaches the next visit without a restart - the rule the whole design turns on
  {
    const env = makeEnv(); env.net = "ok"; env.tag = "old";
    const h = loadWorker(env);
    await fire(h, "install", {});                       // the cache now holds a REAL copy of every file
    env.tag = "new";                                    // and the server has since been given an edited app.js
    env.fetches.length = 0;                             // the install's own fetches are not this request's
    const e = await fire(h, "fetch", {request: req("/web/app.js")});
    assert.strictEqual(e.response.body, "new:/web/app.js",
                       "online the network answers even though the cache holds a copy - cache-first would "
                       + "serve the old bytes and the page would never show an edit");
    assert.deepStrictEqual(env.fetches, ["/web/app.js"], "one network call");
    const stored = env.caches.get("strata-web-v1").map.get("/web/app.js");
    assert.strictEqual(stored.body, "new:/web/app.js", "and the cache now holds the NEW bytes");
    // offline from here: the reader gets the current file, not the one from install time
    env.net = "down";
    const off = await fire(h, "fetch", {request: req("/web/app.js")});
    assert.strictEqual(off.response.body, "new:/web/app.js", "offline: the refreshed copy, not the old one");
    ok("fetch online: the network answers over a cached copy and refreshes it, so an edited app.js shows with " +
       "no restart");
  }

  // 3. offline: the page and its files come from the cache; a navigation with no exact hit still gets the page
  {
    const env = makeEnv(); env.net = "ok";
    const h = loadWorker(env);
    await fire(h, "install", {});                      // filled while the server was up
    env.net = "down";                                  // and now nothing is listening
    for (const u of ["/", "/web/app.css", "/web/tokens.css", "/web/components.css",
                     "/fonts/outfit-latin-wght.woff2"]) {
      const e = await fire(h, "fetch", {request: req(u, "GET", u === "/" ? "navigate" : "cors")});
      assert.ok(e.response, "offline, " + u + " is answered");
      assert.strictEqual(e.response.body, "network:" + u, "from the cache: " + u);
    }
    // a cacheable navigation the cache has never seen (a bookmark of /index.html, which the shell stores as
    // "/") still gets the page rather than the browser's error screen
    const nav = await fire(h, "fetch", {request: req("/index.html", "GET", "navigate")});
    assert.ok(nav.response && nav.response.body === "network:/",
              "a cacheable navigation with no exact hit still gets the page: " + nav.response);
    // and a path that is not the page's own is not the worker's to answer, offline included
    const other = await fire(h, "fetch", {request: req("/some/other/page", "GET", "navigate")});
    assert.strictEqual(other._r, undefined, "an unknown path is not intercepted: the app has no other routes");
    ok("fetch offline: the page and its files come from the cache, as does a cacheable navigation with no exact hit");
  }

  // 4. the API is never intercepted, never cached, and a POST is left alone
  {
    const env = makeEnv(); env.net = "down";
    const h = loadWorker(env);
    await fire(h, "install", {});
    for (const u of ["/health", "/metrics", "/metrics?lite=1", "/settings", "/config", "/mcp", "/v1/models"]) {
      const e = await fire(h, "fetch", {request: req(u.split("?")[0])});
      assert.strictEqual(e._r, undefined, u + " is not the worker's to answer");
      assert.strictEqual(env.caches.get("strata-web-v1").map.has(pn(u)), false, u + " is not in the cache");
    }
    const post = await fire(h, "fetch", {request: req("/v1/chat/completions", "POST")});
    assert.strictEqual(post._r, undefined, "a completion request is never answered from a cache");
    const other = await fire(h, "fetch", {request: {url: "http://elsewhere.example/x", method: "GET"}});
    assert.strictEqual(other._r, undefined, "another origin is not ours to intercept");
    ok("the API, POSTs and other origins are left untouched - a replayed answer would look like a live one");
  }

  // 5. activate drops the caches an older worker left behind
  {
    const env = makeEnv(); env.net = "ok";
    env.caches.set("strata-web-v0", {map: new Map([["/web/app.js", new Res("ancillary")]])});
    const h = loadWorker(env);
    await fire(h, "activate", {});
    assert.strictEqual(env.caches.has("strata-web-v0"), false, "the old cache is gone");
    ok("activate: a new worker deletes the caches the old ones left");
  }

  console.log(done.map((d) => "ok - " + d).join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
