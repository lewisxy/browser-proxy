# User Guide

## Installation And Browser IDs

Build and install the Python package first:

```sh
python3 -m venv .venv
.venv/bin/pip install -e .
.venv/bin/python tools/build_extension.py
```

The native manifest authorizes one exact extension ID. Defaults are:

- Chrome: `gkldokmonobnekdblegmdbfjmjeghdjh`
- Firefox: `browser-proxy@local.invalid`

If a packaged or signed build has a different ID, install its manifest with:

```sh
.venv/bin/browser-proxy-install --browser chrome --extension-id ACTUAL_ID
.venv/bin/browser-proxy-install --browser firefox --extension-id ACTUAL_ID
```

Restart the extension or click **Reconnect native host** after changing a host manifest.

The helper installs user-level registrations in standard Google Chrome and Firefox locations on macOS and Linux, and uses HKCU on Windows. Chromium, Chrome for Testing, vendor-specific channels, and a Chrome process with a custom `--user-data-dir` can use a different `NativeMessagingHosts` directory. In that case, use the JSON printed by `browser-proxy-install --browser chrome --dry-run` and place it in that browser profile's `NativeMessagingHosts` directory.

## Configure Origins

Open Browser Proxy settings from the extension's toolbar popup or browser extension manager. The allowlist starts empty.

Examples:

```text
https://api.example.com
https://api.example.com:8443
https://*.example.org
*://intranet.example.net
http://localhost:*
```

Rules have no path. If `https://api.example.com` is allowed, every path at that default-port origin is allowed. An omitted port means `443` for HTTPS and `80` for HTTP. A `*` scheme means HTTP or HTTPS; a `*` port means any port. A subdomain wildcard also matches the base host.

Avoid `*://*`. Prefer HTTPS and exact hosts and ports. Remove rules when an integration no longer needs them.

### Current Tab Shortcut

Open the toolbar popup while viewing an HTTP or HTTPS page. It displays only the page's origin, not its path, and reports whether any saved rule matches it. If the origin is not allowed, click **Allow this origin** to append an exact scheme, hostname, and port rule.

Browser-internal pages such as `about:`, `chrome:`, extension pages, and local files cannot be proxied and do not offer the add action.

### Import And Export

The settings page can export the currently saved list to `browser-proxy-allowlist.json`. Import validates the complete file, replaces the current list, and saves it atomically. A malformed file does not change existing settings.

The version 1 format is:

```json
{
  "format": "browser-proxy-allowlist",
  "version": 1,
  "allowlist": [
    "https://api.example.com",
    "https://*.example.org",
    "http://localhost:*"
  ]
}
```

Import files are limited to 1 MiB and 1000 rules. Rules are normalized and duplicates are removed during import and export.

### Redirects

Without `-L` / `--location`, Browser Proxy returns a redirect's original HTTP status and sanitized response headers, including `Location`, without contacting the destination. Only the initial origin needs to be allowlisted; a Location value is data, not authorization to request it. This works even when **Enable redirects** is off.

```sh
browser-proxy -i https://example.com/start
browser-proxy -I https://example.com/start
browser-proxy -D headers.txt -o body.bin https://example.com/start
browser-proxy --response-json https://example.com/start
```

An unfollowed redirect exits with status 0, including with `--fail`. Unlike curl, browser Fetch does not expose the redirect's HTML/text body. Browser Proxy sends zero body bytes and marks the response `body_unavailable: true`. This means the body was omitted, not that the server necessarily sent an empty body. `-i`, `-I`, and `-D` display the headers; normal body-only output is empty. A response Content-Length header describes the server's response, not the number of bytes Browser Proxy returns.

For non-HEAD requests, the CLI prints a notice on stderr explaining the unavailable body. `-s` suppresses this informational notice (including with `-S`); `-v` shows it. `--response-json` exposes the flag directly without the notice. No placeholder content or synthetic HTTP header is added. Set-Cookie and Set-Cookie2 are excluded from the returned headers.

