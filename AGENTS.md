# AGENTS.md

## Project Overview

Browser Proxy lets local applications make allowlisted HTTP requests through a user's Chrome or Firefox session without exporting browser cookies.

The repository contains:

- `extension/common/`: shared extension background, policy, settings, and popup code.
- `extension/manifest.chrome.json`: Chrome Manifest V3 source manifest.
- `extension/manifest.firefox.json`: Firefox persistent Manifest V2 source manifest.
- `src/browser_proxy/`: Python CLI, native host, installer, and framing protocol.
- `tools/build_extension.py`: generates browser-specific unpacked extensions.
- `tools/chrome_mcp_test.mjs`: Chrome end-to-end test through Chrome DevTools MCP.
- `tests/`: Python and JavaScript unit/integration tests.
- `docs/`: architecture, protocol, and user documentation.

## Setup

Use the project-local Python environment and pinned npm dependencies:

```sh
python3 -m venv .venv
.venv/bin/pip install -e .
npm ci
```

Do not vendor Chrome DevTools MCP source or archives. It is installed through `package.json` and must be resolved from `node_modules`.

## Generated Files

Do not edit `dist/chrome` or `dist/firefox` directly. Edit files under `extension/`, then rebuild:

```sh
npm run build:extensions
```

The following are local/generated and must not be committed:

- `.venv/`
- `.browser-proxy/`
- `node_modules/`
- `dist/`
- Chrome DevTools MCP archives or expanded source trees

Commit `package-lock.json` when npm dependencies change.

## Required Verification

Run the standard verification after code changes:

```sh
npm run verify
```

This rebuilds both extensions, runs Python tests, runs JavaScript extension tests, and lints the Firefox extension.

For changes affecting extension behavior, native messaging, cookies, allowlists, or the Chrome harness, also run:

```sh
npm run test:chrome
```

The Chrome test must continue to launch MCP with `--no-usage-statistics`. Keep its user-data directory, logs, screenshots, temporary native manifest, and other artifacts under `.browser-proxy/` in the project.

Firefox integration testing requires the user to load `dist/firefox/manifest.json` from `about:debugging#/runtime/this-firefox`. Prompt the user before that step. Remove any native host manifests temporarily installed for browser testing when the test finishes.

## Security Invariants

Do not weaken these properties without explicit user approval and corresponding documentation:

- The extension allowlist is empty by default.
- Only extension UI can modify the allowlist; local protocol clients cannot.
- Rules authorize origins, not paths, and wildcard matching must preserve hostname boundaries.
- Every request is checked against the latest stored allowlist.
- Fetch always uses `credentials: "include"` so credentials remain browser-managed.
- Every Fetch uses `redirect: "manual"`. Redirect following requires both client opt-in and the extension UI setting (off by default). Each hop must pass the latest allowlist before being issued; missing or ambiguous metadata fails closed. Never read redirect bodies, automatically retry for metadata, or use Fetch's automatic following. Preserve hop and whole-chain timeout limits.
- Without client redirect opt-in, return the original redirect status and sanitized headers when available, with `body_unavailable: true` and zero transported body bytes. The unfollowed target is never contacted and does not require allowlist authorization. Never expose raw Set-Cookie headers or pretend the omitted body is the server's empty response.
- Clients cannot set browser-controlled headers such as `Cookie`, `Host`, `Content-Length`, or `Sec-*`.
- Responses do not expose `Set-Cookie` headers.
- Request, response, framing, concurrency, and timeout limits remain enforced.
- Responses from a disconnected native port must never be sent through a replacement port.
- Native-messaging stdout contains framed protocol messages only; diagnostics go to stderr.
- Windows native-messaging stdin and stdout remain in binary mode.
- Local runtime directories and Unix sockets remain owner-only.

The local same-OS-user boundary is trusted. Do not expose the relay over TCP or claim it protects against malicious processes running as the same user.

## Compatibility Notes

Chrome uses a Manifest V3 service worker. Firefox intentionally uses a persistent Manifest V2 background because an idle event page can close the native port and make the external socket unavailable.

The CLI is curl-like, not wire-compatible with curl. Browser Fetch owns cookies, redirects, compression, TLS, HTTP versions, forbidden headers, and cookie-store selection. Keep differences documented in `docs/user-guide.md`.

The local socket protocol and native chunk protocol are documented in `docs/protocol.md`. Any protocol behavior change must update that document and include tests for compatibility or a protocol version increment.

## Change Guidelines

- Prefer the smallest correct change.
- Use only the Python standard library unless a dependency has a clear justification.
- Keep shared extension behavior in `extension/common/`.
- Preserve binary response bodies and explicit base64 transport encoding.
- Add tests for policy, protocol, CLI, or host behavior when changing those areas.
- Update `README.md` and relevant files under `docs/` when user-visible behavior changes.
- Never commit browser profiles, cookies, test credentials, native manifests, sockets, logs, screenshots, or other runtime artifacts.
