#!/usr/bin/env python3
"""Minimal Browser Proxy protocol v1 client."""

from __future__ import annotations

import base64
import json
import socket
import struct
import sys
import uuid
from pathlib import Path


def read_exact(stream, length: int) -> bytes:
    result = bytearray()
    while len(result) < length:
        chunk = stream.read(length - len(result))
        if not chunk:
            raise EOFError("relay closed before completing the response")
        result.extend(chunk)
    return bytes(result)


def main() -> int:
    if len(sys.argv) != 3:
        print(f"usage: {sys.argv[0]} SOCKET URL", file=sys.stderr)
        return 2

    message = {
        "protocol": "browser-proxy",
        "version": 1,
        "type": "request",
        "id": uuid.uuid4().hex,
        "request": {
            "url": sys.argv[2],
            "method": "GET",
            "headers": [["Accept", "application/json"]],
            "body": {"encoding": "base64", "data": ""},
            "timeout_ms": 30000,
            "cache": "default",
        },
    }
    payload = json.dumps(message, separators=(",", ":")).encode()

    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.connect(str(Path(sys.argv[1]).expanduser()))
    with client, client.makefile("rwb", buffering=0) as stream:
        stream.write(struct.pack("!I", len(payload)) + payload)
        (length,) = struct.unpack("!I", read_exact(stream, 4))
        response = json.loads(read_exact(stream, length))

    if not response["ok"]:
        print(f"{response['error']['code']}: {response['error']['message']}", file=sys.stderr)
        return 1
    if response["response"].get("body_unavailable"):
        print(f"HTTP {response['response']['status']}: redirect not followed; response body unavailable", file=sys.stderr)
    sys.stdout.buffer.write(base64.b64decode(response["response"]["body"]["data"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
