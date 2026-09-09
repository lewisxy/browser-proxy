"use strict";

(function (root) {
  const HTTP_SCHEMES = new Set(["http", "https", "*"]);

  function parseHost(value) {
    if (value === "*") {
      return { host: "*", wildcard: true };
    }

    const wildcard = value.startsWith("*.");
    const candidate = wildcard ? value.slice(2) : value;
    if (!candidate || candidate.includes("*")) {
      throw new Error("The host wildcard is only allowed as '*.' at the start");
    }

    let normalized;
    try {
      const parsed = new URL(`http://${candidate}`);
      if (parsed.username || parsed.password || parsed.port || parsed.hostname !== candidate.toLowerCase()) {
        throw new Error();
      }
      normalized = parsed.hostname.toLowerCase();
    } catch {
      throw new Error(`Invalid host: ${candidate}`);
    }

    if (wildcard && (normalized.startsWith("[") || /^\d+(?:\.\d+){3}$/.test(normalized))) {
      throw new Error("Subdomain wildcards cannot be used with IP addresses");
    }

    return { host: wildcard ? `*.${normalized}` : normalized, wildcard };
  }

  function parseRule(value) {
    if (typeof value !== "string") {
      throw new Error("Allowlist rules must be strings");
    }

    const original = value.trim();
    if (!original || original.length > 512 || /\s/.test(original)) {
      throw new Error("A rule must be a non-empty origin without whitespace");
    }

    const separator = original.indexOf("://");
    if (separator < 1) {
      throw new Error("A rule must include a scheme, for example https://example.com");
    }

    const scheme = original.slice(0, separator).toLowerCase();
    if (!HTTP_SCHEMES.has(scheme)) {
      throw new Error("Only http, https, or * schemes are supported");
    }

    let authority = original.slice(separator + 3);
    if (!authority || /[/?#@]/.test(authority)) {
      throw new Error("Rules contain only an origin; paths, credentials, queries, and fragments are not allowed");
    }

    let hostText = authority;
    let portText = null;
    if (authority.startsWith("[")) {
      const end = authority.indexOf("]");
      if (end < 0) {
        throw new Error("Invalid IPv6 host");
      }
      hostText = authority.slice(0, end + 1);
      const remainder = authority.slice(end + 1);
      if (remainder) {
        if (!remainder.startsWith(":")) {
          throw new Error("Invalid origin");
        }
        portText = remainder.slice(1);
      }
    } else {
      const colon = authority.lastIndexOf(":");
      if (colon >= 0) {
        hostText = authority.slice(0, colon);
        portText = authority.slice(colon + 1);
      }
    }

    const { host, wildcard } = parseHost(hostText.toLowerCase());
    let port = null;
    if (portText !== null) {
      if (portText === "*") {
        port = "*";
      } else if (/^\d{1,5}$/.test(portText) && Number(portText) >= 1 && Number(portText) <= 65535) {
        port = String(Number(portText));
      } else {
        throw new Error("A port must be between 1 and 65535, or *");
      }
    }

    return {
      scheme,
      host,
      hostWildcard: wildcard,
      port,
      canonical: `${scheme}://${host}${port === null ? "" : `:${port}`}`,
    };
  }

  function effectivePort(url) {
    if (url.port) {
      return url.port;
    }
    return url.protocol === "https:" ? "443" : "80";
  }

  function ruleMatches(rule, url) {
    const scheme = url.protocol.slice(0, -1).toLowerCase();
    if (rule.scheme !== "*" && rule.scheme !== scheme) {
      return false;
    }

    const hostname = url.hostname.toLowerCase();
    if (rule.host !== "*") {
      if (rule.hostWildcard) {
        const suffix = rule.host.slice(2);
        if (hostname !== suffix && !hostname.endsWith(`.${suffix}`)) {
          return false;
        }
      } else if (hostname !== rule.host) {
        return false;
      }
    }

    if (rule.port === "*") {
      return true;
    }
    if (rule.port !== null) {
      return effectivePort(url) === rule.port;
    }
    return effectivePort(url) === (scheme === "https" ? "443" : "80");
  }

  function parseRequestUrl(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error("The request URL is invalid");
    }
    if (!/^https?:$/.test(url.protocol)) {
      throw new Error("Only HTTP and HTTPS request URLs are supported");
    }
    if (url.username || url.password) {
      throw new Error("Credentials in request URLs are not allowed");
    }
    return url;
  }

  function normalizeRules(values) {
    const rules = [];
    const seen = new Set();
    for (const value of values) {
      const parsed = parseRule(value);
      if (!seen.has(parsed.canonical)) {
        seen.add(parsed.canonical);
        rules.push(parsed);
      }
    }
    return rules;
  }

  function isAllowed(value, values) {
    const url = parseRequestUrl(value);
    return normalizeRules(values).some((rule) => ruleMatches(rule, url));
  }

  const policy = { isAllowed, normalizeRules, parseRequestUrl, parseRule, ruleMatches };
  root.BrowserProxyPolicy = policy;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = policy;
  }
})(globalThis);
