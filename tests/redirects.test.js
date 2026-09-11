"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { STATUS_CODES } = require("node:http");
globalThis.BrowserProxyPolicy = require("../extension/common/policy.js");
const redirects = require("../extension/common/redirects.js");
const observer = require("../extension/common/redirect-observer.js");

const origin = "https://example.com";
const other = "https://other.example";
const request = { url: `${origin}/start`, method: "GET", headers: [], cache: "default", follow_redirects: true, max_redirects: 20 };

function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(details) { return listeners.map(listener => listener(details)); },
  };
}

function network(respond, { firefox = false, beforeRequest = true } = {}) {
  let sequence = 0;
  const calls = [];
  const api = {
    runtime: {
      getURL: () => firefox ? "moz-extension://test/" : "chrome-extension://test/",
      getManifest: () => ({ manifest_version: firefox ? 2 : 3 }),
    },
    webRequest: Object.fromEntries(["onBeforeRequest", "onHeadersReceived", "onBeforeRedirect", "onCompleted", "onErrorOccurred"]
      .map(name => [name, event()])),
  };
  const fetchHop = observer.create(api, async (url, init) => {
    assert.equal(init.redirect, "manual");
    assert.equal(init.credentials, "include");
    const details = { url, method: init.method, requestId: String(++sequence),
      ...(firefox ? { originUrl: "moz-extension://test/background.html" } : { initiator: "chrome-extension://test" }) };
    const emit = (name, extra = {}) => api.webRequest[name].emit({ ...details, ...extra });
    if (beforeRequest) emit("onBeforeRequest");
    const wireUrl = new URL(url);
    wireUrl.hash = "";
    calls.push({ url: wireUrl.href, init });
    const result = await respond(wireUrl, init, emit, details);
    const status = result.status ?? 200;
    const statusLine = `HTTP/1.1 ${status} ${result.statusText ?? STATUS_CODES[status] ?? ""}`;
    if (!result.noHeaders) emit("onHeadersReceived", {
      statusCode: status,
      statusLine,
      responseHeaders: result.headers || (result.location !== undefined ? [{ name: "Location", value: result.location }] : []),
    });
    if (result.location !== undefined && !result.noRedirectEvent) emit("onBeforeRedirect", {
      statusCode: status, statusLine, redirectUrl: new URL(result.location, url).href,
      responseHeaders: result.redirectHeaders,
    });
    emit("onCompleted");
    if (redirects.statuses.has(status) && (result.location !== undefined || result.opaque)) {
      return { type: "opaqueredirect", status: 0, url: wireUrl.href, headers: new Headers(), body: null };
    }
    const response = new Response(status === 304 ? null : (result.body ?? "done"), { status, headers: result.headers });
    Object.defineProperty(response, "url", { value: wireUrl.href });
    return response;
  });
  return { calls, fetchHop, api };
}

function run(net, options = {}, settings = { allowlist: [origin, other], redirectsEnabled: true }, controller = new AbortController()) {
  return redirects.execute({ ...request, ...options }, options.body || new Uint8Array(), controller.signal,
    typeof settings === "function" ? settings : async () => settings, net.fetchHop);
}

test("follows relative and cross-origin redirects and returns only final binary response", async () => {
  const net = network(async url => {
    if (url.pathname === "/start") return { status: 302, location: "/step" };
    if (url.pathname === "/step") return { status: 307, location: `${other}/end` };
    return { body: new Uint8Array([0, 255, 128, 1]) };
  });
  const { response, history } = await run(net);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 255, 128, 1]));
  assert.equal(history.length, 2);
  assert.equal(response.url, `${other}/end`);
  assert.equal(JSON.stringify(history).includes("browser-proxy-"), false);
});

test("client opt-in cannot override a disabled extension setting", async () => {
  const net = network(async () => ({ status: 302, location: "/end" }));
  await assert.rejects(run(net, {}, { allowlist: [origin], redirectsEnabled: false }), { code: "REDIRECT_BLOCKED" });
  assert.equal(net.calls.length, 1);
});

