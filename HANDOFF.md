# Handoff prompt — Strata, 2026-10-24

Paste everything below the line to a fresh agent.

---

You are working on Strata at `/programs/Strata` (branch `fork`, remote Niko1221/Strata).
Read `AGENTS.md`, **`LESSONS.md`**, and `/programs/Strata/todo` (**39 open items, 55 total,
sorted by effort**) first.

## Read this before you touch `todo`

Items have **short names, not numbers** (renamed 2026-10-24). Each item's line starts with its name in
backticks, e.g. `` `pin-conversation` ``. Code comments cite it as `todo #pin-conversation`; prose in the
file says "item pin-conversation". To go from a comment to the item: `grep -n '`pin-conversation`' todo`. To go the
other way: `grep -rn 'todo #pin-conversation' serve/`.

Do not reintroduce numbers. The file was renumbered four times in one day; each pass invalidated
cross-references and the ~40 `todo #N` comments in `serve/`, and twice a scripted renumber corrupted the
file itself (a heading eaten by its own replace, and `items 39-42` mangled into `items asset-validator-42`).
A name cannot collide with its neighbour, so there is nothing to keep in sequence and nothing to renumber
when work lands.

When you finish an item, keep its line and mark it `DONE <date>` - the Done section is history, not a
waiting room. When you add one, pick a name no other line uses. Eight work items that were done and
deleted in an earlier session are still cited by code comments; they live in a "Historical names" section
so those citations resolve instead of dangling.

The one real design question in the file is `pin-conversation`: making a conversation near 1M tokens
always fast to open. Measured here, parked state is 19.1 KB per token, so 1M tokens is ~18 GiB; NVMe does
2.3 GB/s write and 3.2 GB/s cold read, so ~8 s to save and ~6 s to resume against ~500 s to re-read. RAM
cannot hold one such chat. Do not start it with code - it needs a decision first.

## Your job

Work the todos — **one at a time**, in order. Stop and wait. **Never chain items.**

1. Read the relevant code and say in two sentences what you found and what you will change.
2. Make the change. Keep it to the one item.
3. Run the tests that cover it and report the **actual output**, not a summary.
4. Show the diff.
5. The human verifies in the browser. **Normally you do not commit** — suggest a one-line
   message and stop. On 2026-10-24 the human asked for commits, so it is allowed when they say
   so; when a change is really two changes, split it and verify each intermediate state passes
   the suite before committing it.

If an item turns out not to be trivial, say so and stop rather than pushing through it.

## Two rules that cost sessions days

**1. You are the model running on the server you are editing. NEVER restart it.**
The process serving port 8080 (`serve/server.py`) generates your turns. Restarting ends your
session mid-sentence. Changes take effect only on restart, so finish, verify, and tell the
human. Do not restart, and do not call `/unload`.

**2. Never write the chat template's control tags as literal text** — not in prose, not in
reasoning, not in code you display, and **not when quoting a log**. That is the thinking pair,
the tool-call pair and the turn pair. A consumer reads the text as a real boundary and cuts
your turn. Refer to them in words. In shell commands and tests build them from pieces
(`chr(60) + "/think" + chr(62)`). Markdown fences are safe.

This session died twice **while investigating that very bug**, because the agent pasted a line
of raw model output that contained a closing thinking tag. Reading such a log is fine; echoing
it is not. If you must discuss one, name the tag instead of reproducing it.

## Environment

- Fast tests:
  `.venv/bin/python -m unittest serve.test_frontend serve.test_parser_track serve.test_reasoning_tools serve.test_reasoning_rescue serve.test_chat_sidebar serve.test_mcp serve.test_mcp_round_history serve.test_abandoned_calls serve.test_fence_quoted_thinking serve.test_static_cache`
  → **166 tests, ~40 s**
- Full server suite: `.venv/bin/python -m unittest serve.test_server` → **313 tests, ~95 s**
- Web app harness: `node serve/test_chat_sidebar.js` → **47 `ok -` lines**, and
  `serve/test_chat_sidebar.py` runs it from Python. **Run both** for any `app.js` change.
  `node --check serve/web/app.js` for syntax. **Count the `ok -` lines**: a hanging harness
  exits 0 and prints nothing, which looks like a pass.
