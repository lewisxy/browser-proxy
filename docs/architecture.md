# Architecture

## Goals

Browser Proxy allows a local process to use an existing browser authentication session without exporting session cookies. Background Fetch is the default. Opt-in tab-context Fetch supports site-origin requirements and configurable CSRF handling within the constraints of browser Fetch and the destination site's defenses.

The design separates policy, browser authority, and local transport:

```text
custom app / browser-proxy CLI
        |
        | owner-only local socket, protocol v1 (buffered or streaming)
        v
Python native host
        |
        | browser native messaging, chunked JSON
        v
extension background
        |
        | Fetch API, credentials=include, redirect=manual (one authorized hop)
        v
allowlisted HTTP(S) origin
```

## Components

### Extension Background

`extension/common/background.js` owns all privileged behavior. It:

- Opens a long-lived native port named `com.browserproxy.native`.
- Reconnects when the host is installed or restarted.
- Reassembles bounded request chunks.
- Reads the allowlist directly from extension-local storage before every request and redirect hop.
- Validates the URL, method, headers, body size, timeout, and cache mode.
- Performs background `fetch()` with fixed credential and redirect policies.
- For tab requests, delegates each hop to an isolated, document-bound content script while retaining policy, redirect, timeout, and native transport ownership.
- For streaming downloads, uses a 384 KiB Fetch BYOB reader and waits for each downstream acknowledgement before reading more.
- For buffered requests, collects a response up to 32 MiB before chunking it to the host.
- Aborts active requests and discards their responses when their native port disconnects.

Chrome uses a Manifest V3 service worker. A live native port keeps the service worker associated with the host. Firefox uses a Manifest V2 persistent background script because an idle MV3 event page can close its native port and socket, leaving an external process with no way to wake it.

Content scripts are injected on demand only for tab requests. No page can call the privileged request handler: there is no `window.postMessage`, DOM-event, or main-world script bridge. Runtime messages exposed to extension pages only report status or request a native-host reconnect.

The toolbar popup receives temporary `activeTab` access when the user opens it. It reads only the active tab's origin, checks it with the same policy engine, and can append an exact origin rule through explicit user interaction. The settings page owns versioned JSON import/export; an import is fully parsed and normalized before replacing extension storage.

### Tab Context And CSRF

`tab-context.js` chooses a profile by exact API origin, then selects an explicit tab or prefers an exact application URL match followed by the most recently accessed same-origin nonprivate, nondiscarded tab. A missing tab can be created inactive and muted in an existing regular browser window. Selection/creation is serialized to avoid duplicate helpers; requests themselves remain concurrent. Helpers are reference-counted, limited to eight, and closed after 60 seconds idle. Activation relinquishes ownership, and pinned tabs are retained. Ownership is intentionally in-memory; reloads leave existing tabs untouched.

The `scripting` permission and existing host access authorize top-frame injection of `policy.js` and `tab-runner.js`. A runtime Port is bound to the selected document (including documentId when available). The runner has no page-visible command interface. Chrome uses isolated-world page-context Fetch; Firefox MV2 uses `content.fetch` instead of its extension-privileged Fetch. Every runner Fetch fixes credentials to include, redirects to manual, and referrer policy to strict-origin-when-cross-origin. The runner checks both application and destination origins against current storage immediately before Fetch. Service-worker-controlled documents fail closed because the worker could replace the request with unchecked network operations.

Page loads and the website's ordinary scripts/subresources are ordinary browsing activity, distinct from relay Fetches. After navigation, the runner requires the expected application origin. Loading, optional DOM readiness, token acquisition, hops, and download all share the original request deadline. Closing/navigating the document or disconnecting the native port cancels its work. There is no automatic foregrounding, request replay, or fallback to background Fetch.

