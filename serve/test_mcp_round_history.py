"""serve/test_mcp_round_history.py - #2100: the MCP loop and the web app must rebuild a tool turn the same way.

The engine reuses a prompt only when it starts with exactly the tokens it already holds.  The web app rebuilds tool
turns itself (assistantMessages in serve/web/app.js) and does not carry the round's thinking; run_with_mcp used to
attach it.  The chat template renders an empty thinking block for a turn without reasoning_content, so the two
reconstructions tokenized differently and the prefix broke at the first tool round of the chat: every later request
re-read everything after it.  This checks that both sides now render one and the same prompt.

    python -m unittest serve.test_mcp_round_history -v
"""
from __future__ import annotations

import json
import pathlib
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from serve.frontend import ChatTemplate, Event, ToolCall, openai_to_messages  # noqa: E402
from serve.server import run_with_mcp  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
TPL = ChatTemplate(ROOT / "serve" / "chat_template.jinja")
TOOL = "easy__noop"
THINKING = "I should call the tool before answering."


def render(msgs):
    return TPL.render(msgs, add_generation_prompt=True, enable_thinking=True, tools=[{"name": TOOL}])


class FakeSvc:
    """Two rounds: the model thinks and calls, then answers.  prepare() records what the loop rebuilt."""

    def __init__(self, call_name=TOOL, events=None):
        self.round, self.prepared = 0, []
        self.call_name = call_name          # an unknown name exercises the answered-error round
        self.events = events                # a scripted round, for a round with more than one call
        # run_with_mcp reports the call it is running through these (todo #waiting-state), so the stand-in has to carry
        # what a real Service carries - and the unknown-call notice counts into totals, so that too
        self.status_lock = threading.Lock()
        self.mcp_running = {}
        self.totals = {}

    def run(self, ids, thinking, tools, max_new, sampling, cancel, conv=None):
        # this double mirrors Service.run, keywords included - conv names the conversation (item
        # turn-lock-per-conversation), and a double that ignores a real parameter hides signature drift
        self.round += 1
        if self.round == 1:
            if self.events is not None:
                yield from (("event", e) for e in self.events)
                yield "done", {"completion_tokens": 10, "finish": "stop"}
                return
            yield "event", Event("reasoning", THINKING)
            yield "event", Event("tool_call", call=ToolCall(self.call_name, {"value": 7}, "call_x"))
        else:
            yield "event", Event("content", "done")
        yield "done", {"completion_tokens": 10, "finish": "stop"}

    def prepare(self, messages, tools, kw, max_req, cancel=None):
        self.prepared.append([dict(m) for m in messages])
        return [], True, max_req


class FakeHub:
    settings = {"max_rounds": 4}

    def __init__(self, images=None):
        self.images = images or []          # what McpHub.call hands back for a tool that returned a picture

    def routes(self):
        return {TOOL: (None, "noop")}

    def call(self, name, arguments, cancel, include_disabled=False):
        # the same signature as McpHub.call (serve/mcp.py): a request that carries its own tool list asks for
        # include_disabled (todo #mcp-live-toggles), and a double that drifts from the real one hides that.
        if name not in self.routes():
            # what the real hub answers for a name it has no server for (serve/mcp.py, McpHub.call).  The loop now
            # sends that back to the model instead of ending the turn (item unread-call-recovery), which adds a
            # tool round the page has to rebuild exactly - that is what the test below checks.
            return {"ok": False, "text": f"error: there is no tool named {name!r}", "chars": 30,
                    "truncated": False, "ms": 0, "images": []}
        return {"ok": True, "text": "7", "chars": 1, "truncated": False, "ms": 0, "images": self.images}


