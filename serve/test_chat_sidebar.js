// What the chat list does, run against the real app.js with a stub DOM and a stub IndexedDB.
// Run with: node serve/test_chat_sidebar.js   (the Python test runs it too and skips when node is missing)
//
// The stub is faithful only where the code under test depends on it: the result of a read is on the request and
// not on the store; a write the browser refuses fires abort on the transaction; a blocked open never resolves;
// a database already at version 1 does not run onupgradeneeded; a node put in place or appended is a child of the
// node it went into; and a class selector matches whole class tokens, so a click on a field inside a row reaches
// the row through the list's handler, as it does on the page. Requests answer on a later tick, so the code
// cannot be right by answering too early.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------- the stub DOM
function makeEl() {
  const el = {
    dataset: {}, attrs: {}, children: [], value: "", hidden: false, className: "", textContent: "",
    classList: {add() {}, remove() {}, toggle() {}}, style: {},
    scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    addEventListener(t, f) { (this._l = this._l || {})[t] = f; },   // one handler per type: tests call it directly
    appendChild(c) { this.children.push(c); c._parent = this; return c; },
    append(...a) { for (const x of a) { if (typeof x === "string") this.children.push({nodeType: 3, textContent: x, _parent: this}); else { this.children.push(x); x._parent = this; } } },
    get lastElementChild() { return this.children.length ? this.children[this.children.length - 1] : null; },
    get nextElementSibling() {
      const p = this._parent; if (!p) return null;
      const i = p.children.indexOf(this); return i >= 0 && i + 1 < p.children.length ? p.children[i + 1] : null;
    },
    get firstChild() { return this.children.length ? this.children[0] : null; },
    // the page inserts exactly one element per markdown block, so one call makes one child: faithful where the
    // code under test depends on element identity and on what sits next to what
    insertAdjacentHTML(where, html) {
      const n = makeEl(); n._html = html;
      const tag = /^<([a-z][\w-]*)/i.exec(html);              // a real parse gives the element its tag, and the
      if (tag) n.tagName = tag[1].toUpperCase();              // page's listeners test on it (tagName !== DETAILS)
      // the page inserts exactly one element per markdown block, so one call makes one child: faithful where
      // the code under test depends on element identity and on what sits next to what.  The root element's own
      // classes are registered so querySelector finds the node the page just made instead of inventing a
      // second one - which is what lets a test assert that a thinking block or a tool block survived a repaint
      const root = /class="([^"]*)"/.exec(html);
      if (root) { n.className = root[1].trim(); n._parentMade = root[1].split(/\s+/); }
      // a bare boolean attribute in the inserted markup is part of the element the page made: without this a
      // shell that starts hidden looks visible to the tests, and "the container vanished" tests green
      const openTag = /^<[a-z][\w-]*([^>]*)>/i.exec(html);
      if (openTag && /[\s](hidden)(?=[\s>]|$)/.test(openTag[1])) n.hidden = true;
      if (where === "beforeend") { this._ins = (this._ins || 0) + 1; this.children.push(n); n._parent = this; }
      else if (where === "afterend") {
        const p = this._parent; if (!p) throw new Error("insertAdjacentHTML afterend with no parent");
        p._ins = (p._ins || 0) + 1;
        p.children.splice(p.children.indexOf(this) + 1, 0, n); n._parent = p;
      } else throw new Error("insertAdjacentHTML: this page never uses " + where);
      (n._parent._made = n._parent._made || {});
      for (const c of (n._parentMade || [])) if (!(c in n._parent._made)) n._parent._made[c] = n;
      return n;
    },
    querySelectorAll(sel) { return this.children.filter((c) => c.className.includes(sel.slice(1))); },
    // the page reads a node it built with innerHTML; the stub hands back a place to write into.  The LAST token
    // is what the page's selectors target (".st-collapse think" asks for the think element, not the collapse),
    // and the same selector asked for twice must give the same node or identity cannot be tested at all
    querySelector(sel) {
      const attr = /^\[([\w-]+)\]$/.exec(sel);
      const key = attr ? attr[1] : sel.trim().split(/\s+/).pop().replace(/^\./, "");
      const made = this._made = this._made || {};
      if (made[key]) return made[key];
      const found = this.children.find((c) => c.className.split(/\s+/).includes(key) || key in c.attrs);
      if (found) { made[key] = found; return found; }
      const n = makeEl(); n.className = key; n._parent = this; this.children.push(n); made[key] = n;
      return n;
    },
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
    focus() {}, select() {},
    remove() { if (this._parent) this._parent.children = this._parent.children.filter((c) => c !== this); },
    replaceWith(next) { const p = this._parent; if (p) { p.children = p.children.map((c) => (c === this ? next : c)); next._parent = p; } },
    // a browser matches a class selector on whole class tokens: "chat-item__input" is not ".chat-item", so a
    // click on the rename field walks up to its row, the way it does on the page
    closest(sel) {
      const cls = /^\.([\w-]+)$/.exec(sel), attr = /^\[([\w-]+)\]$/.exec(sel);
      let n = this;
      while (n) {
        if (cls) { if (n.className.split(/\s+/).includes(cls[1])) return n; }
        else if (attr) { if (attr[1] in n.dataset || attr[1] in n.attrs) return n; }
        n = n._parent;
      }
      return null;
    },
  };
  // a real <details> fires a toggle event when its open state changes, including when script changes it, and
  // that is how the page's own _auto flag is consumed before the reader's next click
  Object.defineProperty(el, "open", {get: () => !!el._open, set: (v) => {
    if (!!v === !!el._open) return;
    el._open = !!v;
    for (let p = el._parent; p; p = p._parent) if (p._l && p._l.toggle) p._l.toggle({target: el});
  }});
  Object.defineProperty(el, "innerHTML", {get: () => el._html || "",
    set: (v) => { el._sets = (el._sets || 0) + 1; el._html = v; el.children = []; el._made = {}; }});   // _sets counts whole-subtree replaces
  // a real classList has contains(), and the page's toggle listener uses it to tell a thinking block from a tool
  // block; without it every toggle the test fires would throw.  add() and remove() move className for real, so a
  // test can see a class the page put there (the caret case) instead of passing on a stub that ignored it
  el.classList.contains = (c) => el.className.split(/\s+/).includes(c);
  el.classList.add = (c) => { const set = new Set((el.className || "").split(/\s+/).filter(Boolean)); set.add(c);
                              el.className = [...set].join(" "); };
  el.classList.remove = (c) => { el.className = (el.className || "").split(/\s+/).filter((x) => x && x !== c).join(" "); };
  return el;
}

// ---------------------------------------------------------------- the stub IndexedDB
function makeIdb(hooks, seed) {
  const data = Object.assign({}, seed);          // the records, keyed by id
  const stores = {};                             // the store is only there if the upgrade handler made it
  const calls = {upgradeneeded: 0, createObjectStore: 0};
  let current = null;                            // the transaction a request belongs to
  const store = {
    transaction: null,
    put(value) {
      const req = {result: null, error: null, transaction: current, onsuccess: null, onerror: null};
      queueMicrotask(() => {
        if (hooks.quota) { req.error = {name: "QuotaExceededError"}; req.onerror && req.onerror(); return; }
        if (hooks.abort) return;                       // the transaction aborts, the request says nothing
        // as on the read side: a real put structured-clones, so the record does not alias the page's object
        data[value.id] = JSON.parse(JSON.stringify(value)); req.result = value; req.onsuccess && req.onsuccess();
      });
      return req;
    },
    delete(key) {
      const req = {result: null, error: null, transaction: current, onsuccess: null, onerror: null};
      queueMicrotask(() => {
        if (hooks.quota) { req.error = {name: "QuotaExceededError"}; req.onerror && req.onerror(); return; }
        if (hooks.abort) return;                       // the transaction aborts, the request says nothing
        delete data[key]; req.result = true; req.onsuccess && req.onsuccess();
      });
      return req;
    },
    getAll() {
      const req = {result: null, error: null, transaction: current, onsuccess: null, onerror: null};
      queueMicrotask(() => {
        if (hooks.abort) return;                       // the transaction aborts, the request says nothing
        // a real IndexedDB read structured-clones: the record and the object the page gets back are separate.
        // Handing out the live objects made case 5 pass for the wrong reason - writing chats[0].title wrote the
        // record by aliasing - so an app that stops mutating the object it read looked like a regression.
        req.result = Object.values(data).map((v) => JSON.parse(JSON.stringify(v)));
        req.onsuccess && req.onsuccess();
      });
      return req;
    },
  };
  const transaction = () => {
    const t = {error: null, oncomplete: null, onerror: null, onabort: null, objectStore: () => store};
    current = t;
    store.transaction = t;
    queueMicrotask(() => {
      if (hooks.quota || hooks.abort) { t.error = {name: hooks.quota ? "QuotaExceededError" : hooks.abort}; t.onabort && t.onabort(); }
      else if (t.oncomplete) t.oncomplete();
    });
    return t;
  };
  // a version change is what creates the store, so a database already at version 1 may not have it
  const db = {objectStoreNames: {contains: (n) => n in stores}, createObjectStore: (n) => { calls.createObjectStore++; stores[n] = store; },
             transaction};
  return {open: () => {
    if (hooks.throws) throw new Error("private mode");
    const r = {result: db, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null};
    queueMicrotask(() => {
      if (hooks.blocked) { r.onblocked && r.onblocked(); return; }
      if (hooks.newDatabase !== false) { calls.upgradeneeded++; r.onupgradeneeded && r.onupgradeneeded(); }
      r.result = db; r.onsuccess && r.onsuccess();
    });
    return r;
  }, records: data, calls};
}

// ---------------------------------------------------------------- run app.js as the page would
function run(hooks, stored, seed) {
  const byId = {};
  const document = {getElementById: (id) => (byId[id] = byId[id] || makeEl()),
                    createElement: () => makeEl(), createTextNode: (t) => ({nodeType: 3, textContent: t}),
                    documentElement: {dataset: {}},
                    body: makeEl(),                                   // the row menu is appended to <body> (todo #chat-row-menu)
                    hidden: false,                                    // pollDelay reads it; a test flips it
                    _l: {}, addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); },   // recorded so a test can fire the document click/keydown
                    querySelectorAll: () => []};
  const idb = makeIdb(hooks, seed);
  // window listeners are recorded so a test can ask "is anything holding the page open right now, and what
  // does it do to the event" - the page's own leave warning is added and removed with the busy flag
  const win = {_l: {}, addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); },
               removeEventListener(t, f) { this._l[t] = (this._l[t] || []).filter((g) => g !== f); },
               open: (u) => { opened.push(u); return {}; }};
  const confirms = [], confirmAnswer = {yes: true}, copied = [], raf = [], timers = [], fetches = [], opened = [];
  const answer = async () => ({ok: true, json: async () => ({}), text: async () => ""});
  // requestAnimationFrame is queued, not swallowed: a stream that never paints cannot be tested at all, and
  // flush() gives a test the same "one paint per frame" interleaving the browser gives the page.
  // setTimeout is recorded rather than discarded, so a test can arm a timer and fire the one it cares about
  // (the hover intent window) without running every other pending timeout in the page.
  const env = {                                        // guard and the discard guard - record and answer both
    document, localStorage: {getItem: (k) => (k in stored ? stored[k] : null), setItem: (k, v) => { stored[k] = v; }},
    indexedDB: idb, location: {hash: "", pathname: "/", origin: "http://127.0.0.1"},
    history: {replaceState() {}}, matchMedia: () => ({matches: false, addEventListener() {}}),
    fetch: (...a) => { fetches.push(a[0]); return ((hooks.fetch || answer)(...a)); },
    confirm: (m) => { confirms.push(m); return confirmAnswer.yes; },
    setTimeout: (f, ms) => { timers.push({f, ms}); return timers.length; },
    clearTimeout: (id) => { if (id) timers[id - 1] = {f: null, ms: 0}; },
    requestAnimationFrame: (f) => { raf.push(f); return raf.length; }, cancelAnimationFrame: () => {},
    navigator: {clipboard: {writeText: async (t) => { copied.push(t); }}},   // what the page put on the clipboard
    URL: {createObjectURL: () => "blob:stub", revokeObjectURL: () => {}},   // the image open-in-tab path builds a blob: URL
    innerWidth: 1200, innerHeight: 800, window: win, queueMicrotask,
  };
  const names = Object.keys(env);
  const source = fs.readFileSync(path.join(__dirname, "web", "app.js"), "utf8") +
    "\nreturn {get historyOn() { return historyOn; }, get chats() { return chats; }, get chat() { return chat; }, " +
    "get messages() { return messages; }, get db() { return db; }, get attachments() { return attachments; }, chatTitle, groupName, setHistory, startChat, openChat, " +
    "deleteChat, renameChat, cloneChat, exportChatMd, saveChat, renderSidebar, setBusy, send, poll, noteLive, deleteAttachmentsOnly, addFiles, msgEl, updateAssistant, renderBubble, toolHtml, " +
    "bubbleParts, toolSync, toolOpen, onTool, render, apiMessages, assistantMessages, turnMarkdown, safeFileName, " +
    "pollUrl, pollDelay, renderPill, renderLite, hoverTab, prefetchFull, " +
    "getLastHoverFetch: () => lastHoverFetch, setLastHoverFetch: (t) => { lastHoverFetch = t; }, " +
    "setTab: (t) => { tab = t; }, setHidden: (v) => { document.hidden = v; }, " +
    "get busy() { return busy; }, get chatId() { return chatId; }, " +
    "get settings() { return settings; }, setSettings: (s) => { settings = {...DEFAULTS, ...s}; }, get DEFAULTS() { return DEFAULTS; }, " +
    "openDrawer, closeDrawer, loadDrawer, drawerSettings, drawerDirty, get sharedOn() { return sharedOn; }, " +
    "setQuery: (v) => { sidebarQuery = v; renderSidebar(); }, el: document.getElementById, get chatMenu() { return activePopover; }, get viewerEl() { return viewerEl; }, get modalEl() { return msgModal; }, get lastLive() { return lastLive; }, get settingsModal() { return settingsModal; }, openChatPicker, parseChatsJsonl, chatToJsonl, parseLlamaJsonl, parseImport, unzipEntries, row: (cls) => document.getElementById(\"sidebar-list\").children.find((c) => c.className.includes(cls))};";
  const api = {s: new Function(...names, source)(...names.map((n) => env[n])), stored, records: idb.records, calls: idb.calls, win, confirms, confirmAnswer, copied,
               fetches, timers, body: document.body, opened, fireDoc: (t, ev) => (document._l[t] || []).forEach((f) => f(ev)), flush: () => { while (raf.length) raf.shift()(); }};
  return api;
}

const wait = () => new Promise((r) => setTimeout(r, 30));
const rows = (s) => s.el("sidebar-list").children.filter((c) => c.className.split(" ").includes("chat-item")).length;
const groups = (s) => s.el("sidebar-list").children.filter((c) => c.className.split(" ").includes("sidebar-group")).map((c) => c.textContent);
// the warning is a promise to the user, so its kind and its title are part of what is checked here
const warns = (s) => s.el("toasts").children.filter((t) => t.className.split(" ").includes("st-toast--warn"));
const warnTitle = (s) => warns(s).map((t) => t.querySelector(".st-toast__title").textContent).join(" | ");
const warnText = (s) => warns(s).map((t) => t.querySelector(".t-text").textContent).join(" | ");
const firstText = (c) => (c.messages[0] || {}).text || "(empty)";
const msg = (text) => ({role: "user", text, time: Date.now()});
// the quarter label the sidebar uses for a chat past 30 days (todo #sidebar-quarter-groups).  Cases 14 and 51
// just need an old chat to land in SOME quarter bucket, so they compute the expected heading with this; case 52
// pins the formula itself against literal strings, so a wrong formula cannot hide behind a matching helper.
const qlabel = (t) => { const d = new Date(t); return `${d.getFullYear()} Q${Math.floor(d.getMonth() / 3) + 1}`; };

