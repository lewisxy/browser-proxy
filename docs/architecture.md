# Architecture

## Goals

Browser Proxy allows a local process to use an existing browser authentication session without exporting cookies or opening a request tab. It is site-independent within the constraints of the browser Fetch API and the destination site's own defenses.

The design separates policy, browser authority, and local transport:

```text
custom app / browser-proxy CLI
        |
        | owner-only local socket, protocol v1
        v
Python native host
        |
        | browser native messaging, chunked JSON
        v
extension background
        |
        | Fetch API, credentials=include, redirect=error
        v
allowlisted HTTP(S) origin
```

## Components

### Extension Background

`extension/common/background.js` owns all privileged behavior. It:

- Opens a long-lived native port named `com.browserproxy.native`.
- Reconnects when the host is installed or restarted.
- Reassembles bounded request chunks.
- Reads the allowlist directly from extension-local storage for every request.
- Validates the URL, method, headers, body size, timeout, and cache mode.
- Performs background `fetch()` with fixed credential and redirect policies.
- Streams and bounds the response before chunking it to the host.
- Aborts active requests and discards their responses when their native port disconnects.

Chrome uses a Manifest V3 service worker. A live native port keeps the service worker associated with the host. Firefox uses a Manifest V2 persistent background script because an idle MV3 event page can close its native port and socket, leaving an external process with no way to wake it.

No content scripts are installed. No page can call the privileged request handler. Runtime messages exposed to extension pages only report status or request a native-host reconnect.

The toolbar popup receives temporary `activeTab` access when the user opens it. It reads only the active tab's origin, checks it with the same policy engine, and can append an exact origin rule through explicit user interaction. The settings page owns versioned JSON import/export; an import is fully parsed and normalized before replacing extension storage.

### Policy Engine

`extension/common/policy.js` parses and matches origin rules. It is shared by the background and settings UI and is also tested directly under Node.

Rules have this grammar:

```text
(http|https|*)://(host|*.host|*)[:(1-65535|*)]
```

An omitted port means the default port for the matched scheme. `*.example.com` matches both `example.com` and its subdomains, but not `notexample.com`. A rule cannot contain a path, query, fragment, or credentials.

The policy checks the URL before Fetch. Fetch uses `redirect: "error"`, so there is no redirect request that could bypass the initial-origin decision.

### Native Host

`src/browser_proxy/native_host.py` is launched by the browser, not by the CLI. It derives the browser channel from Chrome's caller-origin argument or Firefox's add-on-ID argument and creates one socket:

- `.browser-proxy/run/chrome.sock`
- `.browser-proxy/run/firefox.sock`

When installed in this project's `.venv`, `.browser-proxy` is in the project root. `BROWSER_PROXY_RUNTIME_DIR` overrides the runtime directory for nonstandard deployments.

The socket directory is mode `0700` and the socket is mode `0600` on Unix-like systems. The host limits clients and pending requests to 16, validates local framing, chunks browser messages below the 1 MiB native-messaging limit, and removes stale sockets. Windows stdio is forced into binary mode.

The native host is deliberately a relay. It cannot read or update the allowlist and does not make HTTP requests itself.

### CLI

`src/browser_proxy/cli.py` translates curl-like arguments into protocol v1. It handles textual, JSON, binary, URL-encoded, and multipart bodies without third-party dependencies. Response bodies remain bytes end to end.

## Credential Handling

The extension does not read cookies with a cookie API. It asks browser Fetch to include credentials. Consequently:

- HttpOnly cookies are usable but never visible to Python.
- Cookie selection, SameSite behavior, partitioning, expiry, and secure transport are enforced by the browser.
- `Cookie`, `Set-Cookie`, `Host`, `Content-Length`, `Connection`, `Transfer-Encoding`, `Upgrade`, proxy authorization, and `Sec-*` request headers are rejected.
- Fetch does not expose `Set-Cookie` response headers to extension JavaScript.

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
- Web pages. They receive no content-script bridge.

Socket permissions stop other OS users, not another process already running as the user. A same-user process can call the relay, and a sufficiently capable same-user attacker can replace a predictable Unix socket. Browser Proxy is not a sandbox against malware running under the user's account.

### Important Consequences

- Allowing `*://*` effectively gives all same-user applications browser-session request authority over every HTTP site.
- CSRF protections based only on cookies may be satisfied. CSRF tokens stored in page DOM or JavaScript are not automatically available.
- Host permission is broad at browser-install time because runtime origin policy is maintained independently in extension storage.
- Redirects are unavailable, including safe same-origin redirects, because cross-browser Fetch cannot inspect and authorize every target before it is contacted.
- DNS resolution is left to the browser. An allowed hostname is trusted regardless of the address to which it resolves.

## Limits And Concurrency

| Item | Limit |
| --- | ---: |
| Request body | 16 MiB |
| Response body | 32 MiB |
| Request timeout | 300 seconds |
| Concurrent extension requests | 16 |
| Buffered incoming request data | 32 MiB |
| Request headers | 128 |
| Header value | 4096 characters |
| Local framed message | 64 MiB |
| Native chunk payload | 384 KiB before base64 |

Requests and responses are held in memory. These limits keep each native JSON message below browser limits and cap accidental memory growth.

## Compatibility Limits

- The request uses the browser profile and cookie store in which the extension runs. Firefox containers, private windows, and Chrome incognito stores are not selectable.
- Browser privacy settings can block third-party or partitioned cookies even with `credentials: "include"`.
- Servers may reject the extension request's `Origin`/`Sec-Fetch-*` context or require page-derived CSRF tokens, client certificates, WebAuthn, or anti-bot challenges.
- Fetch transparently handles compression and may normalize headers. It is not a raw TCP or byte-perfect HTTP client.
- HTTP authentication supplied by the user in an `Authorization` header is supported; interactive browser authentication prompts are not managed.

## Build Layout

Shared extension files live under `extension/common`. `tools/build_extension.py` creates:

- `dist/chrome` with a Manifest V3 service worker loader.
- `dist/firefox` with a persistent Manifest V2 background.

The distributions are generated and intentionally ignored by version control.
