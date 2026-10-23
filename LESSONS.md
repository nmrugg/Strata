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

**A web-app change needs no restart.** `serve/server.py:5054-5068` reads every
`/web/...` file (`app.js`, `app.css`) from disk on each request and sends
`Cache-Control: no-cache`, so the new script is live on the next page load. `index.html` is
served at `/` and is also read per request (`server.py:5119`) but carries **no**
`Cache-Control`, so a plain reload can show a stale page - hard-refresh it. Only `serve/*.py`
and the config need the human to restart (and you never do it yourself - see Existential).

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

**Three traps in that same render path, all hit on 2026-10-23.** (1) `send()` captures
`el = $("chat").lastElementChild` (`app.js:1059`) and `paint()` writes into that captured node
(`app.js:1081`), so **any `renderChat()` while a request is running detaches the element the
stream is painting into** and the answer silently stops appearing - do not "re-render the
chat" when a setting changes. (2) A tool block opened by a click handler that called
`preventDefault()` and then asked for a rebuild lost most of its clicks, because the rebuild
replaces the node between mousedown and mouseup and no `click` fires (`todo` #8; now the
browser does the toggling and the `toggle` listener only records `t.open = d.open`). (3) Once
the answer is drawn as parts there is **no whole-bubble assignment left to clean up after
anything that painted one**: the `Writing` placeholder would have sat above the answer for the
rest of the turn. The parts path now clears it on the transition (`if (bubble._ph) {
bubble.innerHTML = ""; ... }`) and the test asserts the transition assigns the bubble exactly
twice - placeholder, then clear. Related: in `updateAssistant` the open/close rules must run
**before** the thinking body is filled, or an auto-opened block renders open and empty - the
`toggle` listener skips the fill for an open we asked for ourselves (`det._auto`).

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
