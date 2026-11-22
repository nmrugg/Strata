# Lessons learned

Hard-won operational knowledge for anyone (human or LLM) working on Strata on this box.
Not style rules — those are in `AGENTS.md`. This file is for things that cost time to
discover.

**Add to this file when you learn something the hard way.** One short entry, with the
evidence that produced it. Prefer a measured number over an adjective, and cite
`file:line` you actually read. Delete an entry when it stops being true.

**Line numbers in here are as-of the date of the entry, not a live index.** They rot on every
edit, and four of them in this file were already wrong when they were re-checked on 2026-10-24.
Before acting on one, re-find the code by its symbol (a function or constant name survives
refactoring; `app.js:1225` does not). Prefer writing the symbol and leaving the number out.
The same applies to the counts quoted in entries - a test count, a token count, a duration is a
measurement of one moment on one box, useful as evidence and misleading as a constant.

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
output. Tag names are safe; the tags themselves are not, and **a markdown fence is not protection**. On 2026-11-19 an agent
broke its own turn twice in one session by spelling the closing think tag while *describing* this bug - once inside
a fenced code block in its answer (the turn ended and the tool call it then wrote arrived as an ordinary chat
message), once inside its own reasoning. Neither was prose, and the fence did not help: the structure is recognised
in the text stream, not in the rendered page.

**In tests and probes, import the parser's constants instead of spelling or assembling the tags.** `serve/frontend.py`
exports `CALL_START`, `CALL_END`, `FUNC_START`, `FUNC_END`, `PARAM_START`, `PARAM_END`, `THINK_END`. Deriving one is
a trap that cost a wrong conclusion the same day: `FUNC_START` ends with `=`, so replacing `<` with `</` and adding
`>` produces a closer one character wrong, the fixture silently takes a different parser path (`call_end` returns
-1, the turn is counted as abandoned instead), and the code under test looks broken when the fixture is. Check a
suspicious fixture by calling the helper directly before believing anything about the code.

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

**A `tee -a` log is several processes, and a grep that returns 0 can mean "not instrumented".** On 2026-11-19
several turns of one agent chat died with the tool call rendered as text. The first measurements said zero of
everything, and both readings were wrong in the same way. `/tmp/strata-server.log` is appended across restarts, so
the two "tool calls inside the thinking" lines belonged to the **previous** process - the current one's start-up
banner was at line 23362 of 25624, and any count has to be taken after that boundary. And the failure mode itself
had no print and no counter in this tree at all, so no pattern could find an event that never emitted one: the
counters that exist (`rescued`, `refused`, `abandoned`, `empty_turns`) each describe a call the parser *recognised*
in some way, and a call envelope handed back as prose is none of them. Cross-check a log count against `/metrics`
`totals` before believing either - they disagreed here for exactly that reason. Fixed by item
unread-call-instrument: `unread` / `unread_names` on the parser, one printed line and `totals.unread_tool_calls`
in the server.