(async () => {
  const done = [];

  // 1. the switch off: the store is never opened, and the single chat is the page from the last release
  const off0 = run({}, {});
  await wait();
  assert.strictEqual(off0.s.historyOn, false, "off is the default");
  assert.strictEqual(off0.s.db, null, "off never opens the store");
  off0.s.messages.push(msg("the first conversation"));
  off0.s.saveChat();
  assert.strictEqual(JSON.parse(off0.stored["strata.chat"])[0].text, "the first conversation");
  assert.deepStrictEqual(Object.keys(off0.stored), ["strata.chat"], "off writes only the single chat");
  done.push("off: the store is not opened, only strata.chat is written");

  // 2. a page load with four records: the list is what the read returned
  const seed = {};
  for (let i = 0; i < 4; i++) seed["c" + i] = {id: "c" + i, title: "chat " + i, time: Date.now() - i * 3600000, messages: [msg("chat " + i)]};
  const four = run({}, {"strata.history": "true", "strata.chatId": JSON.stringify("c1")}, seed);
  await wait();
  assert.strictEqual(four.s.chats.length, 4, "all four records are read");
  assert.strictEqual(rows(four.s), 4, "the list shows them");
  assert.strictEqual(four.s.chatTitle(four.s.chat), "chat 1", "the open one is the one stored as open");
  done.push("read: 4 records in the store, 4 rows in the list");

  // 3. his steps on #1787: off, a conversation, switch on, New chat, reload - the new chat stays empty
  const b = run({}, {});
  await wait();
  b.s.messages.push(msg("the first conversation"));
  b.s.saveChat();
  b.s.setHistory(true, true, true);           // flipped in this session: the chat on the screen becomes the record
  await wait();
  assert.strictEqual(b.s.chats.length, 1, "the chat on the screen became the first record");
  b.s.startChat();
  await wait();
  assert.strictEqual(b.s.chat.messages.length, 0, "the new chat is empty");
  const again = run({}, JSON.parse(JSON.stringify(b.stored)),
                    b.s.chats.reduce((o, c) => (o[c.id] = JSON.parse(JSON.stringify(c)), o), {}));
  await wait();
  assert.strictEqual(again.s.chats.length, 2, "both chats are in the list after the reload");
  assert.strictEqual(again.s.chat.messages.length, 0, "the new chat is still empty after the reload");
  assert.strictEqual(firstText(again.s.chats[0]), "the first conversation", "the migrated record kept the conversation");
  done.push("new chat: stays empty after a reload, the previous one is kept");

  // 4. a browser that only had the single chat gets it as the first record
  const mig = run({}, {"strata.history": "true", "strata.chat": JSON.stringify([msg("old chat")])});
  await wait();
  assert.strictEqual(mig.s.chats.length, 1, "the single chat became the first record");
  assert.strictEqual(firstText(mig.s.chats[0]), "old chat");
  done.push("migration: strata.chat becomes the first record");

  // 5. rename and delete go to the record
  const id = again.s.chats[0].id;
  again.s.chats[0].title = "renamed";
  again.s.saveChat(again.s.chats[0]);            // the renamed chat, not whichever one is open
  await wait();
  assert.strictEqual(again.records[id].title, "renamed", "the name is in the record");
  again.s.deleteChat(again.s.chats[0]);
  await wait();
  assert.ok(!(id in again.records), "the record is gone");
  done.push("rename and delete: the record changes");

  // 6. private mode: the list lives in memory, but a delete still has to show
  const mem = run({throws: true}, {"strata.history": "true"});
  await wait();
  assert.strictEqual(mem.s.db, null, "the store is not available");
  assert.strictEqual(warns(mem.s).length, 1, "one warning");
  assert.ok(warnTitle(mem.s).includes("Chat list not saved"), "the warning is about the list");
  assert.ok(warnText(mem.s).includes("memory"), "the user is told the list lives in memory");
  mem.s.chats.push({id: "x1", title: "a", time: Date.now(), messages: [msg("hi")]});
  mem.s.chats.push({id: "x2", title: "b", time: Date.now(), messages: [msg("yo")]});
  mem.s.renderSidebar();
  assert.strictEqual(rows(mem.s), 3, "the three chats show");
  mem.s.deleteChat(mem.s.chats[1]);
  await wait();
  assert.strictEqual(rows(mem.s), 2, "the row goes away, so the list re-rendered");
  const memRow = mem.s.el("sidebar-list").children.find((c) => c.className.split(" ").includes("chat-item"));
  mem.s.renameChat(memRow, mem.s.chats[0]);
  const memField = memRow.children.find((c) => c.className.split(" ").includes("chat-item__input"));
  memField.value = "renamed in memory";
  memField._l["keydown"]({key: "Enter", preventDefault() {}});
  await wait();
  assert.ok(mem.s.el("sidebar-list").children.some((c) => (c.innerHTML || "").includes("renamed in memory")),
            "the rename shows in memory-only mode too");
  done.push("memory only: a rename and a delete still update the list");

  // 7. a fresh database: the store exists because app.js made it in the upgrade handler
  const fresh = run({}, {"strata.history": "true"});
  await wait();
  assert.strictEqual(fresh.calls.upgradeneeded, 1, "a fresh database runs onupgradeneeded");
  assert.strictEqual(fresh.calls.createObjectStore, 1, "the upgrade handler created the chats store");
  assert.ok(fresh.s.db, "the store is there");
  done.push("fresh database: the upgrade handler creates the chats store");

  // 8. a database already at version 1 does not run onupgradeneeded, so the store may not be there
  const wrong = run({newDatabase: false}, {"strata.history": "true"});
  await wait();
  assert.strictEqual(wrong.s.db, null, "a missing store is the memory-only path, not a throw");
  assert.strictEqual(wrong.calls.createObjectStore, 0, "nothing was created, and nothing was read from it");
  done.push("missing store: memory only, no unhandled rejection");

  // 9. a blocked open never resolves on its own
  const blocked = run({blocked: true}, {"strata.history": "true"});
  await wait();
  assert.strictEqual(blocked.s.db, null, "the blocked open resolves to the memory-only path");
  assert.ok(warnText(blocked.s).includes("memory"), "the user is told the list lives in memory");
  done.push("blocked open: it resolves to memory only instead of hanging");

  // 10. a write the browser refuses warns on the event that actually fires
  const full = run({quota: true}, {"strata.history": "true"});
  await wait();
  full.s.messages.push(msg("a three megabyte answer"));
  full.s.saveChat();
  await wait();
  assert.ok(warnText(full.s).includes("cannot keep more"), "the quota warning is shown on abort");
  full.s.saveChat();
  await wait();
  assert.strictEqual(warns(full.s).length, 1, "it warns once, not on every write");
  done.push("quota: the warning fires on the abort event");

  // 11. flipping the switch off stores the chat you were in, so a reload shows it
  const off = run({}, {"strata.history": "true", "strata.chat": JSON.stringify([msg("the OLD single chat")])});
  await wait();
  off.s.chats[0].messages.push(msg("work done in the sidebar"));
  off.s.saveChat();
  off.s.setHistory(false, true, true);
  assert.deepStrictEqual(JSON.parse(off.stored["strata.chat"]).map((m) => m.text),
                         ["the OLD single chat", "work done in the sidebar"], "a reload shows the chat you were in");
  done.push("off: the single chat is written when the switch is flipped");

  // 12. pictures are stored as names only
  const pic = run({}, {"strata.history": "true"});
  await wait();
  pic.s.chats[0].messages.push({role: "user", text: "the photo", time: Date.now(),
                                images: [{name: "photo.png", url: "data:image/png;base64,AAA"}]});
  pic.s.saveChat();
  await wait();
  assert.deepStrictEqual(pic.records[pic.s.chat.id].messages[0].images, [{name: "photo.png", url: "data:image/png;base64,AAA"}],
                         "the IndexedDB record keeps the image data URL, so a reload can still show it");
  done.push("pictures: bytes kept in the IndexedDB record (stripped only for the localStorage single-chat)");

  // 13. the search covers the title and the message text
  const search = run({}, {"strata.history": "true"}, {
    a: {id: "a", title: "the garden", time: Date.now(), messages: [msg("watering the tomatoes")]},
    b: {id: "b", title: "a chat about code", time: Date.now(), messages: [msg("nothing here")]},
    c: {id: "c", title: "tomatoes again", time: Date.now(), messages: [msg("a different question")]}});
  await wait();
  assert.strictEqual(rows(search.s), 3, "all three chats show");
  search.s.setQuery("tomatoes");
  assert.strictEqual(rows(search.s), 2, "two match: one by title, one by its message text");
  search.s.setQuery("code");
  assert.strictEqual(rows(search.s), 1, "one by title only");
  search.s.setQuery("nothing here");
  assert.strictEqual(rows(search.s), 1, "one by its message text");
  done.push("search: titles and message text");

  // 14. the day groups.  Built from local calendar midnights, not from `Date.now() - N * 86400000`: the groups
  // are calendar days now (todo #sidebar-yesterday), and an arithmetic offset lands on a different calendar day
  // depending on the wall-clock time the test runs at, so a fixed hour (noon) on a fixed day is what is stable.
  const now14 = new Date();
  const at14 = (d) => new Date(now14.getFullYear(), now14.getMonth(), now14.getDate() + d, 12, 0).getTime();
  const grouped = run({}, {"strata.history": "true"}, {
    today: {id: "today", title: "today", time: at14(0), messages: [msg("a")]},
    yesterday: {id: "yesterday", title: "yesterday", time: at14(-1), messages: [msg("b")]},
    week: {id: "week", title: "week", time: at14(-5), messages: [msg("c")]},
    older: {id: "older", title: "older", time: at14(-40), messages: [msg("d")]}});
  await wait();
  assert.deepStrictEqual(groups(grouped.s), ["Today", "Yesterday", "Previous 7 days", qlabel(at14(-40))],
                         "the day groups - past 30 days it is a quarter bucket, not 'Older'");

  // the group names come out newest first, and a chat inside seven days is in the same group
  grouped.s.chats[0].time = at14(-2);
  grouped.s.renderSidebar();
  assert.deepStrictEqual(groups(grouped.s), ["Yesterday", "Previous 7 days", qlabel(at14(-40))], "the group follows the chat");
  done.push("day groups: Today, Yesterday, Previous 7 days, then a quarter past 30 days");

  // 15. rename through the field: Enter keeps the name, Escape gives it up
  const row = search.s.el("sidebar-list").children.find((c) => c.className.split(" ").includes("chat-item"));
  const target = search.s.chats.find((c) => c.id === "b");
  search.s.renameChat(row, target);
  const field = row.children.find((c) => c.className.split(" ").includes("chat-item__input"));
  assert.ok(field, "the row turned into a field");
  field.value = "renamed by the field";
  field._l["keydown"]({key: "Enter", preventDefault() {}});
  await wait();
  assert.strictEqual(search.records["b"].title, "renamed by the field", "Enter keeps the name");
  search.s.renameChat(search.s.el("sidebar-list").children.find((c) => c.className.split(" ").includes("chat-item")), target);
  const field2 = search.s.el("sidebar-list").children.find((c) => c.className.split(" ").includes("chat-item")).children.find((c) => c.className.split(" ").includes("chat-item__input"));
  field2.value = "given up";
  field2._l["keydown"]({key: "Escape", preventDefault() {}});
  await wait();
  assert.strictEqual(search.records["b"].title, "renamed by the field", "Escape gives the name up");
  done.push("rename: Enter keeps, Escape gives up");

  // 16. delete with Undo: the record comes back, and pressing Undo twice does not put it in twice
  const undo = run({}, {"strata.history": "true"}, {a: {id: "a", title: "the one", time: Date.now(), messages: [msg("hi")]}});
  await wait();
  undo.s.deleteChat(undo.s.chats[0]);
  await wait();
  assert.strictEqual(undo.s.chats.length, 1, "the open chat was replaced by a new one");
  assert.ok(!(("a") in undo.records), "the record is gone");
  const button = undo.s.el("toasts").children[0].children.find((c) => c.className.split(" ").includes("st-btn"));
  assert.ok(button, "the toast offers Undo");
  button.onclick();
  await wait();
  assert.strictEqual(undo.records["a"].title, "the one", "the record is back");
  assert.strictEqual(undo.s.chats.length, 2, "the chat you were in is put back next to the new one");
  button.onclick();
  await wait();
  assert.strictEqual(undo.s.chats.length, 2, "the second Undo does not put it in twice");
  done.push("delete with Undo: the record comes back, twice does not double");

  // 17. a read transaction that aborts still answers, so the page does not hang
  const aborted = run({abort: "DataError"}, {"strata.history": "true"},
                      {a: {id: "a", title: "the one", time: Date.now(), messages: [msg("hi")]}});
  await wait();
  assert.strictEqual(rows(aborted.s), 1, "the read answered empty instead of never resolving");
  assert.ok(!aborted.s.chats.some((c) => c.id === "a"), "so the record is not in the list");
  assert.ok(aborted.s.chat, "and the page still rendered a chat");
  done.push("read that aborts: it answers empty instead of never resolving");

  // 18. a transaction that aborts for another reason does not say the storage is full
  const bad = run({abort: "DataError"}, {"strata.history": "true"});
  await wait();
  bad.s.messages.push(msg("a chat that cannot be stored"));
  bad.s.saveChat();
  await wait();
  assert.ok(warnText(bad.s).includes("could not be saved"), "the message fits the error");
  assert.ok(!warnText(bad.s).includes("cannot keep more"), "and not the quota message");
  done.push("abort for another reason: the message is not the quota one");

  // 19. a chat that is not in the list is not the last one
  const stray = run({}, {"strata.history": "true"}, {
    a: {id: "a", title: "first", time: Date.now(), messages: [msg("one")]},
    b: {id: "b", title: "second", time: Date.now(), messages: [msg("two")]}});
  await wait();
  stray.s.deleteChat({id: "z", title: "not in the list", time: Date.now(), messages: [msg("x")]});
  await wait();
  assert.strictEqual(stray.s.chats.length, 2, "nothing was removed");
  assert.ok("a" in stray.records && "b" in stray.records, "both records are still there");
  done.push("delete: a chat the list does not hold removes nothing");

  // 20. nmrugg's report on #1787: a mouse click inside the rename field. The field lives inside the row, so the
  // click reaches the list's handler; opening the chat there re-renders the list, and the field is taken away
  // mid-click - the rename ends before the caret is placed.
  const click = run({}, {"strata.history": "true"}, {
    a: {id: "a", title: "the one", time: Date.now(), messages: [msg("hi")]}});
  await wait();
  const clickRow = click.s.el("sidebar-list").children.find((c) => c.className.split(" ").includes("chat-item"));
  click.s.renameChat(clickRow, click.s.chats[0]);
  const clickField = clickRow.children.find((c) => c.className.split(" ").includes("chat-item__input"));
  assert.ok(clickField, "the row turned into a field");
  clickField.value = "half-typed name";
  click.s.el("sidebar-list")._l["click"]({target: clickField});      // a click on the field's own text
  await wait();
  assert.ok(click.s.el("sidebar-list").children.includes(clickRow), "the list was not rebuilt: the field is still there");
  assert.strictEqual(click.records["a"].title, "the one", "the click does not commit a half-typed name");
  clickField._l["keydown"]({key: "Enter", preventDefault() {}});
  await wait();
  assert.strictEqual(click.records["a"].title, "half-typed name", "and the rename still finishes after the click");
  done.push("rename: a click inside the field leaves the rename open");

  // 21. closing the browser while a request is running asks first.  Driven through send() with a stream that
  // stops after one chunk, so it is the real path: a request puts the listener on, finishing takes it off, and
  // an idle page has none at all (a permanent one is what makes a browser refuse to keep the page in its
  // back/forward cache).
  let release;
  const leave = run({fetch: async () => ({ok: true, json: async () => ({}), body: {getReader: () => ({
    n: 0,
    read() {
      if (!this.n++) return Promise.resolve({done: false, value: new TextEncoder()
        .encode("data: " + JSON.stringify({choices: [{delta: {content: "hi"}}]}) + "\n\n")});
      return new Promise((res) => { release = () => res({done: true}); });
    }})}})}, {});
  await wait();
  const holds = () => (leave.win._l.beforeunload || []);
  const closeTheTab = () => { const e = {preventDefault() { e.canceled = true; }};
                              holds().forEach((f) => f(e)); return e; };
  assert.strictEqual(holds().length, 0, "an idle page does not hold the tab shut");
  assert.ok(!closeTheTab().canceled, "so closing it is not questioned");
  leave.s.el("input").value = "a question";
  const settled = leave.s.send();
  await wait();
  assert.ok(release, "the fake stream is waiting on its second read");
  assert.ok(leave.s.busy, "the request is in flight");
  assert.strictEqual(holds().length, 1, "while it runs the page holds the tab");
  assert.ok(closeTheTab().canceled, "closing now asks first");
  release();
  await settled;
  assert.strictEqual(leave.s.busy, null, "the request finished");
  assert.strictEqual(leave.s.messages[1].text, "hi", "and the answer is on the screen");
  assert.strictEqual(holds().length, 0, "when it ends the hold is gone");
  leave.s.setBusy(false);
  assert.strictEqual(holds().length, 0, "ending twice does not throw and does not double-remove");
  done.push("leave warning: on while a request runs, off when it ends, none on an idle page");

  // 22. "Show thinking" (todo #keep-thinking-open, now one three-way control with the calls): "folded" | "live" | "always".
  // The setting drives the details' open attribute - for a finished answer, for one still streaming, and for a
  // chat re-rendered later (renderChat builds each message with msgEl) - and a block the user opened or closed
  // themselves is still left alone.
  const th = run({}, {});
  await wait();
  const thinkMsg = (m) => th.s.msgEl(m, 0);      // msgEl renders an assistant message exactly as renderChat does
  const detOf = (el, n = 0) => el.querySelector(".st-bubble")._blocks[n].el;   // thinking is a part of the bubble now
  assert.strictEqual(th.s.settings.show, "live", "the default is the middle one, fold when done");
  let done1 = thinkMsg({role: "assistant", text: "the answer", reasoning: "why it answered", time: Date.now()});
  assert.notStrictEqual(detOf(done1).open, true, "live: the thinking of a finished answer stays closed");
  th.s.setSettings({show: "always"});
  done1 = thinkMsg({role: "assistant", text: "the answer", reasoning: "why it answered", time: Date.now()});
  assert.strictEqual(detOf(done1).open, true, "always: it is open, answer already written");
  assert.ok((detOf(done1).querySelector(".thinking")._html || "").includes("why it answered"), "and its text is filled in (as markdown)");
  const live = {role: "assistant", text: "", reasoning: "still going", time: Date.now()};
  const liveEl = th.s.msgEl(live, 0);
  th.s.updateAssistant(liveEl, live, true);
  assert.strictEqual(detOf(liveEl).open, true, "always: open while it streams too");
  detOf(liveEl).dataset.touched = "1";                     // the user clicked the block itself
  detOf(liveEl).open = false;
  th.s.updateAssistant(liveEl, live, true);
  assert.strictEqual(detOf(liveEl).open, false, "the page does not fight a click the user made");
  // "live" opens the run that is streaming and folds it when the answer starts - the old default, named
  const showLive = run({}, {});
  await wait();
  const showMsg = {role: "assistant", text: "", reasoning: "still going", time: Date.now()};
  const showEl = showLive.s.msgEl(showMsg, 0);
  showLive.s.updateAssistant(showEl, showMsg, true);
  assert.strictEqual(detOf(showEl).open, true, "live: open while it streams");
  showLive.s.updateAssistant(showEl, {...showMsg, text: "the answer"}, false);
  assert.strictEqual(detOf(showEl).open, false, "and closed when the answer starts");
  // "folded" opens nothing, even mid-stream
  const showFold = run({}, {});
  await wait();
  showFold.s.setSettings({show: "folded"});
  const foldEl = showFold.s.msgEl({...showMsg, text: ""}, 0);
  showFold.s.updateAssistant(foldEl, {...showMsg, text: ""}, true);
  assert.strictEqual(detOf(foldEl).open, false, "folded: closed while it streams");
  assert.strictEqual(detOf(foldEl).querySelector(".think-preview").textContent, "still going",
                     "but its one-line preview is still there, so the reader knows what is behind the click");
  done.push("thinking: Show thinking folded/live/always drives the open attribute; live is the default; a user click wins");

  // 23. the same control for the calls (todo #keep-tool-calls-open, folded into Show thinking): a tool block nobody has clicked
  // follows it; once one is clicked, that choice wins for the rest of the turn.  The body (arguments, the
  // result as the model read it) is only built while the block is open, so "not open" is checked by its
  // absence, not by the preview line.
  const toolHtmlOf = (m) => too.s.toolHtml(m.tools[0], 0);
  const isOpen = (m) => toolHtmlOf(m).includes('data-tool="0" data-state="done" open');
  const bodyShown = (m) => toolHtmlOf(m).includes("<pre class=\"tool-call__pre tool-call__pre-result\">the result</pre>");
  const toolMsg = () => ({role: "assistant", text: "beforeafter", time: Date.now(),
                          tools: [{id: "t1", name: "x", state: "done", at: 6, result: "the result", round: 0}]});
  const too = run({}, {});
  await wait();
  assert.strictEqual(too.s.settings.show, "live", "the default is the middle one");
  let tm = toolMsg();
  assert.ok(!isOpen(tm), "live: a call that is already done is closed");
  assert.ok(!bodyShown(tm), "and its body is not built");
  too.s.setSettings({show: "always"});
  tm = toolMsg();
  assert.ok(isOpen(tm), "always: nobody has clicked it, so it is open");
  assert.ok(bodyShown(tm), "and the result the model read is shown");
  too.s.setSettings({show: "folded"});
  tm = toolMsg();
  assert.ok(!isOpen(tm), "folded: closed even though it is finished and readable");
  tm.tools[0].open = !too.s.toolOpen(tm.tools[0]);          // what a click records now (see 24)
  assert.ok(isOpen(tm), "a click opens it, control aside");
  tm.tools[0].open = !too.s.toolOpen(tm.tools[0]);
  assert.ok(!isOpen(tm), "and the next click closes it again");
  const tooLive = run({}, {});
  await wait();
  const tmLive = toolMsg();
  tmLive.tools[0].open = !tooLive.s.toolOpen(tmLive.tools[0]);
  assert.ok(isOpen(tmLive), "live: a click still opens a settled call");
  done.push("tool calls: Show thinking folded/live/always decides an untouched block; after a click the click decides");

  // 24. opening and closing a tool block while the engine writes (todo #tool-click-open).  The answer's bubble is rewritten
  // every frame, so a click handler that prevented the browser's own opening and asked for a rebuild lost the
  // click whenever the node was replaced between mousedown and mouseup.  Now the browser opens the block and the
  // page only remembers the state and fills in the body the block was built without.
  const tg = run({}, {});
  await wait();
  const tmsg = {role: "assistant", text: "beforeafter", time: Date.now(),
                tools: [{id: "t1", name: "x", state: "done", at: 6, result: "the result", round: 0}]};
  tg.s.messages.push(tmsg);
  const tmsgEl = tg.s.msgEl(tmsg, 0);
  // the stub does not parse innerHTML, so the test builds the block the page would have made for it
  const block = makeEl();
  block.tagName = "DETAILS"; block.className = "st-collapse tool-call"; block.dataset.tool = "0"; block.open = false;
  tmsgEl.appendChild(block);
  assert.ok(!tg.s.toolHtml(tmsg.tools[0], 0).includes("tool-call__pre-result"), "built closed, body empty");
  block.open = true;                                    // the browser did this, from the click, before any handler ran
  tg.s.el("chat")._l["toggle"]({target: block});
  assert.strictEqual(tmsg.tools[0].open, true, "the page remembered the choice on the tool");
  assert.ok(block.querySelector(".st-collapse__body")._html.includes("the result"), "and filled in the body");
  assert.ok(tg.s.toolHtml(tmsg.tools[0], 0).includes("<pre class=\"tool-call__pre tool-call__pre-result\">the result</pre>"),
            "a later paint would render it open, with its body");
  block.open = false;
  tg.s.el("chat")._l["toggle"]({target: block});
  assert.strictEqual(tmsg.tools[0].open, false, "closing it is remembered too");
  assert.ok(!tg.s.toolHtml(tmsg.tools[0], 0).includes("tool-call__pre-result"), "and a later paint keeps it closed");
  // the click listener itself must no longer touch tool blocks: it would prevent the opening again
  tg.s.el("chat")._l["click"]({target: block});
  assert.strictEqual(tmsg.tools[0].open, false, "a click through it changes nothing");
  // a thinking block still works the same way through the same listener
  const thblock = makeEl();
  thblock.tagName = "DETAILS"; thblock.className = "st-collapse think"; thblock.open = true;
  tmsgEl.appendChild(thblock);
  tg.s.el("chat")._l["toggle"]({target: thblock});
  assert.strictEqual(thblock.dataset.touched, "1", "the thinking block is marked as the user's own");
  done.push("tool calls: the browser opens them, the page remembers - a click is not lost to a rebuild");

  // 25. the answer is updated in place (todo #update-in-place).  What is asserted is element identity and the count of whole-
  // subtree assignments, because that is what the flicker is: each tool block carries two <use> references into
  // web/sprite.svg, and re-making them 60 times a second is what shows on screen.
  const rp = run({}, {});
  await wait();
  const rm = {role: "assistant", text: "para one\n\npara two", reasoning: "", time: Date.now(), tools: []};
  const rel = rp.s.msgEl(rm, 0);
  const bubble = rel.querySelector(".st-bubble");
  assert.strictEqual(bubble._sets, undefined, "the bubble was never innerHTML-assigned, only filled with parts");
  const first = bubble.children[0], last0 = bubble.children[1];
  assert.strictEqual(bubble.children.length, 2, "the first paint made one element per block");
  // growing the answer: one element replaced per frame, never the whole bubble
  const ins0 = bubble._ins || 0;
  for (let i = 0; i < 10; i++) { rm.text += " more"; rp.s.updateAssistant(rel, rm, true); }
  assert.strictEqual(bubble._sets, undefined, "growing the answer never re-assigns the bubble's innerHTML");
  assert.strictEqual(bubble._ins, ins0 + 10, "and it inserts exactly one element per frame: the block that grew");
  assert.strictEqual(bubble.children[0], first, "the settled block is the same element, not a copy of it");
  assert.notStrictEqual(bubble.children[1], last0, "the growing block was replaced");
  // thinking frames with the answer unchanged: nothing in the bubble is touched.  The thinking block has to
  // exist first - with todo #think-per-round a new run is itself a part, so the frame that creates one does add an element
  rm.reasoning = "primed";
  rp.s.updateAssistant(rel, rm, true);
  const before = bubble.children.slice(), insA = bubble._ins;
  for (let i = 0; i < 10; i++) { rm.reasoning += " hmm"; rp.s.updateAssistant(rel, rm, true); }
  assert.deepStrictEqual(bubble.children, before, "a thinking frame touches no element of the answer");
  assert.strictEqual(bubble._ins, insA, "and inserts nothing");
  assert.strictEqual(bubble._sets, undefined, "and assigns no innerHTML");
  // a tool call arrives: it is a top-level part, and the settled text keeps its element - nothing moves
  const textEl = bubble.children.find((c) => (c._html || "").includes("<p>"));   // the settled paragraph, as it is now
  rm.tools.push({id: "c1", name: "easyCMP__fs_read", server: "easyCMP", tool: "fs_read", state: "writing",
                 at: rm.text.length, rat: 0});
  rp.s.updateAssistant(rel, rm, true);
  const det = bubble.children.find((c) => (c.className || "").includes("tool-call"));
  assert.ok(det, "the call is a part of the bubble, at the same level as the text");
  assert.ok(bubble.children.includes(textEl), "and the settled text kept its element: nothing moved");
  const nameSpan = det.querySelector(".tool-call__name");
  const insB = bubble._ins;
  const n0 = bubble.children.length;
  for (let i = 0; i < 10; i++) { rm.reasoning += " hmm"; rp.s.updateAssistant(rel, rm, true); }
  assert.strictEqual(bubble.children.length, n0, "thinking frames add nothing to the bubble");
  assert.strictEqual(bubble._ins, insB, "and insert nothing anywhere");
  assert.strictEqual(bubble.children.find((c) => (c.className || "").includes("tool-call")), det,
                     "the tool block is still the same element");
  assert.strictEqual(det.querySelector(".tool-call__name"), nameSpan, "and so is the span inside its summary");
  Object.assign(rm.tools[0], {state: "running", arguments: {path: "a.txt"}, round: 1, open: true});
  rp.s.updateAssistant(rel, rm, true);
  assert.strictEqual(det.querySelector(".st-badge").textContent, "Running", "the badge follows the state");
  assert.strictEqual(det.querySelector(".tool-call__name"), nameSpan, "with the elements untouched");
  const box = det.querySelector(".st-collapse__body");
  // the block was open from the frame it was made (the default is "live" and this call is being written), so
  // its body was built then and the arguments arrive by text afterwards - which is the point of the parts
  // machinery.  box._html is the first build; the live text is what the reader actually sees.
  const preArgs = box.querySelector(".tool-call__pre-args");
  assert.strictEqual(preArgs.textContent, JSON.stringify({path: "a.txt"}, null, 2),
                     "the open block shows the arguments, written as text into the element it was built with");
  assert.ok(!(box._html || "").includes("tool-call__pre-result"), "and there was no result to show yet");
  Object.assign(rm.tools[0], {state: "done", result: "the file", chars: 8, ok: true, ms: 412});
  rp.s.updateAssistant(rel, rm, true);
  assert.strictEqual(box.querySelector(".tool-call__pre-result").textContent, "the file",
                     "the result the model read is written as text, not re-parsed");
  const boxSets = box._sets, boxIns = box._ins || 0;
  rp.s.updateAssistant(rel, rm, true);
  assert.strictEqual(box._sets, boxSets, "the body was built once, not re-parsed on every paint");
  assert.strictEqual(box._ins || 0, boxIns, "and nothing new was inserted into it");
  assert.strictEqual(bubble._sets, undefined, "still no whole-bubble assignment in the whole stream");
  done.push("flash: the answer is updated in place - settled blocks and tool icons keep their identity");

  // 26. my own messages as markdown (todo #md-per-author and #6).  Off is the page from before: the exact characters typed,
  // nothing parsed.  On uses the answers' renderer, which escapes first - so what matters here is that nothing
  // typed can turn into markup, and that the prompt still carries the raw text either way.
  const u = run({}, {});
  await wait();
  assert.strictEqual(u.s.settings.mdmine, false, "off is the default");
  const md = "**bold** and `code`\n\n- one\n- two\n\n```\nplain <code>\n```";
  const raw = "a <img src=x onerror=alert(1)> tag and [a link](javascript:alert(1))";
  const bubbleOf = (el) => el.children.find((c) => c.className === "st-bubble");
  let ub = bubbleOf(u.s.msgEl({role: "user", text: md, time: Date.now()}, 0));
  assert.strictEqual(ub.textContent, md, "off: the bubble holds exactly what was typed");
  assert.ok(!("_html" in b), "off: nothing was parsed as html");
  u.s.setSettings({mdmine: true});
  ub = bubbleOf(u.s.msgEl({role: "user", text: md, time: Date.now()}, 0));
  assert.ok(ub._html.includes("<strong>bold</strong>"), "on: bold became markup");
  assert.ok(ub._html.includes('<code class="inline">code</code>'), "on: inline code");
  assert.ok(ub._html.includes("<ul><li>one</li><li>two</li></ul>"), "on: a list");
  assert.ok(ub._html.includes("<pre><code>plain &lt;code&gt;</code></pre>"), "on: a fence, its own < escaped");
  ub = bubbleOf(u.s.msgEl({role: "user", text: raw, time: Date.now()}, 0));
  assert.ok(ub._html.includes("&lt;img src=x onerror=alert(1)&gt;"), "a tag you typed stays text");
  assert.ok(!ub._html.includes("<img"), "and no img element appears");
  assert.ok(!ub._html.includes("<a href=\"javascript:"), "and a javascript: target never becomes a link");
  u.s.messages.length = 0;
  u.s.messages.push({role: "user", text: raw, time: Date.now()});
  assert.strictEqual(u.s.apiMessages()[0].content, raw, "the prompt still carries exactly what was typed");
  done.push("my messages: markdown renders them when the switch is on, and nothing typed becomes markup");

  // 27. the defaults per author, and the "md" button in a message's own meta row (todo #md-per-author and #6 as the human
  // asked for them): the drawer sets the default for each side, the button overrides that one message, and the
  // choice is kept on the message so it survives a reload.
  const dd = run({}, {});
  await wait();
  assert.strictEqual(dd.s.settings.mdmine, false, "mine: off by default");
  assert.strictEqual(dd.s.settings.mdtheirs, true, "the model's: on by default, as the page always drew them");
  const mdText = "**bold** line\nplain second line";
  const um = {role: "user", text: "**bold**", time: Date.now()};
  const am = {role: "assistant", text: mdText, reasoning: "", time: Date.now()};
  dd.s.messages.length = 0;
  dd.s.messages.push(um, am);
  const uel = dd.s.msgEl(um, 0), ael = dd.s.msgEl(am, 1);
  const ab = ael.querySelector(".st-bubble");
  assert.ok((ab.children[0]._html || "").includes("<strong>bold</strong>"), "the answer is markdown by default");
  // my message, through its own button
  const ubtn = makeEl();
  ubtn.attrs["data-md-toggle"] = ""; ubtn.attrs["aria-checked"] = "false";
  uel.appendChild(ubtn);
  dd.s.el("chat")._l["click"]({target: ubtn});
  assert.strictEqual(um.md, true, "the message now has a choice of its own");
  assert.strictEqual(ubtn.attrs["aria-checked"], "true", "and the switch shows that choice");
  assert.ok(uel.querySelector(".st-bubble")._html.includes("<strong>bold</strong>"), "my message became markdown");
  // the answer, through its own button: plain text, one element, the model's line break kept
  const abtn = makeEl();
  abtn.attrs["data-md-toggle"] = ""; abtn.attrs["aria-checked"] = "true";
  ael.appendChild(abtn);
  dd.s.el("chat")._l["click"]({target: abtn});
  assert.strictEqual(am.md, false, "the answer's own choice is off");
  assert.strictEqual(ab.children.length, 1, "one element for the whole text part");
  assert.ok(ab.children[0]._html.includes("md-plain"), "the plain element");
  assert.strictEqual(ab.children[0].textContent, mdText, "the characters it wrote, newline and all");
  assert.strictEqual(ab.children[0].children.length, 0, "and nothing inside it");
  // the default off for the model's messages, with no per-message choice
  const pp = run({}, {});
  await wait();
  pp.s.setSettings({mdtheirs: false});
  const pm = {role: "assistant", text: mdText, reasoning: "", time: Date.now()};
  const pb = pp.s.msgEl(pm, 0).querySelector(".st-bubble");
  assert.strictEqual(pb.children.length, 1, "off: one element for the whole answer");
  assert.strictEqual(pb.children[0].textContent, mdText, "raw, exactly as it wrote it");
  // and a plain answer still updates in place while it streams: one element, textContent only
  const pm2 = {role: "assistant", text: "one line", reasoning: "", time: Date.now()};
  const pel2 = pp.s.msgEl(pm2, 0);
  const pb2 = pel2.querySelector(".st-bubble");
  const pel0 = pb2.children[0], pins0 = pb2._ins || 0, psets0 = pb2._sets;
  for (let i = 0; i < 8; i++) { pm2.text += " more"; pp.s.updateAssistant(pel2, pm2, true); }
  assert.strictEqual(pb2.children[0], pel0, "the plain element is the same one through 8 updates");
  assert.strictEqual(pb2._ins || 0, pins0, "no element inserted");
  assert.strictEqual(pb2._sets, psets0, "no innerHTML assigned");
  assert.strictEqual(pel0.textContent, pm2.text, "its text is the whole answer so far");
  done.push("md: defaults per author, and a per-message switch that keeps its choice with the chat");

  // 28. nothing that only pretends to be output (todo #no-placeholder): no "Writing", no caret, and no answer bubble at
  // all until the model has produced something real.  The thinking block is what shows while it thinks.
  const cz = run({}, {});
  await wait();
  const cmsg = {role: "assistant", text: "", reasoning: "thinking first", time: Date.now()};
  const cels = cz.s.msgEl(cmsg, 0);
  cz.s.updateAssistant(cels, cmsg, true);          // the streaming paint, the way send()'s frame loop does it
  const cbul = cels.querySelector(".st-bubble");
  assert.ok(cbul.className.includes("thinking-only"), "thinking-only: the element exists (the thinking lives in it now)");
  assert.strictEqual(cbul.hidden, false, "...but it is not hidden, it has no chrome instead (app.css)");
  assert.strictEqual(cels.querySelector(".st-msg__meta").hidden, false, "the meta row stays visible while thinking, to show live stats (todo #edit-posts)");
  assert.strictEqual(cbul._sets, undefined, "nothing was ever written into the bubble: no placeholder");
  assert.ok(!cbul.className.includes("cursor"), "and no caret class on it");
  assert.strictEqual(detOf(cels).hidden, false, "the thinking block is what is visible");
  cmsg.text = "the answer begins";
  cz.s.updateAssistant(cels, cmsg, true);
  assert.strictEqual(cbul.hidden, false, "the bubble is a real box once there is text");
  assert.ok(!cbul.className.includes("thinking-only"), "and its chrome is back");
  assert.strictEqual(cels.querySelector(".st-msg__meta").hidden, false, "and the meta row with it");
  assert.ok(cbul.children.some((c) => (c._html || "").includes("the answer begins")), "drawn once, as a part");
  assert.strictEqual(cbul._sets, undefined, "and still no whole-bubble assignment anywhere in the turn");
  // a tool call is real output too: the bubble shows for it, before any text arrives
  const tcall = {role: "assistant", text: "", reasoning: "", time: Date.now(),
                 tools: [{id: "c1", name: "x", state: "writing", at: 0, rat: 0}]};
  assert.strictEqual(cz.s.msgEl(tcall, 0).querySelector(".st-bubble").hidden, false, "a call being written is output");
  // a finished turn that delivered nothing keeps its meta row, so it is still visible as a turn
  const eom = {role: "assistant", text: "", reasoning: "", time: Date.now(), stopped: true};
  const eoel = cz.s.msgEl(eom, 0);
  assert.strictEqual(eoel.querySelector(".st-bubble").hidden, true, "no empty box for it");
  assert.strictEqual(eoel.querySelector(".st-msg__meta").hidden, false, "but the row stays");
  assert.strictEqual(eoel.querySelector(".meta-text").textContent, "Stopped", "and says what happened");
  // an error is output: the bubble shows it
  const em = {role: "assistant", text: "", error: "the request failed", time: Date.now()};
  const ebul = cz.s.msgEl(em, 0).querySelector(".st-bubble");
  assert.strictEqual(ebul.hidden, false, "an error is shown");
  assert.strictEqual(ebul.querySelector(".msg-error").textContent, "the request failed", "as its own element");
  done.push("no fake output: no Writing, no caret, no bubble until text, a tool call or an error");

  // 29. the settings drawer warns before it throws away changes (todo #drawer-discard-warn).  Only Apply writes, so closing on
  // the X, the scrim or Escape used to discard whatever the switches had been moved to, silently.
  const dr = run({}, {});
  await wait();
  dr.s.openDrawer(true);
  await wait();                                   // let the panel finish reading the server's share state
  assert.strictEqual(dr.s.drawerDirty(), false, "opening the panel changes nothing");
  dr.s.el("drawer-close").onclick();              // the X, not the function: what the page actually wires up
  assert.strictEqual(dr.confirms.length, 0, "closing with nothing changed asks nothing");
  assert.strictEqual(dr.s.el("drawer").dataset.open, "false", "and it closes");
  dr.s.openDrawer(true);
  await wait();
  dr.s.el("s-temp").value = 0.9;
  assert.strictEqual(dr.s.drawerDirty(), true, "a moved slider is an unapplied change");
  dr.confirmAnswer.yes = false;
  dr.s.el("scrim").onclick();                     // and the scrim, the third way out is the Escape key
  assert.strictEqual(dr.confirms.length, 1, "closing asks first");
  assert.strictEqual(dr.s.el("drawer").dataset.open, "true", "a refused discard leaves the panel open");
  assert.strictEqual(dr.s.settings.temperature, 0.6, "and the setting in force is untouched");
  dr.confirmAnswer.yes = true;
  dr.s.el("scrim").onclick();
  assert.strictEqual(dr.confirms.length, 2, "it asked again");
  assert.strictEqual(dr.s.el("drawer").dataset.open, "false", "agreeing closes it");
  assert.strictEqual(dr.s.settings.temperature, 0.6, "discarded, exactly as the warning said");
  dr.s.openDrawer(true);
  await wait();
  dr.s.el("s-temp").value = 0.9;
  await dr.s.el("s-apply").onclick();
  assert.strictEqual(dr.confirms.length, 2, "Apply asks nothing");
  assert.strictEqual(dr.s.el("drawer").dataset.open, "false", "and Apply closes");
  assert.strictEqual(dr.s.settings.temperature, 0.9, "and Apply is what writes the setting");
  const d2 = run({}, {});
  await wait();
  d2.s.openDrawer(true);
  await wait();
  d2.s.el("s-mdmine").setAttribute("aria-checked", "true");
  assert.strictEqual(d2.s.drawerDirty(), true, "a switch moved counts as unapplied too");
  const d3 = run({}, {});
  await wait();
  d3.s.openDrawer(true);
  await wait();
  d3.confirmAnswer.yes = false;                   // the tool-round-thinking switch asks its own question first
  d3.s.el("s-mcpthink").onclick();
  assert.strictEqual(d3.s.el("s-mcpthink").getAttribute("aria-checked"), "false", "a refused flip left it off");
  assert.strictEqual(d3.s.drawerDirty(), false, "so it is not an unapplied change");
  assert.strictEqual(d3.confirms.length, 1, "one question only: the switch's own, not a discard prompt");
  const d4 = run({}, {});
  await wait();
  d4.s.openDrawer(true);
  await wait();
  d4.s.el("s-share").setAttribute("aria-checked", "true");
  assert.strictEqual(d4.s.drawerDirty(), true, "the share switch counts: until Apply it is worth nothing");
  done.push("drawer: closing with unapplied changes asks; Apply asks nothing; a refused flip is not a change");

  // 30. the thinking block follows its own text only if you were already at the bottom of it.  The stub does not
  // grow scrollHeight when text is set, so what is checked is the decision (follow or leave alone) and where it
  // scrolls to, measured from the geometry before the update - which is exactly the order the page uses.
  const sc = run({}, {});
  await wait();
  const smsg = {role: "assistant", text: "", reasoning: "one", time: Date.now()};
  const sels = sc.s.msgEl(smsg, 0);
  const sbody = detOf(sels).querySelector(".thinking");
  sbody.clientHeight = 420;
  sbody.scrollHeight = 420; sbody.scrollTop = 0;
  smsg.reasoning = "line of thinking\n".repeat(40);
  sc.s.updateAssistant(sels, smsg, true);
  assert.strictEqual(sbody.scrollTop, 420, "at the bottom: it follows the new thinking");
  sbody.scrollHeight = 1200; sbody.scrollTop = 100;      // the reader scrolled up to re-read
  smsg.reasoning += "more thinking\n".repeat(40);
  sc.s.updateAssistant(sels, smsg, true);
  assert.strictEqual(sbody.scrollTop, 100, "scrolled up: not yanked to the bottom");
  sbody.scrollTop = 1200 - 420 - 30;                    // 30px off the bottom: still "at" it
  sc.s.updateAssistant(sels, smsg, true);
  assert.strictEqual(sbody.scrollTop, 1200, "just off the bottom: it still follows");
  // and a finished message is never dragged: a history block opened with "Show thinking: Always" shows where you
  // left it, not the end of the reasoning
  const o = run({}, {});
  await wait();
  o.s.setSettings({show: "always"});
  const om = {role: "assistant", text: "the answer", reasoning: "what it thought", time: Date.now()};
  const oel = o.s.msgEl(om, 0);
  const ob = detOf(oel).querySelector(".thinking");
  ob.clientHeight = 20; ob.scrollHeight = 900; ob.scrollTop = 500;
  o.s.updateAssistant(oel, om, false);
  assert.ok((ob._html || "").includes("what it thought"), "a finished block is filled in (as markdown)");
  assert.strictEqual(ob.scrollTop, 500, "and is not dragged to the bottom");
  done.push("thinking: auto-scroll follows only when you were already at the bottom of it");

  // 31. the composer keeps its text per conversation and across a reload: type in one chat, switch away, come
  // back, and it is still there.  Sending spends it.
  const g = run({}, {"strata.history": "true", "strata.chatId": JSON.stringify("a")},
                {a: {id: "a", title: "chat a", time: Date.now(), messages: [msg("first")]},
                 b: {id: "b", title: "chat b", time: Date.now(), messages: [msg("second")]}});
  await wait();
  assert.strictEqual(g.s.chatId, "a", "chat a is open");
  g.s.el("input").value = "half a question about a";
  g.s.el("input")._l["input"]();                       // the page's own input handler saves as you type
  assert.strictEqual(JSON.parse(g.stored["strata.draft.a"]), "half a question about a", "kept under this chat");
  g.s.openChat("b");
  await wait();
  assert.strictEqual(g.s.el("input").value, "", "switching to b empties the box: b has no draft");
  g.s.el("input").value = "something for b";
  g.s.el("input")._l["input"]();
  g.s.openChat("a");
  await wait();
  assert.strictEqual(g.s.el("input").value, "half a question about a", "back to a and the text is there");
  const g2 = run({}, JSON.parse(JSON.stringify(g.stored)), JSON.parse(JSON.stringify(g.records)));
  await wait();
  assert.strictEqual(g2.s.el("input").value, "half a question about a", "and a reload finds it again");
  g2.s.el("input").value = "asking now";
  g2.s.el("input")._l["input"]();
  await g2.s.send();
  assert.strictEqual(JSON.parse(g2.stored["strata.draft.a"]), "", "sending spends the draft");
  assert.strictEqual(g2.s.el("input").value, "", "and the box is empty");
  // a blank chat is never written to the store and its id is invented per load, so its draft is the one "blank"
  const bl = run({}, {"strata.history": "true"}, {});
  await wait();
  bl.s.el("input").value = "a fresh question";
  bl.s.el("input")._l["input"]();
  assert.strictEqual(JSON.parse(bl.stored["strata.draft.blank"]), "a fresh question", "the blank chat's draft");
  const bl2 = run({}, JSON.parse(JSON.stringify(bl.stored)), {});
  await wait();
  assert.notStrictEqual(bl2.s.chatId, bl.s.chatId, "the blank chat has a different id on the new load");
  assert.strictEqual(bl2.s.el("input").value, "a fresh question", "and the draft is still found");
  // and New chat reuses the blank chat that is already there instead of adding a second
  const n = run({}, {"strata.history": "true", "strata.chatId": JSON.stringify("full")},
                {full: {id: "full", title: "full", time: Date.now(), messages: [msg("used")]},
                 blank: {id: "blank", title: "", time: Date.now(), messages: []}});
  await wait();
  assert.strictEqual(n.s.chatId, "full", "a used chat is open");
  n.s.startChat();
  await wait();
  assert.strictEqual(n.s.chatId, "blank", "New chat reused the blank chat already in the list");
  assert.strictEqual(n.s.chats.length, 2, "and did not add a third row to it");
  done.push("drafts: the box keeps its text per chat and across a reload, and New chat reuses a blank chat");

  // 32. a conversation that still holds unsent text is marked in the list.  The stub does not parse the row's
  // innerHTML, so what is checked is the markup the page generates for the row.
  const mk = run({}, {"strata.history": "true", "strata.chatId": JSON.stringify("a")},
                 {a: {id: "a", title: "chat a", time: Date.now(), messages: [msg("first")]},
                  b: {id: "b", title: "chat b", time: Date.now(), messages: [msg("second")]}});
  await wait();
  const rowHtml = (id) => mk.s.el("sidebar-list").children.find((r) => r.dataset.id === id)._html || "";
  assert.ok(!rowHtml("a").includes('class="chat-item__title draft"'), "nothing marked yet");
  mk.s.el("input").value = "typing in a";
  mk.s.el("input")._l["input"]();
  mk.s.openChat("b");
  await wait();
  assert.ok(rowHtml("a").includes('class="chat-item__title draft"'), "chat a is marked: it has unsent text");
  assert.ok(!rowHtml("b").includes('class="chat-item__title draft"'), "chat b is not");
  assert.ok(rowHtml("a").includes("(has draft)"), "and the tooltip says why");
  mk.s.openChat("a");
  await wait();
  assert.strictEqual(mk.s.el("input").value, "typing in a", "and opening it gives the text back");
  mk.s.el("input").value = "";
  mk.s.el("input")._l["input"]();
  mk.s.openChat("b");
  await wait();
  assert.ok(!rowHtml("a").includes('class="chat-item__title draft"'), "an emptied draft clears the marker");
  done.push("chat list: a conversation with unsent text is marked with an asterisk");

  // 33. the final layout, after two tries at nesting: everything top level, in the order it happened.
  const gr = run({}, {});
  await wait();
  const gm = {role: "assistant", text: "I'll read the file first.Now let me run it.here is the answer",
              reasoning: "first thought", time: Date.now(),
              tools: [{id: "c1", name: "easyCMP__fs_read", state: "done", at: 25, rat: 13, ms: 400,
                       result: "r1", round: 1}]};
  const gel = gr.s.msgEl(gm, 0);
  gr.s.el("chat").appendChild(gel);                            // the toggle listener sits on #chat
  gr.s.messages.length = 0; gr.s.messages.push(gm);            // the listener looks the message up by index
  const gb = gel.querySelector(".st-bubble");
  gr.s.updateAssistant(gel, gm, true);
  gm.reasoning += "\n\nsecond thought";
  gm.tools.push({id: "c2", name: "easyCMP__run_cmd", state: "done", at: 43, rat: 29, ms: 900,
                 result: "r2", round: 2});
  gr.s.updateAssistant(gel, gm, false);
  assert.deepStrictEqual(gb._parts.map((p) => p.kind),
                         ["think", "text", "tool", "think", "text", "tool", "text"],
                         "think, what it said, its call, think, what it said, its call, answer - nothing folded");
  assert.strictEqual(gb._parts.filter((p) => p.kind === "group").length, 0, "no containers any more");
  assert.strictEqual(gb._blocks.length, 2, "two thinking blocks, one per round");
  assert.strictEqual(gb.children.filter((c) => (c.className || "").includes("tool-call")).length, 2,
                     "both calls at the top level, readable without a click");
  // "Show thinking: live" (the default) keeps a finished turn's thinking closed, so neither body is built -
  // what each block shows is its one-line preview.  Opening one fills it, which is the next two assertions.
  assert.strictEqual(gb._blocks[0].el.open, false, "live: a finished turn's thinking is closed");
  assert.strictEqual(gb._blocks[0].el.querySelector(".think-preview").textContent, "first thought",
                     "the run that streamed is still readable on the collapsed line");
  assert.strictEqual(gb._blocks[1].el.querySelector(".thinking").textContent, "", "the run that never streamed is empty");
  gb._blocks[0].el.open = true;                                // a real details fires the toggle event itself
  assert.ok((gb._blocks[0].el.querySelector(".thinking")._html || "").includes("first thought"),
                     "opening the first fills it with its own slice (as markdown)");
  gb._blocks[1].el.open = true;
  assert.ok((gb._blocks[1].el.querySelector(".thinking")._html || "").includes("second thought"),
                     "and it fills with only that run's slice, not the whole reasoning");
  // a run's seconds are stamped only when the NEXT run starts, so the title has to catch up on a later paint
  gm.tools[0].tsec = 4.2;
  gr.s.updateAssistant(gel, gm, false);
  assert.strictEqual(gb._blocks[0].el.querySelector(".think-title").textContent, "Thought for 4.2 s",
                     "the title catches up when the seconds arrive, instead of staying 'Thoughts'");
  assert.strictEqual(gb._blocks[1].el.querySelector(".think-title").textContent, "Thoughts",
                     "a run with no measured end yet says just that");
  // the tripwire: the layout is display only.  What goes back to the server must be byte for byte what it was,
  // or the engine's prompt prefix breaks at the first tool round and the chat re-reads everything after it
  // (serve/server.py:4470-4481, #2100)
  assert.strictEqual(JSON.stringify(gr.s.assistantMessages(gm, true)), JSON.stringify([
    {role: "assistant", content: "I'll read the file first.", tool_calls: [{id: "c1", type: "function",
        function: {name: "easyCMP__fs_read", arguments: "{}"}}], reasoning_content: "first thought"},
    {role: "tool", tool_call_id: "c1", content: "r1"},
    {role: "assistant", content: "Now let me run it.", tool_calls: [{id: "c2", type: "function",
        function: {name: "easyCMP__run_cmd", arguments: "{}"}}], reasoning_content: "second thought"},
    {role: "tool", tool_call_id: "c2", content: "r2"},
    {role: "assistant", content: "here is the answer"}]), "the replay is unchanged by the layout");
  assert.strictEqual(gm.reasoning, "first thought\n\nsecond thought", "and nothing rewrote the reasoning string");
  done.push("layout: think, text, call, think, text, call, answer - all top level, nothing folded");

  // 34. a live thinking block grows with the reasoning.  The bug: the part kept the slice it was created with,
  // so a new thought bubble showed only its first chunk.
  const lv = run({}, {});
  await wait();
  const lm = {role: "assistant", text: "", reasoning: "one", time: Date.now()};
  const lel = lv.s.msgEl(lm, 0);
  lv.s.el("chat").appendChild(lel);
  const lbul = lel.querySelector(".st-bubble");
  lv.s.updateAssistant(lel, lm, true);
  for (const w of [" two", " three", " four"]) { lm.reasoning += w; lv.s.updateAssistant(lel, lm, true); }
  const ldet = lbul._blocks[0].el;
  assert.strictEqual(ldet.open, true, "the live block is open while it streams");
  assert.strictEqual(ldet.querySelector(".thinking").textContent, "one two three four", "and it keeps up");
  assert.strictEqual(ldet.querySelector(".think-preview").textContent, "one two three four", "and so does its preview");
  // the collapsed one-line summary, the way a tool block previews its result
  const fm = {role: "assistant", text: "the answer", reasoning: "line one\nline two\n" + "x".repeat(300),
              time: Date.now()};
  const fbul = lv.s.msgEl(fm, 0).querySelector(".st-bubble");
  const fprev = fbul._blocks[0].el.querySelector(".think-preview").textContent;
  assert.strictEqual(fprev, ("line one line two " + "x".repeat(300)).slice(0, 200),
                     "one line, whitespace collapsed, capped at 200 for the browser to ellipsize");
  assert.ok(!fprev.includes("\n"), "and never more than one line");
  done.push("thinking: a live block grows with the reasoning, and a collapsed one previews a single line");

  // 35. the saved Markdown follows the screen.  The old export wrote three piles - all thinking, then every
  // call, then the text - so a saved multi-round turn lost which thought led to which call.
  const ex = run({}, {});
  await wait();
  const xmm = {role: "assistant", text: "I'll read it.Now let me run it.done",
              reasoning: "first thought\n\nsecond thought", time: Date.now(),
              tools: [{id: "c1", name: "easyCMP__fs_read", server: "easyCMP", tool: "fs_read", state: "done",
                       at: 13, rat: 13, ms: 400, ok: true, result: "the file", round: 1},
                      {id: "c2", name: "easyCMP__run_cmd", server: "easyCMP", tool: "run_cmd", state: "done",
                       at: 31, rat: 29, ms: 900, ok: true, result: "the output", round: 2}]};
  const xmd = ex.s.turnMarkdown(xmm);
  const xat = (s) => xmd.indexOf(s);
  assert.ok(xat("Thoughts") >= 0 && xat("Thoughts") < xat("I'll read it."), "the first thought comes first");
  assert.ok(xat("I'll read it.") < xat("Tool easyCMP / fs_read"), "then what it said, then the call it made");
  assert.ok(xat("Tool easyCMP / fs_read") < xat("second thought"),
            "the second thought sits after that call, not in a pile at the top");
  assert.ok(xat("second thought") < xat("Now let me run it."), "and before the next round's text");
  assert.ok(xat("Now let me run it.") < xat("Tool easyCMP / run_cmd"), "then the second call");
  assert.ok(xat("Tool easyCMP / run_cmd") < xmd.lastIndexOf("done"), "and the answer last");
  assert.strictEqual((xmd.match(/<summary>Thoughts<\/summary>/g) || []).length, 2, "one block per thinking run");
  assert.ok(xmd.includes("<summary>Thoughts</summary>\n\nfirst thought\n\n</details>"), "each holds only its own run");
  assert.ok(xmd.includes("Tool easyCMP / fs_read · 0.4 s"), "a call shows how long it took, like the screen does");
  assert.ok(!xmd.includes("<summary>Thinking</summary>"), "no single merged thinking block any more");
  assert.ok(xmd.includes("```json\n{}\n```"), "the arguments are still there");
  // an unfinished call stays out of the record, as it always was, and an error is part of the turn
  const half = {role: "assistant", text: "did what it could", reasoning: "", time: Date.now(),
                tools: [{id: "c9", name: "x", state: "writing", at: 0, rat: 0}], error: "the request failed"};
  const hmd = ex.s.turnMarkdown(half, 2);
  assert.ok(!hmd.includes("Tool x"), "a call that never finished is not written up");
  assert.ok(hmd.includes("> the request failed"), "and the error is in the turn");
  done.push("export: the saved Markdown walks the same parts as the screen - think, text, call, think, text, call, answer");

  // 36. the copy button in three sizes, and a saved file named for the conversation rather than for the day
  const cp = run({}, {});
  await wait();
  const cm = {role: "assistant", text: "the answer", reasoning: "a thought", time: Date.now(),
              tools: [{id: "c1", name: "easyCMP__fs_read", server: "easyCMP", tool: "fs_read", state: "done",
                       at: 10, rat: 9, ms: 400, ok: true, result: "what it read", round: 1}]};
  // the clipboard takes the same shape the saved file has: thinking as a <details> block, then the text,
  // then (at the top level only) the call exactly as toolMarkdown writes it
  const think1 = "<details><summary>Thoughts</summary>\n\na thought\n\n</details>\n\nthe answer\n\n";
  const tool1 = "<details><summary>Tool easyCMP / fs_read \u00b7 0.4 s</summary>\n\n```json\n{}\n```\n\n```\nwhat it read\n```\n\n</details>\n\n";
  assert.strictEqual(cp.s.turnMarkdown(cm, 1), think1, "Shift: the thinking as a details block, then the text");
  assert.strictEqual(cp.s.turnMarkdown(cm, 2), think1 + tool1, "Ctrl+Shift: byte for byte what the export writes");
  assert.strictEqual(cp.s.turnMarkdown(cm), cp.s.turnMarkdown(cm, 2), "and the export's default level is everything");

  const cel = cp.s.msgEl(cm, 0);
  cp.s.el("chat").appendChild(cel);
  cp.s.messages.length = 0; cp.s.messages.push(cm);
  const cbtn = cel.querySelector("[data-msg-copy]");
  cbtn.attrs["data-msg-copy"] = "";
  cp.s.el("chat")._l["click"]({target: cbtn});
  cp.s.el("chat")._l["click"]({target: cbtn, shiftKey: true});
  cp.s.el("chat")._l["click"]({target: cbtn, shiftKey: true, ctrlKey: true});
  assert.deepStrictEqual(cp.copied, ["the answer", think1, think1 + tool1],
                         "the modifiers pick the size, and a plain click is unchanged");
  await wait();                                       // copyText awaits the clipboard, so the toasts are a tick later
  assert.strictEqual(cp.s.el("toasts").children.length, 3, "and each copy said something");
  assert.ok(cp.s.el("toasts").children.some((t) => (t.querySelector(".st-toast__title").textContent || "").includes("tool calls included")),
            "the biggest one says how much went onto the clipboard");
  // the file name: the conversation's own name first, and hostile characters gone
  assert.strictEqual(cp.s.safeFileName("You are working on Strata"), "You are working on Strata");
  assert.strictEqual(cp.s.safeFileName('what / next: a "quoted" name?'), "what next a quoted name");
  assert.strictEqual(cp.s.safeFileName("trailing dots and spaces...  "), "trailing dots and spaces");
  assert.strictEqual(cp.s.safeFileName("a\nnewline\tand    runs"), "a newline and runs");
  assert.strictEqual(cp.s.safeFileName("x".repeat(120)).length, 48, "capped so the path stays sane");
  assert.strictEqual(cp.s.safeFileName("You are working on Strata at /programs/Strata (branch fork)"),
                     "You are working on Strata at programs Strata", "cut at a word boundary, not mid-word");
  assert.strictEqual(cp.s.safeFileName("You are working on Strata at `/programs/Strata` (branch `fork`, remote Niko1221/Strata)."),
                     "You are working on Strata at programs Strata", "this chat's own title, backticks and slashes gone");
  assert.strictEqual(cp.s.safeFileName("///"), "strata-chat", "a name with nothing left falls back");
  assert.strictEqual(cp.s.safeFileName(""), "strata-chat", "and an empty one does too");
  done.push("copy: plain, Shift (+thinking), Ctrl+Shift (everything); export named for the conversation");

  // 37. switching conversations while one is answering (todo #switch-while-running).  The turn writes into its own message object
  // and paint() looks the row up each frame, so leaving and coming back neither loses the answer nor paints a
  // detached node - and the finished turn is saved into ITS chat, not whichever one happens to be open.
  const ctl = {step: null, flush: null}, sse = [];
  const readFrame = () => new Promise((res) => {
    ctl.step = () => {
      if (ctl.flush) ctl.flush();                  // paint first, as one animation frame would
      res(sse.length ? {done: false, value: new TextEncoder().encode(sse.shift())} : {done: true});
    };
  });
  const sw = run({fetch: async () => ({ok: true, body: {getReader: () => ({read: readFrame})}})},
    {"strata.history": "true", "strata.chatId": JSON.stringify("A")},
    {A: {id: "A", title: "chat A", time: Date.now(), messages: [msg("ask A")]},
     B: {id: "B", title: "chat B", time: Date.now(), messages: [msg("ask B")]}});
  await wait();
  ctl.flush = sw.flush;
  assert.strictEqual(sw.s.chatId, "A", "chat A is open");
  const frame = (o) => "data: " + JSON.stringify(o) + "\n\n";
  sse.push(frame({choices: [{delta: {reasoning_content: "thinking about it"}}]}), frame({choices: [{delta: {content: "first half"}}]}));
  sw.s.el("input").value = "go";
  const running = sw.s.send();                       // not awaited: the stream is still open
  await wait();
  ctl.step(); await wait();                          // the thinking frame
  ctl.step(); await wait();                          // the first content frame
  sw.s.openChat("B"); await wait();                  // switch away mid-answer
  const chatA = sw.s.chats.find((c) => c.id === "A");
  const turnOf = (c) => c.messages[c.messages.length - 1];        // ask A, my "go", then the assistant turn
  sse.push(frame({choices: [{delta: {content: " and the rest"}}]}));
  ctl.step(); await wait();
  assert.strictEqual(turnOf(chatA).text, "first half and the rest", "the turn kept writing into its own chat");
  assert.strictEqual(sw.s.chatId, "B", "and B is what is on screen");
  assert.strictEqual(sw.s.el("chat").children.filter((e) => e.className.includes("st-msg")).length, 1,
                     "B shows B's one message, not A's three");
  sw.s.openChat("A"); await wait();                  // back: renderChat rebuilt every row
  sse.push(frame({choices: [{delta: {content: " done"}}]}));
  ctl.step(); await wait(); ctl.step(); await wait();  // the last frame, then the end (which paints first)
  await running;
  const htmlOf = (e) => [e._html || "", ...(e.children || []).map(htmlOf)].join("|");
  assert.strictEqual(turnOf(chatA).text, "first half and the rest done", "the turn finished in chat A");
  assert.ok(htmlOf(sw.s.el("chat")).includes("first half and the rest done"),
            "paint found the rebuilt row and drew into it, not a detached node");
  assert.strictEqual(sw.records["A"].messages[2].text, "first half and the rest done",
                     "and it was saved into chat A's record");
  assert.strictEqual(sw.records["B"].messages.length, 1, "chat B's record was never written to");
  done.push("switching chats mid-answer: the turn keeps its conversation and paints the rebuilt row");

  // 39. the row says what is happening in it: a spinner while a turn answers there, and a dot when a reply
  // lands in a conversation you are not looking at.  One slot, one marker, priority run > new > draft.
  const ctl39 = {step: null, flush: null}, q39 = [];
  const read39 = () => new Promise((res) => {
    ctl39.step = () => {
      if (ctl39.flush) ctl39.flush();
      res(q39.length ? {done: false, value: new TextEncoder().encode(q39.shift())} : {done: true});
    };
  });
  const mk39 = run({fetch: async () => ({ok: true, body: {getReader: () => ({read: read39})}})},
    {"strata.history": "true", "strata.chatId": JSON.stringify("A")},
    {A: {id: "A", title: "chat A", time: Date.now(), messages: [msg("ask A")]},
     B: {id: "B", title: "chat B", time: Date.now(), messages: [msg("ask B")]}});
  await wait();
  ctl39.flush = mk39.flush;
  const stateOf = (id) => {
    const html = mk39.s.el("sidebar-list").children.find((r) => r.dataset.id === id)._html || "";
    const m = /class="chat-item__state ?([\w-]*)"/.exec(html);
    return m ? m[1] : "";
  };
  assert.strictEqual(stateOf("A"), "", "nothing running, nothing unread: no gutter marker");
  assert.ok(!mk39.s.el("sidebar-list").children.find((r) => r.dataset.id === "A")._html.includes("chat-item__state"),
            "and no span at all when there is nothing to show");
  const f39 = (o) => "data: " + JSON.stringify(o) + "\n\n";
  q39.push(f39({choices: [{delta: {content: "half"}}]}), f39({choices: [{delta: {content: " the rest"}}]}));
  mk39.s.el("input").value = "go";
  const run39 = mk39.s.send();
  await wait();
  assert.strictEqual(stateOf("A"), "", "no spinner on the conversation you are already looking at");
  assert.strictEqual(stateOf("B"), "", "and none on the other one either");
  mk39.s.openChat("B"); await wait();
  assert.strictEqual(stateOf("A"), "run", "leaving it makes the spinner appear in A's gutter");
  assert.strictEqual(stateOf("B"), "", "the conversation now on screen stays unmarked");
  ctl39.step(); await wait();                          // "half" lands while B is on screen
  ctl39.step(); await wait();                          // "the rest"
  ctl39.step(); await wait();                          // the stream ends here
  await run39;
  assert.strictEqual(stateOf("A"), "new", "A gets the unread dot, not the spinner");
  assert.strictEqual(stateOf("B"), "", "the conversation you were reading is not marked");
  assert.strictEqual(mk39.s.chats.find((c) => c.id === "A").unread, true, "and it is on the chat record");
  assert.strictEqual(mk39.records["A"].unread, true, "and saved with it, so a reload still knows");
  mk39.s.openChat("A"); await wait();
  assert.strictEqual(stateOf("A"), "", "opening it clears the mark");
  assert.strictEqual(mk39.s.chats.find((c) => c.id === "A").unread, false, "on the object too");
  done.push("chat list: a spinner for the conversation that is answering, a dot for one with a reply you have not read");

  // 40. a call being written shows the JSON arriving, instead of a static "(being written)" (todo #tool-args-stream).  The
  // server sends the pieces only because the page asked (strata_mcp_args); here they are fed in as events.
  const aw = run({}, {});
  await wait();
  // no setting needed: the default ("live") opens a call that is still being written, and the body is only
  // built while the block is open
  const wm = {role: "assistant", text: "", reasoning: "", time: Date.now(), tools: []};
  const wel = aw.s.msgEl(wm, 0);
  aw.s.onTool(wm, {event: "start", id: "c1", name: "easyCMP__fs_write"});
  aw.s.updateAssistant(wel, wm, true);
  const det40 = wel.querySelector(".st-bubble")._parts.find((p) => p.kind === "tool").el;
  const box40 = det40.querySelector(".st-collapse__body");   // the page reaches the pres through this, and the
  const pre40 = box40.querySelector(".tool-call__pre-args");  // stub only matches direct children
  assert.ok(box40._html.includes("(being written)"), "the body is built saying so, until JSON starts arriving");
  aw.s.onTool(wm, {event: "args", id: "c1", text: '{"path": "/tmp/x"'});
  aw.s.updateAssistant(wel, wm, true);
  assert.strictEqual(pre40.textContent, '{"path": "/tmp/x"', "the JSON as it arrives, unbalanced and all");
  assert.ok(det40.querySelector(".tool-call__preview").textContent.includes('/tmp/x'),
            "and the collapsed summary shows it too, so you can watch without opening the block");
  aw.s.onTool(wm, {event: "args", id: "c1", text: ', "text": "hi"}'});
  aw.s.updateAssistant(wel, wm, true);
  assert.strictEqual(pre40.textContent, '{"path": "/tmp/x", "text": "hi"}', "pieces accumulate");
  aw.s.onTool(wm, {event: "call", id: "c1", name: "easyCMP__fs_write", server: "easyCMP", tool: "fs_write",
                   arguments: {path: "/tmp/x", text: "hi"}, round: 1});
  aw.s.updateAssistant(wel, wm, true);
  assert.strictEqual(pre40.textContent, JSON.stringify({path: "/tmp/x", text: "hi"}, null, 2),
                     "the finished call replaces the raw pieces, pretty-printed");
  assert.strictEqual(wm.tools[0].argsText, undefined, "and the streamed text is dropped, not kept beside it");
  assert.strictEqual(wm.tools[0].state, "running", "the block moves on to running");
  done.push("tool calls: the JSON the model is typing streams into the block instead of \"(being written)\"");

  // 41. a running MCP tool is its own state (todo #waiting-state): measured 2026-10-23, /metrics answered live.state=idle
  // in 3 of 3 samples while a tool ran, because between engine rounds there is no live request record at all.
  const pl = run({}, {});
  await wait();
  const pillState = {state: "running-tool", tool: "easyCMP__run_cmd", queued: 0, elapsed_s: 3.2, busy: true};
  pl.s.render({live: pillState, hardware: {}, hardware_static: {}, engine: {}, history: {}, requests: [], totals: {}});
  assert.strictEqual(pl.s.el("pill-text").textContent, "Waiting · easyCMP__run_cmd", "the pill names the tool");
  // blue, not the generating green: the palette colours reading and generating differently because the engine
  // produces no tokens while a prompt is being read, and that is also true while a tool runs. The Monitor's
  // badge and state card already said blue; the pill was the outlier.
  assert.strictEqual(pl.s.el("pill").dataset.state, "reading", "so it colours like a prompt read, not idle");
  done.push("pill: a running MCP tool reads Waiting · <tool>, in the reading colour");

  // 42. the polling itself (todo #metrics-lite): the Chat tab asks for the lite answer, and the cadence follows what is
  // actually happening and whether the window is even being looked at.
  const po = run({}, {});
  await wait();
  assert.strictEqual(po.s.pollUrl(), "metrics?lite=1", "the Chat tab asks for the pill and nothing else");
  po.s.setTab("monitor");
  assert.strictEqual(po.s.pollUrl(), "metrics", "the Monitor needs the full answer");
  po.s.setTab("about");
  assert.strictEqual(po.s.pollUrl(), "metrics?lite=1&hw=1",
                     "About draws engine facts and the two hardware blocks, and nothing else");
  po.s.setTab("chat");
  const idle = {live: {state: "idle"}};
  assert.strictEqual(po.s.pollDelay(idle), 15000, "idle and visible: 15 s, not 1 s");
  assert.strictEqual(po.s.pollDelay({live: {state: "running-tool", tool: "x"}}), 1000,
                     "a tool running: back to 1 s, because the pill is the point");
  assert.strictEqual(po.s.pollDelay({live: {state: "generating", tok_s: 12}}), 1000, "generating: 1 s");
  assert.strictEqual(po.s.pollDelay(null), 15000, "no answer yet: the slow path");
  po.s.setHidden(true);
  assert.strictEqual(po.s.pollDelay({live: {state: "generating", tok_s: 12}}), 60000,
                     "a hidden window: nothing here is being seen, so a minute");
  po.s.setHidden(false);
  po.s.setTab("monitor");
  assert.strictEqual(po.s.pollDelay(idle), 1000, "the Monitor keeps its own cadence even when idle");
  po.s.setTab("about");
  assert.strictEqual(po.s.pollDelay(idle), 15000, "About backs off too: its facts change rarely");
  po.s.setTab("chat");
  // a lite+hw answer has no sparklines or request table, but it does carry About's cards - renderLite paints
  // those, which is the half that would otherwise go missing
  const abt = run({}, {});
  await wait();
  abt.s.renderLite({lite: true, live: {state: "idle"}, engine: {model: "qwen", max_context: 1048576, cvec: "project:4-44"},
                    hardware: {ram_total: 34359738368, ram_used: 10737418240}, hardware_static: {gpu_name: "RTX 3060"}});
  const factsOf = (id) => (abt.s.el(id)._html || "");
  assert.ok(factsOf("facts-hw").includes("RTX 3060"), "the hardware card is painted from a lite+hw answer");
  assert.ok(factsOf("facts-api").includes("/v1"), "and the API card too");
  assert.ok(factsOf("facts-engine").includes("1,048,576"), "the engine card gets engine.max_context");
  // the pill colour for a running tool: blue, like the Monitor's badge and state card, not the generating green
  const pc = run({}, {});
  await wait();
  pc.s.renderPill({live: {state: "running-tool", tool: "easyCMP__run_cmd"}});
  assert.strictEqual(pc.s.el("pill").dataset.state, "reading",
                     "a tool wait colours like a prompt read: the engine is producing no tokens");
  assert.strictEqual(pc.s.el("pill-text").textContent, "Waiting · easyCMP__run_cmd", "with the tool named");
  // a lite answer carries no cards, so the lite path paints the pill on its own
  const pl2 = run({}, {});
  await wait();
  pl2.s.renderPill({live: {state: "running-tool", tool: "easyCMP__run_cmd"}});
  assert.strictEqual(pl2.s.el("pill-text").textContent, "Waiting · easyCMP__run_cmd", "renderPill needs no cards");
  pl2.s.renderPill({live: {state: "idle"}});
  assert.strictEqual(pl2.s.el("pill-text").textContent, "Idle", "and it follows the state");
  done.push("polling: ?lite=1 off the Monitor, 15 s when idle, a minute when the window is hidden");

  // 44. hovering the Monitor tab prefetches its answer, guarded by a 1 s throttle so a mouse crossing the
  // tab bar cannot stack requests. It is a throttle, not a debounce: the first hover fires at once.
  const hv = run({}, {});
  await wait();
  hv.fetches.length = 0;
  hv.s.hoverTab("monitor");
  await wait();
  assert.deepStrictEqual(hv.fetches, ["metrics"], "the first hover fetches at once - no waiting to be useful");
  hv.s.hoverTab("monitor");
  hv.s.hoverTab("monitor");
  await wait();
  assert.strictEqual(hv.fetches.length, 1, "hovering again inside the throttle window costs nothing");
  hv.s.setLastHoverFetch(0);                       // pretend the last hover fetch is old
  hv.s.hoverTab("monitor");
  await wait();
  assert.strictEqual(hv.fetches.length, 2, "once the window passes, a hover fetches once more");
  const hv3 = run({}, {});
  await wait();
  hv3.s.setTab("monitor");
  hv3.fetches.length = 0;
  hv3.s.hoverTab("monitor");
  await wait();
  assert.deepStrictEqual(hv3.fetches, [], "already on the Monitor: its own 1 s poll covers it");
  const hv2 = run({}, {});
  await wait();
  hv2.s.setTab("chat");
  hv2.fetches.length = 0;
  hv2.s.hoverTab("about");
  await wait();
  assert.deepStrictEqual(hv2.fetches, [], "hovering About sends nothing: it already polls lite+hw");
  assert.strictEqual(hv2.s.pollUrl(), "metrics?lite=1", "and the Chat tab still asks its own tier");
  assert.strictEqual(hv2.s.pollDelay({live: {state: "idle"}}), 15000, "Chat backs off; Monitor keeps 1 s");
  hv2.s.setTab("monitor");
  assert.strictEqual(hv2.s.pollDelay({live: {state: "idle"}}), 1000, "the Monitor's own cadence is unchanged");
  done.push("hover: the Monitor prefetches at once, throttled to one fetch per second");

  // 45. "Show thinking: Fold when done" - one control, both kinds of block.  The want: the thinking and a tool
  // call are open while they are happening, then close themselves once they are done.  Driven through the real
  // paint path, one frame at a time, because the collapse only exists if a later paint re-decides the open
  // attribute.  (The plain-answer half of this, where a fold needs the m.rts stamp send() writes, is cases 46
  // and 47; here the fold comes from `cut`, a call landing at the end of the run.)
  const af = run({}, {});
  await wait();
  assert.strictEqual(af.s.settings.show, "live", "the middle option is the default");
  const am45 = {role: "assistant", text: "", reasoning: "", time: Date.now(), tools: []};
  const ael45 = af.s.msgEl(am45, 0);
  af.s.el("chat").appendChild(ael45);           // the toggle listener is on #chat, so the block must be under it
  af.s.messages.length = 0; af.s.messages.push(am45);
  af.s.updateAssistant(ael45, am45, true);
  am45.reasoning = "let me read that";
  af.s.updateAssistant(ael45, am45, true);
  const ab45 = ael45.querySelector(".st-bubble");
  const think45 = ab45._blocks[0].el;
  assert.strictEqual(think45.open, true, "the thought is open while it is being thought");
  af.s.onTool(am45, {event: "start", id: "c1", name: "easyCMP__fs_read"});
  af.s.updateAssistant(ael45, am45, true);
  const call45 = ab45._parts.find((p) => p.kind === "tool").el;
  // the stub does not read data-* out of inserted HTML (case 24 builds its block by hand for the same reason),
  // so give this one the attribute the real DOM would have parsed.  Then fire the toggle the page's own
  // d.open = true produced - twice, because a browser queues the event and two paints can leave two in
  // flight.  A consumed flag eats the first and reads the second as a click; a comparison eats both.
  call45.dataset.tool = "0";
  af.s.el("chat")._l["toggle"]({target: call45});
  af.s.el("chat")._l["toggle"]({target: call45});
  assert.strictEqual(am45.tools[0].open, undefined,
                     "two of the page's own toggles are still not a click (this is what pinned the block open)");
  assert.strictEqual(call45.open, true, "the call is open while the model writes it");
  assert.strictEqual(think45.open, false, "and the thought that led to it folds: the model has already acted on it");
  const box45 = call45.querySelector(".st-collapse__body");
  const pre45 = box45.querySelector(".tool-call__pre-args");   // the body was built when the block opened
  assert.ok(box45._html.includes("(being written)"), "built while writing, so the reader saw it being written");
  af.s.onTool(am45, {event: "call", id: "c1", name: "easyCMP__fs_read", server: "easyCMP", tool: "fs_read",
                     arguments: {path: "a.txt"}, round: 1});
  af.s.updateAssistant(ael45, am45, true);
  assert.strictEqual(call45.open, true, "still open while it runs");
  assert.strictEqual(pre45.textContent, JSON.stringify({path: "a.txt"}, null, 2),
                     "its arguments were written into the open block, so the reader saw them");
  af.s.onTool(am45, {event: "result", id: "c1", text: "the file", ok: true, ms: 412});
  am45.text = "here is the answer";
  af.s.updateAssistant(ael45, am45, true);
  assert.strictEqual(call45.open, false, "the call folds once the result is in");
  assert.ok(!box45._hasResult,
            "it folded in the frame the result landed, so the result body was never built - the summary line previews it");
  call45.open = true;                                  // the reader clicks it back open
  af.s.el("chat")._l["toggle"]({target: call45});      // the stub fires it through the parent; be explicit
  assert.strictEqual(am45.tools[0].open, true, "that click is the reader's, not the page's");
  assert.strictEqual(box45.querySelector(".tool-call__pre-result").textContent, "the file",
                     "and opening it fills in the result, as it always did");
  af.s.updateAssistant(ael45, am45, false);
  assert.strictEqual(ab45._blocks[0].el.open, false, "the thought stays folded when the turn ends");
  assert.strictEqual(call45.open, true, "and the reader's own open block is left open");
  // a click still wins, in both directions, and is not overwritten by the fold
  const af2 = run({}, {});
  await wait();
  af2.s.setSettings({show: "live"});
  const bm45 = {role: "assistant", text: "", reasoning: "", time: Date.now(), tools: []};
  const bel45 = af2.s.msgEl(bm45, 0);
  af2.s.el("chat").appendChild(bel45);
  af2.s.messages.length = 0; af2.s.messages.push(bm45);
  af2.s.onTool(bm45, {event: "start", id: "c1", name: "easyCMP__fs_read"});
  af2.s.updateAssistant(bel45, bm45, true);
  const bd45 = bel45.querySelector(".st-bubble")._parts.find((p) => p.kind === "tool").el;
  bd45.dataset.tool = "0";                             // as above: the stub does not parse data-* out of HTML
  bd45.open = false;                                   // the reader closed it while it ran
  af2.s.el("chat")._l["toggle"]({target: bd45});       // a real details fires it; the stub does too
  assert.strictEqual(bm45.tools[0].open, false, "the page took the reader's choice");
  af2.s.onTool(bm45, {event: "call", id: "c1", name: "easyCMP__fs_read", arguments: {}, round: 1});
  af2.s.updateAssistant(bel45, bm45, true);
  assert.strictEqual(bd45.open, false, "and the fold did not reopen it under them");
  af2.s.onTool(bm45, {event: "result", id: "c1", text: "r", ok: true, ms: 10});
  af2.s.updateAssistant(bel45, bm45, true);
  assert.strictEqual(bd45.open, false, "still theirs when it settles");
  // the plain answer case: with no tool calls there is no cut, so the thought folds on the first answer text.
  // send() stamps m.rts[0] = 0 when the first reasoning token arrives; the harness feeds it the same way.
  const pf = run({}, {});
  await wait();
  pf.s.setSettings({show: "live"});
  const pm45 = {role: "assistant", text: "", reasoning: "", time: Date.now(), rts: [0]};
  const pel45 = pf.s.msgEl(pm45, 0);
  pf.s.el("chat").appendChild(pel45);
  pf.s.messages.length = 0; pf.s.messages.push(pm45);
  pf.s.updateAssistant(pel45, pm45, true);
  pm45.reasoning = "a long thought about nothing much";
  pf.s.updateAssistant(pel45, pm45, true);
  const pb45 = pel45.querySelector(".st-bubble");
  assert.strictEqual(pb45._blocks[0].el.open, true, "open while it is only thinking");
  pm45.text = "the answer starts";
  pf.s.updateAssistant(pel45, pm45, true);
  assert.strictEqual(pb45._blocks[0].el.open, false, "and folded the moment the answer starts");
  pm45.reasoning += " then thinks again";
  pf.s.updateAssistant(pel45, pm45, true);
  assert.strictEqual(pb45._blocks[0].el.open, false, "a thought after the answer stays folded (its stamp is 0)");
  // no stamp at all (a chat from before this existed, or a stream that never stamped one): the fold does not
  // guess, and the old rule still holds - the live run stays open while the turn streams
  const ns = run({}, {});
  await wait();
  ns.s.setSettings({show: "live"});
  const nm45 = {role: "assistant", text: "already writing", reasoning: "still thinking", time: Date.now()};
  const nel45 = ns.s.msgEl(nm45, 0);
  ns.s.el("chat").appendChild(nel45);
  ns.s.messages.length = 0; ns.s.messages.push(nm45);
  ns.s.updateAssistant(nel45, nm45, true);
  const nb45 = nel45.querySelector(".st-bubble");
  assert.strictEqual(nb45._blocks[0].el.open, true, "no stamp, no fold by the text rule: it follows 'Show thinking'");
  // the tripwire again: m.rts is numbers only, and the replay must be byte for byte what it was
  const trip = {role: "assistant", text: "beforeafter", reasoning: "thought", time: Date.now(), rts: [0],
                tools: [{id: "c1", name: "x", state: "done", at: 6, rat: 7, result: "r", round: 0}]};
  assert.strictEqual(JSON.stringify(ns.s.assistantMessages(trip, true)), JSON.stringify([
    {role: "assistant", content: "before", tool_calls: [{id: "c1", type: "function",
        function: {name: "x", arguments: "{}"}}], reasoning_content: "thought"},
    {role: "tool", tool_call_id: "c1", content: "r"},
    {role: "assistant", content: "after"}]), "m.rts changes nothing about what goes back to the server");
  // the same for a thinking block the reader opened by hand
  const cm45 = {role: "assistant", text: "", reasoning: "a thought", time: Date.now()};
  const cel45 = af2.s.msgEl(cm45, 0);
  af2.s.el("chat").appendChild(cel45);
  af2.s.messages.length = 0; af2.s.messages.push(cm45);
  af2.s.updateAssistant(cel45, cm45, true);
  const cd45 = cel45.querySelector(".st-bubble")._blocks[0].el;
  assert.strictEqual(cd45.open, true, "open while it streams");
  cd45.open = false;
  af2.s.el("chat")._l["toggle"]({target: cd45});
  assert.strictEqual(cd45.dataset.touched, "1", "marked as the reader's own");
  cm45.reasoning += " and more";
  af2.s.updateAssistant(cel45, cm45, true);
  assert.strictEqual(cd45.open, false, "the page does not fight that click, the control aside");
  // all three options, on the same finished message, both kinds of block
  const af3 = run({}, {});
  await wait();
  const dm45 = {role: "assistant", text: "answer", reasoning: "thought", time: Date.now(),
                tools: [{id: "c1", name: "x", state: "done", at: 6, result: "r", round: 0}]};
  const db45 = af3.s.msgEl(dm45, 0).querySelector(".st-bubble");
  assert.strictEqual(db45._blocks[0].el.open, false, "live: a finished thought stays closed");
  assert.ok(!db45._parts.find((p) => p.kind === "tool").el._html.includes('data-state="done" open'), "live: the call is closed");
  af3.s.setSettings({show: "always"});
  const eb45 = af3.s.msgEl(dm45, 0).querySelector(".st-bubble");
  assert.strictEqual(eb45._blocks[0].el.open, true, "always: the thought is open");
  assert.ok(eb45._parts.find((p) => p.kind === "tool").el._html.includes('data-state="done" open'),
            "always: and so is the call, with its body");
  af3.s.setSettings({show: "folded"});
  const fb45 = af3.s.msgEl(dm45, 0).querySelector(".st-bubble");
  assert.strictEqual(fb45._blocks[0].el.open, false, "folded: the thought is closed");
  assert.ok(!fb45._parts.find((p) => p.kind === "tool").el._html.includes('data-state="done" open'),
            "folded: and the call is closed even though it is finished and readable");
  done.push("fold: thinking and tool calls open while they happen and close when they settle; a click still wins");

  // 46. the fold driven through send(), not by hand.  Case 45 feeds the page message objects; this one streams,
  // so it also covers what send() does on the way: the m.rts stamp that tells a later paint where a thinking
  // run began in the answer text.  Without that line the plain answer case never folds, and a test that sets
  // rts itself cannot see it missing (LESSONS.md: a test that calls the function instead of driving the wired
  // control passes on code that is not wired at all).  Same frame queue as case 37: one step per frame.
  const ctl46 = {step: null, flush: null}, q46 = [];
  const read46 = () => new Promise((res) => {
    ctl46.step = () => {
      if (ctl46.flush) ctl46.flush();               // paint first, as one animation frame would
      res(q46.length ? {done: false, value: new TextEncoder().encode(q46.shift())} : {done: true});
    };
  });
  const sd = run({fetch: async () => ({ok: true, body: {getReader: () => ({read: read46})}})}, {});
  await wait();
  ctl46.flush = sd.flush;
  sd.s.setSettings({show: "live"});
  // the row is found by its class and index rather than by position: send() also wrote the user's message, and
  // the stub's msgEl returns a fresh object each time, so a captured child would not be the row being painted
  const rowOf46 = () => sd.s.el("chat").children.find((c) => c.className.includes("st-msg--assistant"));
  q46.push(frame({choices: [{delta: {reasoning_content: "a thought"}}]}),
         frame({choices: [{delta: {content: "the answer"}}]}));
  sd.s.el("input").value = "a question";
  const settled46 = sd.s.send();                     // not awaited: the stream is still open
  await wait();                                      // the fetch resolves and the first read is armed
  ctl46.step(); await wait(); sd.flush();            // the thinking chunk, then the frame it scheduled
  const am46 = sd.s.messages[1];
  assert.deepStrictEqual(am46.rts, [0], "send() stamped where the first thinking run began: no answer text yet");
  assert.strictEqual(am46.text, "", "and only thinking has arrived so far");
  const ab46 = rowOf46().querySelector(".st-bubble");
  assert.strictEqual(ab46._blocks.length, 1, "the thinking block is a part of the bubble");
  assert.strictEqual(ab46._blocks[0].el.open, true, "so the thought is open on screen");
  ctl46.step(); await wait(); sd.flush();            // the first content frame
  assert.strictEqual(rowOf46().querySelector(".st-bubble")._blocks[0].el.open, false,
                     "the answer arrives and the thought folds, mid-stream");
  ctl46.step(); await wait(); sd.flush();            // end of stream
  await settled46;
  assert.strictEqual(rowOf46().querySelector(".st-bubble")._blocks[0].el.open, false,
                     "and stays folded when the turn ends");
  assert.strictEqual(am46.reasoning, "a thought", "the reasoning itself is untouched");
  assert.strictEqual(sd.s.apiMessages()[1].content, "the answer", "and the prompt carries the answer as usual");
  done.push("fold: driven through send() - the stamp lands, and the thought folds when the answer starts");

  // 47. the second stamp: a thought that begins AFTER a tool round is stamped with the answer text that already
  // existed, so it folds when the model writes again and not before.  Without the index (a plain [0]) the second
  // thought would fold the instant it opened, because text.length is already past 0.
  const q47 = [];
  const ctl47 = {step: null};
  const read47 = () => new Promise((res) => { ctl47.step = () => {
    if (ctl47.flush) ctl47.flush();
    res(q47.length ? {done: false, value: new TextEncoder().encode(q47.shift())} : {done: true});
  }; });
  const s2 = run({fetch: async () => ({ok: true, body: {getReader: () => ({read: read47})}})}, {});
  await wait();
  ctl47.flush = s2.flush;
  s2.s.setSettings({show: "live"});
  const row47 = () => s2.s.el("chat").children.find((c) => c.className.includes("st-msg--assistant"));
  q47.push(frame({choices: [{delta: {reasoning_content: "first thought"}}]}),
         frame({choices: [{delta: {content: "I will read it"}}]}),
         frame({strata_mcp: {event: "start", id: "c1", name: "x"}}),
         frame({strata_mcp: {event: "call", id: "c1", name: "x", server: "easyCMP", tool: "x",
                             arguments: {}, round: 0}}),
         frame({strata_mcp: {event: "result", id: "c1", text: "r", ok: true, ms: 5}}),
         frame({choices: [{delta: {reasoning_content: "second thought"}}]}),
         frame({choices: [{delta: {content: " the answer"}}]}));
  s2.s.el("input").value = "go";
  const settled47 = s2.s.send();
  await wait();
  for (let i = 0; i < 6; i++) { ctl47.step(); await wait(); s2.flush(); }   // through the second thought
  const am47 = s2.s.messages[1];
  assert.deepStrictEqual(am47.rts, [0, "I will read it".length],
                         "run 0 stamped at 0, run 1 at the text that existed when it began");
  const rb47 = row47().querySelector(".st-bubble");
  assert.strictEqual(rb47._blocks[1].el.open, true, "the second thought is open: nothing has been written since it began");
  assert.strictEqual(rb47._blocks[0].el.open, false, "and the first is folded: a call cut it");
  ctl47.step(); await wait(); s2.flush();           // the answer resumes
  const rb47b = row47().querySelector(".st-bubble");
  assert.strictEqual(rb47b._blocks[1].el.open, false, "the second thought folds once the text grows past its stamp");
  assert.strictEqual(am47.reasoning, "first thought\n\nsecond thought", "the reasoning is exactly as before");
  ctl47.step(); await wait();                       // one step past the last frame: the stream ends
  await settled47;
  done.push("fold: a thought after a tool round folds on the next text, not the moment it opens");

  // 48. a click on a tool block holds for the turn and no further.  It used to be kept on the tool record and
  // written into the chat, so one tap pinned a call open through every reload after it - and no switch could
  // reclaim it, because toolOpen short-circuits when t.open is set.  Now send() drops it when the turn ends and
  // cleanMessages keeps it out of the record.  This is what makes the thinking and the calls behave the same
  // way: a thinking block's "the reader touched this" always lived on the DOM element and so never survived.
  const q48 = [];
  const ctl48 = {step: null};
  const read48 = () => new Promise((res) => { ctl48.step = () => {
    if (ctl48.flush) ctl48.flush();
    res(q48.length ? {done: false, value: new TextEncoder().encode(q48.shift())} : {done: true});
  }; });
  const s48 = run({fetch: async () => ({ok: true, body: {getReader: () => ({read: read48})}})},
                   {"strata.history": "true"}, {});
  await wait();
  ctl48.flush = s48.flush;
  s48.s.setSettings({show: "folded"});                  // nothing opens by itself: only the reader's click does
  const row48 = () => s48.s.el("chat").children.find((c) => c.className.includes("st-msg--assistant"));
  q48.push(frame({choices:[{delta:{content:"I will read it"}}]}),
         frame({strata_mcp:{event:"start",id:"c1",name:"x"}}),
         frame({strata_mcp:{event:"call",id:"c1",name:"x",arguments:{a:1},round:0}}),
         frame({strata_mcp:{event:"result",id:"c1",text:"the file",ok:true,ms:5}}));
  s48.s.el("input").value = "go";
  const settled48 = s48.s.send();
  await wait();
  for (let i = 0; i < 4; i++) { ctl48.step(); await wait(); s48.flush(); }   // the call finishes
  let b48 = row48().querySelector(".st-bubble");
  let t48 = b48._parts.find((p) => p.kind === "tool").el;
  t48.dataset.tool = "0";
  assert.strictEqual(t48.open, false, "folded: the finished call is closed");
  t48.open = true; s48.s.el("chat")._l["toggle"]({target: t48});            // the reader opens it
  assert.strictEqual(s48.s.messages[1].tools[0].open, true, "the click is recorded for now");
  ctl48.step(); await wait();                                              // end of stream: the turn finishes
  await settled48;
  b48 = row48().querySelector(".st-bubble");
  t48 = b48._parts.find((p) => p.kind === "tool").el;
  assert.strictEqual(s48.s.messages[1].tools[0].open, undefined, "send() dropped the click with the turn");
  assert.strictEqual(t48.open, false, "and the final paint closed the block again, per the control");
  await wait();
  const rec48 = Object.values(s48.records)[0];
  assert.strictEqual(rec48.messages[1].tools[0].open, undefined, "and nothing about it reached the chat record");
  // a chat saved by an older page can still carry open: true; a reload must ignore it, not obey it forever
  const s49 = run({}, {"strata.history":"true","strata.chatId":JSON.stringify("A")},
    {A:{id:"A",title:"a",time:Date.now(),messages:[
      {role:"user",text:"go",time:Date.now()},
      {role:"assistant",text:"the answer",reasoning:"a thought",time:Date.now(),rts:[0],
       tools:[{id:"c1",name:"x",state:"done",at:0,rat:9,result:"the file",round:0,open:true}]}]}});
  await wait();
  s49.s.setSettings({show:"folded"});
  const old49 = s49.s.el("chat").children.find((c)=>c.className.includes("st-msg--assistant"))
                             .querySelector(".st-bubble");
  assert.strictEqual(old49._parts.find((p)=>p.kind==="tool").el.open, false,
                     "a stored open:true from the old page no longer pins the block");
  assert.strictEqual(old49._blocks[0].el.open, false, "and the thinking agrees with it");
  // and the write path strips it on its own, with no turn running: a block opened by hand on a FINISHED message
  // has no send() to drop the choice, so cleanMessages is the only thing standing between it and the record.
  s49.s.saveChat(s49.s.chat); await wait();
  assert.strictEqual(s49.records["A"].messages[1].tools[0].open, undefined,
                     "saving a chat an older page wrote cleans the stored open out of it");
  const clicked49 = old49._parts.find((p)=>p.kind==="tool").el;
  clicked49.dataset.tool = "0";
  clicked49.open = true; s49.s.el("chat")._l["toggle"]({target: clicked49});
  assert.strictEqual(s49.s.chat.messages[1].tools[0].open, true, "the click is recorded in memory, for this view");
  s49.s.saveChat(s49.s.chat); await wait();
  assert.strictEqual(s49.records["A"].messages[1].tools[0].open, undefined,
                     "but it is not written out: the record stays free of display state");
  done.push("fold: a click on a call holds for the turn only - it is not saved, and cannot pin the block open");

  // 49. the four old switches become one control.  A browser that has "sampling" stored from the old page has
  // show/openthink/opentools/autofold as booleans; migrateShow maps them once on load, so the drawer shows the
  // right position and the page behaves as it did, rather than the saved true/false deciding how a three-way
  // control looks.  A new object (show already a word) passes through untouched.
  const stored = (sampling) => run({}, {"strata.sampling": JSON.stringify(sampling)});
  const old_default = {thinking: "high", temperature: 0.6, top_p: 0.95, top_k: 20, max: "", seed: "",
                       show: true, openthink: false, opentools: false, mdmine: false, mdtheirs: true,
                       esp: true, mcp: true, mcpthink: false};        // the page before the fold switch existed
  const m1 = stored(old_default); await wait();
  assert.strictEqual(m1.s.settings.show, "live", "the old default (thinking open while it streams) is 'live'");
  assert.strictEqual("openthink" in m1.s.settings, false, "and the old keys are gone, not left behind");
  const m2 = stored({...old_default, autofold: true}); await wait();
  assert.strictEqual(m2.s.settings.show, "live", "the fold switch from earlier today maps to 'live'");
  const m3 = stored({...old_default, opentools: true}); await wait();
  assert.strictEqual(m3.s.settings.show, "always", "'keep tool calls open' maps to 'always'");
  const m4 = stored({...old_default, openthink: true}); await wait();
  assert.strictEqual(m4.s.settings.show, "always", "'keep thinking open' maps to 'always' too - the same answer");
  const m4b = stored({...old_default, opentools: true, autofold: true}); await wait();
  assert.strictEqual(m4b.s.settings.show, "live",
                     "both on: the fold wins over keep-open, the precedence that already applied to them");
  const m5 = stored({...old_default, show: false}); await wait();
  assert.strictEqual(m5.s.settings.show, "folded", "'Show thinking' off maps to 'folded'");
  const m6 = stored({...old_default, show: "always"}); await wait();
  assert.strictEqual(m6.s.settings.show, "always", "a new-style object passes straight through");
  // and the mapped value is what the page acts on, not just what the setting says
  const m7 = stored({...old_default, autofold: true}); await wait();
  const mm7 = {role: "assistant", text: "answer", reasoning: "thought", time: Date.now(), rts: [0],
               tools: [{id: "c1", name: "x", state: "done", at: 6, result: "r", round: 0}]};
  const mb7 = m7.s.msgEl(mm7, 0).querySelector(".st-bubble");
  assert.strictEqual(mb7._blocks[0].el.open, false, "the migrated setting still folds a finished thought");
  assert.ok(!mb7._parts.find((p) => p.kind === "tool").el._html.includes('data-state="done" open'),
            "and a finished call, exactly as the old autofold switch did");
  // the drawer shows it: three options, and Apply writes the word back.  The options are not clicked here:
  // the stub has no parse-time children, so app.js's "for (const b of children) b.onclick = ..." loop finds
  // nothing to attach to (the same limit s-thinking has always had).  Setting aria-checked is what case 29 does
  // for a switch, and it drives the same read path - drawerSettings, drawerDirty and Apply.
  const m8 = stored({...old_default, opentools: true}); await wait();
  const seg = m8.s.el("s-show");
  // build the three options the browser would have parsed, then let the page read them itself
  seg.children = ["folded", "live", "always"].map((v) => { const e = makeEl(); e.dataset.v = v; e._parent = seg; return e; });
  m8.s.loadDrawer(m8.s.settings);                   // the same call openDrawer makes
  assert.deepStrictEqual(seg.children.map((b) => b.attrs["aria-checked"]), ["false", "false", "true"],
                         "the page itself shows the migrated answer, and there are three options not four switches");
  assert.strictEqual(m8.s.drawerDirty(), false, "opening the panel with a migrated object changes nothing");
  for (const b of seg.children) b.setAttribute("aria-checked", String(b.dataset.v === "live"));
  assert.strictEqual(m8.s.drawerDirty(), true, "moving it is an unapplied change like any other");
  assert.strictEqual(m8.s.drawerSettings().show, "live", "and drawerSettings reads the control, not the old keys");
  await m8.s.el("s-apply").onclick();
  assert.strictEqual(JSON.parse(m8.stored["strata.sampling"]).show, "live", "Apply writes the word");
  assert.strictEqual("autofold" in JSON.parse(m8.stored["strata.sampling"]), false, "and writes no old key");
  const m9 = run({}, {}); await wait();
  assert.strictEqual(m9.s.settings.show, "live", "a browser with nothing stored gets the default");
  done.push("settings: the four old switches map to folded/live/always once on load, and the drawer shows it");

  // 50. auto-scroll keeps following when a big block lands (todo #auto-scroll-big-block).  The bug: send()'s paint()
  // measured nearBottom() AFTER updateAssistant had grown the DOM, so a chunk that adds thousands of pixels in one
  // frame left the reader past the 120 px slack, the follow switched itself off, and it never came back.  The fix
  // measures the follow decision BEFORE the update - the order the thinking body already uses (nearEnd before
  // assigning textContent, app.js).  The stub does not lay out, so the page's growth is modelled by counting the
  // answer bubble's drawn blocks: each block stands for a tall one (a tool call, a table, a code fence) and is
  // weighted far above the slack, so one landing in a single frame is exactly the case that broke.  Driven through
  // send(), one frame at a time, like case 46.
  const ctl50 = {step: null, flush: null}, q50 = [];
  const read50 = () => new Promise((res) => {
    ctl50.step = () => {
      if (ctl50.flush) ctl50.flush();               // paint the previous chunk, as one animation frame would
      res(q50.length ? {done: false, value: new TextEncoder().encode(q50.shift())} : {done: true});
    };
  });
  const as = run({fetch: async () => ({ok: true, body: {getReader: () => ({read: read50})}})}, {});
  await wait();
  ctl50.flush = as.flush;
  const scroll = as.s.el("chat-scroll");
  scroll.clientHeight = 600;
  const rowOf50 = () => as.s.el("chat").children.find((c) => (c.className || "").includes("st-msg--assistant"));
  const blocksOf50 = () => { const r = rowOf50(); const b = r && r.querySelector(".st-bubble"); return b ? b.children.length : 0; };
  // 600 px of chrome plus 5000 px per drawn block: one block appearing in one frame is a jump of 5000 px,
  // far more than the 120 px the follow allows, which is the situation the bug is about.
  Object.defineProperty(scroll, "scrollHeight", {configurable: true, get: () => 600 + 5000 * blocksOf50(), set: () => {}});
  const f50 = (o) => "data: " + JSON.stringify(o) + "\n\n";
  q50.push(f50({choices: [{delta: {content: "the first paragraph"}}]}));
  as.s.el("input").value = "go";
  const running50 = as.s.send();
  await wait();                                     // renderChat has run; the assistant bubble is still empty
  scroll.scrollTop = scroll.scrollHeight - scroll.clientHeight;   // put the reader exactly at the bottom
  const bottom0 = scroll.scrollHeight;
  ctl50.step(); await wait(); as.flush();           // the first content frame: one block lands
  assert.strictEqual(blocksOf50(), 1, "one answer block drawn");
  assert.ok(scroll.scrollHeight > bottom0 + 120, "the block added far more than the 120 px slack in one frame");
  assert.strictEqual(scroll.scrollTop, scroll.scrollHeight,
                     "a 5000 px block lands while at the bottom: the chat follows to the new bottom (this is the fix)");
  // keep following: a second big block (a code fence) lands while still at the bottom - the follow must not have
  // switched itself off, which is what the old code did after the first one
  q50.push(f50({choices: [{delta: {content: "\n\n```\nmany lines\n```"}}]}));
  ctl50.step(); await wait(); as.flush();
  assert.strictEqual(blocksOf50(), 2, "a second block, a code fence, lands");
  assert.strictEqual(scroll.scrollTop, scroll.scrollHeight, "the follow is still on after the first big block");
  // but a reader who scrolled up is not yanked back down: a big block lands above them and the follow is off
  scroll.scrollTop = scroll.scrollHeight - scroll.clientHeight - 400;   // 400 px above the bottom
  const upAt = scroll.scrollTop;
  q50.push(f50({choices: [{delta: {content: "\n\nand more text below"}}]}));
  ctl50.step(); await wait(); as.flush();
  assert.strictEqual(blocksOf50(), 3, "a third block lands while the reader is scrolled up");
  assert.strictEqual(scroll.scrollTop, upAt, "scrolled up: not dragged to the bottom by a new block");
  // the final paint follows only because the reader came back to the bottom
  scroll.scrollTop = scroll.scrollHeight - scroll.clientHeight;
  ctl50.step(); await wait();                        // one step past the last frame: the stream ends, then the fin paint
  await running50;
  assert.strictEqual(scroll.scrollTop, scroll.scrollHeight, "the final paint follows when the reader is at the bottom");
  done.push("auto-scroll: keeps following when a big block lands in one frame; a reader who scrolled up is left alone");

  // 51. the sidebar groups by calendar day, not by a 24-hour count (todo #sidebar-yesterday).  This is the
  // report: a chat from 23:59 yesterday read at any time today was "Today" under the old arithmetic, and nothing
  // was ever "Yesterday" until it was 24-48 hours old.  The timestamps are built from local midnights so the
  // assertion holds whatever wall-clock time the test runs at: 23:59 yesterday is always one calendar day back,
  // and the old `Math.floor((Date.now() - t) / 86400000)` put it in "Today" for the whole of today (the gap is
  // under 24 hours), so this assertion fails on the old code and passes on the new one at every hour.
  const cal = run({}, {"strata.history": "true"}, {});
  await wait();
  const nowC = new Date();
  const atC = (d, h, min) => new Date(nowC.getFullYear(), nowC.getMonth(), nowC.getDate() + d, h, min, 0, 0).getTime();
  cal.s.chats.push(
    {id: "ylate", title: "late yesterday", time: atC(-1, 23, 59), messages: [msg("ylate")]},
    {id: "tearly", title: "early today", time: atC(0, 0, 30), messages: [msg("tearly")]},
    {id: "three", title: "three days ago", time: atC(-3, 12, 0), messages: [msg("three")]},
    {id: "old60", title: "sixty days ago", time: atC(-60, 12, 0), messages: [msg("old")]});
  cal.s.renderSidebar();
  assert.deepStrictEqual(groups(cal.s), ["Today", "Yesterday", "Previous 7 days", qlabel(atC(-60, 12, 0))], "the four calendar groups");
  // which group a given row sits under: walk the list, remembering the last group heading seen
  const groupOf = (id) => {
    let g = "";
    for (const c of cal.s.el("sidebar-list").children) {
      if ((c.className || "").includes("sidebar-group")) g = c.textContent;
      else if (c.dataset.id === id) return g;
    }
    return "(no row)";
  };
  assert.strictEqual(groupOf("ylate"), "Yesterday", "23:59 yesterday reads as Yesterday, not Today, whatever time today it is read");
  assert.strictEqual(groupOf("tearly"), "Today", "00:30 today reads as Today");
  assert.strictEqual(groupOf("three"), "Previous 7 days", "three days ago is in the seven-day group");
  assert.strictEqual(groupOf("old60"), qlabel(atC(-60, 12, 0)), "sixty days ago falls into its calendar quarter, not 'Older'");
  done.push("day groups: calendar days - late yesterday is Yesterday at any hour today; the old 24-hour count said Today all day");

  // 52. past 30 days the sidebar groups by calendar quarter, not one flat "Older" (todo #sidebar-quarter-groups).
  // Fixed 2024 dates so the expected headings are literal strings - independent of when the test runs, and far
  // enough back that every chat is past the 30-day named buckets whatever today's date is.  The headings must come
  // out newest-first (Q4 -> Q1) because renderSidebar sorts newest-first and emits a heading only when the group
  // changes; that ordering is free, and this asserts it.  The quarter FORMULA is pinned by the groupName calls
  // below, so a wrong formula cannot hide behind the qlabel helper cases 14 and 51 use.
  const atQ = (y, mo, da) => new Date(y, mo, da, 12, 0).getTime();
  // seed the four chats so openHistory loads them and does not add a blank "Today" chat on top
  const qg = run({}, {"strata.history": "true"}, {
    q1: {id: "q1", title: "feb 2024", time: atQ(2024, 1, 15), messages: [msg("q1")]},
    q2: {id: "q2", title: "jun 2024", time: atQ(2024, 5, 15), messages: [msg("q2")]},
    q3: {id: "q3", title: "sep 2024", time: atQ(2024, 8, 15), messages: [msg("q3")]},
    q4: {id: "q4", title: "dec 2024", time: atQ(2024, 11, 15), messages: [msg("q4")]}});
  await wait();
  qg.s.renderSidebar();
  assert.deepStrictEqual(groups(qg.s), ["2024 Q4", "2024 Q3", "2024 Q2", "2024 Q1"],
                         "quarters, newest first - not one flat 'Older' bucket");
  assert.strictEqual(qg.s.groupName(atQ(2024, 0, 10)), "2024 Q1", "January is Q1");
  assert.strictEqual(qg.s.groupName(atQ(2024, 2, 10)), "2024 Q1", "March is still Q1");
  assert.strictEqual(qg.s.groupName(atQ(2024, 3, 10)), "2024 Q2", "April opens Q2");
  assert.strictEqual(qg.s.groupName(atQ(2024, 11, 31)), "2024 Q4", "December is Q4");
  assert.strictEqual(qg.s.groupName(undefined), "Older", "a record with no time has no quarter to name (fallback, not NaN QNaN)");
  done.push("day groups: past 30 days the buckets are calendar quarters newest-first; an invalid time falls back to Older");

  // 53. the context percent on a finished answer (todo #context-percent).  Driven through send(): the stream's
  // final usage chunk carries prompt_tokens/completion_tokens and the reused count (prompt_tokens_details.
  // cached_tokens), send() stores m.usage, and the meta row grows a "(NN% context)" span whose hover title
  // breaks it down.  health.max_context is the denominator, so the fake fetch answers /health with a window size.
  // Used = prompt + completion = 4,040 of 8,192 -> 49%; the reused 3,200 is 80% of the 4,000-token prompt.
  const ctl53 = {step: null, flush: null}, q53 = [];
  const read53 = () => new Promise((res) => {
    ctl53.step = () => {
      if (ctl53.flush) ctl53.flush();
      res(q53.length ? {done: false, value: new TextEncoder().encode(q53.shift())} : {done: true});
    };
  });
  const cpr = run({fetch: async (u) => {
    if (u === "health") return {ok: true, json: async () => ({status: "ok", model: "strata", max_context: 8192, images: false, loaded: true})};
    if (String(u).startsWith("v1/chat/completions")) return {ok: true, body: {getReader: () => ({read: read53})}};
    return {ok: true, json: async () => ({}), text: async () => ""};
  }}, {});
  await wait();                                       // loadHealth answered /health, so health.max_context is 8192
  ctl53.flush = cpr.flush;
  const f53 = (o) => "data: " + JSON.stringify(o) + "\n\n";
  q53.push(f53({choices: [{delta: {content: "the answer"}}]}),
         f53({choices: [{}], usage: {prompt_tokens: 4000, completion_tokens: 40, total_tokens: 4040,
                                      prompt_tokens_details: {cached_tokens: 3200}}}));
  cpr.s.el("input").value = "go";
  const run53 = cpr.s.send();
  await wait();
  ctl53.step(); await wait(); cpr.flush();             // the content frame
  ctl53.step(); await wait(); cpr.flush();             // the usage frame
  ctl53.step(); await wait();                          // end of stream, then the fin paint
  await run53;
  const m53 = cpr.s.messages[1];
  assert.ok(m53.usage, "send() stored the usage chunk on the message");
  assert.strictEqual(m53.usage.prompt_tokens, 4000, "prompt tokens kept for the breakdown");
  const row53 = cpr.s.el("chat").children.find((c) => (c.className || "").includes("st-msg--assistant"));
  const pct53 = row53.querySelector(".ctx-pct");
  assert.strictEqual(pct53.hidden, false, "the percent span shows once the turn has usage");
  assert.strictEqual(pct53.textContent, "(49.3% context)", "4,040 of 8,192 tokens is 49.3% (to the tenth)");
  assert.ok(String(pct53.title).includes("3,200"), "the hover title names the reused prefix");
  assert.ok(String(pct53.title).includes("80.0%"), "and how much of the prompt was reused (3,200 of 4,000)");
  // no percent while a turn streams (no usage yet), and a re-render brings it back from the stored usage
  const live53 = {role: "assistant", text: "partial", reasoning: "", time: Date.now()};
  assert.strictEqual(cpr.s.msgEl(live53, 0).querySelector(".ctx-pct").hidden, true, "no percent before the turn has usage");
  assert.strictEqual(cpr.s.msgEl(m53, 0).querySelector(".ctx-pct").textContent, "(49.3% context)",
                     "a re-render shows it again from the stored usage (the reload path)");
  done.push("context percent: (NN% context) on a finished answer; the hover title breaks it into prompt / reused / output");

  // 54. pressing Enter polls at once (todo #poll-on-enter).  Idle polling is POLL_IDLE_MS = 15 s, so before the fix
  // the pill could read "Idle" for up to 15 s into a turn - the next poll was whatever the previous idle cycle had
  // already scheduled.  setBusy(true), which send() calls, must call pollNow(); pollNow goes through the ONE
  // scheduler (schedulePoll clears the pending timer before arming), so it cannot fork a second chain.  The stub
  // records setTimeout calls rather than running them, so what is asserted is the scheduled delay and the count of
  // live timers.
  const pe = run({}, {});
  await wait();
  pe.timers.length = 0;                              // drop any timer the page armed at start-up
  pe.s.setBusy(true);
  assert.strictEqual(pe.timers.filter((t) => t.f && t.ms === 0).length, 1,
                     "setBusy(true) arms exactly one poll at 0 ms - the pill updates now, not up to 15 s away");
  pe.s.setBusy(true);                                // a second send: the scheduler cancels the pending poll, it does not stack
  assert.strictEqual(pe.timers.filter((t) => t.f).length, 1,
                     "still exactly one live timer - the second pollNow replaced the first, it did not fork a second chain");
  pe.timers.length = 0;
  pe.s.setBusy(false);                               // ending must not arm a fresh poll: the chain is already running at 1 s while busy
  assert.strictEqual(pe.timers.filter((t) => t.f).length, 0, "setBusy(false) schedules nothing new");
  done.push("poll-on-enter: Enter polls immediately; the one scheduler means it cannot fork a second chain");

  // 55. the row's three-dot menu (todo #chat-row-menu): one overflow button opens a fixed popover with Rename /
  // Duplicate / Export / Delete.  The popover is appended to <body>, not the row, because #sidebar-list scrolls and
  // would clip it - so the menu carries its own click handler (the sidebar-list handler only opens it, from the
  // overflow button, which IS inside the row).  What the harness can prove is the wiring - open, each action fires
  // the right function, outside-click and Escape close - not the pixel geometry, which is browser-only.
  const cr = run({}, {"strata.history": "true", "strata.chatId": JSON.stringify("a")},
                 {a: {id: "a", title: "chat a", time: Date.now(), messages: [msg("one"), msg("two")]},
                  b: {id: "b", title: "chat b", time: Date.now() - 1000, messages: [msg("only b")]}});
  await wait();
  const rowA = () => cr.s.el("sidebar-list").children.find((c) => c.dataset.id === "a");
  const rowB = () => cr.s.el("sidebar-list").children.find((c) => c.dataset.id === "b");
  // a fake overflow button: closest(".chat-item") resolves its row, closest("[data-chat-menu]") resolves the button
  const menuBtn = {closest: (s) => s === ".chat-item" ? rowA() : (s === "[data-chat-menu]" ? {} : null)};
  const menuBtnB = {closest: (s) => s === ".chat-item" ? rowB() : (s === "[data-chat-menu]" ? {} : null)};
  const actBtn = (act) => { const o = {closest: (s) => (s === "[data-chat-act]" ? o : null), getAttribute: () => act}; return o; };
  const outside = {closest: () => null};
  const openMenu = (btn) => cr.s.el("sidebar-list")._l["click"]({target: btn});
  const fireAct = (act) => cr.s.chatMenu._l["click"]({target: actBtn(act)});

  openMenu(menuBtn);
  const menu = cr.s.chatMenu;
  assert.ok(menu && cr.body.children.includes(menu), "the menu opens on <body>, not inside the clipped row");
  assert.deepStrictEqual(menu.children.map((x) => x.textContent), ["Rename", "Duplicate", "Export", "Delete"],
                         "Rename, Duplicate, Export, Delete");
  assert.ok(menu.children[3].className.includes("danger"), "Delete is the danger item");
  cr.fireDoc("keydown", {key: "Escape"});
  assert.strictEqual(cr.s.chatMenu, null, "Escape closes it");

  // Duplicate clones the conversation: a new chat beside the first, same content, new id, not nested
  const before55 = cr.s.chats.length;
  openMenu(menuBtn); fireAct("copy");
  assert.strictEqual(cr.s.chats.length, before55 + 1, "Duplicate added one chat beside the first");
  const clone = cr.s.chats.find((c) => c.id !== "a" && c.id !== "b");
  assert.ok(clone, "the clone has a new id");
  assert.strictEqual(clone.title, "chat a", "same title");
  assert.strictEqual(clone.messages.length, 2, "same messages");
  assert.strictEqual(clone.messages[0].text, "one", "and the same content");
  assert.notStrictEqual(clone.messages, cr.s.chats.find((c) => c.id === "a").messages, "its message array is a copy, not shared");
  assert.strictEqual(cr.s.chats.filter((c) => c.id === "a").length, 1, "the original is still there once - not nested");
  assert.strictEqual(cr.s.chatMenu, null, "the action closed the menu");

  // Rename turns the row into an inline field (done on B so A's row is untouched by the clone test)
  openMenu(menuBtnB); fireAct("rename");
  assert.ok(rowB().children.some((c) => (c.className || "").includes("chat-item__input")), "Rename opens the inline field");

  // a click outside closes it; a click on the overflow button itself does not close it out from under the row
  openMenu(menuBtn);
  cr.fireDoc("click", {target: outside});
  assert.strictEqual(cr.s.chatMenu, null, "a click outside closes it");
  openMenu(menuBtn);
  cr.fireDoc("click", {target: menuBtn});
  assert.ok(cr.s.chatMenu, "clicking the button again is not treated as an outside click");
  done.push("chat row menu: one overflow opens a body-level popover; Rename/Duplicate/Export/Delete wired; Escape and outside-click close");

  // 56. editing a post (todo #edit-posts, increment 1: edit-only Save).  An Edit button on a message opens an
  // inline box; Save rewrites the post's text and keeps every message below it.  A turn that made tool calls is
  // locked (its rounds are offsets into its own text; the modal comes in a later increment).  Cancel/Escape
  // confirm only when the text actually changed - matching how rename already behaves.
  const ep56 = run({}, {});
  await wait();
  const um56 = {id: "u1", role: "user", text: "the original question", time: Date.now()};
  const am56 = {id: "a1", role: "assistant", text: "the answer", reasoning: "", time: Date.now()};
  const tm56 = {id: "a2", role: "assistant", text: "used a tool", reasoning: "", time: Date.now(),
              tools: [{id: "t1", name: "x", state: "done", at: 10, rat: 0, result: "r", round: 0}]};
  ep56.s.messages.push(um56, am56, tm56);
  const uel56 = ep56.s.msgEl(um56, 0), tel56 = ep56.s.msgEl(tm56, 2);
  ep56.s.el("chat").appendChild(uel56); ep56.s.el("chat").appendChild(ep56.s.msgEl(am56, 1)); ep56.s.el("chat").appendChild(tel56);
  // a fake Edit-button click: closest("[data-msg-edit]") returns itself so .closest(".st-msg") still works
  const editTarget = (row) => { const o = {closest: (s) => s === "[data-msg-edit]" ? o : (s === ".st-msg" ? row : null)}; return o; };
  const clickEdit = (row) => ep56.s.el("chat")._l["click"]({target: editTarget(row)});
  const box56 = (row) => row.children.find((c) => (c.className || "").includes("msg-edit"));   // live children, not the querySelector cache (a reopened box replaces it)
  const taOf = (row) => box56(row).querySelector(".msg-edit__ta");
  const btnOf = (row, i) => box56(row).querySelector(".msg-edit__bar").children[i];   // 0 Save, 1 Submit, 2 Cancel (user); 0 Save, 1 Cancel (assistant)

  clickEdit(uel56);
  assert.ok(box56(uel56) && uel56.children.includes(box56(uel56)), "Edit opens an inline box in the post's row");
  assert.strictEqual(taOf(uel56).value, "the original question", "the box starts with the post's text");
  taOf(uel56).value = "the edited question";
  btnOf(uel56, 0).onclick();                              // Save
  assert.strictEqual(um56.text, "the edited question", "Save rewrote the post");
  assert.strictEqual(am56.text, "the answer", "the answer below it is untouched - edit only, nothing deleted");
  assert.ok(!uel56.children.some((c) => (c.className || "").includes("msg-edit")), "the box closed");

  // Cancel with changed text asks first; refusing keeps the box, accepting discards the edit
  clickEdit(uel56); taOf(uel56).value = "a discarded edit";
  ep56.confirmAnswer.yes = false;
  btnOf(uel56, 2).onclick();                              // Cancel -> refused
  assert.strictEqual(ep56.confirms.length, 1, "Cancel with changed text asks first");
  assert.strictEqual(um56.text, "the edited question", "refusing left the text as it was");
  ep56.confirmAnswer.yes = true;
  btnOf(uel56, 2).onclick();                              // Cancel -> accepted
  assert.strictEqual(ep56.confirms.length, 2, "it asked again");
  assert.strictEqual(um56.text, "the edited question", "accepting discarded the new edit");
  assert.ok(!uel56.children.some((c) => (c.className || "").includes("msg-edit")), "and the box closed");
  // Cancel with nothing changed does not ask (silent close)
  const cB56 = ep56.confirms.length;
  clickEdit(uel56); btnOf(uel56, 2).onclick();
  assert.strictEqual(ep56.confirms.length, cB56, "Cancel with nothing changed asks nothing");
  // a tool-call turn opens the edit-MODE menu (not an inline box): its rounds are offsets into its own text
  clickEdit(tel56);
  const modeMenu56 = ep56.s.chatMenu;
  assert.ok(modeMenu56, "a tool-call turn opens a mode menu instead of editing directly");
  assert.deepStrictEqual(modeMenu56.children.map((b) => b.textContent),
                         ["Edit final output only", "Edit entire (drops its tool calls)", "Cancel"], "the three mode options");
  assert.ok(!tel56.children.some((c) => (c.className || "").includes("msg-edit")), "and no inline box until a mode is chosen");
  ep56.fireDoc("keydown", {key: "Escape"});
  assert.strictEqual(ep56.s.chatMenu, null, "Escape closes the mode menu");
  done.push("edit-posts increment 1: Edit opens an inline box; Save rewrites the post and keeps everything below; Cancel confirms only if changed; a tool-call turn opens a mode menu");

  // 57. Submit on an edited user post (todo #edit-posts increment 2): the box's Submit saves the edit, deletes
  // every message after it, and resends - a fresh answer streams in.  Driven through the real Edit button and the
  // real send() with a fake stream (wire-level, per LESSONS).  An assistant post's box has no Submit.
  const ctl57 = {step: null, flush: null}, q57 = [];
  const read57 = () => new Promise((res) => {
    ctl57.step = () => { if (ctl57.flush) ctl57.flush(); res(q57.length ? {done: false, value: new TextEncoder().encode(q57.shift())} : {done: true}); };
  });
  const su = run({fetch: async (u) => {
    if (u === "health") return {ok: true, json: async () => ({status: "ok", model: "strata", max_context: 8192, images: false, loaded: true})};
    if (String(u).startsWith("v1/chat/completions")) return {ok: true, body: {getReader: () => ({read: read57})}};
    return {ok: true, json: async () => ({}), text: async () => ""};
  }}, {});
  await wait(); ctl57.flush = su.flush;
  const sub0 = {id: "s0", role: "user", text: "first question", time: Date.now()};
  const sub1 = {id: "s1", role: "assistant", text: "first answer", reasoning: "", time: Date.now()};
  const sub2 = {id: "s2", role: "user", text: "second question", time: Date.now()};
  su.s.messages.push(sub0, sub1, sub2);
  const wel57 = su.s.msgEl(sub0, 0); su.s.el("chat").appendChild(wel57);
  su.s.el("chat").appendChild(su.s.msgEl(sub1, 1)); su.s.el("chat").appendChild(su.s.msgEl(sub2, 2));
  const editTarget57 = (row) => { const o = {closest: (s) => s === "[data-msg-edit]" ? o : (s === ".st-msg" ? row : null)}; return o; };
  su.s.el("chat")._l["click"]({target: editTarget57(wel57)});            // open Edit on the first post
  const wbox57 = wel57.children.find((c) => (c.className || "").includes("msg-edit"));
  const wta57 = wbox57.querySelector(".msg-edit__ta");
  assert.strictEqual(wta57.value, "first question", "the box starts with the post's text");
  wta57.value = "edited first question";
  const bar57 = wbox57.querySelector(".msg-edit__bar");
  assert.deepStrictEqual(bar57.children.map((b) => b.textContent), ["Save", "Submit", "Cancel"], "a user post's box has Save, Submit, Cancel");
  const f57 = (o) => "data: " + JSON.stringify(o) + "\n\n";
  q57.push(f57({choices: [{delta: {content: "the new answer"}}]}));
  bar57.children[1].onclick();                                         // Submit -> resend-confirm modal
  assert.ok(su.s.modalEl, "Submit asks to confirm before resending");
  su.s.modalEl.children[0].querySelector(".msg-edit__bar").children[1].onclick();   // Send
  await wait();
  ctl57.step(); await wait(); su.flush();                              // the content frame
  ctl57.step(); await wait();                                          // end of stream
  await wait();
  assert.strictEqual(su.s.messages.length, 2, "everything after the edited post was dropped, then one fresh answer added");
  assert.strictEqual(su.s.messages[0], sub0, "the edited post is still first");
  assert.strictEqual(sub0.text, "edited first question", "its edit was saved");
  assert.strictEqual(su.s.messages[1].role, "assistant", "a new assistant turn replaced the old history");
  assert.strictEqual(su.s.messages[1].text, "the new answer", "and it streamed the model's fresh answer");
  // an assistant post (no tools) has Save and Cancel, but no Submit
  const aw57 = {id: "aw", role: "assistant", text: "an answer", reasoning: "", time: Date.now()};
  su.s.messages.push(aw57);
  const ael57 = su.s.msgEl(aw57, 2); su.s.el("chat").appendChild(ael57);
  su.s.el("chat")._l["click"]({target: editTarget57(ael57)});
  const abox57 = ael57.children.find((c) => (c.className || "").includes("msg-edit"));
  assert.deepStrictEqual(abox57.querySelector(".msg-edit__bar").children.map((b) => b.textContent), ["Save", "Cancel"], "an assistant post's box has no Submit");
  done.push("edit-posts increment 2: Submit saves the edit, deletes every message after it, and resends a fresh answer; assistant posts have no Submit");

  // 58. editing a tool-call turn (todo #edit-posts increment 3): the mode menu offers "Edit final output only"
  // (keeps the tool rounds and their at/rat offsets, edits only the text after the last call) or "Edit entire"
  // (replaces the whole text and drops the calls, turning it into a plain answer).
  const tc = run({}, {});
  await wait();
  const tm58 = {id: "tc1", role: "assistant", text: "HEADTAIL", reasoning: "", time: Date.now(),
              tools: [{id: "t1", name: "x", state: "done", at: 4, rat: 0, result: "r", round: 0}]};
  tc.s.messages.push(tm58);
  const tel58 = tc.s.msgEl(tm58, 0); tc.s.el("chat").appendChild(tel58);
  const editT58 = (row) => { const o = {closest: (s) => s === "[data-msg-edit]" ? o : (s === ".st-msg" ? row : null)}; return o; };
  const actT58 = (act) => { const o = {closest: (s) => s === "[data-chat-act]" ? o : null, getAttribute: () => act}; return o; };
  const pickMode = (act) => tc.s.chatMenu._l["click"]({target: actT58(act)});
  const box58 = () => tel58.children.find((c) => (c.className || "").includes("msg-edit"));

  tc.s.el("chat")._l["click"]({target: editT58(tel58)});          // open the mode menu
  assert.ok(tc.s.chatMenu, "a tool-call turn opens the mode menu");
  pickMode("final");
  assert.ok(box58(), "'Edit final output only' opens the box");
  assert.strictEqual(box58().querySelector(".msg-edit__ta").value, "TAIL", "the box holds only the text after the last call");
  box58().querySelector(".msg-edit__ta").value = "NEWTAIL";
  box58().querySelector(".msg-edit__bar").children[0].onclick();   // Save (assistant box: Save, Cancel)
  assert.strictEqual(tm58.text, "HEADNEWTAIL", "the tool rounds' text is kept; only the final answer changed");
  assert.strictEqual(tm58.tools.length, 1, "the tool call is kept (its at offset still points into the unchanged head)");

  tc.s.el("chat")._l["click"]({target: editT58(tel58)});          // mode menu again
  pickMode("entire");
  assert.ok(box58(), "'Edit entire' opens the box");
  assert.strictEqual(box58().querySelector(".msg-edit__ta").value, "HEADNEWTAIL", "the whole text is editable");
  box58().querySelector(".msg-edit__ta").value = "a plain replacement";
  box58().querySelector(".msg-edit__bar").children[0].onclick();   // Save
  assert.strictEqual(tm58.text, "a plain replacement", "the whole turn was replaced");
  assert.strictEqual(tm58.tools.length, 0, "'Edit entire' dropped the tool calls");
  done.push("edit-posts increment 3: a tool-call turn's mode menu - 'final' keeps the rounds and edits the tail; 'entire' replaces the text and drops the calls");

  // 59. only one edit box at a time (todo #edit-posts): clicking Edit on another post asks to discard the current
  // edit; clicking Edit again on the post already being edited does nothing; the editing row hides its own button.
  const gd = run({}, {});
  await wait();
  const gg1 = {id: "g1", role: "user", text: "one", time: Date.now()};
  const gg2 = {id: "g2", role: "user", text: "two", time: Date.now()};
  gd.s.messages.push(gg1, gg2);
  const geA = gd.s.msgEl(gg1, 0), geB = gd.s.msgEl(gg2, 1);
  gd.s.el("chat").appendChild(geA); gd.s.el("chat").appendChild(geB);
  const gEdit = (row) => { const o = {closest: (s) => s === "[data-msg-edit]" ? o : (s === ".st-msg" ? row : null)}; return o; };
  const clickEdit59 = (row) => gd.s.el("chat")._l["click"]({target: gEdit(row)});
  const hasBox = (row) => row.children.some((c) => (c.className || "").includes("msg-edit"));
  const editing = (row) => (row.className || "").split(/\s+/).includes("editing");

  clickEdit59(geA);
  assert.ok(hasBox(geA), "first Edit opens a box on post 1");
  assert.ok(editing(geA), "the editing row is marked (CSS hides its own Edit button)");
  clickEdit59(geA);                                    // same post again -> no-op, no prompt
  assert.strictEqual(gd.confirms.length, 0, "a second Edit on the same post does nothing");
  assert.strictEqual(geA.children.filter((c) => (c.className || "").includes("msg-edit")).length, 1,
                     "still exactly ONE box - the guard stops a second opening on the same post");
  gd.confirmAnswer.yes = false;
  clickEdit59(geB);                                    // different post, refuse the discard
  assert.strictEqual(gd.confirms.length, 1, "switching posts asks to discard the current edit");
  assert.ok(hasBox(geA) && !hasBox(geB), "refusing keeps post 1's box and does not open post 2");
  gd.confirmAnswer.yes = true;
  clickEdit59(geB);                                    // accept the discard
  assert.strictEqual(gd.confirms.length, 2, "it asked again");
  assert.ok(!hasBox(geA) && hasBox(geB), "accepting closed post 1 and opened post 2");
  assert.ok(!editing(geA), "post 1 is no longer marked editing");

  // 60. clicking Edit while a turn is running says so instead of opening a box (todo #edit-posts).
  let release60;
  const bz = run({fetch: async () => ({ok: true, json: async () => ({}), body: {getReader: () => ({
    n: 0,
    read() { if (!this.n++) return Promise.resolve({done: false, value: new TextEncoder()
      .encode("data: " + JSON.stringify({choices: [{delta: {content: "hi"}}]}) + "\n\n")});
      return new Promise((res) => { release60 = () => res({done: true}); }); }})}})}, {});
  await wait();
  bz.s.el("input").value = "go";
  const run60 = bz.s.send();
  await wait();                                        // a turn is now running (busy set)
  const bel60 = bz.s.el("chat").children.find((c) => (c.className || "").includes("st-msg--assistant"));
  bz.s.el("chat")._l["click"]({target: gEdit(bel60)});
  const toastTitles = bz.s.el("toasts").children.map((t) => (t.querySelector(".st-toast__title").textContent || ""));
  assert.ok(toastTitles.some((x) => x.includes("Can't edit yet")), "Edit during a live turn says to stop it first");
  assert.ok(!bel60.children.some((c) => (c.className || "").includes("msg-edit")), "and no edit box opens");
  release60(); await run60;

  // 61. after "Edit entire" drops the tool calls, the tool blocks are gone from the DOM too, not just the model -
  // the bubble is rebuilt in full so no stale block lingers until a reload (todo #edit-posts).
  const lg = run({}, {});
  await wait();
  const lgm = {id: "lg", role: "assistant", text: "HEADTAIL", reasoning: "thought", time: Date.now(),
               tools: [{id: "t1", name: "x", state: "done", at: 4, rat: 0, result: "r", round: 0}]};
  lg.s.messages.push(lgm);
  const lgEl = lg.s.msgEl(lgm, 0); lg.s.el("chat").appendChild(lgEl);
  const lgAct = (a) => { const o = {closest: (s) => s === "[data-chat-act]" ? o : null, getAttribute: () => a}; return o; };
  lg.s.el("chat")._l["click"]({target: gEdit(lgEl)});
  lg.s.chatMenu._l["click"]({target: lgAct("entire")});
  const lgBox = lgEl.children.find((c) => (c.className || "").includes("msg-edit"));
  lgBox.querySelector(".msg-edit__ta").value = "plain now";
  lgBox.querySelector(".msg-edit__bar").children[0].onclick();      // Save
  // close() rebuilds the whole row, so check the row now in the chat (not the detached original)
  const lgFresh = lg.s.el("chat").children.find((c) => +c.dataset.i === 0);
  assert.ok(lgFresh, "the edited row was rebuilt in place");
  assert.ok(!lgFresh.querySelector(".st-bubble").children.some((c) => (c.className || "").includes("tool-call")),
            "no tool block left in the rebuilt bubble after 'Edit entire'");
  done.push("edit-posts: one edit box at a time (discard prompt; same-post re-click is a no-op; button hidden), Edit during a live turn says stop it, and dropped tool blocks leave the DOM");

  // 62. editing a turn that has thinking offers a "Delete the model's thinking" toggle (option B): kept by
  // default, but checked by default for "Edit entire" (which already drops the tool calls).  A user post (no
  // thinking) gets no toggle.
  const th62 = run({}, {});
  await wait();
  const thEdit = (row) => { const o = {closest: (s) => s === "[data-msg-edit]" ? o : (s === ".st-msg" ? row : null)}; return o; };
  const clickEd = (row) => th62.s.el("chat")._l["click"]({target: thEdit(row)});
  const boxIn = (row) => row.children.find((c) => (c.className || "").includes("msg-edit"));
  const cbIn = (row) => boxIn(row).children.find((c) => (c.className || "").includes("msg-edit__think"))._cb;
  const saveIn = (row) => boxIn(row).querySelector(".msg-edit__bar").children[0];

  const am62 = {id: "am62", role: "assistant", text: "the answer", reasoning: "a long thought", time: Date.now()};
  th62.s.messages.push(am62);
  const amEl = th62.s.msgEl(am62, 0); th62.s.el("chat").appendChild(amEl);
  clickEd(amEl);
  assert.ok(boxIn(amEl).children.some((c) => (c.className || "").includes("msg-edit__think")), "a thinking post gets the toggle");
  assert.strictEqual(cbIn(amEl).checked, false, "keeping the thinking is the default");
  saveIn(amEl).onclick();
  assert.strictEqual(am62.reasoning, "a long thought", "Save kept the thinking (toggle off)");
  clickEd(amEl);
  cbIn(amEl).checked = true;
  saveIn(amEl).onclick();
  assert.strictEqual(am62.reasoning, "", "checking the toggle deleted the thinking on Save");
  // "Edit entire" on a tool-call turn defaults the toggle to delete
  const tm62 = {id: "tm62", role: "assistant", text: "HEADTAIL", reasoning: "thought", time: Date.now(),
                tools: [{id: "t", name: "x", state: "done", at: 4, rat: 0, result: "r", round: 0}]};
  th62.s.messages.push(tm62);
  const tmEl = th62.s.msgEl(tm62, 1); th62.s.el("chat").appendChild(tmEl);
  clickEd(tmEl);
  const act62 = (a) => { const o = {closest: (s) => s === "[data-chat-act]" ? o : null, getAttribute: () => a}; return o; };
  th62.s.chatMenu._l["click"]({target: act62("entire")});
  assert.strictEqual(cbIn(tmEl).checked, true, "'Edit entire' defaults the thinking toggle to delete");
  // a user post (no thinking) gets no toggle
  const um62 = {id: "um62", role: "user", text: "q", time: Date.now()};
  th62.s.messages.push(um62);
  const umEl = th62.s.msgEl(um62, 2); th62.s.el("chat").appendChild(umEl);
  clickEd(umEl);
  assert.ok(!boxIn(umEl).children.some((c) => (c.className || "").includes("msg-edit__think")), "a user post has no thinking toggle");
  done.push("edit-posts option B: editing a thinking turn offers 'Delete the model's thinking' (keep by default; delete by default for 'Edit entire'); user posts have none");

  // 63. editing a user post can remove its attachments (todo #edit-posts): the box lists the post's images and
  // files as removable chips, plus an Attach button; removing one and saving updates the post.  (Adding through
  // the file picker is browser-only - it needs FileReader - but it is the same addFiles path the composer uses.)
  const at = run({}, {});
  await wait();
  const am63 = {id: "at1", role: "user", text: "look", time: Date.now(),
                images: [{name: "pic.png", url: "data:image/png;base64,AAA"}],
                files: [{name: "note.txt", text: "hi"}]};
  at.s.messages.push(am63);
  const atEl = at.s.msgEl(am63, 0); at.s.el("chat").appendChild(atEl);
  const atEdit = (row) => { const o = {closest: (s) => s === "[data-msg-edit]" ? o : (s === ".st-msg" ? row : null)}; return o; };
  at.s.el("chat")._l["click"]({target: atEdit(atEl)});
  const atBox = atEl.children.find((c) => (c.className || "").includes("msg-edit"));
  const attachBox = atBox.children.find((c) => (c.className || "").includes("attachments"));
  assert.ok(atBox.children.some((c) => (c.className || "").includes("msg-edit__attach")), "the box has an Attach button");
  assert.strictEqual(attachBox.children.length, 2, "the box lists the post's two attachments as chips");
  assert.ok(attachBox.children[0].children.some((c) => (c.className || "").includes("chip__thumb")), "an image chip shows a thumbnail");
  attachBox.children[0].children.find((c) => (c.className || "").includes("st-btn")).onclick();   // remove the first chip
  assert.strictEqual(attachBox.children.length, 1, "removing a chip drops it");
  atBox.querySelector(".msg-edit__bar").children[0].onclick();   // Save (user box: Save, Submit, Cancel)
  assert.strictEqual(am63.images.length + am63.files.length, 1, "Save wrote back one attachment");
  assert.strictEqual(am63.files.length, 1, "the removed image is gone, the file remains");
  assert.strictEqual(am63.files[0].name, "note.txt", "the surviving attachment is note.txt");
  done.push("edit-posts: editing a user post lists its attachments as removable chips + an Attach button; removing one and saving updates the post");

  // 64. clicking an attachment opens a viewer (todo #edit-posts): a text file shows its contents, an image
  // enlarges.  Escape or clicking the backdrop closes it.
  const vw = run({}, {});
  await wait();
  const vm = {id: "vw1", role: "user", text: "q", time: Date.now(),
              images: [{name: "pic.png", url: "data:image/png;base64,aGVsbG8="}],
              files: [{name: "note.txt", text: "the file contents"}]};
  vw.s.messages.push(vm);
  const vmEl = vw.s.msgEl(vm, 0); vw.s.el("chat").appendChild(vmEl);
  const wraps = vmEl.children.filter((c) => (c.className || "").includes("msg-images"));   // files wrap then images wrap
  wraps[0].children[0].onclick();                                                          // click the file chip
  assert.ok(vw.s.viewerEl, "clicking a file chip opens the viewer");
  assert.strictEqual(vw.s.viewerEl.children[0].querySelector(".att-viewer__text").textContent, "the file contents",
                     "the viewer shows the text file's contents");
  vw.fireDoc("keydown", {key: "Escape"});
  assert.strictEqual(vw.s.viewerEl, null, "Escape closes the viewer");
  wraps[1].children[0].onclick();                                                          // click the image thumbnail -> in-page viewer
  assert.ok(vw.s.viewerEl, "clicking an image opens the in-page viewer, like a text file");
  const vimg = vw.s.viewerEl.children[0].querySelector(".att-viewer__img");
  assert.ok(vimg, "the viewer shows the enlarged image");
  assert.strictEqual(vw.opened.length, 0, "opening the viewer does not open a tab yet");
  vimg.onclick();                                                                          // click the enlarged image -> new tab
  assert.strictEqual(vw.opened.length, 1, "clicking the image in the viewer opened one tab");
  assert.ok(vw.opened[0].startsWith("blob:"), "it opens via a blob: URL (data: URLs are blocked for top-level navigation)");
  done.push("edit-posts: image thumbnail opens the in-page viewer; clicking the image in the viewer opens a new tab via a blob: URL");

  // 65. switching chats while an edit box is open prompts to discard it, so the edit is not silently lost
  // (todo #edit-posts).
  const sw65 = run({}, {"strata.history": "true", "strata.chatId": JSON.stringify("A")},
                   {A: {id: "A", title: "chat A", time: Date.now(), messages: [msg("ask A")]},
                    B: {id: "B", title: "chat B", time: Date.now() - 1000, messages: [msg("ask B")]}});
  await wait();
  const editT65 = (row) => { const o = {closest: (s) => s === "[data-msg-edit]" ? o : (s === ".st-msg" ? row : null)}; return o; };
  const userRow65 = () => sw65.s.el("chat").children.find((c) => (c.className || "").includes("st-msg--user"));
  sw65.s.el("chat")._l["click"]({target: editT65(userRow65())});     // open Edit on chat A's message
  assert.ok(userRow65().children.some((c) => (c.className || "").includes("msg-edit")), "an edit box is open");
  sw65.confirmAnswer.yes = false;
  sw65.s.openChat("B");                                             // try to switch away
  assert.strictEqual(sw65.confirms.length, 1, "switching while editing asks to discard");
  assert.strictEqual(sw65.s.chatId, "A", "refusing keeps you in chat A");
  assert.ok(userRow65().children.some((c) => (c.className || "").includes("msg-edit")), "and the edit box stays open");
  sw65.confirmAnswer.yes = true;
  sw65.s.openChat("B");                                             // switch, accepting the discard
  assert.strictEqual(sw65.s.chatId, "B", "accepting switches to chat B");
  done.push("edit-posts: switching chats while editing prompts to discard; refusing keeps the chat and the open edit box");

  // 66. a streaming message's meta updates live (estimated tokens/context) and its Edit button is hidden until
  // the turn ends (todo #edit-posts).
  const ctl66 = {step: null, flush: null}, q66 = [];
  const read66 = () => new Promise((res) => { ctl66.step = () => { if (ctl66.flush) ctl66.flush(); res(q66.length ? {done: false, value: new TextEncoder().encode(q66.shift())} : {done: true}); }; });
  const lm66 = run({fetch: async (u) => {
    if (u === "health") return {ok: true, json: async () => ({status: "ok", model: "strata", max_context: 8192, images: false, loaded: true})};
    if (String(u).startsWith("v1/chat/completions")) return {ok: true, body: {getReader: () => ({read: read66})}};
    return {ok: true, json: async () => ({}), text: async () => ""};
  }}, {});
  await wait(); ctl66.flush = lm66.flush;
  lm66.s.el("input").value = "go";
  const f66 = (o) => "data: " + JSON.stringify(o) + "\n\n";
  q66.push(f66({choices: [{delta: {content: "hello there this is a longer answer"}}]}),
         f66({choices: [{}], usage: {prompt_tokens: 100, completion_tokens: 12, total_tokens: 112, prompt_tokens_details: {cached_tokens: 50}}}));
  const run66 = lm66.s.send();
  await wait();
  const row66a = lm66.s.el("chat").children.find((c) => (c.className || "").includes("st-msg--assistant"));
  assert.strictEqual(row66a.querySelector(".meta-text").textContent, "", "no stats before thinking/output starts");
  ctl66.step(); await wait(); lm66.flush();            // the content frame paints (live meta)
  const row66 = lm66.s.el("chat").children.find((c) => (c.className || "").includes("st-msg--assistant"));
  assert.ok((row66.className || "").includes("streaming"), "the streaming row is marked (its Edit button is hidden by CSS)");
  const meta66 = row66.querySelector(".meta-text").textContent;
  assert.ok(meta66.includes("tokens") && meta66.includes("– context"),
            "tokens show once output starts; context is '-' until the poll reports the prompt: " + meta66);
  ctl66.step(); await wait(); lm66.flush();            // the usage frame
  ctl66.step(); await wait();                        // end of stream
  await run66;
  const row66b = lm66.s.el("chat").children.find((c) => (c.className || "").includes("st-msg--assistant"));
  assert.ok(!(row66b.className || "").includes("streaming"), "the streaming class is gone when the turn ends (Edit button back)");
  assert.ok((row66b.querySelector(".meta-text").textContent || "").includes("12 tokens"), "the exact final meta replaces the estimate");

  // 67. deleting a chat asks first (todo #edit-posts): refuse keeps it, accept deletes it.
  const dc = run({}, {"strata.history": "true", "strata.chatId": JSON.stringify("A")},
                 {A: {id: "A", title: "chat A", time: Date.now(), messages: [msg("a")]},
                  B: {id: "B", title: "chat B", time: Date.now() - 1000, messages: [msg("b")]}});
  await wait();
  dc.confirmAnswer.yes = false;
  dc.s.deleteChat(dc.s.chats.find((c) => c.id === "B"));
  assert.strictEqual(dc.confirms.length, 1, "delete asks first");
  assert.ok(dc.s.chats.some((c) => c.id === "B") && "B" in dc.records, "refusing keeps the chat and its record");
  dc.confirmAnswer.yes = true;
  dc.s.deleteChat(dc.s.chats.find((c) => c.id === "B"));
  assert.ok(!dc.s.chats.some((c) => c.id === "B"), "accepting deletes it");
  done.push("edit-posts: streaming meta updates live (tokens/context) with the Edit button hidden until done; deleting a chat asks first");

  // 68. deleting a post (todo #edit-posts): a modal with a "delete all below" checkbox (default on).  Delete-below
  // truncates at that message; delete-one removes just that message; Cancel does nothing.
  const delT68 = (row) => { const o = {closest: (s) => s === "[data-msg-delete]" ? o : (s === ".st-msg" ? row : null)}; return o; };
  const seed3 = () => [{id: "a", role: "user", text: "first", time: Date.now()},
                       {id: "b", role: "assistant", text: "answer", reasoning: "", time: Date.now()},
                       {id: "c", role: "user", text: "second", time: Date.now()}];
  const rowWith = (s, i) => s.el("chat").children.find((c) => +c.dataset.i === i);

  const dA = run({}, {}); await wait();
  const s3 = seed3(); dA.s.messages.push(...s3);
  dA.s.el("chat").appendChild(dA.s.msgEl(s3[0], 0)); dA.s.el("chat").appendChild(dA.s.msgEl(s3[1], 1)); dA.s.el("chat").appendChild(dA.s.msgEl(s3[2], 2));
  dA.s.el("chat")._l["click"]({target: delT68(rowWith(dA.s, 1))});                 // Delete on the assistant (index 1)
  assert.ok(dA.s.modalEl, "Delete opens a modal");
  const panelA = dA.s.modalEl.children[0];
  assert.strictEqual(panelA.children.find((c) => (c.className || "").includes("msg-del__below"))._cb.checked, true, "'delete all below' is on by default");
  panelA.querySelector(".msg-edit__bar").children[1].onclick();                    // Delete (bar: Cancel, Delete)
  assert.strictEqual(dA.s.messages.length, 1, "delete-below truncated at the message (removed it and everything after)");
  assert.strictEqual(dA.s.messages[0].id, "a", "the message before it remains");

  const dB = run({}, {}); await wait();
  const s3b = seed3(); dB.s.messages.push(...s3b);
  dB.s.el("chat").appendChild(dB.s.msgEl(s3b[0], 0)); dB.s.el("chat").appendChild(dB.s.msgEl(s3b[1], 1)); dB.s.el("chat").appendChild(dB.s.msgEl(s3b[2], 2));
  dB.s.el("chat")._l["click"]({target: delT68(rowWith(dB.s, 1))});
  const panelB = dB.s.modalEl.children[0];
  panelB.children.find((c) => (c.className || "").includes("msg-del__below"))._cb.checked = false;   // delete just this one
  panelB.querySelector(".msg-edit__bar").children[1].onclick();                    // Delete
  assert.strictEqual(dB.s.messages.length, 2, "delete-one removed only that message");
  assert.deepStrictEqual(dB.s.messages.map((m) => m.id), ["a", "c"], "the neighbours remain");

  const dC = run({}, {}); await wait();
  const s3c = seed3(); dC.s.messages.push(...s3c);
  dC.s.el("chat").appendChild(dC.s.msgEl(s3c[0], 0));
  dC.s.el("chat")._l["click"]({target: delT68(rowWith(dC.s, 0))});
  dC.s.modalEl.children[0].querySelector(".msg-edit__bar").children[0].onclick();  // Cancel
  assert.strictEqual(dC.s.messages.length, 3, "Cancel deletes nothing");
  assert.strictEqual(dC.s.modalEl, null, "and closes the modal");
  done.push("edit-posts: Delete-a-post modal - 'delete all below' (default) truncates, delete-one removes just that message, Cancel does nothing");

  // 69. the poll holds the live prompt/generated figures across the null gaps between MCP rounds, so a message's
  // context does not collapse to 0 between rounds (todo #edit-posts).
  let pollN69 = 0;
  const hold = run({fetch: async (u) => {
    if (String(u).startsWith("metrics")) { pollN69++;
      return {ok: true, json: async () => pollN69 === 1 ? {live: {state: "generating", prompt_tokens: 5000, generated: 10}}
                                                        : {live: {state: "idle", prompt_tokens: null, generated: null}}}; }
    return {ok: true, json: async () => ({}), text: async () => ""};
  }}, {});
  await wait();
  await hold.s.poll();
  assert.strictEqual(hold.s.lastLive.prompt_tokens, 5000, "the first poll records the prompt size");
  hold.timers.filter((t) => t.f).pop().f();          // the poll re-armed itself; run the (null) second poll
  await wait();
  assert.strictEqual(hold.s.lastLive.prompt_tokens, 5000, "a null round keeps the last known prompt (no collapse to 0)");
  assert.strictEqual(hold.s.lastLive.generated, 10, "and the last known generated count");

  // 70. stopping a turn keeps the token count, not just "Stopped" (todo #edit-posts).
  const st = run({fetch: async (u) => {
    if (u === "health") return {ok: true, json: async () => ({status: "ok", model: "strata", max_context: 8192, images: false, loaded: true})};
    if (String(u).startsWith("v1/chat/completions")) return {ok: true, body: {getReader: () => ({n: 0, read() {
      if (this.n === 0) { this.n++; return Promise.resolve({done: false, value: new TextEncoder().encode("data: " + JSON.stringify({choices: [{delta: {content: "partial answer"}}]}) + "\n\n")}); }
      const e = new Error("aborted"); e.name = "AbortError"; return Promise.reject(e);   // simulate a stop mid-turn
    }})}};
    return {ok: true, json: async () => ({}), text: async () => ""};
  }}, {});
  await wait();
  st.s.el("input").value = "go";
  const run70 = st.s.send();
  await run70;
  const msg70 = st.s.messages[1];
  assert.ok(msg70.stopped, "the turn is marked stopped");
  assert.ok((msg70.meta || "").includes("Stopped") && (msg70.meta || "").includes("tokens"),
            "the stopped meta keeps the token count, not just 'Stopped': " + msg70.meta);
  done.push("edit-posts: the poll holds live figures across the null gaps between rounds; stopping a turn keeps the token count");

  // 71. the live token count ACCUMULATES across MCP rounds - the poll's `generated` resets each round, so
  // noteLive must add the growth, not read the current round (this was the "back to 0 tokens" bug).
  let mN71 = 0;
  const acc = run({fetch: async (u) => {
    if (u === "health") return {ok: true, json: async () => ({status: "ok", model: "strata", max_context: 8192, images: false, loaded: true})};
    if (String(u).startsWith("metrics")) { mN71++; const gen = [10, 15, 3][mN71 - 1];
      return {ok: true, json: async () => ({live: {state: "generating", prompt_tokens: 5000, generated: gen}})}; }
    if (String(u).startsWith("v1/chat/completions")) return {ok: true, body: {getReader: () => ({n: 0, read() {
      if (!this.n++) return Promise.resolve({done: false, value: new TextEncoder().encode("data: " + JSON.stringify({choices: [{delta: {content: "x"}}]}) + "\n\n")});
      return new Promise(() => {});   // stay open: the turn is still running
    }})}};
    return {ok: true, json: async () => ({}), text: async () => ""};
  }}, {});
  await wait();
  acc.s.el("input").value = "go";
  acc.s.send();                       // start a turn (busy set); the stream stays open
  await wait();
  await acc.s.poll();                 // round 1 grew to 10
  assert.strictEqual(acc.s.busy.msg._gen, 10, "round 1: 10 tokens");
  await acc.s.poll();                 // same round grew to 15
  assert.strictEqual(acc.s.busy.msg._gen, 15, "same round grew to 15");
  await acc.s.poll();                 // NEW round: generated reset to 3 -> accumulate, not reset
  assert.strictEqual(acc.s.busy.msg._gen, 18, "a new round accumulates (15 + 3), it does not drop to 3 or 0");
  done.push("edit-posts: the live token count accumulates across MCP rounds (does not reset when a new round starts)");

  // 72. thinking renders as markdown once settled (escaped first, safe), and the thinking block's own md toggle
  // switches it back to plain text (todo #thinking-markdown).
  const thk = run({}, {});
  await wait();
  thk.s.setSettings({show: "always"});                          // open the thinking block so its body renders
  const thkMsg = {id: "tm", role: "assistant", text: "answer", reasoning: "**bold** and `code` thought", time: Date.now()};
  thk.s.messages.push(thkMsg);
  const tel72 = thk.s.msgEl(thkMsg, 0); thk.s.el("chat").appendChild(tel72);
  const thinkEl = () => tel72.querySelector(".st-bubble")._blocks[0].el;
  assert.ok((thinkEl().querySelector(".thinking")._html || "").includes("<strong>bold</strong>"), "settled thinking renders markdown");
  assert.ok((thinkEl().querySelector(".thinking")._html || "").includes('<code class="inline">code</code>'), "and inline code");
  assert.ok(!(thinkEl()._html || "").includes("data-think-md"), "no separate per-thinking-block md button");
  // the message's single md control (the meta-row button) switches thinking (and the answer) to plain
  const mdb72 = tel72.querySelector("[data-md-toggle]");
  thk.s.el("chat")._l["click"]({target: {closest: (s) => s === "[data-md-toggle]" ? mdb72 : (s === ".st-msg" ? tel72 : null)}});
  assert.strictEqual(thkMsg.md, false, "the message's md button turned markdown off");
  assert.strictEqual(thinkEl().querySelector(".thinking").textContent, "**bold** and `code` thought", "thinking falls back to plain text");
  done.push("thinking-markdown: thinking follows the message's single md control; no per-block button; the md button is hidden until content appears");

  // 73. user messages get a copy button too (todo): clicking it copies the post's own text.
  const cp73 = run({}, {});
  await wait();
  const um73 = {id: "u73", role: "user", text: "my question here", time: Date.now()};
  cp73.s.messages.push(um73);
  const uel73 = cp73.s.msgEl(um73, 0); cp73.s.el("chat").appendChild(uel73);
  const meta73 = uel73.children.find((c) => (c.className || "").includes("st-msg__meta"));
  assert.ok((meta73._html || "").includes("data-msg-copy"), "the user meta row carries a copy button");
  const copyEl73 = uel73.querySelector("[data-msg-copy]");
  assert.ok(copyEl73, "a user message has a copy button");
  assert.notStrictEqual(copyEl73.hidden, true, "and it is shown");
  cp73.s.el("chat")._l["click"]({target: {closest: (s) => s === "[data-msg-copy]" ? copyEl73 : (s === ".st-msg" ? uel73 : null)}});
  assert.ok(cp73.copied.includes("my question here"), "clicking it copies the user's text");
  done.push("copy: user messages get a copy button that copies their text");

  // 74. the chat picker: all checked by default; a filter narrows what's VISIBLE; All/None act on the visible
  // rows; the action applies to every CHECKED chat even if the current filter hides it (todo #import-export).
  const pk = run({}, {"strata.history": "true", "strata.chatId": JSON.stringify("a")},
                 {a: {id: "a", title: "apple", time: Date.now() - 3 * 86400000, messages: [msg("a")]},
                  b: {id: "b", title: "banana", time: Date.now() - 2 * 86400000, messages: [msg("b")]},
                  c: {id: "c", title: "cherry", time: Date.now() - 1 * 86400000, messages: [msg("c")]}});
  await wait();
  let ranSel = null;
  pk.s.openChatPicker({verb: "Export", list: pk.s.chats, onBack: () => {}, onRun: (sel) => { ranSel = sel.map((x) => x.id); }});
  const picker = pk.s.settingsModal;
  assert.ok(picker, "the picker opens");
  const panel74 = picker.children[0];
  const rows74 = () => panel74.querySelector(".chat-picker__list").children;
  assert.ok(panel74.children[0].children.some((c) => (c.className || "").includes("chat-picker__back")), "the picker has a back button (given onBack)");
  const ctrls74 = panel74.querySelector(".chat-picker__controls").children;   // [filter, from, to, row2(All,None)]
  assert.strictEqual(rows74().length, 3, "all three chats listed, checked by default");
  ctrls74[0].value = "an"; ctrls74[0]._l["input"]();                          // filter -> "banana" matches "an"
  assert.strictEqual(rows74().length, 1, "the filter narrows to the visible match");
  ctrls74[3].children[1].onclick();                                           // None (row2 = [All, None]) on the visible row
  ctrls74[0].value = ""; ctrls74[0]._l["input"]();                            // clear the filter
  assert.strictEqual(rows74().length, 3, "filter cleared, all visible again");
  panel74.querySelector(".msg-edit__bar").children[1].onclick();             // the action (Export)
  assert.deepStrictEqual((ranSel || []).slice().sort(), ["a", "c"], "the action covers every checked chat, including ones the filter had hidden");

  // 75. the JSONL is llama.cpp-readable (OpenAI `messages`) AND round-trips Strata's extras (thinking, tool rounds).
  const rt = run({}, {});
  await wait();
  const rtChat = {id: "rt", title: "Trip", time: 1000, messages: [
    {id: "m1", role: "user", text: "go", time: 1000},
    {id: "m2", role: "assistant", text: "done", reasoning: "thinking here", time: 1001,
     tools: [{id: "t1", name: "x", state: "done", at: 4, rat: 8, result: "r", round: 0}]}]};
  const line75 = rt.s.chatToJsonl(rtChat);
  assert.strictEqual(JSON.parse(line75).messages[0].role, "user", "OpenAI-shaped messages present for llama.cpp");
  const parsed75 = rt.s.parseChatsJsonl(line75);
  assert.strictEqual(parsed75.length, 1, "one chat parsed");
  assert.strictEqual(parsed75[0].title, "Trip", "title kept");
  assert.strictEqual(parsed75[0].messages[1].reasoning, "thinking here", "thinking round-trips");
  assert.strictEqual(parsed75[0].messages[1].tools[0].at, 4, "tool round at/rat round-trips");
  done.push("import-export: the picker defaults to all-checked, All/None act on visible rows, the action covers all checked even if filtered out; JSONL is llama.cpp-readable and round-trips Strata extras");

  // 76. "Delete only attachments" strips images/files from the chosen chats but keeps the chats (todo #import-export).
  const da = run({}, {"strata.history": "true", "strata.chatId": JSON.stringify("a")},
                 {a: {id: "a", title: "with att", time: Date.now(),
                      messages: [{id: "m", role: "user", text: "look", time: Date.now(),
                                  images: [{name: "p.png", url: "data:image/png;base64,AAA"}], files: [{name: "n.txt", text: "hi"}]}]}});
  await wait();
  const daChat = da.s.chats.find((c) => c.id === "a");
  da.confirmAnswer.yes = true;
  da.s.deleteAttachmentsOnly([daChat]);
  assert.strictEqual(daChat.messages[0].images.length, 0, "images removed");
  assert.strictEqual(daChat.messages[0].files.length, 0, "files removed");
  assert.strictEqual(daChat.messages[0].text, "look", "the chat and its text are kept");

  // 77. the global attachments toggle off blocks adding attachments (todo #import-export).
  const at77 = run({}, {});
  await wait();
  at77.s.setSettings({attachments: false});
  at77.s.addFiles([{type: "text/plain", name: "a.txt", size: 4}]);   // would try FileReader if enabled
  assert.strictEqual(at77.s.attachments.length, 0, "attachments off -> addFiles does nothing");
  done.push("import-export: delete-only-attachments strips images/files but keeps the chats; the attachments toggle gates addFiles");

  // 78. the Delete picker's "delete only attachments" toggle routes the action (keep chats vs delete them), and
  // the picker passes its toggle state to the action (todo #import-export).
  const dt = run({}, {"strata.history": "true", "strata.chatId": JSON.stringify("a")},
                 {a: {id: "a", title: "keep", time: Date.now(),
                      messages: [{id: "m", role: "user", text: "hi", time: Date.now(), images: [{name: "p.png", url: "data:image/png;base64,AAA"}]}]}});
  await wait();
  let togSeen = null;
  dt.confirmAnswer.yes = true;
  dt.s.openChatPicker({verb: "Delete", danger: true, list: dt.s.chats, toggles: [{id: "attOnly", def: false}],
    onRun: (sel, t) => { togSeen = t.get("attOnly"); if (t.get("attOnly")) dt.s.deleteAttachmentsOnly(sel); }});
  const panel78 = dt.s.settingsModal.children[0];
  const togSw = panel78.querySelector(".chat-picker__toggles").children[0].children[1];   // the switch in the toggle row
  togSw.onclick();                                                                        // turn "delete only attachments" on
  panel78.querySelector(".msg-edit__bar").children[1].onclick();                          // the Delete action
  assert.strictEqual(togSeen, true, "the picker passed the toggle state to the action");
  assert.ok(dt.s.chats.some((c) => c.id === "a"), "toggle on -> the chat is kept");
  assert.strictEqual(dt.s.chats.find((c) => c.id === "a").messages[0].images.length, 0, "toggle on -> attachments stripped");
  done.push("import-export: the Delete picker's toggle routes to delete-attachments vs delete-chats and passes its state to the action");

  // 79. the NEW llama.cpp export (per-conversation JSONL: a session header + a message tree with toolCalls /
  // toolCallId / reasoningContent) imports into a coherent chat, not a blank New Chat.
  const lj = run({}, {});
  await wait();
  const ljText = [
    JSON.stringify({type: "session", id: "c1", name: "Civil War", lastModified: 123, currNode: "a2"}),
    JSON.stringify({type: "message", message: {id: "r", role: "system", content: "", parent: null, children: ["s"]}}),
    JSON.stringify({type: "message", message: {id: "s", role: "system", content: "sys prompt", parent: "r", children: ["u"]}}),
    JSON.stringify({type: "message", message: {id: "u", role: "user", content: "Q?", parent: "s", children: ["a1"]}}),
    JSON.stringify({type: "message", message: {id: "a1", role: "assistant", content: "", reasoningContent: "let me look", parent: "u", children: ["t1"], toolCalls: [{id: "call1", type: "function", function: {name: "fs_read", arguments: "{\"path\":\"x\"}"}}]}}),
    JSON.stringify({type: "message", message: {id: "t1", role: "tool", content: "the file", toolCallId: "call1", parent: "a1", children: ["a2"]}}),
    JSON.stringify({type: "message", message: {id: "a2", role: "assistant", content: "Final answer", parent: "t1", children: []}}),
  ].join("\n");
  const ljParsed = lj.s.parseLlamaJsonl(ljText);
  assert.strictEqual(ljParsed.length, 1, "one conversation parsed");
  assert.strictEqual(ljParsed[0].title, "Civil War", "session name used as the title");
  const roles = ljParsed[0].messages.map((m) => m.role);
  assert.deepStrictEqual(roles, ["user", "assistant"], "system/root messages dropped, user then assistant");
  const a = ljParsed[0].messages[1];
  assert.strictEqual(a.reasoning, "let me look", "reasoningContent becomes thinking");
  assert.strictEqual(a.text, "Final answer", "the assistant text is kept");
  assert.strictEqual(a.tools.length, 1, "the tool call is rebuilt");
  assert.strictEqual(a.tools[0].name, "fs_read", "tool name");
  assert.strictEqual(a.tools[0].result, "the file", "the tool result is matched by toolCallId");
  assert.ok(a.tools[0].at >= 0 && a.tools[0].rat >= 0, "at/rat offsets set for correct replay");

  // 80. a zip of JSONL (the new llama.cpp export) is read back entry by entry.
  const zr = run({}, {});
  await wait();
  const enc = new TextEncoder();
  const zraw = enc.encode(ljText);
  const nm = enc.encode("a.jsonl");
  const lh = new Uint8Array(30 + nm.length); const ldv = new DataView(lh.buffer);
  ldv.setUint32(0, 0x04034b50, true); ldv.setUint16(4, 20, true); ldv.setUint16(8, 0, true);   // stored (method 0)
  ldv.setUint32(18, zraw.length, true); ldv.setUint32(22, zraw.length, true); ldv.setUint16(26, nm.length, true);
  lh.set(nm, 30);
  const cd = new Uint8Array(46 + nm.length); const cdv = new DataView(cd.buffer);
  cdv.setUint32(0, 0x02014b50, true); cdv.setUint16(4, 20, true); cdv.setUint16(6, 20, true); cdv.setUint16(10, 0, true);
  cdv.setUint32(20, zraw.length, true); cdv.setUint32(24, zraw.length, true); cdv.setUint16(28, nm.length, true);
  cdv.setUint32(42, 0, true); cd.set(nm, 46);
  const eocd = new Uint8Array(22); const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true); edv.setUint16(8, 1, true); edv.setUint16(10, 1, true);
  edv.setUint32(12, zraw.length, true); edv.setUint32(16, 30 + nm.length + zraw.length, true);
  const zipBuf = new Uint8Array(lh.length + zraw.length + cd.length + eocd.length); let p = 0;
  for (const part of [lh, zraw, cd, eocd]) { zipBuf.set(part, p); p += part.length; }
  const entries = await zr.s.unzipEntries(zipBuf.buffer);
  assert.strictEqual(entries.length, 1, "one entry unzipped");
  assert.strictEqual(entries[0].name, "a.jsonl", "entry name");
  const zp = zr.s.parseLlamaJsonl(entries[0].text);
  assert.strictEqual(zp.length, 1, "the zipped JSONL parses to one chat");
  done.push("import-export: the new llama.cpp JSONL (session + message tree, tools + reasoning) and a zip of JSONL both import correctly");

  console.log(done.map((d) => "ok - " + d).join("\n"));
})();
