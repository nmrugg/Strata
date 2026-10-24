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
    addEventListener(t, f) { (this._l = this._l || {})[t] = f; },
    appendChild(c) { this.children.push(c); c._parent = this; return c; },
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
        data[value.id] = value; req.result = value; req.onsuccess && req.onsuccess();
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
        req.result = Object.values(data); req.onsuccess && req.onsuccess();
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
                    createElement: () => makeEl(), documentElement: {dataset: {}},
                    addEventListener() {}, querySelectorAll: () => []};
  const idb = makeIdb(hooks, seed);
  // window listeners are recorded so a test can ask "is anything holding the page open right now, and what
  // does it do to the event" - the page's own leave warning is added and removed with the busy flag
  const win = {_l: {}, addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); },
               removeEventListener(t, f) { this._l[t] = (this._l[t] || []).filter((g) => g !== f); }};
  const confirms = [], confirmAnswer = {yes: true}, copied = [];   // the page asks confirm() twice now: the tool-thinking
  const env = {                                        // guard and the discard guard - record and answer both
    document, localStorage: {getItem: (k) => (k in stored ? stored[k] : null), setItem: (k, v) => { stored[k] = v; }},
    indexedDB: idb, location: {hash: "", pathname: "/", origin: "http://127.0.0.1"},
    history: {replaceState() {}}, matchMedia: () => ({matches: false, addEventListener() {}}),
    fetch: hooks.fetch || (async () => ({ok: true, json: async () => ({}), text: async () => ""})),
    confirm: (m) => { confirms.push(m); return confirmAnswer.yes; },
    setTimeout: () => 0, clearTimeout: () => 0, requestAnimationFrame: () => 0,
    navigator: {clipboard: {writeText: async (t) => { copied.push(t); }}},   // what the page put on the clipboard
    innerWidth: 1200, innerHeight: 800, window: win, queueMicrotask,
  };
  const names = Object.keys(env);
  const source = fs.readFileSync(path.join(__dirname, "web", "app.js"), "utf8") +
    "\nreturn {get historyOn() { return historyOn; }, get chats() { return chats; }, get chat() { return chat; }, " +
    "get messages() { return messages; }, get db() { return db; }, chatTitle, setHistory, startChat, openChat, " +
    "deleteChat, renameChat, saveChat, renderSidebar, setBusy, send, msgEl, updateAssistant, renderBubble, toolHtml, " +
    "bubbleParts, toolSync, toolOpen, apiMessages, assistantMessages, turnMarkdown, safeFileName, " +
    "get busy() { return busy; }, get chatId() { return chatId; }, " +
    "get settings() { return settings; }, setSettings: (s) => { settings = {...DEFAULTS, ...s}; }, get DEFAULTS() { return DEFAULTS; }, " +
    "openDrawer, closeDrawer, drawerSettings, drawerDirty, get sharedOn() { return sharedOn; }, " +
    "setQuery: (v) => { sidebarQuery = v; renderSidebar(); }, el: document.getElementById, row: (cls) => document.getElementById(\"sidebar-list\").children.find((c) => c.className.includes(cls))};";
  return {s: new Function(...names, source)(...names.map((n) => env[n])), stored, records: idb.records, calls: idb.calls, win, confirms, confirmAnswer, copied};
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
  again.s.saveChat();
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
  assert.deepStrictEqual(pic.records[pic.s.chat.id].messages[0].images, [{name: "photo.png"}],
                         "no data URL in the record");
  done.push("pictures: names only");

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

  // 14. the day groups
  const day = 86400000;
  const grouped = run({}, {"strata.history": "true"}, {
    today: {id: "today", title: "today", time: Date.now(), messages: [msg("a")]},
    yesterday: {id: "yesterday", title: "yesterday", time: Date.now() - 1.5 * day, messages: [msg("b")]},
    week: {id: "week", title: "week", time: Date.now() - 5 * day, messages: [msg("c")]},
    older: {id: "older", title: "older", time: Date.now() - 40 * day, messages: [msg("d")]}});
  await wait();
  assert.deepStrictEqual(groups(grouped.s), ["Today", "Yesterday", "Previous 7 days", "Older"], "the day groups");

  // the group names come out newest first, and a chat inside seven days is in the same group
  grouped.s.chats[0].time = Date.now() - 2 * day;
  grouped.s.renderSidebar();
  assert.deepStrictEqual(groups(grouped.s), ["Yesterday", "Previous 7 days", "Older"], "the group follows the chat");
  done.push("day groups: Today, Yesterday, Previous 7 days, Older");

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

  // 22. "Keep thinking open" (todo #3): the setting drives the details' open attribute - for a finished answer,
  // for one still streaming, and for a chat re-rendered later (renderChat builds each message with msgEl) - and
  // a block the user opened or closed themselves is still left alone.
  const th = run({}, {});
  await wait();
  const thinkMsg = (m) => th.s.msgEl(m, 0);      // msgEl renders an assistant message exactly as renderChat does
  const detOf = (el, n = 0) => el.querySelector(".st-bubble")._blocks[n].el;   // thinking is a part of the bubble now
  assert.strictEqual(th.s.settings.openthink, false, "off is the default");
  let done1 = thinkMsg({role: "assistant", text: "the answer", reasoning: "why it answered", time: Date.now()});
  assert.notStrictEqual(detOf(done1).open, true, "off: the thinking of a finished answer stays closed");
  th.s.setSettings({openthink: true});
  done1 = thinkMsg({role: "assistant", text: "the answer", reasoning: "why it answered", time: Date.now()});
  assert.strictEqual(detOf(done1).open, true, "on: it is open, answer already written");
  assert.strictEqual(detOf(done1).querySelector(".thinking").textContent, "why it answered", "and its text is filled in");
  const live = {role: "assistant", text: "", reasoning: "still going", time: Date.now()};
  const liveEl = th.s.msgEl(live, 0);
  th.s.updateAssistant(liveEl, live, true);
  assert.strictEqual(detOf(liveEl).open, true, "on: open while it streams too");
  detOf(liveEl).dataset.touched = "1";                     // the user clicked the block itself
  detOf(liveEl).open = false;
  th.s.updateAssistant(liveEl, live, true);
  assert.strictEqual(detOf(liveEl).open, false, "the page does not fight a click the user made");
  // with the switch off, the two existing rules are untouched: "Show thinking" opens it while it streams and
  // closes it when the answer starts
  const showOff = run({}, {});
  await wait();
  const showMsg = {role: "assistant", text: "", reasoning: "still going", time: Date.now()};
  const showEl = showOff.s.msgEl(showMsg, 0);
  showOff.s.updateAssistant(showEl, showMsg, true);
  assert.strictEqual(detOf(showEl).open, true, "show: true opens it while it streams, as before");
  showOff.s.updateAssistant(showEl, {...showMsg, text: "the answer"}, false);
  assert.strictEqual(detOf(showEl).open, false, "and closes it when the answer starts, as before");
  done.push("thinking: 'keep thinking open' drives the open attribute; off by default; a user click wins");

  // 23. "Keep tool calls open" (todo #4): a tool block nobody has clicked follows the switch; once one is
  // clicked, that choice wins in both directions.  The body (arguments, the result as the model read it) is only
  // built while the block is open, so "not open" is checked by its absence, not by the preview line.
  const toolHtmlOf = (m) => too.s.toolHtml(m.tools[0], 0);
  const isOpen = (m) => toolHtmlOf(m).includes('data-tool="0" data-state="done" open');
  const bodyShown = (m) => toolHtmlOf(m).includes("<pre class=\"tool-call__pre tool-call__pre-result\">the result</pre>");
  const toolMsg = () => ({role: "assistant", text: "beforeafter", time: Date.now(),
                          tools: [{id: "t1", name: "x", state: "done", at: 6, result: "the result", round: 0}]});
  const too = run({}, {});
  await wait();
  assert.strictEqual(too.s.settings.opentools, false, "off is the default");
  let tm = toolMsg();
  assert.ok(!isOpen(tm), "off: the block is closed");
  assert.ok(!bodyShown(tm), "and its body is not built");
  too.s.setSettings({opentools: true});
  tm = toolMsg();
  assert.ok(isOpen(tm), "on: nobody has clicked it, so it is open");
  assert.ok(bodyShown(tm), "and the result the model read is shown");
  tm.tools[0].open = !too.s.toolOpen(tm.tools[0]);          // what a click records now (see 24)
  assert.ok(!isOpen(tm), "a click closes it, switch aside");
  tm.tools[0].open = !too.s.toolOpen(tm.tools[0]);
  assert.ok(isOpen(tm), "and the next click opens it again");
  const tooOff = run({}, {});
  await wait();
  const tmOff = toolMsg();
  tmOff.tools[0].open = !tooOff.s.toolOpen(tmOff.tools[0]);
  assert.ok(isOpen(tmOff), "off: a click still opens it, as before");
  done.push("tool calls: 'keep tool calls open' opens an untouched block; after a click the click decides");

  // 24. opening and closing a tool block while the engine writes (todo #8).  The answer's bubble is rewritten
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

  // 25. the answer is updated in place (todo #7).  What is asserted is element identity and the count of whole-
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
  // exist first - with todo #12 a new run is itself a part, so the frame that creates one does add an element
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
  assert.ok((box._html || "").includes("a.txt"), "opening it built the body, with the arguments");
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

  // 26. my own messages as markdown (todo #5 and #6).  Off is the page from before: the exact characters typed,
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

  // 27. the defaults per author, and the "md" button in a message's own meta row (todo #5 and #6 as the human
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

  // 28. nothing that only pretends to be output (todo #34): no "Writing", no caret, and no answer bubble at
  // all until the model has produced something real.  The thinking block is what shows while it thinks.
  const cz = run({}, {});
  await wait();
  const cmsg = {role: "assistant", text: "", reasoning: "thinking first", time: Date.now()};
  const cels = cz.s.msgEl(cmsg, 0);
  cz.s.updateAssistant(cels, cmsg, true);          // the streaming paint, the way send()'s frame loop does it
  const cbul = cels.querySelector(".st-bubble");
  assert.ok(cbul.className.includes("thinking-only"), "thinking-only: the element exists (the thinking lives in it now)");
  assert.strictEqual(cbul.hidden, false, "...but it is not hidden, it has no chrome instead (app.css)");
  assert.strictEqual(cels.querySelector(".st-msg__meta").hidden, true, "and no meta row while it is still thinking");
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

  // 29. the settings drawer warns before it throws away changes (todo #36).  Only Apply writes, so closing on
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
  // and a finished message is never dragged: a history block opened with "Keep thinking open" shows where you
  // left it, not the end of the reasoning
  const o = run({}, {});
  await wait();
  o.s.setSettings({openthink: true});
  const om = {role: "assistant", text: "the answer", reasoning: "what it thought", time: Date.now()};
  const oel = o.s.msgEl(om, 0);
  const ob = detOf(oel).querySelector(".thinking");
  ob.clientHeight = 20; ob.scrollHeight = 900; ob.scrollTop = 500;
  o.s.updateAssistant(oel, om, false);
  assert.strictEqual(ob.textContent, "what it thought", "a finished block is filled in");
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
  assert.strictEqual(gb._blocks[0].el.querySelector(".thinking").textContent, "first thought",
                     "the run that streamed kept its text");
  assert.strictEqual(gb._blocks[1].el.querySelector(".thinking").textContent, "", "the run that never streamed is empty");
  gb._blocks[1].el.open = true;                                // a real details fires the toggle event itself
  assert.strictEqual(gb._blocks[1].el.querySelector(".thinking").textContent, "\n\nsecond thought",
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

  console.log(done.map((d) => "ok - " + d).join("\n"));
})();
