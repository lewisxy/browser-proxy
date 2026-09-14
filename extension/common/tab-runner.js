"use strict";

// Isolated-world content script. There is deliberately no DOM/postMessage bridge
// and no execution of caller-supplied JavaScript in the page or the extension.
(function (root) {
  if (root.browserProxyTabRunner) return;
  root.browserProxyTabRunner = true;
  const api = root.browser || root.chrome;
  const chunkBytes = 384 * 1024;
  const maxBodyBytes = 16 * 1024 * 1024;

  function encode(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function decode(data) {
    const binary = atob(data);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  }

  function fail(code) { throw new Error(code); }

  api.runtime.onConnect.addListener(port => {
    if (port.name !== "browser-proxy-tab-v1" || port.sender?.id !== api.runtime.id) return;
    const controller = new AbortController();
    const documentOrigin = location.origin;
    let initialized = false;
    let busy = false;
    let nextSequence = 0;
    let upload;
    let received = 0;
    let request;
    let response;
    let reader;
    let closed = false;

    function checkDocument() {
      controller.signal.throwIfAborted();
      if (location.origin !== documentOrigin) fail("TAB_NAVIGATED");
    }

    async function authorize(url) {
      checkDocument();
      const { allowlist } = await api.storage.local.get({ allowlist: [] });
      checkDocument();
      if (!BrowserProxyPolicy.isAllowed(location.href, allowlist) || !BrowserProxyPolicy.isAllowed(url, allowlist)) fail("ORIGIN_NOT_ALLOWED");
    }

    async function cancelBody() {
      if (reader) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        reader = null;
      } else {
        await response?.body?.cancel().catch(() => {});
      }
      response = null;
    }

    async function handle(message) {
      checkDocument();
      if (message.kind === "hello") {
        if (initialized || message.origin !== documentOrigin) fail("TAB_NAVIGATED");
        await authorize(location.href);
        while (message.wait_for && !document.querySelector(message.wait_for)) {
          await new Promise(resolve => setTimeout(resolve, 50));
          checkDocument();
        }
        initialized = true;
        return { origin: documentOrigin };
      }
      if (!initialized) fail("TAB_PROTOCOL_ERROR");
      if (message.kind === "source") {
        await authorize(location.href);
        const source = message.source;
        let value = null;
        if (source.type === "cookie") {
          const matches = document.cookie.split(";").map(item => item.trim()).filter(item => item.startsWith(`${source.name}=`));
          if (matches.length > 1) fail("CSRF_SOURCE_AMBIGUOUS");
          if (matches.length) value = matches[0].slice(source.name.length + 1);
        } else if (source.type === "dom") {
          const elements = document.querySelectorAll(source.selector);
          if (elements.length > 1) fail("CSRF_SOURCE_AMBIGUOUS");
          if (elements.length) value = source.attribute ? elements[0].getAttribute(source.attribute)
            : source.property === "value" ? elements[0].value : elements[0].textContent;
        } else fail("TAB_PROTOCOL_ERROR");
        if (value !== null && (typeof value !== "string" || value.length > 4096)) fail("CSRF_TOKEN_INVALID");
        return { value };
      }
      if (message.kind === "begin") {
        await cancelBody();
        await authorize(message.url);
        if (!Number.isSafeInteger(message.body_bytes) || message.body_bytes < 0 || message.body_bytes > maxBodyBytes) fail("TAB_PROTOCOL_ERROR");
        request = message;
        upload = new Uint8Array(message.body_bytes);
        received = 0;
        return {};
      }
      if (message.kind === "upload") {
        if (!upload || typeof message.data !== "string" || message.data.length > chunkBytes * 4 / 3) fail("TAB_PROTOCOL_ERROR");
        const bytes = decode(message.data);
        if (!bytes.length || received + bytes.length > upload.length) fail("TAB_PROTOCOL_ERROR");
        upload.set(bytes, received);
        received += bytes.length;
        return {};
      }
      if (message.kind === "fetch") {
        if (!request || !upload || received !== upload.length) fail("TAB_PROTOCOL_ERROR");
        await authorize(request.url);
        // A site's service worker could replace a manual Fetch with its own
        // automatically-followed request. Such documents cannot enforce our hop policy.
        if (navigator.serviceWorker?.controller) fail("TAB_SERVICE_WORKER");
        const firefox = Boolean(api.runtime.getBrowserInfo);
        const fetchPage = firefox && typeof content !== "undefined" ? content.fetch.bind(content) : root.fetch.bind(root);
        if (firefox && typeof content === "undefined") fail("TAB_UNSUPPORTED");
        const body = upload.length ? upload : undefined;
        upload = null;
        const init = {
          method: request.method, headers: request.headers, body,
          credentials: "include", redirect: "manual", cache: request.cache,
          referrerPolicy: "strict-origin-when-cross-origin", signal: controller.signal,
        };
        response = await fetchPage(request.url, init);
        checkDocument();
        request = null;
        const metadata = {
          status: response.status, statusText: response.statusText, url: response.url, type: response.type,
          headers: Array.from(response.headers).filter(([name]) => !/^set-cookie2?$/i.test(name)),
          hasBody: Boolean(response.body) && response.type !== "opaqueredirect",
        };
        if (JSON.stringify(metadata).length * 6 + 1024 > 1024 * 1024) fail("RESPONSE_TOO_LARGE");
        return metadata;
      }
      if (message.kind === "read") {
        if (!response || response.type === "opaqueredirect" || [301, 302, 303, 307, 308].includes(response.status) && response.headers.has("location")) {
          fail("TAB_PROTOCOL_ERROR");
        }
        if (!response.body) return { done: true, data: "" };
        reader ??= response.body.getReader({ mode: "byob" });
        const { done, value } = await reader.read(new Uint8Array(chunkBytes));
        return { done, data: value?.length ? encode(value) : "" };
      }
      if (message.kind === "cancel_body") {
        await cancelBody();
        return {};
      }
      fail("TAB_PROTOCOL_ERROR");
    }

    port.onMessage.addListener(message => {
      if (closed) return;
      if (busy || message.sequence !== nextSequence++) {
        controller.abort();
        port.disconnect();
        return;
      }
      busy = true;
      void handle(message).then(value => {
        if (!closed) port.postMessage({ sequence: message.sequence, value });
      }, error => {
        // Never include token values, page contents, or bootstrap response bytes.
        const code = /^(TAB_|CSRF_|ORIGIN_NOT_ALLOWED$|RESPONSE_TOO_LARGE$)[A-Z_]*$/.test(error.message)
          ? error.message : "TAB_REQUEST_FAILED";
        if (!closed) port.postMessage({ sequence: message.sequence, error: code });
      }).finally(() => { busy = false; });
    });
    port.onDisconnect.addListener(() => {
      closed = true;
      controller.abort();
      upload = null;
      void cancelBody();
    });
  });
})(globalThis);
