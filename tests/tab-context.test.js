"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
globalThis.BrowserProxyPolicy = require("../extension/common/policy.js");
globalThis.BrowserProxyRedirects = require("../extension/common/redirects.js");
globalThis.BrowserProxyRedirectObserver = require("../extension/common/redirect-observer.js");
globalThis.BrowserProxyTabSettings = require("../extension/common/tab-settings.js");
const contexts = require("../extension/common/tab-context.js");
const site = "https://app.example.com";
const other = "https://api.example.com";

function event() {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
    emit: (...args) => [...listeners].map(fn => fn(...args)), size: () => listeners.size };
}

function ports() {
  let closed = false;
  const pair = [0, 1].map(() => ({ onMessage: event(), onDisconnect: event(), sender: { id: "extension" }, name: "browser-proxy-tab-v1" }));
  pair.forEach((port, index) => {
    port.postMessage = message => queueMicrotask(() => { if (!closed) pair[1 - index].onMessage.emit(JSON.parse(JSON.stringify(message))); });
    port.disconnect = () => {
      if (closed) return;
      closed = true;
      pair.forEach(item => item.onDisconnect.emit());
    };
  });
  return pair;
}

function fixture(t, { initialTabs = [{ id: 1, url: `${site}/app`, status: "complete", active: true }], respond, profile, firefox = false } = {}) {
  const tabs = new Map(initialTabs.map(tab => [tab.id, { ...tab }]));
  const documents = new Map();
  const connections = [];
  const created = [];
  const network = [];
  const settings = { allowlist: [site, other], redirectsEnabled: true, tabProfiles: { version: 1, profiles: profile ? [profile] : [] } };
  let nextId = 100;
  let requestId = 0;
  let readCount = 0;
  const runtime = { id: "extension", getURL: () => "chrome-extension://extension/", getManifest: () => ({ manifest_version: firefox ? 2 : 3 }),
    ...(firefox ? { getBrowserInfo() {} } : {}) };
  const api = {
    runtime,
    windows: { getAll: async () => [{ id: 1, focused: true, incognito: false }] },
    storage: { local: { get: async defaults => ({ ...defaults, ...settings }) } },
    webRequest: Object.fromEntries(["onBeforeRequest", "onHeadersReceived", "onBeforeRedirect", "onCompleted", "onErrorOccurred"].map(name => [name, event()])),
    tabs: {
      onActivated: event(), onRemoved: event(),
      get: async id => { if (!tabs.has(id)) throw new Error("missing"); return { ...tabs.get(id) }; },
      query: async () => [...tabs.values()].map(tab => ({ ...tab })),
      create: async options => {
        created.push(options);
        const tab = { ...options, status: "complete", id: nextId++ };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      update: async (id, options) => { Object.assign(tabs.get(id), options); return { ...tabs.get(id) }; },
      remove: async id => { tabs.delete(id); api.tabs.onRemoved.emit(id); },
      connect: id => {
        const pair = ports();
        connections.push({ id, port: pair[0] });
        documents.get(id).runtime.onConnect.emit(pair[1]);
        return pair[0];
      },
    },
    scripting: { executeScript: async ({ target }) => {
      const id = target.tabId;
      if (!documents.has(id)) {
        const tab = tabs.get(id);
        const document = { cookie: "XSRF-TOKEN=fresh%2Btoken", querySelector: () => ({}),
          querySelectorAll: () => [{ getAttribute: () => "dom-token", textContent: "dom-token", value: "input-token" }] };
        const contentRuntime = { ...runtime, onConnect: event() };
        const fetch = async (url, init) => {
          const details = { url, method: init.method, requestId: String(++requestId), initiator: new URL(tab.url).origin, tabId: id, frameId: 0, documentId: `doc-${id}` };
          const emit = (name, extra = {}) => api.webRequest[name].emit({ ...details, ...extra });
          emit("onBeforeRequest");
          const wire = new URL(url); wire.hash = "";
          network.push({ url: wire.href, init, id });
          const result = await respond?.(wire, init, { emit, settings });
          if (result?.redirect) {
            emit("onHeadersReceived", { statusCode: 307, responseHeaders: [{ name: "Location", value: result.redirect }] });
            emit("onBeforeRedirect", { statusCode: 307, redirectUrl: new URL(result.redirect, url).href });
            return { type: "opaqueredirect", status: 0, statusText: "", url: wire.href, headers: new Headers(), body: null };
          }
          emit("onCompleted");
          const response = result?.response || new Response(new ReadableStream({
            type: "bytes", pull(controller) { readCount++; controller.enqueue(new Uint8Array([0, 255, 128, 1])); controller.close(); },
          }));
          Object.defineProperty(response, "url", { value: wire.href });
          return response;
        };
        const context = vm.createContext({
          [firefox ? "browser" : "chrome"]: { ...api, runtime: contentRuntime }, document,
          location: new URL(tab.url), navigator: {},
          ...(firefox ? { content: { fetch }, fetch: () => assert.fail("must use Firefox page fetch") } : { fetch }),
          BrowserProxyPolicy, Headers, URL, Uint8Array, AbortController, atob, btoa, setTimeout, clearTimeout,
        });
        vm.runInContext(fs.readFileSync(path.join(__dirname, "../extension/common/tab-runner.js"), "utf8"), context);
        documents.set(id, { runtime: contentRuntime, context });
      }
      return [{ frameId: 0, documentId: `doc-${id}` }];
    } },
  };
  const manager = contexts.create(api);
  t.after(() => {
    for (const { port } of connections) port.disconnect();
    // Relinquish helper ownership to clear their idle timers.
    for (const id of tabs.keys()) api.tabs.onActivated.emit({ tabId: id });
  });
  const request = { url: `${site}/api`, tab: {}, method: "POST", headers: [], cache: "default", follow_redirects: false, max_redirects: 20 };
  async function open(options = {}, controller = new AbortController()) {
    const req = { ...request, ...options };
    const session = await manager.open(req, controller.signal);
    return { session, run: async (body = new Uint8Array(), changes = {}) => BrowserProxyRedirects.execute({ ...req, ...changes }, body,
      controller.signal, async () => settings, session.fetchHop) };
  }
  return { api, settings, tabs, created, network, documents, connections, manager, request, open, reads: () => readCount };
}

test("reuses the most recently accessed matching tab without focusing or navigating it", async t => {
  const f = fixture(t, { initialTabs: [
    { id: 1, url: `${site}/one`, status: "complete", lastAccessed: 1 },
    { id: 2, url: `${site}/two`, status: "complete", lastAccessed: 2 },
    { id: 3, url: `${site}/private`, status: "complete", lastAccessed: 3, incognito: true },
  ] });
  const { session, run } = await f.open();
  try {
    const { response } = await run(new Uint8Array([1, 2, 3]));
    assert.equal(f.network[0].id, 2);
    assert.deepEqual(Array.from(f.network[0].init.body), [1, 2, 3]);
    assert.equal(f.created.length, 0);
    assert.equal(f.network[0].init.referrerPolicy, "strict-origin-when-cross-origin");
    assert.equal(f.network[0].init.credentials, "include");
    assert.equal(f.network[0].init.redirect, "manual");
    assert.equal(f.reads(), 0, "remote response must not be read eagerly");
    const reader = response.body.getReader({ mode: "byob" });
    const first = await reader.read(new Uint8Array(16));
    assert.deepEqual([...first.value], [0, 255, 128, 1]);
    assert.equal((await reader.read(new Uint8Array(16))).done, true);
  } finally { session.release(); }
  assert.equal(f.api.webRequest.onBeforeRequest.size(), 0, "session observer listeners must be removed");
});

test("concurrent requests create only one inactive muted helper and existing-only never creates", async t => {
  const f = fixture(t, { initialTabs: [] });
  await assert.rejects(f.open({ tab: { existing_only: true } }), { code: "TAB_NOT_FOUND" });
  const sessions = await Promise.all([f.open(), f.open(), f.open()]);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].active, false);
  assert.equal([...f.tabs.values()][0].muted, true);
  sessions.forEach(({ session }) => session.release());
});

