# Pinning a conversation so it is always fast to open

Design spec for todo item 16. Nothing here is built; the measured numbers are from this
box on 2026-10-23 and are labelled with what produced them.

## The want

One control on a chat: "this one stays cached". Open it later — including after Strata was
stopped and started again — and it resumes in seconds instead of re-reading. Today that
promise does not exist: the live conversation cache is LRU with a byte budget, so a
conversation is dropped as soon as something else needs the room, and nothing at all
survives a server restart.

## What already exists

| piece | state |
| --- | --- |
| Engine verbs `SAVE <path>` / `RESTORE <path>` (`generate.cpp:9888-9912`) | built; valid only **between requests**; answers `SAVED <tokens> <bytes> <ms>`, `RESTORED <tokens> <bytes> <ms>`, or `SERR <invalid\|storage\|memory\|io> <published 0\|1> <reason>` |
| `POST /slots/0?action=save\|restore` with `{"filename": NAME}` | built; needs `slot_save_path` in the config, and the path is confined to that directory (`slot_save_dir`, `server.py:2848`) |
| File format | built: `STRSESS\x01` header, model fingerprint and config fingerprint, then geometry, layer range, live state, checkpoints, every K/V part and the draft K/V |
| Validation on restore | built: bounds-checked while parsing, before any array is allocated, then the whole image checked against this engine; a file from another model or configuration is refused |
| RAM guard on restore | built: reading the file must leave `--conversation-cache-min-free-mib` (default 2560) free |
| Disk guard on save | built: `--session-min-free-mib` (default 4096) must remain free where the file is written |
| Automatic save/restore keyed to a conversation | **missing** — this is the whole item |

`slot_save_path` only turns on the manual endpoint. It does not save on idle, on unload, or
on switching chats, and it has no idea which conversation a file belongs to.

## The measured cost of a conversation

Session files and parked conversations hold the same thing, and two independent
measurements agree: the server's own start line says "about 1.2 GB per 63K-token
conversation" (`server.py:6578`), and this box measured 3,783,989,232 bytes for 193,453
parked tokens from the park log.

That gives **19,560 bytes per token** of conversation state, which is what every figure
below is computed from. It is not a constant across configurations - it is this model at
this KV format (int8, 12 full-attention layers, 2 KV heads, 256 dims, plus the draft ring
and indexer rows) - so re-measure it before quoting it for another model or `--kv` setting.

| conversation | state size | save at 2.3 GB/s | restore at 3.2 GB/s | re-read at ~2,000 tok/s |
| --- | --- | --- | --- | --- |
| 63,000 tokens | 1.15 GiB | ~0.5 s | ~0.4 s | ~32 s |
| 193,453 tokens | 3.52 GiB | ~1.7 s | ~1.2 s | ~97 s |
| 352,542 tokens | 6.42 GiB | ~3.0 s | ~2.2 s | ~176 s |
| 602,142 tokens | 10.97 GiB | ~5.1 s | ~3.7 s | ~301 s |
| 1,000,000 tokens | 18.22 GiB | ~8.5 s | ~6.1 s | ~500 s |

NVMe measured on this box (Seagate FireCuda 520, ext4, `dd ... oflag=direct`, 3 GiB):
**2.3 GB/s write, 3.2 GB/s cold read.** The save and restore columns are the file transfer
only - parse, validate and the engine's device writes are not measured and will add to
them. The re-read column is measured directly: a 533,954-token prompt took 332 s.

Parking in RAM was measured directly: **326 ms** for 193,453 tokens, against ~1.2 s to
restore the same state from disk. So RAM is roughly 3x faster and costs ~300x more of it.

The current 4,096 MiB park budget therefore holds **~219,600 tokens** - one mid-sized chat.
50 GB free on `/` holds about two 1M-token session files.

## The blocker before any of this pays off

