"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const allowlistFile = require("../extension/common/allowlist-file.js");

test("serializes and parses a canonical versioned allowlist", () => {
  const serialized = allowlistFile.serialize([
    " HTTPS://API.EXAMPLE.COM ",
    "https://api.example.com",
    "http://localhost:*",
  ]);
  assert.deepEqual(JSON.parse(serialized), {
    format: "browser-proxy-allowlist",
    version: 1,
    allowlist: ["https://api.example.com", "http://localhost:*"],
  });
  assert.deepEqual(allowlistFile.parse(serialized), [
    "https://api.example.com",
    "http://localhost:*",
  ]);
});

test("rejects invalid formats without returning partial rules", () => {
  assert.throws(() => allowlistFile.parse("not json"), /not valid JSON/);
  assert.throws(
    () => allowlistFile.parse('{"format":"browser-proxy-allowlist","version":2,"allowlist":[]}'),
    /format version 1/,
  );
  assert.throws(
    () =>
      allowlistFile.parse(
        '{"format":"browser-proxy-allowlist","version":1,"allowlist":["https://good.example","https://bad.example/path"]}',
      ),
    /paths/,
  );
});

test("rejects non-string rules and oversized files", () => {
  assert.throws(
    () => allowlistFile.parse('{"format":"browser-proxy-allowlist","version":1,"allowlist":[42]}'),
    /must be a string/,
  );
  assert.throws(() => allowlistFile.parse("x".repeat(allowlistFile.maxFileBytes + 1)), /cannot exceed/);
});

test("rejects more than 1000 rules", () => {
  const contents = JSON.stringify({
    format: "browser-proxy-allowlist",
    version: 1,
    allowlist: Array.from({ length: 1001 }, (_, index) => `https://host-${index}.example`),
  });
  assert.throws(() => allowlistFile.parse(contents), /cannot contain more than 1000 rules/);
});
