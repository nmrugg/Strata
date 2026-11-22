"""serve/test_web_first_start.py - item server-before-model: the port listens before the model is up.

It used to be the other way round: `httpd = serve(svc, ...)` ran after the engine constructor, which blocks for
a minute or two, so a page had exactly one signal - "my fetch of /health stopped failing" - and could not tell
"still loading" from "never started".  Now both engines are built lazy and `start_model_load()` brings the model
up on a thread once the port is answering.  What that has to keep working is what this checks: a request that
arrives mid-load WAITS (the loader holds the same FIFO a request does, and prepare() only refuses when the
context is unknown), /health says which of its three states the server is in, and a model that will not start
leaves the server up with the reason in it instead of taking the process down with the answer.

    python -m unittest serve.test_web_first_start -v
"""
from __future__ import annotations

import http.client
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path

from serve.frontend import (CALL_END, CALL_START, FUNC_END, FUNC_START, PARAM_END, PARAM_START, THINK_END,
                            ChatTemplate)
from serve.server import (ByteTokenizer, EngineDied, IM_END, MockEngine, Service, serve, start_model_load)

ROOT = Path(__file__).resolve().parents[1]
TPL = ROOT / "serve" / "chat_template.jinja"
# a mock script that reaches content has to close its thinking block first; the parser's own constant, because
# the tags themselves are never written out (LESSONS.md, Existential)
ANSWER = THINK_END + "\n\nanswered after the load"


class LoadingEngine(MockEngine):
    """MockEngine with the lifecycle a real engine has and the mock one does not: not alive until restart()
    has finished, restart() can fail the way a start that never reaches READY fails, and it can be slow."""

    def __init__(self, tokenizer, script="ok", load_s=1.5, fail_times=0):
        super().__init__(tokenizer, script)
        self.known_ctx = self.max_context
        self.unloaded, self.started_once, self.restarts = True, False, 0
        self._up, self.load_s, self.fail_times = False, load_s, fail_times

    def alive(self):                                   # StrataEngine's: the process is up and said READY
        return self._up

    def exit_code(self):
        return None

    def restart(self, tries: int = 3):
        self.restarts += 1
        time.sleep(self.load_s)
        if self.fail_times:
            self.fail_times -= 1
            raise EngineDied("the engine exited before it was ready")
        self._up, self.unloaded, self.started_once = True, False, True


