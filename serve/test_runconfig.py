"""serve/test_runconfig.py - #564: the web page's Settings view of the run config (GET / POST /config), against the
mock engine: only the listed keys change, every other key of the file stays, a bad value changes nothing, and only
Strata's own page may write it (JSON, no foreign Origin, the API key when one is set).

    python -m unittest serve.test_runconfig
"""
from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from serve import runconfig
from serve.frontend import ChatTemplate
from serve.server import ByteTokenizer, MockEngine, Service, serve

ROOT = Path(__file__).resolve().parents[1]
CFG = {"exe": "engine/strata.exe", "args": ["--pack", "data/packs/q2_0", "--kv", "int8", "--spec-min-p", "0.5"],
       "model_name": "qwen3.8-flash-next-q2_0", "port": 8080, "host": "0.0.0.0", "api_key": "",
       "sampling": {"temperature": 0.7, "presence_penalty": 1.5},
       "mcp_servers": {"files": {"command": "npx", "args": ["-y", "server-filesystem", "."]}},
       "cors_origins": ["http://localhost:3000"]}


class Apply(unittest.TestCase):
    def test_only_the_named_keys_change(self):
        new, changed = runconfig.apply(CFG, {"sampling.top_p": 0.95, "reasoning_budget_tokens": 4096,
                                             "vram_reserve_mib": 2048, "aliases": "qwen, local", "lazy_load": True})
        self.assertEqual(changed, ["sampling.top_p", "reasoning_budget_tokens", "vram_reserve_mib", "aliases",
                                   "lazy_load"])
        self.assertEqual(new["sampling"], {"temperature": 0.7, "presence_penalty": 1.5, "top_p": 0.95})
        self.assertEqual(new["args"][-2:], ["--vram-reserve-mib", "2048"])
        self.assertEqual(new["aliases"], ["qwen", "local"])
        for k in ("exe", "model_name", "port", "host", "api_key", "mcp_servers", "cors_origins"):
            self.assertEqual(new[k], CFG[k], k)
        self.assertEqual(CFG["sampling"], {"temperature": 0.7, "presence_penalty": 1.5})   # the input is left alone

    def test_null_is_the_default_again(self):
        cfg, _ = runconfig.apply(CFG, {"vram_reserve_mib": 2048, "fit_max_tokens": True})
        new, changed = runconfig.apply(cfg, {"vram_reserve_mib": None, "fit_max_tokens": None,
                                             "sampling.temperature": None, "idle_unload_s": None})
        self.assertEqual(changed, ["vram_reserve_mib", "fit_max_tokens", "sampling.temperature"])
        self.assertEqual(new["args"], CFG["args"])
        self.assertNotIn("fit_max_tokens", new)
        self.assertEqual(new["sampling"], {"presence_penalty": 1.5})
        new, _ = runconfig.apply({"sampling": {"top_k": 20}}, {"sampling.top_k": None})
        self.assertNotIn("sampling", new)                                 # an empty block goes

    def test_refused(self):
        for changes in ({"api_key": "x"}, {"host": "0.0.0.0"}, {"mcp_servers": {}}, {"before_load": "calc.exe"},
                        {"args": []}, {"exe": "evil.exe"}, {"trusted_origins": ["*"]}, {"allowed_hosts": ["*"]},
                        {"sampling.temperature": -1}, {"sampling.top_p": 0}, {"sampling.top_k": 65},
                        {"sampling.min_p": 2}, {"reasoning_budget_tokens": 1.5}, {"fit_max_tokens": "yes"},
                        {"effort_position": "middle"}, {"vram_reserve_mib": -5}, {"idle_unload_s": True},
                        {"start_beep": "yes"}, {"start_beep": 1},
                        {"aliases": [1]}, {}, None, ["x"]):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                runconfig.apply(CFG, changes)
        with self.assertRaises(ValueError):                              # one bad value: nothing is applied
            runconfig.apply(CFG, {"fit_max_tokens": True, "sampling.top_k": 0})
        with self.assertRaises(ValueError):
            runconfig.apply({**CFG, "vision": {"gpu": True}}, {"lazy_load": True})

    def test_view(self):
        v = runconfig.view({**CFG, "args": CFG["args"] + ["--vram-reserve-mib", "1500"]}, "x/strata-q2_0.json")
        self.assertEqual(v["file"], "strata-q2_0.json")
        got = {k["key"]: k for k in v["keys"]}
        self.assertEqual(got["sampling.temperature"]["value"], 0.7)
        self.assertEqual(got["vram_reserve_mib"]["value"], 1500)
        self.assertIsNone(got["fit_max_tokens"]["value"])
        self.assertEqual(got["start_beep"]["kind"], "bool")
        self.assertIsNone(got["start_beep"]["value"])               # not in the file: off
        self.assertEqual(got["anthropic_thinking"]["choices"], ["model", "on_request"])
        self.assertNotIn("api_key", got)
        self.assertNotIn("mcp_servers", got)


