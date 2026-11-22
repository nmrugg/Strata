"""The chat sidebar: the conversations kept in this browser, the open one on the screen.
The feature is opt-in; with the switch off the page is the page from the last release.

The checks read the page and the script as text, like test_monitor.py's page check: a function body where the
check is about what a function does, and a string where the check is about a storage key or a message the user
sees. What the storage path does is run against app.js in test_chat_sidebar.js, with a stub DOM and a stub
IndexedDB; that one is skipped on a machine without node.
"""
import json
import re
import shutil
import subprocess
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from serve.frontend import ChatTemplate
from serve.server import ByteTokenizer, MockEngine, Service, serve


class ChatSidebar(unittest.TestCase):
    def setUp(self):
        web = Path(__file__).parent / "web"
        self.html = (web / "index.html").read_text(encoding="utf-8")
        self.js = (web / "app.js").read_text(encoding="utf-8")

    def body(self, name):
        """the source of a function, so a check is about what it does, not about one line of it"""
        found = re.search(rf"function {name}\(.*?\n}}", self.js, re.S)
        self.assertTrue(found, f"{name} is not in app.js")
        return found.group(0)

    def test_the_page_has_the_sidebar_and_its_switch(self):
        for el in ("sidebar", "sidebar-toggle", "sidebar-search", "sidebar-list", "sidebar-foot"):
            self.assertIn(f'id="{el}"', self.html)
            self.assertIn(f'"{el}"', self.js)
        # the sidebar is no longer hidden until a switch is turned on (todo #drop-single-chat): the list IS the page
        self.assertIn('id="sidebar" data-open="true" aria-label="Chats">', self.html)
        self.assertIn('[hidden] { display: none !important; }', (Path(__file__).parent / "web" / "app.css").read_text(encoding="utf-8"))

    def test_a_tool_call_shows_what_the_model_is_typing(self):
        # todo #tool-args-stream: the page asks for a call's argument pieces as they are written and shows them in the block,
        # instead of a static "(being written)".  serve/test_mcp.py pins the server half.
        self.assertIn("body.strata_mcp_args = true;", self.js)
        self.assertIn('x.event === "args"', self.js)
        self.assertIn('delete t.argsText;', self.js)          # the finished arguments replace the streamed text
        self.assertIn("(t.arguments != null ? JSON.stringify(t.arguments, null, 2) : (t.argsText || \"\"))", self.js)

    def test_a_chat_row_marks_what_is_happening_in_it(self):
        # one state slot per row, before the name: run (a turn answering there now), new (a reply that landed
        # while you were elsewhere), draft (text you typed and never sent). One at a time, that priority.
        css = (Path(__file__).parent / "web" / "app.css").read_text(encoding="utf-8")
        draft_rule = re.search(r"\.chat-item__title\.draft::before \{([^}]*)\}", css).group(1)
        self.assertIn('content: "*"', draft_rule)
        self.assertNotIn("color", draft_rule)             # the row's own ink; colour means something else here
        # run/new live in a 12px gutter on the row, absolutely placed: they cost no title width on any row
        self.assertIn("position: relative; padding-left: 12px;", css)
        self.assertIn(".chat-item__state { position: absolute; left: 4px;", css)
        # 4px in rather than a smaller ring: at left 0 the 12px ring touched the row's 10px corner radius and
        # looked like it was leaving the highlighted row; one more pixel of clearance reads better (the owner,
        # 2026-11-22). Size unchanged.
        self.assertIn(".chat-item__state.run::before { content: \"\"; position: absolute; inset: 0;", css)
        self.assertIn(".chat-item__state.run::before", css)
        # the slot is only emitted when there is a marker, so an ordinary row keeps its full title width; and it
        # is a node of its own, because a node thrown away and made again restarts its spin
        self.assertIn("paintMark(row, c);", self.body("chatItem"))
        self.assertIn('node("span", `chat-item__state ${want.cls}`)', self.body("paintMark"))
        self.assertIn("mark.className =", self.body("paintMark"))          # recoloured in place, not remade
        self.assertIn("const sameShape = plan.length === kids.length", self.body("renderSidebar"))
        self.assertNotIn("margin-left: 8px", css)                     # no fixed left slot costing every row width
        self.assertIn("animation: st-spin 0.9s linear infinite", css)     # happening now: accent, spinning
        self.assertIn(".chat-item__state.new::before", css)
        self.assertIn("background: var(--st-info)", css)                  # happened: blue, go read it
        item = self.body("chatItem")
        # the gutter mark carries the engine's phase, in the colours the pill and the Monitor already use
        # (todo #sidebar-spinner-states); the behaviour itself is driven in the node harness, case 108
        self.assertIn("(own || waiting) && (c.id !== chatId || showSpin)", self.body("markFor"))   # a turn, or a queue waiting
        self.assertIn('return {cls: `run ${phase}`, tip: PHASE_TIP[phase]};', self.body("markFor"))
        for phase, colour in (("read", "--st-info"), ("wait", "--st-ink-muted"),
                              ("queue", "--st-warn-text")):     # the badge's colour, not the pill's
            self.assertIn(f".chat-item__state.run.{phase} {{ --spin: var({colour}); }}", css)
        # every phase spins, including queued - only reduced motion stops it (the owner, 2026-11-22)
        self.assertNotIn(".chat-item__state.run.queue::before { animation: none", css)
        self.assertIn("@media (prefers-reduced-motion: reduce)", css)     # the spinner does not have to spin
        self.assertIn("refreshSpinners();", self.body("poll"))            # the mark follows the phase, per poll
        self.assertIn("if (renaming) return;", self.body("refreshSpinners"))   # and never over a rename
        self.assertIn("$(" + '"spin-toggle").onclick', self.js)           # the always-show switch
        self.assertIn("renderSidebar();", self.body("setBusy"))          # the list follows turn start/end
        self.assertIn("turn.chat.unread = true;", self.body("startTurn"))
        self.assertIn("c.unread = false;", self.body("showChat"))

    def test_a_long_code_line_cannot_push_the_page_wide(self):
        # a bubble is a flex item sized to its content, so one long line in a <pre> made a user's post wider than
        # the message. The assistant bubble was capped, the user's was not. (CSS only: the harness cannot measure
        # layout, so the width itself is the human's to confirm in a browser.)
        css = (Path(__file__).parent / "web" / "app.css").read_text(encoding="utf-8")
        self.assertIn(".st-bubble { max-width: 100%; min-width: 0; }", css)
        self.assertIn(".st-bubble .st-code { min-width: 0; }", css)
        self.assertIn(".st-bubble .st-code pre { max-width: 100%; overflow-x: auto; }", css)

    def test_the_copy_sizes_and_the_file_name(self):
        # todo #copy-whole-turn: plain click copies the answer, Shift adds the thinking, Ctrl/Cmd+Shift adds the tool calls.
        # The saved file is named for the conversation, not just for the day.
        self.assertIn("const level = (e.ctrlKey || e.metaKey) && e.shiftKey ? 2 : (e.shiftKey ? 1 : 0);", self.js)
        # one builder for the clipboard and the file: the human asked for the copy to look like the export, so
        # turnMarkdown takes the level and there is no second formatter that could drift
        self.assertIn("function turnMarkdown(m, level = 2)", self.js)
        self.assertNotIn("function turnText", self.js)
        self.assertIn('const txt = (m.role === "user" || !level) ? (m.text || "") : turnMarkdown(m, level);', self.js)
        self.assertIn("function safeFileName(t)", self.js)
        self.assertIn("a.download = name;", self.js)
        self.assertNotIn("a.download = `strata-chat-", self.js)          # the day-only name is only a fallback now
        self.assertIn('chatTitle(chat || {title: "", messages})', self.js)   # works with the sidebar on or off

    def test_the_saved_markdown_follows_the_screen(self):
        # the export used to write three piles (all thinking, then every call, then the text).  It now walks the
        # same parts the bubble draws, so the two cannot drift apart again.
        self.assertIn("for (const p of bubbleParts(m)) {", self.body("turnMarkdown"))
        self.assertNotIn("const tools = (m) =>", self.js)
        self.assertNotIn("<summary>Thinking</summary>", self.js)
        self.assertIn("function toolMarkdown(t)", self.js)

    def test_a_turn_keeps_its_own_conversation_while_you_read_another(self):
        # todo #switch-while-running: switching chats mid-answer used to be refused, and the reason it could not simply be allowed
        # is that send() captured one element and renderChat() destroys them all (LESSONS.md, render-path trap 1).
        # The turn now belongs to a chat, and the row is looked up each frame.
        self.assertIn("function rowOf(m, c = chat)", self.js)
        self.assertIn("const el = rowOf(m, c); if (el)", self.body("startTurn"))
        # the turn records which conversation it belongs to - and with the queue it can belong to one that is
        # not on screen at all
        self.assertIn("const turn = {controller, msg: m, chat: c, chatId: c.id};", self.js)
        self.assertIn("turns.push(turn);", self.body("startTurn"))
        self.assertIn("const turnIn = (id) => turns.find((t) => t.chatId === id) || null;", self.js)
        self.assertIn("saveChat(turn.chat);", self.body("startTurn"))
        self.assertNotIn("$(\"chat\").lastElementChild", self.js)          # the capture that made this unsafe is gone
        self.assertIn("function saveChat(c = chat)", self.js)
        oc = self.body("openChat")
        self.assertNotIn("Still writing", oc)                             # reading another chat is allowed now
        # deleting a chat that owns a turn is not allowed - and with a turn per chat, "owns a turn" is per chat
        self.assertIn("if (turnIn(c.id))", self.body("deleteChat"))

    def test_the_composer_keeps_its_text_per_conversation(self):
        # the box keeps what you typed: per chat across a switch, and across a reload.  A chat with no messages
        # is keyed "blank" rather than by its id, because blank chats are never written to the store and newChat()
        # invents a fresh id on every load - persisting them just to stabilise the id would fill the list with
        # empty rows, and the list had no reason to hold more than one blank chat anyway.
        self.assertIn('const draftKeyOf = (id, blank) => "draft." + (blank ? "blank" : id);', self.js)
        self.assertIn("const draftKey = () => draftKeyOf(chatId, !messages.length);", self.js)
        show = self.body("showChat")
        self.assertIn("if (c.id !== chatId) saveDraft();", show)
        self.assertIn("loadDraft();", show)
        self.assertIn('addEventListener("input", () => { autosize(); saveDraft(); });', self.js)
        self.assertIn("store.set(key, \"\");", self.body("send"))      # the key is taken before the message lands
        self.assertNotIn("if (db) writeChat(chat);", self.body("openHistory"))
        self.assertIn("const blank = chats.find((c) => !c.messages.length);", self.body("startChat"))
        self.assertIn("loadDraft();", self.body("openHistory"))          # the list loads it once the store answers

    def test_the_thinking_block_follows_only_if_you_were_at_its_bottom(self):
        # the thinking body is its own scroll container (.st-collapse__body.thinking, max-height 420px in
        # app.css).  The chat already follows the answer only when you are at the bottom of it; the block had
        # nothing, so new thinking ran out of sight below the fold.
        think = self.body("syncThink")
        self.assertIn("const follow = streaming && p.i === p.runs - 1 && nearEnd(body, 48);", think)
        self.assertIn("if (follow) body.scrollTop = body.scrollHeight;", think)
        self.assertIn('function nearBottom() { return nearEnd($("chat-scroll"), 120); }', self.js)   # one helper

    def test_the_chat_list_name_uses_the_whole_row_until_you_hover(self):
        # the edit and delete buttons used opacity: 0, which keeps their space reserved: two 30px buttons, a 2px
        # gap and the row's 2px gap = 64px, so in the 260px rail (228px of content, 16px of the title's padding)
        # the name had 148px instead of 212px and ellipsised for buttons nobody could see
        css = (Path(__file__).parent / "web" / "app.css").read_text(encoding="utf-8")
        base = re.search(r"\.chat-item__actions \{([^}]*)\}", css).group(1)
        self.assertIn("display: none", base)
        self.assertNotIn("opacity", base)
        self.assertIn(".chat-item:hover .chat-item__actions, .chat-item:focus-within .chat-item__actions { display: flex; }", css)
        # the field owns the row while renaming, and where there is no hover the buttons are always shown
        self.assertIn(".chat-item:has(.chat-item__input) .chat-item__actions { display: none; }", css)
        self.assertIn("@media (hover: none) { .chat-item__actions { display: flex; } }", css)

    def test_nothing_pretends_to_be_output(self):
        # todo #no-placeholder: no "Writing" placeholder, no fake caret, and no answer bubble until there is real output.
        # (The word "Writing" survives in one place on purpose: TOOL_STATE's label for a tool call that is being
        # written, which IS real output.)
        self.assertNotIn('<span class="muted cursor">Writing</span>', self.js)
        self.assertNotIn('<span class="cursor">', self.js)
        self.assertNotIn("const ph =", self.js)                          # the placeholder branch is gone
        self.assertNotIn('classList.add("cursor")', self.js)             # and the caret with it
        self.assertIn("bubble.querySelector(\".msg-error\").textContent", self.js)   # not firstChild: it is null in a stub
        css = (Path(__file__).parent / "web" / "app.css").read_text(encoding="utf-8")
        self.assertNotIn(".cursor::after", css)
        self.assertIn("@keyframes blink", css)                           # the Running/Writing tool badge blinks
        upd = self.body("updateAssistant")
        self.assertIn("const hasOutput = !!m.text || !!(m.tools && m.tools.length) || !!m.error;", upd)
        self.assertIn("bubble.hidden = !hasOutput && !m.reasoning;", upd)
        self.assertIn('el.querySelector(".st-msg__meta").hidden = false;', upd)   # stays visible during a turn so live stats show (todo #edit-posts)
        # thinking lives inside the bubble now (todo #think-per-round), so a thinking-only message keeps the element and
        # drops its chrome instead of hiding it - hiding the bubble would hide the thinking with it
        self.assertIn('bubble.classList.add("thinking-only")', upd)
        self.assertIn(".st-bubble.thinking-only { background: none; border: 0; padding: 0; }", css)
        # a thinking block inside the bubble needs its own margin: as a sibling it got the message row's 6px
        # flex gap, and inside the bubble nothing spaced it from the text under it (the human's spacing report)
        self.assertIn(".st-bubble .st-collapse.think { width: 100%; margin: var(--st-s-3) 0; }", css)
        # a collapsed thinking block previews one line of it, like a tool block previews its result
        self.assertIn(".st-collapse.think .think-preview {", css)
        self.assertIn(".st-collapse.think[open] .think-preview { display: none; }", css)
        self.assertIn('<span class="think-preview muted"></span>', self.js)
        self.assertIn("const thinkPreview = (t) => t.replace(/\\s+/g, \" \").trim().slice(0, 200);", self.js)
        # the live run's slice must come from this paint, not from when the part was made (the first-word bug)
        self.assertIn("p.from = w.from; p.to = w.to; p.runs = w.runs;", self.js)
        self.assertNotIn(".st-work", css)                              # the container is gone, and so is its CSS

    def test_an_open_tool_block_hides_its_one_line_preview(self):
        # todo #hide-preview-when-open: the preview line in the summary row duplicates the arguments and the
        # result that appear right below it once the block is open.  The thinking block has done this for a
        # while; a tool block did not.  CSS only - the element is still built, so a closed block keeps it and
        # toolSync keeps updating it every frame.
        css = (Path(__file__).parent / "web" / "app.css").read_text(encoding="utf-8")
        self.assertIn(".tool-call[open] .tool-call__preview { display: none; }", css)
        self.assertIn(".tool-call__preview { flex: 1;", css)           # the closed block's rule is untouched
        self.assertIn('<span class="tool-call__preview muted">', self.js)
        self.assertIn('d.querySelector(".tool-call__preview")', self.js)   # still refreshed, just not shown

    def test_the_sidebar_width_is_the_readers_and_is_checked(self):
        # todo #sidebar-resize: drag the grip on the chat list's right edge and the width is kept in this
        # browser.  What the harness cannot see (it has no layout) is pinned here as wiring: the grip exists,
        # the width goes through a custom property with the old 260px as its fallback, and the stored number
        # is validated before it is used.  What the width must NOT be is a sampling setting - see LESSONS.md
        # on the drawer's dirty check; the behaviour side is case 84/85 in test_chat_sidebar.js.
        for el in ("sidebar-resize",):
            self.assertIn(f'id="{el}"', self.html)
            self.assertIn(f'"{el}"', self.js)
        self.assertIn('role="separator" aria-orientation="vertical" tabindex="0"', self.html)
        css = (Path(__file__).parent / "web" / "app.css").read_text(encoding="utf-8")
        rail = re.search(r"\.chat-sidebar \{([^}]*)\}", css).group(1)     # so a failure names the rule, not the file
        self.assertIn("width: var(--sidebar-w, 260px);", rail)             # the fallback is the old fixed width
        self.assertIn("position: relative;", rail)                         # the grip is placed against the rail
        self.assertIn(".sidebar-resize { position: absolute;", css)
        self.assertIn(".chat-sidebar[data-open=\"false\"] .sidebar-resize { display: none; }", css)
        self.assertIn("@media (hover: none) { .sidebar-resize { display: none; } }", css)
        self.assertIn(".chat-sidebar[data-open=\"false\"] { width: 60px; }", css)   # the rail rule still wins
        self.assertIn('side.style.setProperty("--sidebar-w", sidebarW + "px");', self.js)
        self.assertNotIn('$("sidebar").style.width', self.js)      # an inline width would beat the rail rule
        self.assertIn("if (!sidebarOpen) return;", self.js)        # no width to change on a collapsed rail
        defaults = re.search(r"const DEFAULTS = \{[^}]*\}", self.js).group(0)
        self.assertNotIn("sidebarw", defaults)                     # not a drawer control, not sent anywhere
        self.assertIn('store.get("sidebarw", null)', self.js)
        self.assertIn('store.set("sidebarw", sidebarW)', self.js)
        sane = self.body("storedSidebarW")
        self.assertIn("typeof v !== \"number\" || !Number.isFinite(v) || v < SIDEBAR_MIN || v > SIDEBAR_MAX", sane)

    def test_a_block_the_reader_touched_is_not_folded_and_a_call_folds_on_the_next_output(self):
        # todo #keep-boxes-open-on-interact and #tool-fold-on-next-output.  The behaviour is driven through
        # send() in test_chat_sidebar.js (cases 86-88); this pins the wiring those cases depend on, including
        # that streaming reaches the tool parts at all - syncLevel declared the parameter and was never given
        # it, so a call's fold could not know whether its turn was still running.
        self.assertIn('$("chat").addEventListener("scroll", (e) => {', self.js)
        self.assertIn("}, true);", self.js)                          # capture: scroll does not bubble
        self.assertIn("if (!det || det === box || nearEnd(box, 48)) return;", self.js)   # the follow's own scroll
        self.assertIn('det.dataset.touched = "1";', self.js)         # syncThink leaves this block alone
        self.assertIn("if (t) t.open = true;", self.js)
        self.assertIn('const toolFollowed = (m, t, k) => !!m && ((m.text || "").length > (t.at || 0) ||', self.js)
        self.assertIn('(m.reasoning || "").length > (t.rat || 0) ||', self.js)
        self.assertIn('(k == null ? (m.tools || []).indexOf(t) : k) + 1 < (m.tools || []).length);', self.js)
        self.assertIn('settings.show === "live" ? (toolLive(t) || (!!streaming && !toolFollowed(m, t, k)))', self.js)
        for wired in ("syncLevel(bubble, m, want, have, streaming);",
                      "have.push(makePart(host, want[i], m, streaming));",
                      "toolHtml(m.tools[w.k], w.k, m, streaming)",
                      "toolSync(p.el, m.tools[p.k], m, p.k, streaming)",
                      "toolOpen(t, m, +d.dataset.tool, !!(busy && busy.msg === m))"):
            self.assertIn(wired, self.js)

    def test_the_autoscroll_backs_off_when_the_reader_fights_it(self):
        # todo #autoscroll-cooldown: the follow rule has 120 px of slack, so a small scroll up during a turn was
        # undone every frame.  The behaviour is case 89 in test_chat_sidebar.js; this pins the wiring, and the one
        # thing the stub cannot show: a real browser clamps scrollTop to the bottom, so autoTop must be READ BACK
        # after the assignment - recording scrollHeight would make the page's own follow look like the reader
        # scrolling up, and the follow would switch itself off for good.
        self.assertIn('$("chat-scroll").addEventListener("scroll", () => {', self.js)
        self.assertIn("s.scrollTop = s.scrollHeight; autoTop = s.scrollTop;", self.js)
        self.assertIn("const following = () => nearBottom() && performance.now() >= followHeldUntil;", self.js)
        self.assertIn("if (s.scrollTop < autoTop - FIGHT_PX) followHeldUntil = performance.now() + FOLLOW_HOLD_MS;", self.js)
        self.assertIn("const FOLLOW_HOLD_MS = 2500, FIGHT_PX = 24;", self.js)
        self.assertIn("if (force) { followHeldUntil = 0; stickBottom(); } else if (following()) stickBottom();", self.js)
        self.assertEqual(self.js.count("const follow = following();"), 2)   # the live paint and the final one
        self.assertNotIn("const follow = nearBottom();", self.js)           # neither may bypass the hold

    def test_the_mcp_panel_is_the_same_control_as_the_card(self):
        # todo #mcp-chat-picker: the wrench panel is a shortcut to the Monitor's MCP card - one state, one write
        # path, no per-conversation tool list.  The clicks are driven in serve/test_chat_sidebar.js (case 91);
        # what is pinned here is the wiring the harness cannot reach cheaply.
        self.assertIn('id="mcp-btn" title="MCP Servers" aria-label="MCP Servers"', self.html)
        self.assertIn('"mcp-btn"', self.js)
        css = (Path(__file__).parent / "web" / "app.css").read_text(encoding="utf-8")
        # the panel scrolls inside the window instead of running off the top, and it is wide so the tools wrap
        picker_rule = re.search(r"\.mcp-picker \{([^}]*)\}", css).group(1)
        self.assertIn("overflow-y: auto;", picker_rule)
        self.assertIn("width: min(92vw, 640px);", picker_rule)
        # the same markup as the card, so there is one look for "which tools" and no second style to keep in step
        self.assertIn('node("div", "mcp-server__head")', self.js)
        self.assertIn('node("div", "mcp-server__tools")', self.js)
        self.assertIn('chip mcp-tool${c.enabled ? "" : " off"}', self.js)      # the Settings card
        # the panel uses the same class with THIS chat's state, so there is one look for "which tools" and no
        # second style to keep in step (todo #prompt-inspector: a chat pins its own list)
        self.assertIn('chip mcp-tool${on ? "" : " off"}', self.js)
        self.assertNotIn("mcp-picker__head", self.js)                # no "Tools for X" heading
        # the row menu's item rule must be class-scoped: the panel is a .chat-menu too, and a bare descendant
        # rule reached every chip in it and turned them into full-width block rows
        self.assertNotIn(".chat-menu button", css)
        self.assertIn(".chat-menu__item { display: block;", css)
        self.assertIn("chat-menu__item${danger", self.js)
        self.assertIn("placePopover(menu, anchor);", self.body("openPopover"))
        self.assertIn("placePopover(panel, anchor);", self.body("openMcpPicker"))
        self.assertIn("el.style.maxHeight = `${room}px`;", self.body("placePopover"))
        self.assertIn("room = Math.max(120, bottomSide ? below : above)", self.body("placePopover"))
        # the edge NEAREST the button is pinned, so the panel cannot cover it however tall it is, and nothing
        # depends on measuring the rendered height (that measurement is what made it land on the button)
        body = self.body("placePopover")
        self.assertIn('if (bottomSide) { el.style.bottom = ""; el.style.top = `${r.bottom + 6}px`; }', body)
        self.assertIn('else { el.style.top = ""; el.style.bottom = `${Math.max(4, vh - r.top + 6)}px`; }', body)
        self.assertNotIn("el.offsetHeight", body)
        self.assertIn('$("mcp-btn").onclick = () => openMcpPicker($("mcp-btn"));', self.js)
        self.assertIn("mcpBtn.onclick = () => openMcpPicker(mcpBtn);", self.body("openEditBox"))
        self.assertIn('$("mcp-btn").hidden = !list.length;', self.body("renderMcp"))   # no MCP: no button
        # the panel is a popover like the row menu, so the outside-click rule must not close it on its own opener
        self.assertIn('!e.target.closest("#mcp-btn")', self.js)
        # and nothing per-conversation survives: one setting, not two
        for gone in ("mcpFrozen", "chatToolsFor", "mcpDefault", "mcpSent", "updateMcpDot", "mcp-dot",
                     "mcpSwitchState", "data-mcp-unfreeze", "mcpDraft", "data-mcp-apply"):
            self.assertNotIn(gone, self.js)
        # auto-apply with a way back: one snapshot per opened view, and Undo is greyed until something moved
        self.assertIn("let mcpBaseline = null;", self.js)
        self.assertIn('data-mcp-undo${n ? "" : " disabled"}', self.js)
        self.assertIn("mcpSnapshot();", self.body("openMcpPicker"))
        self.assertIn("if (tab === \"monitor\") loadMcp();", self.js)
        self.assertIn("function redrawMcpViews()", self.js)      # the card and an open panel move together

    def test_the_settings_tab_holds_the_mcp_server_form(self):
        """todo #mcp-server-add / #mcp-settings-page: the fourth header tab exists and the server form is wired
        to it.  The clicks themselves are driven in serve/test_chat_sidebar.js (case 94); what is pinned here is
        the markup and the wiring the harness cannot reach cheaply."""
        self.assertIn('data-tab="settings"', self.html)
        self.assertIn('id="view-settings"', self.html)
        self.assertIn('id="mcp-set-list"', self.html)
        self.assertIn('id="mcp-set-add"', self.html)
        self.assertIn('"chat", "monitor", "about", "settings"', self.js)     # showTab knows the fourth view
        # the branch, not the whole line: what the view loads when it opens grows, and pinning the exact
        # text made this fail the day a third loader was added (a stale literal, not a broken page)
        self.assertIn('if (tab === "settings") { mcpSnapshot(); loadMcp(); loadConfig();', self.js)
        # the card the Settings list writes carries the two buttons that change the entry itself
        self.assertIn("data-mcp-edit", self.js)
        self.assertIn("data-mcp-del", self.js)
        self.assertIn('$("mcp-set-list").addEventListener("click", mcpListClick);', self.js)
        # the captions the owner deleted (AGENTS.md: never state what the reader already sees).  Pinned in both
        # files so they cannot creep back with the next edit; neither string appears in a comment here, which
        # is the trap that makes an assertNotIn match its own explanation (LESSONS.md).
        for gone in ("new chats start with this", "Starts every new chat",
                     "A server is a program that runs on this PC", "set when this chat started"):
            self.assertNotIn(gone, self.html)
            self.assertNotIn(gone, self.js)
        self.assertIn('$("mcp-set-add").onclick = () => openMcpForm(null);', self.js)
        # one write path, the same POST /mcp the switches use; add and edit carry the entry, remove the name
        self.assertIn('mcpPostAll([{server: n, [editing ? "edit" : "add"]: entry}]', self.js)
        self.assertIn('mcpPostAll([{server: name, remove: true}]', self.js)
        # nothing is written as you type: the field listeners repaint the preview of the command line only
        self.assertIn('.forEach((el) => el.addEventListener("input", paint));', self.js)
        self.assertIn("runs.textContent = mcpRunsText(read());", self.js)
        # a server entry is a command line that runs here, so the form says so before it writes, and the delete
        # confirm is a modal naming that command (SECURITY.md)
        self.assertIn("Runs on this PC with your rights:", self.js)
        self.assertIn('node("div", "msg-del__quote", mcpRunsText(have))', self.js)
        # the form's inputs carry ids, or their labels point at nothing a browser can follow
        self.assertIn("el.id = id;", self.js)
        # the wrench panel reaches the entry too (todo #mcp-picker-entry-points): it is a shortcut, so it carries
        # the same three buttons, and a modal opened from it must not close the panel behind it
        self.assertIn('add.setAttribute("data-mcp-add", "1");', self.js)
        self.assertIn('ed.setAttribute("data-mcp-edit", s.name);', self.js)
        self.assertIn('del.setAttribute("data-mcp-del", s.name);', self.js)
        self.assertIn('!e.target.closest(".att-viewer")) closePopover();', self.js)
        # the Monitor carries no MCP card at all now (todo #mcp-settings-page): status, switches, chips and the
        # entry buttons are all in Settings, and the wrench panel is a shortcut to that same state
        for gone in ('id="mcp-card"', 'id="mcp-list"', 'id="mcp-sum"', 'id="mcp-goto-settings"',
                     '$("mcp-list")', '$("mcp-card")', '$("mcp-sum")'):
            self.assertNotIn(gone, self.html, "the Monitor's MCP card is gone from the page")
            self.assertNotIn(gone, self.js, "and nothing still tries to write it")
        self.assertNotIn(".mcp-card__link", (Path(__file__).parent / "web" / "app.css").read_text(encoding="utf-8"))
        # the non-info parts of the Info page moved: the run-config card and this browser's own settings
        def section(name):
            m = re.search(r'<section class="view view--%s".*?</section>' % name[5:], self.html, re.S)
            return m.group(0) if m else ""
        about, settings = section("view-about"), section("view-settings")
        self.assertTrue(about and settings, "both sections exist")
        for moved in ('id="cfg-card"', 'id="api-key"', 'id="dark-toggle"'):
            self.assertIn(moved, settings, "%s belongs on the Settings tab" % moved)
            self.assertNotIn(moved, about, "and not on the Info page")
        for info in ('id="facts-engine"', 'id="facts-hw"', 'id="facts-api"'):
            self.assertIn(info, about, "the Info page keeps what actually informs")
        # and the page measures itself like the Info page, not like the dashboard
        css = (Path(__file__).parent / "web" / "app.css").read_text(encoding="utf-8")
        self.assertIn(".settings { max-width: 860px; }", css)
        self.assertIn(".monitor, .about, .settings {", css)
        self.assertIn(".view--monitor, .view--about, .view--settings { overflow-y: auto; }", css)
        self.assertIn(".settings .st-card { display: flex; flex-direction: column; gap: var(--st-s-3); }", css)
        # a textarea is not a one-line input: .st-input's 44px height and zero vertical padding made every
        # argument list a clipped strip with no padding above the text
        self.assertIn(".mcp-form textarea.st-input { height: auto; min-height: 6em; padding: 10px 14px;", css)

    def test_the_drawer_warns_before_losing_unapplied_changes(self):
        # todo #drawer-discard-warn: only Apply writes, so the X, the scrim and Escape used to throw away moved switches in silence
        self.assertIn("function closeDrawer()", self.js)
        self.assertIn('$("drawer-close").onclick = closeDrawer;', self.js)
        self.assertIn('$("scrim").onclick = closeDrawer;', self.js)
        self.assertIn('=== "true") closeDrawer(); });', self.js)                 # Escape goes the same way
        self.assertIn("function drawerDirty()", self.js)
        self.assertIn("function drawerSettings()", self.js)
        self.assertIn("settings = drawerSettings();", self.js)      # Apply and the check read the controls once
        self.assertNotIn('$("scrim").onclick = () => openDrawer(false);', self.js)

    def test_markdown_for_each_author_with_a_per_message_switch(self):
        # todo #md-per-author and #6: the drawer sets the default for each author (mine off, the model's on, as the page
        # always drew them) and every message carries an "md" button in its meta row that overrides that one.
        # Off is the page from before: the exact characters, and the prompt is untouched either way.
        for el in ("s-mdmine", "s-mdtheirs"):
            self.assertIn(f'id="{el}"', self.html)
            self.assertIn(f'"{el}"', self.js)
        self.assertIn("mdmine: true, mdtheirs: true", self.js)   # your own messages are formatted by default
        self.assertIn('if (msgMd(m)) b.innerHTML = markdown(m.text || ""); else b.textContent = m.text;',
                      self.body("msgEl"))
        self.assertIn("data-md-toggle", self.js)                       # the button, and the handler for it
        self.assertIn("m.md = !msgMd(m);", self.js)                    # the message keeps its own choice
        self.assertIn("if (!busy) saveChat();", self.js)               # and it is written out with the chat
        self.assertNotIn("mdmine", self.body("apiMessages"))           # what is sent is what was typed
        self.assertNotIn("mdmine", self.body("userText"))
        # the redraw on Apply must refuse to run while an answer streams: send() paints into the element it
        # captured, and renderChat() would detach it
        self.assertIn("if ((settings.mdmine !== mdWas || settings.mdtheirs !== thWas) && !busy) renderChat();", self.js)
        css = (Path(__file__).parent / "web" / "app.css").read_text(encoding="utf-8")
        self.assertIn(".st-bubble .md-plain { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }", css)
        self.assertIn('.st-msg__meta .st-btn--md[aria-checked="true"]', css)
        # "on" is the same ink as the rest of that meta line, with a chip behind it - not the accent
        on_rule = re.search(r'\.st-msg__meta \.st-btn--md\[aria-checked="true"\] \{([^}]*)\}', css).group(1)
        self.assertNotIn("accent", on_rule)
        self.assertIn("background", on_rule)
        self.assertIn("margin-left: auto", css)                    # the md switch, at the right end of the row
        # a user bubble is painted on the accent with --st-accent-ink text (components.css:66), so the markdown
        # styles written for the answer's --st-surface bubble go unreadable there: code.inline measured
        # #1d2226-on-#052e20 in dark (black on black) and #f7f7f7-on-#ffffff in light (white on white), and a
        # link was accent green on the accent's own green.  Every one of them needs a user-bubble variant.
        for sel in (".st-msg--user .st-bubble code.inline", ".st-msg--user .st-bubble a",
                    ".st-msg--user .st-bubble blockquote", ".st-msg--user .st-bubble th",
                    ".st-msg--user .st-bubble hr", ".st-msg--user .st-bubble h3"):
            self.assertIn(sel, css)

    def test_the_answer_is_updated_in_place_and_not_rebuilt(self):
        # todo #update-in-place: the flash was the whole answer being assigned to the bubble on every frame, which threw away
        # and re-made every element in it - each tool block's two sprite icons above all (todo #tool-click-open's clicks, and
        # the flicker the human reported).  A part whose text did not grow must not be touched at all.
        self.assertNotIn("answerHtml", self.js)                      # the whole-answer string builder is gone
        self.assertIn("function renderBubble(el, m, streaming)", self.js)
        self.assertIn("function toolSync(d, t, m, k, streaming)", self.js)   # a tool block's text, not its elements
        self.assertIn("function markdownBlocks(text)", self.js)      # blocks, so only the last one can change
        self.assertIn("if (w.to === p._to) return;", self.js)        # unchanged text: no work, no DOM
        self.assertIn("old.insertAdjacentHTML(\"afterend\", last);", self.js)   # one element replaced, not the subtree

    def test_a_tool_block_opens_on_the_click_and_not_on_a_rebuild(self):
        # todo #tool-click-open: the answer's bubble is rewritten every animation frame while it streams.  The click handler used
        # to prevent the browser's own opening and ask for a rebuild, so a click whose mousedown and mouseup
        # straddled a rebuild landed on a node that was gone and did nothing.
        click = re.search(r'\$\("chat"\)\.addEventListener\("click", \(e\) => \{(.*?)\n\}\);', self.js, re.S).group(1)
        self.assertNotIn("preventDefault", click)                    # nothing stands between the click and the details
        self.assertNotIn("tool-call", click)                         # and the tool blocks are not its business
        toggle = re.search(r'\$\("chat"\)\.addEventListener\("toggle", \(e\) => \{(.*?)\n\}, true\);', self.js, re.S).group(1)
        self.assertIn('classList.contains("tool-call")', toggle)     # the state is taken from what the browser did
        self.assertIn("t.open = d.open", toggle)
        self.assertIn("syncToolBody(", toggle)                      # the body an unopened block was built without

    def test_show_thinking_is_one_three_way_control_for_both_kinds(self):
        # todo #keep-thinking-open and #4, and the fold switch that joined them, are now one segmented control: the drawer used
        # to carry four switches that answered the same question twice and contradicted each other (show /
        # openthink / opentools / autofold).  One key, three values, and the old stored booleans are mapped.
        self.assertIn('id="s-show"', self.html)
        self.assertIn('role="radiogroup" aria-label="Show thinking"', self.html)
        for v in ("folded", "live", "always"):
            self.assertIn(f'data-v="{v}"', self.html)
        self.assertIn("show: \"live\"", self.js)                             # the middle one is the default
        for gone in ("s-openthink", "s-opentools", "s-autofold"):
            self.assertNotIn(gone, self.html)                               # the four are gone, not hidden
            self.assertNotIn(f'"{gone}"', self.js)
        # the one decision, read once by both kinds of block
        self.assertIn("settings.show === \"always\" ? true", self.js)
        self.assertIn('settings.show === "live" ? (toolLive(t) ||', self.js)   # live: while it happens, and until
                                                                       # the model moves on (see toolFollowed)
        self.assertIn('const toolLive = (t) => t.state === "writing" || t.state === "running";', self.js)
        think = self.body("syncThink")
        self.assertIn('settings.show === "always" ? true', think)            # the thinking half
        self.assertIn('settings.show === "live" ? liveRun : false;', think)
        self.assertIn('if (det.dataset.touched !== "1" && det.open !== wantOpen)', think)   # a click wins
        # an old settings object has the four as booleans; map them once rather than let a saved true/false
        # decide how the drawer looks
        mig = self.body("migrateShow")
        self.assertIn("if (SHOWS.includes(s.show)) return s;", mig)          # a new object passes straight through
        self.assertIn("s.autofold === true ? \"live\"", mig)
        self.assertIn("(s.openthink === true || s.opentools === true) ? \"always\"", mig)
        self.assertIn('s.show === false ? "folded"', mig)
        self.assertIn("for (const k of [\"openthink\", \"opentools\", \"autofold\"]) delete out[k];", mig)
        self.assertIn("migrateShow(store.get(\"sampling\", {}))", self.js)    # and it runs on load
        self.assertIn('open ? toolBodyHtml(t) : ""', self.js)                # the body exists only while open
        # the control's box sizes itself to its buttons: .seg was a fixed 4-column grid, which left an empty
        # cell behind a 3-option control (Thinking has four, Show thinking has three)
        css = (Path(__file__).parent / "web" / "app.css").read_text(encoding="utf-8")
        seg_rule = re.search(r"\.seg \{([^}]*)\}", css).group(1)
        self.assertIn("display: flex", seg_rule)
        self.assertNotIn("repeat(4", seg_rule)
        self.assertIn(".seg button { flex: 1 1 0;", css)

    def test_a_click_on_a_tool_block_holds_for_the_turn_only(self):
        # the second half of the simplification: a block the reader opened used to keep that choice on the tool
        # record, which was written into the chat - so one tap pinned a call open through every reload after it
        # and no control could reclaim it.  A thinking block never did that, because its "the reader touched
        # this" lives on the DOM element.  Now both are display state: dropped when the turn ends, and kept out
        # of the record on the way out and on the way back in.
        self.assertIn("for (const t of m.tools || []) delete t.open;", self.body("startTurn"))
        self.assertIn("tools: (m.tools || []).map((t) => ({...t, open: undefined}))", self.js)   # cleanMessages
        self.assertIn("c.messages = dropToolOpen(c.messages || []);", self.body("openHistory"))  # records an
        self.assertIn("fromScreen ? messages : dropToolOpen(store.get(\"chat\", []))",            # older page wrote
            self.js)
        self.assertIn("const dropToolOpen = (list) =>", self.js)
        # and the page's own open/close must not be mistaken for the reader's.  This is a comparison, not a
        # consumed flag: a browser queues the toggle event, so with two events in flight the first used to eat
        # the flag and the second - the page's own change - was read as a click, which set t.open and meant the
        # block never folded again until send() cleared it at the end of the turn.
        self.assertIn("if (d.open !== open) d.open = open;", self.body("toolSync"))
        toggle = re.search(r'\$\("chat"\)\.addEventListener\("toggle", \(e\) => \{(.*?)\n\}, true\);', self.js, re.S).group(1)
        tool_branch = toggle.split('if (!d.classList.contains("think"))')[0]
        self.assertIn("if (d.open === toolOpen(t, m, +d.dataset.tool, !!(busy && busy.msg === m))) return;", tool_branch)
        self.assertNotIn("_auto", tool_branch)         # the thinking branch keeps its flag; this one must not
        # m.md is still kept: the human chose that per message and asked for it to survive a reload
        self.assertIn("m.md = !msgMd(m);", self.js)

    def test_the_fold_knows_when_a_thought_is_over(self):
        # "the last run while streaming" is not when a thought is over: while a tool round runs thinkRuns still
        # reports one run, so that rule would hold it open through the whole call.  Two signals say it is
        # finished - cut (a call starts where the run ends) and tstart (answer text grew past where the run
        # began, stamped in send() as m.rts).  m.rts is numbers only, so the replay cannot change.
        think = self.body("syncThink")
        self.assertIn("const liveRun = p.i === p.runs - 1 && streaming && !p.cut && !(p.tstart != null && m.text.length > p.tstart);", think)
        self.assertIn("return {...r, i, secs, cut: i < cuts.length, tstart: (m.rts || [])[i]};", self.body("thinkRuns"))
        self.assertIn("(m.rts = m.rts || [])[roundCuts(m).length] = m.text.length;", self.body("startTurn"))
        self.assertIn("p.secs = w.secs; p.cut = w.cut;", self.js)            # the part refreshes the ones that grow

    def test_the_single_chat_mode_is_gone_and_its_key_is_migrated(self):
        # todo #drop-single-chat: "off" used to mean one chat in localStorage, cleared by New chat.  The switch,
        # the flag and that whole branch are gone; what must SURVIVE is the migration, or every browser that has
        # only "strata.chat" would open on an empty list and look like it lost the conversation.
        self.assertNotIn("historyOn", self.js)
        self.assertNotIn("function setHistory", self.js)
        self.assertNotIn('store.get("history"', self.js)
        self.assertNotIn('store.set("chat"', self.js)                     # nothing writes the single-chat key now
        self.assertNotIn("id=\"history-toggle\"", self.html)
        self.assertIn('dropToolOpen(store.get("chat", []))', self.body("openHistory"))   # ... and it is read once
        # the storage helper is as it was: the list did not add a method to it
        helper = re.search(r"const store = \{.*?\n\};", self.js, re.S).group(0)
        self.assertEqual(sorted(re.findall(r"^\s{2}(\w+)\(", helper, re.M)), ["get", "set"])

    def test_the_list_stays_in_the_browser(self):
        self.assertIn('indexedDB.open("strata", 1)', self.js)             # a chat can be megabytes; localStorage is ~5 MB
        self.assertIn('createObjectStore("chats", {keyPath: "id"})', self.js)
        self.assertIn("function putChat(c)", self.js)                     # one record per chat, not the whole list
        self.assertIn("function dropChat(c)", self.js)
        self.assertNotIn('fetch("chats"', self.js)                        # nothing about it goes to the server
        self.assertIn("function chatTitle(c)", self.js)                   # the name: what the user called it, else the first question

    def test_the_read_takes_the_result_from_the_request(self):
        # oncomplete is the transaction's event, and the store has no result: reading there gives nothing
        read = self.body("allChats")
        self.assertIn("req.onsuccess", read)
        self.assertIn("req.transaction.onabort", read)                 # an aborted read fires abort, not error
        self.assertNotIn("store.result", read)
        self.assertNotIn(".oncomplete", read)

    def test_the_store_is_opened_at_start_and_memory_only_still_works(self):
        open_db = self.body("openDb")
        self.assertIn("catch (e) { resolve(null); return; }", open_db)    # private mode: memory only
        self.assertIn("r.onblocked = () => resolve(null)", open_db)       # another tab holds an older version
        # a database already at version 1 does not run onupgradeneeded, so the store may not be there
        self.assertIn('objectStoreNames.contains("chats") ? r.result : null', open_db)
        self.assertIn("openHistory(false).then(renderChat);", self.js)   # start-up, not behind a switch - and the
                                                                        # list is drawn when the read comes back
        self.assertIn("if (!db) warnStorage(", self.body("openHistory"))  # private mode: in memory, and it says so

    def test_a_write_the_browser_refuses_still_shows_the_change(self):
        for name in ("putChat", "dropChat"):
            self.assertIn("renderSidebar()", self.body(name))            # memory only: the list has to update
        # a request that fails because the storage is full aborts the transaction, so it fires abort, not error
        quota = self.body("onQuota")
        self.assertIn("t.onerror = warn; t.onabort = warn;", quota)
        self.assertIn('t.error.name === "QuotaExceededError"', quota)    # the message is about a full storage
        for name in ("writeChat", "dropRecord"):
            self.assertIn("onQuota(t)", self.body(name))

    def test_the_list_is_rendered_once_per_change(self):
        # the record helpers write without rendering, so a caller that renders does not render twice
        self.assertIn("writeChat", self.body("showChat"))
        self.assertNotIn("putChat", self.body("showChat"))
        self.assertIn("dropRecord", self.body("deleteChat"))
        self.assertNotIn("dropChat", self.body("deleteChat"))

    def test_a_new_chat_stays_empty_after_a_reload(self):
        # the bug reported on #1787: the single chat from before the switch must not be copied into an empty chat
        history = self.body("openHistory")
        self.assertIn("chats = db ? await allChats() : []", history)
        self.assertIn("const old = fromScreen ? messages : dropToolOpen(store.get(\"chat\", []))", history)

    def test_new_chat_never_clears_the_chat_you_are_in(self):
        # the old page had a "New chat" that emptied the one chat and offered an Undo.  With the list always on,
        # New chat starts another conversation and the one you were in stays where it is.
        self.assertIn('$("new-btn").onclick = () => startChat();', self.js)
        self.assertNotIn("The last one was cleared.", self.js)             # the off-mode Undo toast is gone

    def test_attachment_bytes_are_kept_in_the_record(self):
        # the IndexedDB record keeps image data URLs and file text so a reloaded post can still show and open its
        # attachments (todo #edit-posts / store-full-attachments).  There used to be a second path that stripped
        # them for the localStorage single chat; that mode is gone (todo #drop-single-chat), so the parameter
        # that chose between them is gone with it - a switch nothing can set is a switch that gets misread later.
        clean = re.search(r"const cleanMessages = .*?;\n", self.js, re.S).group(0)
        self.assertIn("images: (m.images || []).map((i) => ({name: i.name, url: i.url})),", clean)
        self.assertIn("files: (m.files || []).map((f) => ({name: f.name, text: f.text})),", clean)
        self.assertNotIn("keepBytes", self.js)
        self.assertNotIn("cleanMessages(messages, false)", self.js)

    def test_the_search_and_the_day_groups(self):
        render = self.body("renderSidebar")
        self.assertIn("chatTitle(c).toLowerCase().includes(q)", render)
        self.assertIn("c.messages.some((m) => (m.text || \"\").toLowerCase().includes(q))", render)
        self.assertIn("function groupName(t)", self.js)
        for group in ("Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"):
            self.assertIn(f'"{group}"', self.js)

    def test_the_open_chat_is_what_a_request_is_built_from(self):
        self.assertIn("messages = chat.messages", self.js)                # the list and the screen share the array
        self.assertIn("function apiMessages(c = chat)", self.js)
        self.assertIn("function showChat(c)", self.js)


