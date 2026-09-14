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

The socket is an AF_UNIX stream. Each message is prefixed by one unsigned 32-bit **big-endian** length followed by exactly that many JSON bytes. One connection carries one request and its response, then closes. The original `request` mode returns one buffered response frame. The additive `request_stream` mode returns multiple response frames and requires acknowledgements. Tab-context equivalents are `request_tab` and `request_tab_stream`. The request and buffered-response maximum frame is 64 MiB; streaming response frames are at most 1 MiB and acknowledgement frames at most 1 KiB.

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
| `follow_redirects` | no | Boolean, default `false`; requests allowlisted following only when enabled in extension UI |
| `max_redirects` | no | Integer from 0 through 20, default 20; maximum number of followed hops |
| `tab` | tab modes only | Required object for `request_tab`/`request_tab_stream`; forbidden in background request envelopes |

Clients cannot choose credentials, raw Fetch redirect mode, or browser profile. Background cookie selection is fixed; tab requests use the selected document's cookie context. `follow_redirects` is opt-in to the extension-controlled loop, not permission to follow unchecked redirects. The extension's `redirectsEnabled` setting is false by default, is writable only by extension UI, and is not a protocol request field.

### Tab-Context Requests

Tab execution is an additive protocol-v1 feature with **distinct message types** so an older host cannot strip tab options and accidentally execute a mutation in the background:

```json
{
  "protocol": "browser-proxy",
  "version": 1,
  "type": "request_tab_stream",
  "id": "tab-example",
  "request": {
    "url": "https://api.example.com/action",
    "method": "POST",
    "headers": [["Content-Type", "application/json"]],
    "body": {"encoding": "base64", "data": "e30="},
    "tab": {"profile": "work-app", "existing_only": true}
  }
}
```

`tab` fields (all optional; `{}` enables automatic selection):

| Field | Meaning |
| --- | --- |
| `url` | Absolute HTTP(S), credential-free application/bootstrap URL; maximum 16384 characters |
| `id` | Nonnegative safe-integer browser tab ID; selects this existing tab without navigation |
| `profile` | Saved profile name, 1–64 ASCII letters/digits/dots/underscores/hyphens; must match the exact initial API origin |
| `existing_only` | Boolean, default false; prohibit helper creation |
| `csrf` | Boolean, default true; enable the selected profile's CSRF rules |

