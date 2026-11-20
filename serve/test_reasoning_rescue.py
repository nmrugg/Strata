"""serve/test_reasoning_rescue.py - #804 / #1058: when a `<tool_call>` written inside the reasoning is a real call.

A call inside the reasoning counts only when ALL hold: tools are declared and the name is one of them; the opener is
at the start of a line; it is outside a Markdown code fence and outside inline code; the call closes with
</tool_call> and nothing but whitespace (or more calls) follows it before the end of the turn or `</think>`; and the
turn did not end by max tokens (or a cancel or an error).  Anything else stays reasoning text.

The corpus in serve/fixtures/rcall_specimens.json holds 25 entries from PR #525's corpus and the 12 live strandings
recovered by 47Hunter47 (gist 4abcd3a8...): 16 act, 21 must not (the reporter's 20 negative controls
plus the live one cut by max tokens).

    python -m unittest serve.test_reasoning_rescue -v
"""
from __future__ import annotations

import io
import json
import random
import sys
import unittest
import urllib.request
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from serve.frontend import (CALL_END, CALL_START, FUNC_END, FUNC_START, PARAM_END, PARAM_START,
                            ChatTemplate, OutputParser)  # noqa: E402
from serve.server import ByteTokenizer, MockEngine, Service, serve  # noqa: E402
from serve.test_server import CTX  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SPECIMENS = json.loads((ROOT / "serve/fixtures/rcall_specimens.json").read_text(encoding="utf-8"))["specimens"]
CALL = "<tool_call>\n<function=write>\n<parameter=path>\nfile.txt\n</parameter>\n</function>\n</tool_call>"
RM = CALL.replace("file.txt", "rm -rf build")
PROPS = {"path": {"type": "string"}}
SCHEMA = [{"name": "write", "parameters": {"properties": PROPS}}]


def parse(text, width, tools=SCHEMA, finish=None, stream_tools=True):
    """Events for `text` fed `width` characters at a time (0 = random 1-9, seeded)."""
    p = OutputParser(thinking=True, tools=tools, stream_tools=stream_tools)
    evs, rnd, i = [], random.Random(7), 0
    while i < len(text):
        k = width or rnd.randint(1, 9)
        evs += p.feed(text[i:i + k])
        i += k
    return evs + p.finish(finish)


def calls(evs):
    return [e.call.name for e in evs if e.kind == "tool_call"]


def reasoning(evs):
    return "".join(e.text for e in evs if e.kind == "reasoning")


WIDTHS = (1, 2, 3, 7, 0, 100_000)


class Corpus(unittest.TestCase):
    def test_every_specimen_whole_and_in_chunks(self):
        for sp in SPECIMENS:
            tools = [{"name": n, "parameters": {"properties": {}}} for n in sp["tools"]]
            seen = set()
            for width in WIDTHS:
                for st in (True, False):
                    with self.subTest(name=sp["name"], width=width, stream_tools=st):
                        evs = parse(sp["input"], width, tools, sp["finish"], st)
                        self.assertEqual(calls(evs), sp["calls"])
                        seen.add((reasoning(evs), tuple(e.call.name for e in evs if e.kind == "tool_call")))
            self.assertEqual(len(seen), 1, sp["name"])        # streamed and whole agree

    def test_the_corpus_has_the_reported_split(self):
        self.assertEqual((len(SPECIMENS), sum(bool(s["calls"]) for s in SPECIMENS)), (37, 16))