for (const enabled of [false, true]) {
  for (const status of [301, 302, 303, 307, 308]) {
    test(`without opt-in returns ${status} headers with setting ${enabled} and never contacts a denied target`, async () => {
      const net = network(async () => ({ status, location: `${other}/end`, headers: [
        { name: "Location", value: `${other}/end` },
        { name: "Content-Length", value: "123" },
        { name: "X-Redirect", value: "original-response" },
        { name: "sEt-CoOkIe", get value() { assert.fail("must not copy Set-Cookie"); } },
        { name: "Set-Cookie2", value: "hidden=secret" },
      ] }));
      const { response, history } = await run(net, { follow_redirects: false }, { allowlist: [origin], redirectsEnabled: enabled });
      assert.equal(response.status, status);
      assert.equal(response.statusText, STATUS_CODES[status]);
      assert.equal(response.url, request.url);
      assert.equal(response.headers.get("location"), `${other}/end`);
      assert.equal(response.headers.get("content-length"), "123");
      assert.equal(response.headers.get("x-redirect"), "original-response");
      assert.equal(response.headers.has("set-cookie"), false);
      assert.equal(response.headers.has("set-cookie2"), false);
      assert.equal(response.body, null);
      assert.equal(response.bodyUnavailable, true);
      assert.equal(history.length, 0);
      assert.equal(net.calls.length, 1);
    });
  }
}

test("without opt-in exposes relative and credential-bearing Location values as data", async () => {
  for (const location of ["../next?x=1", "https://user:secret@denied.example/", "file:///tmp/target"]) {
    const net = network(async () => ({ status: 302, location }));
    const { response } = await run(net, { follow_redirects: false });
    assert.equal(response.headers.get("location"), location);
    assert.equal(net.calls.length, 1);
  }
});

test("without opt-in still requires the initial origin to be allowlisted", async () => {
  const net = network(async () => assert.fail("disallowed initial URL must not be fetched"));
  await assert.rejects(run(net, { follow_redirects: false }, { allowlist: [], redirectsEnabled: false }), { code: "ORIGIN_NOT_ALLOWED" });
});

test("unfollowed browser-generated redirects remove inherited correlation tags from Location", async () => {
  const net = network(async (_url, _init, _emit, details) => ({
    status: 307, location: `${other}/end${new URL(details.url).hash}`,
    headers: [{ name: "Location", value: `${other}/end${new URL(details.url).hash}` }],
  }));
  const { response } = await run(net, { follow_redirects: false, url: `${request.url}#user-fragment` });
  assert.equal(response.headers.get("location"), `${other}/end#user-fragment`);
  assert.equal(response.url, request.url);
});

test("unfollowed redirects support fallback header events and binary header values", async () => {
  const net = network(async () => ({
    status: 302, location: "/end", noHeaders: true,
    redirectHeaders: [{ name: "Location", value: "/end" }, { name: "X-Text", binaryValue: [99, 97, 102, 233] }],
  }));
  const { response } = await run(net, { follow_redirects: false });
  assert.equal(response.statusText, "Found");
  assert.equal(response.headers.get("x-text"), "caf\u00e9");
});

test("rejects a disallowed intermediate origin before issuing that hop", async () => {
  const net = network(async () => ({ status: 302, location: `${other}/back-to-allowed` }));
  await assert.rejects(run(net, {}, { allowlist: [origin], redirectsEnabled: true }), error => {
    assert.equal(error.code, "REDIRECT_NOT_ALLOWED");
    assert.deepEqual(error.details, { hop: 1, from_origin: origin, to_origin: other });
    return true;
  });
  assert.equal(net.calls.length, 1);
});

for (const target of ["http://example.com/end", "https://example.com:8443/end", "https://notexample.com/end"]) {
  test(`redirect authorization preserves scheme, port, and hostname boundaries: ${target}`, async () => {
    const net = network(async () => ({ status: 302, location: target }));
    await assert.rejects(run(net, {}, { allowlist: [origin], redirectsEnabled: true }), { code: "REDIRECT_NOT_ALLOWED" });
    assert.equal(net.calls.length, 1);
  });
}

test("wildcard rules authorize matching redirect origins", async () => {
  const net = network(async url => url.pathname === "/start"
    ? { status: 302, location: "https://sub.example.org:8443/end" } : {});
  const { response } = await run(net, {}, { allowlist: [origin, "https://*.example.org:*"], redirectsEnabled: true });
  assert.equal(response.status, 200);
  assert.equal(net.calls.length, 2);
});

test("original fragments are inherited only when Location omits a fragment", () => {
  const hop = { ...request, url: `${origin}/start#user-fragment` };
  assert.equal(redirects.nextHop(hop, { status: 302, location: "/end" }).url, `${origin}/end#user-fragment`);
  assert.equal(redirects.nextHop(hop, { status: 302, location: "/end#new" }).url, `${origin}/end#new`);
  assert.equal(redirects.nextHop(hop, { status: 302, location: "/end#" }).url, `${origin}/end#`);
});

