# Lessons learned

Hard-won operational knowledge for anyone (human or LLM) working on Strata on this box.
Not style rules — those are in `AGENTS.md`. This file is for things that cost time to
discover.

**Add to this file when you learn something the hard way.** One short entry, with the
evidence that produced it. Prefer a measured number over an adjective, and cite
`file:line` you actually read. Delete an entry when it stops being true.

## Existential

**Never restart the server you are running on.** The process serving port 8080
(`serve/server.py`) is what generates your own turns. A restart ends your session
mid-sentence, and you cannot finish the change you were making. Make it, verify it, tell
the human to restart, stop. Same for `/unload`. Config and code changes take effect only
on restart, so there is never a reason to do it yourself.

**Never write the chat template's control tags as literal text** — not in prose, not in
reasoning, not in code you display. That is the thinking pair, the tool-call pair, and the
turn pair. A session on 2026-10-23 died roughly six times in one day because the agent's
own output contained them while it was *describing* the bug: some consumer (Strata's
parser, the MCP transport, or the harness rendering the agent's reasoning) read the text as
a real boundary and cut the turn. Refer to them in words. In commands and test files build
them from pieces (`chr(60) + "/think" + chr(62)`) so the literal sequence never appears in
output. Markdown fences are safe; tag names are not.

## Verify, then claim

**Read the code before describing it, and quote `file:line` you have opened.** In one
session the agent cited a line number for a mechanism that lived elsewhere (pointed at
`frontend.py:1373`, which was unrelated code, for something actually at `1399`), and claimed
a second mechanism (`finish()` dumps held markup as content) from reading rather than
running — a direct test contradicted it: with `stream_tools` on, that path drops the text
silently instead. Every confident unverified claim cost a correction cycle.

**When a test fails, check whether the test or the code is wrong — do not assume either.**
Several failures in one session were the agent's own malformed test fixtures: a missing
parameter closer, a tag placed mid-line when the parser requires line start, a truncated
closer string. In each case the code was right. But the reverse also happened: a validation
that rejected an absent config key (`cfg.get(k)` returning `None` where `False` was
assumed) was a genuine bug that would have stopped every config without that key from
starting. Three shipped tests caught it. Check which one is wrong.

**"Already exists" is a claim that must be tested against the want, not the feature name.**
Six todo items were marked as already done and five were wrong or only partly true.
Markdown rendering exists but was not applied to the user's messages. A prefix pin exists
but pins a document, not a conversation. Session save/restore exists but is per-slot and
manual, which is not the "this conversation stays cached" promise being asked for. When the
human asks for X, check whether the existing thing does X, not whether it is related to X.

## Measure before you build

**Get a captured real sample before writing a parser rule.** A fix was implemented for
turns stuck in parser state `rcall`, and a test was written that made it look verified. The
test input was invented. The real log had never shown `rcall` — the observed deaths were a
different state. The fix was dead weight and had to be moved behind a flag. The correct
order is: instrument, collect one real failure, then fix the shape you actually saw.

**Trust recorded real data over plausible reasoning.** The obvious rule "a real end of
thinking is always followed by a line break" is clean, local, and *wrong*: the shipped
corpus `serve/fixtures/rcall_specimens.json` (37 recorded real cases, including 12 real
strandings) contains a case where the tag is followed directly by text and the correct
answer is that the text **is** the answer. That corpus rejected the change immediately and
is the reason both directions of this bug (#804, then #1058 fixing an over-correction of
#804) are recorded rather than repeated. Run it before touching the parser.

**Instrument, then check that the instrument can see the failure.** A counter was added for
abandoned tool calls and reported zero for a whole session while the human kept seeing
failures — because it only looked at states `call`/`json`, and the shape that mattered was
elsewhere. A counter that cannot see the bug is worse than none, because it looks like
evidence.

**The numbers that made the design question answerable, measured 2026-10-23:**
- parked conversation state: **19.1 KB per token** (193,453 tokens = 3.55 GiB)
- parking cost: **326 ms** for that conversation
- re-reading it: **~97 s** at ~2,000 tok/s; a 533,954-token prompt took **332 s**
- NVMe (FireCuda 520, ext4, `oflag=direct`, 3 GiB): **2.3 GB/s write, 3.2 GB/s cold read**
- so a 1M-token conversation is **~18 GiB of state**: ~8 s to save, ~6 s to resume, ~500 s
  to re-read — and RAM cannot hold one (4 GiB park budget, 34 GiB available, 35 GiB in swap)

## Where things actually go

**Two logs, and the important one is lost by default.** Engine stderr →
`/programs/Strata/strata-iq3_s.log`. The **server's** prints (`reasoning_close_retry`
firing, `EMPTY TURN`, `tool calls inside the thinking`, tool execution times) go to the
terminal and reach no file unless started with
`... 2>&1 | tee -a /tmp/strata-server.log`. This single fact caused most of a day of
guessing about a bug whose signature was being printed and discarded.

**The config's `env` block reaches only the engine child process** (`server.py:2626-2632`).
`STRATA_WATCHDOG_S` there works because the *engine* reads it. `STRATA_DEBUG` there does
nothing, because the *server* reads it via `os.environ`. A key that looks correctly placed
and silently does nothing is worse than an error. Server-side env vars go in the shell
command line.

**Grep self-pollution.** With `STRATA_DEBUG=1` the server dumps the model's entire raw
output per request. Those dumps contain the agent's own words about the bug, so searching
for a probe string matches the dumps of yourself searching for it. One count read "2 empty
turns and 1 abandoned call"; anchored (`^\[strata\] EMPTY TURN`) it was zero of each.
Anchor patterns, and prefer `/metrics` counters (`totals.empty_turns`,
`totals.abandoned_tool_calls`) over grepping a log that contains your own text.

**Counters appear only when non-zero.** `/metrics` omits `empty_turns` entirely rather than
reporting `0`. Absent means zero, not broken — but it reads like a missing feature and cost
a detour.

**The web app's harness had never run `send()`.** `serve/test_chat_sidebar.js`
drives the real `serve/web/app.js` against a stub DOM, but that stub had no `innerHeight`
and no `lastElementChild`, so the first attempt to call `send()` from it died at
`app.js:1138` (`autosize` reads a bare `innerHeight`); the next line it would have died on
is `app.js:1041` (`$("chat").lastElementChild`, also absent from the stub). Both are in the
stub now, `send()` is exported to the harness, and its `fetch` can be replaced with a stream
that stops when the test says so - so stream-path changes can be tested instead of
eyeballed. The one place `busy` (`app.js:563`) reaches the UI is `setBusy()`
(`app.js:1021`), so anything that means "while a request is running" belongs there: that is
where the leave warning went, and `app.js` went from 0 to 1 `beforeunload` registrations,
attached in `setBusy(true)` and undone in `setBusy(false)` (a permanent one costs the
browser's back/forward cache).

**A web-app change needs no restart, and revalidating it is now a 304.** `serve/server.py`'s
`_send_static` serves `/web/*` and the two pages: `Cache-Control: no-cache` so an edit to
`app.js` shows on the next reload with no restart, plus an `ETag` and `Last-Modified` so that
revalidation costs ~150 bytes instead of the file. The bytes are held in memory against the
file's mtime and size, so an edit is picked up on the next request and the disk is not read
once per asset per tab. Before this (2026-10-24, `serve/test_static_cache.py`): `/web/*` sent
`no-cache` with **no validator at all**, so every revalidation was a full 200 - 29,112 bytes
for the icon sprite, which the page re-resolves as output streams - and `index.html` carried
no `Cache-Control` at all, which is why a changed `app.js` sometimes needed a hard-refresh.
That hard-refresh advice is now obsolete. Only `serve/*.py` and the config need the human to
restart (and you never do it yourself - see Existential).

**`/health`'s `loaded` does not mean "the model is loaded".** It is
`Service.loaded()` = `not hasattr(engine, "alive") or engine.alive()` (`serve/server.py:2941-2943`),
and `alive()` is just "the engine child process has not exited" - `proc.poll() is None`
(`serve/server.py:872-875`). It is also useless as a start-up readiness signal, because
the port does not listen until the model is already up: `httpd = serve(svc, ...)` is
`serve/server.py:6633`, after `loading the model (the first start takes a minute or two)
...` at `serve/server.py:6448` and after the `StrataEngine(...)` constructor. So a page
has exactly one signal - "my fetch of /health stopped failing" - and cannot tell "still
loading" from "not started yet". That is why the start-up sound is a **server-side console
bell**, not a page sound (a page sound was tried on 2026-10-23 and rejected: it also needs
a click before any browser will play it). With `"lazy": true` or the idle-unload timer the
model can still come and go under an open page, and the page does not notice:
`loadHealth()` re-polls only after a *failed* fetch (`serve/web/app.js:100-109`).

**The app.js harness stubs `setTimeout` to a no-op** (`serve/test_chat_sidebar.js`, `env`),
so anything the page schedules - `loadHealth`'s 2 s retry, a toast's dismissal - never
fires in a test. Call the function yourself instead of waiting for the timer, and say so
in the comment, or the test looks like it covers the retry when it covers nothing.

**The web app's flash is the `innerHTML` assignment, not the markdown.** Measured on this
box with the page's own renderer (node, 200 calls each): building the HTML for an 18,000-char
answer is **26 us**, inside a code fence **10 us**, with an open tool block holding a
17,600-char result **7 us** - so at the 60 paints/s the page allows (`app.js:1123`
`if (!frame) frame = requestAnimationFrame(paint)`) string building costs **0.4-1.6 ms per
second of streaming**. It is not the bottleneck. The cost was `bubble.innerHTML = answerHtml(m)`
throwing away and re-parsing the whole bubble subtree every frame: 1 element for one
18,000-char paragraph, 10 with a code fence, 15 with an open tool block, and **2 sprite
`<use>` instances per tool block** (`i-tool`, `i-chevron`) - which is why the icons, not the
text, were what the human saw flicker. Fixed by rendering the answer as parts and updating in
place (`renderBubble`/`toolSync`/`markdownBlocks`). Same fake stream, 21 frames, counting
whole-subtree assignments on the bubble:

```
phase                    before    after: assigns / inserts
thinking                   11            1 / 0
tool block created          2            0 / 1
tool result                 1            0 / 0
writing the answer         10            0 / 10
end                         1            0 / 0
total                      25            1 / 11
```

The one remaining assignment is the `Writing` placeholder painted before any text exists. The
thinking body was already text-only (`body.textContent`), which is why it never flickered.
Still not measured: what the browser spends on those assignments - there is no browser on
this box for it. The visible proof is the human's own eyes.

**Four traps in that same render path, all hit on 2026-10-23.** (1) `send()` used to capture one element
(`const el = $("chat").lastElementChild`) and paint into it for the whole turn, so **any `renderChat()` while a
request was running detached the element the stream was painting into** and the answer silently stopped
appearing. Fixed on 2026-10-23 (todo #switch-while-running): `rowOf(m)` looks the row up by the message's index in the chat on
screen each frame, and the turn carries the chat it belongs to (`busy = {controller, msg, chat, chatId}`), which
is what makes switching conversations mid-answer safe. The lesson stands: a long-lived paint target must be
resolved, not captured. (2) A tool block opened by a click handler that called
`preventDefault()` and then asked for a rebuild lost most of its clicks, because the rebuild
replaces the node between mousedown and mouseup and no `click` fires (`todo` #8; now the
browser does the toggling and the `toggle` listener only records `t.open = d.open`). (3) Once
the answer is drawn as parts there is **no whole-bubble assignment left to clean up after
anything that paints into that bubble**: a `Writing` placeholder written on one frame sat above
the answer for the rest of the turn, and the fix at the time was to clear it explicitly on the
transition. That placeholder is now gone altogether (`todo` #34: no placeholder, no caret, and
the bubble is `hidden` until there is real output), but the trap stands for anything else that
paints into the bubble - clear it explicitly, or hide the element. (4) A follow-if-at-the-bottom
check has to measure **before** the content grows: the new text is exactly what pushes the
bottom out of range, so testing the gap after `textContent = ...` silently stops the following
on any chunk larger than the slack. The thinking body uses 48 px of slack where the chat uses
120 px, because that box is only 420 px tall (`.st-collapse__body.thinking`, `app.css`) - 120 px
there would mean "scrolled up a quarter of the box and still dragged". Related: in `updateAssistant` the open/close rules must run
**before** the thinking body is filled, or an auto-opened block renders open and empty - the
`toggle` listener skips the fill for an open we asked for ourselves (`det._auto`).

**Run the negative control before committing.** A test that calls the function instead of
driving the wired control passes on code that is not wired at all. Found by doing exactly
that on 2026-10-23: the drawer's "warn before discarding" case called `closeDrawer()`
directly, so it still passed when the X and the scrim were rewired back to
`openDrawer(false)` (`node exit=0` on deliberately broken code). Rewriting the case to click
`el("drawer-close").onclick()` and `el("scrim").onclick()` made the same control fail with
`closing asks first - 0 !== 1`. Wire-level claims need wire-level tests; text assertions on
the wiring line are a second-best, not a substitute. It has now bitten twice in one session, both times
because the **stub was less faithful than the assertions assumed**: a case that called `closeDrawer()` instead
of clicking the button passed on unwired code, and a case that checked a container's children passed while
every tool call in the app was `display: none`, because the stub never read bare boolean attributes out of
inserted HTML - a shell written as `<details ... hidden>` looked visible. The stub now parses the root tag,
its classes and its bare attributes, and fires a `toggle` event when script sets `open`. When a control fails
to fail, suspect the stub before believing the code.

**Blank chats are not stable, and more than one is reachable today.** `newChat()` invents an
id (`c<time><rand>`) and `openHistory` pushes a blank chat into `chats` **without writing it**,
so a blank chat's id changes on every page load. And `startChat` only refuses when the
*current* chat is blank: blank A → open used chat B → New chat → blank C, which `showChat`
does write, so the list can hold several blanks. Anything keyed to a chat id therefore must
not key blank chats by id - they are fungible. The composer draft uses one shared `"blank"`
key for exactly that reason, and `startChat` now reuses the blank chat the list already has
(4a695a05) instead of adding another. Persisting blank chats to stabilise their id was the
first instinct and is the wrong fix: it fills the list with empty rows.

**A composer draft belongs in localStorage, not the chat record.** The conversations live in
IndexedDB one record per chat because a chat can be megabytes (`openHistory`, `writeChat`);
writing the record on every keystroke to save a few hundred characters of draft would be
ruinous. `store.set("draft." + key, ...)` is synchronous and tiny. The store helper is
deliberately `get`/`set` only - a test pins that (`test_chat_sidebar.py`) - so "no draft" is
an empty string, not a deleted key.

**Three more things, learned while grouping the answer into think/work blocks (todo #think-per-round, 2026-10-23).**
(1) `querySelector` never returns the element it is called on. `syncThink` asked the details
element for `.st-collapse think` - its own class - which is `null` in a browser and would have
thrown on the next line; the stub auto-creates a node, so it looked like a test problem instead.
A part's own element must be used directly, and only its descendants queried.
(2) A container that swallows the model's narration costs more than it saves. The first version folded a
round's text **and** its calls together, and the human's objection was concrete: the text is part of the
answer, it was hidden behind a click, and the copy button still copied it - so the same words existed twice,
one invisible. It also cost exactly one rebuild per round, because text that had been drawn at the top level
had to move into the new container when the first call appeared. Folding **only the calls** fixed both: text
and thinking stay top level in the order they happened, and a settled part never moves. Both containers were
ultimately removed (2026-10-23): even a calls-only box was one click too many to read a call, so the shipped
layout is think / text / call / think / text / call / answer, all top level. The lesson stands for anything
that folds away something the reader wants in line.
(3) Before changing how a turn is *displayed*, write the replay tripwire first: assert
`assistantMessages()` output is byte-identical. The same offsets (`at`, `rat`) feed both the
layout and what goes back to the server, and a one-character difference there breaks the
engine's prompt prefix at the first tool round. The stub also has to fire a `toggle` event when
script sets `details.open`, or the page's own `_auto` flag leaks onto the next simulated user
click and a test fails for a reason that does not exist in a browser.

**A persistent part must refresh every field that grows.** The parts machinery keeps an element per part and
only rebuilds the tail, so the part object survives across paints - which means any field describing a *growing*
range has to be re-read from the fresh spec every paint. The text part does that with `_to`; the thinking part
did not, so a new thought bubble showed only its first chunk and nothing else ever appeared (reported by the
human 2026-10-23, fixed in the commit after c878ab21: `p.from = w.from; p.to = w.to; p.runs = w.runs;`). The
same trap was already hit once for text (`1 !== 10` in the insert count), and once more in the same function
minutes later: a run's seconds are stamped only when the *next* run starts, so a part that never refreshes
`secs` says "Thoughts" forever and never "Thought for 4.2 s". When you add a part kind, ask which
of its fields are live and refresh them, and write the test as "grow it, then assert the whole text is there".
`p.runs` matters too: a stale run count makes the last block stop looking like the last block, which turns off
both auto-opening and auto-following.

**The harness never painted a stream until 2026-10-23.** `serve/test_chat_sidebar.js` stubbed
`requestAnimationFrame: () => 0`, so `if (!frame) frame = requestAnimationFrame(paint)` scheduled a paint that
**never ran** - every streaming test up to then asserted on the message objects and never once on what was
drawn. It now queues the callbacks and exposes `flush()`, and a stream test drives one frame at a time (each
`read()` flushes first, the way one animation frame does). That is what made the switching-chats bug testable
at all: with the old stub, painting into a detached node was invisible to the tests by construction.

**A hanging test exits 0 with no output - it looks like a pass.** `serve/test_chat_sidebar.js` is one async
IIFE that prints its `ok -` lines at the very end. If any awaited promise never resolves (I drove a fake stream
with one `step()` too few), node's event loop empties, the process exits **0**, and nothing prints: no failure,
no test count. `node exit=0` alone is not evidence. Count the `ok -` lines, or compare the total against the
number of cases you expect, before believing a green harness run.

**A web-app file that needs a matching server change breaks the running app the moment you save it.**
`serve/web/*` is read from disk per request, so it is live before any restart. Inlining the sprite meant
`index.html` referencing `href="#i-chat"` while the **running** server (an older commit) never injected the
symbols - every icon in the app went blank the instant the file was written, and it stayed blank until a
restart. The commit was correct; the ordering was the trap. Either land the two halves and restart in the same
breath, or make the client tolerant (e.g. app.js detecting that the symbols are absent and falling back to the
file URL). Related: the sprite is now a build input, not a fetched asset - deleting it takes the icons out of
every page (with `serve/server.py`'s guard the page still serves, symbols simply missing).

**Setting `details.open` from script fires a real `toggle` event, and the page's own listener will read it as
the reader's click unless you mark it.** `toolSync` sets `d.open` itself (`serve/web/app.js:1093`), and the
`#chat` toggle listener records *any* toggle as the reader's choice (`t.open = d.open`), so an auto-opened
call stopped following the rules after its first auto-open and never collapsed. The thinking block already
had a guard (`det._auto`, set `app.js:1225`, consumed `app.js:1421`); the tool block had none.

**The flag was the wrong shape, and it produced the exact symptom "calls fold only at the end of the turn".**
`_auto` is a one-shot token, but a browser queues `toggle` rather than firing it inside the setter, so two
paints can leave two events in flight: the first eats the token and the second - the page's own change - is
read as a click. That sets `t.open`, and `toolOpen` short-circuits on `t.open` (`app.js:1026`), so no control
can reclaim the block until `send()` deletes `t.open` at the end of the turn (`app.js:1613`). Demonstrated in
the harness: fire the page's own toggle twice and the flag version leaves `t.open === true`, the comparison
version leaves it `undefined`. The tool branch now compares instead of consuming (`if (d.open === toolOpen(t))
return;`, `app.js:1415`) - idempotent, so any number of queued events is the same. The thinking branch keeps
its flag; it has the same weakness and should get the same treatment if a thinking block is ever reported
stuck open.

The general rule: **a "was that me?" question needs a comparison against current intent, not a consumed
token**, whenever the event can be queued. And note the stub fires `toggle` synchronously inside the setter,
so it cannot show this on its own - the test has to fire the event twice deliberately.

**Display state does not belong in the chat record.** A tool block's open/closed choice was kept on the tool
(`t.open`) and `cleanMessages` spreads `...m`, so it went into the IndexedDB record and came back on every
reload: one tap pinned a call open forever, and `toolOpen` short-circuits whenever `t.open` is set
(`app.js:1026`), so no control could reclaim it. The thinking block never had that bug, because its "the reader
touched this" lives on the DOM element (`dataset.touched`), which `renderChat()` throws away. Measured before
fixing: with fold on and keep-open off, a fresh stream folded correctly (`state=done -> open=false`) but one
click left `t.open=true` in the record, and a reload reopened it. Fix: `send()` drops it when the turn ends
(`app.js:1610`), `cleanMessages` strips it on write, and `openHistory` strips it on read for records an older
page already wrote (`dropToolOpen`, `app.js:692`, `771`, `773`). **Both halves need their own test**: the read
strip masks the write strip, so a control that only removes the write strip still passes until you also click
a block on a *finished* message and save (harness case 48).

**The harness's IndexedDB stub aliased reads and writes, and one test passed only because of it.** `getAll()`
returned `Object.values(data)` - the live record objects - and `put()` stored the object it was handed. So case
5's `chats[0].title = "renamed"; saveChat()` appeared to reach the record through shared identity, while it was
in fact saving the *open* chat, a different one. Any change that made the app stop mutating what it read looked
like a regression (it did: 42 ok lines became 0). The stub now structured-clones on both sides, like real IDB,
and case 5 saves the chat it renamed. When a storage test fails after you stop mutating a record you read,
check whether the test was relying on aliasing before believing you broke something.

**A shared CSS box for a segmented control must not hardcode the option count.** `.seg` was
`grid-template-columns: repeat(4, 1fr)`, sized for the four-option Thinking control; a three-option control
inside it left an empty cell. Now `display: flex` with `flex: 1 1 0` on the buttons (app.css:271-275), which
gives the four-option control the same equal widths it had. Pinned by a regex on the `.seg` rule, not on the
whole file - `repeat(4, 1fr)` still appears in the comment explaining why it went, and an `assertNotIn` over
the file failed on its own comment.

**The stub does not parse `data-*` out of inserted HTML, so a tool block the page made is invisible to the
toggle listener.** `+d.dataset.tool` is `NaN`, `m.tools[NaN]` is `undefined`, and the listener returns at
`if (!t)` — a test that opens such a block "as the reader" silently tests nothing. Case 24 has always worked
around it by building the block by hand (`test_chat_sidebar.js:588`); case 45 sets `dataset.tool` on the node
the page made instead. Either is fine, doing neither is a silent pass.

**In the fake stream, one `step()` delivers one chunk; the paint for that chunk needs a second flush.** The
stub's `step()` calls `flush()` *before* resolving the read, so the frame the page schedules for the chunk it
just handed over is still queued afterwards. A stream test that asserts after `step(); await wait()` alone sees
the state from before the chunk - `_blocks.length` 0 where it should be 1. The pattern that works is
`step(); await wait(); flush();` per chunk, and one `step()` past the last frame or `send()` never returns (see
"hanging test exits 0").

**A thinking run is not "over" just because it is the last one.** While a tool round runs, `thinkRuns` still
reports one run (the next round's reasoning has not arrived), so "the last run while streaming" keeps the
thought open through the whole tool call. Two signals say it is finished: `runs[i].cut` (`app.js:1143`, a call
starts where the run ends) and `runs[i].tstart` - how much answer text existed when the run began, stamped in
`send()` as `m.rts[index] = m.text.length` (`app.js:1581`), so text grown past it means the model started
writing. `m.rts` holds numbers only, never text, so the replay tripwire (case 33) is untouched - asserted.
Like `secs`, `cut` must be refreshed from the fresh spec every paint (`app.js:1288`) or the part keeps a stale
value - the trap that bit `from`/`to`/`runs` and `secs` before it. `tstart` does NOT need refreshing: it is
fixed when the run begins, and a control that tried to prove the refresh failed to fail, which is how I found
the line was dead weight and deleted it.

**Three different deaths, and naming one fixes none of the others.** A session on 2026-10-24 used
"the stall" for all of them and wrote it into the todo that way; the human had to separate them.
They are: (1) the **slow death** - `reasoning_loop_recovery: "recover"` fires and the thinking
counter then sits at exactly 2560 tokens for minutes while the rate decays 88.5 -> 29.3 tok/s, so
the turn never advances and never ends (todo slow-death, `strata-slow-death.txt`); (2) the **silent no-op**
- `focused_recovery_prompt` (`serve/server.py:193`) splices `HIGH_EFFORT` (=`EFFORT_TEXT["xhigh"]`,
`server.py:157`) down to `LOW_EFFORT`, keyed on xhigh because that is the template's *default*
sentence, so a request that asked low or medium has no such sequence, the function returns `None`,
and nothing is recovered (todo recover-noop); (3) the **forged-boundary death** - a turn cut because a
boundary tag appeared as text, twice today because the agent quoted a log line containing one
(todo dead-turn). This box's own web traffic is NOT in case 2: the app sends `high` and
`serve/chat_template.jinja:59-61` maps `high` to `xhigh`, which is why the log shows the rescue
firing and then the freeze. Check which one the evidence points at before proposing a fix, and say
which one you mean when you write "the stall".

**One colour per state, and the pill is not a separate decision.** `--st-accent` green means the engine is
producing tokens; `--st-info` blue means it is not (reading a prompt, waiting on an MCP tool); `--st-warn`
means queued. `components.css:20-21` already encodes that for the pill's dot and `:58-60` for the badges, so
`setPill(state, ...)` must pass the state that matches, not the one that looks "active". I introduced a
mismatch on 2026-10-24 by setting `running-tool` to `"generating"` (green) while the Monitor's badge and state
card already said blue for the same state - three components, one state, two colours. A test now pins the
pill's `data-state` for `running-tool`, because colour bugs are invisible to everything except a human eye.

**Strata, the engine, and the MCP tool server are three processes.** `http://localhost:8643`
("easyCMP") is the tool server. It has crashed twice; both times Strata was healthy and
kept answering normally while the agent's tools went dark. Attribute the crash to the right
process before diagnosing it.

## Structure, not parsing

**Boundaries that are represented as text can be forged by the content.** The engine
already knows them as token IDs — 248068/248069 the thinking pair, 248058/248059 the
tool-call pair, 248045/248046 the turn pair, all marked special in `token_type.json` — and
it sends raw IDs on its `T` lines. The server detokenises and throws the ID away one line
later (`server.py:3995`), then tries to recover the structure by string matching. That is
why quoted and genuine tags are byte-identical and no local rule can separate them. Any
serious fix goes through the IDs, not the text. (Unverified whether the engine forwards
special IDs on `T` lines — check `generate.cpp:11818` before sizing it.)

**Conversation reuse has no identity.** Reuse is exact token-prefix matching with no client
session ID (`DETAILS.md`, "Multiple conversations"). Nothing can be told "warm chat 7" or
"pin this conversation". Anything that wants a per-conversation promise — pinning,
auto-save, preloading, multi-tab sync — has to solve identity first, and the client is
currently the only thing that knows which conversation it is in.

**Anything the client re-derives will eventually disagree with the server.** The
re-read bug came from the web app rebuilding a tool turn's history slightly differently
from how the server had built it (dropped thinking), so the prompt stopped matching the
engine's checkpoint and the whole tail was re-read. Same root as multi-tab clobbering and
the preloading problem. Prefer passing state through over reconstructing it.

## Working style

**One change per commit, and say what it leaves alone.** Several commits in one session
mixed a diagnostic with a behaviour change, which made the behaviour change impossible to
review or revert on its own. `AGENTS.md` already requires this; it is here because it was
broken anyway.

**New behaviour goes behind a flag with the default unchanged, and the flag needs a test
for both positions.** A parser fix that changed the default path violated the repo rule and
had to be re-gated. The repo already has the pattern: `false | true | "calls"` mirrors
`reasoning_loop_recovery: false | "stop" | "recover"`, and a tri-state avoids new flag
sprawl. Also validate the *absent* case — `cfg.get(k)` returning `None` is not `False`.

**No legacy browser fallbacks.** On 2026-10-23 the human deleted the second half of the
leave warning - `e.returnValue = ""` alongside `e.preventDefault()` - with the words "they
are not being supported" (commit 894329fc; `warnOnLeave` is now three lines,
`serve/web/app.js:1017-1019`). The harness assertion that checked the older form had to be
deleted with it, and it failed loudly first (`AssertionError: the older form the page sets
is there too - null !== ''`), which is the right order: the test was wrong, the code was
deliberate. Write for current browsers only.

**Do not edit the human's config without asking.** It silently changes behaviour on the
next restart, and it can turn a fix off. A config key that is documented as off-by-default
means the human has to opt in; say so explicitly rather than setting it.

**Scripted text edits need a read-back.** Two automated renumberings of a markdown list
corrupted it — one truncated every item number to its first digit, another promoted body
lines into items. Both were caught only by printing the result afterwards. Keep a backup
before a bulk edit, and verify the count and the cross-references, not just that the
command exited 0.

**Ask what the human actually wants before scoping.** One todo item was wrong for most of a
day because it described the mechanism the agent inferred rather than the behaviour asked
for; the difference was "cancel on switch" (three lines) versus "warm the conversation when
I start typing" (a new engine verb). Cheap question, expensive assumption.

**State every config change you make, and never describe your own change as pre-existing.**
In one session the agent added `open_browser: false` and `reasoning_close_retry: true` to
`strata-iq3_s.json`, then later told the human "you set that, so it's done" and listed the
same flags as if they were the box's original configuration. Config edits are invisible
state: they change behaviour on the next restart, they can turn a fix off, and a fresh
checkout would not have them. Three rules follow:
- say what you changed in the config, in the same message you changed it;
- do not call a thing "already configured" without checking whether *you* configured it;
- do not touch the config at all without asking - see the flag rule above.
The same trap produced a false "already exists" list: six todo items were marked done, and
the state that made them look done was partly the agent's own recent edits.
