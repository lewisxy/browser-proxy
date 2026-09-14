"""Native-messaging host that bridges browser ports to a local Unix socket."""

from __future__ import annotations

import base64
import binascii
import os
import queue
import re
import select
import signal
import socket
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .protocol import (
    LOCAL_LENGTH,
    MAX_CONTROL_MESSAGE_BYTES,
    MAX_STREAM_BODY_BYTES,
    MAX_STREAM_MESSAGE_BYTES,
    STREAM_CHUNK_BYTES,
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
NATIVE_CHUNK_BYTES = STREAM_CHUNK_BYTES
SOCKET_HANDOFF_SECONDS = 2
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
    streaming: bool = False
    messages: queue.Queue[dict[str, Any]] = field(default_factory=lambda: queue.Queue(maxsize=1))
    awaiting_ack: int | None = None


class NativeHost:
    def __init__(self, browser: str, socket_path: Path) -> None:
        self.browser = browser
        self.socket_path = socket_path
        self.stop_event = threading.Event()
        self.native_write_lock = threading.Lock()
        self.pending_lock = threading.Lock()
        self.server_lock = threading.Lock()
        self.pending: dict[str, PendingResponse] = {}
        self.server: socket.socket | None = None
        self.socket_identity: tuple[int, int] | None = None
        self.client_slots = threading.BoundedSemaphore(16)

    def native_message(self, message: dict[str, Any]) -> None:
        envelope = {"protocol": PROTOCOL_NAME, "version": PROTOCOL_VERSION, **message}
        with self.native_write_lock:
            write_framed(sys.stdout.buffer, envelope, NATIVE_LENGTH, MAX_NATIVE_MESSAGE_BYTES)

    def send_request(
        self, request_id: str, request: dict[str, Any], body: bytes, streaming: bool = False,
    ) -> None:
        metadata = {
            key: request[key]
            for key in ("url", "method", "headers", "timeout_ms", "cache", "follow_redirects", "max_redirects", "tab")
            if key in request
        }
        with self.native_write_lock:
            write_framed(
                sys.stdout.buffer,
                {
                    "protocol": PROTOCOL_NAME,
                    "version": PROTOCOL_VERSION,
                    "type": "tab_request_start" if "tab" in request else "request_start",
                    "id": request_id,
                    "request": metadata,
                    "body_bytes": len(body),
                    **({"stream_response": True} if streaming else {}),
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

            if pending.streaming:
                self.handle_stream_response(request_id, pending, message)
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

    def handle_stream_response(self, request_id: str, pending: PendingResponse, message: dict[str, Any]) -> None:
        """Called under pending_lock; never block the shared native reader."""
        try:
            if pending.awaiting_ack is not None:
                raise ValueError("Browser sent data before the previous acknowledgement")
            kind = message.get("type")
            if kind == "response_start" and pending.response is None:
                if message.get("body_bytes", -1) is not None or not isinstance(message.get("response"), dict):
                    raise ValueError("Browser does not support streaming responses; reload the extension")
                pending.response = message["response"]
                pending.awaiting_ack = -1
            elif kind == "response_chunk" and pending.response is not None:
                if type(message.get("sequence")) is not int or message["sequence"] != pending.next_sequence:
                    raise ValueError("Response chunks are missing or out of order")
                data = message.get("data")
                if not isinstance(data, str) or len(data) > 4 * (NATIVE_CHUNK_BYTES // 3):
                    raise ValueError("Response chunk exceeds the stream limit")
                chunk = base64.b64decode(data, validate=True)
                if not 0 < len(chunk) <= NATIVE_CHUNK_BYTES:
                    raise ValueError("Invalid response chunk size")
                pending.received_bytes += len(chunk)
                if pending.received_bytes > MAX_STREAM_BODY_BYTES:
                    raise ValueError("Response exceeds the streaming byte-count limit")
                pending.awaiting_ack = pending.next_sequence
                pending.next_sequence += 1
            elif kind == "response_end" and pending.response is not None:
                if (
                    type(message.get("chunks")) is not int or message["chunks"] != pending.next_sequence
                    or type(message.get("body_bytes")) is not int or message["body_bytes"] != pending.received_bytes
                ):
                    raise ValueError("Response length or chunk count does not match")
                pending.result = message
                pending.event.set()
                return
            else:
                raise ValueError("Unexpected streaming response message")
            pending.messages.put_nowait(message)
        except (ValueError, binascii.Error, queue.Full) as error:
            pending.result = response_error(request_id, "PROTOCOL_ERROR", str(error))
            pending.event.set()

    def native_reader(self) -> None:
        try:
            while not self.stop_event.is_set():
                message = read_framed(
                    sys.stdin.buffer,
                    NATIVE_LENGTH,
                    MAX_NATIVE_MESSAGE_BYTES,
                )
                self.handle_native_response(message)
        except EOFError:
            pass
        except Exception as error:
            print(f"browser-proxy-host: native input failed: {error}", file=sys.stderr)
        finally:
            self.stop_event.set()
            self.fail_all("Browser closed the native messaging connection")
            self.close_server()

    def decode_request(self, message: dict[str, Any]) -> tuple[str, dict[str, Any], bytes, float]:
        if (
            message.get("protocol") != PROTOCOL_NAME
            or message.get("version") != PROTOCOL_VERSION
            or message.get("type") not in ("request", "request_stream", "request_tab", "request_tab_stream")
        ):
            raise ProtocolError("Unsupported local protocol envelope")
        request_id = message.get("id")
        request = message.get("request")
        if not isinstance(request_id, str) or not ID_PATTERN.fullmatch(request_id):
            raise ProtocolError("id must contain 1-128 safe ASCII characters")
        if not isinstance(request, dict):
            raise ProtocolError("request must be an object")
        tab_mode = message["type"] in {"request_tab", "request_tab_stream"}
        if tab_mode != ("tab" in request) or tab_mode and not isinstance(request["tab"], dict):
            raise ProtocolError("Tab requests require a tab object and a request_tab/request_tab_stream envelope")
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

    def relay_stream(
        self, connection: socket.socket, stream: Any, request_id: str,
        pending: PendingResponse, wait_seconds: float,
    ) -> None:
        deadline = time.monotonic() + wait_seconds
        complete = False
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self.fail_pending(request_id, "BROWSER_TIMEOUT", "Streaming response exceeded its deadline")
                if pending.event.is_set():
                    with self.pending_lock:
                        event = dict(pending.result or response_error(request_id, "INTERNAL_ERROR", "No result"))
                    if event.get("type") == "response":
                        event["type"] = "response_error"
                        event.pop("ok", None)
                    connection.settimeout(max(0.1, remaining))
                    write_framed(stream, event, LOCAL_LENGTH, MAX_STREAM_MESSAGE_BYTES)
                    complete = event["type"] == "response_end"
                    return
                try:
                    event = pending.messages.get(timeout=min(0.1, max(0.001, remaining)))
                except queue.Empty:
                    # Detect a closed client even while Fetch is waiting for headers.
                    if select.select([connection], [], [], 0)[0]:
                        if not connection.recv(1, socket.MSG_PEEK):
                            raise EOFError("Local streaming client disconnected")
                        raise ProtocolError("Unexpected local stream data")
                    continue
                connection.settimeout(max(0.1, deadline - time.monotonic()))
                write_framed(stream, event, LOCAL_LENGTH, MAX_STREAM_MESSAGE_BYTES)
                ack = read_framed(stream, LOCAL_LENGTH, MAX_CONTROL_MESSAGE_BYTES)
                sequence = -1 if event["type"] == "response_start" else event["sequence"]
                if (
                    ack.get("protocol") != PROTOCOL_NAME or ack.get("version") != PROTOCOL_VERSION
                    or ack.get("type") != "response_ack" or ack.get("id") != request_id
                    or type(ack.get("sequence")) is not int or ack["sequence"] != sequence
                ):
                    raise ProtocolError("Invalid streaming response acknowledgement")
                with self.pending_lock:
                    if pending.event.is_set():
                        continue
                    pending.awaiting_ack = None
                self.native_message({"type": "response_ack", "id": request_id, "sequence": sequence})
        finally:
            if not complete:
                self.native_message({"type": "request_cancel", "id": request_id})

    def handle_client(self, connection: socket.socket) -> None:
        request_id = "unknown"
        streaming = False
        try:
            connection.settimeout(5)
            stream = connection.makefile("rwb", buffering=0)
            try:
                message = read_local(stream)
                streaming = message.get("type") in {"request_stream", "request_tab_stream"}
                request_id, request, body, wait_seconds = self.decode_request(message)
                pending = PendingResponse(streaming=streaming)
                with self.pending_lock:
                    if len(self.pending) >= 16:
                        raise ProtocolError("The native host has too many pending requests")
                    if request_id in self.pending:
                        raise ProtocolError("A request with this id is already pending")
                    self.pending[request_id] = pending
                try:
                    self.send_request(request_id, request, body, streaming)
                    if streaming:
                        self.relay_stream(connection, stream, request_id, pending, wait_seconds)
                        return
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
            print(f"browser-proxy-host: local client failed: {error}", file=sys.stderr)
            try:
                stream = connection.makefile("wb", buffering=0)
                code = "BROWSER_TIMEOUT" if streaming and isinstance(error, TimeoutError) else "HOST_PROTOCOL_ERROR"
                error_message = response_error(request_id, code, str(error))
                if streaming:
                    error_message["type"] = "response_error"
                    error_message.pop("ok", None)
                write_local(stream, error_message)
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

        handoff_deadline = time.monotonic() + SOCKET_HANDOFF_SECONDS
        while self.socket_path.exists():
            existing_stat = os.stat(self.socket_path, follow_symlinks=False)
            existing_identity = (existing_stat.st_dev, existing_stat.st_ino)
            probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                probe.settimeout(0.2)
                probe.connect(os.fspath(self.socket_path))
            except OSError:
                try:
                    current_stat = os.stat(self.socket_path, follow_symlinks=False)
                except FileNotFoundError:
                    break
                if (current_stat.st_dev, current_stat.st_ino) == existing_identity:
                    self.socket_path.unlink(missing_ok=True)
                    break
            else:
                if time.monotonic() >= handoff_deadline:
                    raise RuntimeError(f"Another {self.browser} native host already owns {self.socket_path}")
                time.sleep(0.05)
            finally:
                probe.close()

        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            server.bind(os.fspath(self.socket_path))
            socket_stat = os.stat(self.socket_path, follow_symlinks=False)
            socket_identity = (socket_stat.st_dev, socket_stat.st_ino)
            try:
                self.socket_path.chmod(0o600)
            except OSError:
                pass
            server.listen(16)
            server.settimeout(0.5)
        except Exception:
            server.close()
            self.socket_path.unlink(missing_ok=True)
            raise
        with self.server_lock:
            self.server = server
            self.socket_identity = socket_identity
        return server

    def close_server(self) -> None:
        with self.server_lock:
            server = self.server
            socket_identity = self.socket_identity
            self.server = None
            self.socket_identity = None
            if socket_identity is not None:
                try:
                    current_stat = os.stat(self.socket_path, follow_symlinks=False)
                    if (current_stat.st_dev, current_stat.st_ino) == socket_identity:
                        self.socket_path.unlink(missing_ok=True)
                except OSError:
                    pass
            if server is not None:
                try:
                    server.close()
                except OSError:
                    pass

    def run(self) -> int:
        server = self.prepare_socket()
        self.native_message({"type": "host_ready"})
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
            self.close_server()
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
            host.close_server()

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        return host.run()
    except Exception as error:
        print(f"browser-proxy-host: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