class Gates(unittest.TestCase):
    def check(self, text, expect, finish=None, tools=SCHEMA):
        for width in WIDTHS:
            with self.subTest(text=text[:40], width=width):
                evs = parse(text, width, tools, finish)
                self.assertEqual(len(calls(evs)), expect)
                if not expect:
                    self.assertEqual(reasoning(evs), text)       # nothing lost, nothing turned into content

    def test_a_stranded_call_is_recovered(self):
        self.check("I will write it now.\n\n" + CALL, 1)
        self.check(CALL, 1)
        self.check("Hmm.\n  " + CALL + "\n", 1)                    # indented opener and trailing blank lines
        self.check("Two steps.\n" + CALL + "\n\n" + CALL, 2)
        self.check("Two steps.\n" + CALL + "\n</think>\n\ndone", 1)

    def test_recovered_call_keeps_the_text_before_it(self):
        evs = parse("Let me think.\n\n" + CALL, 3)
        self.assertEqual(reasoning(evs), "Let me think.\n\n")

    def test_the_reporters_negative_controls(self):
        self.check("I could run\n" + RM + "\nbut first let me check what build holds...", 0)
        self.check("I could run\n" + RM, 0, finish="length")             # cut by max tokens: the destructive one
        self.check("Example:\n```xml\n" + RM + "\n```\nok", 0)
        self.check("Example:\n~~~\n" + RM + "\n~~~\nok", 0)
        self.check("The format is " + RM + " ok.", 0)
        self.check("I must emit `<tool_call>` then more", 0)
        self.check("Use `\n" + RM, 0)                                       # inside inline code spanning a line
        self.check("> " + RM, 0)
        self.check("Plan: " + RM, 0)

    def test_a_length_cut_keeps_even_a_clean_stranded_call_as_text(self):
        for finish in ("length", "cancel", "error", "disconnect"):
            self.check("Now.\n" + CALL, 0, finish=finish)
        self.check("Now.\n" + CALL, 1, finish="stop")

    def test_after_a_closed_fence_a_call_counts_again(self):
        self.check("```\nx\n```\n" + CALL, 1)
        self.check("~~~\nx\n~~~\n" + CALL, 1)
        self.check("a `b` c\n" + CALL, 1)

    def test_a_fence_needs_the_same_marker_to_close(self):
        self.check("~~~\n```\n" + CALL, 0)

    def test_fence_split_across_chunks(self):
        text = "Format:\n```xml\n" + CALL + "\n```\n"
        for cut in range(1, len(text)):
            with self.subTest(cut=cut):
                p = OutputParser(thinking=True, tools=SCHEMA, stream_tools=True)
                evs = p.feed(text[:cut]) + p.feed(text[cut:]) + p.finish()
                self.assertEqual(calls(evs), [])
                self.assertEqual(reasoning(evs), text)

    def test_opener_split_across_chunks(self):
        text = "Go.\n" + CALL
        for cut in range(1, len(text)):
            with self.subTest(cut=cut):
                p = OutputParser(thinking=True, tools=SCHEMA, stream_tools=True)
                evs = p.feed(text[:cut]) + p.feed(text[cut:]) + p.finish("stop")
                self.assertEqual(calls(evs), ["write"])
        quoted = "Go " + CALL
        for cut in range(1, len(quoted)):
            with self.subTest(cut=cut, quoted=True):
                p = OutputParser(thinking=True, tools=SCHEMA, stream_tools=True)
                evs = p.feed(quoted[:cut]) + p.feed(quoted[cut:]) + p.finish("stop")
                self.assertEqual(calls(evs), [])

    def test_the_end_of_the_turn_splits_a_held_tail(self):
        p = OutputParser(thinking=True, tools=SCHEMA)
        evs = p.feed("ok\n" + CALL + "\n<tool_c")           # a half opener after the call: it was prose
        evs += p.finish("stop")
        self.assertEqual(calls(evs), [])
        self.assertEqual(reasoning(evs), "ok\n" + CALL + "\n<tool_c")

    def test_a_call_waits_and_is_not_streamed_early(self):
        p = OutputParser(thinking=True, tools=SCHEMA)
        evs = p.feed("go\n" + CALL + "\n")
        self.assertEqual(calls(evs), [])                    # not yet: the turn could still say it was a quote
        self.assertEqual(calls(p.finish("stop")), ["write"])

    def test_no_tools_declared_is_unchanged(self):
        text = "before\n" + CALL + "\n</think>\n\nanswer"
        for tools in (None, []):
            evs = parse(text, 5, tools)
            self.assertEqual(calls(evs), [])
            self.assertEqual(reasoning(evs), "before\n" + CALL + "\n")

    def test_an_undeclared_name_stays_reasoning(self):
        self.check("go\n" + CALL.replace("write", "other"), 0)

    def test_the_counters(self):
        p = OutputParser(thinking=True, tools=SCHEMA)
        p.feed("go\n" + CALL)
        p.finish("length")
        self.assertEqual((p.rescued, p.refused), (0, 1))
        p = OutputParser(thinking=True, tools=SCHEMA)
        p.feed("go\n" + CALL)
        p.finish("stop")
        self.assertEqual((p.rescued, p.refused), (1, 0))


