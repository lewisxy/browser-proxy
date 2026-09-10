from __future__ import annotations

import io
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import MagicMock, patch

from browser_proxy.protocol import LOCAL_LENGTH, ProtocolError, STREAM_CHUNK_BYTES, read_local, stream_local, write_local


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

    def test_write_local_completes_partial_writes(self) -> None:
        class PartialWriteStream(io.BytesIO):
            def write(self, data: bytes) -> int:
                return super().write(data[:17])

        stream = PartialWriteStream()
        message = {"protocol": "browser-proxy", "body": "x" * 4096}
        write_local(stream, message)
        stream.seek(0)
        self.assertEqual(read_local(stream), message)

    def stream_events(self, events):
        encoded = io.BytesIO()
        for event in events:
            write_local(encoded, {"protocol": "browser-proxy", "version": 1, "id": "test", **event})

        class Duplex(io.BytesIO):
            def __init__(self):
                super().__init__(encoded.getvalue())
                self.written = bytearray()

            def write(self, data):
                self.written.extend(data)
                return len(data)

        duplex = Duplex()
        client = MagicMock()
        client.__enter__.return_value = client
        client.makefile.return_value = duplex
        mocked = patch("browser_proxy.protocol.socket.socket", return_value=client)
        mocked.start()
        self.addCleanup(mocked.stop)
        return stream_local({"id": "test", "type": "request_stream"}, Path("unused.sock"), 1, 1), duplex

    def test_stream_acknowledges_only_when_consumer_advances(self):
        events, duplex = self.stream_events([
            {"type": "response_start", "body_bytes": None, "response": {}},
            {"type": "response_chunk", "sequence": 0, "data": "AP9hYmM="},
            {"type": "response_end", "chunks": 1, "body_bytes": 5},
        ])
        with closing(events):
            self.assertEqual(next(events)["type"], "response_start")
            request_size = len(duplex.written)
            self.assertEqual(next(events)["data"], b"\x00\xffabc")
            ack_start = read_local(io.BytesIO(duplex.written[request_size:]))
            self.assertEqual(ack_start["sequence"], -1)
            chunk_ack_offset = len(duplex.written)
            self.assertEqual(next(events)["type"], "response_end")
            ack_chunk = read_local(io.BytesIO(duplex.written[chunk_ack_offset:]))
            self.assertEqual(ack_chunk["sequence"], 0)

    def test_stream_rejects_invalid_sequence_encoding_size_and_final_counts(self):
        invalid = [
            {"type": "response_chunk", "sequence": 1, "data": "YQ=="},
            {"type": "response_chunk", "sequence": 0, "data": "!"},
            {"type": "response_chunk", "sequence": 0, "data": ""},
            {"type": "response_chunk", "sequence": 0, "data": "A" * (STREAM_CHUNK_BYTES * 4 // 3 + 4)},
            {"type": "response_end", "chunks": 0, "body_bytes": 1},
            {"type": "response_end", "chunks": 1, "body_bytes": 0},
            {"type": "response_start", "body_bytes": None, "response": {}},
            {"type": "response_chunk", "sequence": 0, "data": "YQ==", "id": "wrong"},
            {"type": "response_error", "id": "unknown", "error": {"code": "TIMEOUT", "message": "wrong id"}},
        ]
        for event in invalid:
            with self.subTest(type=event["type"]):
                events, _ = self.stream_events([
                    {"type": "response_start", "body_bytes": None, "response": {}}, event,
                ])
                with closing(events):
                    next(events)
                    with self.assertRaises(ProtocolError):
                        next(events)

    def test_stream_requires_explicit_end_even_for_empty_response(self):
        events, _ = self.stream_events([{"type": "response_start", "body_bytes": None, "response": {}}])
        with closing(events):
            next(events)
            with self.assertRaises(EOFError):
                next(events)

    def test_stream_accepts_old_host_error_without_buffered_fallback(self):
        events, _ = self.stream_events([{
            "type": "response", "id": "unknown", "ok": False,
            "error": {"code": "HOST_PROTOCOL_ERROR", "message": "Unsupported local protocol envelope"},
        }])
        with closing(events):
            self.assertEqual(next(events)["error"]["code"], "HOST_PROTOCOL_ERROR")
            with self.assertRaises(StopIteration):
                next(events)


if __name__ == "__main__":
    unittest.main()
