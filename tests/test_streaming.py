from __future__ import annotations

import base64
import hashlib
import io
import os
import select
import socket
import subprocess
import sys
import tempfile
import threading
import tracemalloc
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from browser_proxy.cli import main
from browser_proxy.native_host import NativeHost, PendingResponse
from browser_proxy.protocol import (
    MAX_STREAM_MESSAGE_BYTES, NATIVE_LENGTH, STREAM_CHUNK_BYTES,
    exchange_local, read_framed, read_local, write_framed, write_local,
)


def envelope(kind: str, request_id: str = "download", **fields) -> dict:
    return {"protocol": "browser-proxy", "version": 1, "type": kind, "id": request_id, **fields}


def response_start(request_id: str = "download", status: int = 200) -> dict:
    return envelope("response_start", request_id, body_bytes=None, response={
        "status": status, "status_text": "Test", "url": "https://example.com/file", "headers": [],
    })


class CountingOutput:
    """A partial-writing consumer that never retains the complete download."""

    def __init__(self):
        self.count = 0
        self.digest = hashlib.sha256()
        self.max_write = 0

    def write(self, data):
        self.max_write = max(self.max_write, len(data))
        part = data[:65536]
        self.digest.update(part)
        self.count += len(part)
        return len(part)

    def flush(self):
        pass


