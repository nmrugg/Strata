"""The web app's files and the two pages carry a validator, so a browser that asks "still the same?" gets a 304
instead of the whole file again.  The icon sprite is re-resolved by the page as output streams, and with
`Cache-Control: no-cache` and no ETag every one of those revalidations was a full 200 carrying 29,112 bytes.
no-cache stays (edit app.js, the next reload must show it without a restart) - the validator is what makes it
cheap.  The page itself gets one too: with no Cache-Control at all a browser could serve a stale index.html on
an ordinary reload.

    python -m unittest serve.test_static_cache -v
"""
import http.client
import json
import unittest
from pathlib import Path

from serve.frontend import ChatTemplate
from serve.server import ByteTokenizer, MockEngine, Service, serve

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "serve" / "web"
PROBE = WEB / "_cache_probe.js"


def get(conn, path, headers=None):
    conn.request("GET", path, headers=headers or {})
    r = conn.getresponse()
    return r.status, dict(r.getheaders()), r.read()


class Server(unittest.TestCase):
    def setUp(self):
        tok = ByteTokenizer()
        self.svc = Service(MockEngine(tok, "ok"), tok, ChatTemplate(ROOT / "serve/chat_template.jinja"))
        self.httpd = serve(self.svc, port=0)
        self.conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_address[1], timeout=10)

    def tearDown(self):
        self.conn.close()
        self.httpd.shutdown()
        self.httpd.server_close()
        PROBE.unlink(missing_ok=True)


class StaticValidators(Server):
    def test_an_asset_carries_a_validator(self):
        code, h, body = get(self.conn, "/web/app.js")
        self.assertEqual(code, 200)
        self.assertTrue(h.get("ETag", "").startswith('W/"'), h)
        self.assertIn("GMT", h.get("Last-Modified", ""))
        self.assertEqual(h.get("Cache-Control"), "no-cache")   # still revalidate: an edit shows with no restart
        self.assertEqual(len(body), len((WEB / "app.js").read_bytes()))

    def test_a_matching_etag_gets_304_and_no_body(self):
        _, h, _ = get(self.conn, "/web/sprite.svg")
        code, h2, body = get(self.conn, "/web/sprite.svg", {"If-None-Match": h["ETag"]})
        self.assertEqual(code, 304)
        self.assertEqual(body, b"")
        self.assertEqual(h2["ETag"], h["ETag"])
        self.assertNotIn("Content-Length", h2)                 # a 304 has no body to size

    def test_any_of_several_offered_tags_matches(self):
        _, h, _ = get(self.conn, "/web/app.css")
        code, _, body = get(self.conn, "/web/app.css", {"If-None-Match": f'W/"nope-0-0", {h["ETag"]}'})
        self.assertEqual(code, 304)
        self.assertEqual(body, b"")

    def test_star_matches_any_current_representation(self):
        code, _, body = get(self.conn, "/web/app.css", {"If-None-Match": "*"})
        self.assertEqual(code, 304)
        self.assertEqual(body, b"")

    def test_last_modified_also_works_when_no_etag_is_offered(self):
        _, h, _ = get(self.conn, "/web/monitor.js")
        code, _, body = get(self.conn, "/web/monitor.js", {"If-Modified-Since": h["Last-Modified"]})
        self.assertEqual(code, 304)
        self.assertEqual(body, b"")

    def test_a_stamp_older_than_the_file_serves_the_file(self):
        code, _, body = get(self.conn, "/web/monitor.js", {"If-Modified-Since": "Wed, 01 Jan 2020 00:00:00 GMT"})
        self.assertEqual(code, 200)
        self.assertTrue(body)

    def test_an_unreadable_stamp_is_no_reason_to_claim_freshness(self):
        code, _, body = get(self.conn, "/web/monitor.js", {"If-Modified-Since": "not a date"})
        self.assertEqual(code, 200)
        self.assertTrue(body)

    def test_an_edit_is_served_without_a_restart(self):
        # no-cache plus a validator is only safe if the validator moves when the file does: that is the whole
        # reason the developer wanted revalidation in the first place
        PROBE.write_text("const v = 1;", encoding="utf-8")
        _, h1, _ = get(self.conn, "/web/_cache_probe.js")
        PROBE.write_text("const v = 2; // longer than before", encoding="utf-8")
        code, h2, body = get(self.conn, "/web/_cache_probe.js", {"If-None-Match": h1["ETag"]})
        self.assertEqual(code, 200, "an old tag must not answer for changed bytes")
        self.assertNotEqual(h2["ETag"], h1["ETag"])
        self.assertIn("longer than before", body.decode())

    def test_the_page_gets_a_validator_too(self):
        # without one a browser could serve a stale index.html on a plain reload, which is why a changed app.js
        # sometimes needed a hard-refresh
        code, h, body = get(self.conn, "/")
        self.assertEqual(code, 200)
        self.assertEqual(h.get("Cache-Control"), "no-cache")
        self.assertTrue(h.get("ETag", "").startswith('W/"'), h)
        code2, _, body2 = get(self.conn, "/", {"If-None-Match": h["ETag"]})
        self.assertEqual(code2, 304)
        self.assertEqual(body2, b"")

    def test_the_path_rules_are_unchanged(self):
        self.assertEqual(get(self.conn, "/web/../server.py")[0], 404)
        self.assertEqual(get(self.conn, "/web/server.py")[0], 404)          # not an allowed extension
        self.assertEqual(get(self.conn, "/web/nope.js")[0], 404)


