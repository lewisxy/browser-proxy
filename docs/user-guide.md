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

`-v` prints only caller-supplied request headers and explicitly notes that browser cookies are hidden. Response bodies are written as bytes. The 32 MiB response limit includes decoded response content.

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

- `-L`/`--location` is intentionally rejected. Redirects cannot be safely followed while guaranteeing per-origin authorization.
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

Likely causes include a blocked redirect, DNS/TLS failure, browser cookie policy, a server rejecting extension-origin requests, or an unsupported browser-controlled header. Retry with `-v`; browser developer tools can provide network details.

### Login Cookie Missing

Verify the user is logged in in the same profile where Browser Proxy is installed. Check browser third-party-cookie, partitioning, private-window, and container settings. The proxy does not select another cookie store or extract tokens from page DOM.