class VisibleAnswer(unittest.TestCase):
    """#1058: the same fence / inline-code rule for a call in the visible answer (after </think>)."""
    HEAD = "ok</think>\n\n"

    def run_all(self, text, finish=None):
        res = set()
        for width in WIDTHS:
            evs = parse(text, width, SCHEMA, finish)
            res.add((tuple(calls(evs)), "".join(e.text for e in evs if e.kind == "content")))
        self.assertEqual(len(res), 1, res)               # every chunking agrees
        return res.pop()

    def test_quoted_calls_stay_text(self):
        for body in ("Format:\n```xml\n" + RM + "\n```\nDone.", "Format:\n~~~\n" + RM + "\n~~~\nDone.",
                     "Use `" + RM + "` like this.", "Use `x`, then `\n" + RM + "`", "```\n" + RM,
                     "Text\n\n```python\nx = 1\n```\n```\n" + CALL):
            with self.subTest(body=body[:30]):
                got, text = self.run_all(self.HEAD + body)
                self.assertEqual(got, ())
                self.assertEqual(text, body)             # nothing lost

    def test_real_calls_still_fire(self):
        for body in (CALL, "Let me do it.\n\n" + CALL, "Let me do it. " + CALL, "```\ncode\n```\n" + CALL,
                     "`a` and `b` " + CALL, "~~~\nx\n~~~\n\n" + CALL):
            with self.subTest(body=body[:30]):
                self.assertEqual(self.run_all(self.HEAD + body)[0], ("write",))
        self.assertEqual(self.run_all(self.HEAD + CALL + "\n" + CALL)[0], ("write", "write"))

    def test_a_closed_call_in_a_length_cut_answer_stays_a_call(self):
        self.assertEqual(self.run_all(self.HEAD + "Now.\n" + CALL, finish="length")[0], ("write",))

    def test_without_thinking(self):
        p = OutputParser(thinking=False, tools=SCHEMA)
        evs = p.feed("```\n" + RM + "\n```") + p.finish()
        self.assertEqual(calls(evs), [])