class SpriteInlined(Server):
    """The icon symbols are inlined into the pages that reference them, so a <use href="#i-name"> is
    same-document and the browser never fetches sprite.svg - which it used to re-resolve as new icons appeared
    while output streamed."""

    def test_the_page_carries_the_symbols_and_no_reference_to_the_file(self):
        code, _, body = get(self.conn, "/")
        html = body.decode()
        self.assertEqual(code, 200)
        self.assertIn('<symbol id="i-chat"', html)
        self.assertIn('<use href="#i-chat"/>', html)
        self.assertNotIn("web/sprite.svg", html)
        self.assertIn('style="display:none"', html)

    def test_the_provenance_manifest_is_not_inlined(self):
        # the page gets the symbols and nothing else from the file.  The manifest was deleted from the source,
        # but this stays: if provenance comes back to the file, it belongs to the file and not to every page
        code, _, body = get(self.conn, "/")
        html = body.decode()
        self.assertNotIn("c2pa:manifest", html)
        self.assertNotIn("<metadata", html)
        self.assertEqual(html.count("<symbol "), 33)
        self.assertLess(len(html.encode()), 42000, "the page stayed a sane size")

    def test_the_symbols_come_before_the_first_use(self):
        code, _, body = get(self.conn, "/")
        html = body.decode()
        self.assertLess(html.index('<symbol id="i-chat"'), html.index('<use href="#i-chat"/>'))

    def test_a_page_that_uses_no_symbols_is_left_alone(self):
        self.svc.api_monitor = True
        code, _, body = get(self.conn, "/api-monitor")
        self.assertEqual(code, 200)
        self.assertNotIn("<symbol ", body.decode())

    def test_a_missing_sprite_degrades_instead_of_failing_the_request(self):
        # the file is now the source of the inlined symbols, so a missing one must not take the page down
        handler = self.httpd.RequestHandlerClass
        real = handler.SPRITE
        handler.SPRITE = WEB / "no_such_sprite.svg"
        try:
            code, _, body = get(self.conn, "/")
            self.assertEqual(code, 200)
            self.assertNotIn(b"<symbol ", body)
            code2, _, _ = get(self.conn, "/web/app.js")
            self.assertEqual(code2, 200)                       # other assets never needed it
        finally:
            handler.SPRITE = real

    def test_the_sprite_file_is_still_served_whole(self):
        # it is no longer fetched by the app, but it is the source of the symbols and still a real file at a
        # real URL: the route must not strip anything from it
        code, _, body = get(self.conn, "/web/sprite.svg")
        self.assertEqual(code, 200)
        self.assertEqual(body, (WEB / "sprite.svg").read_bytes())
        self.assertIn(b"<symbol id=\"i-chat\"", body)


