"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
globalThis.BrowserProxyPolicy = require("../extension/common/policy.js");
const settings = require("../extension/common/tab-settings.js");

const base = { name: "app", origin: "https://api.example.com", page_url: "https://app.example.com/start" };
const cookie = { type: "cookie", name: "XSRF-TOKEN" };
const binding = { sources: [cookie], target: { header: "X-XSRF-TOKEN" } };
const config = profile => ({ version: 1, profiles: [{ ...base, ...profile }] });
const rules = (...csrf) => settings.normalize(config({ csrf })).profiles[0].csrf;
const init = (body = "{}", contentType = "application/json") => ({
  method: "POST", headers: new Headers({ "Content-Type": contentType }), body: new TextEncoder().encode(body),
});

test("profiles use exact API origins, resolve bootstrap URLs against the application, and reject ambiguity", () => {
  const value = settings.normalize(config({ csrf: [{ ...binding, sources: [{ type: "bootstrap", url: "/csrf", json_path: ["token"] }] }] }));
  assert.equal(value.profiles[0].csrf[0].sources[0].url, "https://app.example.com/csrf");
  assert.equal(settings.select(value, base.origin).name, "app");
  assert.equal(settings.select(value, "https://api.example.com.evil"), undefined);
  assert.throws(() => settings.select(value, "https://other.example", "app"));
  value.profiles.push({ ...value.profiles[0], name: "second" });
  assert.throws(() => settings.select(value, base.origin), /Multiple/);
  assert.equal(settings.select(value, base.origin, "second").name, "second");
});

test("malformed profiles, executable hooks, forbidden headers, and prototype paths are rejected", () => {
  const bad = [
    { origin: "https://*.example.com" }, { origin: `${base.origin}/` }, { page_url: "javascript:alert(1)" },
    { page_url: "https://user:password@example.com" }, { script: "fetch('/api')" },
    { csrf: [{ ...binding, sources: [{ type: "javascript", code: "1" }] }] },
    { csrf: [{ ...binding, sources: [{ type: "bootstrap", url: "/csrf", header: "Set-Cookie" }] }] },
    { csrf: [{ ...binding, target: { json_path: ["__proto__", "token"] } }] },
    { csrf: [{ ...binding, target: { form: "csrf" }, methods: ["GET"] }] },
    ...["Cookie", "Origin", "Referer", "Authorization", "Sec-Fetch-Site", "Proxy-Authorization", "Content-Length"].map(header =>
      ({ csrf: [{ ...binding, target: { header } }] })),
  ];
  for (const profile of bad) assert.throws(() => settings.normalize(config(profile)), JSON.stringify(profile));
  assert.throws(() => settings.request({ id: -1 }));
  assert.throws(() => settings.request({ profile: 1 }));
  assert.throws(() => settings.request({ csrf: "true" }));
  assert.throws(() => settings.request({ allowlist: ["*://*"] }));
});

test("CSRF sources fall back in order, transform tokens, override caller values, and preserve the original request", async () => {
  const original = init();
  original.headers.set("X-XSRF-TOKEN", "stale");
  const calls = [];
  const configured = rules({ ...binding, sources: [cookie, { type: "dom", selector: "meta", attribute: "content" }], transforms: ["url-decode", "trim"], prefix: "Token " });
  const result = await settings.apply(configured, original, async source => {
    calls.push(source.type);
    return source.type === "cookie" ? null : "%20fresh%2Btoken%20";
  });
  assert.deepEqual(calls, ["cookie", "dom"]);
  assert.equal(result.headers.get("x-xsrf-token"), "Token fresh+token");
  assert.equal(original.headers.get("x-xsrf-token"), "stale");
  assert.strictEqual(result.body, original.body);
  await settings.apply(configured, { ...original, method: "GET" }, () => assert.fail("GET does not need a token"));
});

test("CSRF injection supports nested JSON and URL-encoded form bodies", async () => {
  const json = await settings.apply(rules({ ...binding, target: { json_path: ["security", "csrf"] } }), init('{"value":42}'), async () => "a+b&c");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(json.body)), { value: 42, security: { csrf: "a+b&c" } });
  const form = await settings.apply(rules({ ...binding, target: { form: "csrf" } }), init("value=42&csrf=stale", "application/x-www-form-urlencoded"), async () => "a+b&c");
  assert.equal(new TextDecoder().decode(form.body), "value=42&csrf=a%2Bb%26c");
  await assert.rejects(settings.apply(rules({ ...binding, target: { form: "csrf" } }), init(), async () => "token"), /CSRF_BODY_INVALID/);
  await assert.rejects(settings.apply(rules({ ...binding, target: { json_path: ["csrf"] } }), init("[]"), async () => "token"), /CSRF_BODY_INVALID/);
});

test("missing, invalid, and oversized tokens fail without revealing token contents", async () => {
  for (const token of [null, "", "secret\r\nvalue", "x".repeat(4097)]) {
    await assert.rejects(settings.apply(rules(binding), init(), async () => token), /^Error: CSRF_TOKEN_(UNAVAILABLE|INVALID)$/);
  }
  await assert.rejects(settings.apply(rules({ ...binding, transforms: ["url-decode"] }), init(), async () => "%invalid-secret"), /^Error: CSRF_TOKEN_INVALID$/);
  assert.equal(settings.extractJson({ security: { token: "fresh" } }, ["security", "token"]), "fresh");
  assert.equal(settings.extractJson({}, ["toString"]), null);
});
