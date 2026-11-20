"""serve/test_mcp.py - tools from MCP servers (serve/mcp.py) and the web app's tool loop, against the mock engine and
the fake MCP server in serve/mcp_fake_server.py (no GPU, no pack, no MCP SDK).

    python -m unittest serve.test_mcp -v
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from serve import mcp as mcp_mod  # noqa: E402
from serve import mcp_fake_server as fake  # noqa: E402
from serve.frontend import ChatTemplate  # noqa: E402
from serve.mcp import McpCancelled, McpHub, hub_from_config  # noqa: E402
from serve.server import ByteTokenizer, MockEngine, Service, serve  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
FAKE = str(ROOT / "serve" / "mcp_fake_server.py")
CTX = 8192


def stdio(*args, **extra):
    return {"command": sys.executable, "args": [FAKE, *args], **extra}


def call_script(name, **params):
    """The model's text for one tool call, as Qwen's template asks for it."""
    body = "".join(f"<parameter={k}>\n{v}\n</parameter>\n" for k, v in params.items())
    return f"</think>\n\nLet me check.\n\n<tool_call>\n<function={name}>\n{body}</function>\n</tool_call>"


class FakeVision:
    """A stand-in encoder (serve/test_server.py's): every picture is three rows in one file it owns."""

    def __init__(self, d):
        self.dir = Path(d)
        self.rows = self.dir / "img.sve"
        self.rows.write_bytes(b"rows")

    def encode(self, source):
        return self.rows, 3


class ScriptedEngine(MockEngine):
    """A mock engine with one script per call (the last one repeats): a tool call first, then the answer."""

    def __init__(self, tok, scripts, max_context=CTX, delay_s=0.0):
        super().__init__(tok, list(scripts), max_context=max_context, delay_s=delay_s)
        self.prompts = []

    def generate(self, ids, max_new, sampling, cancel, embeddings=None):
        self.prompts.append(list(ids))
        yield from super().generate(ids, max_new, sampling, cancel, embeddings)

    def prompt_text(self, i):
        return bytes(t for t in self.prompts[i] if t < 256).decode("utf-8", "replace")


# ------------------------------------------------------------------------------------------------ the client
class Client(unittest.TestCase):
    """The stdio client against the fake server: start, pagination, calls, errors, crashes, timeouts, the cap."""

    @classmethod
    def setUpClass(cls):
        cls.log = tempfile.NamedTemporaryFile(delete=False, suffix=".jsonl")
        cls.log.close()
        os.environ["FAKE_MCP_LOG"] = cls.log.name
        cls.hub = McpHub({"fake": stdio(), "paged": stdio("--page", "4"), "broken": stdio("--crash-at-start"),
                          "missing": {"command": "strata-no-such-program"}},
                         {"timeout_s": 1.5, "max_result_chars": 1000})
        cls.hub.start(wait=True)

    @classmethod
    def tearDownClass(cls):
        cls.hub.close()
        del os.environ["FAKE_MCP_LOG"]
        os.unlink(cls.log.name)

    def test_initialize_and_list_every_page(self):
        s = self.hub.servers["fake"]
        self.assertEqual(s.status, "ready")
        self.assertEqual(s.info["name"], "fake")
        self.assertEqual(s.info["protocol"], "2025-06-18")
        want = [t["name"] for t in fake.TOOLS]
        self.assertEqual([t["name"] for t in s.tools], want)         # 3 pages of 2
        self.assertEqual([t["name"] for t in self.hub.servers["paged"].tools], want)   # 2 pages of 4

    def test_namespaced_openai_tools(self):
        tools = self.hub.openai_tools()
        names = [t["function"]["name"] for t in tools]
        self.assertIn("fake__echo", names)
        self.assertIn("paged__echo", names)
        echo = next(t for t in tools if t["function"]["name"] == "fake__echo")
        self.assertEqual(echo["type"], "function")
        self.assertEqual(echo["function"]["parameters"]["properties"]["text"]["type"], "string")

    def test_a_server_that_fails_is_left_out(self):
        for name, why in (("broken", "missing configuration"), ("missing", "could not start")):
            with self.subTest(name=name):
                s = self.hub.servers[name]
                self.assertEqual(s.status, "failed")
                self.assertIn(why, s.error)
                self.assertFalse([t for t in self.hub.template_tools() if t["name"].startswith(name + "__")])
        st = {s["name"]: s for s in self.hub.status()["servers"]}
        self.assertEqual(st["broken"]["status"], "failed")
        self.assertEqual(st["fake"]["status"], "ready")

    def test_call(self):
        self.hub.routes()
        r = self.hub.call("fake__echo", {"text": "hello wörld"})
        self.assertEqual((r["ok"], r["text"], r["server"], r["tool"]), (True, "hello wörld", "fake", "echo"))
        self.assertEqual(self.hub.call("fake__add", {"a": 2, "b": 40})["text"], "42")
        self.assertEqual(self.hub.call("fake__echo", {"text": "hi"})["images"], [])     # text-only: no pictures

    def test_a_picture_result_is_a_picture(self):
        """An MCP image block (get_image, a screenshot) comes back as the picture itself, not only as a note."""
        self.hub.routes()
        r = self.hub.call("fake__image", {"n": 2})
        self.assertTrue(r["ok"])
        named = f"[image (image/png, {len(fake.PNG) * 3 // 4:,} bytes)]"
        self.assertEqual(r["text"], f"a picture\n{named}\n{named}")            # the text still says one came
        self.assertEqual([i["source"] for i in r["images"]],
                         [f"data:image/png;base64,{fake.PNG}"] * 2)            # ...and here it is

    def test_a_picture_over_the_limit_is_only_named(self):
        """A server must not be able to hand the conversation a picture of any size."""
        with mock.patch.object(mcp_mod, "MAX_IMAGE_BYTES", 10):
            text, images = mcp_mod.result_text(fake.image_result(1))
        self.assertEqual(images, [])
        self.assertIn("too big for the model, not shown", text)

    def test_errors_become_text(self):
        self.hub.routes()
        r = self.hub.call("fake__fail", {})                         # the tool's own error (isError)
        self.assertFalse(r["ok"])
        self.assertEqual(r["text"], "error: it failed on purpose")
        r = self.hub.call("nobody__nothing", {})                    # not a tool at all
        self.assertTrue(r["text"].startswith("error: there is no tool"))
        # a JSON-RPC error from the server
        s = self.hub.servers["fake"]
        with self.assertRaises(Exception) as ctx:
            s.call("no-such-tool", {}, 5)
        self.assertIn("unknown tool", str(ctx.exception))

    def test_timeout(self):
        self.hub.routes()
        t0 = time.monotonic()
        r = self.hub.call("fake__sleep", {"seconds": 5})
        self.assertLess(time.monotonic() - t0, 4)
        self.assertFalse(r["ok"])
        self.assertIn("timed out after 1.5 s", r["text"])
        self.assertEqual(self.hub.call("fake__echo", {"text": "still here"})["text"], "still here")

    def test_truncation(self):
        self.hub.routes()
        r = self.hub.call("fake__big", {"n": 50000})
        self.assertTrue(r["ok"])
        self.assertTrue(r["truncated"])
        self.assertEqual(r["chars"], 50000)
        self.assertTrue(r["text"].startswith("y" * 1000 + "\n\n[... truncated"))
        self.assertIn("50,000 characters", r["text"])
        self.assertLess(len(r["text"]), 1200)

    def test_crash_mid_call_then_restart(self):
        hub = McpHub({"solo": stdio()}, {"timeout_s": 5})
        hub.start(wait=True)
        try:
            hub.routes()
            r = hub.call("solo__die", {})
            self.assertFalse(r["ok"])
            self.assertIn("the server stopped", r["text"])
            self.assertIn("dying on purpose", r["text"])
            self.assertEqual(hub.servers["solo"].status, "stopped")
            self.assertIn("solo__echo", hub.routes())                # its tools stay: the next call restarts it
            self.assertEqual(hub.call("solo__echo", {"text": "back"})["text"], "back")
            self.assertEqual(hub.servers["solo"].status, "ready")
        finally:
            hub.close()

    def test_cancel(self):
        self.hub.routes()
        cancel = threading.Event()
        threading.Timer(0.3, cancel.set).start()
        t0 = time.monotonic()
        with self.assertRaises(McpCancelled):
            self.hub.call("fake__sleep", {"seconds": 1.2}, cancel)
        self.assertLess(time.monotonic() - t0, 1.0)
        time.sleep(0.3)
        seen = [json.loads(line) for line in Path(self.log.name).read_text().splitlines()]
        self.assertTrue(any("cancelled" in e for e in seen), seen)   # notifications/cancelled reached the server



class ToolOff(unittest.TestCase):
    """One tool of a server turned off in the config (todo #tool-exclude).  The model must never be told it
    exists, a call naming it must get the same answer as a tool that was never there, and the Monitor must still
    show it - as off, under the name the model would have seen - so it can be switched back on."""

    def setUp(self):
        self.log = tempfile.NamedTemporaryFile(delete=False, suffix=".jsonl")
        self.log.close()
        os.environ["FAKE_MCP_LOG"] = self.log.name
        self.hub = McpHub({"fake": stdio(disabled_tools=["echo"])},
                          {"timeout_s": 10, "max_result_chars": 500})
        self.hub.start(wait=True)

    def tearDown(self):
        self.hub.close()
        del os.environ["FAKE_MCP_LOG"]
        os.unlink(self.log.name)

    def test_offered_not_routed_and_still_listed(self):
        self.assertIn("fake__add", self.hub.routes())                # the server's other tools stay
        self.assertNotIn("fake__echo", self.hub.routes())
        self.assertNotIn("fake__echo", [t["name"] for t in self.hub.template_tools()])
        st = self.hub.status()
        self.assertEqual(st["tools"], len(self.hub.routes()))        # the count the Monitor prints
        row = {t["tool"]: t for t in st["servers"][0]["tools"]}
        self.assertIs(row["echo"]["enabled"], False)
        self.assertEqual(row["echo"]["name"], "fake__echo")          # the name the model would have seen
        self.assertIs(row["add"]["enabled"], True)
        r = self.hub.call("fake__echo", {"text": "x"})
        self.assertFalse(r["ok"])
        self.assertIn("no tool named", r["text"])

    def test_the_shape_is_checked_at_the_start(self):
        for bad in ("echo", {"a": 1}, ["ok", 5], ["  "], [""], 7):
            with self.subTest(bad=bad), self.assertRaises(SystemExit):
                mcp_mod.servers_from({"x": {"command": "c", "disabled_tools": bad}}, "test")
        self.assertEqual(mcp_mod.servers_from({"x": {"command": "c", "disabled_tools": ["a", "b"]}},
                                              "test")["x"]["disabled_tools"], ["a", "b"])


class HttpClient(unittest.TestCase):
    """Streamable HTTP: JSON answers, an event-stream answer, the session id."""

    @classmethod
    def setUpClass(cls):
        cls.httpd = fake.http_server(0)
        url = f"http://127.0.0.1:{cls.httpd.server_address[1]}/mcp"
        cls.hub = McpHub({"web": {"url": url}, "down": {"url": "http://127.0.0.1:9/mcp"}}, {"timeout_s": 1.5})
        cls.hub.start(wait=True)

    @classmethod
    def tearDownClass(cls):
        cls.hub.close()
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def test_list_and_call(self):
        s = self.hub.servers["web"]
        self.assertEqual(s.status, "ready", s.error)
        self.assertEqual(len(s.tools), len(fake.TOOLS))             # pages, with the session id on each request
        self.assertEqual(s.transport.session, "s-1")
        self.hub.routes()
        self.assertEqual(self.hub.call("web__echo", {"text": "over http"})["text"], "over http")   # event stream
        self.assertEqual(self.hub.call("web__fail", {})["text"], "error: it failed on purpose")

    def test_timeout_and_unreachable(self):
        self.hub.routes()
        r = self.hub.call("web__sleep", {"seconds": 4})
        self.assertIn("timed out", r["text"])
        self.assertEqual(self.hub.servers["down"].status, "failed")
        self.assertIn("could not reach", self.hub.servers["down"].error)


class Config(unittest.TestCase):
    def test_both_spellings_and_the_file(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "claude_desktop_config.json")
            Path(path).write_text(json.dumps({"mcpServers": {"b": {"url": "http://x/mcp"}, "a": stdio()}}),
                                  encoding="utf-8")
            hub = hub_from_config({"mcp_servers": {"a": {"command": "old"}},
                                   "mcpServers": {"c": stdio(), "off": {"command": "x", "disabled": True}},
                                   "mcp": {"timeout_s": 5, "max_result_chars": 100, "max_rounds": 3}}, path)
            self.assertEqual(sorted(hub.servers), ["a", "b", "c"])
            self.assertEqual(hub.servers["a"].cfg["command"], sys.executable)   # the file wins a name clash
            self.assertEqual(hub.servers["b"].kind, "http")
            self.assertEqual((hub.settings["timeout_s"], hub.settings["max_result_chars"], hub.settings["max_rounds"]),
                             (5.0, 100, 3))
        self.assertIsNone(hub_from_config({}))
        self.assertEqual(McpHub({}).settings["max_result_chars"], 20000)

    def test_bad_entries_stop_the_start(self):
        for cfg in ({"mcp_servers": {"x": {}}}, {"mcp_servers": {"x": {"command": "a", "args": "b"}}},
                    {"mcp_servers": ["x"]}, {"mcpServers": {"x": {"url": "http://a", "type": "sse"}}},
                    {"mcp_servers": {"x": {"command": "a"}}, "mcp": {"timeout_s": 0}},
                    {"mcp_servers": {"x": {"command": "a"}}, "mcp": {"max_rounds": 1.5}}):
            with self.subTest(cfg=cfg), self.assertRaises(SystemExit):
                hub_from_config(cfg)
        with self.assertRaises(SystemExit):
            hub_from_config({}, os.path.join(tempfile.gettempdir(), "strata-no-such-mcp.json"))


# ------------------------------------------------------------------------------------------------ the tool loop
class LoopFixture(unittest.TestCase):
    """The web app's chat against the fake MCP hub: one script per engine call, the streamed answer read
    back as events.  Shared by ToolLoop and UnknownCall, so neither one inherits the other's tests."""

    def setUp(self):
        self.log = tempfile.NamedTemporaryFile(delete=False, suffix=".jsonl")
        self.log.close()
        os.environ["FAKE_MCP_LOG"] = self.log.name
        self.hub = McpHub({"fake": stdio(), "broken": stdio("--crash-at-start")},
                          {"timeout_s": 10, "max_result_chars": 500, "max_rounds": 2})
        self.hub.start(wait=True)
        self.httpd = None

    def tearDown(self):
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
        self.hub.close()
        del os.environ["FAKE_MCP_LOG"]
        os.unlink(self.log.name)

    def start(self, *scripts, delay_s=0.0):
        tok = ByteTokenizer()
        self.engine = ScriptedEngine(tok, list(scripts), delay_s=delay_s)
        self.svc = Service(self.engine, tok, ChatTemplate(ROOT / "serve/chat_template.jinja"))
        self.svc.mcp = self.hub
        self.httpd = serve(self.svc, port=0)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def post(self, body, headers=None, stream=True):
        body = {"model": "m", "messages": [{"role": "user", "content": "check it"}], "stream": stream, **body}
        req = urllib.request.Request(self.base + "/v1/chat/completions", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                text = r.read().decode()
                return r.status, text
        except urllib.error.HTTPError as e:
            with e:
                return e.code, e.read().decode()

    @staticmethod
    def chunks(text):
        return [json.loads(line[6:]) for line in text.splitlines() if line.startswith("data: {")]


class ToolLoop(LoopFixture):
    """The web app's chat (`"strata_mcp": true`): the model calls an MCP tool, the server runs it and the model
    answers with its result; plain API requests never see the MCP tools."""


    def test_argument_pieces_stream_when_the_client_asks(self):
        # todo #tool-args-stream: the page asks for a call's JSON as it is written, so it can show what the model is typing
        # instead of a static "(being written)".  It only happens for a request that asks - the test above
        # asserts the plain start/call/result sequence for one that does not.
        self.start(call_script("fake__echo", text="hello from the tool"), "</think>\n\nThe tool said hello.")
        code, text = self.post({"strata_mcp": True, "strata_mcp_args": True})
        self.assertEqual(code, 200, text)
        mcp = [c["strata_mcp"] for c in self.chunks(text) if "strata_mcp" in c]
        kinds = [m["event"] for m in mcp]
        self.assertEqual(kinds[0], "start")                      # the block appears before its JSON does
        self.assertIn("args", kinds)
        self.assertGreater(len([k for k in kinds if k == "args"]), 1, "pieces, not one lump at the end")
        self.assertEqual(kinds[-2:], ["call", "result"])         # the finished call still arrives whole
        pieces = "".join(m["text"] for m in mcp if m["event"] == "args")
        call = next(m for m in mcp if m["event"] == "call")
        self.assertEqual(json.loads(pieces), call["arguments"], "the pieces reassemble into the call's arguments")
        self.assertTrue(all(m["id"] == call["id"] for m in mcp if m["event"] == "args"),
                        "and they belong to that call")

    def test_the_turn_numbers_survive_the_tool_wait(self):
        # the Context fill gauge reads live.prompt_tokens + live.generated, and every one of those was gated on
        # busy - which is False between engine rounds. So mid-turn, while a tool ran, the gauge showed 0%
        # (the human's report). The numbers are in status for the whole turn; the gate had to include the wait.
        self.start(call_script("fake__sleep", seconds=1.5), "</think>\n\ndone.")
        threading.Thread(target=self.post, args=({"strata_mcp": True},), daemon=True).start()
        base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        seen, deadline = None, time.time() + 6
        while time.time() < deadline:
            with urllib.request.urlopen(base + "/metrics", timeout=5) as r:
                live = json.loads(r.read())["live"]
            if live["state"] == "running-tool":
                seen = live
                break
            time.sleep(0.03)
        self.assertIsNotNone(seen, "never caught the tool running")
        self.assertIsNotNone(seen["prompt_tokens"], "the prompt this turn is holding, still named during the wait")
        self.assertIsNotNone(seen["elapsed_s"])
        self.assertGreater(seen["prompt_tokens"], 0)

    def test_a_running_tool_is_a_state_of_its_own(self):
        # measured 2026-10-23: while an MCP call ran, /metrics answered live.state = "idle" in 3 of 3 samples -
        # the one moment a user wants to know something is happening was reported as nothing happening (todo #waiting-state)
        self.start(call_script("fake__sleep", seconds=1.2), "</think>\n\ndone.")
        threading.Thread(target=self.post, args=({"strata_mcp": True},), daemon=True).start()
        base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        states, tools = [], []
        deadline = time.time() + 4
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(base + "/metrics", timeout=5) as r:
                    live = json.loads(r.read())["live"]
            except (urllib.error.URLError, KeyError):
                time.sleep(0.05)
                continue
            states.append(live["state"])
            if live["state"] == "running-tool":
                tools.append(live["tool"])
            if tools:
                break
            time.sleep(0.05)
        self.assertIn("running-tool", states, states)
        self.assertEqual(set(tools), {"fake__sleep"}, tools)
        first = states.index("running-tool")
        self.assertNotIn("idle", states[first:],
                         "once a turn of ours is in hand, the tab is never told nothing is happening")

    def test_tool_call_then_answer(self):
        self.start(call_script("fake__echo", text="hello from the tool"), "</think>\n\nThe tool said hello.")
        code, text = self.post({"strata_mcp": True})
        self.assertEqual(code, 200, text)
        cs = self.chunks(text)
        mcp = [c["strata_mcp"] for c in cs if "strata_mcp" in c]
        self.assertEqual([m["event"] for m in mcp], ["start", "call", "result"])
        self.assertEqual(mcp[1]["arguments"], {"text": "hello from the tool"})
        self.assertEqual((mcp[1]["server"], mcp[1]["tool"]), ("fake", "echo"))
        self.assertEqual((mcp[2]["ok"], mcp[2]["text"]), (True, "hello from the tool"))
        self.assertEqual(len({m["id"] for m in mcp}), 1)
        content = "".join((c["choices"][0]["delta"].get("content") or "") for c in cs)
        self.assertEqual(content, "Let me check.The tool said hello.")
        self.assertFalse([c for c in cs if c["choices"][0]["delta"].get("tool_calls")])   # nothing for the client to run
        self.assertEqual(cs[-1]["choices"][0]["finish_reason"], "stop")
        self.assertEqual(len(self.engine.prompts), 2)
        first, second = self.engine.prompt_text(0), self.engine.prompt_text(1)
        self.assertIn('"name": "fake__echo"', first)                 # the MCP tools are in the prompt
        self.assertNotIn("broken__", first)                          # the server that failed is left out
        self.assertIn("<function=fake__echo>\n<parameter=text>\nhello from the tool\n</parameter>", second)
        self.assertIn("<tool_response>\nhello from the tool\n</tool_response>", second)
        self.assertEqual(cs[-1]["usage"]["prompt_tokens"], len(self.engine.prompts[1]))

    def test_a_call_the_output_ends_inside_is_not_run(self):
        """#211: the model's turn ends inside an MCP call: nothing runs (it used to run with no arguments)."""
        script = call_script("fake__echo", text="hello from the tool")
        self.start(script[:script.index("from the tool")], "</think>\n\nnever")
        code, text = self.post({"strata_mcp": True})
        self.assertEqual(code, 200, text)
        cs = self.chunks(text)
        mcp = [c["strata_mcp"] for c in cs if "strata_mcp" in c]
        self.assertEqual([m["event"] for m in mcp], ["start"])        # the web app shows it as "Not run" at the end
        self.assertEqual(len(self.engine.prompts), 1)
        self.assertNotIn('"call"', Path(self.log.name).read_text())    # nothing ran
        self.assertEqual(cs[-1]["choices"][0]["finish_reason"], "stop")

    def test_non_stream(self):
        self.start(call_script("fake__add", a=2, b=3), "</think>\n\n5.")
        code, text = self.post({"strata_mcp": True}, stream=False)
        self.assertEqual(code, 200, text)
        msg = json.loads(text)["choices"][0]["message"]
        self.assertEqual(msg["content"], "Let me check.5.")
        self.assertEqual(msg["strata_mcp"][-1]["text"], "5")

    def test_plain_requests_get_no_mcp_tools(self):
        self.start(call_script("fake__echo", text="x"), "</think>\n\nnever")
        code, text = self.post({})
        self.assertEqual(code, 200, text)
        self.assertNotIn("fake__echo", self.engine.prompt_text(0))
        cs = self.chunks(text)
        self.assertFalse([c for c in cs if "strata_mcp" in c])
        self.assertEqual(cs[-1]["choices"][0]["finish_reason"], "tool_calls")   # returned to the client as always
        self.assertEqual(len(self.engine.prompts), 1)
        self.assertNotIn('"call"', Path(self.log.name).read_text())    # nothing ran
        for req in ({"strata_mcp": "yes"}, {"strata_mcp": 1}):         # only a real true opts in
            self.post(req)
            self.assertNotIn("fake__echo", self.engine.prompt_text(-1))

    def test_own_tools_still_go_to_the_client(self):
        own = [{"type": "function", "function": {"name": "lookup", "parameters": {"type": "object", "properties": {
            "q": {"type": "string"}}}}}]
        self.start(call_script("lookup", q="x"), "</think>\n\nnever")
        code, text = self.post({"strata_mcp": True, "tools": own})
        cs = self.chunks(text)
        calls = [tc for c in cs for tc in c["choices"][0]["delta"].get("tool_calls") or []]
        self.assertEqual(calls[0]["function"]["name"], "lookup")
        self.assertEqual(cs[-1]["choices"][0]["finish_reason"], "tool_calls")
        self.assertIn('"name": "lookup"', self.engine.prompt_text(0))
        self.assertIn('"name": "fake__echo"', self.engine.prompt_text(0))
        self.assertEqual(len(self.engine.prompts), 1)

    def test_tool_error_is_a_result(self):
        self.start(call_script("fake__fail"), "</think>\n\nIt failed.")
        code, text = self.post({"strata_mcp": True})
        mcp = [c["strata_mcp"] for c in self.chunks(text) if "strata_mcp" in c]
        self.assertEqual((mcp[-1]["ok"], mcp[-1]["text"]), (False, "error: it failed on purpose"))
        self.assertIn("<tool_response>\nerror: it failed on purpose\n</tool_response>", self.engine.prompt_text(1))
        self.assertEqual(self.chunks(text)[-1]["choices"][0]["finish_reason"], "stop")

    def test_truncated_for_the_model(self):
        self.start(call_script("fake__big", n=3000), "</think>\n\nLong.")
        self.post({"strata_mcp": True})
        second = self.engine.prompt_text(1)
        self.assertIn("y" * 500 + "\n\n[... truncated: the tool returned 3,000 characters", second)
        self.assertNotIn("y" * 501, second)

    def test_max_rounds(self):
        self.start(call_script("fake__echo", text="again"))          # the model never stops calling
        code, text = self.post({"strata_mcp": True})
        mcp = [c["strata_mcp"] for c in self.chunks(text) if "strata_mcp" in c]
        self.assertEqual(len(self.engine.prompts), 3)                # 2 rounds of tools, then the limit
        self.assertEqual(sum(m["event"] == "call" for m in mcp), 2)
        self.assertIn({"event": "limit", "max_rounds": 2}, mcp)
        self.assertTrue(mcp[-1].get("skipped"))
        self.assertEqual(self.chunks(text)[-1]["choices"][0]["finish_reason"], "stop")

    def test_a_picture_a_tool_returned_reaches_the_encoder(self):
        """The get_image case: the picture comes back as an image part of the tool's message, so the vision encoder
        sees it (the note in the text tells the model a picture came with the result)."""
        tok = ByteTokenizer()
        pad = tok.encode("<|image_pad|>", parse_special=True)[0]
        start = tok.encode("<|vision_start|>", parse_special=True)[0]
        self.start(call_script("fake__image", n=2), "</think>\n\nI see two pictures.")
        with tempfile.TemporaryDirectory() as d:
            self.svc.vision = FakeVision(d)
            code, text = self.post({"strata_mcp": True})
            self.assertEqual(code, 200, text)
            mcp = [c["strata_mcp"] for c in self.chunks(text) if "strata_mcp" in c]
            self.assertEqual(mcp[2]["images"], 2)                              # the web app's block says so
            first, second = self.engine.prompts[0], self.engine.prompts[1]
            self.assertEqual((first.count(start), second.count(start)), (0, 2))    # the tool's turn has the pictures
            self.assertEqual(second.count(pad), 6)                          # two pictures, three rows each
            body = self.engine.prompt_text(1)                               # specials are dropped there
            self.assertIn(f"[image (image/png, {len(fake.PNG) * 3 // 4} bytes)]", body)

    def test_a_picture_without_an_encoder_is_a_note(self):
        """No vision encoder here: the call still works, the model reads the note, and the chat does not break."""
        tok = ByteTokenizer()
        start = tok.encode("<|vision_start|>", parse_special=True)[0]
        self.start(call_script("fake__image", n=1), "</think>\n\nI cannot see it.")
        code, text = self.post({"strata_mcp": True})
        self.assertEqual(code, 200, text)
        self.assertEqual(self.engine.prompts[1].count(start), 0)               # no image reached the prompt
        self.assertIn("[image omitted: this server has no image encoder]", self.engine.prompt_text(1))
        self.assertEqual("".join((c["choices"][0]["delta"].get("content") or "")
                                 for c in self.chunks(text)), "Let me check.I cannot see it.")

    def test_stop_during_a_tool(self):
        """Closing the connection while a slow tool runs stops the tool (notifications/cancelled) and the loop."""
        self.start(call_script("fake__sleep", seconds=8), "</think>\n\nnever")
        body = {"model": "m", "messages": [{"role": "user", "content": "x"}], "stream": True, "strata_mcp": True}
        req = urllib.request.Request(self.base + "/v1/chat/completions", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        r = urllib.request.urlopen(req, timeout=30)
        for raw in r:
            if b'"event": "call"' in raw:
                break
        r.close()                                                    # the web app's Stop aborts the fetch
        t0 = time.monotonic()
        while time.monotonic() - t0 < 6 and "cancelled" not in Path(self.log.name).read_text():
            time.sleep(0.1)
        self.assertIn("cancelled", Path(self.log.name).read_text())
        self.assertLess(time.monotonic() - t0, 6)
        time.sleep(0.5)
        self.assertEqual(len(self.engine.prompts), 1)                # no second round
        self.assertFalse(self.svc.status["busy"])

    def test_only_from_the_app_s_own_page(self):
        self.start("</think>\n\nhi")
        req = urllib.request.Request(self.base + "/v1/chat/completions", data=json.dumps(
            {"model": "m", "messages": [{"role": "user", "content": "x"}], "strata_mcp": True}).encode(),
            headers={"Content-Type": "text/plain"})                  # a cross-site "simple" request
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req, timeout=10)
        self.assertEqual(ctx.exception.code, 415)
        code, _ = self.post({"strata_mcp": True}, {"Origin": "http://evil.example"})
        self.assertEqual(code, 403)
        self.assertEqual(self.engine.prompts, [])
        host = self.base.split("://", 1)[1]
        code, _ = self.post({"strata_mcp": True}, {"Origin": "http://" + host})
        self.assertEqual(code, 200)

    def test_get_mcp(self):
        self.start("</think>\n\nhi")
        with urllib.request.urlopen(self.base + "/mcp", timeout=10) as r:
            st = json.loads(r.read())
        servers = {s["name"]: s for s in st["servers"]}
        self.assertEqual(servers["fake"]["status"], "ready")
        self.assertEqual(servers["fake"]["transport"], "stdio")
        self.assertIn("fake__echo", [t["name"] for t in servers["fake"]["tools"]])
        self.assertEqual(servers["broken"]["status"], "failed")
        self.assertIn("missing configuration", servers["broken"]["error"])
        self.assertEqual(st["tools"], len(fake.TOOLS))
        self.assertEqual(st["settings"]["max_rounds"], 2)
        self.svc.api_key = "k"
        with self.assertRaises(urllib.error.HTTPError):
            urllib.request.urlopen(self.base + "/mcp", timeout=10)
        self.svc.api_key = ""


    def test_a_request_can_carry_its_own_tool_list(self):
        # todo #mcp-live-toggles: the tools block is the FIRST system turn (serve/chat_template.jinja), and reuse
        # is exact token-prefix matching, so a conversation must keep seeing exactly the list it started with or
        # its next message re-reads its whole history.  "strata_mcp_tools" is how the client says which list that is.
        self.start("</think>\n\nhi")
        code, text = self.post({"strata_mcp": True, "strata_mcp_tools": ["fake__add"]})
        self.assertEqual(code, 200, text)
        p = self.engine.prompt_text(0)
        self.assertIn("fake__add", p)
        self.assertNotIn("fake__echo", p)                      # the server's other tools are not in this prompt
        self.assertNotIn("fake__sleep", p)
        self.assertIn("# Tools", p)                            # the block is there, just smaller

    def test_a_bad_tool_list_is_refused_before_anything_runs(self):
        self.start("</think>\n\nhi")
        for bad in ("x", [1], [""], {"a": 1}):
            code, text = self.post({"strata_mcp": True, "strata_mcp_tools": bad})
            self.assertEqual(code, 400, (bad, text))
            self.assertIn("strata_mcp_tools", text)

    def test_the_chip_switch_is_live_and_a_frozen_chat_keeps_its_tool(self):
        # the Monitor's chip changes what NEW conversations see, with no restart; a conversation that already
        # carries the tool in its prompt keeps rendering AND running it, because a tool the model can see but
        # cannot call is a broken turn and dropping it would cost that chat a re-read.
        offered = lambda: [t["name"] for t in self.hub.template_tools()]
        self.assertIn("fake__echo", offered())
        self.assertTrue(self.hub.set_tool_disabled("fake", "echo", True))     # the chip, live
        self.assertNotIn("fake__echo", offered())                             # new chats: gone, no restart
        self.assertIn("fake__echo", [t["name"] for t in
                                     self.hub.template_tools(only=["fake__echo"], include_disabled=True)])
        self.start(call_script("fake__echo", text="still here"), "</think>\n\nran.")
        code, text = self.post({"strata_mcp": True, "strata_mcp_tools": ["fake__echo"]})
        self.assertEqual(code, 200, text)
        mcp = [c["strata_mcp"] for c in self.chunks(text) if "strata_mcp" in c]
        self.assertEqual([m["event"] for m in mcp][-2:], ["call", "result"], "the frozen tool still runs")
        last = mcp[-1]
        self.assertTrue(last["ok"], last)                 # an error result has the same two events: check it ran
        self.assertIn("still here", last["text"], last)   # and the tool really produced its answer
        self.assertTrue(self.hub.set_tool_disabled("fake", "echo", False))    # and back on again
        self.assertIn("fake__echo", offered())

    def test_turning_a_whole_server_off_and_on_live(self):
        self.assertTrue(self.hub.set_server_disabled("fake", True))
        self.assertNotIn("fake", self.hub.servers)
        self.assertEqual(self.hub.template_tools(), [])              # nothing to offer: the chat runs without them
        self.assertTrue(self.hub.set_server_disabled("fake", False, stdio()))
        self.hub.wait(10)
        self.assertIn("fake__echo", [t["name"] for t in self.hub.template_tools()])
        self.assertFalse(self.hub.set_server_disabled("nope", True))  # a name that is not there changes nothing

class UnknownCall(LoopFixture):
    """A call naming a tool that neither the request declared nor the hub offers.  Reproduced from a live death
    on this box: the turn returned 200 with finish_reason tool_calls, no MCP activity at all and an empty answer,
    while every parser counter stayed at zero - because a call WAS delivered, so the turn is not "empty", and it
    is not abandoned, refused, unread or drift.  The loop will not run a name it does not offer, and the page has
    no handler for a tool_calls delta (it only ever writes them, when rebuilding history), so the chat stops with
    nothing on screen.  item unread-call-recovery."""

    def test_a_call_for_an_undeclared_name_is_counted_and_logged(self):
        self.start(call_script("fake__nothere", text="hi"), "</think>\n\nNothing to say.")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code, text = self.post({"strata_mcp": True})
        self.assertEqual(code, 200, text)
        said = out.getvalue()
        self.assertIn("neither the request declared nor this server offers", said, said[:400])
        self.assertIn("fake__nothere", said, "and it names what the model asked for")
        self.assertEqual(self.svc.totals.get("unknown_tool_calls"), 1)

    def test_the_model_is_told_the_tool_does_not_exist_and_gets_another_turn(self):
        # the fix: the hub has no server behind the name, so its own answer - "there is no tool named X" - goes
        # back as the tool result and the model gets a turn to pick the one it meant.  The page sees the usual
        # start/call/result, so it shows a block and replays the round: the two rebuilds stay identical and the
        # prompt prefix does not break (serve/web/app.js assistantMessages replays any tool with a result).
        self.hub.settings["max_rounds"] = 5
        self.start(call_script("fake__nothere", text="hi"),
                   call_script("fake__echo", text="now the right one"),
                   "</think>\n\nDone.")
        code, text = self.post({"strata_mcp": True})
        self.assertEqual(code, 200, text)
        mcp = [c["strata_mcp"] for c in self.chunks(text) if "strata_mcp" in c]
        kinds = [m["event"] for m in mcp]
        self.assertEqual(kinds[:3], ["start", "call", "result"], "the unknown call is a block, not a silence")
        bad = [m for m in mcp if m["event"] == "result"][0]
        self.assertFalse(bad["ok"])
        self.assertIn("there is no tool named", bad["text"], bad["text"][:120])
        self.assertEqual(len(self.engine.prompts), 3, "the model was given a turn after the error, and another")
        answer = "".join((c["choices"][0].get("delta") or {}).get("content") or "" for c in self.chunks(text))
        self.assertIn("Done.", answer, "and the chat ends with an answer instead of nothing")

    def test_the_answer_is_capped_so_a_model_inventing_names_cannot_burn_the_rounds(self):
        self.hub.settings["max_rounds"] = 8
        self.start(*([call_script("fake__nothere", text="hi")] * 4))
        code, text = self.post({"strata_mcp": True})
        self.assertEqual(code, 200, text)
        mcp = [c["strata_mcp"] for c in self.chunks(text) if "strata_mcp" in c]
        results = [m for m in mcp if m["event"] == "result"]
        answered = [m for m in results if not m.get("skipped")]
        self.assertEqual(len(answered), 2, "the error goes back twice, no more")
        self.assertEqual(len([m for m in results if m.get("skipped")]), 1,
                         "and the third is shown as not run, not swallowed on the way out")
        self.assertEqual(len(self.engine.prompts), 3, "then the turn ends rather than looping")
        self.assertEqual(self.svc.totals.get("unknown_tool_calls"), 3, "and every one is still counted")

    def test_a_tool_the_client_declared_is_not_unknown(self):
        # the other half of the rule: a tool the request brought itself is the client's to answer, and that is
        # normal - counting those would make the number meaningless
        self.start(call_script("mine", q="x"), "</think>\n\nDone.")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code, _ = self.post({"strata_mcp": True, "tools": [
                {"type": "function", "function": {"name": "mine", "parameters": {"properties": {}}}}]})
        self.assertEqual(code, 200)
        self.assertIsNone(self.svc.totals.get("unknown_tool_calls"), "absent means zero")
        self.assertNotIn("neither the request declared", out.getvalue())


class RuntimeChange(unittest.TestCase):
    """todo #mcp-server-add: a server can be added, changed or removed while Strata runs.  The hub has to
    construct and start an added entry, rebuild a changed one (a toggle would leave it answering with the tools
    the file no longer describes), and close a removed one."""

    def setUp(self):
        self.hub = McpHub({}, {"timeout_s": 10, "start_timeout_s": 30})
        self.assertEqual(self.hub.routes(), {}, "a hub with no servers routes nothing")

    def tearDown(self):
        self.hub.close()

    def test_a_server_added_at_runtime_starts_and_routes_its_tools(self):
        self.assertTrue(self.hub.replace_server("fake", stdio()))
        self.hub.wait(20)
        self.assertIn("fake__echo", self.hub.routes())
        self.assertEqual([s["name"] for s in self.hub.status()["servers"]], ["fake"])
        self.assertEqual(self.hub.status()["tools"], len(self.hub.routes()))

    def test_a_changed_entry_replaces_the_running_server(self):
        self.hub.replace_server("fake", stdio())
        self.hub.wait(20)
        old = self.hub.servers["fake"].transport
        self.assertIn("fake__echo", self.hub.routes())
        self.hub.replace_server("fake", stdio("--crash-at-start"))
        self.hub.wait(20)
        self.assertEqual([n for n in self.hub.routes() if n.startswith("fake__")], [],
                         "the old entry's tools are no longer offered")
        self.assertFalse(old.alive(), "and its process was ended, not left running next to the new one")
        self.assertEqual(self.hub.servers["fake"].status, "failed", "what the new entry actually does")

    def test_a_removed_server_stops_routing_and_its_process_ends(self):
        self.hub.replace_server("fake", stdio())
        self.hub.wait(20)
        proc = self.hub.servers["fake"].transport.proc
        self.assertIsNotNone(proc)
        self.assertTrue(self.hub.set_server_disabled("fake", True))
        self.assertEqual(self.hub.routes(), {})
        self.assertNotIn("fake", self.hub.servers)
        self.assertIsNotNone(proc.poll(), "the process closed with it (a stopped hub is not a stopped PC)")


class NoServers(unittest.TestCase):
    def test_opt_in_without_servers_is_a_plain_chat(self):
        tok = ByteTokenizer()
        svc = Service(ScriptedEngine(tok, ["</think>\n\nhi"]), tok, ChatTemplate(ROOT / "serve/chat_template.jinja"))
        httpd = serve(svc, port=0)
        try:
            base = f"http://127.0.0.1:{httpd.server_address[1]}"
            with urllib.request.urlopen(base + "/mcp", timeout=10) as r:
                self.assertEqual(json.loads(r.read()), {"servers": [], "tools": 0, "configured": {}, "entries": {}})
            req = urllib.request.Request(base + "/v1/chat/completions", data=json.dumps(
                {"model": "m", "messages": [{"role": "user", "content": "x"}], "strata_mcp": True}).encode(),
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=10) as r:
                self.assertEqual(json.loads(r.read())["choices"][0]["message"]["content"], "hi")
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()