test("concurrent requests share a helper before its initial page URL is committed", async t => {
  const f = fixture(t, { initialTabs: [] });
  const create = f.api.tabs.create;
  f.api.tabs.create = async options => {
    const tab = await create(options);
    Object.assign(f.tabs.get(tab.id), { url: "about:blank", pendingUrl: options.url, status: "loading" });
    setTimeout(() => Object.assign(f.tabs.get(tab.id), { url: options.url, status: "complete" }), 10);
    return { ...f.tabs.get(tab.id) };
  };
  const sessions = await Promise.all([f.open(), f.open(), f.open()]);
  try { assert.equal(f.created.length, 1, "pending helpers must participate in selection"); }
  finally { sessions.forEach(({ session }) => session.release()); }
});

test("helper tabs close only after the last request is idle; user activation relinquishes ownership", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t, { initialTabs: [] });
  const first = await f.open();
  const second = await f.open();
  first.session.release();
  t.mock.timers.tick(60001);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.tabs.size, 1, "a live request keeps the helper open");
  second.session.release();
  t.mock.timers.tick(60001);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.tabs.size, 0);
  const adopted = await f.open();
  const tabId = [...f.tabs.keys()][0];
  f.api.tabs.onActivated.emit({ tabId });
  adopted.session.release();
  t.mock.timers.tick(60001);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.tabs.size, 1, "user-owned tabs must not be closed");
});