The **Enable redirects** checkbox in extension settings is off by default and saves immediately. Enabling it permits applications to request redirect following with `-L` / `--location`:

```sh
browser-proxy -L https://example.com/start
browser-proxy -L --max-redirs 5 -o download.bin https://example.com/download
```

Both the checkbox and `-L` are required to follow redirects. With `-L` and the checkbox off, a redirect still produces `REDIRECT_BLOCKED`. Every followed destination must match the latest allowlist, including intermediate destinations and same-origin hops. For example, following a redirect from `https://google.com` to `https://www.google.com` requires both origins. Following HTTPS upgrades also requires an HTTPS rule; an HTTP rule alone does not authorize HTTPS.

Disabling redirects or removing an origin takes effect before the next hop of an in-progress chain. Requests already sent cannot be undone. Allowlist import/export transfers only origin rules and does not change the redirect checkbox. Local applications cannot change either setting.

`--max-redirs` accepts 0 through 20, defaults to 20, and counts followed redirects (not the initial request). Zero rejects the first redirect when following is enabled. One `--max-time` deadline covers the entire chain, redirect inspection, final download, and output acknowledgements.

Supported redirect statuses are 301, 302, 303, 307, and 308. POST changes to GET for 301/302; 303 changes methods other than GET/HEAD to GET. Those changes discard the body and body-related headers, including Content-Type. 307/308 preserve the method and exact body bytes. These rules also apply when `-X` explicitly specified the method, unlike some curl behaviors. Authorization is removed on an origin change and is never restored later in the chain. Other caller-supplied headers are retained; this includes custom API-key headers, so only allow destinations to which those headers may be sent.

Each hop is a separate credentialed browser Fetch with automatic redirects disabled. Cookies (including cookies set on intermediate or unfollowed responses) stay browser-managed. Requests use a no-referrer policy, and the browser's Origin, SameSite, and other request-context behavior can differ from a browser navigation or a single automatically followed Fetch. HTML/JavaScript redirects and meta refresh are not followed. Non-redirect 3xx responses, such as 300/304 or a readable 302 without Location, are ordinary HTTP responses regardless of `-L`.

With `-L`, only the final response headers and body are output, including with `-i` or `-D`. `--response-json` also includes `redirected: true` and a bounded `redirects` history when hops were followed. Intermediate response bodies and Set-Cookie headers are not returned.

Redirect inspection requires the browser to expose correlated `webRequest` events. Chrome's HTTP-cache redirects and preloaded HSTS upgrades are covered by the integration test. A missing or ambiguous event (for example, a browser-restricted URL or unobservable cache response) produces `REDIRECT_UNINSPECTABLE`, with no automatic retry of the request. Firefox additionally cancels unexpected automatic internal rewrites; use the final URL if the browser cannot expose a manually controlled hop.

After upgrading, rebuild/reload the extension to grant its webRequest permission (also webRequestBlocking on Firefox), then reconnect the native host. Older extensions return `REDIRECT_BLOCKED` instead of unfollowed response headers. Older clients can consume the response frames, but should be updated to recognize `body_unavailable` rather than mistake omitted content for a genuinely empty body. Update the host too: a host predating redirect support omits the follow flag, so even a request with `-L` can arrive at the extension as an unfollowed request.

## CLI Requests

Select Chrome by default or pass `--browser firefox`.

### Methods And Headers

```sh
browser-proxy -X PATCH \
  -H "Accept: application/json" \
  -H "If-Match: abc123" \
  --json '{"enabled":true}' \
  https://api.example.com/resource/7
```

`-d`, `--json`, and `-F` imply POST unless `-X` overrides it. `-I` sends HEAD. `-H @headers.txt` reads one header per line.

The browser controls `Cookie`, `Host`, message-length, connection, proxy, and `Sec-*` headers. User-agent and referrer behavior can also be normalized or restricted by Fetch.

