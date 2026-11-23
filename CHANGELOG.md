# Changelog — this fork, since upstream `4079e5665`

## Conversations

- Many chats instead of one, kept in IndexedDB: a sidebar list, grouped by day and by quarter past a month, with rename, duplicate, export and delete on each row, and a draggable edge.
- Switch away from a chat while it is answering and come back — the turn belongs to its conversation, not to the page you were looking at.
- Each chat keeps its own unsent draft, and a blank chat is reused instead of stacking up.
- Row markers say what is happening where: a spinner while a turn answers there, a blue dot when a reply landed while you were elsewhere, an asterisk for an unsent draft.
- Ask before leaving the page while the model is thinking.

## Tools (MCP)

- Pick which tools a conversation can use, from a wrench panel next to the composer or a Settings tab; add, change and remove servers without editing a config file.
- A conversation keeps the tool list it started with, so a reload doesn't change what it sends. Switches apply at once, with Undo, and the cost of changing them is named in tokens before you pay it.

## Turns, thinking and tool calls

- Thinking and tool calls are laid out in the order they happened, with a collapsed block per round that previews one line and reports how long the model thought.
- One "Show thinking" control: folded, fold when done, always.
- A tool call streams the arguments as the model writes them instead of "(being written)".
- The answer is updated in place — settled blocks and icons keep their elements, so a streamed answer no longer rebuilds the whole bubble 25 times.
- Nothing pretends to be output: no placeholder, no fake caret, no empty bubble.
- A tool call the model opened but never finished, or one aimed at a tool nobody declared, is answered and reported instead of ending the turn silently.

## Editing, copying, importing

- Edit one of your posts and resend, delete a post, or delete the model's thinking and keep the answer.
- Copy at three sizes: the answer, plus thinking, plus everything including tool calls. Export a chat as Markdown named for the conversation.
- Import and export llama.cpp chats (JSONL and zip), with a picker, date range and attachment handling.
- Attach images and files to a message; a picture a tool returned shows in its block and replays correctly on later turns.

## Reliability

- A crash, an OOM kill or the machine sleeping no longer loses the last exchange — the record is written when you send, at the first token, when thinking ends, and at every tool call.
- Two tabs open in the same browser no longer overwrite each other's chats.
- Send in one chat while another answers; a message sent mid-turn waits on the record and fires when its turn is next.
- The port listens before the model finishes loading, so a request that arrives early waits and is served; `/health` reports `loading`, `load_seconds` and `load_error`.
- The page opens with the server stopped, through a network-first service worker — and editing the web app still needs only a reload.

## Reading the answer

- Markdown per author with an "md" switch on each message; settled thinking renders as markdown too.
- Fences that name a language are colored; a fence inside a bullet renders as a block; a growing block no longer flashes and can be scrolled while it is being written.
- ` ```html ` fences, and untagged ones that open with a doctype, `<html>` or `<body>`, render live in a sandboxed frame with copy / reload / source / split / full-screen controls. `<style>` and `<script>` inside are colored as CSS and JavaScript.
- Context fill on a finished answer, with a hover breakdown of prompt, reused and output tokens.

## Cost and configuration

- A per-chat system prompt, with `{{date}} {{time}} {{model}} {{gpu}} {{vram}} {{ram}} {{cpu}}` resolved once when the chat starts and frozen into the record.
- Prompt inspector: what this chat's request costs, measured by the server, running nothing — the tools block, the system prompt, the conversation.

## Engine and server behavior

- `--prompt-cache-spread` and `--conversation-cache-park-gain` ported from upstream; vision fixed.
- A tool-call round no longer forces a re-read of the thinking, with a toggle for sending it back.
- `fence_quoted_thinking` (off by default) keeps a thinking tag quoted inside a code fence from ending the reasoning mid-example.
- The reasoning-loop recovery keys on the effort sentence actually in the prompt, and each pass says where it is — a re-read now reads as reading the prompt instead of a stuck counter.
- `/metrics?lite=1` answers the status pill alone; polling backs off when the tab is idle or hidden. `start_beep` rings the terminal bell when the model is ready.