test("helper creation never opens or focuses a window when no regular window exists", async t => {
  const f = fixture(t, { initialTabs: [] });
  f.api.windows.getAll = async () => [{ id: 2, focused: true, incognito: true }];
  await assert.rejects(f.open(), { code: "TAB_NO_WINDOW" });
  assert.equal(f.created.length, 0);
});

test("explicit tab selection can use a different allowed application origin", async t => {
  const f = fixture(t);
  const { session, run } = await f.open({ url: `${other}/api`, tab: { id: 1 } });
  try { await run(); assert.equal(f.network[0].id, 1); } finally { session.release(); }
  await assert.rejects(f.open({ tab: { id: 1, url: `${other}/` } }), { code: "TAB_ORIGIN_MISMATCH" });
});

for (const firefox of [false, true]) {
  for (const follow of [false, true]) {
    test(`${firefox ? "Firefox" : "Chrome"} reports helper-page origin changes before API Fetch, with -L ${follow}`, async t => {
      const f = fixture(t, { initialTabs: [], firefox });
      f.settings.allowlist = ["https://*.example.com"];
      const create = f.api.tabs.create;
      f.api.tabs.create = async options => {
        const tab = await create(options);
        f.tabs.get(tab.id).url = `${other}/application?private=secret#token`;
        return { ...f.tabs.get(tab.id) };
      };
      for (const enabled of [false, true]) {
        f.settings.redirectsEnabled = enabled;
        await assert.rejects(f.open({ follow_redirects: follow }), failure => {
          assert.equal(failure.code, "TAB_ORIGIN_MISMATCH");
          assert.deepEqual(failure.details, { expected_origin: site, actual_origin: other, actual_origin_allowed: true });
          assert(failure.message.includes(site) && failure.message.includes(other));
          assert.match(failure.message, /final website URL/);
          assert.match(failure.message, /-L controls API redirects/);
          assert(!JSON.stringify({ message: failure.message, details: failure.details }).includes("secret"));
          return true;
        });
      }
      assert.equal(f.network.length, 0, "must not rewrite or submit the API request from a different context");
      assert.equal(f.documents.size, 0, "must not inject into the redirected page");
    });
  }
}

test("helper-page mismatch identifies a missing final-origin allowlist rule without granting access", async t => {
  const f = fixture(t, { initialTabs: [] });
  f.settings.allowlist = [site];
  const create = f.api.tabs.create;
  f.api.tabs.create = async options => {
    const tab = await create(options);
    f.tabs.get(tab.id).url = `${other}/login?private=secret`;
    return { ...f.tabs.get(tab.id) };
  };
  await assert.rejects(f.open(), failure => {
    assert.equal(failure.code, "TAB_ORIGIN_MISMATCH");
    assert.equal(failure.details.actual_origin_allowed, false);
    assert.match(failure.message, /extension allowlist/);
    return true;
  });
  assert.deepEqual(f.settings.allowlist, [site]);
  assert.equal(f.network.length, 0);
});

