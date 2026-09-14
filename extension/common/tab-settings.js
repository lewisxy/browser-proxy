"use strict";

(function (root) {
  const maxConfigBytes = 64 * 1024;
  const maxTokenLength = 4096;
  const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
  const controlledHeaders = new Set([
    "accept-charset", "accept-encoding", "access-control-request-headers", "access-control-request-method",
    "authorization", "connection", "content-length", "cookie", "cookie2", "date", "dnt", "expect",
    "host", "keep-alive", "origin", "referer", "set-cookie", "set-cookie2", "te", "trailer",
    "transfer-encoding", "upgrade", "via",
  ]);

  function object(value, keys, label) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
      throw new Error(`Invalid ${label} or unknown field`);
    }
  }

  function text(value, label, max = 1024) {
    if (typeof value !== "string" || !value.length || value.length > max) throw new Error(`Invalid ${label}`);
    return value;
  }

  function url(value, base) {
    const parsed = new URL(text(value, "URL", 16384), base);
    BrowserProxyPolicy.parseRequestUrl(parsed.href);
    return parsed.href;
  }

  function jsonPath(value) {
    if (!Array.isArray(value) || !value.length || value.length > 16 || value.some(key =>
      typeof key !== "string" || !key.length || key.length > 256 || unsafeKeys.has(key))) {
      throw new Error("json_path must be an array of safe property names");
    }
    return value;
  }

  function source(value, pageUrl) {
    object(value, ["type", "name", "selector", "attribute", "property", "url", "json_path", "header"], "CSRF source");
    if (value.type === "cookie") {
      if (!/^[^\s=;]+$/.test(text(value.name, "cookie name", 256))) throw new Error("Invalid cookie name");
      object(value, ["type", "name"], "cookie source");
    } else if (value.type === "dom") {
      object(value, ["type", "selector", "attribute", "property"], "DOM source");
      text(value.selector, "DOM selector");
      if (value.attribute !== undefined) text(value.attribute, "DOM attribute", 256);
      if (value.property !== undefined && value.property !== "value") throw new Error("Only the DOM value property is supported");
      if (value.attribute && value.property) throw new Error("Choose attribute or property, not both");
    } else if (value.type === "bootstrap") {
      object(value, ["type", "url", "json_path", "header"], "bootstrap source");
      value = { ...value, url: url(value.url, pageUrl) };
      if (Boolean(value.json_path) === Boolean(value.header)) throw new Error("Bootstrap requires json_path or header");
      if (value.json_path) jsonPath(value.json_path);
      if (value.header) {
        text(value.header, "bootstrap response header", 256);
        if (/^set-cookie2?$/i.test(value.header)) throw new Error("Cookie response headers cannot be read");
        new Headers([[value.header, "test"]]);
      }
    } else {
      throw new Error("CSRF source type must be cookie, dom, or bootstrap");
    }
    return value;
  }

  function rule(value, pageUrl) {
    object(value, ["sources", "target", "transforms", "prefix", "methods"], "CSRF rule");
    if (!Array.isArray(value.sources) || !value.sources.length || value.sources.length > 8) throw new Error("CSRF rules need 1-8 sources");
    object(value.target, ["header", "form", "json_path"], "CSRF target");
    if (Object.keys(value.target).length !== 1) throw new Error("Choose one CSRF target: header, form, or json_path");
    if (value.target.header !== undefined) {
      const name = text(value.target.header, "CSRF header", 256).toLowerCase();
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || controlledHeaders.has(name) || /^(sec-|proxy-)/.test(name)) {
        throw new Error("CSRF cannot set browser-controlled or authorization headers");
      }
    }
    if (value.target.form !== undefined) text(value.target.form, "form field", 256);
    if (value.target.json_path !== undefined) jsonPath(value.target.json_path);
    const transforms = value.transforms ?? [];
    if (!Array.isArray(transforms) || transforms.length > 4 || transforms.some(item => !["trim", "url-decode", "base64-decode"].includes(item))) {
      throw new Error("Supported transforms: trim, url-decode, base64-decode");
    }
    const methods = value.methods ?? ["POST", "PUT", "PATCH", "DELETE"];
    if (!Array.isArray(methods) || !methods.length || methods.length > 16 || methods.some(method =>
      typeof method !== "string" || !/^[A-Z]+$/.test(method) || ["CONNECT", "TRACE", "TRACK"].includes(method))) {
      throw new Error("Invalid CSRF methods");
    }
    if ((value.target.form || value.target.json_path) && methods.some(method => ["GET", "HEAD"].includes(method))) {
      throw new Error("Body CSRF targets cannot apply to GET or HEAD");
    }
    const prefix = value.prefix ?? "";
    if (typeof prefix !== "string" || prefix.length > 256 || /[\r\n\0]/.test(prefix)) throw new Error("Invalid token prefix");
    return { sources: value.sources.map(item => source(item, pageUrl)), target: value.target, transforms, prefix, methods };
  }

  function normalize(config) {
    object(config, ["version", "profiles"], "tab configuration");
    if (config.version !== 1 || !Array.isArray(config.profiles) || config.profiles.length > 64 || new TextEncoder().encode(JSON.stringify(config)).length > maxConfigBytes) {
      throw new Error("Tab configuration requires version 1 and at most 64 profiles / 64 KiB");
    }
    const names = new Set();
    const profiles = config.profiles.map(profile => {
      object(profile, ["name", "origin", "page_url", "wait_for", "csrf"], "tab profile");
      const name = text(profile.name, "profile name", 64);
      if (!/^[A-Za-z0-9._-]+$/.test(name) || names.has(name)) throw new Error("Profile names must be unique safe ASCII names");
      names.add(name);
      const origin = new URL(url(profile.origin)).origin;
      if (profile.origin !== origin || origin.includes("*")) throw new Error("Profile origin must be an exact HTTP(S) origin without a trailing slash");
      const pageUrl = url(profile.page_url ?? `${origin}/`);
      if (profile.wait_for !== undefined) text(profile.wait_for, "readiness selector");
      if (profile.csrf !== undefined && (!Array.isArray(profile.csrf) || profile.csrf.length > 8)) throw new Error("At most 8 CSRF rules per profile");
      return { name, origin, page_url: pageUrl, ...(profile.wait_for ? { wait_for: profile.wait_for } : {}),
        csrf: (profile.csrf ?? []).map(item => rule(item, pageUrl)) };
    });
    const result = { version: 1, profiles };
    if (new TextEncoder().encode(JSON.stringify(result)).length > maxConfigBytes) throw new Error("Normalized profiles exceed 64 KiB");
    return result;
  }

  function request(value) {
    object(value, ["url", "id", "existing_only", "profile", "csrf"], "tab request");
    if (value.url !== undefined) url(value.url);
    if (value.id !== undefined && (!Number.isSafeInteger(value.id) || value.id < 0)) throw new Error("tab.id must be a nonnegative integer");
    if (value.profile !== undefined && (typeof value.profile !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(value.profile))) throw new Error("Invalid tab profile name");
    for (const key of ["existing_only", "csrf"]) {
      if (value[key] !== undefined && typeof value[key] !== "boolean") throw new Error(`tab.${key} must be boolean`);
    }
    return value;
  }

  function select(config, origin, name) {
    const profiles = normalize(config).profiles.filter(profile => profile.origin === origin && (!name || profile.name === name));
    if (profiles.length > 1) throw new Error("Multiple tab profiles match; select one with --tab-profile");
    if (name && !profiles.length) throw new Error("Tab profile does not exist or does not match the API origin");
    return profiles[0];
  }

  function extractJson(value, path) {
    for (const key of path) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return null;
      value = value[key];
    }
    return typeof value === "string" ? value : null;
  }

  async function apply(rules, init, resolve) {
    const result = { ...init, headers: new Headers(init.headers) };
    for (const item of rules) {
      if (!item.methods.includes(init.method)) continue;
      let token;
      for (const candidate of item.sources) {
        token = await resolve(candidate);
        if (typeof token === "string" && token.length) break;
      }
      if (typeof token !== "string" || !token.length || token.length > maxTokenLength) throw new Error("CSRF_TOKEN_UNAVAILABLE");
      try {
        for (const transform of item.transforms) {
          if (transform === "trim") token = token.trim();
          if (transform === "url-decode") token = decodeURIComponent(token);
          if (transform === "base64-decode") token = atob(token);
        }
      } catch { throw new Error("CSRF_TOKEN_INVALID"); }
      token = item.prefix + token;
      if (!token.length || token.length > maxTokenLength || /[\r\n\0]/.test(token)) throw new Error("CSRF_TOKEN_INVALID");
      const target = item.target;
      if (target.header) {
        // Browser-derived values replace caller values; they never enter hop history.
        result.headers.set(target.header, token);
      } else {
        const contentType = result.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
        const body = new TextDecoder("utf-8", { fatal: true }).decode(result.body);
        if (target.form && contentType === "application/x-www-form-urlencoded") {
          const form = new URLSearchParams(body);
          form.set(target.form, token);
          result.body = new TextEncoder().encode(form.toString());
        } else if (target.json_path && (contentType === "application/json" || contentType?.endsWith("+json"))) {
          const data = JSON.parse(body);
          let cursor = data;
          for (const [index, key] of target.json_path.entries()) {
            if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) throw new Error("CSRF_BODY_INVALID");
            if (index === target.json_path.length - 1) cursor[key] = token;
            else {
              if (!Object.hasOwn(cursor, key)) cursor[key] = {};
              cursor = cursor[key];
            }
          }
          result.body = new TextEncoder().encode(JSON.stringify(data));
        } else throw new Error("CSRF_BODY_INVALID");
        if (result.body.length > 16 * 1024 * 1024) throw new Error("CSRF_BODY_TOO_LARGE");
      }
    }
    if (Array.from(result.headers).length > 128) throw new Error("CSRF_HEADERS_TOO_LARGE");
    return result;
  }

  root.BrowserProxyTabSettings = { normalize, request, select, extractJson, apply, maxConfigBytes };
  if (typeof module !== "undefined" && module.exports) module.exports = root.BrowserProxyTabSettings;
})(globalThis);
