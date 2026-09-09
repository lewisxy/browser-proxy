# Protocol Version 1

## Overview

There are two framed transports:

1. External applications use the local socket protocol.
2. The Python host uses native messaging with the extension.

Both use UTF-8 JSON objects containing:

```json
{
  "protocol": "browser-proxy",
  "version": 1,
  "type": "...",
  "id": "caller-selected-correlation-id"
}
```

IDs must contain 1 to 128 ASCII letters, digits, dots, underscores, colons, or hyphens. An ID must be unique while a request is pending.

## Local Socket Transport

The socket is an AF_UNIX stream. Each message is prefixed by one unsigned 32-bit **big-endian** length followed by exactly that many JSON bytes. One connection carries one request and one response, then closes. The maximum frame is 64 MiB.

Default endpoints are `<runtime>/chrome.sock` and `<runtime>/firefox.sock`. For this `.venv`, `<runtime>` is `<project>/.browser-proxy/run`. Set `BROWSER_PROXY_RUNTIME_DIR` for a custom deployment or let the CLI use `--socket`.

### Request

```json
{
  "protocol": "browser-proxy",
  "version": 1,
  "type": "request",
  "id": "b88c3949a7c3418fb8212772bf62a8d0",
  "request": {
    "url": "https://api.example.com/v1/items?limit=10",
    "method": "POST",
    "headers": [
      ["Accept", "application/json"],
      ["Content-Type", "application/json"]
    ],
    "body": {
      "encoding": "base64",
      "data": "eyJuYW1lIjoiQWRhIn0="
    },
    "timeout_ms": 30000,
    "cache": "default"
  }
}
```

Request fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `url` | yes | Absolute `http` or `https` URL without URL credentials |
| `method` | no | HTTP token, default `GET`; `CONNECT`, `TRACE`, and `TRACK` are rejected |
| `headers` | no | Array of string `[name, value]` pairs |
| `body` | no | Base64 object; defaults to empty; forbidden for `GET` and `HEAD` |
| `timeout_ms` | no | Integer from 1 through 300000; default 30000 |
| `cache` | no | `default`, `no-store`, `reload`, `no-cache`, or `force-cache` |

Clients cannot choose credentials, redirect mode, browser profile, or cookie store. Those are fixed browser-side policies.

### Successful Response

```json
{
  "protocol": "browser-proxy",
  "version": 1,
  "type": "response",
  "id": "b88c3949a7c3418fb8212772bf62a8d0",
  "ok": true,
  "response": {
    "status": 200,
    "status_text": "OK",
    "url": "https://api.example.com/v1/items?limit=10",
    "headers": [["content-type", "application/json"]],
    "body": {
      "encoding": "base64",
      "data": "eyJpZCI6MTIzfQ=="
    }
  }
}
```

HTTP statuses 400 and above are successful protocol responses. The CLI only maps them to exit status 22 when `--fail` or `--fail-with-body` is used.

### Error Response

```json
{
  "protocol": "browser-proxy",
  "version": 1,
  "type": "response",
  "id": "b88c3949a7c3418fb8212772bf62a8d0",
  "ok": false,
  "error": {
    "code": "ORIGIN_NOT_ALLOWED",
    "message": "The request origin is not in the extension allowlist"
  }
}
```

Common codes:

| Code | Source | Meaning |
| --- | --- | --- |
| `ORIGIN_NOT_ALLOWED` | extension | No allowlist rule matched |
| `INVALID_REQUEST` | extension | URL, method, headers, body, timeout, or chunks were invalid |
| `BUSY` | extension | Extension concurrency limit reached |
| `TIMEOUT` | extension | Fetch exceeded `timeout_ms` |
| `REQUEST_FAILED` | extension | Network, browser policy, CORS-like, or redirect failure |
| `RESPONSE_TOO_LARGE` | extension/host | Response exceeded 32 MiB |
| `HOST_PROTOCOL_ERROR` | host | Local envelope, body, or framing error |
| `HOST_BUSY` | host | Local client limit reached |
| `BROWSER_TIMEOUT` | host | Extension did not answer after its deadline |
| `BROWSER_DISCONNECTED` | host | Native messaging port closed |
| `PROTOCOL_ERROR` | host | Extension sent an invalid sequence |

New error codes may be added without a protocol version change. Clients should display unknown codes rather than treating them as success.

## Native Messaging Transport

Native messages use the browser-defined framing: an unsigned 32-bit length in **native byte order**, followed by UTF-8 JSON. The host never writes logs to stdout. The host-to-browser maximum is 1 MiB, so bodies are chunked at 384 KiB before base64 encoding.

Request sequence:

```text
request_start { request metadata, body_bytes }
request_chunk { sequence: 0, data: base64 }  repeated
request_end   { chunks: N }
```

Success sequence:

```text
response_start { response metadata, body_bytes }
response_chunk { sequence: 0, data: base64 } repeated
response_end   { chunks: N }
```

An error is one `response_error` message with an `error` object. Sequence numbers start at zero and must be contiguous. Declared byte and chunk counts must match. The native sequence is internal; custom local applications should implement only the local socket protocol.

## Custom Application Example

`examples/custom_client.py` is a minimal dependency-free client. A custom application should:

1. Connect to the browser-specific socket as the same OS user.
2. Generate a fresh ID.
3. send one big-endian length-prefixed request object.
4. Read one response frame and close.
5. Base64-decode the body only when `ok` is true.
6. Treat HTTP status separately from protocol success.

Applications must not attempt to provide a `Cookie` header. Login state belongs to the selected browser profile and is attached by Fetch after the extension's allowlist check.