test("requesting the canonical origin reuses its existing tab even when focused", async t => {
  const f = fixture(t, { initialTabs: [{ id: 1, url: `${other}/`, status: "complete", active: true }] });
  const { session, run } = await f.open({ url: `${other}/` });
  try {
    await run();
    assert.equal(f.created.length, 0);
    assert.equal(f.network[0].url, `${other}/`);
    assert.equal(f.network[0].id, 1);
  } finally { session.release(); }
});

test("an inaccessible selected tab produces origin-only diagnostics", async t => {
  const f = fixture(t, { initialTabs: [{ id: 1, url: "about:blank", status: "complete" }] });
  await assert.rejects(f.open({ tab: { id: 1, url: `${site}/` } }), failure => {
    assert.equal(failure.code, "TAB_ORIGIN_MISMATCH");
    assert.deepEqual(failure.details, { expected_origin: site, actual_origin: null, actual_origin_allowed: false });
    return true;
  });
  assert.equal(f.network.length, 0);
});

const profile = { name: "app", origin: site, page_url: `${site}/app`, csrf: [{
  sources: [{ type: "cookie", name: "XSRF-TOKEN" }], transforms: ["url-decode"], target: { header: "X-XSRF-TOKEN" },
}] };

test("tab CSRF stays browser-side, is refreshed per hop, and never crosses origins", async t => {
  const f = fixture(t, { profile, respond: async url => url.pathname === "/api" ? { redirect: `${other}/end` } : undefined });
  const { session, run } = await f.open();
  try {
    const { history } = await run(new Uint8Array(), { follow_redirects: true });
    assert.equal(new Headers(f.network[0].init.headers).get("x-xsrf-token"), "fresh+token");
    assert.equal(new Headers(f.network[1].init.headers).get("x-xsrf-token"), null);
    assert.equal(JSON.stringify(history).includes("fresh"), false);
  } finally { session.release(); }
});

test("same-origin redirect hops acquire the current token rather than replaying the previous token", async t => {
  const f = fixture(t, { profile, respond: async url => {
    if (url.pathname === "/api") {
      f.documents.get(1).context.document.cookie = "XSRF-TOKEN=rotated-token";
      return { redirect: "/end" };
    }
  } });
  const { session, run } = await f.open();
  try {
    await run(new Uint8Array(), { follow_redirects: true });
    assert.deepEqual(f.network.map(item => new Headers(item.init.headers).get("x-xsrf-token")), ["fresh+token", "rotated-token"]);
  } finally { session.release(); }
});

test("redirect observation ignores other tabs, frames, and documents even with a matching URL/tag", async t => {
  const f = fixture(t, { respond: async (_url, _init, { emit }) => {
    for (const extra of [{ tabId: 99 }, { frameId: 1 }, { documentId: "old-document" }, { initiator: "https://untrusted.example" }]) {
      emit("onHeadersReceived", { statusCode: 302, responseHeaders: [{ name: "Location", value: "https://untrusted.example" }], ...extra });
    }
    return { redirect: "/end" };
  } });
  const { session, run } = await f.open();
  try {
    const { response } = await run();
    assert.equal(response.headers.get("location"), "/end");
    assert.equal(response.bodyUnavailable, true);
    assert.equal(f.network.length, 1);
  } finally { session.release(); }
});

test("missing or ambiguous CSRF tokens prevent the API request, and --no-csrf disables injection", async t => {
  const f = fixture(t, { profile });
  const { session, run } = await f.open();
  try {
    f.documents.get(1).context.document.cookie = "";
    await assert.rejects(run(), { code: "CSRF_TOKEN_UNAVAILABLE" });
    assert.equal(f.network.length, 0);
    f.documents.get(1).context.document.cookie = "XSRF-TOKEN=a; XSRF-TOKEN=b";
    await assert.rejects(run(), { code: "CSRF_SOURCE_AMBIGUOUS" });
  } finally { session.release(); }
  const disabled = await f.open({ tab: { csrf: false } });
  try { await disabled.run(); assert.equal(new Headers(f.network[0].init.headers).has("x-xsrf-token"), false); }
  finally { disabled.session.release(); }
});

