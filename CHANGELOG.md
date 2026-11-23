# Changelog — this fork, since upstream `4079e5665`

## Code blocks

- Fences that name a language are colored — 13 families, about 100 language names. A fence with no language, or one the table doesn't know, looks exactly as before.
- A fenced block inside a bullet renders as a code block instead of literal backticks.
- A growing code block no longer flashes, and you can scroll it while the answer is still being written.
- ` ```html ` fences, and untagged fences that open with a doctype, `<html>` or `<body>`, render live in a sandboxed frame with copy / reload / source / split / full-screen controls. `<style>` and `<script>` inside are colored as CSS and JavaScript.
- The preview runs scripts but can't read this browser's chat data or act as the page.
- Split and full-screen sizes are correct; the board fills the pane instead of sitting in a 150 px strip.
- Space no longer re-toggles the last button you clicked, so it reaches a game or form in the preview.

## Chat and the sidebar

- Send in one chat while another is answering. A message sent mid-turn waits on the record and fires when its turn is next; Cancel returns the text, and it survives a crash or a reload.
- The chat record is written when you send, at the first token, when thinking ends, and at every tool call — a crash or the machine sleeping no longer loses the last exchange.
- Two tabs over one browser no longer overwrite each other's chats.
- The gutter mark carries the phase: reading, answering, waiting on a tool, queued.
- The list order follows when you send, not when the answer lands, so two running chats stop leapfrogging.

## Prompts and cost

- A per-chat system prompt, with `{{date}} {{time}} {{model}} {{gpu}} {{vram}} {{ram}} {{cpu}}` resolved once when the chat starts and frozen into the record.
- Prompt inspector: what this chat's request costs, measured by the server, running nothing. A chat pins its own tool list, and the wrench shows that list rather than the config's.

## Server

- The port listens before the model loads, so a request that arrives mid-load waits and is served. `/health` reports `loading`, `load_seconds`, and `load_error`.
- The page opens with the server stopped, through a network-first service worker. Editing the web app still needs only a reload.
- Tool calls are answered in the order the model wrote them, and a call that was opened but never finished is answered rather than run.