Unknown tab fields are rejected. No inline profile, arbitrary JavaScript, cookie value, allowlist, or settings-update operation is accepted. Profiles are selected and normalized in the browser from extension-UI-owned `tabProfiles` storage. The [user guide](user-guide.md#tab-context-requests) specifies the profile format and selection heuristic. Both application and requested API/bootstrap origins must match the current allowlist. Explicit tab IDs can select an accessible container/private document; automatic selection excludes private/discarded tabs. Helper creation requires an existing regular window, uses `active: false`, and does not focus that window.

API requests, uploads, HTTP status handling, redirect opt-in, metadata sanitization, buffered limits, and streaming acknowledgements use the existing protocols. Tab selection/loading, readiness, CSRF acquisition, and transfer all share `timeout_ms`. Closing/navigating the document interrupts the request. Tab and CSRF errors never trigger a context fallback or automatic mutation retry.

Cookie/DOM/bootstrap-derived tokens remain inside browser-side processing. They are not sent to the native host, stored in redirect history, or included in diagnostics. Header/form/JSON targets are applied to a fresh copy of each hop, only on the configured exact API origin and methods; derived values are not carried across origins. Caller-supplied values at configured targets are replaced. Form/JSON rewriting stays within the 16 MiB upload limit. A profile change mid-request fails with `TAB_CONFIG_CHANGED`; allowlists are reread before each Fetch, including bootstrap GETs and final issuance in the content script.

Bootstrap GETs use include credentials, no-store cache, and manual redirects. They require a direct 2xx response; redirect bodies are never read, and redirect targets are never contacted for token acquisition. JSON is limited to 64 KiB and tokens to 4096 characters. Tab Fetch uses the application document's context with `strict-origin-when-cross-origin`, subject to normal page CORS. Service-worker-controlled documents are rejected because their workers can replace manual requests with unchecked network operations. Normal page loading/subresources are ordinary browsing, not proxied requests; execution after navigation requires the expected application origin.

An unexpected application-page origin returns `TAB_ORIGIN_MISMATCH` before injection, token acquisition, or API Fetch, even if an allowlist wildcard covers both origins. This also applies to an explicitly selected tab with a different origin. `follow_redirects` does not change this setup check. The error includes `expected_origin` and `actual_origin` (HTTP(S) origins, or null if unavailable) and boolean `actual_origin_allowed`, based on a fresh allowlist read. Messages report origins rather than page paths/queries/fragments and suggest using the final application/endpoint URL. `actual_origin_allowed` is diagnostic, not authorization to adopt another context. This replaces older builds' generic `TAB_INTERACTION_REQUIRED` for navigation-origin mismatches within v1; existing error framing is retained.

An older host rejects `request_tab`/`request_tab_stream`. The current host sends `tab_request_start` to the extension; an older extension ignores that start and may time out without issuing a Fetch. The host rejects `tab` in legacy request envelopes, and the extension rejects it in `request_start`. Upgrade all components together. Existing background clients and framing remain compatible; tests cover both tab response modes and the native/local type distinction.

### Unfollowed Redirect Responses

With `follow_redirects` false or omitted, an HTTP redirect is a successful response containing the original status, reason text (possibly empty), URL, and sanitized response headers. The extension never requests the Location target, so only the initial URL requires allowlist authorization. The extension UI setting controls following and is not required to inspect these headers.

Browser Fetch normally hides redirect bodies. The extension never reads a redirect body, including on browsers that expose a readable manual response. Instead, the response has **`body_unavailable: true`**, indicating omitted content rather than a known empty server body:

```json
{
  "protocol": "browser-proxy",
  "version": 1,
  "type": "response",
  "id": "unfollowed",
  "ok": true,
  "response": {
    "status": 302,
    "status_text": "Found",
    "url": "https://example.com/start",
    "headers": [["location", "https://other.example/end"], ["content-length", "123"]],
    "body_unavailable": true,
    "body": {"encoding": "base64", "data": ""}
  }
}
```

Buffered/native responses declare zero body bytes and contain no body chunks. Streaming `response_start` includes the same metadata flag and the existing `body_bytes: null`; after the start acknowledgement, `response_end` has `chunks: 0` and `body_bytes: 0`. Header Content-Length describes the server's body, not the omitted transport body. Clients must use the transport counts and `body_unavailable` flag rather than infer completeness from Content-Length. HEAD responses may also carry the flag; it does not assert that the server sent a body.

Set-Cookie and Set-Cookie2 are excluded before retaining header snapshots and again at serialization. Header names/values are validated and normalized using Headers; duplicate headers can be combined as with normal Fetch responses. Internal correlation fragments are excluded from URLs and Location headers. Relative Location values remain relative. Missing or ambiguous observation fails with `REDIRECT_UNINSPECTABLE`, and browser Fetch failures remain errors; neither case triggers a retry or automatic following.

This changes the default redirect result from `REDIRECT_BLOCKED` to a 3xx success within protocol v1, using an additive metadata field and the existing framing. Original clients can decode the empty transported body but must inspect `body_unavailable` to distinguish omitted content. Older extensions retain the old error response. Compatibility tests cover the metadata flag and zero-byte completion in both buffered and streaming modes through the relay.

### Redirect Following

These optional fields work with both `request` and `request_stream`. `follow_redirects: true` requests following; the UI setting must also be enabled, otherwise a redirect returns `REDIRECT_BLOCKED`. An older host omits the follow fields, causing a new extension to return an unfollowed response even if the original client requested following. An older extension ignores the fields and retains manual rejection. Update components together, and do not retry or fall back to unchecked following to compensate for an older component.

Each hop uses `credentials: "include"`, `redirect: "manual"`, and the requested cache mode. Before issuing each hop, including same-origin hops, the extension rereads the stored allowlist and (for subsequent hops) checks that redirects remain enabled. Disallowed redirect destinations produce `REDIRECT_NOT_ALLOWED` before being requested. The initial URL still produces `ORIGIN_NOT_ALLOWED` if disallowed. One `timeout_ms` deadline covers the complete chain, metadata observation, body transfer, and streaming acknowledgements.

Only 301/302/303/307/308 redirects are followed. 301/302 convert POST to GET; 303 converts methods other than GET/HEAD to GET. Method conversion removes the body and Content-Encoding, Content-Language, Content-Location, and Content-Type. 307/308 preserve the original caller body bytes and method; tab CSRF rules are reapplied to each applicable hop. Authorization is removed when the origin changes; other caller headers are retained subject to normal Fetch restrictions. Background requests use a no-referrer policy. Tab requests use the application document with strict-origin-when-cross-origin, never a previous redirect URL. The browser manages cookies separately for every hop. Relative targets are resolved against the current URL; targets must remain HTTP(S), credential-free, and at most 16384 characters.

The hop limit counts followed redirects, with at most 21 physical requests for the default limit of 20. A repeated URL alone does not terminate the chain because cookies can change between hops. A zero limit rejects the first redirect when following is requested and enabled. Redirect bodies are never read or streamed. Non-redirect 3xx responses (such as 300/304 or a readable 302 without Location) are returned normally regardless of the follow option. Normal readable responses omit `body_unavailable`.

Opaque manual responses require correlated browser metadata. Missing or ambiguous metadata fails with `REDIRECT_UNINSPECTABLE`; the extension never probes, automatically retries, or switches Fetch to automatic following to recover it. See [Architecture](architecture.md#redirect-observation) for event correlation.

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

After following one or more redirects, the final response metadata additionally contains:

```json
{
  "redirected": true,
  "redirects": [
    {"status": 302, "from": "https://example.com/start", "to": "https://api.example.com/result"}
  ]
}
```

With following enabled, `url`, `status`, `status_text`, `headers`, and `body` describe only the final response. The optional history is ordered, contains at most `max_redirects` entries, and is subject to the native metadata frame limit (excessive metadata returns `RESPONSE_TOO_LARGE`). These fields appear in streaming `response_start` as well as buffered responses. Internal correlation fragments and unsanitized observed response headers are never included.

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
| `REDIRECT_BLOCKED` | extension | Following was requested, but the extension setting was off or disabled during the chain (older extensions also reject unfollowed redirects) |
| `REDIRECT_NOT_ALLOWED` | extension | Redirect target is not allowlisted; details contain `hop` (1-based), `from_origin`, and `to_origin` |
| `REDIRECT_LIMIT_EXCEEDED` | extension | The requested maximum number of followed hops was reached |
| `REDIRECT_UNINSPECTABLE` | extension | Browser redirect metadata was missing, ambiguous, or indicated an unexpected automatic rewrite |
| `INVALID_REDIRECT` | extension | Target URL was malformed, too long, non-HTTP(S), or contained credentials |
| `REQUEST_FAILED` | extension | Network, browser policy, or CORS-like failure |
| `RESPONSE_TOO_LARGE` | extension/host | Buffered response exceeded 32 MiB, metadata exceeded its frame limit, or streaming byte counter exceeded its limit |
| `HOST_PROTOCOL_ERROR` | host | Local envelope, body, or framing error |
| `HOST_BUSY` | host | Local client limit reached |
| `BROWSER_TIMEOUT` | host | Extension did not answer after its deadline |
| `BROWSER_DISCONNECTED` | host | Native messaging port closed |
| `PROTOCOL_ERROR` | host | Extension sent an invalid sequence |
| `TAB_NOT_FOUND` / `TAB_NO_WINDOW` | extension | No eligible existing tab/window for the selected mode |
| `TAB_ORIGIN_MISMATCH` | extension | Explicit tab or loaded application did not match its expected origin; includes origin-only details (older builds used `TAB_INTERACTION_REQUIRED` for navigation changes) |
| `TAB_UNAVAILABLE` / `TAB_UNSUPPORTED` / `TAB_REQUEST_FAILED` | extension | Tab access, injection, page Fetch, or browser support failed |
| `TAB_CLOSED` / `TAB_NAVIGATED` | extension | Document connection closed or its origin changed |
| `TAB_SERVICE_WORKER` | extension | A controlling site service worker prevents enforcing the manual-hop policy |
| `TAB_CONFIG_INVALID` / `TAB_CONFIG_CHANGED` | extension | Invalid/ambiguous profile or configuration changed during the request |
| `TAB_PROTOCOL_ERROR` | extension | Invalid internal document-port sequence or message |
| `CSRF_TOKEN_UNAVAILABLE` / `CSRF_TOKEN_INVALID` / `CSRF_SOURCE_AMBIGUOUS` | extension | Missing, excessive, invalid, or ambiguous token; no token contents in the error |
| `CSRF_BODY_INVALID` / `CSRF_BODY_TOO_LARGE` / `CSRF_HEADERS_TOO_LARGE` | extension | Injection could not preserve body/header constraints |
| `CSRF_BOOTSTRAP_FAILED` / `CSRF_BOOTSTRAP_TOO_LARGE` | extension | Bootstrap was unsuccessful, redirected, invalid JSON, or exceeded 64 KiB |

New error codes may be added without a protocol version change. Clients should display unknown codes rather than treating them as success.

Observer-generated `REDIRECT_UNINSPECTABLE` errors may include boolean `request_observed`, `response_headers_observed`, `redirect_observed`, and `metadata_invalid` details to distinguish absent browser events from rejected metadata. `extension_events_observed` reports whether any events from the observer's owning context arrived during the Fetch (extension initiator for background mode, selected document for tab mode), including other concurrent requests; it does not authorize correlation. When no request event was bound, `web_request_permission` and `host_permission` may also report the existing browser grants. These diagnostics contain no request URLs or response headers and do not request permissions.

## Streaming Response Mode

Send the same request envelope and fields as above, with **`"type": "request_stream"`** (or **`"type": "request_tab_stream"`** and a `tab` object). Upload bodies remain base64 encoded and limited to 16 MiB. All stream frames use the common protocol/version/id envelope. Streaming is an additive version 1 feature: original `request` clients retain their single-frame responses and 32 MiB response cap. An older host rejects unsupported types; clients must not silently fall back to buffering or background execution. The new host also rejects a buffered native response to a streaming request, prompting an extension reload.

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

Tab requests replace **only** the initial type with `tab_request_start` and include the validated `tab` object in request metadata. Upload chunks/end, cancellations, and responses retain their existing types. This start-type distinction prevents an older extension from treating tab requests as background requests. Local-only settings fields are not forwarded by the native host.

Buffered success sequence:

```text
response_start { response metadata, body_bytes }
response_chunk { sequence: 0, data: base64 } repeated
response_end   { chunks: N }
```

For a streaming request, the host adds `stream_response: true` to `request_start` or `tab_request_start`. The extension uses the same response_start/chunk/end fields and acknowledgement sequence described in [Streaming Response Mode](#streaming-response-mode). Native `response_ack` messages carry the request ID and sequence, including `-1` for start. Native `request_cancel` carries only the request ID in addition to the common envelope. The extension validates controls against the current port and active request. An invalid acknowledgement aborts that request.

An error is one `response_error` message with an `error` object. Sequence numbers start at zero and must be contiguous. Declared byte and chunk counts must match. Custom local applications should implement only the local socket protocol.

## Custom Application Example

`examples/custom_client.py` is a minimal dependency-free client. A custom application should:

1. Connect to the browser-specific socket as the same OS user.
2. Generate a fresh ID.
3. send one big-endian length-prefixed request object.
4. Read one response frame and close.
5. When `ok` is true, inspect `response.body_unavailable` before treating the base64-decoded body as complete server content. An unavailable body is represented by zero transported bytes.
6. Treat HTTP status separately from protocol success.

Applications must not attempt to provide a `Cookie` header. Login state belongs to the selected browser profile and is attached by Fetch after the extension's allowlist check.