- Files: web app `serve/web/app.js`, `serve/web/index.html`, `serve/web/app.css`; server
  `serve/server.py`; parser `serve/frontend.py`; MCP hub `serve/mcp.py`.
- Settings live in `DEFAULTS` in `app.js` and persist through the `store` object
  (localStorage, key `strata.sampling`). Follow that pattern for new settings.
- Config `strata-iq3_s.json`, **actual values** (the previous handoff got one wrong):
  `reasoning_close_retry: true` (not `"calls"`), `reasoning_loop_recovery: "recover"`,
  `tool_call_recovery: true`, `fence_quoted_thinking: true`, `open_browser: false`,
  `start_beep`, and **`effort_position` is absent**, so it is the default `"start"`.
- The config's `env` block reaches **only the engine child** (`server.py:2626-2632`).
  Server-side vars like `STRATA_DEBUG` go in the shell that starts the server.
- Two logs. Engine stderr → `strata-iq3_s.log`. The server's own prints reach a file **only**
  if started with `... 2>&1 | tee -a /tmp/strata-server.log`. With `STRATA_DEBUG=1` that file
  contains the model's full raw output per request, so grepping a probe string matches the
  agent's own words about the probe. Anchor patterns (`^\[strata\] PATTERN`) or use `/metrics`.
- The MCP tool server is a separate process on `http://localhost:8643` ("easyCMP", 30 tools).
  It has crashed twice; if tools return "could not reach" that is it, not Strata.
- Web assets are served from disk with `Cache-Control: no-cache` plus an ETag, so an
  `app.js`/`index.html`/`app.css` change needs a **browser reload, not a restart**. A change
  that needs a matching server change will break the running page the moment you save it.

## What shipped on 2026-10-24 (four commits, all on `fork`, none pushed)

`4f26e5c7` one three-way **"Show thinking"** control — `Folded / Fold when done / Always`
(default *Fold when done*) — replacing four overlapping switches (`show`, `openthink`,
`opentools`, `autofold`). It governs **both** thinking blocks and tool-call blocks from one
key (`settings.show`). Old stored settings map to it once on load (`migrateShow`).
`a0bb1d98` a click on a tool block holds for the **turn**, not forever, and is no longer
written into the chat record.
`71a07306` LESSONS entries. `7e2a66a4`, `6b0dd108`, `fe0e3a33` and `b7929b54` are todo and docs churn
from the same day, including two renumber passes that the rename below undoes; the hashes are the
stable citation, the numbers in those messages are not.

The items those commits added are, by name: `fold-control`, `click-not-persisted`, `drawer-auto-apply`,
`no-scrim`, `send-spinner`, `hide-preview-when-open`, `server-before-model`, `test-command`,
`slow-death`, `recover-noop` and `dead-turn`.

Two mechanisms worth knowing before you touch either kind of block:

- A thinking run is not "over" just because it is the last one — while a tool round runs
  `thinkRuns` still reports one run. Two signals say it is finished: `cut` (a call starts
  where the run ends) and `tstart` (answer text grew past where the run began, stamped in
  `send()` as `m.rts`, numbers only so the replay is untouched).
- `toolSync` sets `d.open` itself, and a browser **queues** the `toggle` event. A one-shot
  `_auto` flag was the first guard and was wrong: two events in flight and the second is read
  as a click, which pins the block open. The tool branch now compares instead
  (`if (d.open === toolOpen(t)) return;`). The **thinking branch still uses the flag** and has
  the same weakness — if a thought is ever reported stuck open, give it the same treatment.

## The unresolved bug: turns that end badly (context, and two new findings)

