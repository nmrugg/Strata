# Handoff prompt — Strata, 2026-10-23

Paste everything below the line to a fresh agent.

---

You are working on Strata at `/programs/Strata` (branch `fork`, remote Niko1221/Strata).
Read `AGENTS.md`, **`LESSONS.md`**, and `/programs/Strata/todo` (33 items, sorted by effort) first.

`LESSONS.md` is the running record of things that cost time to discover. It is not optional
reading, and **you are expected to add to it**: when you find something the hard way - a
config key that silently does nothing, a log that is missing by default, a rule real
recorded data already rejected, a claim you got wrong - append one short entry with the
evidence and the `file:line` you read. Prefer a measured number to an adjective. If an
entry stops being true, delete or correct it rather than leaving it.

Two of its entries are worth repeating, because breaking them wastes your whole session:
never restart the server (it is generating you), and never write the chat template's
control tags as literal text anywhere in your output.

## Your job

Work the **Trivial** tier of `todo` — items 2 through 8 — **one at a time**, in this order.
Item 1 (warn on closing while a request runs) is **already done**, commit `7a6e63ac`; do not
redo it. Standing instruction from the human: **no legacy browser fallbacks** — current
browsers only (see `LESSONS.md`, "No legacy browser fallbacks").

| # | item | shape |
|---|---|---|
| 2 | Play a sound / beep on start up | `app.js`, maybe one server line |
| 3 | Option: auto-expand thinking | `app.js` + `index.html` |
| 4 | Option: auto-expand tool calls | same |
| 5 | Toggle markdown vs plain text for my own messages | `app.js` |
| 6 | Render my own messages as markdown | `app.js` |
| 7 | Stop the UI flashing while the model writes | `app.js` re-render path |
| 8 | Be able to open and close thinking / tool calls while the engine is writing | `app.js` |

Do 2, stop, and wait. **Never chain items.** The workflow is:

1. Read the relevant code and tell me in two sentences what you found and what you'll change.
2. Make the change. Keep it to the one item.
3. Run the tests that cover it (below) and report the actual output, not a summary.
4. Show me the diff.
5. **I verify it in the browser and I commit it myself.** You do not commit. Suggest a
   commit message in one line and stop there.

If an item turns out not to be trivial, say so and stop rather than pushing through it.

## Two rules that cost the last session days

**1. You are the model running on the server you are editing. NEVER restart it.**
The process serving port 8080 (`serve/server.py`) is what generates your turns. Restarting
it ends your session mid-sentence. Code and config changes take effect only on restart, so
finish, verify, and tell me to restart. Do not restart, and do not call `/unload`.

**2. Never write the chat template's control tags as literal text** — not in prose, not in
reasoning, not in code you display. That includes the thinking pair, the tool-call pair,
and the turn pair. The last session died about six times in one day because its own output
contained them and some consumer read the text as a real boundary. Refer to them in words.
In shell commands and test files, build them from pieces (`chr(60) + "/think" + chr(62)`)
so the literal sequence never appears in your output. Markdown fences are safe.

## Environment

- Fast tests:
  `.venv/bin/python -m unittest serve.test_frontend serve.test_parser_track serve.test_reasoning_tools serve.test_reasoning_rescue serve.test_chat_sidebar serve.test_mcp serve.test_mcp_round_history serve.test_abandoned_calls serve.test_fence_quoted_thinking serve.test_static_cache`
- Full server suite (~95 s): `.venv/bin/python -m unittest serve.test_server` (311 tests)
- The web-app JS has its own harness: `node serve/test_chat_sidebar.js`, and
  `serve/test_chat_sidebar.py` runs it from Python. **Run both** for any `app.js` change.
  `node --check serve/web/app.js` to catch syntax errors.
- Files: web app `serve/web/app.js` and `serve/web/index.html`; server `serve/server.py`;
  parser `serve/frontend.py`; MCP hub `serve/mcp.py`.
- Settings live in `DEFAULTS` in `app.js` and persist through a `store` object
  (localStorage) — follow that existing pattern for new toggles rather than inventing one.
- `markdown()` already exists in `app.js` and is applied to assistant turns only; items 5
  and 6 extend it to the user's own messages. Check how it escapes HTML before you widen it.
