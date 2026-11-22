# Changelog — this fork, since upstream `4079e5665`

34 commits, 2026-11-21 and 2026-11-22. Grouped by what changed for the person using the page, not by commit.
Every number here was measured on this box (2 × RTX 3090 Ti, i9-12900K, 96 GB, `qwen3.8-flash-next-iq3_s`)
unless it says otherwise.

## Code blocks and markdown (web app, no restart needed)

- **Syntax colouring** (`code-syntax-highlight`). A fence that names a language colours its comments, strings,
  numbers and keywords — 13 rule families, 103 language names, 65 rules, one compiled regex per family, no
  dependency and nothing fetched. A fence that names nothing, or a name the table does not know, is byte for
  byte what it was: `esc(code)`, no spans. Cost, measured: 2,000 chars 0.12 ms / 175 spans, 8,000 0.21 ms /
  713, 20,000 0.49 ms / 1,781, 40,000 0.95 ms / 3,564 — so a block over 20,000 characters goes out plain.
- **A fence inside a bullet** (`fence-in-list`). An indented ```` ```bash ```` under a `-` item was never seen by
  the fence scanner (it only stripped column-0 fences), got folded into the bullet's text, and the inline-code
  rule ate one pair of the three backticks: the command came out as inline code with a literal `` on each side
  and its line breaks gone. A list item is now a list of parts, and a fence indented up to six spaces is a
  fence. Side effect kept: lines inside a fence are never tested against the blockquote or bullet rules.
- **No more flashing while it writes** (`code-block-grow`). The growing block was rebuilt whole — 40
  whole-`<code>` assignments and 336,545 characters of rebuilt HTML for one 6,090-character fence. It is now
  grown: settled tokens live in an append-only span and only the tail is rewritten — 1 assignment, about 10×
  less work. Which tokens are allowed to settle turned out to be the hard part.
- **Scrolling a code block** (`code-block-scroll`). Two causes, found one after the other: the block's `<pre>`
  was replaced every frame (taking its scroll position with it), and it had `overflow:auto` with **no height
  limit**, so it could never scroll at all and "scroll the block" meant scrolling the chat, which the page was
  pulling back to the bottom. Now the `<pre>` survives, the block has its own 65 vh scroll box, and it follows
  the tail only if you were already at the bottom.
- **Live HTML blocks** (`html-block-preview`). A finished ```` ```html ```` fence — or an untagged one that opens
  with a doctype, `<html>` or `<body>` — renders as a sandboxed iframe (`allow-scripts allow-modals`, never
  `allow-same-origin`) with **copy · reload · source · split · full screen** controls. While the block is still
  being written it stays highlighted source: a half-written page is never previewed. `<style>` bodies are
  coloured as CSS and `<script>` bodies as JavaScript. Verified in headless Chrome: the frame's scripts run, and
  both directions of cross-document access raise `SecurityError`.
- **Controls that cannot go blank.** They are inline SVG, not `<use>` references: the icon sprite is inlined into
  the page at request time, so a page loaded before a symbol exists renders an empty button. That is why they
  looked black or missing. They also have an explicit 28 px target and a 17 px glyph.
- **Split and full screen sizing.** An `<iframe>` is a replaced element, so a grid does not stretch it the way it
  stretches a `<pre>`; `height:auto` meant the intrinsic 150 px strip. Split panes and the maximized view now
  carry explicit heights.
- **Focus and the Space key.** A clicked button keeps DOM focus and re-activates on Space, so after clicking
  Split, Space kept toggling Split instead of reaching the game in the preview. Pointer-driven controls now give
  focus back (`e.detail` non-zero); keyboard-driven ones keep it, so Tab still works. The preview iframe is
  `tabindex="0"` so a keyboard reader can enter it deliberately.

## Chat, turns and the sidebar (web app)

- **One turn per conversation** (`turn-lock-per-conversation`). The page sends `strata_conv`; the server holds a
  refcounted per-conversation lock around the whole turn, tool rounds included, and answers 409 `model_busy`
  after 300 s rather than waiting forever. `/metrics` `live.conv` names the conversation the engine holds.
- **Send in one chat while another answers** (`queue-other-chats`, `queue-another-chat`). A single busy flag
  became a list of turns; a message sent mid-turn becomes a queued post on the record — shown in the chat,
  Cancel returns the text — that fires when its turn is next. A queued post that came back from the record
  waits for a Send click: a reload is not a request to continue.
- **A crash no longer loses the last exchange** (`crash-recovers-last-turn`). The record is written when the
  question lands, at the first token, when the thinking ends, and at every tool call and result.