Application-origin mismatches are diagnosed before injection with `TAB_ORIGIN_MISMATCH`, the expected/actual origins, and a freshly checked final-origin allowlist flag. A wildcard permission does not make sibling origins interchangeable: changing page context can change Origin, CORS, and CSRF source selection. The diagnostic recommends a canonical application/endpoint URL instead of assuming an authentication failure or suggesting that focusing the tab will help. Application-page navigation is distinct from the API redirect loop controlled by `-L`.

`tab-settings.js` validates declarative profiles saved only by extension UI. Profiles contain ordered cookie/DOM/bootstrap token sources, transforms, method filters, and header/form/JSON-field targets. Cookie access is limited to the page's own `document.cookie`; there is no cookies API permission. Bootstrap Fetches use the same tab/observer with a no-store GET, require allowlist authorization and a direct 2xx response, and cap JSON at 64 KiB. CSRF tokens are bounded to 4096 characters. Profile changes stop in-flight preparation; rules are applied to fresh copies of each hop's headers/body on the exact configured API origin, so derived secrets are not carried across origins or retained in redirect history. The original buffered upload remains available for the standard redirect method transformations. Generated bodies still obey the 16 MiB limit.

`tab-profile-editor.js` renders the settings-page profile/rule forms with common presets and collapsible advanced controls. Draft state is separate from storage; `options.js` persists only after form and shared-schema validation, and locks editing during a save/import. Imported version 1 profiles populate every supported control, preserving source/transform order, prefix whitespace, custom methods, and literal JSON path segments. Dynamic content uses DOM text/value setters, not HTML interpolation. JSON remains the import/export format; the execution schema and local protocol are unchanged by the editor.

The internal port protocol has sequential request/reply operations for readiness, source extraction, upload initialization/chunks, one Fetch, and pull-based body reads. Uploads and reads are base64 chunks of at most 384 KiB. The background exposes remote responses as byte streams with highWaterMark zero: there is no content-script read until the native output path asks for one, preserving downstream acknowledgements and bounded streaming. Redirect responses never obtain a body reader. Every logical request has its own port/controller; ports and observer listeners are disposed at completion.

### Policy Engine

`extension/common/policy.js` parses and matches origin rules. It is shared by the background and settings UI and is also tested directly under Node.

Rules have this grammar:

```text
(http|https|*)://(host|*.host|*)[:(1-65535|*)]
```

An omitted port means the default port for the matched scheme. `*.example.com` matches both `example.com` and its subdomains, but not `notexample.com`. A rule cannot contain a path, query, fragment, or credentials.

The policy checks the URL before Fetch. Every Fetch uses `redirect: "manual"`. Following requires client opt-in and the extension's `redirectsEnabled` setting, which starts false. `extension/common/redirects.js` controls the loop, checks the latest stored policy before each hop, applies HTTP method/body/header transformations, and caps the chain at 20 followed redirects. With opt-in, only the final response enters the buffered or streaming output path. Without opt-in, a redirect returns its original status and sanitized headers as a header-only response with `body_unavailable: true`. No target is requested or needs authorization in that case. The native host cannot enable the setting.

### Redirect Observation

`extension/common/redirect-observer.js` registers webRequest listeners before the native host connects. Manual Fetch usually returns an opaque response with no readable status, headers, or body. The observer captures redirect status, reason text, and a validated header snapshot from `onHeadersReceived`, with `onBeforeRedirect` as a fallback for browser-generated redirects. Set-Cookie and Set-Cookie2 are dropped before copying their values; the raw header array is never retained. Requests without client opt-in also use observation so their redirect headers can be returned, even with the UI setting off.

Every observed hop replaces its outgoing URL fragment with a fresh cryptographic UUID. The fragment is visible in browser webRequest events but is not sent over HTTP, does not modify path/query/headers/body, and does not change the HTTP cache key. Background events must identify this extension as initiator; tab events must match the selected tab, top frame, application initiator origin, and documentId when available. The initial URL/method/tag must match exactly before binding a browser request ID. Subsequent events use that binding. Tags are removed from fallback redirect metadata and browser-generated Location headers; public history uses the original URLs. Fresh tags avoid ambiguity for identical concurrent URLs, cache responses, aborted requests, and replacement native ports without serializing unrelated operations. Trackers are removed on success, failure, or abort; late events cannot match a new tag.