class OverHttp(unittest.TestCase):
    """The same rules through the real server: OpenAI chat (whole and streamed), Anthropic and Responses."""

    def ask(self, script, max_tokens=800):
        tok = ByteTokenizer()
        svc = Service(MockEngine(tok, script, max_context=CTX), tok, ChatTemplate(ROOT / "serve/chat_template.jinja"))
        httpd = serve(svc, port=0)
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        msgs = [{"role": "user", "content": "save my notes"}]
        reqs = {
            "openai": ("/v1/chat/completions", {"tools": [{"type": "function", "function": {
                "name": "write", "parameters": {"type": "object", "properties": PROPS}}}], "messages": msgs,
                "max_tokens": max_tokens}),
            "anthropic": ("/v1/messages", {"tools": [{"name": "write", "input_schema": {
                "type": "object", "properties": PROPS}}], "messages": msgs, "max_tokens": max_tokens}),
            "responses": ("/v1/responses", {"tools": [{"type": "function", "name": "write", "parameters": {
                "type": "object", "properties": PROPS}}], "input": "save my notes", "max_output_tokens": max_tokens}),
        }
        out = {}
        try:
            for api, (path, body) in reqs.items():
                for stream in (False, True):
                    req = urllib.request.Request(base + path, data=json.dumps(dict(body, model="x", stream=stream)).encode(),
                                                 headers={"Content-Type": "application/json", "anthropic-version": "2023-06-01"})
                    with urllib.request.urlopen(req, timeout=30) as r:
                        raw = r.read().decode()
                    out[api, stream] = self.tool_uses(api, stream, raw)
        finally:
            httpd.shutdown()
            httpd.server_close()
        return out

    @staticmethod
    def tool_uses(api, stream, raw):
        """How many tool calls the answer carries."""
        if not stream:
            m = json.loads(raw)
            if api == "openai":
                return len(m["choices"][0]["message"].get("tool_calls") or [])
            if api == "anthropic":
                return sum(b["type"] == "tool_use" for b in m["content"])
            return sum(o["type"] == "function_call" for o in m["output"])
        evs = [json.loads(line[6:]) for line in raw.splitlines() if line.startswith("data: {")]
        if api == "openai":
            return len({tc["index"] for e in evs for c in e["choices"] for tc in c["delta"].get("tool_calls") or []})
        if api == "anthropic":
            return sum(e["type"] == "content_block_start" and e["content_block"]["type"] == "tool_use" for e in evs)
        return sum(e["type"] == "response.output_item.added" and e["item"]["type"] == "function_call" for e in evs)

    def test_a_stranded_call_is_a_call_in_every_api(self):
        a = self.ask("Writing the file now.\n\n" + CALL)
        self.assertEqual(set(a.values()), {1}, a)

    def test_quotes_and_cuts_are_not(self):
        for name, script, tokens in (
                ("fence", "Format:\n```xml\n" + RM + "\n```\nand that is all.", 800),
                ("midsentence", "I could run " + RM + " but no.", 800),
                ("prose after", "I could run\n" + RM + "\nbut first let me check what build holds.", 800),
                ("cut", "I could run\n" + RM + "\nthen more thinking " * 40, len("I could run\n" + RM)),
                ("cut exactly at the call", "Now.\n" + CALL + "\nmore thought " * 40, len("Now.\n" + CALL))):
            with self.subTest(name):
                a = self.ask(script, max_tokens=tokens)
                self.assertEqual(set(a.values()), {0}, a)

    def test_visible_answer_fences_on_all_three_apis(self):
        for name, body, want in (("fence", "Format:\n```xml\n" + RM + "\n```\nDone.", 0),
                                 ("inline", "Use `" + RM + "` here.", 0),
                                 ("real", "Doing it.\n\n" + CALL, 1)):
            with self.subTest(name):
                a = self.ask( "ok</think>\n\n" + body)
                self.assertEqual(set(a.values()), {want}, a)


