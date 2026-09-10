"use strict";

const extensionApi = globalThis.browser || globalThis.chrome;
const nativeHostName = "com.browserproxy.native";
const maxRequestBytes = 16 * 1024 * 1024;
const maxResponseBytes = 32 * 1024 * 1024;
const nativeChunkBytes = 384 * 1024;
const maxConcurrentRequests = 16;
const maxBufferedRequestBytes = 32 * 1024 * 1024;
const forbiddenHeaders = new Set([
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "set-cookie",
  "transfer-encoding",
  "upgrade",
]);
const cacheModes = new Set(["default", "no-store", "reload", "no-cache", "force-cache"]);

let nativePort = null;
let nativeReady = false;
let reconnectTimer = null;
let lastNativeError = "Native host has not connected";
const incomingRequests = new Map();
const activeRequests = new Map();
let bufferedRequestBytes = 0;

function storageGet(defaults) {
  return extensionApi.storage.local.get(defaults);
}

function sendNative(message, port = nativePort) {
  if (!port || port !== nativePort) {
    return;
  }
  try {
    port.postMessage({ protocol: "browser-proxy", version: 1, ...message });
  } catch (error) {
    lastNativeError = error.message;
  }
}

function sendError(id, code, message, details, port = nativePort) {
  sendNative({
    type: "response_error",
    id,
    error: { code, message, ...(details ? { details } : {}) },
  }, port);
}

function validateRequestStart(message) {
  const request = message.request;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("request must be an object");
  }
  if (typeof request.url !== "string" || request.url.length > 16384) {
    throw new Error("url must be a string no longer than 16384 characters");
  }
  BrowserProxyPolicy.parseRequestUrl(request.url);

  const method = String(request.method || "GET").toUpperCase();
  if (!/^[!#$%&'*+.^_`|~0-9A-Z-]+$/.test(method) || ["CONNECT", "TRACE", "TRACK"].includes(method)) {
    throw new Error("method is not supported by browser fetch");
  }

  const headers = request.headers || [];
  if (!Array.isArray(headers) || headers.length > 128) {
    throw new Error("headers must be an array with no more than 128 entries");
  }
  const normalizedHeaders = [];
  for (const entry of headers) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error("each header must be a [name, value] pair");
    }
    const name = String(entry[0]);
    const value = String(entry[1]);
    if (!name || name.length > 256 || value.length > 4096) {
      throw new Error("a header name or value is too long");
    }
    if (forbiddenHeaders.has(name.toLowerCase()) || name.toLowerCase().startsWith("sec-")) {
      throw new Error(`the browser-controlled header '${name}' cannot be set`);
    }
    normalizedHeaders.push([name, value]);
  }

  const bodyBytes = Number(message.body_bytes || 0);
  if (!Number.isSafeInteger(bodyBytes) || bodyBytes < 0 || bodyBytes > maxRequestBytes) {
    throw new Error(`body_bytes must be between 0 and ${maxRequestBytes}`);
  }
  if (["GET", "HEAD"].includes(method) && bodyBytes !== 0) {
    throw new Error(`${method} requests cannot have a body`);
  }

  const timeoutMs = request.timeout_ms === undefined ? 30000 : Number(request.timeout_ms);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    throw new Error("timeout_ms must be between 1 and 300000");
  }
  const cache = request.cache || "default";
  if (!cacheModes.has(cache)) {
    throw new Error("cache is invalid");
  }

  return {
    url: request.url,
    method,
    headers: normalizedHeaders,
    timeout_ms: timeoutMs,
    cache,
    bodyBytes,
  };
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function joinChunks(chunks, totalBytes) {
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

async function readResponseBody(response) {
  if (!response.body) {
    return new Uint8Array();
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    await response.body.cancel();
    throw new Error(`Response body exceeds the ${maxResponseBytes}-byte limit`);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.length;
    if (total > maxResponseBytes) {
      await reader.cancel();
      throw new Error(`Response body exceeds the ${maxResponseBytes}-byte limit`);
    }
    chunks.push(value);
  }
  return joinChunks(chunks, total);
}

function sendSuccess(id, response, body, port) {
  sendNative({
    type: "response_start",
    id,
    response: {
      status: response.status,
      status_text: response.statusText,
      url: response.url,
      headers: Array.from(response.headers.entries()),
    },
    body_bytes: body.length,
  }, port);
  let sequence = 0;
  for (let offset = 0; offset < body.length; offset += nativeChunkBytes) {
    sendNative({
      type: "response_chunk",
      id,
      sequence,
      data: encodeBase64(body.subarray(offset, offset + nativeChunkBytes)),
    }, port);
    sequence += 1;
  }
  sendNative({ type: "response_end", id, chunks: sequence }, port);
}

async function executeRequest(id, state) {
  const { request } = state;
  const port = state.port;
  const controller = new AbortController();
  const active = { port, controller };
  activeRequests.set(id, active);
  try {
    const { allowlist } = await storageGet({ allowlist: [] });
    if (!BrowserProxyPolicy.isAllowed(request.url, allowlist)) {
      sendError(id, "ORIGIN_NOT_ALLOWED", "The request origin is not in the extension allowlist", null, port);
      return;
    }
    if (port !== nativePort) {
      return;
    }

    const body = joinChunks(state.chunks, state.receivedBytes);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeout_ms);

    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: new Headers(request.headers),
        body: body.length ? body : undefined,
        credentials: "include",
        redirect: "manual",
        cache: request.cache,
        signal: controller.signal,
      });
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        sendError(
          id,
          "REDIRECT_BLOCKED",
          "The request returned a redirect, which Browser Proxy does not follow; retry with the final URL",
          null,
          port,
        );
        return;
      }
      const responseBody = await readResponseBody(response);
      sendSuccess(id, response, responseBody, port);
    } catch (error) {
      if (timedOut) {
        sendError(id, "TIMEOUT", `Request exceeded ${request.timeout_ms} ms`, null, port);
      } else if (error.message.startsWith("Response body exceeds")) {
        sendError(id, "RESPONSE_TOO_LARGE", error.message, null, port);
      } else {
        sendError(id, "REQUEST_FAILED", error.message || "The browser request failed", null, port);
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    sendError(id, "INVALID_REQUEST", error.message, null, port);
  } finally {
    bufferedRequestBytes -= state.receivedBytes;
    if (activeRequests.get(id) === active) {
      activeRequests.delete(id);
    }
  }
}

