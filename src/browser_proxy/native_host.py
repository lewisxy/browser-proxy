"""Native-messaging host that bridges browser ports to a local Unix socket."""

from __future__ import annotations

import base64
import binascii
import os
import re
import signal
import socket
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .protocol import (
    MAX_LOCAL_MESSAGE_BYTES,
    NATIVE_LENGTH,
    PROTOCOL_NAME,
    PROTOCOL_VERSION,
    ProtocolError,
    default_socket_path,
    read_framed,
    read_local,
    write_framed,
    write_local,
)


MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024
MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_RESPONSE_BYTES = 32 * 1024 * 1024
NATIVE_CHUNK_BYTES = 384 * 1024
FIREFOX_EXTENSION_ID = "browser-proxy@local.invalid"
ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


@dataclass
class PendingResponse:
    event: threading.Event = field(default_factory=threading.Event)
    result: dict[str, Any] | None = None
    response: dict[str, Any] | None = None
    expected_bytes: int = 0
    received_bytes: int = 0
    next_sequence: int = 0
    body: bytearray = field(default_factory=bytearray)


class NativeHost:
    def __init__(self, browser: str, socket_path: Path) -> None:
        self.browser = browser
        self.socket_path = socket_path
        self.stop_event = threading.Event()
        self.native_write_lock = threading.Lock()
        self.pending_lock = threading.Lock()
        self.pending: dict[str, PendingResponse] = {}
        self.server: socket.socket | None = None
        self.client_slots = threading.BoundedSemaphore(16)

    def native_message(self, message: dict[str, Any]) -> None:
        envelope = {"protocol": PROTOCOL_NAME, "version": PROTOCOL_VERSION, **message}
        with self.native_write_lock:
            write_framed(sys.stdout.buffer, envelope, NATIVE_LENGTH, MAX_NATIVE_MESSAGE_BYTES)

    def send_request(self, request_id: str, request: dict[str, Any], body: bytes) -> None:
        metadata = {
            key: request[key]
            for key in ("url", "method", "headers", "timeout_ms", "cache")
            if key in request
        }
        with self.native_write_lock:
            write_framed(
                sys.stdout.buffer,
                {
                    "protocol": PROTOCOL_NAME,
                    "version": PROTOCOL_VERSION,
                    "type": "request_start",
                    "id": request_id,
                    "request": metadata,
                    "body_bytes": len(body),
                },
                NATIVE_LENGTH,
                MAX_NATIVE_MESSAGE_BYTES,
            )
            sequence = 0
            for offset in range(0, len(body), NATIVE_CHUNK_BYTES):
                chunk = body[offset : offset + NATIVE_CHUNK_BYTES]
                write_framed(
                    sys.stdout.buffer,
                    {
                        "protocol": PROTOCOL_NAME,
                        "version": PROTOCOL_VERSION,
                        "type": "request_chunk",
                        "id": request_id,
                        "sequence": sequence,
                        "data": base64.b64encode(chunk).decode("ascii"),
                    },
                    NATIVE_LENGTH,
                    MAX_NATIVE_MESSAGE_BYTES,
                )
                sequence += 1
            write_framed(
                sys.stdout.buffer,
                {
                    "protocol": PROTOCOL_NAME,
                    "version": PROTOCOL_VERSION,
                    "type": "request_end",
                    "id": request_id,
                    "chunks": sequence,
                },
                NATIVE_LENGTH,
                MAX_NATIVE_MESSAGE_BYTES,
            )

    def fail_pending(self, request_id: str, code: str, message: str) -> None:
        with self.pending_lock:
            pending = self.pending.get(request_id)
            if not pending or pending.event.is_set():
                return
            pending.result = response_error(request_id, code, message)
            pending.event.set()

    def fail_all(self, message: str) -> None:
        with self.pending_lock:
            for request_id, pending in self.pending.items():
                if not pending.event.is_set():
                    pending.result = response_error(request_id, "BROWSER_DISCONNECTED", message)
                    pending.event.set()

    def handle_native_response(self, message: dict[str, Any]) -> None:
        if message.get("protocol") != PROTOCOL_NAME or message.get("version") != PROTOCOL_VERSION:
            return
        request_id = message.get("id")
        if not isinstance(request_id, str):
            return
        with self.pending_lock:
            pending = self.pending.get(request_id)
            if not pending or pending.event.is_set():
                return

            message_type = message.get("type")
            if message_type == "response_error":
                error = message.get("error")
                if not isinstance(error, dict):
                    error = {"code": "PROTOCOL_ERROR", "message": "Browser returned an invalid error"}
                pending.result = {
                    "protocol": PROTOCOL_NAME,
                    "version": PROTOCOL_VERSION,
                    "type": "response",
                    "id": request_id,
                    "ok": False,
                    "error": error,
                }
                pending.event.set()
                return

            if message_type == "response_start":
                response = message.get("response")
                expected = message.get("body_bytes")
                if pending.response is not None or not isinstance(response, dict) or not isinstance(expected, int):
                    pending.result = response_error(request_id, "PROTOCOL_ERROR", "Invalid response_start message")
                    pending.event.set()
                elif expected < 0 or expected > MAX_RESPONSE_BYTES:
                    pending.result = response_error(request_id, "RESPONSE_TOO_LARGE", "Browser response is too large")
                    pending.event.set()
                else:
                    pending.response = response
                    pending.expected_bytes = expected
                return

            if message_type == "response_chunk":
                try:
                    if pending.response is None or message.get("sequence") != pending.next_sequence:
                        raise ValueError("Response chunks are missing or out of order")
                    data = message.get("data")
                    if not isinstance(data, str):
                        raise ValueError("Response chunk data is invalid")
                    chunk = base64.b64decode(data, validate=True)
                    pending.received_bytes += len(chunk)
                    if pending.received_bytes > pending.expected_bytes:
                        raise ValueError("Response is larger than declared")
                    pending.body.extend(chunk)
                    pending.next_sequence += 1
                except (ValueError, binascii.Error) as error:
                    pending.result = response_error(request_id, "PROTOCOL_ERROR", str(error))
                    pending.event.set()
                return

            if message_type == "response_end":
                if (
                    pending.response is None
                    or pending.received_bytes != pending.expected_bytes
                    or message.get("chunks") != pending.next_sequence
                ):
                    pending.result = response_error(
                        request_id, "PROTOCOL_ERROR", "Response length or chunk count does not match"
                    )
                else:
                    pending.result = {
                        "protocol": PROTOCOL_NAME,
                        "version": PROTOCOL_VERSION,
                        "type": "response",
                        "id": request_id,
                        "ok": True,
                        "response": {
                            **pending.response,
                            "body": {
                                "encoding": "base64",
                                "data": base64.b64encode(pending.body).decode("ascii"),
                            },
                        },
                    }
                pending.event.set()

    def native_reader(self) -> None:
        try:
            while not self.stop_event.is_set():
                message = read_framed(
                    sys.stdin.buffer,
                    NATIVE_LENGTH,
                    MAX_LOCAL_MESSAGE_BYTES,
                )
                self.handle_native_response(message)
        except EOFError:
            pass
        except Exception as error:
            print(f"browser-proxy-host: native input failed: {error}", file=sys.stderr)
        finally:
            self.stop_event.set()
            self.fail_all("Browser closed the native messaging connection")
            if self.server:
                try:
                    self.server.close()
                except OSError:
                    pass

    def decode_request(self, message: dict[str, Any]) -> tuple[str, dict[str, Any], bytes, float]:
        if (
            message.get("protocol") != PROTOCOL_NAME
            or message.get("version") != PROTOCOL_VERSION
            or message.get("type") != "request"
        ):
            raise ProtocolError("Unsupported local protocol envelope")
        request_id = message.get("id")
        request = message.get("request")
        if not isinstance(request_id, str) or not ID_PATTERN.fullmatch(request_id):
            raise ProtocolError("id must contain 1-128 safe ASCII characters")
        if not isinstance(request, dict):
            raise ProtocolError("request must be an object")
        body_value = request.get("body", {"encoding": "base64", "data": ""})
        if not isinstance(body_value, dict) or body_value.get("encoding") != "base64":
            raise ProtocolError("request.body must use base64 encoding")
        data = body_value.get("data")
        if not isinstance(data, str):
            raise ProtocolError("request.body.data must be a string")
        try:
            body = base64.b64decode(data, validate=True)
        except binascii.Error as error:
            raise ProtocolError("request body is not valid base64") from error
        if len(body) > MAX_REQUEST_BYTES:
            raise ProtocolError(f"request body exceeds {MAX_REQUEST_BYTES} bytes")
        timeout_ms = request.get("timeout_ms", 30000)
        if not isinstance(timeout_ms, int) or timeout_ms < 1 or timeout_ms > 300000:
            raise ProtocolError("timeout_ms must be an integer between 1 and 300000")
        return request_id, request, body, timeout_ms / 1000 + 5

    def handle_client(self, connection: socket.socket) -> None:
        request_id = "unknown"
        try:
            connection.settimeout(5)
            stream = connection.makefile("rwb", buffering=0)
            try:
                message = read_local(stream)
                request_id, request, body, wait_seconds = self.decode_request(message)
                pending = PendingResponse()
                with self.pending_lock:
                    if len(self.pending) >= 16:
                        raise ProtocolError("The native host has too many pending requests")
                    if request_id in self.pending:
                        raise ProtocolError("A request with this id is already pending")
                    self.pending[request_id] = pending
                try:
                    self.send_request(request_id, request, body)
                    connection.settimeout(wait_seconds + 1)
                    if not pending.event.wait(wait_seconds):
                        with self.pending_lock:
                            if not pending.event.is_set():
                                pending.result = response_error(
                                    request_id, "BROWSER_TIMEOUT", "Browser did not return a response in time"
                                )
                                pending.event.set()
                    with self.pending_lock:
                        result = pending.result
                    write_local(stream, result or response_error(request_id, "INTERNAL_ERROR", "No result"))
                finally:
                    with self.pending_lock:
                        self.pending.pop(request_id, None)
            finally:
                stream.close()
        except Exception as error:
            try:
                stream = connection.makefile("wb", buffering=0)
                write_local(stream, response_error(request_id, "HOST_PROTOCOL_ERROR", str(error)))
                stream.close()
            except Exception:
                pass
        finally:
            connection.close()
            self.client_slots.release()

    @staticmethod
    def reject_client(connection: socket.socket) -> None:
        try:
            stream = connection.makefile("wb", buffering=0)
            write_local(stream, response_error("unknown", "HOST_BUSY", "Too many local clients"))
            stream.close()
        except Exception:
            pass
        finally:
            connection.close()

    def prepare_socket(self) -> socket.socket:
        self.socket_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            self.socket_path.parent.chmod(0o700)
        except OSError:
            pass

        if self.socket_path.exists():
            probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                probe.settimeout(0.2)
                probe.connect(os.fspath(self.socket_path))
            except OSError:
                self.socket_path.unlink(missing_ok=True)
            else:
                raise RuntimeError(f"Another {self.browser} native host already owns {self.socket_path}")
            finally:
                probe.close()

        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(os.fspath(self.socket_path))
        try:
            self.socket_path.chmod(0o600)
        except OSError:
            pass
        server.listen(16)
        server.settimeout(0.5)
        self.server = server
        return server

    def run(self) -> int:
        server = self.prepare_socket()
        reader = threading.Thread(target=self.native_reader, name="native-reader", daemon=True)
        reader.start()
        try:
            while not self.stop_event.is_set():
                try:
                    connection, _ = server.accept()
                except socket.timeout:
                    continue
                except OSError:
                    break
                if not self.client_slots.acquire(blocking=False):
                    threading.Thread(
                        target=self.reject_client,
                        args=(connection,),
                        name="rejected-client",
                        daemon=True,
                    ).start()
                    continue
                threading.Thread(
                    target=self.handle_client,
                    args=(connection,),
                    name="local-client",
                    daemon=True,
                ).start()
        finally:
            self.stop_event.set()
            server.close()
            self.socket_path.unlink(missing_ok=True)
        return 0