class UnreadCall(unittest.TestCase):
    """todo #unread-call-instrument: an act the model wrote that the parser could not carry out is counted and
    named.  What comes OUT of the parser is already pinned above and by the corpus - the markup comes back as text -
    and none of that changes here.  What is new is that the turn reports it, because no existing counter covers
    it: a call swallowed by a code fence that never closes is not abandoned (the envelope closed), not refused
    (the name was declared and never reached that decision) and not an empty turn (text was delivered); an
    undeclared name inside the reasoning is not refused either (refused counts the declared ones).  A chat sees
    both as "the agent stopped instead of calling a tool"."""

    UNDECLARED = CALL.replace(FUNC_START + "write>", FUNC_START + "write_file>")
    JSON_ENV = CALL_START + '\n{"name": "write_file", "arguments": {"path": "x"}}\n' + CALL_END
    OPEN_FENCE = VisibleAnswer.HEAD + "```python\n" + CALL            # the fence is never closed
    QUOTED = VisibleAnswer.HEAD + "```python\n" + CALL + "\n```\nDone."

    def parse(self, text, tools=SCHEMA, recover=False):
        p = OutputParser(thinking=True, tools=tools, recover=recover)
        return p, p.feed(text) + p.finish()

    def test_a_call_inside_a_fence_that_never_closes_is_counted(self):
        p, evs = self.parse(self.OPEN_FENCE, recover=True)
        self.assertEqual(calls(evs), [], "the fence rule made it text - that rule is not changing here")
        self.assertEqual((p.unread, p.unread_names), (1, ["write"]), "but the turn says so, and names it")
        self.assertEqual(p.abandoned + p.rescued + p.refused, 0, "no other counter claims it")

    def test_a_call_shown_as_an_example_is_not_counted(self):
        for label, text in (("closed fence", self.QUOTED),
                            ("inline code", VisibleAnswer.HEAD + "Use `" + CALL + "` here."),
                            ("prose naming the format",
                             VisibleAnswer.HEAD + "Format: " + CALL_START + " blocks name the tool, then I explain.")):
            with self.subTest(label):
                p, evs = self.parse(text, recover=True)
                self.assertEqual(calls(evs), [])
                self.assertEqual(p.unread, 0, "the model was showing the format, not acting")

    def test_an_undeclared_name_in_the_thinking_is_counted(self):
        p, evs = self.parse("let me write it.\n" + self.UNDECLARED)
        self.assertEqual(calls(evs), [])
        self.assertEqual((p.unread, p.unread_names), (1, ["write_file"]))

    def test_a_real_call_is_not_counted(self):
        p, evs = self.parse("let me write it.\n" + CALL)
        self.assertEqual(calls(evs), ["write"], "rescued, as #804 established")
        self.assertEqual(p.unread, 0)

    def test_the_json_form_naming_nothing_declared_is_counted(self):
        p, evs = self.parse(VisibleAnswer.HEAD + self.JSON_ENV, recover=True)
        self.assertEqual(calls(evs), [])
        self.assertEqual((p.unread, p.unread_names), (1, ["write_file"]))
        p, _ = self.parse(VisibleAnswer.HEAD + self.JSON_ENV.replace("write_file", "write"), recover=True)
        self.assertEqual(p.unread, 0, "the same envelope naming a declared tool is a call, not an unread act")

    def test_a_pending_undeclared_call_is_counted_when_the_thinking_releases(self):
        p, evs = self.parse("let me write.\n" + CALL + "\n" + self.UNDECLARED)
        self.assertEqual(calls(evs), ["write"], "the declared one is rescued, as #804 established")
        self.assertEqual((p.unread, p.unread_names), (1, ["write_file"]), "the other went back as reasoning")

    def test_a_call_in_a_fence_inside_the_thinking_is_counted(self):
        p, evs = self.parse("```python\n" + CALL)
        self.assertEqual(calls(evs), [])
        self.assertEqual((p.unread, p.unread_names), (1, ["write"]))
        p, _ = self.parse("```python\n" + CALL + "\n```\nmore thinking")
        self.assertEqual(p.unread, 0, "a fence that closes inside the thinking is an example, not a swallowed act")

    def test_the_count_does_not_depend_on_how_the_text_arrives(self):
        for width in WIDTHS:
            p = OutputParser(thinking=True, tools=SCHEMA, recover=True)
            i, rnd = 0, random.Random(7)
            while i < len(self.OPEN_FENCE):
                k = width or rnd.randint(1, 9)
                p.feed(self.OPEN_FENCE[i:i + k])
                i += k
            p.finish()
            with self.subTest(width=width):
                self.assertEqual(p.unread, 1)
                self.assertEqual(p.unread_names, ["write"], "named even when the opener arrives one character "
                                                           "at a time")

    def test_the_server_logs_it_and_counts_it(self):
        tok = ByteTokenizer()
        svc = Service(MockEngine(tok, self.OPEN_FENCE, max_context=CTX), tok,
                      ChatTemplate(ROOT / "serve/chat_template.jinja"))
        httpd = serve(svc, port=0)
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        body = {"model": "x", "messages": [{"role": "user", "content": "save my notes"}], "max_tokens": 800,
                "tools": [{"type": "function", "function": {"name": "write",
                                                            "parameters": {"type": "object", "properties": PROPS}}}]}
        out = io.StringIO()
        try:
            with redirect_stdout(out):
                req = urllib.request.Request(base + "/v1/chat/completions", data=json.dumps(body).encode(),
                                             headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=30) as r:
                    r.read()
        finally:
            httpd.shutdown()
            httpd.server_close()
        said = out.getvalue()
        self.assertIn("came back as text and never ran", said, said)
        self.assertIn("write", said, "the line names what the model asked for")
        self.assertEqual(svc.totals.get("unread_tool_calls"), 1, "and /metrics can see the count")
        # deliberately NOT asserted on svc.history: that record is written before parser.finish() runs, and an
        # unclosed fence is only known to be an act (rather than a quoted example) at the end of the turn.  A
        # field there would read "none" for the one shape this exists to catch.