function removeIncoming(id, state, releaseBuffer = true) {
  if (incomingRequests.get(id) === state) {
    incomingRequests.delete(id);
    if (releaseBuffer) {
      bufferedRequestBytes -= state.receivedBytes;
    }
  }
}

function handleNativeMessage(message, port) {
  if (!message || message.protocol !== "browser-proxy" || message.version !== 1) {
    return;
  }
  if (message.type === "host_ready") {
    if (port === nativePort) {
      nativeReady = true;
      lastNativeError = "";
    }
    return;
  }
  if (typeof message.id !== "string") {
    return;
  }

  if (message.type === "request_start") {
    if (incomingRequests.has(message.id) || activeRequests.has(message.id)) {
      sendError(message.id, "INVALID_REQUEST", "A request with this id already exists", null, port);
      return;
    }
    if (incomingRequests.size + activeRequests.size >= maxConcurrentRequests) {
      sendError(message.id, "BUSY", "The extension has too many concurrent requests", null, port);
      return;
    }
    try {
      incomingRequests.set(message.id, {
        request: validateRequestStart(message),
        port,
        chunks: [],
        receivedBytes: 0,
        nextSequence: 0,
      });
    } catch (error) {
      sendError(message.id, "INVALID_REQUEST", error.message, null, port);
    }
    return;
  }

  const state = incomingRequests.get(message.id);
  if (!state) {
    return;
  }

  if (message.type === "request_chunk") {
    try {
      if (message.sequence !== state.nextSequence || typeof message.data !== "string") {
        throw new Error("Request chunks are missing or out of order");
      }
      const chunk = decodeBase64(message.data);
      if (bufferedRequestBytes + chunk.length > maxBufferedRequestBytes) {
        throw new Error("Concurrent request bodies exceed the extension buffer limit");
      }
      state.receivedBytes += chunk.length;
      if (state.receivedBytes > state.request.bodyBytes || state.receivedBytes > maxRequestBytes) {
        throw new Error("Request body is larger than declared");
      }
      state.chunks.push(chunk);
      bufferedRequestBytes += chunk.length;
      state.nextSequence += 1;
    } catch (error) {
      removeIncoming(message.id, state);
      sendError(message.id, "INVALID_REQUEST", error.message, null, port);
    }
    return;
  }

  if (message.type === "request_end") {
    if (state.receivedBytes !== state.request.bodyBytes || message.chunks !== state.nextSequence) {
      removeIncoming(message.id, state);
      sendError(message.id, "INVALID_REQUEST", "Request body length or chunk count does not match", null, port);
      return;
    }
    removeIncoming(message.id, state, false);
    void executeRequest(message.id, state);
  }
}

function clearPortRequests(port) {
  for (const [id, state] of incomingRequests) {
    if (state.port === port) {
      removeIncoming(id, state);
    }
  }
  for (const active of activeRequests.values()) {
    if (active.port === port) {
      active.controller.abort();
    }
  }
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNativeHost();
  }, 5000);
}

function connectNativeHost() {
  if (nativePort) {
    return;
  }
  try {
    const port = extensionApi.runtime.connectNative(nativeHostName);
    nativePort = port;
    nativeReady = false;
    lastNativeError = "Native host is starting";
    port.onMessage.addListener((message) => handleNativeMessage(message, port));
    port.onDisconnect.addListener(() => {
      if (nativePort !== port) {
        return;
      }
      const runtimeError = extensionApi.runtime.lastError;
      const portError = port.error;
      lastNativeError = runtimeError?.message || portError?.message || "Native host disconnected";
      clearPortRequests(port);
      nativePort = null;
      nativeReady = false;
      scheduleReconnect();
    });
  } catch (error) {
    lastNativeError = error.message;
    nativePort = null;
    nativeReady = false;
    scheduleReconnect();
  }
}

extensionApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "reconnect_native") {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (nativePort) {
      const port = nativePort;
      nativePort = null;
      nativeReady = false;
      clearPortRequests(port);
      port.disconnect();
    }
    lastNativeError = "Native host is reconnecting";
    connectNativeHost();
    sendResponse({ accepted: true });
    return false;
  }
  if (message && message.type === "get_status") {
    storageGet({ allowlist: [] }).then(({ allowlist }) => {
      sendResponse({
        connected: Boolean(nativePort && nativeReady),
        connecting: Boolean((nativePort && !nativeReady) || reconnectTimer),
        error: lastNativeError,
        allowlistCount: allowlist.length,
      });
    });
    return true;
  }
  return false;
});

connectNativeHost();
