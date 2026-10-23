"""serve/test_fence_quoted_thinking.py - "fence_quoted_thinking" (opt-in): a think tag quoted inside a code fence.

#537 treats a closing think tag as the model quoting it when it sits right after a quote or a backtick.  A model that
writes the tag on its own line between fence markers is preceded by a newline, so that rule misses it: the thinking
ends in the middle of the example and the rest of the fence plus the model's real answer is delivered as the answer.
The option recognises that shape by watching whether the fence closes (a quoted example) or a blank line comes first
(the template's own end of the thinking).  Off by default; with it off every case below parses exactly as before.

    python -m unittest serve.test_fence_quoted_thinking -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from serve.frontend import OutputParser  # noqa: E402

THINK_END = "<" + "/think" + ">"
FENCE = chr(96) * 3
TOOLS = [{"name": "lookup", "parameters": {"type": "object", "properties": {"term": {"type": "string"}}}}]


def parse(text, fence_mode, width=5):
    p = OutputParser(thinking=True, tools=TOOLS, stream_tools=True, fence_think=fence_mode)
    evs = []
    for i in range(0, len(text), width):
        evs += p.feed(text[i:i + width])
    evs += p.finish()
    return ("".join(e.text for e in evs if e.kind == "reasoning"),
            "".join(e.text for e in evs if e.kind == "content"))


QUOTED = "the format is: " + FENCE + "\n" + THINK_END + "\n" + FENCE + "\nso I will not write it there."
AFTER_FENCE = FENCE + "\nx\n" + FENCE + "\n" + THINK_END + "\n\nTHE ANSWER"
LANG_FENCE = FENCE + "python\nx = 1\n" + FENCE + "\n" + THINK_END + "\n\nTHE ANSWER"
OPEN_FENCE = "```python\nx = 1\n" + THINK_END + "\n\nTHE ANSWER"
PLAIN = "just thinking\n" + THINK_END + "\n\nTHE ANSWER"
FENCED_ANSWER = "```python\nx = 1\n" + THINK_END + "\n\n" + FENCE + "sh\nls\n" + FENCE


class FenceQuoted(unittest.TestCase):
    def test_on_the_quoted_tag_stays_in_the_thinking(self):
        for width in (1, 3, 7, 100000):
            with self.subTest(width=width):
                rea, con = parse(QUOTED, True, width)
                self.assertEqual(con, "", "the example must not become the answer")
                self.assertIn(THINK_END, rea, "the tag itself stays in the reasoning")
                self.assertIn("so I will not write it there.", rea)

    def test_on_a_real_end_after_a_fence_still_ends_the_thinking(self):
        for label, text, want in (("closed fence", AFTER_FENCE, "THE ANSWER"),
                                  ("fence with a language", LANG_FENCE, "THE ANSWER"),
                                  ("no fence at all", PLAIN, "THE ANSWER"),
                                  ("fence left open", OPEN_FENCE, "THE ANSWER"),
                                  ("answer starts fenced", FENCED_ANSWER, "ls")):
            with self.subTest(label):
                for width in (1, 3, 7, 100000):
                    self.assertIn(want, parse(text, True, width)[1], label)

    def test_off_everything_parses_as_before(self):
        """The default path is byte-identical: the option changes only the one shape it is about."""
        for label, text, want in (("closed fence", AFTER_FENCE, "THE ANSWER"), ("language", LANG_FENCE, "THE ANSWER"),
                                  ("plain", PLAIN, "THE ANSWER"), ("open fence", OPEN_FENCE, "THE ANSWER")):
            with self.subTest(label):
                self.assertIn(want, parse(text, False)[1])
        # off: the old behaviour stays - the tag ends the thinking and the tail of the example becomes the answer
        rea, con = parse(QUOTED, False)
        self.assertEqual(rea, "the format is: " + FENCE + "\n")
        self.assertEqual(con, FENCE + "\nso I will not write it there.")


if __name__ == "__main__":
    unittest.main()
