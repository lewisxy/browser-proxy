# Browser Proxy

Browser Proxy lets a local application make allowlisted HTTP requests through a user's Firefox or Chrome session. The browser performs each request with `credentials: "include"`, so HttpOnly cookies remain inside the browser and are never copied into the command-line process. Requests run in the extension background and do not create tabs.

The project contains:

- Browser extensions for Chrome Manifest V3 and Firefox Manifest V2.
- A Python native-messaging host with one local socket per browser.
- A curl-like `browser-proxy` command-line client.
- Install helpers, tests, and detailed protocol documentation.

## Quick Start

Python 3.10 or newer is required. This checkout already uses `.venv`; recreate it as follows if needed:

```sh
python3 -m venv .venv
.venv/bin/pip install -e .
.venv/bin/python tools/build_extension.py
```

On Windows, use `.venv\Scripts\python.exe` and the corresponding `.exe` commands.

### Chrome

1. Run `.venv/bin/browser-proxy-install --browser chrome`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**, click **Load unpacked**, and select `dist/chrome`.
4. Open the extension's **Details**, then **Extension options**.
5. Add the narrowest origin rules you need and click **Save allowlist**.
6. Confirm **Native host connected**.

The toolbar popup also reports whether the active HTTP(S) page is allowed and can add that page's exact origin. Settings can import or export the saved allowlist as a versioned JSON file.

The included manifest key gives the unpacked Chrome extension the stable ID `gkldokmonobnekdblegmdbfjmjeghdjh`.

### Firefox

1. Run `.venv/bin/browser-proxy-install --browser firefox`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on** and select `dist/firefox/manifest.json`.
4. Open Browser Proxy's **Preferences**.
5. Add origin rules, save, and confirm **Native host connected**.

A temporary Firefox extension disappears when Firefox restarts. A permanent distribution must be signed by Mozilla while retaining the extension ID `browser-proxy@local.invalid` or installing a host manifest for its replacement ID.

### Make A Request

```sh
.venv/bin/browser-proxy https://api.example.com/profile
.venv/bin/browser-proxy -i -H "Accept: application/json" https://api.example.com/items
.venv/bin/browser-proxy --json '{"name":"Ada"}' https://api.example.com/items
.venv/bin/browser-proxy -F "note=hello" -F "file=@report.pdf" https://api.example.com/upload
.venv/bin/browser-proxy --browser firefox -o response.bin https://api.example.com/export
```

Run `.venv/bin/browser-proxy --help` for all options. Notable differences from curl are documented in [the user guide](docs/user-guide.md).

Downloads stream to stdout or `-o FILE` with bounded buffers in the extension, native host, and CLI. Files larger than 32 MiB are supported, including compressed responses and responses without a known length:

```sh
.venv/bin/browser-proxy --max-time 300 -o archive.zip https://api.example.com/archive.zip
```

The CLI acknowledges each chunk after writing it, so a slow disk or pipe pauses the download. A failed download returns a nonzero status and may leave a partial output file. Uploads remain limited to 16 MiB; `--response-json` retains its buffered 32 MiB response limit. See [streaming downloads](docs/user-guide.md#streaming-downloads) for details.

### Follow Redirects

Without `-L`, a redirect returns its original status and sanitized headers without contacting its target. Use `-i`, `-I`, or `-D` to view headers, including `Location`:

```sh
.venv/bin/browser-proxy -i https://example.com/start
```

Browser Fetch does not expose redirect bodies. The CLI reports this on stderr (`-s` suppresses the notice), and `--response-json` marks the header-only response with `body_unavailable: true`. An unfollowed redirect is a successful HTTP exchange, with exit status 0.

Turn on **Enable redirects** in extension settings (off by default), allow every destination origin, and use `-L`:

```sh
.venv/bin/browser-proxy -L --max-redirs 5 https://example.com/start
```

The extension checks the latest allowlist before every hop, including same-origin redirects. The default limit is 20 redirects and `--max-time` covers the complete chain and download. Missing browser redirect metadata stops the request rather than following an unchecked destination. See [redirect behavior](docs/user-guide.md#redirects).

## Security Summary

- The allowlist is empty by default and can only be changed in extension UI.
- Rules match origins, never paths. Wildcards are explicit.
- Following redirects requires both the extension setting and client opt-in. Each hop is authorized before it is issued; clients cannot enable the setting or change the allowlist. Without opt-in, only the redirect's status and sanitized headers are returned.
- Browser-controlled request headers, including `Cookie`, cannot be supplied by a client.
- The browser's Fetch API filters `Set-Cookie` from response headers.
- The local socket and its directory are owner-only, but every process running as the same OS user is inside the local trust boundary.
- State-changing requests remain state-changing. Allowlisting an origin grants local same-user applications substantial access to that origin.

Read [Architecture](docs/architecture.md), [Protocol](docs/protocol.md), and [User Guide](docs/user-guide.md) before using broad wildcard rules.

## Development

Install the pinned JavaScript test tools locally. The MCP implementation is an npm dependency and is not vendored in this repository.

```sh
npm install
npm run verify
```

The Chrome integration harness uses the locally installed `chrome-devtools-mcp` package with `--no-usage-statistics`, `--no-performance-crux`, and a project-local user data directory:

```sh
npm run test:chrome
```

Its browser profile, temporary native manifest, screenshots, logs, and results are kept under `.browser-proxy/`. Set `CHROME_PATH` when Chrome is not installed at the platform's usual location.

To additionally check a live HEAD redirect in that isolated profile, set `BROWSER_PROXY_LIVE_REDIRECT_URL`, for example:

```sh
BROWSER_PROXY_LIVE_REDIRECT_URL=https://google.com/ npm run test:chrome
```

The live probe only allows the initial origin and requests headers without following. The regular suite uses local fixtures and does not depend on this optional endpoint.

## Uninstall

```sh
.venv/bin/browser-proxy-install --browser chrome --uninstall
.venv/bin/browser-proxy-install --browser firefox --uninstall
```

Remove the extension from the browser separately. The uninstall command only removes this project's native host registration.