A response event may establish the same exact binding if the browser omits or delays onBeforeRequest. This still requires the appropriate initiating context, full tagged URL, and original method to match; an untagged URL or an event for a different method is insufficient.

Chrome uses passive webRequest observation. Firefox additionally uses a blocking onBeforeRequest listener to cancel unexpected URL/method rewrites of tagged requests, rather than letting the browser automatically advance them. Chrome HTTP-cache redirects and preloaded HSTS upgrades are tested as manually stopped, observable hops. If the browser omits required events, correlation is ambiguous, or it unexpectedly changes the final URL, the request fails closed with `REDIRECT_UNINSPECTABLE`. Missing events are given at most one second after Fetch returns, within the overall request deadline. There is no probe, replay, automatic-follow fallback, or redirect-body reading.

The loop retains a single buffered upload for 307/308 replay and occupies one logical concurrency slot. The one request deadline covers policy reads, all hops, metadata observation, final body reads, and streaming acknowledgements. Turning off redirects or revoking an origin stops subsequent hops, not requests already sent.

Unfollowed responses have a null internal body and an explicit unavailable-body marker, so neither output path obtains a redirect reader. Buffered transport sends an empty base64 body; streaming sends start, waits for its acknowledgement, then sends end with zero chunks/bytes. The server's Content-Length can remain in the headers but is not interpreted as a transport length. The existing metadata frame bound also applies to these snapshots. The CLI reports the omission on stderr except in silent/HEAD mode, while JSON clients receive the metadata flag.

### Native Host

`src/browser_proxy/native_host.py` is launched by the browser, not by the CLI. It derives the browser channel from Chrome's caller-origin argument or Firefox's add-on-ID argument and creates one socket:

- `.browser-proxy/run/chrome.sock`
- `.browser-proxy/run/firefox.sock`

When installed in this project's `.venv`, `.browser-proxy` is in the project root. `BROWSER_PROXY_RUNTIME_DIR` overrides the runtime directory for nonstandard deployments.

The socket directory is mode `0700` and the socket is mode `0600` on Unix-like systems. The host limits clients and pending requests to 16, validates local framing, chunks browser messages below the 1 MiB native-messaging limit, and removes stale sockets. Windows stdio is forced into binary mode.

The native host is deliberately a relay. It cannot read or update the allowlist and does not make HTTP requests itself.

Streaming responses use a one-message queue per request plus a terminal result slot. The native reader validates and enqueues messages without waiting for local socket I/O. Each local-client thread forwards a message, waits for the client's acknowledgement, then forwards that acknowledgement to the extension. A slow download therefore cannot build an unbounded queue or block the native reader from handling other responses. Client disconnection, invalid acknowledgements, and timeouts cancel the browser request.

### CLI

`src/browser_proxy/cli.py` translates curl-like arguments into protocol v1. It handles textual, JSON, binary, URL-encoded, and multipart bodies without third-party dependencies. Normal output uses `request_stream` and writes/flushes each decoded chunk before acknowledging it. `--response-json` uses the original bounded, buffered `request` mode. Response bodies remain bytes end to end.

## Credential Handling

The extension does not read cookies with a cookie API. It asks browser Fetch to include credentials. Consequently:

- HttpOnly cookies are usable but never visible to Python.
- Cookie selection, SameSite behavior, partitioning, expiry, and secure transport are enforced by the browser.
- `Cookie`, `Set-Cookie`, `Host`, `Content-Length`, `Connection`, `Transfer-Encoding`, `Upgrade`, proxy authorization, and `Sec-*` request headers are rejected.
- Fetch response headers exclude `Set-Cookie`; the response serializer also filters it explicitly. The redirect observer ignores cookie headers exposed by privileged webRequest events.
- Authorization is stripped on cross-origin redirects. Cookies are selected by the browser anew at each hop, including cookies set on intermediate responses.