test("bootstrap JSON is bounded, credentialed, manually redirected, and consumed only inside the browser", async t => {
  const f = fixture(t, { profile: { ...profile, csrf: [{ sources: [{ type: "bootstrap", url: "/csrf", json_path: ["token"] }], target: { header: "X-CSRF" } }] },
    respond: async url => url.pathname === "/csrf" ? { response: new Response('{"token":"bootstrap-secret"}') } : undefined });
  const { session, run } = await f.open();
  try {
    const result = await run();
    assert.equal(f.network.length, 2);
    assert.equal(f.network[0].init.cache, "no-store");
    assert.equal(f.network[0].init.method, "GET");
    assert.equal(new Headers(f.network[1].init.headers).get("x-csrf"), "bootstrap-secret");
    assert.equal(result.history.length, 0);
  } finally { session.release(); }
});

test("bootstrap redirects and disallowed bootstrap origins fail without contacting their targets", async t => {
  const f = fixture(t, { profile: { ...profile, csrf: [{ sources: [{ type: "bootstrap", url: "/csrf", header: "X-CSRF" }], target: { header: "X-CSRF" } }] },
    respond: async () => ({ redirect: "https://denied.example/token" }) });
  const { session, run } = await f.open();
  try { await assert.rejects(run(), { code: "CSRF_BOOTSTRAP_FAILED" }); assert.equal(f.network.length, 1); }
  finally { session.release(); }
});

test("oversized bootstrap bodies are cancelled before any API call", async t => {
  const f = fixture(t, { profile: { ...profile, csrf: [{ sources: [{ type: "bootstrap", url: "/csrf", json_path: ["token"] }], target: { header: "X-CSRF" } }] },
    respond: async () => ({ response: new Response("x".repeat(65537)) }) });
  const { session, run } = await f.open();
  try { await assert.rejects(run(), { code: "CSRF_BOOTSTRAP_TOO_LARGE" }); assert.equal(f.network.length, 1); }
  finally { session.release(); }
});

test("aborting a logical request aborts the page fetch without retry", async t => {
  const f = fixture(t, { respond: async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }) });
  const controller = new AbortController();
  const { session, run } = await f.open({}, controller);
  try {
    const pending = run();
    const rejected = assert.rejects(pending);
    while (!f.network.length) await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await rejected;
    assert.equal(f.network[0].init.signal.aborted, true);
    assert.equal(f.network.length, 1);
  } finally { session.release(); }
});

test("revoking allowlists or changing profiles prevents subsequent requests", async t => {
  const f = fixture(t, { profile });
  const { session, run } = await f.open();
  try {
    f.settings.allowlist = [];
    await assert.rejects(run(), { code: "ORIGIN_NOT_ALLOWED" });
    f.settings.allowlist = [site];
    f.settings.tabProfiles = { version: 1, profiles: [] };
    await assert.rejects(run(), { code: "TAB_CONFIG_CHANGED" });
    assert.equal(f.network.length, 0);
  } finally { session.release(); }
});

test("closing or navigating a tab cancels its fetch, and service-worker-controlled documents fail closed", async t => {
  const f = fixture(t);
  const { session, run } = await f.open();
  try {
    f.documents.get(1).context.navigator.serviceWorker = { controller: {} };
    await assert.rejects(run(), { code: "TAB_SERVICE_WORKER" });
    assert.equal(f.network.length, 0);
    f.connections[0].port.disconnect();
    await assert.rejects(run(), { code: "TAB_CLOSED" });
  } finally { session.release(); }
});

test("Firefox MV2 calls content.fetch rather than the privileged extension fetch", async t => {
  const f = fixture(t, { firefox: true });
  const { session, run } = await f.open();
  try { await run(); assert.equal(f.network.length, 1); } finally { session.release(); }
});