### Bodies

```sh
browser-proxy -d "name=Ada" -d "role=admin" URL
browser-proxy --data-urlencode "query=two words" URL
browser-proxy --data-binary @archive.bin URL
browser-proxy --json @request.json URL
browser-proxy -F "description=report" -F "document=@report.pdf;type=application/pdf" URL
```

Use `@-` with data options to read stdin. Request bodies are limited to 16 MiB.

### Query Parameters

```sh
browser-proxy -G --data-urlencode "q=two words" https://api.example.com/search
browser-proxy --url-query "page=2" --url-query "sort=created desc" URL
```

### Output And Errors

```sh
browser-proxy -i URL
browser-proxy -D headers.txt -o body.bin URL
browser-proxy --fail-with-body URL
browser-proxy --response-json URL
browser-proxy -v URL
```

`-v` prints only caller-supplied request headers and explicitly notes that browser cookies are hidden. Response bodies are written as bytes and normally streamed as they arrive.

### Streaming Downloads

Normal CLI requests stream responses to stdout or `-o FILE`, including binary files larger than 32 MiB:

```sh
browser-proxy --max-time 300 -o archive.zip https://api.example.com/archive.zip
browser-proxy https://api.example.com/export | another-program
```

The extension reads at most 384 KiB at a time using a Fetch BYOB (bring-your-own-buffer) reader. Each chunk travels through native messaging and the local socket. The CLI writes and flushes it before acknowledging it; the extension waits for that acknowledgement before reading more. The native host keeps a bounded queue per download, and a stalled download does not block its shared response reader. Application-managed response memory is bounded independently of total file size, including when stdout is a slow pipe.

Both known-length and unknown-length responses are supported. The browser handles decompression; streamed byte counts describe the decoded bytes actually written. Streaming uses counters capped at `2^53 - 1` bytes, rather than the buffered mode's 32 MiB body cap. The existing 16-request concurrency limit still applies.

The request timeout defaults to 30 seconds and can be raised to 300 seconds with `--max-time`. It includes browser Fetch and time spent waiting for the download consumer. Slow or stalled output can therefore cause a timeout.

Headers (`-i`, `-D`, `-v`) become available before the body finishes. `--fail` stops on an HTTP error without downloading its body; `--fail-with-body` streams the error body and then returns status 22. Network errors, timeouts, browser disconnection, or invalid stream messages return a nonzero status. File and pipe write errors return status 23 and cancel the browser request. **A failed or interrupted transfer can leave a partial file or partial stdout output**; check the exit status before using the result. Output files are opened with truncation when response headers arrive.

