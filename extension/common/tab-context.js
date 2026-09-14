"use strict";

(function (root) {
  const emptyProfiles = { version: 1, profiles: [] };
  const chunkBytes = 384 * 1024;
  const helperIdleMs = 60000;

  function error(code, message = code.replaceAll("_", " ").toLowerCase()) {
    if (code === "TAB_SERVICE_WORKER") message = "The page is controlled by a site service worker; use an application page without a controlling worker to preserve manual redirect enforcement";
    return new BrowserProxyRedirects.RedirectError(code, message);
  }

  function pause(signal, milliseconds = 50) {
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  function encode(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function decode(data) {
    return Uint8Array.from(atob(data), character => character.charCodeAt(0));
  }

  function origin(value) {
    try { return BrowserProxyPolicy.parseRequestUrl(value).origin; } catch { return null; }
  }

  function create(api) {
    const helpers = new Map();
    let selection = Promise.resolve();
    api.tabs.onActivated.addListener(({ tabId }) => {
      const helper = helpers.get(tabId);
      if (helper) { clearTimeout(helper.timer); helpers.delete(tabId); }
    });
    api.tabs.onRemoved.addListener(tabId => {
      clearTimeout(helpers.get(tabId)?.timer);
      helpers.delete(tabId);
    });

    function releaseTab(tabId) {
      const helper = helpers.get(tabId);
      if (!helper) return;
      helper.users -= 1;
      if (helper.users) return;
      helper.timer = setTimeout(async () => {
        if (helpers.get(tabId) !== helper || helper.users) return;
        try {
          const tab = await api.tabs.get(tabId);
          if (helpers.get(tabId) !== helper || helper.users) return;
          helpers.delete(tabId);
          if (!tab.active && !tab.pinned) await api.tabs.remove(tabId);
        } catch { helpers.delete(tabId); }
      }, helperIdleMs);
    }

    async function open(request, signal) {
      const options = BrowserProxyTabSettings.request(request.tab);
      const apiOrigin = origin(request.url);
      const initial = await api.storage.local.get({ allowlist: [], tabProfiles: emptyProfiles });
      signal.throwIfAborted();
      if (!BrowserProxyPolicy.isAllowed(request.url, initial.allowlist)) throw error("ORIGIN_NOT_ALLOWED");
      let profile;
      try { profile = BrowserProxyTabSettings.select(initial.tabProfiles, apiOrigin, options.profile); }
      catch (failure) { throw error("TAB_CONFIG_INVALID", failure.message); }
      const profileSnapshot = JSON.stringify(profile);
      let pageUrl = options.url || profile?.page_url || `${apiOrigin}/`;
      if (profile && origin(pageUrl) !== origin(profile.page_url)) throw error("TAB_CONFIG_INVALID", "Tab URL must match the profile's page origin");
      let tab;
      let leasedTabId;
      let port;
      let observer;
      let pending;
      let sequence = 0;
      let disconnected = false;

      function close() {
        if (disconnected) return;
        disconnected = true;
        pending?.reject(error("TAB_CLOSED", "The tab connection closed or its document navigated"));
        pending = null;
        try { port?.disconnect(); } catch { /* Already disconnected. */ }
      }

      async function pageOriginMismatch(actualUrl) {
        const expectedOrigin = origin(pageUrl);
        const actualOrigin = origin(actualUrl);
        const { allowlist } = await api.storage.local.get({ allowlist: [] });
        signal.throwIfAborted();
        const actualAllowed = Boolean(actualOrigin && BrowserProxyPolicy.isAllowed(actualOrigin, allowlist));
        const message = actualOrigin
          ? `The tab is at ${actualOrigin}, but tab mode expects ${expectedOrigin}. ` +
            (actualAllowed ? "" : `Add ${actualOrigin} to the extension allowlist before using that page. `) +
            "Use the final website URL with --tab, or set --tab-url/the profile's application page to the intended final URL. -L controls API redirects, not tab setup."
          : "The tab has no accessible HTTP(S) application URL. Open the intended application page and check the extension's site access.";
        return new BrowserProxyRedirects.RedirectError("TAB_ORIGIN_MISMATCH", message, {
          expected_origin: expectedOrigin, actual_origin: actualOrigin, actual_origin_allowed: actualAllowed,
        });
      }

      async function settings(url = request.url) {
        signal.throwIfAborted();
        const stored = await api.storage.local.get({ allowlist: [], tabProfiles: emptyProfiles, redirectsEnabled: false });
        signal.throwIfAborted();
        if (!BrowserProxyPolicy.isAllowed(pageUrl, stored.allowlist) || !BrowserProxyPolicy.isAllowed(url, stored.allowlist)) throw error("ORIGIN_NOT_ALLOWED");
        let current;
        try { current = BrowserProxyTabSettings.select(stored.tabProfiles, apiOrigin, options.profile); }
        catch { throw error("TAB_CONFIG_CHANGED", "Tab profile changed during the request"); }
        if (JSON.stringify(current) !== profileSnapshot) throw error("TAB_CONFIG_CHANGED", "Tab profile changed during the request");
        return stored;
      }

      function rpc(kind, fields = {}) {
        signal.throwIfAborted();
        if (disconnected) return Promise.reject(error("TAB_CLOSED"));
        if (pending) return Promise.reject(error("TAB_PROTOCOL_ERROR"));
        return new Promise((resolve, reject) => {
          pending = { resolve, reject, sequence: sequence++ };
          try { port.postMessage({ kind, ...fields, sequence: pending.sequence }); }
          catch { close(); }
        });
      }

      async function remoteFetch(url, init) {
        await settings(url);
        const body = init.body || new Uint8Array();
        await rpc("begin", { url, method: init.method, headers: Array.from(init.headers), cache: init.cache, body_bytes: body.length });
        for (let offset = 0; offset < body.length; offset += chunkBytes) {
          await rpc("upload", { data: encode(body.subarray(offset, offset + chunkBytes)) });
        }
        await settings(url);
        const metadata = await rpc("fetch");
        const stream = metadata.hasBody ? new ReadableStream({
          type: "bytes",
          async pull(controller) {
            try {
              const result = await rpc("read");
              if (typeof result.data !== "string" || result.data.length > chunkBytes * 4 / 3 || typeof result.done !== "boolean") throw error("TAB_PROTOCOL_ERROR");
              const bytes = decode(result.data);
              if (bytes.length) controller.enqueue(bytes);
              else if (!result.done) throw error("TAB_PROTOCOL_ERROR");
              if (result.done) {
                controller.close();
                if (!bytes.length) controller.byobRequest?.respond(0);
              }
            } catch (failure) { controller.error(failure); }
          },
          async cancel() {
            if (!disconnected && !signal.aborted) await rpc("cancel_body");
          },
        }, { highWaterMark: 0 }) : null;
        return { ...metadata, headers: new Headers(metadata.headers), body: stream };
      }

      async function resolveSource(source) {
        await settings();
        if (source.type !== "bootstrap") return (await rpc("source", { source })).value;
        const bootstrap = { url: source.url, method: "GET", headers: [], cache: "no-store", follow_redirects: false, max_redirects: 0 };
        const { response } = await BrowserProxyRedirects.execute(bootstrap, new Uint8Array(), signal,
          () => settings(source.url), observer);
        if (response.bodyUnavailable || response.type === "opaqueredirect" || response.status < 200 || response.status >= 300) {
          await response.body?.cancel();
          throw error("CSRF_BOOTSTRAP_FAILED", "CSRF bootstrap must return a successful non-redirect response; configure its final URL");
        }
        if (source.header) {
          const value = response.headers.get(source.header);
          await response.body?.cancel();
          return value;
        }
        const reader = response.body?.getReader();
        let total = 0;
        const chunks = [];
        try {
          while (reader) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > 64 * 1024) throw error("CSRF_BOOTSTRAP_TOO_LARGE", "CSRF bootstrap JSON exceeds 64 KiB");
            chunks.push(value);
          }
          const bytes = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          return BrowserProxyTabSettings.extractJson(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), source.json_path);
        } catch (failure) {
          if (failure instanceof BrowserProxyRedirects.RedirectError) throw failure;
          throw error("CSRF_BOOTSTRAP_FAILED", "CSRF bootstrap did not return valid JSON");
        } finally {
          await reader?.cancel().catch(() => {});
          reader?.releaseLock();
        }
      }

      try {
        // Serialize selection/creation only, not page loads or requests. Concurrent
        // requests share a helper tab but have distinct document-bound ports.
        const choose = selection.then(async () => {
          signal.throwIfAborted();
          if (options.id !== undefined) {
            tab = await api.tabs.get(options.id);
            if (!options.url && !profile) pageUrl = tab.url;
            if (!origin(tab.url) || origin(tab.url) !== origin(pageUrl)) throw await pageOriginMismatch(tab.url);
          } else {
            await settings();
            // A newly created helper can still report about:blank while its
            // initial URL is pending. Reserve it for concurrent callers as well.
            const candidateUrl = candidate => origin(candidate.url) ? candidate.url
              : helpers.has(candidate.id) ? candidate.pendingUrl || helpers.get(candidate.id).url : candidate.url;
            const candidates = (await api.tabs.query({})).filter(candidate =>
              !candidate.incognito && !candidate.discarded && origin(candidateUrl(candidate)) === origin(pageUrl));
            candidates.sort((a, b) => Number(candidateUrl(b) === pageUrl) - Number(candidateUrl(a) === pageUrl)
              || (b.lastAccessed || 0) - (a.lastAccessed || 0) || a.id - b.id);
            tab = candidates[0];
            if (!tab) {
              if (options.existing_only) throw error("TAB_NOT_FOUND", "No matching open tab; open the application or omit --tab-existing-only");
              if (helpers.size >= 8) throw error("BUSY", "The extension already has eight helper tabs");
              const windows = (await api.windows.getAll({ windowTypes: ["normal"] })).filter(window => !window.incognito);
              const window = windows.find(window => window.focused) || windows[0];
              if (!window) throw error("TAB_NO_WINDOW", "Open a regular browser window before creating a helper tab");
              signal.throwIfAborted();
              tab = await api.tabs.create({ url: pageUrl, active: false, windowId: window.id });
              helpers.set(tab.id, { users: 0, timer: null, url: pageUrl });
              await api.tabs.update(tab.id, { muted: true }).catch(() => {});
            }
          }
          const helper = helpers.get(tab.id);
          if (helper) { helper.users += 1; clearTimeout(helper.timer); leasedTabId = tab.id; }
        });
        selection = choose.catch(() => {});
        await choose;
        await settings();
        while (true) {
          signal.throwIfAborted();
          tab = await api.tabs.get(tab.id);
          if (tab.discarded) throw error("TAB_UNAVAILABLE", "The selected tab was discarded; load it before requesting");
          if (tab.status === "complete") break;
          await pause(signal);
        }
        if (!origin(tab.url) || origin(tab.url) !== origin(pageUrl)) throw await pageOriginMismatch(tab.url);
        const results = await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ["policy.js", "tab-runner.js"] });
        signal.throwIfAborted();
        const documentId = results.find(result => result.frameId === 0)?.documentId;
        port = api.tabs.connect(tab.id, { name: "browser-proxy-tab-v1", frameId: 0, ...(documentId ? { documentId } : {}) });
        port.onMessage.addListener(message => {
          if (!pending || message.sequence !== pending.sequence) { close(); return; }
          const current = pending;
          pending = null;
          if (message.error) current.reject(error(message.error));
          else current.resolve(message.value);
        });
        port.onDisconnect.addListener(close);
        signal.addEventListener("abort", close, { once: true });
        signal.throwIfAborted();
        await rpc("hello", { origin: origin(pageUrl), wait_for: profile?.wait_for });
        observer = BrowserProxyRedirectObserver.create(api, remoteFetch, details =>
          details.tabId === tab.id && details.frameId === 0 &&
          (!documentId || details.documentId === documentId) &&
          origin(details.initiator ?? details.originUrl ?? details.documentUrl) === origin(pageUrl));
        return {
          async fetchHop(url, init, observe) {
            await settings(url);
            let prepared = init;
            if (options.csrf !== false && profile && origin(url) === profile.origin) {
              try { prepared = await BrowserProxyTabSettings.apply(profile.csrf, init, resolveSource); }
              catch (failure) {
                if (failure instanceof BrowserProxyRedirects.RedirectError) throw failure;
                throw error(/^CSRF_[A-Z_]+$/.test(failure.message) ? failure.message : "CSRF_TOKEN_INVALID",
                  "Could not prepare the configured CSRF token or body; inspect the tab profile locally");
              }
            }
            return observer(url, prepared, observe);
          },
          release() {
            signal.removeEventListener("abort", close);
            close();
            observer.dispose();
            releaseTab(leasedTabId);
            leasedTabId = undefined;
          },
        };
      } catch (failure) {
        signal.removeEventListener("abort", close);
        close();
        observer?.dispose();
        releaseTab(leasedTabId);
        if (signal.aborted) throw signal.reason;
        if (failure instanceof BrowserProxyRedirects.RedirectError) throw failure;
        throw error("TAB_UNAVAILABLE", "Could not access the tab; check site access, reload the extension, and try an open application tab");
      }
    }
    return { open };
  }

  root.BrowserProxyTabContext = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = root.BrowserProxyTabContext;
})(globalThis);