**A request that asked for MCP tools and got none looks exactly like a dead engine, and no counter could see it.**
2026-11-21: an agent chat stopped answering with tool calls. The requests ended `stop` with plausible text while
`empty_turns`, `abandoned_tool_calls`, `unread_tool_calls`, `drift_tool_markup` and `unknown_tool_calls` were all
absent - because content WAS delivered. The request record's `tools` field said `0`: the handler computes
`use_mcp = bool(extra)` from the hub's tool list, and an empty list means the prompt is rendered with no tools
block at all, so the model does something else instead of failing. The hub had printed `31 tools` at start-up, so
the usual suspect - the tool server being down, which this file already records twice - was wrong this time. Two
rules: when a turn dies with every counter at zero, read the record's `tools` count before suspecting the parser;
and a silently tool-less prompt needs its own print, because the one that exists ("Its tools are left out; the
chat works without them") is true for a person chatting and false for an agent whose every turn is a call. Now
instrumented: `totals.mcp_requests_without_tools`, and a line naming which of the three causes it was (item
tools-block-empty).

**Where a state is decided late, an instrument has to wait for the end.** An unclosed code fence and a quoted
example of the format are indistinguishable while the text is arriving (`_fence_quoted_think` already says so for
the think tag). So the parser now *remembers* the openers the code-quote rule turned into text and only decides in
`finish()` whether the fence ever closed. Counting at the moment of the swallow would have counted every quote the
corpus insists must stay text.

**A class named for an input reaches a textarea.** `.st-input` in `serve/web/components.css` is
`height: 44px; padding: 0 14px` — right for a one-line field, and it made every multi-line field in the MCP server
form a 44 px strip with the text clipped under the top edge. A `textarea.st-input` needs `height: auto` and real
vertical padding; a `min-height` alone does not fix it, because the fixed `height` still wins. Pinned by a CSS
assertion in `serve/test_chat_sidebar.py`, because no test on this box renders a page.

**A popover's outside-click rule will close the popover under a modal it opened.** `serve/web/app.js` keeps one
document click listener that calls `closePopover()` unless the click is inside `.chat-menu`, on an opener
(`[data-chat-menu]`, `[data-msg-edit]`, `#mcp-btn`). A modal lives on `<body>` inside `.att-viewer`, so the first
click in the MCP server form counted as an outside click and the wrench panel behind it vanished - the view the
modal was editing. The rule now excludes `.att-viewer`. Escape was already right (modal first, then popover), which
is the tell: the keyboard path and the mouse path disagreed.

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

**The Monitor's per-request record is written before the parser decides anything at the end of the turn.**
`self.history.append({...})` in `Service.run` (`serve/server.py`) runs before `parser.finish()`, so a verdict the
parser only reaches at the end — whether an open code fence swallowed a real call, the `unread` count of item
unread-call-instrument — cannot live in that record: it would read absent for exactly the case it exists to flag.
The printed line and `totals` are the only places those are visible. Found by adding the field, watching a test
that otherwise passed come back `None`, and reading the order instead of blaming the assertion.

**A re-read inside one request is visible only in the engine log, per pass.** The engine prints one line per
pass: `strata serve: prompt N tokens = R reused + X read in ... ms`. `request_stats` in `serve/server.py` builds
the `/metrics` record from **segments[0]** for `reused`/`prompt_read`, so a request whose second or later round
lost the prefix records the first pass's good numbers and looks clean. Found 2026-11-21 chasing a re-read the
owner had seen in the Monitor: the record said 87,463 prompt / 51,182 reused / 36,281 read, and the neighbouring
engine lines for the same chat read 91 and 876 tokens - the 36k was a *later* pass of the request before it.
To find *which* message diverged: `GET /api/requests` lists the retained requests, `GET /api/requests?id=ID`
returns that request's `input` (the whole body as sent, cut at 262,144 characters, `input_truncated` says so).
Diffing consecutive requests' `input` by hand is a dead end when they are different turns; what works is
converting the char offset of the divergence into a token offset and reading the engine log's per-pass prompt
sizes to find the pass that ends just before it, then reading the server log's `[strata] tool ...` lines in that
pass's window. That is how the round below was pinned to 176 tokens.

**A round's calls have one order, and it is the model's.** `run_with_mcp` used to keep the calls it answers
itself in two lists - the hub's tools and the names nobody offers - and join them real-first. The client never
sees that join: it builds its tool list from the announcements as they arrive and replays that array, so a round
that wrote an unknown call before a real one was re-ordered in the history, and the token prefix stopped
matching there. Measured 2026-11-21: 36,281 of 87,463 tokens re-read (14.4 s) by the next request, and the
client hung up. Same root as the thinking-shape and the tool-picture re-reads: **the server's internal grouping
is not part of the contract; the sequence of tokens it produced is.** Any list the server rebuilds from a turn
has to be in the order the model wrote it, not the order the server found it convenient to run it in.

**An agent turn is ONE request, so a per-request limit is a per-turn limit in disguise.** The MCP loop runs the
tools itself and re-prompts, so a turn with thirty tool rounds is one HTTP request containing thirty engine
passes - measured 2026-11-21 on this box: one request, `prompt 268,485` tokens, ~30 `[strata] tool ...` lines
inside it. Anything `run_with_mcp` counts per request is therefore counted once per turn, and a turn is long.
The cap of two answered unknown calls (ported from upstream, where a turn is one question and one answer)
killed a working turn here: three slips across thirty rounds, the third went over the cap, its call was shown
as "not run", the loop broke, and the turn ended with no answer - the death item unread-call-recovery exists
to remove, caused by the fix for it. A limit meant to stop a loop has to count the **streak**, not the total.
The same trap sits in the Monitor: `request_stats` folds those thirty passes into one row.

**A new parser event kind has to be tolerated by every consumer of the event stream, and a 400 can be our bug.**
Adding `tool_cut` to the parser's events broke `serve/test_server.py UnfinishedToolCall` with `HTTP 400 Bad
Request`, not a crash: `anthropic_events` maps kinds through a dict (`{"reasoning": ..., "tool_call": ...}[ev.kind]`,
`serve/server.py`), the KeyError escaped the generator, and the handler's `except (TypeError, KeyError,
AttributeError, IndexError, UnicodeError)` branch answered it as **"the request is malformed"** - a message that
blames the client for a server-side hole. The traceback is printed to the console (`[strata] 400 malformed
request (KeyError: 'tool_cut')`), so the way to read a 400 from this server is to check the console before
suspecting the client. Grep `\[ev.kind\]` before adding a kind: the OpenAI path uses `elif` chains (an unknown
kind is inert) and the Anthropic path uses a dict (it is not).

**`serve/frontend.py`'s tag constants are not in one place.** `CALL_START`, `CALL_END`, `PARAM_END`, `FUNC_START`
and `FUNC_END` sit together near the top; `PARAM_START` is about 100 lines further down, with the parameter
helpers. A module-level regex composed from `PARAM_START` and placed with the first group raises `NameError` at
import — the edit looks fine in the diff. Compose from a constant only after that constant, and `py_compile` the
file before believing any edit that adds module-level code.

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

**Patch, test, restore inside one command - then re-read the tree before believing the control.** On 2026-11-21
a control run written as one shell command (patch the source, run the test, copy the good file back) printed a
failure that named the code I had just fixed, and the next command could not reproduce it. Clearing
`serve/__pycache__` did not change it, and a clean re-run of the same three states - fixed, patched, restored -
behaved correctly every time. What was wrong was my reading of which file each run had used. So: run each
control as its own step, and `grep` the exact line you changed immediately before and after it, rather than
trusting that a `cp` in the same command list did what it says.

**A stub that is missing a property the code READS drives a path no real browser takes, and the test then proves
the stub.** Writing `serve/test_service_worker.js` (item offline-web-assets) produced three stub bugs in a row,
each of which would have shipped a broken feature with green tests: (1) a worker-scope `location` stub with
`href` but no `origin` made the worker's own origin guard true for every request, so it intercepted nothing and
the offline cases failed for a reason that had nothing to do with the worker; (2) the page harness's "no service
worker" case set `navigator.serviceWorker = undefined`, which makes `"serviceWorker" in navigator` **true** -
the code then called `.register()` on undefined, in a browser shape that does not exist; (3) the cache stub
keyed entries by whatever string it was handed, so `add("/web/app.js")` and `match(<absolute-URL request>)`
never met and every offline hit looked like a miss. Same family as the DOM stub's `data-*` and `toggle` gaps:
list what the code *reads* off the platform (`origin`, whether a key exists at all, `pathname`) and give the
stub that shape - a real `new URL(...)` for `location`, an omitted key rather than an undefined one.

**Never run `git checkout <path>` on a file with uncommitted work.** 2026-11-22: while bisecting a change by
control-patching it, a cleanup command ended with `git checkout serve/web/app.js` and discarded the queue
plumbing that was sitting uncommitted in that file - the control patches had already rewritten it, so the
"restore" step restored the *committed* state, not the working one. It was recoverable only because a copy had
been taken to `/tmp` before the first control. The rule: before any edit-and-restore cycle on an uncommitted
file, `cp` it aside and say so in the command; and prefer `git stash push -- <path>` / `git stash pop` to a
checkout, because stash is recoverable and a checkout is not.

**The harness's `children` is an array; the browser's is an HTMLCollection.** 2026-11-22: `row.children.find(...)`,
`.children.some(...)` and friends passed every harness case and threw on the real page - `HTMLCollection` has no
`find`, `some`, `every`, `map`, `filter` or `reduce`. The owner caught it; three calls went out. Indexing,
`.length` and `for..of` are fine, so only the array methods are the trap, and `x.children || []` is not a guard -
it still hands back the collection; spread it (`[...x.children]`) or use `Array.from`.
No runtime test can catch this, because the stub is an array - so the guard is textual:
`serve/test_chat_sidebar.py::test_no_array_method_is_called_on_a_live_collection` greps `web/app.js` for an array
method directly on `.children`, `.childNodes`, `.cells` or `querySelectorAll(...)`. Control: one `.children.some(`
in the file fails it. The general rule for stub harnesses: **when the stub's data structure is more capable than
the real one, the tests lie in one direction only** - check what the platform actually gives you before trusting
a green run.

**A failure collector that reports only at the end turns a crash into a silent exit 0.** Adding
`process.on("unhandledRejection", r => unhandled.push(r))` to the chat harness hid a real bug: the run printed
nothing, exited **0**, and the 92 `ok -` lines never appeared - the exact shape recorded above for a hang.
Report the moment it happens (`console.error` plus `process.exitCode = 1`). A collector is only safe if the run
always reaches the reporting line, and a failing run is precisely when it does not.

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

**The stub only parses `data-*` on the ROOT element of inserted HTML — a handler that reads a name off an
ancestor can still ship broken.** First recorded because `+d.dataset.tool` was `NaN`, so a test that opened a
tool block "as the reader" silently tested nothing (case 24 worked around it by building the block by hand,
case 45 by setting `dataset.tool` on the node the page made). On 2026-11-19 the stub was extended to register a
root element's `data-*` into `dataset`, camel-cased as a real DOM does — and the same class of bug shipped
anyway: the Monitor's MCP card was written without `data-mcp-server`, so in a browser the handler read
`undefined` and the server answered "there is no MCP server '' in mcp_servers", while the harness passed because
the test hand-built the card with the dataset value it wanted. Two rules follow: (1) elements inside an
`innerHTML` string are still not nodes at all — only the root of an `insertAdjacentHTML` is; (2) when a handler
reads a value off an element the page built, take the expected value out of the HTML the page wrote
(`el._html`) and drive the click with that, so dropping the attribute fails the case. Control that proves it:
delete `data-mcp-server` from `renderMcp` and case 90 fails with "the card the page wrote carries
data-mcp-server" — before the fix it passed.

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
producing tokens; `--st-info` blue means it is reading a prompt; grey (the idle colour) means nothing is being
generated, which covers both Idle and waiting on an MCP tool; `--st-warn` means queued. The palette lives in
`components.css` for the pill's dot and the badges, so `setPill(state, ...)` must pass the state that matches,
not the one that looks "active". Two mismatches have been corrected: on 2026-10-24 `running-tool` was set to
`"generating"` (green) while the badges said blue; on 2026-11-22 the owner moved it to **grey**, because blue
was making "not generating" two colours across three components and the chat-list mark was already grey for the
same state. A test pins the pill's `data-state` for `running-tool`, because colour bugs are invisible to
everything except a human eye - and when a colour decision changes, the LESSONS entry changes with it.

**A CSS animation restarts when the node is replaced, not when its colour changes.** 2026-11-22: the chat-list
spinner restarted every time a row re-rendered, because the mark was part of the row's `innerHTML` string - any
re-render threw the node away and made a new one, and a new node starts from 0deg. Two rules follow: anything
that animates needs to be a node the render *reuses* (the sidebar now updates rows in place when the list has
the same shape), and a test for "the animation did not restart" is an identity assertion - the same node object
before and after - because no stub can measure an animation.

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

**A split history has to be verified per commit, and `git worktree` is the safe way to do it.**
On 2026-11-21 a day's work in one file had to become five commits. Two attempts produced
commits that did not pass their own tests, and both times the cause was a hunk split that
separated an edit from the thing it depended on: a harness stub defined `registers` in one
commit and used it in another; `renderPill` called `healthPill()` in a commit where the
function arrived later, because the `loadHealth` edit that adds both also carried an unrelated
wording change. Neither shows up if you run the suite from the working tree - I ran it five
times against the final tree and it said OK five times. What caught it: `git worktree add
--detach /tmp/v <sha>` for each commit and running the suite **inside** that directory (never
touching the working tree), then `git worktree remove`. Two rules follow: verify each commit as
a tree, not each diff as a patch; and when classifying hunks by content, never use a phrase that
appears in your own comments as the marker - "server-before-model" is written in the code it was
supposed to identify, and it dragged nine hunks into the wrong commit.

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