Established earlier: not the engine — every request ends `finish: stop` with
`output_tokens == engine_generated`; it is the parser classifying the model's text. The real
fix is to stop representing boundaries as text: the engine has them as token IDs
(248068/248069 thinking pair, 248058/248059 tool-call pair, 248045/248046 turn pair, marked
special in `token_type.json`) and sends raw IDs on its `T` lines, but the server detokenises
and discards the ID at `server.py:3995`. Whether the engine forwards them is **unverified** —
check `generate.cpp:11818` before sizing it. The 37-case corpus
`serve/fixtures/rcall_specimens.json` already rejected the obvious rule "a real end is always
followed by a line break", so a smarter local heuristic is probably impossible. Run that
corpus before touching the parser.

**New, root cause written up in `strata-slow-death.txt`** (repo root, **untracked** — it is full of
literal control tags, so read it but never quote from it). It describes **three separate deaths**,
and conflating them wastes time:

1. **The slow death** (todo **72**). `reasoning_loop_recovery: "recover"` *fires* — "repeated
   reasoning detected at 2560 tokens (coverage=0.555); resuming the same output with the low-effort
   instruction" — and then the thinking counter sits at **exactly 2560** for minutes while the
   reported rate decays 88.5 → 29.3 tok/s. The turn neither advances nor ends. Both the freeze and
   the decay are **unexplained**; measure before fixing.
2. **The silent no-op** (todo **73**). `focused_recovery_prompt()` (`server.py:193`) splices token
   ids, swapping `HIGH_EFFORT` (= `EFFORT_TEXT["xhigh"]`, `server.py:157`) for `LOW_EFFORT` (158).
   It looks for xhigh because that is the template's **default** sentence and the rescue's job is to
   *lower* effort; it does not know the request's level. So a request that asked **low or medium**
   has no xhigh sequence, the function returns `None`, and nothing is recovered. This box's **own
   web traffic is not in that case** — the app sends `high`, and `chat_template.jinja:59-61` maps
   `high` to `xhigh`. Other clients that ask low or medium are. Fix: key the splice on the
   request's own level.
3. **The forged-boundary death** (todo **83**, and `LESSONS.md`). A turn cut because a boundary tag
   appeared as text. This session died twice because the agent *quoted* a log line containing one
   while investigating. No counter sees it: 0 `EMPTY TURN` lines across 2,024 requests.

Measured over 2,024 requests in `/tmp/strata-server.log`: 0 `EMPTY TURN` lines, 19
`reasoning_close_retry` rescues, 5 "tool calls inside the thinking", and 10 zero-token turns that
were all `finish=cancel` **mid-prefill** — the client giving up on a long read, which is a fourth,
unrelated thing — a client timing out on a long prefill, which is the re-read and start-up family
(items **70** and **92**), not a parser bug. So the counter built for the stalled-turn problem
cannot see it, and a counter that cannot see the bug is worse than none.

**The front end can already detect a dead turn.** `app.js:1342` computes
`hasOutput = !!m.text || !!(m.tools && m.tools.length) || !!m.error` and item no-placeholder uses it only to
hide the bubble. Nothing acts on it — so a Continue affordance, or an opt-in re-prompt, is one
boolean away. It would not have saved this session, because the agent harness is a different client.

## How to behave

- Verify in the code before claiming anything, and quote `file:line` you have actually read.
  Re-check line numbers after any edit that moves them: twice in one session numbers written
  from memory were wrong.
- When a test fails, work out whether the test or the code is wrong. Both directions happened
  this session: one assertion was a stale literal string, and one test passed only because the
  harness's IndexedDB stub aliased objects that a real store would clone.
- Scripted edits to markdown need a **read-back**: `todo` was corrupted twice by them. Verify
  counts and cross-references, not just exit code.
- Follow `AGENTS.md`: one change per commit, new behaviour opt-in, default path
  byte-identical, a test for anything you add, and a negative control that proves the test
  can fail. If a control does not fail, suspect the test — and if it cannot fail, the line may
  be dead weight.
- Do not edit the human's config without asking, and say plainly what you changed.
- Never describe your own change as pre-existing.
- Prefer "I don't know" or "this needs a measurement" to a confident guess.
- Finish the turn. Say what you did, what you did not, and what is unverified. Do not end a
  turn announcing work you have not run.
