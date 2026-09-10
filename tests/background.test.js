"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createPort() {
  let messageListener;
  let disconnectListener;
  return {
    error: undefined,
    onMessage: {
      addListener(listener) {
        messageListener = listener;
      },
    },
    onDisconnect: {
      addListener(listener) {
        disconnectListener = listener;
      },
    },
    postMessage() {},
    disconnect() {},
    receive(message) {
      messageListener(message);
    },
    drop(error) {
      this.error = error;
      disconnectListener();
    },
  };
}

test("reports ready only for the current native port", async () => {
  const ports = [createPort(), createPort()];
  let nextPort = 0;
  let runtimeMessageListener;
  let reconnectTimer;
  const chrome = {
    runtime: {
      lastError: undefined,
      connectNative() {
        return ports[nextPort++];
      },
      onMessage: {
        addListener(listener) {
          runtimeMessageListener = listener;
        },
      },
    },
    storage: {
      local: {
        async get(defaults) {
          return defaults;
        },
      },
    },
  };
  const source = fs.readFileSync(
    path.join(__dirname, "..", "extension", "common", "background.js"),
    "utf8",
  );
  vm.runInNewContext(source, {
    chrome,
    BrowserProxyPolicy: {},
    AbortController,
    setTimeout(callback) {
      reconnectTimer = callback;
      return 1;
    },
    clearTimeout() {
      reconnectTimer = undefined;
    },
  });

  const status = async () => {
    const result = await new Promise((resolve) => {
      assert.equal(runtimeMessageListener({ type: "get_status" }, {}, resolve), true);
    });
    return { ...result };
  };
  const reconnect = async () => {
    const result = await new Promise((resolve) => {
      assert.equal(runtimeMessageListener({ type: "reconnect_native" }, {}, resolve), false);
    });
    return { ...result };
  };
  const ready = { protocol: "browser-proxy", version: 1, type: "host_ready" };

  assert.deepEqual(await status(), {
    connected: false,
    connecting: true,
    error: "Native host is starting",
    allowlistCount: 0,
  });
  ports[0].receive(ready);
  assert.equal((await status()).connected, true);

  assert.deepEqual(await reconnect(), { accepted: true });
  ports[0].receive(ready);
  assert.deepEqual(await status(), {
    connected: false,
    connecting: true,
    error: "Native host is starting",
    allowlistCount: 0,
  });
  ports[1].receive(ready);
  assert.equal((await status()).connected, true);

  ports[1].drop(new Error("replacement failed"));
  assert.deepEqual(await status(), {
    connected: false,
    connecting: true,
    error: "replacement failed",
    allowlistCount: 0,
  });
  assert.equal(typeof reconnectTimer, "function");
});

function streamingBackground(response, onMessage = () => {}) {
  const ports = [createPort(), createPort()];
  const messages = [];
  let nextPort = 0;
  let fetchSignal;
  const context = vm.createContext({
    chrome: {
      runtime: {
        connectNative: () => ports[nextPort++],
        onMessage: { addListener() {} },
      },
      storage: { local: { get: async () => ({ allowlist: ["https://example.com"] }) } },
    },
    BrowserProxyPolicy: { parseRequestUrl() {}, isAllowed: () => true },
    AbortController, Headers, Uint8Array, atob, btoa,
    setTimeout: (...args) => setTimeout(...args).unref(),
    clearTimeout,
    fetch: async (_url, options) => {
      fetchSignal = options.signal;
      return response;
    },
  });
  ports[0].postMessage = (message) => onMessage(message);
  ports[1].postMessage = (message) => messages.push(message);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "extension", "common", "background.js"), "utf8"), context);
  const send = (type, fields = {}, port = ports[0]) => port.receive({
    protocol: "browser-proxy", version: 1, id: "stream-test", type, ...fields,
  });
  return {
    context, ports, messages, send,
    signal: () => fetchSignal,
    start(stream = true, timeout = 30000) {
      send("request_start", {
        request: { url: "https://example.com/file", timeout_ms: timeout },
        body_bytes: 0, stream_response: stream,
      });
      send("request_end", { chunks: 0 });
    },
  };
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert(Date.now() < deadline, "timed out waiting for background state");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("streaming reads bounded chunks only after downstream acknowledgements", async () => {
  const chunkBytes = 384 * 1024;
  const totalBytes = 70 * 1024 * 1024 + 17;
  let remaining = totalBytes;
  let reads = 0;
  let received = 0;
  let lastMessage;
  const response = new Response(new ReadableStream({
    type: "bytes",
    pull(controller) {
      reads += 1;
      const view = controller.byobRequest.view;
      assert(view.byteLength <= chunkBytes);
      const size = Math.min(remaining, view.byteLength);
      view.fill(0xa5, 0, size);
      remaining -= size;
      controller.byobRequest.respond(size);
      if (!remaining) controller.close();
    },
  }), { headers: { "Content-Length": String(totalBytes) } });
  const background = streamingBackground(response, (message) => { lastMessage = message; });
  background.start();
  await waitUntil(() => lastMessage?.type === "response_start");
  assert.equal(lastMessage.body_bytes, null);
  assert.equal(reads, 0, "must not read before output accepts the headers");
  background.send("response_ack", { sequence: -1 });
  await waitUntil(() => lastMessage.type === "response_chunk");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(reads, 1, "a slow consumer must stop network reads");
  let sequence = 0;
  while (lastMessage.type !== "response_end") {
    await waitUntil(() => lastMessage.type === "response_end" || lastMessage.sequence === sequence);
    if (lastMessage.type === "response_end") break;
    const message = lastMessage;
    assert.equal(message.type, "response_chunk");
    const bytes = Buffer.from(message.data, "base64");
    assert(bytes.length <= chunkBytes);
    assert(bytes.every((byte) => byte === 0xa5));
    received += bytes.length;
    background.send("response_ack", { sequence });
    sequence += 1;
  }
  assert.equal(received, totalBytes);
  assert.equal(lastMessage.body_bytes, totalBytes);
  assert.equal(lastMessage.chunks, sequence);
  await waitUntil(() => vm.runInContext("activeRequests.size", background.context) === 0);
});