for (const update of [settings => { settings.allowlist = []; }, settings => { settings.redirectsEnabled = false; }]) {
  test("rechecks saved policy between hops", async () => {
    const settings = { allowlist: [origin], redirectsEnabled: true };
    const net = network(async () => {
      update(settings);
      return { status: 302, location: "/end" };
    });
    await assert.rejects(run(net, {}, settings), error => ["REDIRECT_BLOCKED", "REDIRECT_NOT_ALLOWED"].includes(error.code));
    assert.equal(net.calls.length, 1);
  });
}

for (const [status, method, expected] of [[301, "POST", "GET"], [302, "POST", "GET"], [302, "PUT", "PUT"],
  [303, "PATCH", "GET"], [303, "HEAD", "HEAD"], [307, "POST", "POST"], [308, "PUT", "PUT"]]) {
  test(`${status} transforms ${method} to ${expected} with correct headers/body`, async () => {
    const body = new Uint8Array([0, 255, 42]);
    const net = network(async url => url.pathname === "/start" ? { status, location: `${other}/end` } : {});
    await run(net, { method, body: method === "HEAD" ? undefined : body,
      headers: [["Authorization", "Bearer secret"], ["Content-Type", "application/octet-stream"], ["Content-Language", "en"]] });
    const final = net.calls[1].init;
    assert.equal(final.method, expected);
    assert.equal(final.headers.has("authorization"), false);
    if (expected === "GET") {
      assert.equal(final.body, undefined);
      assert.equal(final.headers.has("content-type"), false);
      assert.equal(final.headers.has("content-language"), false);
    } else if (method !== "HEAD") assert.deepEqual(final.body, body);
  });
}

test("keeps Authorization on same-origin redirects but never restores it after crossing origins", async () => {
  const net = network(async url => {
    if (url.pathname === "/start") return { status: 302, location: "/same" };
    if (url.pathname === "/same") return { status: 302, location: `${other}/other` };
    if (url.pathname === "/other") return { status: 302, location: `${origin}/end` };
    return {};
  });
  await run(net, { headers: [["Authorization", "secret"]] });
  assert.equal(net.calls[1].init.headers.get("authorization"), "secret");
  assert.equal(net.calls[2].init.headers.has("authorization"), false);
  assert.equal(net.calls[3].init.headers.has("authorization"), false);
});

for (const location of ["file:///etc/passwd", "data:text/plain,hello", "https://user:secret@example.com/", "http://[invalid", "x".repeat(16385)]) {
  test(`rejects invalid redirect ${location.slice(0, 50)}`, () => {
    assert.throws(() => redirects.nextHop(request, { status: 302, location }), { code: "INVALID_REDIRECT" });
  });
}

for (const limit of [0, 2]) {
  test(`bounds redirect loops to ${limit} followed hops`, async () => {
    const net = network(async () => ({ status: 302, location: "/start" }));
    await assert.rejects(run(net, { max_redirects: limit }), { code: "REDIRECT_LIMIT_EXCEEDED" });
    assert.equal(net.calls.length, limit + 1);
  });
}

test("does not classify 300, 304 or a 302 without Location as a followable redirect", async () => {
  for (const [status, follow_redirects] of [300, 304, 302].flatMap(status => [[status, true], [status, false]])) {
    const net = network(async () => ({ status }));
    const result = await run(net, { follow_redirects });
    assert.equal(result.response.status, status);
    assert.equal(result.response.bodyUnavailable, undefined);
    assert.equal(net.calls.length, 1);
  }
});

test("missing observation fails closed without retrying POST", async () => {
  const net = network(async () => ({ status: 302, opaque: true, noHeaders: true }));
  await assert.rejects(run(net, { method: "POST", body: new Uint8Array([1]) }), { code: "REDIRECT_UNINSPECTABLE" });
  assert.equal(net.calls.length, 1);
});

test("without opt-in missing metadata fails closed and never retries POST", async () => {
  const net = network(async () => ({ status: 302, opaque: true, noHeaders: true }));
  await assert.rejects(run(net, { follow_redirects: false, method: "POST", body: new Uint8Array([1]) }), error => {
    assert.equal(error.code, "REDIRECT_UNINSPECTABLE");
    assert.deepEqual(error.details, {
      request_observed: true, response_headers_observed: false, redirect_observed: false, metadata_invalid: false,
      extension_events_observed: true,
    });
    return true;
  });
  assert.equal(net.calls.length, 1);
});