**Restoring state is useless unless the next request's tokens still match it.** Reuse is
exact token-prefix matching with no client session ID (`DETAILS.md`, "Multiple
conversations"). A restore loads the engine's state; the client must then send a prompt that
begins with exactly those tokens, or the engine falls back to the pinned root and re-reads
everything anyway.

That is not hypothetical. On 2026-10-23 a chat re-read 211,745 tokens because the web app
rebuilt a tool round's history without the thinking the server had put in the prompt, so the
prefix stopped matching. Pinning would not have helped that turn: the state was there, the
prompt did not match it.

So the order matters: **history rendering must be byte-stable across sessions before
persistence is worth building.** The `strata_mcp_thinking` switch (off by default, matching
what the web app already sends) is what makes that true today. Item 16 assumes it.

## The identity gap

The server has never seen a conversation ID. The web app has one — a chat id in IndexedDB —
and never sends it. Two ways to close it:

1. **Client sends it.** A new request field naming the conversation. Simple, explicit, and
   it makes the server's bookkeeping honest. Cost: it is a new API surface, and any client
   can claim any id, so it needs the same origin/API-key guards as the other admin paths.
2. **Server derives it.** A hash of the conversation's first N tokens after the system turn.
   No API change, and it already resembles how replicas route (`serve/replicas.py` tracks
   hashes of 64-token blocks of what each replica holds). Cost: it breaks whenever the front
   of the chat changes — an edited system prompt, a different tool list, a different
   reasoning effort — which is exactly when you would want the pin to survive.

Option 1 is the one to build. Option 2 is a fallback for clients that will not change.

## Shape of the feature

**Phase 0 — measure with what exists, no code.** Set `slot_save_path`, then by hand: switch
to the chat, `action=save`, restart, `action=restore`, send one message and read the
`reused` figure in `/metrics`. This answers the two questions the whole spec depends on:
how long a real 600K-token restore takes including validate and device writes, and whether
the client's next prompt actually matches the restored state. Everything below is cheaper
to decide after that one measurement.

**Phase 1 — save.** Write the session file when a conversation stops being the live one:
on switch away, on idle, and on unload. One file per conversation id, plus a small index
recording id, path, token count, and the last saved prefix hash. Reuse the existing
`SAVE` verb and its disk guard; the retry wrapper in `serve/session_save_retry.py` already
handles a refused save.

**Phase 2 — restore.** On opening a pinned chat — focus, or first keystroke, which is
item 24 — issue `RESTORE` for that id before any request is sent. The engine only accepts
it between requests, so this must land in the FIFO gap, and it must be cancellable: a
restore that is still running when the user sends should not block them (the single-slot
FIFO makes a naive version worse than today).

**Phase 3 — the disk tier for the park cache** (item 23). At that point "pinned" stops
meaning "restore a file into the one live slot" and means "the park cache spills to disk",
which is what makes several pinned chats coexist. Do not build this before Phase 2 has been
measured.

## Limits that will bite

- **One live slot.** Save and restore are per-slot and only valid between requests, so a
  restore occupies the FIFO. An 11.0 GiB restore is seconds of I/O that another user's
  request waits behind.
- **RAM to read the file.** Restore admits only if it can leave 2,560 MiB free after the
  parse. An 11.0 GiB file needs that much RAM in reach; this box has ~40 GiB available with
  27 GiB already in swap. Paging a parked or restored conversation is itself a documented
  stall cause (#2049, #2065), so "restore from disk" can degrade into "page 10 GiB back
  in".
- **Disk space.** 18 GiB per pinned 1M-token chat. `/` has ~50 GB free, so about two.
  The disk guard refuses rather than filling the drive, which means a save can silently not
  happen — the index needs to record whether each pin is actually saved or only requested.
- **Privacy.** This writes full conversation text to disk, unencrypted, and today's
  `STRATA_DEBUG` raw dumps already do something similar to a log file. It needs a stated
  retention rule, and it must not capture request bodies carrying an API key.

## The decision this spec is asking for

For conversations near 1M tokens, "always cached" cannot mean RAM: 18.2 GiB each, with a
4 GiB park budget and 27 GiB in swap. So it has to be one of:

- **A disk promise** — ~6 s to resume, ~8 s to save, 18 GiB of disk per pinned chat, and a
  restore that blocks the single slot.
- **A size limit** — keep chats under the cliff (the current 4 GiB budget holds ~220K
  tokens; 17 GiB would hold ~935K but that RAM is not honestly free), and let new chats
  start fresh.

Both are defensible. The first is worth building only after Phase 0 shows that a real
restore lands a prompt the client actually matches.