`--response-json` uses the original single-response protocol and buffers the response, with a 32 MiB limit including decompressed content. Existing custom clients using `type: "request"` retain that behavior. Custom clients can opt into streaming with `type: "request_stream"`; see [Protocol](protocol.md#streaming-response-mode).

After upgrading, rebuild/reload the extension and reconnect the native host so both understand streaming. Browser Fetch byte streams with BYOB readers are required; an unsupported browser reports a request error rather than falling back to whole-body buffering. Uploads still use the original 16 MiB bounded request format.

Useful exit statuses follow curl where practical:

| Status | Meaning |
| ---: | --- |
| 0 | Protocol and requested HTTP handling succeeded |
| 1 | Extension or host rejected/failed the request |
| 2 | Invalid command arguments |
| 7 | Browser relay socket unavailable |
| 22 | HTTP error with `--fail` or `--fail-with-body` |
| 23 | Output write failed |
| 28 | Request timed out |

### Curl Differences

- Without `-L`, redirect status and headers are available, but the redirect body is omitted and explicitly marked unavailable. The CLI reports this on stderr unless silent; `--response-json` exposes `body_unavailable: true`.
- `-L`/`--location` requires **Enable redirects** in extension settings and authorization of every hop. The limit is at most 20; only final response headers are output. See [Redirects](#redirects) for method and credential handling.
- TLS options, client certificates, proxies, DNS overrides, HTTP version selection, and raw transfer encodings are browser-owned and not configurable.
- Compression is browser-managed; `--compressed` is accepted as a compatibility no-op.
- Fetch may combine duplicate headers and transparently decode response content.
- `Set-Cookie` is never included in response headers.

## Custom Applications

Custom applications should connect to the local socket rather than registering another native host. This preserves one browser connection and one extension policy enforcement point. See [Protocol](protocol.md) and `examples/custom_client.py`.

Set a custom shared runtime directory before launching both the browser and application if the default project-local path is unsuitable:

```sh
export BROWSER_PROXY_RUNTIME_DIR="$HOME/.local/run/browser-proxy"
```

The browser launches the native host with its own environment, so environment overrides must be present in the browser's environment too. A custom app can instead connect to an explicit known path; the bundled CLI exposes `--socket`.

Do not expose the socket over TCP, place it in a directory writable by another OS user, or add protocol methods that modify the allowlist. If an application needs fewer privileges, use a separate OS account or separate browser profile with a narrower allowlist.

## Troubleshooting

### Native Host Offline

1. Confirm `.venv/bin/browser-proxy-host` exists and is executable.
2. Rerun `browser-proxy-install` for the correct browser.
3. Verify the installed extension ID matches the native manifest.
4. Click **Reconnect native host** or reload the extension.
5. For custom Chrome user-data directories, place the host manifest under that profile's `NativeMessagingHosts` directory.

### Origin Not Allowed

Compare scheme, hostname, and effective port. `localhost` and `127.0.0.1` are different hosts. Save the settings page after editing.

### Request Failed

`REDIRECT_BLOCKED` means the request asked to follow redirects (`-L`) but the extension setting was off or disabled during the chain. Enable it or omit `-L` to inspect the redirect status and headers. Older extensions also return this error for requests without `-L`; reload an updated build for header-only responses.

`REDIRECT_NOT_ALLOWED` means an intermediate destination failed the latest allowlist check. `--response-json` exposes its hop number and source/target origins in the error details. Add the missing origin in extension settings if appropriate.

`REDIRECT_LIMIT_EXCEEDED` means the configured hop limit was reached. `INVALID_REDIRECT` means a target is malformed, too long, non-HTTP(S), or contains URL credentials; the browser may reject some of these itself with `REQUEST_FAILED`. `REDIRECT_UNINSPECTABLE` means trustworthy browser metadata was unavailable; retry using a known final URL rather than automatically resubmitting a state-changing request.

With `--response-json`, observation failures include boolean diagnostics under `error.details`: `request_observed`, `response_headers_observed`, `redirect_observed`, and `metadata_invalid`. Missing-request-event failures also check `web_request_permission` and `host_permission` when the browser exposes the permission API. Check the extension's site access and reload the updated extension if either is false. A Chrome session that previously granted webRequest as an optional permission can retain broken interception state even after switching back to required permissions; it may need a one-time full browser restart. This is distinct from enabling redirects normally with required permissions. The diagnostic flags contain no URLs, headers, or cookies, and never request additional access.

`extension_events_observed` indicates whether any extension-initiated webRequest events arrived during the request (possibly for another concurrent request). When it is false and both permission flags are true, missing browser interception is the likely cause, rather than rejected header metadata.

`REQUEST_FAILED` covers other Fetch failures, including DNS/TLS failure, browser cookie policy, a server rejecting extension-origin requests, or an unsupported browser-controlled header. Retry with `-v`; browser developer tools can provide network details.

### Login Cookie Missing

Verify the user is logged in in the same profile where Browser Proxy is installed. Check browser third-party-cookie, partitioning, private-window, and container settings. The proxy does not select another cookie store or extract tokens from page DOM.
