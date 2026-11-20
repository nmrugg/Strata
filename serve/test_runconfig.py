"""serve/test_runconfig.py - #564: the web page's Settings view of the run config (GET / POST /config), against the
mock engine: only the listed keys change, every other key of the file stays, a bad value changes nothing, and only
Strata's own page may write it (JSON, no foreign Origin, the API key when one is set).

    python -m unittest serve.test_runconfig
"""
from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from serve import runconfig
from serve.frontend import ChatTemplate
from serve.server import ByteTokenizer, MockEngine, Service, serve

ROOT = Path(__file__).resolve().parents[1]
FAKE = str(ROOT / "serve" / "mcp_fake_server.py")     # the fake MCP server serve/test_mcp.py uses
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

    def test_a_server_can_be_added(self):
        new, changed = runconfig.set_mcp(CFG, [{"server": "weather",
                                                "add": {"command": "node", "args": ["srv.js"], "env": {"KEY": "v"}}}])
        self.assertEqual(changed, ["weather (added)"])
        self.assertEqual(new["mcp_servers"]["weather"], {"command": "node", "args": ["srv.js"], "env": {"KEY": "v"}})
        self.assertEqual(new["mcp_servers"]["files"], CFG["mcp_servers"]["files"], "the other server, untouched")
        for k in ("exe", "args", "sampling", "cors_origins", "port", "host", "api_key", "model_name"):
            self.assertEqual(new[k], CFG[k], k)                       # everything else, exactly as it was
        self.assertNotIn("weather", CFG["mcp_servers"])               # the input dict is left alone

    def test_an_edit_keeps_the_switches_and_every_key_the_form_does_not_show(self):
        off, _ = runconfig.set_mcp(CFG, [{"server": "files", "disabled": True},
                                         {"server": "files", "tool": "read_file", "enabled": False}])
        off["mcp_servers"]["files"]["autoApprove"] = ["read_file"]   # a key from another tool's config file
        new, changed = runconfig.set_mcp(off, [{"server": "files",
                                                "edit": {"command": "node", "args": ["-y", "srv", "/data"],
                                                        "cwd": "/srv"}}])
        self.assertEqual(changed, ["files (edited)"])
        e = new["mcp_servers"]["files"]
        self.assertEqual((e["command"], e["args"], e["cwd"]), ("node", ["-y", "srv", "/data"], "/srv"))
        self.assertIs(e["disabled"], True, "switching a server off survives an edit of its command")
        self.assertEqual(e["disabled_tools"], ["read_file"], "and so does a tool switch")
        self.assertEqual(e["autoApprove"], ["read_file"], "a key the form does not show is left exactly as it was")

    def test_an_env_value_of_null_keeps_the_value_that_is_in_the_file(self):
        with_key, _ = runconfig.set_mcp(CFG, [{"server": "weather",
                                               "add": {"command": "node", "env": {"TOKEN": "s3cret"}}}])
        self.assertEqual(runconfig.mcp_entries(with_key)["weather"]["env"], ["TOKEN"],
                         "the page is shown the names, never the values")
        kept, changed = runconfig.set_mcp(with_key, [{"server": "weather",
                                                      "edit": {"command": "node", "env": {"TOKEN": None}}}])
        self.assertEqual(kept["mcp_servers"]["weather"]["env"], {"TOKEN": "s3cret"})
        self.assertEqual(changed, [], "nothing moved, so the file would not be rewritten")
        gone, _ = runconfig.set_mcp(with_key, [{"server": "weather", "edit": {"command": "node", "env": {}}}])
        self.assertNotIn("env", gone["mcp_servers"]["weather"], "leaving a name out is how it is removed")
        with self.assertRaises(ValueError):               # a name with nothing saved cannot be "kept"
            runconfig.set_mcp(CFG, [{"server": "files", "edit": {"command": "npx", "env": {"NEW": None}}}])

    def test_a_server_can_be_removed(self):
        new, changed = runconfig.set_mcp(CFG, [{"server": "files", "remove": True}])
        self.assertEqual(changed, ["files (removed)"])
        self.assertEqual(new["mcp_servers"], {})
        for k in ("exe", "args", "sampling", "cors_origins", "port"):
            self.assertEqual(new[k], CFG[k], k)

    def test_the_first_server_creates_the_block(self):
        new, changed = runconfig.set_mcp({"exe": "x"}, [{"server": "a", "add": {"command": "node"}}])
        self.assertEqual(changed, ["a (added)"])
        self.assertEqual(new["mcp_servers"], {"a": {"command": "node"}})
        with self.assertRaises(ValueError):        # a switch still refuses: there is nothing to switch
            runconfig.set_mcp({"exe": "x"}, [{"server": "a", "disabled": True}])

    def test_an_edit_that_changes_nothing_is_not_a_change(self):
        same = {"command": "npx", "args": ["-y", "server-filesystem", "."]}
        new, changed = runconfig.set_mcp(CFG, [{"server": "files", "edit": same}])
        self.assertEqual(changed, [])
        self.assertEqual(new, json.loads(json.dumps(CFG)))

    def test_a_bad_entry_is_refused_and_nothing_is_written(self):
        for entry in ({}, {"command": "  "}, {"command": "x", "args": "not a list"}, {"command": "x", "args": [7]},
                      {"command": "x", "url": "http://x"}, {"url": "http://x", "headers": "x"},
                      {"command": "x", "env": {"K": 7}}, {"command": "x", "env": "not an object"},
                      {"command": "x", "cwd": 5}):
            with self.subTest(entry=str(entry)), self.assertRaises(ValueError):
                runconfig.set_mcp(CFG, [{"server": "new-one", "add": entry}])
        with self.assertRaises(ValueError):                       # a name already taken
            runconfig.set_mcp(CFG, [{"server": "files", "add": {"command": "x"}}])
        with self.assertRaises(ValueError):                       # removing what is not there
            runconfig.set_mcp(CFG, [{"server": "nope", "remove": True}])
        for name in ("", "   ", "a\nb", "x" * 65):
            with self.subTest(name=name), self.assertRaises(ValueError):
                runconfig.set_mcp(CFG, [{"server": name, "add": {"command": "x"}}])
        with self.assertRaises(ValueError):                       # one bad change voids the whole request
            runconfig.set_mcp(CFG, [{"server": "ok", "add": {"command": "x"}},
                                    {"server": "nope", "remove": True}])
        self.assertNotIn("ok", runconfig.mcp_block(CFG)[0])

    def test_the_form_cannot_write_a_key_it_does_not_own(self):
        # the form owns command / args / env / cwd / url / headers and nothing else, so a paste of Claude
        # Desktop's block cannot smuggle the retired SSE transport in as a new entry...
        new, _ = runconfig.set_mcp(CFG, [{"server": "old", "add": {"url": "http://x", "type": "sse"}}])
        self.assertEqual(new["mcp_servers"]["old"], {"url": "http://x"})
        # ...while an entry that already carries it - a file the user wrote by hand - is refused on edit, the
        # same answer serve/mcp.py gives at start-up, because unowned keys are preserved rather than dropped
        with self.assertRaises(ValueError):
            runconfig.set_mcp({"mcp_servers": {"old": {"url": "http://x", "type": "sse"}}},
                              [{"server": "old", "edit": {"url": "http://y"}}])

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
        self.assertIn('"disabled", "tool", "tools", "add", "edit" or "remove"', v["error"]["message"])

    def test_adding_a_server_writes_the_file_and_starts_it(self):
        # this fixture has no hub at all: adding the first server has to start one, or the change would sit in
        # the file until a restart, which is exactly what the live switches made unnecessary
        status, v = self.post({"mcp": [{"server": "fake", "add": {"command": sys.executable, "args": [FAKE]}}]})
        self.assertEqual(status, 200, v)
        self.assertEqual(v["changed"], ["fake (added)"])
        cfg = self.saved()
        self.assertEqual(cfg["mcp_servers"]["fake"], {"command": sys.executable, "args": [FAKE]})
        for k in ("exe", "args", "sampling", "cors_origins", "port", "host", "api_key"):
            self.assertEqual(cfg[k], CFG[k], k)                       # every other key, exactly as it was
        self.assertEqual(json.loads((self.path.parent / "strata-q2_0.json.bak").read_text(encoding="utf-8")), CFG,
                         "the earlier file is kept, as every other write keeps it")
        self.assertIs(v["configured"]["fake"]["disabled"], False, "the answer already lists the new server")
        status, got = self.call("GET")
        self.assertEqual(status, 200, got)
        self.assertEqual(got["entries"]["fake"]["args"], [FAKE], "and GET shows the form what would run")
        self.assertIsNotNone(self.svc.mcp, "a hub was started for it")
        self.svc.mcp.wait(10)
        self.assertIn("fake__echo", self.svc.mcp.routes(), "and the added server really started and listed tools")
        self.svc.mcp.close()

    def test_an_edit_rebuilds_the_running_server_instead_of_toggling_it(self):
        self.post({"mcp": [{"server": "fake", "add": {"command": sys.executable, "args": [FAKE]}}]})
        self.svc.mcp.wait(10)
        self.assertIn("fake__echo", self.svc.mcp.routes())
        status, v = self.post({"mcp": [{"server": "fake",
                                        "edit": {"command": sys.executable, "args": [FAKE, "--crash-at-start"]}}]})
        self.assertEqual(status, 200, v)
        self.assertIn("fake (edited)", v["changed"])
        self.svc.mcp.wait(10)
        self.assertEqual([n for n in self.svc.mcp.routes() if n.startswith("fake__")], [],
                         "the OLD entry's tools are gone: the hub rebuilt the server, it did not keep the process")
        self.assertEqual(self.svc.mcp.servers["fake"].cfg["args"][-1], "--crash-at-start",
                         "and the hub now holds what the file says - the drift that made a click a no-op once")
        self.svc.mcp.close()

    def test_removing_a_server_closes_it_and_asks_the_chats_to_read_again(self):
        self.post({"mcp": [{"server": "fake", "add": {"command": sys.executable, "args": [FAKE]}}]})
        self.svc.mcp.wait(10)
        status, v = self.post({"mcp": [{"server": "fake", "remove": True}]})
        self.assertEqual(status, 200, v)
        self.assertEqual(v["changed"], ["fake (removed)"])
        self.assertNotIn("fake", self.saved()["mcp_servers"], "out of the file")
        self.assertNotIn("fake", self.svc.mcp.servers, "and out of the running hub")
        self.assertEqual(v["reloads"], ["fake"], "a chat holding its tools reads its history again (todo #mcp-live-toggles)")
        self.svc.mcp.close()

    def test_an_edit_that_changes_nothing_is_a_200_with_nothing_changed(self):
        status, v = self.post({"mcp": [{"server": "files",
                                        "edit": {"command": "npx", "args": ["-y", "server-filesystem", "."]}}]})
        self.assertEqual(status, 200, v)
        self.assertEqual(v["changed"], [])
        self.assertEqual(self.saved(), CFG, "the file was not rewritten, so no new .bak either")

    def test_a_malformed_entry_is_a_400_and_the_server_survives_it(self):
        before = self.path.read_bytes()
        for change in ({"server": "bad", "add": {"args": "not a list"}},
                       {"server": "bad", "add": {}},                                  # no command, no url
                       {"server": "files", "add": {"command": "x"}},                  # the name is taken
                       {"server": "nope", "remove": True},                            # nothing to remove
                       {"server": "bad", "add": {"command": "x", "url": "http://x"}}):  # both at once
            status, b = self.post({"mcp": [change]})
            with self.subTest(change=str(change)):
                self.assertEqual(status, 400, b)
        self.assertEqual(self.path.read_bytes(), before, "nothing written")
        # the point of the non-fatal validator: _check_server raises SystemExit, which on a request thread would
        # have taken the whole server down.  The page must still answer afterwards.
        self.assertEqual(self.call("GET")[0], 200)

    def test_get_shows_the_command_line_but_never_an_env_value(self):
        self.post({"mcp": [{"server": "secret", "add": {"command": sys.executable, "args": ["-c", "pass"],
                                                        "env": {"TOKEN": "s3cret"}}}]})
        status, v = self.call("GET")
        self.assertEqual(status, 200, v)
        self.assertEqual(v["entries"]["secret"]["command"], sys.executable)
        self.assertEqual(v["entries"]["secret"]["env"], ["TOKEN"], "names only, so the form can show what runs")
        self.assertNotIn("s3cret", json.dumps(v), "the value never reaches the page")
        if self.svc.mcp:
            self.svc.mcp.close()

    def test_adding_is_refused_from_another_page(self):
        before = self.path.read_bytes()
        status, _ = self.call("POST", {"mcp": [{"server": "x", "add": {"command": "y"}}]},
                              {"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        self.assertEqual(self.path.read_bytes(), before)

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