test("missing Chrome request events have actionable diagnostics without exposing request data", async () => {
  const { api } = network(async () => ({}));
  const fetchHop = observer.create(api, async url => {
    // No onBeforeRequest binding: even unrelated completion events cannot be
    // substituted for the missing observation of this particular Fetch.
    api.webRequest.onCompleted.emit({ requestId: "unrelated" });
    return { type: "opaqueredirect", status: 0, url: request.url, headers: new Headers(), body: null };
  });
  await assert.rejects(fetchHop(request.url, { method: "HEAD", signal: new AbortController().signal }, true), error => {
    assert.equal(error.code, "REDIRECT_UNINSPECTABLE");
    assert.match(error.message, /did not deliver webRequest events/);
    assert.deepEqual(error.details, {
      request_observed: false, response_headers_observed: false, redirect_observed: false, metadata_invalid: false,
      extension_events_observed: false,
    });
    assert(!JSON.stringify(error.details).includes("example.com"));
    return true;
  });
});

for (const method of ["GET", "HEAD"]) {
  test(`${method} redirect metadata can bind a missing initial event by its exact tag`, async () => {
    const net = network(async url => url.pathname === "/start" ? { status: 301, location: "/end" } : {}, { beforeRequest: false });
    const unfollowed = await run(net, { method, follow_redirects: false });
    assert.equal(unfollowed.response.status, 301);
    assert.equal(unfollowed.response.bodyUnavailable, true);
    assert.equal(unfollowed.response.headers.get("location"), "/end");
    assert.equal(net.calls.length, 1);
    const followed = await run(net, { method });
    assert.equal(followed.response.status, 200);
    assert.equal(net.calls.length, 3);
  });
}

test("late binding rejects response events for the wrong method even with a matching tag", async () => {
  const net = network(async (_url, _init, emit) => {
    emit("onHeadersReceived", { method: "POST", statusCode: 301, responseHeaders: [{ name: "Location", value: "/wrong" }] });
    return { status: 301, location: "/end" };
  }, { beforeRequest: false });
  await assert.rejects(run(net, { method: "HEAD", follow_redirects: false }), { code: "REDIRECT_UNINSPECTABLE" });
  assert.equal(net.calls.length, 1);
});

test("missing event diagnostics distinguish withheld site access without requesting it", async () => {
  const { api } = network(async () => ({}));
  api.permissions = {
    contains: async query => Boolean(query.permissions),
    request: () => assert.fail("diagnostics must not request permissions"),
  };
  const fetchHop = observer.create(api, async () => ({
    type: "opaqueredirect", status: 0, url: request.url, headers: new Headers(), body: null,
  }));
  await assert.rejects(fetchHop(request.url, { method: "HEAD", signal: new AbortController().signal }, true), error => {
    assert.equal(error.details.web_request_permission, true);
    assert.equal(error.details.host_permission, false);
    assert.match(error.message, /site access is missing/);
    return true;
  });
});

test("a target-only event is insufficient to return unfollowed response headers", async () => {
  const net = network(async () => ({ status: 302, location: "/end", noHeaders: true }));
  await assert.rejects(run(net, { follow_redirects: false }), { code: "REDIRECT_UNINSPECTABLE" });
  assert.equal(net.calls.length, 1);
});

test("ambiguous fallback headers cannot be returned as an unfollowed redirect", async () => {
  const net = network(async () => ({ status: 302, location: "/a", noHeaders: true, redirectHeaders: [
    { name: "Location", value: "/a" }, { name: "Location", value: "/b" },
  ] }));
  await assert.rejects(run(net, { follow_redirects: false }), { code: "REDIRECT_UNINSPECTABLE" });
});

test("ambiguous Location headers fail closed", async () => {
  const net = network(async () => ({ status: 302, location: "/a", headers: [
    { name: "Location", value: "/a" }, { name: "location", value: "/b" },
  ] }));
  await assert.rejects(run(net), { code: "REDIRECT_UNINSPECTABLE" });
  assert.equal(net.calls.length, 1);
});

test("conflicting response headers and browser redirect destinations fail closed", async () => {
  const net = network(async (_url, _init, emit) => {
    emit("onHeadersReceived", { statusCode: 302, responseHeaders: [{ name: "Location", value: "/first" }] });
    emit("onBeforeRedirect", { statusCode: 302, redirectUrl: `${other}/different` });
    return { status: 302, opaque: true, noHeaders: true };
  });
  await assert.rejects(run(net), { code: "REDIRECT_UNINSPECTABLE" });
  assert.equal(net.calls.length, 1);
});