class Fixture(unittest.TestCase):
    """One run config file on disk, one server reading it, and the HTTP call the page makes."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "strata-q2_0.json"
        self.path.write_text(json.dumps(CFG, indent=1), encoding="utf-8")
        tok = ByteTokenizer()
        self.svc = Service(MockEngine(tok, "ok", max_context=4096), tok, ChatTemplate(ROOT / "serve/chat_template.jinja"))
        self.svc.config_path = str(self.path)
        self.httpd = serve(self.svc, port=0)
        self.host = f"127.0.0.1:{self.httpd.server_address[1]}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.dir.cleanup()

    def call(self, method, body=None, headers=None, path="/config"):
        h = {"Content-Type": "application/json", **(headers or {})}
        req = urllib.request.Request(f"http://{self.host}{path}", method=method, headers=h,
                                     data=None if body is None else (body if isinstance(body, bytes)
                                                                     else json.dumps(body).encode()))
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            with e:
                return e.code, json.loads(e.read())

    def saved(self):
        return json.loads(self.path.read_text(encoding="utf-8"))

    def post(self, payload, origin=True):
        """A POST from Strata's own page, with the start-up print swallowed."""
        h = {"Origin": f"http://{self.host}"} if origin else {}
        with contextlib.redirect_stdout(io.StringIO()):
            return self.call("POST", payload, h)


