"""serve/test_abandoned_calls.py - a tool call the model opened and never finished is counted, not silently dropped.

The parser holds a call it has opened until it closes.  When the turn ends first, nothing is delivered for it (#211):
the answer stops where the call began and no call runs, which from the chat looks like the engine died.  `abandoned`
counts those, so the server can say so in its window and in /metrics instead of leaving it silent.  The delivered
bytes are unchanged: this is a counter, not a parser change.

    python -m unittest serve.test_abandoned_calls -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from serve.frontend import OutputParser  # noqa: E402

# built from pieces so this file never contains a tag the parser would read
OPEN = "<" + "?".replace("?", "tool_call") + ">"
CLOSE = "<" + "/tool_call" + ">"
FN = "<" + "function="
FN_END = "<" + "/function" + ">"
PARAM = "<" + "parameter="
PARAM_END = "<" + "/parameter" + ">"
THINK_END = "<" + "/think" + ">"

TOOLS = [{"name": "lookup", "parameters": {"type": "object", "properties": {"term": {"type": "string"}}}}]
WHOLE = OPEN + "\n" + FN + "lookup>\n" + PARAM + "term>\nalpha\n" + PARAM_END + "\n" + FN_END + "\n" + CLOSE


def parse(text, tools=TOOLS, stream=True):
    p = OutputParser(thinking=True, tools=tools, stream_tools=stream)
    evs = []
    for i in range(0, len(text), 5):
        evs += p.feed(text[i:i + 5])
    return evs + p.finish(), p


class Abandoned(unittest.TestCase):
    def head(self):
        return "thinking" + THINK_END + "\n\nLook it up.\n"

    def test_a_finished_call_is_not_counted(self):
        evs, p = parse(self.head() + WHOLE)
        self.assertEqual(p.abandoned, 0)
        self.assertEqual(sum(1 for e in evs if e.kind == "tool_call"), 1)

    def test_a_call_left_open_is_counted_the_same_way_whether_announced_or_not(self):
        cut = self.head() + OPEN + "\n" + FN + "lookup>\n" + PARAM + "term>\nalpha\n"
        for stream in (True, False):
            with self.subTest(stream_tools=stream):
                _, p = parse(cut, stream=stream)
                self.assertEqual(p.abandoned, 1, "both stream_tools settings report it the same")

    def test_the_counter_survives_a_whole_turn(self):
        evs, p = parse(self.head() + OPEN + "\n" + FN + "lookup>\n")
        self.assertEqual(p.abandoned, 1)
        self.assertFalse([e for e in evs if e.kind == "tool_call"])

    def test_naming_the_format_in_prose_is_not_an_abandoned_call(self):
        # #1058: an opener followed by ordinary text is prose; it stays content and is not a dropped call
        _, p = parse(self.head() + OPEN + "\n and I will explain the format later.")
        self.assertEqual(p.abandoned, 0)

    def test_the_count_is_about_the_model_not_about_the_request(self):
        # the content state recognises a call's structure whether or not the request declared tools, so an opened
        # call that never closes is counted either way: the counter reports what the model did.
        _, p = parse(self.head() + OPEN + "\n" + FN + "lookup>\n", tools=None)
        self.assertEqual(p.abandoned, 1)


if __name__ == "__main__":
    unittest.main()
