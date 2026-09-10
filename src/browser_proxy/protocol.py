"""Shared framing and local protocol helpers."""

from __future__ import annotations

import base64
import binascii
import json
import os
import socket
import struct
import sys
from pathlib import Path
from typing import BinaryIO, Any, Iterator


PROTOCOL_NAME = "browser-proxy"
PROTOCOL_VERSION = 1
MAX_LOCAL_MESSAGE_BYTES = 64 * 1024 * 1024
MAX_STREAM_MESSAGE_BYTES = 1024 * 1024
MAX_CONTROL_MESSAGE_BYTES = 1024
STREAM_CHUNK_BYTES = 384 * 1024
MAX_STREAM_BODY_BYTES = 2**53 - 1
LOCAL_LENGTH = struct.Struct("!I")
NATIVE_LENGTH = struct.Struct("@I")


class ProtocolError(Exception):
    """Raised when a peer sends an invalid frame or message."""


def runtime_root() -> Path:
    override = os.environ.get("BROWSER_PROXY_RUNTIME_DIR")
    if override:
        return Path(override).expanduser().resolve()
    if sys.prefix != sys.base_prefix:
        return Path(sys.prefix).resolve().parent / ".browser-proxy" / "run"
    return Path.home() / ".browser-proxy" / "run"


def default_socket_path(browser: str) -> Path:
    if browser not in {"chrome", "firefox"}:
        raise ValueError(f"Unsupported browser: {browser}")
    return runtime_root() / f"{browser}.sock"


def _read_exact(stream: BinaryIO, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            raise EOFError("Peer closed the connection")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_framed(stream: BinaryIO, length_struct: struct.Struct, maximum: int) -> dict[str, Any]:
    header = _read_exact(stream, length_struct.size)
    (length,) = length_struct.unpack(header)
    if length <= 0 or length > maximum:
        raise ProtocolError(f"Message length {length} is outside the allowed range")
    payload = _read_exact(stream, length)
    try:
        message = json.loads(
            payload,
            parse_constant=lambda value: (_ for _ in ()).throw(
                ProtocolError(f"Non-standard JSON constant is not allowed: {value}")
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProtocolError("Message is not valid UTF-8 JSON") from error
    if not isinstance(message, dict):
        raise ProtocolError("Message must be a JSON object")
    return message


def write_framed(
    stream: BinaryIO,
    message: dict[str, Any],
    length_struct: struct.Struct,
    maximum: int,
) -> None:
    payload = json.dumps(
        message,
        ensure_ascii=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    if not payload or len(payload) > maximum:
        raise ProtocolError(f"Encoded message is {len(payload)} bytes; maximum is {maximum}")
    frame = memoryview(length_struct.pack(len(payload)) + payload)
    offset = 0
    while offset < len(frame):
        written = stream.write(frame[offset:])
        if written is None or written <= 0:
            raise OSError("Peer closed the connection while writing")
        offset += written
    stream.flush()


def read_local(stream: BinaryIO) -> dict[str, Any]:
    return read_framed(stream, LOCAL_LENGTH, MAX_LOCAL_MESSAGE_BYTES)


def write_local(stream: BinaryIO, message: dict[str, Any]) -> None:
    write_framed(stream, message, LOCAL_LENGTH, MAX_LOCAL_MESSAGE_BYTES)


def exchange_local(
    message: dict[str, Any],
    socket_path: Path,
    connect_timeout: float,
    response_timeout: float,
) -> dict[str, Any]:
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        client.settimeout(connect_timeout)
        client.connect(os.fspath(socket_path))
        client.settimeout(response_timeout)
        stream = client.makefile("rwb", buffering=0)
        try:
            write_local(stream, message)
            return read_local(stream)
        finally:
            stream.close()
    finally:
        client.close()


def stream_local(
    message: dict[str, Any],
    socket_path: Path,
    connect_timeout: float,
    response_timeout: float,
) -> Iterator[dict[str, Any]]:
    """Yield validated stream events, decoding one body chunk at a time.

    Advancing the iterator acknowledges the previous event. Consumers must
    finish writing that chunk before advancing, and close the iterator on an
    early exit (including output errors) to cancel the browser request.
    """
    request_id = message["id"]
    started = False
    sequence = 0
    total = 0
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(connect_timeout)
        client.connect(os.fspath(socket_path))
        client.settimeout(response_timeout)
        with client.makefile("rwb", buffering=0) as stream:
            write_local(stream, message)
            while True:
                event = read_framed(stream, LOCAL_LENGTH, MAX_STREAM_MESSAGE_BYTES)
                if (
                    event.get("protocol") != PROTOCOL_NAME
                    or event.get("version") != PROTOCOL_VERSION
                    or (event.get("id") != request_id and (started or event.get("id") != "unknown"))
                ):
                    raise ProtocolError("Invalid streaming response envelope")
                kind = event.get("type")
                # Older hosts and admission failures use the original error envelope.
                if kind == "response_error" or (not started and kind == "response" and event.get("ok") is False):
                    if not isinstance(event.get("error"), dict):
                        raise ProtocolError("Invalid streaming error")
                    yield event
                    return
                if event.get("id") != request_id:
                    raise ProtocolError("Streaming response id does not match")
                if kind == "response_start" and not started:
                    if event.get("body_bytes", -1) is not None or not isinstance(event.get("response"), dict):
                        raise ProtocolError("Expected a streaming response_start")
                    started = True
                    ack = -1
                elif kind == "response_chunk" and started:
                    if type(event.get("sequence")) is not int or event["sequence"] != sequence:
                        raise ProtocolError("Response chunks are missing or out of order")
                    data = event.get("data")
                    if not isinstance(data, str) or len(data) > 4 * (STREAM_CHUNK_BYTES // 3):
                        raise ProtocolError("Response chunk exceeds the stream limit")
                    try:
                        chunk = base64.b64decode(data, validate=True)
                    except (ValueError, binascii.Error) as error:
                        raise ProtocolError("Invalid response chunk encoding") from error
                    if not 0 < len(chunk) <= STREAM_CHUNK_BYTES:
                        raise ProtocolError("Invalid response chunk size")
                    total += len(chunk)
                    if total > MAX_STREAM_BODY_BYTES:
                        raise ProtocolError("Response exceeds the stream byte-count limit")
                    event = {**event, "data": chunk}
                    ack = sequence
                    sequence += 1
                elif kind == "response_end" and started:
                    if (
                        type(event.get("chunks")) is not int or event["chunks"] != sequence
                        or type(event.get("body_bytes")) is not int or event["body_bytes"] != total
                    ):
                        raise ProtocolError("Response length or chunk count does not match")
                    yield event
                    return
                else:
                    raise ProtocolError("Unexpected streaming response message")
                yield event
                write_framed(stream, {
                    "protocol": PROTOCOL_NAME, "version": PROTOCOL_VERSION,
                    "type": "response_ack", "id": request_id, "sequence": ack,
                }, LOCAL_LENGTH, MAX_CONTROL_MESSAGE_BYTES)
