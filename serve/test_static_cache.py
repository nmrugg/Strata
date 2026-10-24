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
