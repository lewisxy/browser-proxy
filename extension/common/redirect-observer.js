"use strict";

(function (root) {
  function uninspectable(state) {
    const details = state ? {
      request_observed: Boolean(state.requestId),
      response_headers_observed: Boolean(state.redirectResponse),
      redirect_observed: Boolean(state.redirect),
      metadata_invalid: Boolean(state.invalid),
      extension_events_observed: state.eventsObserved(),
    } : undefined;
    let message = "The browser did not expose trustworthy redirect metadata; retry with the final URL";
    if (state && !state.requestId && !state.invalid) {
      message = details.extension_events_observed
        ? "The browser delivered webRequest events, but this request could not be correlated safely"
        : "The browser did not deliver webRequest events for this request; reload the extension and check its site access. Chrome sessions that previously granted webRequest as optional may need a one-time browser restart";
    }
    return new BrowserProxyRedirects.RedirectError(
      "REDIRECT_UNINSPECTABLE", message, details,
    );
  }

  function create(api, fetchRequest = root.fetch.bind(root), ownsRequest) {
    const pending = new Map();
    const requests = new Map();
    let extensionEvents = 0;
    const extensionRoot = api.runtime.getURL("");
    const extensionOrigin = extensionRoot.replace(/\/$/, "");
    const filter = { urls: ["http://*/*", "https://*/*"], types: ["xmlhttprequest"] };
    // Firefox can additionally stop an unexpected internal rewrite before it is
    // sent. Chrome MV3 uses nonblocking observation and manual Fetch redirects.
    const blocking = api.runtime.getManifest().manifest_version === 2;
    const listeners = [];

    function listen(event, listener, extra) {
      // Firefox's onErrorOccurred accepts only listener and filter. An explicit
      // undefined still counts as a third argument and aborts background startup.
      if (extra === undefined) event.addListener(listener, filter);
      else event.addListener(listener, filter, extra);
      listeners.push([event, listener]);
    }

    function owned(details) {
      if (ownsRequest) return ownsRequest(details);
      const initiator = details.initiator ?? details.originUrl ?? details.documentUrl;
      return initiator === extensionOrigin || initiator?.startsWith(extensionRoot);
    }

    function tag(url) {
      try { return new URL(url).hash; } catch { return ""; }
    }

    function stateForEvent(details) {
      if (!owned(details)) return undefined;
      extensionEvents += 1;
      const bound = requests.get(details.requestId);
      if (bound) return bound;
      const state = pending.get(tag(details.url));
      if (!state) return undefined;
      // Chrome may omit or delay the initial event. A later event can establish
      // the binding, but only with the exact extension origin, URL, method and
      // fresh fragment tag. Never substitute a URL-only or FIFO match.
      if (details.url !== state.url || details.method !== state.method ||
          (state.requestId && state.requestId !== details.requestId)) {
        state.invalid = true;
        state.notify();
        return state;
      }
      state.requestId = details.requestId;
      requests.set(details.requestId, state);
      return state;
    }

    function cleanLocation(value, state) {
      // Browser-generated Location headers (e.g. HSTS) can inherit our tag.
      return value.endsWith(state.tag)
        ? value.slice(0, -state.tag.length) + new URL(state.originalUrl).hash : value;
    }

    function responseMetadata(details, state) {
      if (!Array.isArray(details.responseHeaders)) return undefined;
      const locations = details.responseHeaders.filter(header => header.name.toLowerCase() === "location");
      if (locations.length > 1 || (locations.length === 1 && typeof locations[0].value !== "string")) throw uninspectable();
      const headers = new Headers();
      for (const header of details.responseHeaders) {
        const name = header.name.toLowerCase();
        if (name === "set-cookie" || name === "set-cookie2") continue;
        let value = header.value;
        if (typeof value !== "string") {
          if (!Array.isArray(header.binaryValue) || !header.binaryValue.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
            throw uninspectable();
          }
          value = header.binaryValue.map(byte => String.fromCharCode(byte)).join("");
        }
        // Validate names/values with Headers and never retain the raw array.
        headers.append(header.name, name === "location" ? cleanLocation(value, state) : value);
      }
      const statusLine = /^HTTP\/\S+\s+(\d{3})(?:[ \t]+([^\r\n]*))?$/.exec(details.statusLine || "");
      return {
        status: details.statusCode,
        statusText: statusLine && Number(statusLine[1]) === details.statusCode ? statusLine[2] || "" : "",
        headers: Array.from(headers.entries()),
      };
    }

    listen(api.webRequest.onBeforeRequest, (details) => {
      const state = stateForEvent(details);
      if (!state) return;
      if (details.url !== state.url || details.method !== state.method ||
          (state.requestId && state.requestId !== details.requestId)) {
        state.invalid = true;
        state.notify();
        return blocking ? { cancel: true } : undefined;
      }
      state.requestId = details.requestId;
      requests.set(details.requestId, state);
    }, blocking ? ["blocking"] : []);

    listen(api.webRequest.onHeadersReceived, (details) => {
      const state = stateForEvent(details);
      if (!state) return;
      if (details.url !== state.url) {
        state.invalid = true;
      } else if (BrowserProxyRedirects.statuses.has(details.statusCode)) {
        try {
          state.redirectResponse = responseMetadata(details, state);
        } catch {
          state.invalid = true;
        }
        const locations = (details.responseHeaders || []).filter(header => header.name.toLowerCase() === "location");
        if (locations.length > 1 || (locations.length === 1 && typeof locations[0].value !== "string")) {
          state.invalid = true;
        } else if (locations.length === 1) {
          state.redirect = { status: details.statusCode, location: cleanLocation(locations[0].value, state) };
        }
      }
      if (state.invalid) state.notify();
    }, ["responseHeaders"]);

    listen(api.webRequest.onBeforeRedirect, (details) => {
      const state = stateForEvent(details);
      if (!state) return;
      if (details.url !== state.url) {
        state.invalid = true;
      } else {
        try {
          if (!state.redirectResponse) state.redirectResponse = responseMetadata(details, state);
          const target = new URL(details.redirectUrl);
          if (target.hash === state.tag) target.hash = new URL(state.originalUrl).hash;
          if (state.redirect) {
            const headerTarget = new URL(state.redirect.location, state.originalUrl);
            headerTarget.hash = "";
            const browserTarget = new URL(target.href);
            browserTarget.hash = "";
            if (headerTarget.href !== browserTarget.href || state.redirect.status !== details.statusCode) state.invalid = true;
          } else {
            // Covers browser-generated redirects without a Location header event.
            state.redirect = { status: details.statusCode, location: target.href };
          }
        } catch {
          state.invalid = true;
        }
      }
      state.notify();
    }, ["responseHeaders"]);

    for (const event of [api.webRequest.onCompleted, api.webRequest.onErrorOccurred]) {
      listen(event, (details) => {
        const state = stateForEvent(details);
        if (state) state.notify();
      });
    }

    async function fetchHop(url, init, observe) {
      if (!observe) return { response: await fetchRequest(url, init) };
      const tagged = new URL(url);
      // Fragments are visible to webRequest but never sent over HTTP or used in
      // the HTTP cache key. Fresh tags prevent late events, identical concurrent
      // URLs and replacement native ports from sharing another hop's metadata.
      tagged.hash = `browser-proxy-${crypto.randomUUID()}`;
      let notify;
      const observed = new Promise(resolve => { notify = resolve; });
      const eventsAtStart = extensionEvents;
      const state = {
        tag: tagged.hash, url: tagged.href, originalUrl: url, method: init.method, notify,
        eventsObserved: () => extensionEvents > eventsAtStart,
      };
      pending.set(state.tag, state);
      let timer;
      let aborted;
      try {
        const response = await fetchRequest(tagged.href, init);
        if (response.type === "opaqueredirect") {
          // Event delivery and Fetch resolution are asynchronous. A missing event
          // is an error, never a reason to retry the request or guess a target.
          await Promise.race([
            observed,
            new Promise((resolve, reject) => {
              timer = setTimeout(resolve, 1000);
              aborted = () => reject(init.signal.reason);
              init.signal.addEventListener("abort", aborted, { once: true });
              if (init.signal.aborted) aborted();
            }),
          ]);
          if ((!state.redirect && !state.redirectResponse) || state.invalid) throw uninspectable(state);
        }
        if (state.invalid) {
          await response.body?.cancel();
          throw uninspectable(state);
        }
        // A changed final URL indicates an unexpected automatic hop. Normal
        // manual Fetch (including Chrome HSTS) must not reach this condition.
        const expected = new URL(url);
        expected.hash = "";
        if (response.url && response.url !== expected.href) {
          state.invalid = true;
          await response.body?.cancel();
          throw uninspectable(state);
        }
        return { response, redirect: state.redirect, redirectResponse: state.redirectResponse };
      } catch (error) {
        if (state.invalid) throw uninspectable(state);
        if (error.code === "REDIRECT_UNINSPECTABLE" && !state.requestId && api.permissions) {
          try {
            const target = new URL(url);
            const [webRequestPermission, hostPermission] = await Promise.all([
              api.permissions.contains({ permissions: ["webRequest"] }),
              api.permissions.contains({ origins: [`${target.protocol}//${target.hostname}/*`] }),
            ]);
            error.details.web_request_permission = webRequestPermission;
            error.details.host_permission = hostPermission;
            if (!webRequestPermission || !hostPermission) {
              error.message = "The browser did not deliver webRequest events because the required permission or site access is missing; reload the extension and allow access to this site in the browser's extension settings";
            }
          } catch {
            // Diagnostics must not replace the original failure or request access.
          }
        }
        throw error;
      } finally {
        clearTimeout(timer);
        if (aborted) init.signal.removeEventListener("abort", aborted);
        pending.delete(state.tag);
        if (state.requestId) requests.delete(state.requestId);
      }
    }
    fetchHop.dispose = () => {
      for (const [event, listener] of listeners) event.removeListener(listener);
    };
    return fetchHop;
  }

  root.BrowserProxyRedirectObserver = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = root.BrowserProxyRedirectObserver;
})(globalThis);