class DriftMarkup(unittest.TestCase):
    """todo #unread-call-recovery: the shapes that are not the template's envelope at all, so the envelope logic
    never sees them and item unread-call-instrument's counter cannot either.  Measured on this tree before any
    handling: a function opener with a space where = should be, and the invoke dialect, both come back as plain
    text with every counter at zero - that is the death the chat sees as "the agent stopped instead of calling a
    tool".  And a parameter written as a named parameter tag, or as an XML element, fires a call with NO
    arguments: the tool runs, answers, and nothing says the arguments were lost - worse than a death, because the
    conversation goes on as if it worked.  What the parser DELIVERS does not change here; the counters do."""

    LT = FUNC_START[:1]                       # composed from the constants, never spelled out
    CALL_RUN = (CALL_START + "\n" + FUNC_START + "run>\n" + PARAM_START + "cmd>\nls\n" + PARAM_END
                + "\n" + FUNC_END + "\n" + CALL_END)
    SPACE = LT + "function run>\n" + PARAM_START + "cmd>\nls\n" + PARAM_END + "\n" + FUNC_END
    INVOKE = (LT + 'invoke name="run">\n' + LT + 'parameter name="cmd">\nls\n' + LT + "/parameter>\n"
              + LT + "/invoke>")
    NAMED = (CALL_START + "\n" + FUNC_START + "run>\n" + LT + 'parameter name="cmd">\nls\n' + LT
             + "/parameter>\n" + FUNC_END + "\n" + CALL_END)
    ELEMENT = (CALL_START + "\n" + FUNC_START + "run>\n" + LT + "cmd>ls" + LT + "/cmd>\n" + FUNC_END
               + "\n" + CALL_END)
    SCHEMA = [{"name": "run", "parameters": {"properties": {"cmd": {"type": "string"}}}}]

    def parse(self, text, thinking=False):
        p = OutputParser(thinking=thinking, tools=self.SCHEMA, recover=True, stream_tools=True)
        return p, p.feed(text) + p.finish()

    def test_the_drift_shapes_are_counted_and_named(self):
        for label, body in (("a function opener with a space", self.SPACE), ("the invoke dialect", self.INVOKE)):
            with self.subTest(label):
                p, evs = self.parse(body)
                self.assertEqual(calls(evs), [], "no call ran - that is the death")
                self.assertEqual(p.drift, 1, "and the turn now says so")
                self.assertTrue(p.drift_kinds)
                self.assertEqual(p.unread + p.abandoned + p.rescued + p.refused, 0,
                                 "no other counter sees it either: this was the whole blind spot")

    def test_a_quoted_example_is_not_counted(self):
        for label, body in (("closed fence", VisibleAnswer.HEAD + "Format:\n```xml\n" + self.CALL_RUN + "\n```\nNot running it."),
                            ("tilde fence", VisibleAnswer.HEAD + "Example:\n~~~\n" + self.CALL_RUN + "\n~~~\nEnd of it."),
                            ("inline code", VisibleAnswer.HEAD + "Use `" + self.CALL_RUN + "` to call it.")):
            with self.subTest(label):
                p, evs = self.parse(body, thinking=True)
                self.assertEqual(calls(evs), [])
                self.assertEqual(p.drift, 0, "the model was writing about a call, not making one")

    def test_a_call_swallowed_by_an_unclosed_fence_is_counted_once_not_twice(self):
        p, evs = self.parse(VisibleAnswer.HEAD + "```python\n" + self.CALL_RUN, thinking=True)
        self.assertEqual(calls(evs), [])
        self.assertEqual(p.unread, 1, "that shape belongs to unread-call-instrument")
        self.assertEqual(p.drift, 0, "and drift does not claim it as well")

    def test_a_turn_that_ran_its_call_is_not_counted_even_if_it_mentions_the_shape(self):
        # the guard is "this round delivered a call", not "the reply contains nothing shaped like one": a model
        # that ran a tool and then wrote about the format in prose is not the death this counts
        p, evs = self.parse(self.CALL_RUN + "\nBy the way, one writes " + self.LT + "function name> for this.")
        self.assertEqual(calls(evs), ["run"])
        self.assertEqual(p.drift, 0, "the round ran its call; what follows is prose")

    def test_a_call_that_fires_with_no_arguments_is_counted(self):
        # the named-parameter form is fixed (class NamedParameterForm); this pins the shape that is still not
        # read - a parameter written as an XML element, which upstream handles in a later commit of the series
        p, evs = self.parse(self.ELEMENT)
        got = [(c.call.name, c.call.arguments) for c in evs if c.kind == "tool_call"]
        self.assertEqual([g[0] for g in got], ["run"], "the tool DID run")
        self.assertEqual(got[0][1], {}, "with nothing in it")
        self.assertEqual((p.empty_args, p.empty_args_names), (1, ["run"]))


    def test_a_real_call_and_a_plain_answer_count_nothing(self):
        p, evs = self.parse(self.CALL_RUN)
        self.assertEqual(calls(evs), ["run"])
        self.assertEqual((p.drift, p.empty_args), (0, 0))
        p, evs = self.parse("All good, nothing to run.")
        self.assertEqual((p.drift, p.empty_args, p.unread), (0, 0, 0))

    def test_the_count_does_not_depend_on_how_the_text_arrives(self):
        for width in WIDTHS:
            p = OutputParser(thinking=False, tools=self.SCHEMA, recover=True, stream_tools=True)
            i, rnd = 0, random.Random(7)
            while i < len(self.INVOKE):
                k = width or rnd.randint(1, 9)
                p.feed(self.INVOKE[i:i + k])
                i += k
            p.finish()
            with self.subTest(width=width):
                self.assertEqual(p.drift, 1)
                self.assertIn("the invoke dialect", p.drift_kinds)

    def test_the_server_logs_the_drift_and_counts_it(self):
        tok = ByteTokenizer()
        svc = Service(MockEngine(tok, self.INVOKE, max_context=CTX), tok,
                      ChatTemplate(ROOT / "serve/chat_template.jinja"))
        httpd = serve(svc, port=0)
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        body = {"model": "x", "messages": [{"role": "user", "content": "list the files"}], "max_tokens": 800,
                "tools": [{"type": "function", "function": {"name": "run",
                                                            "parameters": {"type": "object", "properties": {
                                                                "cmd": {"type": "string"}}}}}]}
        out = io.StringIO()
        try:
            with redirect_stdout(out):
                req = urllib.request.Request(base + "/v1/chat/completions", data=json.dumps(body).encode(),
                                             headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=30) as r:
                    r.read()
        finally:
            httpd.shutdown()
            httpd.server_close()
        said = out.getvalue()
        self.assertIn("not the template's form", said, said[:400])
        self.assertIn("the invoke dialect", said, "the line names the shape, never the text")
        self.assertEqual(svc.totals.get("drift_tool_markup"), 1)
        self.assertIsNone(svc.totals.get("calls_with_empty_args"), "absent means zero, like the other counters")


