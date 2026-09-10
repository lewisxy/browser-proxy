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

The socket is an AF_UNIX stream. Each message is prefixed by one unsigned 32-bit **big-endian** length followed by exactly that many JSON bytes. One connection carries one request and its response, then closes. The original `request` mode returns one buffered response frame. The additive `request_stream` mode returns multiple response frames and requires acknowledgements. The request and buffered-response maximum frame is 64 MiB; streaming response frames are at most 1 MiB and acknowledgement frames at most 1 KiB.

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
| `REDIRECT_BLOCKED` | extension | The server returned a redirect; pass the final URL directly |
| `REQUEST_FAILED` | extension | Network, browser policy, or CORS-like failure |
| `RESPONSE_TOO_LARGE` | extension/host | Buffered response exceeded 32 MiB, or streaming byte counter exceeded its limit |
| `HOST_PROTOCOL_ERROR` | host | Local envelope, body, or framing error |
| `HOST_BUSY` | host | Local client limit reached |
| `BROWSER_TIMEOUT` | host | Extension did not answer after its deadline |
| `BROWSER_DISCONNECTED` | host | Native messaging port closed |
| `PROTOCOL_ERROR` | host | Extension sent an invalid sequence |

New error codes may be added without a protocol version change. Clients should display unknown codes rather than treating them as success.

## Streaming Response Mode

Send the same request envelope and fields as above, with **`"type": "request_stream"`**. Upload bodies remain base64 encoded and limited to 16 MiB. All stream frames use the common protocol/version/id envelope. Streaming is an additive version 1 feature: original `request` clients retain their single-frame responses and 32 MiB response cap. An older host rejects `request_stream`; clients must not silently fall back to buffering. The new host also rejects a buffered native response to a streaming request, prompting an extension reload.

The successful exchange is:

```text
host → client: response_start { response: {status, status_text, url, headers}, body_bytes: null }
client → host: response_ack   { sequence: -1 }
host → client: response_chunk { sequence: 0, data: base64 }
client → host: response_ack   { sequence: 0 }
              ...repeat chunks and acknowledgements...
host → client: response_end   { chunks: N, body_bytes: total_decoded_bytes }
```

- `response_start` contains the same metadata as the buffered response, without a `body` object. `body_bytes` is explicitly `null`; the total need not be known until EOF, even if the server supplies Content-Length.
- Each chunk contains **1 through 393216 bytes (384 KiB)** before base64 encoding. Sequence numbers are contiguous, starting at zero. Empty responses contain no chunks.
- The client must finish writing/consuming each chunk before acknowledging it. There is at most one unacknowledged data frame per request, including the start frame. No next chunk or end message may be sent until the previous acknowledgement. The start acknowledgement allows clients to open output files or reject HTTP errors before reading the body.
- The host forwards each acknowledgement to the extension, which waits before reading another bounded chunk from Fetch. Socket buffering alone is not the flow-control mechanism.
- `response_end` must match the received chunk and decoded byte counts. Counts are nonnegative integers bounded by JavaScript's safe-integer maximum, `2^53 - 1`. This replaces the 32 MiB body cap for streamed responses. EOF without a valid `response_end` is a failed, potentially partial transfer.
- Streaming frame lengths, chunk sizes, ordering, IDs, and counts must be validated before accepting the response. The host's queue holds at most one data frame per request, plus a terminal error/end result. Up to 16 requests may run concurrently.
- A `response_error { error: {code, message} }` may terminate the stream before or after response_start, including while an acknowledgement is outstanding. It requires no acknowledgement. Before response_start, clients must also accept the original `response {ok: false, error}` envelope used by host admission errors and older hosts; those errors may carry ID `unknown`.
- Closing the local connection cancels the download. Output failure or early termination should close the connection immediately. The host sends a native `request_cancel`, and the extension aborts Fetch and releases its reader and acknowledgement waiter. Pending responses from a disconnected native port never use a replacement port.
- `timeout_ms` retains its 30000 ms default and 300000 ms maximum. The extension's deadline includes Fetch, body reads, and downstream acknowledgement waits. The host adds its existing deadline grace period. Partial data already written cannot be retracted.

The Python `stream_local()` helper yields validated events with chunk `data` decoded to bytes. Advancing the iterator acknowledges the previous event; callers must write before advancing and close the iterator on early exit (for example, with `contextlib.closing`). The CLI uses streaming by default; `--response-json` intentionally uses the original buffered mode.

## Native Messaging Transport

Native messages use the browser-defined framing: an unsigned 32-bit length in **native byte order**, followed by UTF-8 JSON. The host never writes logs to stdout. The host-to-browser maximum is 1 MiB, so bodies are chunked at 384 KiB before base64 encoding. The host also limits incoming native frames to 1 MiB.

After its local socket is bound, listening, and owner-only, the host sends one `host_ready` message. The extension reports the native host as connected only after receiving this message from its current native port. This readiness message has no request ID and is internal to the extension-host lifecycle.

Request sequence:

```text
request_start { request metadata, body_bytes }
request_chunk { sequence: 0, data: base64 }  repeated
request_end   { chunks: N }
```

Buffered success sequence:

```text
response_start { response metadata, body_bytes }
response_chunk { sequence: 0, data: base64 } repeated
response_end   { chunks: N }
```

For a streaming request, the host adds `stream_response: true` to `request_start`. The extension uses the same response_start/chunk/end fields and acknowledgement sequence described in [Streaming Response Mode](#streaming-response-mode). Native `response_ack` messages carry the request ID and sequence, including `-1` for start. Native `request_cancel` carries only the request ID in addition to the common envelope. The extension validates controls against the current port and active request. An invalid acknowledgement aborts that request.

An error is one `response_error` message with an `error` object. Sequence numbers start at zero and must be contiguous. Declared byte and chunk counts must match. Custom local applications should implement only the local socket protocol.

## Custom Application Example

`examples/custom_client.py` is a minimal dependency-free client. A custom application should:

1. Connect to the browser-specific socket as the same OS user.
2. Generate a fresh ID.
3. send one big-endian length-prefixed request object.
4. Read one response frame and close.
5. Base64-decode the body only when `ok` is true.
6. Treat HTTP status separately from protocol success.

Applications must not attempt to provide a `Cookie` header. Login state belongs to the selected browser profile and is attached by Fetch after the extension's allowlist check.