- Config: `strata-iq3_s.json`. Live flags: `reasoning_close_retry: "calls"`,
  `reasoning_loop_recovery: "recover"`, `tool_call_recovery: true`,
  `fence_quoted_thinking: true`, `open_browser: false`.
- The config's `env` block reaches **only the engine child process** (`server.py:2626-2632`).
  Server-side env vars such as `STRATA_DEBUG` must be set in the shell that starts the
  server, not in the config.
- Two separate logs. Engine stderr → `/programs/Strata/strata-iq3_s.log`. The server's own
  prints go to the terminal and are captured **only** if started as
  `.venv/bin/python serve/server.py --engine strata --config strata-iq3_s.json --port 8080 2>&1 | tee -a /tmp/strata-server.log`
  With `STRATA_DEBUG=1` that file holds the model's full raw output per request, so
  `grep` for a probe string will match the agent's own text about that probe. Anchor
  patterns (`^\[strata\] PATTERN`) or read `/metrics` counters instead.
- The MCP tool server is a separate process on `http://localhost:8643` ("easyCMP", 30
  tools). It has crashed twice. If tools return "could not reach", that is the tool server,
  not Strata — say so instead of guessing.

## Do not re-litigate these

The previous session claimed six things "already exist". Five were wrong or only partly
true and have been removed from `todo`. Verified now:

- **Browser on start** — done, but **not pre-existing**: `open_browser: false` was added to
  `strata-iq3_s.json` during this session by the previous agent, not by the human and not by
  upstream. `--open` makes the server call `webbrowser.open()` once the model is ready, and
  `setup.py:4410` only appends `--open` when `open_browser` is not `false`. A fresh checkout
  would not have it. Closed here; do not describe it as already configured.
- **Pinning a conversation, keeping it on disk, and never evicting it** — these were three
  separate todo items and they are one want. Merged into item 16, which is **not** done and
  is not trivial.
- **Parking conversations** — believed to work and measured once (326 ms for 193,453
  tokens), but the "always cached" promise was never demonstrated. Do not claim it works.
- **Markdown** — the renderer exists but is not applied to the user's messages, which is
  exactly items 5 and 6. Not done.
- **Stop button** — was listed as an open item by mistake; it works. Nothing to do.

Item 16 is the one real design question in the file: making a conversation near 1M tokens
always fast to open. Measured here: parked state is 19.1 KB per token, so 1M tokens is
~18 GiB; NVMe does 2.3 GB/s write and 3.2 GB/s cold read, so ~8 s to save and ~6 s to
resume against ~500 s to re-read. RAM cannot hold one such chat. **Do not start that item
with code** — it needs a decision first, and it is not part of your task today.

## The unresolved bug (context only — not today's task)

Turns that deliver nothing, and thinking tags / literal backslash-n pairs appearing as
visible output. Established: not the engine — every request ends `finish: stop` and
`output_tokens == engine_generated`. It is the parser classifying the model's text.

Committed and available: a probe that prints
`EMPTY TURN: ... (state=... held=... abandoned=... reasoning_tokens=...)` and counts
`totals.empty_turns` / `totals.abandoned_tool_calls` in `/metrics`.

Important negative result: the widening behind `reasoning_close_retry: "calls"` targets
parser state `rcall`, which has **never appeared in the real log**. The test that appeared
to verify it used synthetic input the previous agent invented. Treat that mode as
unproven. Also established: the shipped 37-case corpus
(`serve/fixtures/rcall_specimens.json`) rejects the obvious rule "a real end is always
followed by a line break", so a smarter local heuristic is probably impossible. The real
fix is to stop representing boundaries as text — the engine knows them as token IDs
(248068/248069 think pair, 248058/248059 tool-call pair, 248045/248046 turn pair, marked
special in `token_type.json`) and sends raw IDs on its `T` lines, but the server
detokenises and discards the ID at `server.py:3995`. Whether the engine forwards those IDs
is **unverified** — check `generate.cpp:11818` before sizing that work.

## How to behave

- Verify in the code before claiming anything. Quote `file:line` you have actually read.
  The last session asserted line numbers and mechanisms it had not checked and was wrong
  repeatedly.
- When a test fails, check whether your test or the code is wrong — do not assume.
- Follow `AGENTS.md`: one change per commit, new behaviour opt-in, default path
  byte-identical, and a test for anything you add.
- Prefer saying "I don't know" or "this needs a measurement" to a confident guess.