class WebFirst(unittest.TestCase):
    def service(self, engine) -> Service:
        return Service(engine, ByteTokenizer(), ChatTemplate(TPL))

    def open(self, httpd) -> http.client.HTTPConnection:
        conn = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=30)
        self.addCleanup(conn.close)
        return conn

    def get(self, conn, path):
        conn.request("GET", path)
        r = conn.getresponse()
        return r.status, json.loads(r.read().decode())

    def health(self, conn):
        code, body = self.get(conn, "/health")
        self.assertEqual(code, 200, body)
        return body

    def chat(self, conn, text):
        conn.request("POST", "/v1/chat/completions", json.dumps(
            {"model": "m", "messages": [{"role": "user", "content": text}]}),
            {"Content-Type": "application/json"})
        r = conn.getresponse()
        return r.status, json.loads(r.read().decode())

    def down(self, httpd):
        httpd.shutdown()
        httpd.server_close()

    # ---------------------------------------------------------------- the three states
    def test_the_port_answers_before_the_model_and_health_says_which_state_it_is_in(self):
        svc = self.service(LoadingEngine(ByteTokenizer(), "hello", load_s=1.2))
        httpd = serve(svc, port=0)                     # the port first, exactly as main() does now
        self.addCleanup(self.down, httpd)
        conn = self.open(httpd)
        self.assertFalse(self.health(conn)["loaded"], "the model is not up; the page is")
        self.assertFalse(self.health(conn)["loading"], "and nobody has started loading it yet (--lazy reads this)")
        thread = start_model_load(svc)
        mid = self.health(conn)
        self.assertTrue(mid["loading"], "the page can be told the model is on its way")
        self.assertFalse(mid["loaded"])
        self.assertNotIn("load_error", mid)
        thread.join(30)
        up = self.health(conn)
        self.assertTrue(up["loaded"], "the same server, once the model is up")
        self.assertFalse(up["loading"])
        self.assertGreater(up["load_seconds"], 0, "how long it took is worth saying")

    def test_a_request_that_arrives_mid_load_waits_and_is_served(self):
        """The behaviour the owner asked for: the request is treated exactly as it would be if the model were
        up - it waits its turn.  It is not refused: prepare() answers 503 "the engine is starting" only when the
        context is unknown (#344), and a lazy engine already knows its context from --max-context."""
        eng = LoadingEngine(ByteTokenizer(), ANSWER, load_s=1.5)
        svc = self.service(eng)
        httpd = serve(svc, port=0)
        self.addCleanup(self.down, httpd)
        conn = self.open(httpd)
        thread = start_model_load(svc)
        time.sleep(0.3)                                # the load is underway
        code, body = self.chat(conn, "does it wait?")
        self.assertEqual(code, 200, body)
        self.assertEqual(body["choices"][0]["message"]["content"], "answered after the load")
        self.assertEqual(eng.restarts, 1, "it waited for the load the server had already started; it did not start one")
        thread.join(30)

    def test_a_model_that_will_not_start_leaves_the_server_up_and_says_why(self):
        """Killing the process at that point would take the only place to read the reason with it.  The next
        request tries again through the machinery an engine that died already uses (issue #27)."""
        eng = LoadingEngine(ByteTokenizer(), ANSWER, load_s=0.2, fail_times=1)
        svc = self.service(eng)
        httpd = serve(svc, port=0)
        self.addCleanup(self.down, httpd)
        conn = self.open(httpd)
        start_model_load(svc).join(30)
        failed = self.health(conn)
        self.assertFalse(failed["loaded"])
        self.assertFalse(failed["loading"], "the load is over, one way or the other")
        self.assertIn("exited before it was ready", failed.get("load_error", ""), failed)
        self.assertEqual(self.chat(conn, "try again")[0], 200)
        self.assertEqual(eng.restarts, 2, "the request found it down and started it again")
        self.assertNotIn("load_error", self.health(conn), "a server that got there in the end stops reporting it")

    def test_the_load_holds_the_fifo_so_a_request_waits_behind_it_not_alongside_it(self):
        """The loader takes the same lock Service.run takes before ensure_loaded(); without it a request would
        race a second start of the same engine.  Measured on the lock itself: a non-blocking acquire during the
        load has to fail."""
        eng = LoadingEngine(ByteTokenizer(), ANSWER, load_s=0.8)
        svc = self.service(eng)
        httpd = serve(svc, port=0)
        self.addCleanup(self.down, httpd)
        thread = start_model_load(svc)
        time.sleep(0.2)                                # the loader is inside the load by now
        self.assertFalse(eng.alive(), "still loading when the lock is probed")
        held = not svc.fifo.acquire(blocking=False)
        if not held:
            svc.fifo.release()
        self.assertTrue(held, "the load holds the FIFO a request would wait behind")
        thread.join(30)
        self.assertTrue(eng.alive())
        self.assertTrue(svc.fifo.acquire(timeout=5), "and gives it back")
        svc.fifo.release()