for (const action of ["cancel", "disconnect", "timeout", "bad ack"]) {
  test(`streaming releases a blocked reader on ${action}`, async () => {
    let cancelled = false;
    let lastMessage;
    const response = new Response(new ReadableStream({
      type: "bytes",
      pull(controller) {
        controller.byobRequest.view[0] = 42;
        controller.byobRequest.respond(1);
      },
      cancel() { cancelled = true; },
    }));
    const background = streamingBackground(response, (message) => { lastMessage = message; });
    background.start(true, action === "timeout" ? 100 : 30000);
    await waitUntil(() => lastMessage?.type === "response_start");
    background.send("response_ack", { sequence: -1 });
    await waitUntil(() => lastMessage.type === "response_chunk");
    if (action === "cancel") background.send("request_cancel");
    if (action === "bad ack") background.send("response_ack", { sequence: 10 });
    if (action === "disconnect") {
      background.ports[0].drop();
      vm.runInContext("connectNativeHost()", background.context);
      background.send("response_ack", { sequence: 0 }); // stale port
    }
    await waitUntil(() => vm.runInContext("activeRequests.size", background.context) === 0);
    assert.equal(cancelled, true);
    assert.equal(background.signal().aborted, true);
    assert.equal(vm.runInContext("bufferedRequestBytes", background.context), 0);
    assert.equal(background.messages.length, 0, "old responses must never reach a replacement port");
    if (action === "timeout") assert.equal(lastMessage.error.code, "TIMEOUT");
  });
}

test("streaming rejects redirects before reading a response body", async () => {
  let reads = 0;
  let lastMessage;
  const response = new Response(new ReadableStream({
    type: "bytes", pull() { reads += 1; },
  }), { status: 302, headers: { Location: "https://other.example/file" } });
  const background = streamingBackground(response, (message) => { lastMessage = message; });
  background.start();
  await waitUntil(() => lastMessage?.type === "response_error");
  assert.equal(lastMessage.error.code, "REDIRECT_BLOCKED");
  assert.equal(reads, 0);
});

test("buffered responses retain their 32 MiB limit", async () => {
  let lastMessage;
  const response = new Response(new ReadableStream({ type: "bytes" }), {
    headers: { "Content-Length": String(33 * 1024 * 1024) },
  });
  const background = streamingBackground(response, (message) => { lastMessage = message; });
  background.start(false);
  await waitUntil(() => lastMessage?.type === "response_error");
  assert.equal(lastMessage.error.code, "RESPONSE_TOO_LARGE");
});

test("empty streaming responses finish with zero byte and chunk counts", async () => {
  let lastMessage;
  const background = streamingBackground(new Response(null, { status: 204 }), (message) => { lastMessage = message; });
  background.start();
  await waitUntil(() => lastMessage?.type === "response_start");
  background.send("response_ack", { sequence: -1 });
  await waitUntil(() => lastMessage.type === "response_end");
  assert.equal(lastMessage.body_bytes, 0);
  assert.equal(lastMessage.chunks, 0);
});
