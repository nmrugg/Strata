"""serve/test_mcp_round_history.py - #2100: the MCP loop and the web app must rebuild a tool turn the same way.

The engine reuses a prompt only when it starts with exactly the tokens it already holds.  The web app rebuilds tool
turns itself (assistantMessages in serve/web/app.js) and does not carry the round's thinking; run_with_mcp used to
attach it.  The chat template renders an empty thinking block for a turn without reasoning_content, so the two
reconstructions tokenized differently and the prefix broke at the first tool round of the chat: every later request
re-read everything after it.  This checks that both sides now render one and the same prompt.

    python -m unittest serve.test_mcp_round_history -v
"""
from __future__ import annotations

import pathlib
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from serve.frontend import ChatTemplate, Event, ToolCall  # noqa: E402
from serve.server import run_with_mcp  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
TPL = ChatTemplate(ROOT / "serve" / "chat_template.jinja")
TOOL = "easy__noop"
THINKING = "I should call the tool before answering."


def render(msgs):
    return TPL.render(msgs, add_generation_prompt=True, enable_thinking=True, tools=[{"name": TOOL}])


class FakeSvc:
    """Two rounds: the model thinks and calls, then answers.  prepare() records what the loop rebuilt."""

    def __init__(self):
        self.round, self.prepared = 0, []
        # run_with_mcp reports the call it is running through these (todo #waiting-state), so the stand-in has to carry
        # what a real Service carries
        self.status_lock = threading.Lock()
        self.mcp_running = {}

    def run(self, ids, thinking, tools, max_new, sampling, cancel):
        self.round += 1
        if self.round == 1:
            yield "event", Event("reasoning", THINKING)
            yield "event", Event("tool_call", call=ToolCall(TOOL, {"value": 7}, "call_x"))
        else:
            yield "event", Event("content", "done")
        yield "done", {"completion_tokens": 10, "finish": "stop"}

    def prepare(self, messages, tools, kw, max_req, cancel=None):
        self.prepared.append([dict(m) for m in messages])
        return [], True, max_req


class FakeHub:
    settings = {"max_rounds": 4}

    def routes(self):
        return {TOOL: (None, "noop")}

    def call(self, name, arguments, cancel):
        return {"ok": True, "text": "7", "chars": 1, "truncated": False, "ms": 0, "images": []}


class RoundHistory(unittest.TestCase):
    """Both modes are checked, and so is the mix: the two rebuilds must agree, whichever way the switch sits."""

    def loop(self, keep):
        svc = FakeSvc()
        msgs = [{"role": "user", "content": "Call the noop tool with value 7."}]
        list(run_with_mcp(svc, FakeHub(), msgs, [{"name": TOOL}], {}, [], True, 100, 100,
                          {}, threading.Event(), {TOOL}, keep))
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


if __name__ == "__main__":
    unittest.main()