class NothingGoesToTheServer(unittest.TestCase):
    """The list is the browser's; the server has no endpoint for it and never sees a chat title."""

    def setUp(self):
        self.tok = ByteTokenizer()
        self.service = Service(MockEngine(self.tok, "ok"), self.tok,
                               ChatTemplate(Path(__file__).parent / "chat_template.jinja"))
        self.httpd = serve(self.service, port=0)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def get(self, path):
        try:
            with urllib.request.urlopen(self.base + path, timeout=10) as response:
                return response.status, response.read().decode()
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode()

    def post(self, path, body):
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                return response.status, response.read().decode()
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode()

    def test_the_page_and_its_script_are_served(self):
        code, body = self.get("/web/app.js")
        self.assertEqual(code, 200)
        self.assertIn("indexedDB.open(\"strata\", 1)", body)              # the script that keeps the list

    def test_there_is_no_chat_history_endpoint(self):
        for path in ("/chats", "/api/chats", "/history", "/api/history"):
            with self.subTest(path=path):
                self.assertEqual(self.get(path)[0], 404)
        # the server answers, so those 404s are the routes that do not exist and not a broken page
        self.assertEqual(self.post("/v1/chat/completions", {"messages": [{"role": "user", "content": "hi"}]})[0], 200)


class TheStoragePath(unittest.TestCase):
    """The storage path, run against app.js with a stub DOM and a stub IndexedDB: the read, the write,
    private mode, a full storage, a store that is not there, and a reload. It is skipped on a machine
    without node, so the suite still runs there."""

    def test_the_storage_path(self):
        if not shutil.which("node"):
            self.skipTest("node is not installed")
        script = Path(__file__).parent / "test_chat_sidebar.js"
        result = subprocess.run(["node", str(script)], capture_output=True, text=True, timeout=60)
        if result.returncode:
            self.fail((result.stderr or result.stdout).strip())


if __name__ == "__main__":
    unittest.main()