class RoundHistory(unittest.TestCase):
    """Both modes are checked, and so is the mix: the two rebuilds must agree, whichever way the switch sits."""

    PNG = ("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmM"
           "IQAAAABJRU5ErkJggg==")

    def loop(self, keep, images=None):
        svc = FakeSvc()
        msgs = [{"role": "user", "content": "Call the noop tool with value 7."}]
        list(run_with_mcp(svc, FakeHub(images and [{"type": "image", "source": self.PNG}]), msgs, [{"name": TOOL}],
                          {}, [], True, 100, 100, {}, threading.Event(), {TOOL}, keep))
        return svc.prepared[-1]

    def client(self, server_msgs, keep):
        """What assistantMessages() sends back for that turn (serve/web/app.js), in the same mode."""
        out = []
        for m in server_msgs:
            if m.get("tool_calls"):
                c = {k: v for k, v in m.items() if k != "reasoning_content"}
                if keep:
                    c["reasoning_content"] = THINKING      # the page holds its own copy of the round's thinking
                out.append(c)
            else:
                out.append({k: v for k, v in m.items() if k != "reasoning_content"})
        return out + [{"role": "assistant", "content": "done"}, {"role": "user", "content": "and now?"}]

    def test_off_is_the_default_and_keeps_the_prompt_small(self):
        rebuilt = self.loop(False)
        rounds = [m for m in rebuilt if m.get("tool_calls")]
        self.assertEqual(len(rounds), 1, "one tool round")
        self.assertNotIn("reasoning_content", rounds[0], "off: the thinking stays out of the history")
        self.assertTrue(render(self.client(rebuilt, False)).startswith(render(rebuilt)),
                        "off: the next request still starts with everything the engine holds")
        self.assertNotIn(THINKING, render(rebuilt), "off: the reasoning is not in the prompt at all")

    def test_on_keeps_the_round_thinking_for_the_next_round(self):
        rebuilt = self.loop(True)
        rounds = [m for m in rebuilt if m.get("tool_calls")]
        self.assertEqual(rounds[0].get("reasoning_content"), THINKING, "on: the round's thinking is kept")
        self.assertIn(THINKING, render(rebuilt), "on: round 2 sees round 1's reasoning")
        self.assertTrue(render(self.client(rebuilt, True)).startswith(render(rebuilt)),
                        "on: a client that keeps it too still matches the engine's tokens")

    def test_the_two_sides_disagreeing_breaks_the_prefix(self):
        """The bug, kept as a guard: one side carries the thinking and the other drops it."""
        for keep_server, keep_client in ((True, False), (False, True)):
            with self.subTest(server=keep_server, client=keep_client):
                rebuilt = self.loop(keep_server)
                self.assertFalse(render(self.client(rebuilt, keep_client)).startswith(render(rebuilt)),
                                 "a mismatched pair re-reads everything past the first tool round")


    def test_a_picture_in_a_tool_message_must_ride_back_or_the_prefix_breaks(self):
        """item ai-image-visible.  run_with_mcp gives the model the tool's text AND the picture as parts; if the
        page replays that round as the text alone, the next request stops matching the engine's tokens at this
        message and the chat re-reads everything after it - and the model forgets what it saw."""
        rebuilt = self.loop(False, [{"type": "image", "source": self.PNG}])
        tool_msgs = [m for m in rebuilt if m.get("role") == "tool"]
        self.assertEqual(len(tool_msgs), 1)
        self.assertIsInstance(tool_msgs[0]["content"], list, "the server sent parts: text plus the picture")
        self.assertIn("image", render(rebuilt), "and the picture is in the engine's prompt")
        # what the page sends back is the CLIENT's shape (serve/web/app.js, assistantMessages) - run it through the
        # real conversion, the only way to know the two rebuilds agree
        as_client = [dict(m, content=[p if p["type"] == "text" else
                                      {"type": "image_url", "image_url": {"url": p["source"]}} for p in m["content"]])
                     if m.get("role") == "tool" and isinstance(m["content"], list) else m for m in rebuilt]
        msgs, _, _ = openai_to_messages({"messages": as_client})
        self.assertTrue(render(msgs).startswith(render(rebuilt)),
                        "the client's rebuild continues the tokens the engine already holds")
        # echoing the server's INTERNAL part shape back must work too: it did not, and that was a 400 on every
        # later message of any chat that had a tool picture (the bug this commit fixes)
        msgs2, _, _ = openai_to_messages({"messages": rebuilt})
        self.assertTrue(render(msgs2).startswith(render(rebuilt)), "the internal part shape is accepted as well")
        # and the failure all of this exists to prevent: the round replayed as text only
        text_only = [dict(m, content=m["content"][0]["text"])
                     if m.get("role") == "tool" and isinstance(m["content"], list) else m for m in rebuilt]
        self.assertFalse(render(self.client(text_only, False)).startswith(render(rebuilt)),
                         "text only re-reads from this message onwards")

    UNKNOWN = "easy__nothere"

    def test_an_answered_error_round_replays_identically(self):
        """The unknown-tool fix (item unread-call-recovery): the loop answers a call nobody can serve with the hub's
        own error and lets the model go on.  That puts an extra tool round into the history, and the page rebuilds
        tool rounds by itself - so "the chat's cache survives" was a claim until this compares both rebuilds
        through the real template."""
        svc = FakeSvc(self.UNKNOWN)
        msgs = [{"role": "user", "content": "Call a tool that does not exist."}]
        list(run_with_mcp(svc, FakeHub(), msgs, [{"name": TOOL}], {}, [], True, 100, 100,
                          {}, threading.Event(), {TOOL}, False))
        rebuilt = svc.prepared[-1]
        rounds = [m for m in rebuilt if m.get("tool_calls")]
        self.assertEqual(len(rounds), 1, "the answered error is a tool round in the history")
        self.assertEqual(rounds[0]["tool_calls"][0]["function"]["name"], self.UNKNOWN)
        self.assertIn("there is no tool named", [m for m in rebuilt if m.get("role") == "tool"][0]["content"])
        self.assertEqual(svc.round, 2, "and the model was given a second turn to correct itself")
        self.assertTrue(render(self.client(rebuilt, False)).startswith(render(rebuilt)),
                        "the page's rebuild continues the tokens the engine already holds: no re-read")

    def test_a_mixed_round_keeps_the_order_the_model_wrote(self):
        """The answered-error round cost a re-read after all, and it was the LOOP's doing, not the page's: the
        calls it answers were kept in two lists and joined real-first, while the page rebuilds a round from the
        order the calls ARRIVED (onTool pushes on the announcement, assistantMessages replays that array).  One
        unknown call written before a real one therefore moved that round's calls - and their results - into a
        different order than the engine had been fed, and the exact-prefix reuse stopped matching at that round.
        Measured on this box 2026-11-21 over a real agent chat: the request after such a round re-read 36,281 of
        its 87,463 prompt tokens, 14.4 s, and the client hung up while waiting (finish=disconnect).
        Both sides go through the real conversion: the page's messages are built in the CLIENT's shape from the
        events it was actually sent, then read by openai_to_messages - never hand-modelled (LESSONS.md)."""
        first = ToolCall(self.UNKNOWN, {"value": 1}, "call_u")      # the name nobody offers, written FIRST
        second = ToolCall(TOOL, {"value": 7}, "call_t")
        svc = FakeSvc(events=[Event("tool_start", call=first), Event("tool_call", call=first),
                              Event("tool_start", call=second), Event("tool_call", call=second)])
        asked = "Call the missing one, then the noop."
        out = list(run_with_mcp(svc, FakeHub(), [{"role": "user", "content": asked}], [{"name": TOOL}],
                                {}, [], True, 100, 100, {}, threading.Event(), {TOOL}, False))
        rebuilt = svc.prepared[-1]
        rounds = [m for m in rebuilt if m.get("tool_calls")]
        self.assertEqual([c["function"]["name"] for c in rounds[0]["tool_calls"]], [self.UNKNOWN, TOOL],
                         "the round the loop builds keeps the order the model wrote the calls in")
        self.assertEqual([m["content"] for m in rebuilt if m.get("role") == "tool"],
                         [f"error: there is no tool named {self.UNKNOWN!r}", "7"],
                         "and each result sits under its own call")
        # what the page holds: the calls in arrival order, each with the result that came back for it
        order = [x["id"] for k, x in out if k == "mcp" and x["event"] == "start"]
        got: dict = {}
        for k, x in out:
            if k == "mcp" and x["event"] in ("call", "result"):
                got.setdefault(x["id"], {}).update(x)
        self.assertEqual(order, ["call_u", "call_t"], "the page saw the unknown call first")
        as_client = [{"role": "user", "content": asked},
                     {"role": "assistant", "content": "", "tool_calls": [
                         {"id": i, "type": "function",
                          "function": {"name": got[i]["name"], "arguments": json.dumps(got[i]["arguments"])}}
                         for i in order]},
                     *[{"role": "tool", "tool_call_id": i, "content": got[i]["text"]} for i in order],
                     {"role": "assistant", "content": "done"}, {"role": "user", "content": "and now?"}]
        client, _, _ = openai_to_messages({"messages": as_client})
        self.assertTrue(render(client).startswith(render(rebuilt)),
                        "the page's rebuild of that round continues the tokens the engine already holds")

    def test_a_cut_off_call_becomes_a_round_both_sides_rebuild_the_same(self):
        """Answering a call the model opened and never finished puts a new round into the history: the call as
        far as it got, and the note the model was told.  The page rebuilds that round from the events it was
        sent, so the two have to agree token for token or the prefix breaks here - the hazard that measured
        36,281 tokens on this box.  A cut-off call is also always the LAST thing a pass wrote, so appending it
        keeps the model's order rather than disturbing it."""
        half = ToolCall(TOOL, {"text": "hello from"}, "call_cut")
        svc = FakeSvc(events=[Event("tool_start", call=half),
                              Event("tool_args", text='{"text": "hello from"', call=half),
                              Event("tool_cut", text="text", call=half)])
        asked = "Call the noop tool and stop half way through."
        out = list(run_with_mcp(svc, FakeHub(), [{"role": "user", "content": asked}], [{"name": TOOL}],
                                {}, [], True, 100, 100, {}, threading.Event(), {TOOL}, False))
        rebuilt = svc.prepared[-1]
        rounds = [m for m in rebuilt if m.get("tool_calls")]
        self.assertEqual(len(rounds), 1, "the cut-off call is a round in the history")
        self.assertEqual(rounds[0]["tool_calls"][0]["function"]["name"], TOOL)
        self.assertEqual(rounds[0]["tool_calls"][0]["function"]["arguments"], {"text": "hello from"},
                         "with the arguments as far as the model got, not an empty call")
        note = [m for m in rebuilt if m.get("role") == "tool"][0]["content"]
        self.assertIn("was not run", note, note[:200])
        self.assertIn('"text"', note, "and it names the parameter the call stopped inside")
        order = [x["id"] for k, x in out if k == "mcp" and x["event"] == "start"]
        got: dict = {}
        for k, x in out:
            if k == "mcp" and x["event"] in ("call", "result"):
                got.setdefault(x["id"], {}).update(x)
        as_client = [{"role": "user", "content": asked},
                     {"role": "assistant", "content": "", "tool_calls": [
                         {"id": i, "type": "function",
                          "function": {"name": got[i]["name"], "arguments": json.dumps(got[i]["arguments"])}}
                         for i in order]},
                     *[{"role": "tool", "tool_call_id": i, "content": got[i]["text"]} for i in order],
                     {"role": "assistant", "content": "done"}, {"role": "user", "content": "and now?"}]
        client, _, _ = openai_to_messages({"messages": as_client})
        self.assertTrue(render(client).startswith(render(rebuilt)),
                        "the page's rebuild of the cut round continues the tokens the engine already holds")
        self.assertEqual(svc.round, 2, "and the model was given a turn after the note")


if __name__ == "__main__":
    unittest.main()
