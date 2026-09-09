"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../extension/common/policy.js");

test("normalizes and deduplicates origin rules", () => {
  const rules = policy.normalizeRules([
    " HTTPS://API.EXAMPLE.COM ",
    "https://api.example.com",
    "http://localhost:*",
  ]);
  assert.deepEqual(
    rules.map((rule) => rule.canonical),
    ["https://api.example.com", "http://localhost:*"],
  );
});

test("matches schemes, subdomains, base hosts, and ports", () => {
  assert.equal(policy.isAllowed("https://example.com/path", ["*://*.example.com"]), true);
  assert.equal(policy.isAllowed("http://a.b.example.com:80/path", ["*://*.example.com"]), true);
  assert.equal(policy.isAllowed("https://api.example.com:8443/path", ["https://api.example.com:*"]), true);
  assert.equal(policy.isAllowed("https://api.example.com:8443/path", ["https://api.example.com"]), false);
  assert.equal(policy.isAllowed("https://notexample.com/path", ["*://*.example.com"]), false);
});

test("handles exact IPv4 and IPv6 origins", () => {
  assert.equal(policy.isAllowed("http://127.0.0.1:8080/a", ["http://127.0.0.1:8080"]), true);
  assert.equal(policy.isAllowed("http://[::1]:9000/a", ["http://[::1]:*"]), true);
});

test("rejects paths, URL credentials, and malformed wildcards", () => {
  assert.throws(() => policy.parseRule("https://example.com/api"), /origin/);
  assert.throws(() => policy.parseRule("https://foo.*.example.com"), /wildcard/);
  assert.throws(() => policy.parseRequestUrl("https://user:password@example.com"), /Credentials/);
  assert.throws(() => policy.parseRequestUrl("file:///tmp/test"), /HTTP/);
});