test("metadata delivery after Fetch resolution is awaited without a retry", async () => {
  const net = network(async url => url.pathname === "/start" ? { status: 302, location: "/end" } : {});
  const { api } = net;
  let calls = 0;
  const delayed = observer.create(api, async (url, init) => {
    calls += 1;
    const wireUrl = new URL(url);
    wireUrl.hash = "";
    setTimeout(() => {
      const details = { url, method: init.method, requestId: "delayed", initiator: "chrome-extension://test" };
      api.webRequest.onBeforeRequest.emit(details);
      api.webRequest.onHeadersReceived.emit({ ...details, statusCode: 302, responseHeaders: [{ name: "Location", value: "/end" }] });
      api.webRequest.onBeforeRedirect.emit({ ...details, statusCode: 302, redirectUrl: `${origin}/end` });
    }, 10);
    return { type: "opaqueredirect", status: 0, url: wireUrl.href, headers: new Headers(), body: null };
  });
  const result = await delayed(request.url, { method: "GET", signal: new AbortController().signal }, true);
  assert.equal(result.redirect.location, "/end");
  assert.equal(calls, 1);
});

test("the whole-chain abort signal interrupts an unobservable redirect", async () => {
  const { api } = network(async () => ({}));
  const controller = new AbortController();
  let calls = 0;
  const missing = observer.create(api, async () => {
    calls += 1;
    return { type: "opaqueredirect", status: 0, url: request.url, headers: new Headers(), body: null };
  });
  const result = missing(request.url, { method: "POST", signal: controller.signal }, true);
  const timer = setTimeout(() => controller.abort(new Error("whole-chain deadline")), 10);
  try { await assert.rejects(result, /whole-chain deadline/); } finally { clearTimeout(timer); }
  assert.equal(calls, 1);
});

test("identical concurrent URLs use distinct metadata despite reordered events", async () => {
  const tags = [];
  const net = network(async (url, init, emit, details) => {
    tags.push(new URL(details.url).hash);
    if (url.pathname === "/start") {
      const name = init.headers.get("X-Caller");
      await new Promise(resolve => setTimeout(resolve, name === "one" ? 20 : 1));
      // Unrelated page traffic at exactly the same URL must not override state.
      emit("onHeadersReceived", { initiator: "https://page.example", statusCode: 302,
        responseHeaders: [{ name: "Location", value: "https://unrelated.example/" }] });
      return { status: 302, location: `/${name}` };
    }
    return { body: url.pathname };
  });
  const results = await Promise.all(["one", "two"].map(name => run(net, { headers: [["X-Caller", name]] })));
  assert.deepEqual(await Promise.all(results.map(result => result.response.text())), ["/one", "/two"]);
  assert.equal(new Set(tags).size, 4);
});

test("late events from an aborted request cannot authorize its replacement", async () => {
  const controller = new AbortController();
  let stale;
  const net = network(async (url, init, emit) => {
    if (!stale) {
      stale = emit;
      controller.abort(new Error("cancelled"));
      throw controller.signal.reason;
    }
    stale("onHeadersReceived", { statusCode: 302, responseHeaders: [{ name: "Location", value: "/wrong" }] });
    return { status: 302, opaque: true, noHeaders: true };
  });
  await assert.rejects(run(net, {}, undefined, controller), /cancelled/);
  await assert.rejects(run(net), { code: "REDIRECT_UNINSPECTABLE" });
  assert.equal(net.calls.length, 2);
});

test("cancellation stops the chain before the next hop", async () => {
  const controller = new AbortController();
  const net = network(async () => {
    controller.abort(new Error("deadline"));
    return { status: 302, location: "/end" };
  });
  await assert.rejects(run(net, {}, undefined, controller), /deadline/);
  assert.equal(net.calls.length, 1);
});

test("Firefox uses originUrl and blocks unexpected automatic URL rewrites", async () => {
  const net = network(async (_url, _init, emit, details) => {
    const unexpected = details.url.replace("example.com", "denied.example");
    assert.deepEqual(emit("onBeforeRequest", { url: unexpected }), [{ cancel: true }]);
    return { status: 302, location: "/end" };
  }, { firefox: true });
  await assert.rejects(run(net), { code: "REDIRECT_UNINSPECTABLE" });
});