- **Two tabs, one database** (`multi-tab-sync`). Every write stamps `rev` and posts on `BroadcastChannel`; the
  other tab re-reads before it writes; deletes tombstone in both. Guards: do not adopt into a chat this tab is
  streaming into, do not adopt while an edit box is open, `writeChat` refuses a tombstoned id, Undo broadcasts.
- **The gutter mark carries the phase** (`sidebar-spinner-states`): blue reading, green answering, grey waiting
  on a tool, amber queued. Marks are nodes that get recoloured, not strings rebuilt — a replaced node restarts
  its animation. The "Waiting · tool" pill and badge are grey, the Idle colour.

- **The list order belongs to your send** (`sidebar-order-on-send`). `saveChat` stamped the chat's timestamp on
  every write, and the record now writes at every milestone of a turn, so two running chats leapfrogged over
  each other several times a turn. The stamp moved to the moment you send; the time shown on a row is now when
  you sent, not when the answer happened to finish.

## Prompts, settings and what a chat costs (web app + server)

- **A per-chat system prompt** (`system-prompt`). A Settings card; `{{date}} {{time}} {{model}} {{max_context}}
  {{gpu}} {{vram}} {{ram}} {{cpu}}` resolved **once at chat start** and frozen in the record, because a date
  that changes mid-conversation would make the engine re-read the whole history. Shown as an editable row above
  the first message, with the re-read cost named. The server needed nothing: the template already merges
  leading system messages.
- **The prompt inspector** (`prompt-inspector`). `POST /inspect` renders the request's own prompt and returns the
  parts, running nothing. Measured here: the tools block is **4,117 tokens for 16 tools** — 3,904 of it the
  servers' own schemas; five disabled tools in the config save **2,776 tokens per request**; the reasoning-effort
  sentence is 42 tokens at xhigh, 30 at low, none at medium. A chat pins its own tool list, the wrench shows
  that list rather than the config's, and a blue dot marks the difference.
- **UI captions that state what you already see were deleted** — three of them, and pinned so they stay deleted.

## Server and start-up

- **The port listens before the model loads** (`server-before-model`). The model loads on a thread holding the
  FIFO, so a request that arrives mid-load waits and is served. `/health` carries `loading`, `load_seconds`
  (79.5–81.6 s for this model on this box) and, when it fails, `load_error`.
- **The page opens with the server stopped** (`offline-web-assets`). `sw.js` is network-first and caches only when
  the fetch fails, so "edit app.js, reload, no restart" stays true. API paths, POSTs and other origins are never
  intercepted; `localhost` only, because a service worker will not register on a LAN address over plain http.
- **Tool-call recovery** (`unread-call-recovery`). The round the loop answers keeps the order the model wrote the
  calls in (a mixed round once re-read 36,281 of 87,463 prompt tokens, 14.4 s); the cap on answered bad calls
  counts a streak, not the request; and a call opened and never finished is answered and never run.
- **Never run an agent turn with no tools block, silently** (`tools-block-empty`): instrumented, partly repaired.

## Tests, harness and lessons

- Node harness `serve/test_chat_sidebar.js`: **102 → 107 `ok -` lines** (cases 113–117), plus a stub fix —
  `classList.toggle` was an empty function, so a page that keeps its state in classes could not be tested.
- Python: fast suite **273 → 275**, `serve.test_server` + `serve.test_responses` **357 OK**, service-worker
  harness **5**.
- **47 negative controls** across the four code-block items; every one of them bit. Two controls initially did
  not, which exposed assertions that were not testing anything, and they were rebuilt.
- `LESSONS.md` gained: the reasoning-recovery re-read measurement; `]` closes a regex character class (second
  time in the same renderer); check the units of your own probe before quoting its number; tokenizing a growing
  text is not stable; a per-frame element swap is invisible until the reader scrolls something; markup the
  renderer emits cannot depend on the page's icon sprite; a button you clicked with the mouse still owns the
  Space key.

## Known open now

- The Stop button's scope across several running chats needs checking against `busy` / `rebindBusy`.
- A "queue until the other chat is completely done" control, beyond the current per-chat queue.
- `slow-death` is measured but not fixed: the reasoning recovery splices the effort sentence into the **head** of
  the prompt, so the conversation cache misses entirely — `0 reused + 66,079 read in 26,074 ms`, ending
  `cancel=True` with **1 output token** — and the spliced prompt is a *different* conversation to the cache, so
  it parked a duplicate ~1.7 GB entry and evicted another chat. The fix is to append the instruction as a
  trailing turn instead of editing the head. Needs a restart.