class StreamingIntegrationTests(unittest.TestCase):
    def setUp(self):
        runtime = Path(__file__).resolve().parents[1] / ".browser-proxy"
        runtime.mkdir(exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(dir=runtime)
        self.addCleanup(self.directory.cleanup)
        self.socket_path = Path(self.directory.name) / "host.sock"
        # Measure the real relay process as well as the client test process.
        self.process = subprocess.Popen([
            sys.executable, "-c",
            "import tracemalloc; tracemalloc.start(); "
            "from browser_proxy.native_host import main; result = main(); "
            "import sys; print('peak_memory=' + str(tracemalloc.get_traced_memory()[1]), file=sys.stderr); "
            "sys.exit(result)",
            "--channel", "chrome", "--socket", os.fspath(self.socket_path),
        ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        self.addCleanup(self.stop_host)
        self.assertEqual(self.read_native()["type"], "host_ready")
        self.driver_errors = []

    def stop_host(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            stream.close()

    def read_native(self):
        if not select.select([self.process.stdout], [], [], 10)[0]:
            raise AssertionError("Timed out waiting for a native message")
        return read_framed(self.process.stdout, NATIVE_LENGTH, MAX_STREAM_MESSAGE_BYTES)

    def send_native(self, message):
        write_framed(self.process.stdin, message, NATIVE_LENGTH, MAX_STREAM_MESSAGE_BYTES)

    def start_driver(self, function):
        def run():
            try:
                function()
            except Exception as error:
                self.driver_errors.append(error)
        driver = threading.Thread(target=run, daemon=True)
        driver.start()
        self.addCleanup(driver.join, 1)
        return driver

    def finish_driver(self, driver):
        driver.join(10)
        self.assertFalse(driver.is_alive(), "native driver did not finish")
        if self.driver_errors:
            raise self.driver_errors[0]

    def accept_request(self, status=200):
        start = self.read_native()
        self.assertEqual(start["type"], "request_start")
        self.assertTrue(start["stream_response"])
        self.assertEqual(self.read_native()["type"], "request_end")
        self.send_native(response_start(start["id"], status))
        return start["id"]

    def expect_ack(self, request_id, sequence):
        self.assertEqual(self.read_native(), envelope("response_ack", request_id, sequence=sequence))

    def run_cli(self, output, *arguments):
        with patch("sys.argv", ["browser-proxy", "--socket", str(self.socket_path), *arguments, "https://example.com/file"]), \
                patch("browser_proxy.cli.sys.stdout", SimpleNamespace(buffer=output)), \
                patch("browser_proxy.cli.sys.stderr", io.StringIO()) as stderr:
            code = main()
            return code, stderr.getvalue()

    def test_large_download_has_bounded_client_and_host_memory(self):
        chunk = bytes(range(256)) * (STREAM_CHUNK_BYTES // 256)
        count = 240  # 90 MiB: exceeds both the old body and local frame limits.
        expected_hash = hashlib.sha256()
        for _ in range(count):
            expected_hash.update(chunk)

        def browser():
            request_id = self.accept_request()
            self.expect_ack(request_id, -1)
            data = base64.b64encode(chunk).decode("ascii")
            for sequence in range(count):
                self.send_native(envelope("response_chunk", request_id, sequence=sequence, data=data))
                self.expect_ack(request_id, sequence)
            self.send_native(envelope("response_end", request_id, chunks=count, body_bytes=count * len(chunk)))

        output = CountingOutput()
        tracemalloc.start()
        try:
            driver = self.start_driver(browser)
            code, stderr = self.run_cli(output, "--max-time", "120")
            self.finish_driver(driver)
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(output.count, count * len(chunk))
        self.assertEqual(output.digest.digest(), expected_hash.digest())
        self.assertLessEqual(output.max_write, STREAM_CHUNK_BYTES)
        self.assertLess(peak, 16 * 1024 * 1024, f"client peak allocation: {peak}")
        self.process.stdin.close()
        self.process.wait(timeout=3)
        diagnostics = self.process.stderr.read().decode()
        self.assertEqual(self.process.returncode, 0, diagnostics)
        host_peak = int(diagnostics.split("peak_memory=")[1].splitlines()[0])
        self.assertLess(host_peak, 16 * 1024 * 1024, f"host peak allocation: {host_peak}")

    def test_output_failure_cancels_without_acknowledging_chunk(self):
        class FailedOutput(CountingOutput):
            def write(self, data):
                raise OSError("disk full")

        def browser():
            request_id = self.accept_request()
            self.expect_ack(request_id, -1)
            self.send_native(envelope("response_chunk", request_id, sequence=0, data="YWJj"))
            self.assertEqual(self.read_native(), envelope("request_cancel", request_id))

        driver = self.start_driver(browser)
        code, stderr = self.run_cli(FailedOutput())
        self.finish_driver(driver)
        self.assertEqual(code, 23)
        self.assertIn("disk full", stderr)

    def test_error_after_partial_body_reports_failure(self):
        def browser():
            request_id = self.accept_request()
            self.expect_ack(request_id, -1)
            self.send_native(envelope("response_chunk", request_id, sequence=0, data="YWJj"))
            self.expect_ack(request_id, 0)
            self.send_native(envelope("response_error", request_id, error={"code": "TIMEOUT", "message": "too slow"}))
            self.assertEqual(self.read_native(), envelope("request_cancel", request_id))

        driver = self.start_driver(browser)
        output = io.BytesIO()
        code, stderr = self.run_cli(output)
        self.finish_driver(driver)
        self.assertEqual(code, 28)
        self.assertEqual(output.getvalue(), b"abc")
        self.assertIn("incomplete", stderr)

    def test_closed_stdout_pipe_cancels_and_preserves_write_error_exit(self):
        def browser():
            request_id = self.accept_request()
            self.expect_ack(request_id, -1)
            self.send_native(envelope("response_chunk", request_id, sequence=0, data="YWJj"))
            self.assertEqual(self.read_native(), envelope("request_cancel", request_id))

        driver = self.start_driver(browser)
        cli = subprocess.Popen([
            sys.executable, "-m", "browser_proxy.cli", "--socket", str(self.socket_path), "https://example.com/file",
        ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            cli.stdout.close()
            cli.wait(timeout=5)
            stderr = cli.stderr.read().decode()
            self.finish_driver(driver)
            self.assertEqual(cli.returncode, 23, stderr)
            self.assertNotIn("Exception ignored", stderr)
        finally:
            if cli.poll() is None:
                cli.kill()
                cli.wait(timeout=3)
            cli.stderr.close()

    def test_http_fail_cancels_before_body(self):
        def browser():
            request_id = self.accept_request(status=404)
            self.assertEqual(self.read_native(), envelope("request_cancel", request_id))

        driver = self.start_driver(browser)
        output = io.BytesIO()
        code, stderr = self.run_cli(output, "--fail")
        self.finish_driver(driver)
        self.assertEqual(code, 22)
        self.assertEqual(output.getvalue(), b"")
        self.assertIn("HTTP 404", stderr)

    def test_fail_with_body_streams_file_and_headers(self):
        def browser():
            request_id = self.accept_request(status=404)
            self.expect_ack(request_id, -1)
            self.send_native(envelope("response_chunk", request_id, sequence=0, data="AP9hYmM="))
            self.expect_ack(request_id, 0)
            self.send_native(envelope("response_end", request_id, chunks=1, body_bytes=5))

        driver = self.start_driver(browser)
        body_path = Path(self.directory.name) / "body.bin"
        header_path = Path(self.directory.name) / "headers.txt"
        code, stderr = self.run_cli(io.BytesIO(), "--fail-with-body", "-i", "-o", str(body_path), "-D", str(header_path))
        self.finish_driver(driver)
        self.assertEqual(code, 22)
        self.assertEqual(body_path.read_bytes(), b"HTTP/1.1 404 Test\r\n\r\n\x00\xffabc")
        self.assertEqual(header_path.read_bytes(), b"HTTP/1.1 404 Test\r\n\r\n")
        self.assertIn("HTTP 404", stderr)

    def test_slow_client_does_not_block_other_requests(self):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as slow:
            slow.connect(str(self.socket_path))
            slow.settimeout(3)
            with slow.makefile("rwb", buffering=0) as stream:
                write_local(stream, envelope("request_stream", "slow", request={"url": "https://example.com/file"}))
                request_id = self.accept_request()
                self.assertEqual(read_local(stream)["type"], "response_start")
                # Deliberately withhold the start ACK, then complete a buffered request.
                result = {}
                client = self.start_driver(lambda: result.update(exchange_local(
                    envelope("request", "fast", request={"url": "https://example.com/file"}), self.socket_path, 1, 3,
                )))
                self.assertEqual(self.read_native()["id"], "fast")
                self.assertEqual(self.read_native()["type"], "request_end")
                start = response_start("fast")
                start["body_bytes"] = 0
                self.send_native(start)
                self.send_native(envelope("response_end", "fast", chunks=0))
                self.finish_driver(client)
                self.assertTrue(result["ok"])
        self.assertEqual(self.read_native(), envelope("request_cancel", request_id))

    def test_client_disconnect_before_headers_cancels_fetch(self):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.connect(str(self.socket_path))
            with client.makefile("rwb", buffering=0) as stream:
                write_local(stream, envelope("request_stream", request={"url": "https://example.com/file"}))
                self.assertEqual(self.read_native()["type"], "request_start")
                self.assertEqual(self.read_native()["type"], "request_end")
        self.assertEqual(self.read_native(), envelope("request_cancel"))

    def test_invalid_local_acknowledgement_cancels_download(self):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.connect(str(self.socket_path))
            client.settimeout(3)
            with client.makefile("rwb", buffering=0) as stream:
                write_local(stream, envelope("request_stream", request={"url": "https://example.com/file"}))
                request_id = self.accept_request()
                self.assertEqual(read_local(stream)["type"], "response_start")
                write_local(stream, envelope("response_ack", request_id, sequence=0))
                self.assertEqual(self.read_native(), envelope("request_cancel", request_id))
                error = read_local(stream)
                self.assertEqual(error["type"], "response_error")
                self.assertEqual(error["error"]["code"], "HOST_PROTOCOL_ERROR")


class StreamingValidationTests(unittest.TestCase):
    def test_host_rejects_unsolicited_chunks_without_growing_queue(self):
        host = NativeHost("chrome", Path("unused.sock"))
        pending = PendingResponse(streaming=True)
        host.pending["download"] = pending
        host.handle_native_response(response_start())
        for sequence in range(100):
            host.handle_native_response(envelope("response_chunk", sequence=sequence, data="YWJj"))
        self.assertEqual(pending.messages.qsize(), 1)
        self.assertEqual(pending.body, b"")
        self.assertEqual(pending.result["error"]["code"], "PROTOCOL_ERROR")

    def test_host_validates_stream_sequences_sizes_and_final_counts(self):
        bad_messages = [
            envelope("response_chunk", sequence=1, data="YWJj"),
            envelope("response_chunk", sequence=0, data="!"),
            envelope("response_chunk", sequence=0, data=""),
            envelope("response_chunk", sequence=0, data="A" * (STREAM_CHUNK_BYTES * 4 // 3 + 4)),
            envelope("response_end", chunks=1, body_bytes=0),
            envelope("response_end", chunks=0, body_bytes=1),
            response_start(),
        ]
        for message in bad_messages:
            with self.subTest(message=message["type"]):
                host = NativeHost("chrome", Path("unused.sock"))
                pending = PendingResponse(streaming=True)
                host.pending["download"] = pending
                host.handle_native_response(response_start())
                pending.messages.get_nowait()
                pending.awaiting_ack = None
                host.handle_native_response(message)
                self.assertEqual(pending.result["error"]["code"], "PROTOCOL_ERROR")


if __name__ == "__main__":
    unittest.main()