class LiteMetrics(Server):
    """todo #40: the Chat tab shows the header pill and nothing else, so it asks ?lite=1. The point is not only
    the bytes: the full answer snapshots the telemetry and re-reads the engine log (up to a MiB of new lines),
    which the Chat tab was paying for once a second and never showing."""

    def test_the_full_answer_carries_the_cards(self):
        code, _, body = get(self.conn, "/metrics")
        m = json.loads(body)
        self.assertEqual(code, 200)
        for key in ("engine", "live", "requests", "conversation_cache", "totals", "hardware",
                    "hardware_static", "history"):
            self.assertIn(key, m)

    def test_lite_keeps_the_pill_and_drops_the_rest(self):
        code, _, body = get(self.conn, "/metrics?lite=1")
        m = json.loads(body)
        self.assertEqual(code, 200)
        self.assertTrue(m["lite"])
        self.assertIn("state", m["live"])
        self.assertIn("max_context", m["engine"])      # projectionLoaded() reads engine.cvec
        for key in ("history", "hardware", "hardware_static", "conversation_cache", "totals", "requests"):
            self.assertNotIn(key, m)
        full = len(get(self.conn, "/metrics")[2])
        # on this box a real /metrics is 7,317 bytes and the lite answer measured 404 - about 18x smaller. The
        # mock engine has almost no history, so the ratio here is much less; what is asserted is that the lite
        # answer is smaller and that the card-only keys are gone (checked above by name, which is the real claim).
        self.assertLess(len(body), full, "the lite answer has to actually be smaller")

    def test_lite_still_reports_a_running_tool(self):
        # todo #35 and #40 meet here: the pill is the whole reason the Chat tab polls, so a tool must be named
        # in the lite answer too
        tok = ByteTokenizer()
        svc = self.svc
        with svc.status_lock:
            svc.mcp_running[object()] = "easyCMP__run_cmd"
        try:
            m = json.loads(get(self.conn, "/metrics?lite=1")[2])
        finally:
            with svc.status_lock:
                svc.mcp_running.clear()
        self.assertEqual(m["live"]["state"], "running-tool")
        self.assertEqual(m["live"]["tool"], "easyCMP__run_cmd")

    def test_lite_does_not_read_the_engine_log_or_the_telemetry(self):
        # the work, not just the bytes: a lite call must not touch either
        calls = []
        svc = self.svc
        real_tel, real_log = svc.telemetry.snapshot, svc.conv_log.poll
        svc.telemetry.snapshot = lambda *a, **k: (calls.append("telemetry"), real_tel())[1]
        svc.conv_log.poll = lambda *a, **k: (calls.append("conv_log"), real_log(*a, **k))[1]
        try:
            get(self.conn, "/metrics?lite=1")
            self.assertEqual(calls, [], "a lite answer did server work the Chat tab cannot show")
            get(self.conn, "/metrics")
            self.assertIn("telemetry", calls)
            self.assertIn("conv_log", calls)
        finally:
            svc.telemetry.snapshot, svc.conv_log.poll = real_tel, real_log

    def test_requests_all_still_works(self):
        m = json.loads(get(self.conn, "/metrics?requests=all")[2])
        self.assertIn("requests", m)


class MetricsStillUncached(Server):
    """The point of the change is the bytes that are NOT worth caching: /metrics is live state, so it keeps no
    validator and answers in full every time - which is why it should be asked for less often, not cheaper."""

    def test_metrics_answers_200_even_offered_star(self):
        _, h, _ = get(self.conn, "/metrics")
        self.assertNotIn("ETag", h)
        code, _, body = get(self.conn, "/metrics", {"If-None-Match": "*"})
        self.assertEqual(code, 200)
        self.assertTrue(json.loads(body)["live"]["state"])


if __name__ == "__main__":
    unittest.main()
