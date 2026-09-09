"""Shared framing and local protocol helpers."""

from __future__ import annotations

import json
import os
import socket
import struct
import sys
from pathlib import Path
from typing import BinaryIO, Any


PROTOCOL_NAME = "browser-proxy"
PROTOCOL_VERSION = 1
MAX_LOCAL_MESSAGE_BYTES = 64 * 1024 * 1024
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
    stream.write(length_struct.pack(len(payload)))
    stream.write(payload)
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