class NamedParameterForm(unittest.TestCase):
    """The named parameter form - upstream #5969's third form, item unread-call-recovery.  Before: it parsed to
    NO arguments, so the tool ran with nothing and answered as if it had worked; with two parameters, the second
    one named, the first value swallowed the closer and the next parameter's whole opener.  Now it is the same
    parameter the template's form is.  The template's own form is untouched, including #210's case where a value
    quotes the tags."""

    LT = FUNC_START[:1]
    SCHEMA = [{"name": "run", "parameters": {"properties": {"cmd": {"type": "string"}, "n": {"type": "integer"}}}}]

    def envelope(self, params):
        return CALL_START + "\n" + FUNC_START + "run>\n" + params + FUNC_END + "\n" + CALL_END

    def parse(self, text):
        p = OutputParser(thinking=False, tools=self.SCHEMA, recover=True, stream_tools=True)
        return p, p.feed(text) + p.finish()

    def one(self, text):
        _, evs = self.parse(text)
        calls = [c.call for c in evs if c.kind == "tool_call"]
        self.assertEqual(len(calls), 1, [e.kind for e in evs])
        return calls[0].arguments

    def test_a_named_parameter_is_the_parameter(self):
        self.assertEqual(self.one(self.envelope(
            self.LT + 'parameter name="cmd">\nls\n' + self.LT + "/parameter>\n")), {"cmd": "ls"})
        self.assertEqual(self.one(self.envelope(
            self.LT + "parameter name='cmd'>\nls\n" + self.LT + "/parameter>\n")), {"cmd": "ls"})
        self.assertEqual(self.one(self.envelope(
            self.LT + 'parameter  name = "cmd" >\nls\n' + self.LT + "/parameter>\n")), {"cmd": "ls"})

    def test_two_parameters_one_named_are_both_read(self):
        args = self.one(self.envelope(
            PARAM_START + "cmd>\nls\n" + PARAM_END + "\n" + self.LT + 'parameter name="n">\n3\n'
            + self.LT + "/parameter>\n"))
        self.assertEqual(args, {"cmd": "ls", "n": 3}, "the mangled single value this used to give is the bug")

    def test_the_template_form_and_a_value_that_quotes_the_tags_are_unchanged(self):
        self.assertEqual(self.one(self.envelope(PARAM_START + "cmd>\nls\n" + PARAM_END + "\n")), {"cmd": "ls"})
        quoted = PARAM_START + "cmd>\nuse " + PARAM_START + "x>" + PARAM_END + " like this\n" + PARAM_END + "\n"
        self.assertEqual(self.one(self.envelope(quoted)),
                         {"cmd": "use " + PARAM_START + "x>" + PARAM_END + " like this"}, "#210")

    def test_the_named_form_no_longer_counts_as_an_empty_call(self):
        p, _ = self.parse(self.envelope(self.LT + 'parameter name="cmd">\nls\n' + self.LT + "/parameter>\n"))
        self.assertEqual((p.empty_args, p.drift, p.unread), (0, 0, 0))

    def test_it_holds_across_the_chunk_sizes_and_without_streaming(self):
        body = self.envelope(self.LT + 'parameter name="cmd">\nls\n' + self.LT + "/parameter>\n")
        for width in WIDTHS:
            for st in (True, False):
                p = OutputParser(thinking=False, tools=self.SCHEMA, recover=True, stream_tools=st)
                i, rnd, evs = 0, random.Random(7), []
                while i < len(body):
                    k = width or rnd.randint(1, 9)
                    evs += p.feed(body[i:i + k])
                    i += k
                evs += p.finish()
                got = [c.call.arguments for c in evs if c.kind == "tool_call"]
                with self.subTest(width=width, stream_tools=st):
                    self.assertEqual(got, [{"cmd": "ls"}])


if __name__ == "__main__":
    unittest.main()