An endpoint can still return sensitive information in its response body. That is the purpose and inherent authority of this proxy, so allowlists should be narrow.

## Security Boundaries

### Trusted

- The installed extension and checked-in native host code.
- Processes running as the same OS account, for purposes of local socket access.
- Origins explicitly entered by the user.

### Untrusted

- Native protocol and local socket input until validated.
- HTTP response bytes and headers.
- Redirect destinations.
- Web pages. They receive no interface to invoke the relay or change policy. Configured DOM/cookie token sources are treated as bounded input.

Socket permissions stop other OS users, not another process already running as the user. A same-user process can call the relay, and a sufficiently capable same-user attacker can replace a predictable Unix socket. Browser Proxy is not a sandbox against malware running under the user's account.

### Important Consequences

- Allowing `*://*` effectively gives all same-user applications browser-session request authority over every HTTP site.
- Background mode does not acquire CSRF tokens. Tab mode can acquire configured page-readable tokens; private application JavaScript request interceptors are not invoked.
- Host permission is broad at browser-install time because runtime origin policy is maintained independently in extension storage.
- Redirects require explicit enablement and every hop's authorization. Browser-restricted or unobservable redirects are rejected, even if the destination might be allowed.
- DNS resolution is left to the browser. An allowed hostname is trusted regardless of the address to which it resolves.

## Limits And Concurrency

| Item | Limit |
| --- | ---: |
| Request body | 16 MiB |
| Buffered response body | 32 MiB |
| Streamed response byte counter | 2^53 - 1 bytes |
| Request timeout | 300 seconds |
| Followed redirects | 20 per logical request |
| Concurrent extension requests | 16 |
| Buffered incoming request data | 32 MiB |
| Request headers | 128 |
| Header value | 4096 characters |
| Local framed message | 64 MiB |
| Streaming response frame / native message accepted by host | 1 MiB |
| Local acknowledgement frame | 1 KiB |
| Native chunk payload | 384 KiB before base64 |
| Unacknowledged streaming data | One chunk per request |

Requests and buffered responses are held in memory within their size caps. Streaming responses are read with fixed-size BYOB buffers and relayed incrementally, with no whole-body assembly in the extension, host, or CLI. Flow control bounds in-flight data even with slow consumers. Metadata and error frames remain bounded too. Streaming counts decoded bytes and checks final byte/chunk totals; it does not require or trust Content-Length to determine the total. Browser-managed network/cache buffers are controlled by the browser.

## Compatibility Limits

- Background mode uses the extension's cookie context. Tab mode uses the selected document's context; an explicit tab ID can identify an accessible container/private tab. Automatic tab selection excludes private tabs, and helper creation uses a regular window's default store. Browser profiles remain determined by the native-host channel.
- Browser privacy settings can block third-party or partitioned cookies even with `credentials: "include"`.
- Servers may reject the extension request's `Origin`/`Sec-Fetch-*` context or require page-derived CSRF tokens, client certificates, WebAuthn, or anti-bot challenges.
- Tab mode uses the application's request context but is subject to page CORS, background-tab lifecycle limits, and site-specific token formats. Service-worker-controlled documents are rejected to preserve redirect invariants.
- Fetch transparently handles compression and may normalize headers. It is not a raw TCP or byte-perfect HTTP client.
- HTTP authentication supplied by the user in an `Authorization` header is supported; interactive browser authentication prompts are not managed.

## Build Layout

Shared extension files live under `extension/common`. `tools/build_extension.py` creates:

- `dist/chrome` with a Manifest V3 service worker loader.
- `dist/firefox` with a persistent Manifest V2 background.

The distributions are generated and intentionally ignored by version control.