def response_error(request_id: str, code: str, message: str) -> dict[str, Any]:
    return {
        "protocol": PROTOCOL_NAME,
        "version": PROTOCOL_VERSION,
        "type": "response",
        "id": request_id,
        "ok": False,
        "error": {"code": code, "message": message},
    }


def detect_browser(arguments: list[str]) -> str:
    for index, argument in enumerate(arguments):
        if argument == "--channel" and index + 1 < len(arguments):
            channel = arguments[index + 1]
            if channel in {"chrome", "firefox"}:
                return channel
        if argument.startswith("chrome-extension://"):
            return "chrome"
        if argument == FIREFOX_EXTENSION_ID:
            return "firefox"
    raise RuntimeError("Could not determine browser channel from native-messaging arguments")


def explicit_socket(arguments: list[str]) -> Path | None:
    for index, argument in enumerate(arguments):
        if argument == "--socket" and index + 1 < len(arguments):
            return Path(arguments[index + 1]).expanduser().resolve()
    return None


def main() -> int:
    try:
        if os.name == "nt":
            import msvcrt

            msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
            msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
        browser = detect_browser(sys.argv[1:])
        socket_path = explicit_socket(sys.argv[1:]) or default_socket_path(browser)
        host = NativeHost(browser, socket_path)

        def stop(_signum: int, _frame: Any) -> None:
            host.stop_event.set()
            if host.server:
                host.server.close()

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        return host.run()
    except Exception as error:
        print(f"browser-proxy-host: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
