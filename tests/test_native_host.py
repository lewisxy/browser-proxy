from __future__ import annotations

import base64
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path

from browser_proxy.native_host import NativeHost, detect_browser
from browser_proxy.protocol import (
    MAX_LOCAL_MESSAGE_BYTES,
    NATIVE_LENGTH,
    PROTOCOL_NAME,
    PROTOCOL_VERSION,
    exchange_local,
    read_framed,
    write_framed,
)


class NativeHostTests(unittest.TestCase):
    def test_detects_browser_arguments(self) -> None:
        self.assertEqual(detect_browser(["chrome-extension://abc/"]), "chrome")
        self.assertEqual(detect_browser(["manifest.json", "browser-proxy@local.invalid"]), "firefox")
        self.assertEqual(detect_browser(["--channel", "chrome"]), "chrome")

    def test_real_host_bridges_chunked_request_and_response(self) -> None:
        project_runtime = Path(__file__).resolve().parents[1] / ".browser-proxy"
        project_runtime.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=project_runtime) as directory:
            socket_path = Path(directory) / "host.sock"
            process = subprocess.Popen(
                [sys.executable, "-m", "browser_proxy.native_host", "--channel", "chrome", "--socket", os.fspath(socket_path)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            self.addCleanup(self.stop_process, process)
            for _ in range(100):
                if socket_path.exists():
                    break
                if process.poll() is not None:
                    self.fail(process.stderr.read().decode("utf-8"))
                time.sleep(0.02)
            else:
                self.fail("native host did not create its socket")

            ready = read_framed(process.stdout, NATIVE_LENGTH, MAX_LOCAL_MESSAGE_BYTES)
            self.assertEqual(
                ready,
                {"protocol": PROTOCOL_NAME, "version": PROTOCOL_VERSION, "type": "host_ready"},
            )

            request_id = uuid.uuid4().hex
            request_body = b"request data"
            local_message = {
                "protocol": PROTOCOL_NAME,
                "version": PROTOCOL_VERSION,
                "type": "request",
                "id": request_id,
                "request": {
                    "url": "https://example.com/api",
                    "method": "POST",
                    "headers": [["Content-Type", "text/plain"]],
                    "body": {"encoding": "base64", "data": base64.b64encode(request_body).decode("ascii")},
                    "timeout_ms": 1000,
                    "cache": "default",
                },
            }
            result: dict = {}

            def local_client() -> None:
                result.update(exchange_local(local_message, socket_path, 1, 3))

            client = threading.Thread(target=local_client)
            client.start()
            start = read_framed(process.stdout, NATIVE_LENGTH, MAX_LOCAL_MESSAGE_BYTES)
            chunk = read_framed(process.stdout, NATIVE_LENGTH, MAX_LOCAL_MESSAGE_BYTES)
            end = read_framed(process.stdout, NATIVE_LENGTH, MAX_LOCAL_MESSAGE_BYTES)
            self.assertEqual(start["type"], "request_start")
            self.assertEqual(start["body_bytes"], len(request_body))
            self.assertEqual(base64.b64decode(chunk["data"]), request_body)
            self.assertEqual(end, {"protocol": PROTOCOL_NAME, "version": 1, "type": "request_end", "id": request_id, "chunks": 1})

            response_body = b"response data"
            for native_message in (
                {
                    "protocol": PROTOCOL_NAME,
                    "version": PROTOCOL_VERSION,
                    "type": "response_start",
                    "id": request_id,
                    "response": {"status": 200, "status_text": "OK", "url": "https://example.com/api", "headers": []},
                    "body_bytes": len(response_body),
                },
                {
                    "protocol": PROTOCOL_NAME,
                    "version": PROTOCOL_VERSION,
                    "type": "response_chunk",
                    "id": request_id,
                    "sequence": 0,
                    "data": base64.b64encode(response_body).decode("ascii"),
                },
                {
                    "protocol": PROTOCOL_NAME,
                    "version": PROTOCOL_VERSION,
                    "type": "response_end",
                    "id": request_id,
                    "chunks": 1,
                },
            ):
                write_framed(process.stdin, native_message, NATIVE_LENGTH, MAX_LOCAL_MESSAGE_BYTES)
            client.join(3)
            self.assertFalse(client.is_alive())
            self.assertTrue(result["ok"])
            self.assertEqual(base64.b64decode(result["response"]["body"]["data"]), response_body)

            process.stdin.close()
            process.wait(timeout=2)
            self.assertEqual(process.returncode, 0)
            self.assertFalse(socket_path.exists())

    def test_old_host_does_not_unlink_replacement_socket(self) -> None:
        project_runtime = Path(__file__).resolve().parents[1] / ".browser-proxy"
        project_runtime.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=project_runtime) as directory:
            socket_path = Path(directory) / "host.sock"
            old_host = NativeHost("chrome", socket_path)
            old_server = old_host.prepare_socket()
            old_server.close()
            socket_path.unlink()

            replacement = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.addCleanup(replacement.close)
            replacement.bind(os.fspath(socket_path))
            replacement.listen(1)

            old_host.close_server()
            self.assertTrue(socket_path.exists())
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                client.connect(os.fspath(socket_path))
            finally:
                client.close()
                replacement.close()
                socket_path.unlink(missing_ok=True)

    @staticmethod
    def stop_process(process: subprocess.Popen) -> None:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream:
                stream.close()


if __name__ == "__main__":
    unittest.main()