class Http(Fixture):
    def test_read_and_write_from_the_page(self):
        status, v = self.call("GET")
        self.assertEqual(status, 200, v)
        self.assertEqual({k["key"]: k["value"] for k in v["keys"]}["sampling.temperature"], 0.7)
        with contextlib.redirect_stdout(io.StringIO()):
            status, v = self.call("POST", {"set": {"sampling.temperature": 1.0, "open_browser": False,
                                                   "start_beep": True}},
                                  {"Origin": f"http://{self.host}"})
        self.assertEqual(status, 200, v)
        self.assertEqual(v["changed"], ["sampling.temperature", "open_browser", "start_beep"])
        cfg = self.saved()
        self.assertEqual(cfg["sampling"]["temperature"], 1.0)
        self.assertIs(cfg["open_browser"], False)
        self.assertIs(cfg["start_beep"], True)                    # the bell: a key of the file like any other
        for k in ("mcp_servers", "cors_origins", "host", "args", "exe"):
            self.assertEqual(cfg[k], CFG[k], k)
        self.assertEqual(json.loads((self.path.parent / "strata-q2_0.json.bak").read_text(encoding="utf-8")), CFG)
        status, v = self.call("POST", {"set": {"open_browser": False}})   # no Origin (a script on this PC): allowed
        self.assertEqual((status, v["changed"]), (200, []))

    def test_only_from_strata_s_own_page(self):
        before = self.path.read_bytes()
        status, _ = self.call("POST", {"set": {"fit_max_tokens": True}}, {"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        status, _ = self.call("POST", b'{"set": {"fit_max_tokens": true}}', {"Content-Type": "text/plain"})
        self.assertEqual(status, 415)
        for body in ({"set": {"api_key": ""}}, {"set": {"mcp_servers": {"x": {"command": "calc"}}}},
                     {"set": {"sampling.top_k": 0}}, {"nothing": 1}, b"not json"):
            status, b = self.call("POST", body, {"Origin": f"http://{self.host}"})
            self.assertEqual(status, 400, (body, b))
        self.assertEqual(self.path.read_bytes(), before)                 # nothing was written
        self.assertFalse((self.path.parent / "strata-q2_0.json.bak").exists())

    def test_the_api_key(self):
        self.svc.api_key = "secret"
        self.assertEqual(self.call("GET")[0], 401)
        self.assertEqual(self.call("POST", {"set": {"fit_max_tokens": True}})[0], 401)
        with contextlib.redirect_stdout(io.StringIO()):
            status, _ = self.call("POST", {"set": {"fit_max_tokens": True}}, {"Authorization": "Bearer secret"})
        self.assertEqual(status, 200)
        self.assertIs(self.saved()["fit_max_tokens"], True)

    def test_without_a_run_config(self):
        self.svc.config_path = None
        self.assertEqual(self.call("GET")[0], 404)
        self.assertEqual(self.call("POST", {"set": {"fit_max_tokens": True}})[0], 404)

    def test_the_page_has_the_view(self):
        web = ROOT / "serve" / "web"
        html, js = (web / "index.html").read_text(encoding="utf-8"), (web / "app.js").read_text(encoding="utf-8")
        for el in ("cfg-card", "cfg-form", "cfg-save", "cfg-msg"):
            self.assertIn(f'id="{el}"', html)
        self.assertIn('fetch("config", {method: "POST", headers: headers(true)', js)


class McpApply(unittest.TestCase):
    """runconfig.set_mcp / mcp_state: one flag of one server, every other key of the file left alone
    (todo #mcp-server-toggle, #tool-exclude)."""

    def test_a_server_off_and_back_on(self):
        new, changed = runconfig.set_mcp(CFG, [{"server": "files", "disabled": True}])
        self.assertEqual(changed, ["files (off)"])
        self.assertIs(new["mcp_servers"]["files"]["disabled"], True)
        for k in ("exe", "args", "sampling", "cors_origins", "port", "host", "api_key", "model_name"):
            self.assertEqual(new[k], CFG[k], k)                       # everything else, exactly as it was
        self.assertIsNone(CFG["mcp_servers"]["files"].get("disabled"))  # the input dict is left alone
        back, changed = runconfig.set_mcp(new, [{"server": "files", "disabled": False}])
        self.assertEqual(changed, ["files (on)"])
        self.assertIs(back["mcp_servers"]["files"]["disabled"], False)

    def test_one_tool_off_and_back_on(self):
        one, changed = runconfig.set_mcp(CFG, [{"server": "files", "tool": "read_file", "enabled": False}])
        self.assertEqual(changed, ["files__read_file (off)"])
        self.assertEqual(one["mcp_servers"]["files"]["disabled_tools"], ["read_file"])
        two, _ = runconfig.set_mcp(one, [{"server": "files", "tool": "write_file", "enabled": False}])
        self.assertEqual(two["mcp_servers"]["files"]["disabled_tools"], ["read_file", "write_file"])   # sorted
        back, _ = runconfig.set_mcp(two, [{"server": "files", "tool": "read_file", "enabled": True}])
        self.assertEqual(back["mcp_servers"]["files"]["disabled_tools"], ["write_file"])
        clean, _ = runconfig.set_mcp(back, [{"server": "files", "tool": "write_file", "enabled": True}])
        self.assertNotIn("disabled_tools", clean["mcp_servers"]["files"])   # the last one back: the key goes

    def test_state_lists_every_configured_server(self):
        off, _ = runconfig.set_mcp(CFG, [{"server": "files", "disabled": True},
                                         {"server": "files", "tool": "x", "enabled": False}])
        self.assertEqual(runconfig.mcp_state(off), {"files": {"disabled": True, "disabled_tools": ["x"]}})
        self.assertEqual(runconfig.mcp_state(CFG), {"files": {"disabled": False, "disabled_tools": []}})
        # the other spelling, read the way serve/mcp.py reads it
        self.assertEqual(runconfig.mcp_state({"mcpServers": {"a": {"url": "http://x"}}}),
                         {"a": {"disabled": False, "disabled_tools": []}})

    def test_a_whole_server_at_once(self):
        # the wrench menu sets one chat's list; the Monitor's Apply turns THAT into the defaults, in one change
        # per server - and only the running hub knows a server's tool names, so it has to be told (known=).
        known = {"files": ["read_file", "write_file", "list"]}
        new, changed = runconfig.set_mcp(CFG, [{"server": "files", "tools": ["read_file", "list"]}], known)
        self.assertEqual(new["mcp_servers"]["files"]["disabled_tools"], ["write_file"])
        self.assertEqual(changed, ["files (2 of 3 tools on)"])
        back, _ = runconfig.set_mcp(new, [{"server": "files", "tools": ["read_file", "write_file", "list"]}], known)
        self.assertNotIn("disabled_tools", back["mcp_servers"]["files"])   # everything on: the key goes
        with self.assertRaises(ValueError):        # a server the hub has not listed: nothing to compute from
            runconfig.set_mcp(CFG, [{"server": "files", "tools": ["read_file"]}], {})
        with self.assertRaises(ValueError):
            runconfig.set_mcp(CFG, [{"server": "files", "tools": "read_file"}], known)
        with self.assertRaises(ValueError):
            runconfig.set_mcp(CFG, [{"server": "files", "tools": ["read_file", 7]}], known)

    def test_refused(self):
        for changes in ([], None, "x", [{"server": "nope", "disabled": True}], [{"server": "files"}],
                        [{"server": "files", "disabled": "yes"}],
                        [{"server": "files", "tool": "x", "enabled": "no"}], [{"tool": "x"}]):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                runconfig.set_mcp(CFG, changes)
        with self.assertRaises(ValueError):        # a server that came from --mcp-config, not this file
            runconfig.set_mcp({"mcp_servers": "not an object"}, [{"server": "files", "disabled": True}])
        with self.assertRaises(ValueError):
            runconfig.set_mcp({"exe": "x"}, [{"server": "files", "disabled": True}])


class McpHttp(Fixture):
    """POST /mcp - the Monitor's chips and the wrench menu's Apply.  The same guard as /config.  It writes the
    run config AND updates the running hub, so a change is live for conversations that have not chosen their own
    tool list; a conversation that has one keeps it (serve/server.py, _mcp_post and mcp_only)."""

    def call(self, method, body=None, headers=None):
        return super().call(method, body, headers, path="/mcp")

    def test_a_server_off_writes_the_file_and_nothing_else(self):
        status, v = self.post({"mcp": [{"server": "files", "disabled": True}]})
        self.assertEqual(status, 200, v)
        self.assertEqual(v["changed"], ["files (off)"])
        self.assertEqual(v["live"], [], "this fixture has no hub, so there is nothing to apply live")
        self.assertEqual(v["reloads"], [])
        self.assertEqual(v["configured"], {"files": {"disabled": True, "disabled_tools": []}})
        cfg = self.saved()
        self.assertIs(cfg["mcp_servers"]["files"]["disabled"], True)
        for k in ("exe", "args", "sampling", "cors_origins", "port", "host", "api_key"):
            self.assertEqual(cfg[k], CFG[k], k)
        self.assertEqual(json.loads((self.path.parent / "strata-q2_0.json.bak").read_text(encoding="utf-8")), CFG)

    def test_a_tool_chip(self):
        status, v = self.post({"mcp": [{"server": "files", "tool": "read_file", "enabled": False}]})
        self.assertEqual(status, 200, v)
        self.assertEqual(self.saved()["mcp_servers"]["files"]["disabled_tools"], ["read_file"])

    def test_get_lists_what_the_config_says_even_with_no_hub(self):
        self.post({"mcp": [{"server": "files", "disabled": True}]})
        status, v = self.call("GET")
        self.assertEqual(status, 200, v)
        self.assertEqual(v["servers"], [])                             # this fixture has no hub at all
        self.assertEqual(v["configured"], {"files": {"disabled": True, "disabled_tools": []}})

    def test_the_same_guard_as_the_config_view(self):
        before = self.path.read_bytes()
        self.assertEqual(self.call("POST", {"mcp": [{"server": "files", "disabled": True}]},
                                   {"Origin": "https://evil.example"})[0], 403)
        for body in ({}, {"mcp": []}, {"mcp": [{"server": "nope", "disabled": True}]}, b"not json"):
            status, b = self.call("POST", body, {"Origin": f"http://{self.host}"})
            self.assertEqual(status, 400, (body, b))
        self.assertEqual(self.path.read_bytes(), before)               # nothing written

    def test_a_whole_server_change_needs_the_hub(self):
        # the Apply button sends {"server": ..., "tools": [...]}.  The tool names come from the running hub, and
        # this fixture has none - so the change is refused rather than guessing at an empty list, which would
        # have switched every tool of that server off.
        before = self.path.read_bytes()
        status, b = self.post({"mcp": [{"server": "files", "tools": ["read_file"]}]})
        self.assertEqual(status, 400, b)
        self.assertIn("not known until it has started", b["error"]["message"])
        self.assertEqual(self.path.read_bytes(), before)

    def test_the_api_key(self):
        self.svc.api_key = "secret"
        self.assertEqual(self.call("GET")[0], 401)
        self.assertEqual(self.call("POST", {"mcp": [{"server": "files", "disabled": True}]})[0], 401)

    def test_a_click_that_changes_nothing_is_not_an_error(self):
        # the two views of these switches redraw from the answer, so the same click can arrive twice.  It used to
        # come back 400 "nothing to change", which is what broke the Monitor's chips once the card and the config
        # were showing different things.
        status, v = self.post({"mcp": [{"server": "files", "disabled": False}]})     # already not disabled
        self.assertEqual(status, 200, v)
        self.assertEqual(v["changed"], [])
        self.assertEqual(self.saved(), CFG)                                          # the file was not rewritten
        # but a change that names nothing to change is still a caller bug, and it is refused before any write
        status, v = self.post({"mcp": [{"server": "files"}]})
        self.assertEqual(status, 400, v)
        self.assertIn('"disabled", "tool" or "tools"', v["error"]["message"])

    def test_the_page_has_the_chips(self):
        js = (ROOT / "serve" / "web" / "app.js").read_text(encoding="utf-8")
        self.assertIn('fetch("mcp", {method: "POST", headers: headers(true), body: JSON.stringify({mcp: changes})})', js)
        self.assertIn('data-mcp-server', js)
        self.assertIn('data-mcp-tool', js)
        self.assertIn('data-mcp-toggle', js)
        # one state, two views (todo #mcp-chat-picker): the wrench panel and the Monitor card post the SAME
        # change through the SAME function, and there is no per-conversation tool list anywhere
        # one write path for both views, and an Undo that sends the whole baseline back at once
        self.assertIn("async function mcpPostAll(changes, label)", js)
        self.assertIn("async function mcpUndo()", js)
        self.assertIn("function mcpSnapshot()", js)
        self.assertEqual(js.count("mcpPost("), 2)                 # one call in each view
        self.assertEqual(js.count('fetch("mcp", {method: "POST"'), 1)   # one fetch for every write
        self.assertIn('body: JSON.stringify({mcp: changes})', js)  # and it can carry many changes at once
        for gone in ("mcpFrozen", "chatToolsFor", "mcpDefault", "mcpSent", "updateMcpDot", "mcp-dot",
                     "data-mcp-unfreeze", "strata_mcp_tools = "):
            self.assertNotIn(gone, js)
        self.assertIn("reads its history again on its next message", js)   # the cost, said where the switches are
        self.assertNotIn("Saved for the next start", js)         # no longer true: the hub is updated live
        self.assertIn(".mcp-tool.off { opacity: .55; text-decoration: line-through; }",
                      (ROOT / "serve" / "web" / "app.css").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