# ------------------------------------------------------------------ the wiring, not only the function
# A test that calls start_model_load() proves nothing about main() calling it after serve() - the trap
# LESSONS.md records ("a test that calls the function instead of driving the wired control passes on code that
# is not wired at all").  So this runs the real start-up: serve/server.py as its own process, with a fake
# engine that says READY only READY_S seconds after it is started.  The port has to answer long before that,
# and the model still has to come up on its own afterwards.
READY_S = 6
FAKE_ENGINE = '''import sys, time
args = sys.argv[2:]                       # past the "--serve" the server inserts
delay = float(args[args.index("--ready-delay") + 1]) if "--ready-delay" in args else 0.0
time.sleep(delay)
print("INFO engine=0.1.39", flush=True)
print("READY 4096 stop", flush=True)
for line in sys.stdin:
    if line.startswith("GEN "):
        print("DONE 1 %d 1 1 stop" % (len(line.split()) - 1), flush=True)
'''


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(os.name == "nt", "the stand-in engine is a script with a shebang")
class StartupOrder(unittest.TestCase):
    def health(self, port):
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
            return json.loads(r.read().decode())

    def end(self, proc):
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(15)
            except subprocess.TimeoutExpired:
                proc.kill()

    def test_the_real_start_up_answers_the_port_before_the_engine_is_ready(self):
        with tempfile.TemporaryDirectory() as tmp:
            exe = Path(tmp) / "fake-strata"
            exe.write_text("#!/usr/bin/env python3\n" + FAKE_ENGINE, encoding="utf-8")
            exe.chmod(0o755)
            cfg = Path(tmp) / "web-first.json"
            # a tokenizer of our own making: main() refuses to start a strata engine without one, and Service
            # encodes the end-of-turn tokens in its constructor, so the vocabulary has to hold every printable
            # character and those specials - the specials come from the parser's constants, never spelled here
            tokdir = Path(tmp) / "tokenizer"
            tokdir.mkdir()
            chars = [chr(c) for c in range(32, 127)] + ["\n", "\t", "\r"]
            specials = [IM_END, chr(60) + "|endoftext|" + chr(62), THINK_END, CALL_START, CALL_END,
                        FUNC_START, FUNC_END, PARAM_START, PARAM_END]   # the end-of-text marker assembled, not
            # spelled: the tags themselves are never written out anywhere (LESSONS.md, Existential)
            vocab = {t: i for i, t in enumerate(dict.fromkeys(chars + specials))}
            (tokdir / "vocab.json").write_text(json.dumps(vocab), encoding="utf-8")
            (tokdir / "merges.txt").write_text("a b", encoding="utf-8")  # one merge of two characters that are
            # both in the vocabulary; an empty file still splits to one empty pair, which the reader refuses
            (tokdir / "token_type.json").write_text(
                json.dumps([2 if t in specials else 1 for t in vocab]), encoding="utf-8")
            cfg.write_text(json.dumps({"exe": str(exe), "cwd": tmp, "model_name": "web-first-test",
                                       "tokenizer": str(tokdir),
                                       "args": ["--max-context", "4096", "--ready-delay", str(READY_S)]}),
                           encoding="utf-8")
            port = free_port()
            proc = subprocess.Popen([sys.executable, str(ROOT / "serve" / "server.py"), "--engine", "strata",
                                     "--config", str(cfg), "--port", str(port)],
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            self.addCleanup(self.end, proc)
            lines: list[str] = []
            threading.Thread(target=lambda: [lines.append(l.rstrip()) for l in proc.stdout], daemon=True).start()

            t0, answer = time.monotonic(), None
            while time.monotonic() - t0 < READY_S + 25 and answer is None:
                try:
                    answer = self.health(port)
                except OSError:
                    time.sleep(0.1)
            self.assertIsNotNone(answer, "the port never answered: " + " | ".join(lines[-12:]))
            first = time.monotonic() - t0
            self.assertLess(first, READY_S - 1,
                            f"the page answered {first:.1f} s in, but the stand-in engine only says READY at "
                            f"{READY_S} s - the port still waits for the model")
            self.assertFalse(answer["loaded"], "and /health says the model is not up, which at that moment is true")

            up, deadline = None, time.monotonic() + READY_S + 30
            while time.monotonic() < deadline:
                try:
                    h = self.health(port)
                except OSError:
                    h = None
                if h and h["loaded"]:
                    up = h
                    break
                time.sleep(0.25)
            self.assertIsNotNone(up, "the background load never brought the model up: " + " | ".join(lines[-12:]))
            self.assertFalse(up["loading"], "loading is over once it is up")
            self.assertGreaterEqual(up["load_seconds"], READY_S - 1,
                                    "it really waited for the engine, it did not pretend")
            self.assertIsNone(proc.poll(), "and it is still the same server process, not a restarted one")
            banner = [l for l in lines if l.startswith("ready: http") or "model ready" in l]
            self.assertEqual(len(banner), 2, "the URL banner and the model-ready line, once each: " + str(banner))
            self.assertIn("ready: http", banner[0])
            self.assertIn("model loading", banner[0], "the banner says the model is not there yet")
            self.assertIn("model ready", banner[1])


if __name__ == "__main__":
    unittest.main()
