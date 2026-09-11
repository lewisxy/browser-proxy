"use strict";

(function (root) {
  const statuses = new Set([301, 302, 303, 307, 308]);
  const bodyHeaders = new Set(["content-encoding", "content-language", "content-location", "content-type"]);
  const maxRedirects = 20;

  class RedirectError extends Error {
    constructor(code, message, details) {
      super(message);
      this.code = code;
      this.details = details;
    }
  }

  function blocked() {
    return new RedirectError("REDIRECT_BLOCKED", "Redirects require -L/--location and Enable redirects in extension settings");
  }

  function unfollowedResponse(response, metadata, url) {
    const opaque = response.type === "opaqueredirect";
    if (opaque && (!metadata || !statuses.has(metadata.status) || !Array.isArray(metadata.headers))) {
      throw new RedirectError("REDIRECT_UNINSPECTABLE", "The browser did not expose the redirect response headers");
    }
    const original = new URL(url);
    original.hash = "";
    const headers = new Headers(opaque ? metadata.headers : response.headers);
    headers.delete("set-cookie");
    headers.delete("set-cookie2");
    // This is deliberately a header-only response, not the server's empty body.
    // Do not manufacture content or read a redirect stream even if exposed.
    return {
      status: opaque ? metadata.status : response.status,
      statusText: opaque ? metadata.statusText : response.statusText,
      url: original.href,
      headers,
      body: null,
      bodyUnavailable: true,
    };
  }

  function nextHop(hop, redirect) {
    let target;
    try {
      if (typeof redirect.location !== "string" || redirect.location.length > 16384) {
        throw new Error("Missing or excessive Location header");
      }
      target = new URL(redirect.location, hop.url);
      if (!redirect.location.includes("#")) target.hash = new URL(hop.url).hash;
      if (target.href.length > 16384) throw new Error("Redirect URL is too long");
      BrowserProxyPolicy.parseRequestUrl(target.href);
    } catch (error) {
      throw new RedirectError("INVALID_REDIRECT", error.message);
    }

    let { method, body } = hop;
    const headers = new Headers(hop.headers);
    if (((redirect.status === 301 || redirect.status === 302) && method === "POST") ||
        (redirect.status === 303 && method !== "GET" && method !== "HEAD")) {
      method = "GET";
      body = undefined;
      for (const name of bodyHeaders) headers.delete(name);
    }
    if (new URL(hop.url).origin !== target.origin) headers.delete("authorization");
    return { url: target.href, method, body, headers };
  }

  async function execute(request, body, signal, getSettings, fetchHop) {
    let hop = {
      url: request.url, method: request.method,
      headers: new Headers(request.headers), body: body.length ? body : undefined,
    };
    const history = [];
    while (true) {
      signal.throwIfAborted();
      const { allowlist, redirectsEnabled } = await getSettings({ allowlist: [], redirectsEnabled: false });
      signal.throwIfAborted();
      if (history.length && redirectsEnabled !== true) throw blocked();
      if (!BrowserProxyPolicy.isAllowed(hop.url, allowlist)) {
        throw new RedirectError(
          history.length ? "REDIRECT_NOT_ALLOWED" : "ORIGIN_NOT_ALLOWED",
          history.length ? "The redirect origin is not in the extension allowlist" : "The request origin is not in the extension allowlist",
          history.length ? {
            hop: history.length,
            from_origin: new URL(history[history.length - 1].from).origin,
            to_origin: new URL(hop.url).origin,
          } : undefined,
        );
      }
      const following = request.follow_redirects && redirectsEnabled === true;
      const result = await fetchHop(hop.url, {
        method: hop.method, headers: hop.headers, body: hop.body,
        credentials: "include", redirect: "manual", cache: request.cache, signal,
        // Each hop is a fresh Fetch. Never forward a previous URL as a referrer.
        referrerPolicy: "no-referrer",
      }, following || !request.follow_redirects);
      const { response } = result;
      // Some browser implementations expose manual responses directly.
      const location = response.headers.get("location");
      const redirect = result.redirect || (statuses.has(response.status) && location !== null
        ? { status: response.status, location } : undefined);
      signal.throwIfAborted();
      const opaque = response.type === "opaqueredirect";
      if (!opaque && !redirect) {
        if (response.type === "opaque" || response.status === 0) {
          throw new RedirectError("REQUEST_FAILED", "The browser returned an unreadable response");
        }
        return { response, history };
      }
      await response.body?.cancel();
      if (!request.follow_redirects) {
        return { response: unfollowedResponse(response, result.redirectResponse, hop.url), history };
      }
      if (!following) throw blocked();
      if (!redirect || !statuses.has(redirect.status)) {
        throw new RedirectError("REDIRECT_UNINSPECTABLE", "The browser did not expose trustworthy redirect metadata");
      }
      if (history.length >= request.max_redirects) {
        throw new RedirectError("REDIRECT_LIMIT_EXCEEDED", `Request exceeded ${request.max_redirects} redirects`);
      }
      const next = nextHop(hop, redirect);
      history.push({ status: redirect.status, from: hop.url, to: next.url });
      hop = next;
    }
  }

  root.BrowserProxyRedirects = { RedirectError, statuses, maxRedirects, nextHop, execute };
  if (typeof module !== "undefined" && module.exports) module.exports = root.BrowserProxyRedirects;
})(globalThis);
