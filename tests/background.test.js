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
