from __future__ import annotations

import base64
import tempfile
import unittest
from pathlib import Path

from browser_proxy.cli import build_request, parser


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


if __name__ == "__main__":
    unittest.main()
