from __future__ import annotations

import io
import unittest

from browser_proxy.protocol import LOCAL_LENGTH, ProtocolError, read_local, write_local


class ProtocolTests(unittest.TestCase):
    def test_local_frame_round_trip(self) -> None:
        stream = io.BytesIO()
        message = {"protocol": "browser-proxy", "value": "caf\u00e9"}
        write_local(stream, message)
        stream.seek(0)
        self.assertEqual(read_local(stream), message)

    def test_rejects_oversized_declared_frame(self) -> None:
        stream = io.BytesIO(LOCAL_LENGTH.pack(64 * 1024 * 1024 + 1))
        with self.assertRaises(ProtocolError):
            read_local(stream)


if __name__ == "__main__":
    unittest.main()
