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
const fetchHop = BrowserProxyRedirectObserver.create(extensionApi);
let tabContext;

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
    return false;
  }
  try {
    port.postMessage({ protocol: "browser-proxy", version: 1, ...message });
    return true;
  } catch (error) {
    lastNativeError = error.message;
    return false;
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
  const inTab = message.type === "tab_request_start";
  if (inTab !== (request.tab !== undefined)) throw new Error("Tab options require tab_request_start");
  if (inTab) BrowserProxyTabSettings.request(request.tab);

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
  if (message.stream_response !== undefined && typeof message.stream_response !== "boolean") {
    throw new Error("stream_response must be a boolean");
  }
  if (request.follow_redirects !== undefined && typeof request.follow_redirects !== "boolean") {
    throw new Error("follow_redirects must be a boolean");
  }
  const maxRedirects = request.max_redirects === undefined ? BrowserProxyRedirects.maxRedirects : request.max_redirects;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > BrowserProxyRedirects.maxRedirects) {
    throw new Error(`max_redirects must be an integer between 0 and ${BrowserProxyRedirects.maxRedirects}`);
  }

  return {
    url: request.url,
    method,
    headers: normalizedHeaders,
    timeout_ms: timeoutMs,
    cache,
    bodyBytes,
    streamResponse: message.stream_response === true,
    follow_redirects: request.follow_redirects === true,
    max_redirects: maxRedirects,
    ...(inTab ? { tab: request.tab } : {}),
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

function responseMetadata(response, history) {
  const metadata = {
    status: response.status,
    status_text: response.statusText,
    url: response.url,
    headers: Array.from(response.headers.entries()).filter(([name]) => !["set-cookie", "set-cookie2"].includes(name.toLowerCase())),
    ...(response.bodyUnavailable ? { body_unavailable: true } : {}),
    ...(history.length ? { redirected: true, redirects: history } : {}),
  };
  // Leave room for the envelope and worst-case JSON escaping in the relay.
  if (JSON.stringify(metadata).length * 6 + 1024 > 1024 * 1024) {
    throw new BrowserProxyRedirects.RedirectError("RESPONSE_TOO_LARGE", "Response metadata exceeds the native frame limit");
  }
  return metadata;
}

function sendSuccess(id, response, body, port, history) {
  sendNative({
    type: "response_start",
    id,
    response: responseMetadata(response, history),
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

function sendAcknowledged(message, sequence, active) {
  const { controller, port } = active;
  return new Promise((resolve, reject) => {
    const aborted = () => {
      active.ack = null;
      reject(new Error("Streaming request aborted"));
    };
    if (controller.signal.aborted) {
      aborted();
      return;
    }
    controller.signal.addEventListener("abort", aborted, { once: true });
    active.ack = {
      sequence,
      resolve() {
        controller.signal.removeEventListener("abort", aborted);
        active.ack = null;
        resolve();
      },
    };
    if (!sendNative(message, port)) {
      controller.abort();
    }
  });
}

async function streamSuccess(id, response, active, history) {
  const start = {
    type: "response_start",
    id,
    response: responseMetadata(response, history),
    body_bytes: null,
  };
  let reader;
  let complete = false;
  try {
    // BYOB bounds each read even if the network delivers a large chunk. Fetch
    // response bodies are byte streams in supported Chrome/Firefox versions.
    reader = response.body?.getReader({ mode: "byob" });
    await sendAcknowledged(start, -1, active);
    let sequence = 0;
    let total = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read(new Uint8Array(nativeChunkBytes));
        if (value?.byteLength) {
          total += value.byteLength;
          if (!Number.isSafeInteger(total)) {
            throw new Error("Response body exceeds the streaming byte-count limit");
          }
          await sendAcknowledged({
            type: "response_chunk", id, sequence, data: encodeBase64(value),
          }, sequence, active);
          sequence += 1;
        }
        if (done) {
          break;
        }
      }
    }
    sendNative({ type: "response_end", id, chunks: sequence, body_bytes: total }, active.port);
    complete = true;
  } finally {
    if (!complete) {
      if (reader) {
        await reader.cancel().catch(() => {});
      } else if (response.body) {
        await response.body.cancel().catch(() => {});
      }
    }
    reader?.releaseLock();
  }
}

async function executeRequest(id, state) {
  const { request } = state;
  const port = state.port;
  const controller = new AbortController();
  const active = { port, controller };
  activeRequests.set(id, active);
  let timedOut = false;
  let tabSession;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeout_ms);
  try {
    const body = joinChunks(state.chunks, state.receivedBytes);
    if (request.tab) {
      tabContext ??= BrowserProxyTabContext.create(extensionApi);
      tabSession = await tabContext.open(request, controller.signal);
    }
    const { response, history } = await BrowserProxyRedirects.execute(
      request, body, controller.signal, storageGet, tabSession?.fetchHop || fetchHop,
    );
    if (request.streamResponse) {
      await streamSuccess(id, response, active, history);
    } else {
      const responseBody = await readResponseBody(response);
      sendSuccess(id, response, responseBody, port, history);
    }
  } catch (error) {
    if (timedOut) {
      sendError(id, "TIMEOUT", `Request exceeded ${request.timeout_ms} ms`, null, port);
    } else if (error instanceof BrowserProxyRedirects.RedirectError) {
      sendError(id, error.code, error.message, error.details, port);
    } else if (error.message.startsWith("Response body exceeds")) {
      sendError(id, "RESPONSE_TOO_LARGE", error.message, null, port);
    } else {
      sendError(id, "REQUEST_FAILED", error.message || "The browser request failed", null, port);
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
    tabSession?.release();
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
  if (port !== nativePort || !message || message.protocol !== "browser-proxy" || message.version !== 1) {
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

  if (message.type === "request_cancel") {
    const incoming = incomingRequests.get(message.id);
    if (incoming?.port === port) {
      removeIncoming(message.id, incoming);
    }
    const active = activeRequests.get(message.id);
    if (active?.port === port) {
      active.controller.abort();
    }
    return;
  }
  if (message.type === "response_ack") {
    const active = activeRequests.get(message.id);
    if (active?.port === port) {
      if (active.ack && message.sequence === active.ack.sequence) {
        active.ack.resolve();
      } else {
        active.controller.abort();
      }
    }
    return;
  }

  if (message.type === "request_start" || message.type === "tab_request_start") {
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
