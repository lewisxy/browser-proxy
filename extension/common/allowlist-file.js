"use strict";

(function (root) {
  const formatName = "browser-proxy-allowlist";
  const formatVersion = 1;
  const maxFileBytes = 1024 * 1024;
  const maxRules = 1000;
  const policy = root.BrowserProxyPolicy || (typeof require !== "undefined" ? require("./policy.js") : null);

  function normalize(values) {
    if (!Array.isArray(values)) {
      throw new Error("allowlist must be an array");
    }
    if (values.length > maxRules) {
      throw new Error(`An allowlist file cannot contain more than ${maxRules} rules`);
    }
    if (!values.every((value) => typeof value === "string")) {
      throw new Error("Every allowlist entry must be a string");
    }
    return policy.normalizeRules(values).map((rule) => rule.canonical);
  }

  function parse(text) {
    if (typeof text !== "string" || new TextEncoder().encode(text).length > maxFileBytes) {
      throw new Error(`Allowlist files cannot exceed ${maxFileBytes} bytes`);
    }
    let document;
    try {
      document = JSON.parse(text);
    } catch {
      throw new Error("The selected file is not valid JSON");
    }
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      throw new Error("The allowlist file must contain a JSON object");
    }
    if (document.format !== formatName || document.version !== formatVersion) {
      throw new Error(`Expected ${formatName} format version ${formatVersion}`);
    }
    return normalize(document.allowlist);
  }

  function serialize(values) {
    return `${JSON.stringify(
      {
        format: formatName,
        version: formatVersion,
        allowlist: normalize(values),
      },
      null,
      2,
    )}\n`;
  }

  const allowlistFile = { formatName, formatVersion, maxFileBytes, maxRules, parse, serialize };
  root.BrowserProxyAllowlistFile = allowlistFile;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = allowlistFile;
  }
})(globalThis);
