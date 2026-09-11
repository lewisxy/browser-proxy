from __future__ import annotations

import base64
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from browser_proxy.cli import build_request, main, parser


class CliRequestTests(unittest.TestCase):
    def parse(self, *arguments: str):
        return parser().parse_args([*arguments, "https://example.com/api"])

    def test_empty_data_still_selects_post(self) -> None:
        request = build_request(self.parse("-d", ""))
        self.assertEqual(request["method"], "POST")
        self.assertIn(["Content-Type", "application/x-www-form-urlencoded"], request["headers"])

    def test_json_file_and_custom_header(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "request.json"
            source.write_text('{"answer": 42}', encoding="utf-8")
            request = build_request(self.parse("--json", f"@{source}", "-H", "Accept: application/json"))
        self.assertEqual(base64.b64decode(request["body"]["data"]), b'{"answer": 42}')
        self.assertIn(["Content-Type", "application/json"], request["headers"])
        self.assertIn(["Accept", "application/json"], request["headers"])

    def test_json_adds_accept_header(self) -> None:
        request = build_request(self.parse("--json", "{}"))
        self.assertIn(["Accept", "application/json"], request["headers"])

    def test_get_moves_encoded_data_to_query(self) -> None:
        request = build_request(self.parse("-G", "--data-urlencode", "q=two words"))
        self.assertEqual(request["method"], "GET")
        self.assertEqual(request["url"], "https://example.com/api?q=two+words")
        self.assertEqual(request["body"]["data"], "")
        self.assertNotIn("Content-Type", [name for name, _ in request["headers"]])

    def test_repeated_binary_data_uses_separator(self) -> None:
        request = build_request(self.parse("--data-binary", "one", "--data-binary", "two"))
        self.assertEqual(base64.b64decode(request["body"]["data"]), b"one&two")

    def test_url_query_encodes_value(self) -> None:
        request = build_request(self.parse("--url-query", "q=caf\u00e9 & tea"))
        self.assertEqual(request["url"], "https://example.com/api?q=caf%C3%A9+%26+tea")

    def test_multipart_includes_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "sample.txt"
            source.write_bytes(b"file contents")
            request = build_request(self.parse("-F", "label=test", "-F", f"upload=@{source}"))
        body = base64.b64decode(request["body"]["data"])
        self.assertIn(b'name="label"\r\n\r\ntest', body)
        self.assertIn(b'filename="sample.txt"', body)
        self.assertIn(b"file contents", body)

    def test_response_json_retains_buffered_protocol(self) -> None:
        result = {"ok": True, "response": {"body": {"encoding": "base64", "data": "YWJj"}}}
        with patch("sys.argv", ["browser-proxy", "--response-json", "https://example.com/file"]), \
                patch("browser_proxy.cli.exchange_local", return_value=result) as exchange, \
                patch("sys.stdout", io.StringIO()) as output:
            self.assertEqual(main(), 0)
            self.assertEqual(json.loads(output.getvalue()), result)
            self.assertEqual(exchange.call_args.args[0]["type"], "request")

    def test_redirects_require_opt_in_and_have_a_bounded_limit(self) -> None:
        self.assertFalse(build_request(self.parse())["follow_redirects"])
        request = build_request(self.parse("-L", "--max-redirs", "3"))
        self.assertTrue(request["follow_redirects"])
        self.assertEqual(request["max_redirects"], 3)
        for value in ("-1", "21"):
            with patch("sys.argv", ["browser-proxy", "-L", "--max-redirs", value, "https://example.com"]), \
                    patch("sys.stderr", io.StringIO()), self.assertRaises(SystemExit) as error:
                main()
            self.assertEqual(error.exception.code, 2)

    def test_unfollowed_redirect_output_and_body_unavailable_notice(self) -> None:
        response = {
            "status": 302, "status_text": "Found", "url": "https://example.com/api",
            "headers": [["location", "https://denied.example/end"], ["content-length", "99"]],
            "body_unavailable": True,
        }
        expected = b"HTTP/1.1 302 Found\r\nlocation: https://denied.example/end\r\ncontent-length: 99\r\n\r\n"
        for flags, include, notice in [([], False, True), (["-i"], True, True), (["-I"], True, False),
                                       (["--fail"], False, True), (["-s"], False, False),
                                       (["-s", "-S"], False, False), (["-s", "-v"], False, True)]:
            with self.subTest(flags=flags):
                output = io.BytesIO()
                events = (event for event in [
                    {"type": "response_start", "response": response, "body_bytes": None},
                    {"type": "response_end", "body_bytes": 0, "chunks": 0},
                ])
                with patch("sys.argv", ["browser-proxy", *flags, "https://example.com/api"]), \
                        patch("browser_proxy.cli.stream_local", return_value=events), \
                        patch("sys.stdout", SimpleNamespace(buffer=output)), patch("sys.stderr", io.StringIO()) as stderr:
                    self.assertEqual(main(), 0)
                    self.assertEqual(output.getvalue(), expected if include else b"")
                    self.assertEqual("response body is unavailable" in stderr.getvalue(), notice)

    def test_unfollowed_redirect_json_exposes_unavailable_body(self) -> None:
        result = {"ok": True, "response": {
            "status": 302, "headers": [["location", "https://denied.example/end"]],
            "body_unavailable": True, "body": {"encoding": "base64", "data": ""},
        }}
        with patch("sys.argv", ["browser-proxy", "--response-json", "https://example.com/api"]), \
                patch("browser_proxy.cli.exchange_local", return_value=result), \
                patch("sys.stdout", io.StringIO()) as output, patch("sys.stderr", io.StringIO()) as stderr:
            self.assertEqual(main(), 0)
            self.assertEqual(json.loads(output.getvalue()), result)
            self.assertEqual(stderr.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
