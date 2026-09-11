#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const mcpServer = path.join(
  path.dirname(require.resolve("chrome-devtools-mcp")),
  "bin",
  "chrome-devtools-mcp.js",
);
const runtimeRoot = path.join(root, ".browser-proxy");
const profile = path.join(runtimeRoot, "chrome-mcp-profile");
const chromeRuntime = path.join(runtimeRoot, "chrome-mcp-run");
const chromeSocket = path.join(chromeRuntime, "chrome.sock");
const largeResponseFile = path.join(runtimeRoot, "chrome-large-response.bin");
const extensionPath = path.join(root, "dist", "chrome");
const venvScripts = path.join(root, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const chromeDefaults = {
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  linux: "/usr/bin/google-chrome",
  win32: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
};
const chromePath = process.env.CHROME_PATH || chromeDefaults[process.platform];
const expectedExtensionId = "gkldokmonobnekdblegmdbfjmjeghdjh";

if (!chromePath || !fs.existsSync(chromePath)) {
  throw new Error("Chrome was not found. Set CHROME_PATH to the browser executable.");
}

fs.mkdirSync(runtimeRoot, { recursive: true });
fs.rmSync(profile, { recursive: true, force: true });
fs.rmSync(chromeRuntime, { recursive: true, force: true });
fs.rmSync(largeResponseFile, { force: true });
const profileNativeManifest = path.join(
  profile,
  "NativeMessagingHosts",
  "com.browserproxy.native.json",
);
fs.mkdirSync(path.dirname(profileNativeManifest), { recursive: true });
fs.writeFileSync(
  profileNativeManifest,
  `${JSON.stringify(
    {
      name: "com.browserproxy.native",
      description: "Browser Proxy local request relay",
      path: path.join(venvScripts, process.platform === "win32" ? "browser-proxy-host.exe" : "browser-proxy-host"),
      type: "stdio",
      allowed_origins: [`chrome-extension://${expectedExtensionId}/`],
    },
    null,
    2,
  )}\n`,
);

let echoRequests = 0;
let deniedRedirectRequests = 0;
const redirectGates = new Map();
const redirectHits = new Map();
const deniedServer = http.createServer((_request, response) => {
  deniedRedirectRequests += 1;
  response.writeHead(302, { Location: `${baseUrl}/echo` });
  response.end();
});
await new Promise(resolve => deniedServer.listen(0, "127.0.0.1", resolve));
const largeResponseBytes = 70 * 1024 * 1024 + 17;
let resumeLargeResponse;

function largeResponse(response, compressed) {
  response.setHeader("Content-Type", "application/octet-stream");
  if (compressed) {
    response.setHeader("Content-Encoding", "gzip");
  } else {
    response.setHeader("Content-Length", largeResponseBytes);
  }
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  if (!compressed) resumeLargeResponse = resume;
  response.once("close", resume);
  const source = Readable.from((async function* () {
    const chunk = Buffer.alloc(64 * 1024, 0xa5);
    for (let offset = 0; offset < largeResponseBytes; offset += chunk.length) {
      yield chunk.subarray(0, Math.min(chunk.length, largeResponseBytes - offset));
      if (offset === 0 && !compressed) await gate;
    }
  })());
  // pipeline propagates a cancelled download back to the generator.
  const streams = compressed ? [source, createGzip(), response] : [source, response];
  void pipeline(...streams).catch(() => {});
}

async function assertLargeFile(filename) {
  assert.equal(fs.statSync(filename).size, largeResponseBytes);
  const actual = createHash("sha256");
  for await (const chunk of fs.createReadStream(filename)) actual.update(chunk);
  const expected = createHash("sha256");
  const block = Buffer.alloc(64 * 1024, 0xa5);
  for (let offset = 0; offset < largeResponseBytes; offset += block.length) {
    expected.update(block.subarray(0, Math.min(block.length, largeResponseBytes - offset)));
  }
  assert.equal(actual.digest("hex"), expected.digest("hex"));
}

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const parsed = new URL(request.url, "http://localhost");
    if (["/r", "/r-cache", "/r-gated"].includes(parsed.pathname)) {
      redirectHits.set(request.url, (redirectHits.get(request.url) || 0) + 1);
      const send = () => {
        response.setHeader("Location", parsed.searchParams.get("to") || "/echo");
        response.setHeader("X-Redirect-Test", request.headers["x-test"] || "redirect");
        response.setHeader("Vary", "X-Test");
        if (parsed.pathname === "/r-cache") response.setHeader("Cache-Control", "max-age=3600");
        if (parsed.searchParams.has("cookie")) response.setHeader("Set-Cookie", "redirect_cookie=hop-secret; HttpOnly; SameSite=Lax; Path=/");
        response.statusCode = Number(parsed.searchParams.get("status") || 302);
        response.end("redirecting");
      };
      if (parsed.pathname === "/r-gated") redirectGates.set(parsed.searchParams.get("gate"), send);
      else send();
      return;
    }
    if (request.url === "/login") {
      response.setHeader("Set-Cookie", [
        "proxy_lax=browser-secret; HttpOnly; SameSite=Lax; Path=/",
        "proxy_secure=secure-secret; HttpOnly; SameSite=None; Secure; Path=/",
      ]);
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end("<!doctype html><title>Cookie ready</title><h1>Cookie ready</h1>");
      return;
    }
    if (request.url === "/redirect") {
      response.statusCode = 302;
      response.setHeader("Location", `http://127.0.0.1:${server.address().port}/echo`);
      response.setHeader("Content-Type", "text/plain");
      response.setHeader("Content-Length", Buffer.byteLength("redirecting"));
      response.setHeader("Set-Cookie", "unfollowed_cookie=hidden-secret; HttpOnly; SameSite=Lax; Path=/");
      response.end("redirecting");
      return;
    }
    if (request.url === "/echo") {
      echoRequests += 1;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          method: request.method,
          cookie: request.headers.cookie || "",
          testHeader: request.headers["x-test"] || "",
          body: Buffer.concat(chunks).toString("utf8"),
          bodyBase64: Buffer.concat(chunks).toString("base64"),
          authorization: request.headers.authorization || "",
          contentType: request.headers["content-type"] || "",
        }),
      );
      return;
    }
    if (request.url === "/large" || request.url === "/large-gzip") {
      largeResponse(response, request.url === "/large-gzip");
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const port = server.address().port;
const baseUrl = `http://localhost:${port}`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    mcpServer,
    "--headless",
    "--executable-path",
    chromePath,
    "--user-data-dir",
    profile,
    "--log-file",
    path.join(runtimeRoot, "chrome-mcp.log"),
    "--category-extensions",
    "--experimental-structured-content",
    "--no-usage-statistics",
    "--no-performance-crux",
    "--allow-unrestricted-paths",
    "--viewport",
    "1280x800",
  ],
  env: {
    ...process.env,
    CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "true",
    BROWSER_PROXY_RUNTIME_DIR: chromeRuntime,
  },
  stderr: "pipe",
});
const client = new Client(
  { name: "browser-proxy-chrome-test", version: "1.0.0" },
  { capabilities: {} },
);

function resultText(result) {
  return (result.content || [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(`${name} failed: ${resultText(result)}`);
  }
  return result;
}

async function waitForFile(filename, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filename)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${filename}`);
}

const results = {
  mcpFlags: ["--no-usage-statistics", "--user-data-dir", profile, "--category-extensions"],
  extensionId: "",
  nativeConnected: false,
  cookieNamesSeen: [],
  requestMethod: "",
  redirectBlocked: false,
  unfollowedRedirectPassed: false,
  liveHeadRedirectStatus: null,
  redirectsPassed: false,
  cachedRedirectPassed: false,
  redirectRevocationPassed: false,
  hstsRedirectPassed: false,
  deniedOriginBlocked: false,
  foregroundPageAdded: false,
  popupDetectedOrigin: false,
  popupAddedOrigin: false,
  allowlistImportPassed: false,
  nativeReconnectPassed: false,
  largeResponsePassed: false,
  incrementalOutputPassed: false,
  compressedStreamingPassed: false,
  popupScreenshot: "",
  desktopScreenshot: "",
  mobileScreenshot: "",
};

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert(tools.tools.some((tool) => tool.name === "install_extension"));

  const installed = await call("install_extension", { path: extensionPath });
  assert.match(resultText(installed), new RegExp(expectedExtensionId));
  results.extensionId = expectedExtensionId;

  const listed = await call("list_extensions");
  assert.match(resultText(listed), new RegExp(`id=${expectedExtensionId}.*Enabled`));

  const loginPageResult = await call("new_page", {
    url: `${baseUrl}/login`,
    background: true,
    timeout: 30000,
  });
  const loginPage = loginPageResult.structuredContent.pages.find((page) => page.url === `${baseUrl}/login`);
  assert(loginPage, "login page was not listed by MCP");
  await call("select_page", { pageId: loginPage.id, bringToFront: true });
  await call("trigger_extension_action", { id: expectedExtensionId });
  const popupPageResult = await call("new_page", {
    url: `chrome-extension://${expectedExtensionId}/popup.html`,
    background: true,
    timeout: 30000,
  });
  const popupPage = (popupPageResult.structuredContent.extensionPages || []).find((page) =>
    page.url.startsWith(`chrome-extension://${expectedExtensionId}/popup.html`),
  );
  assert(popupPage, "extension popup was not listed by MCP");
  const popupSnapshot = await call("take_snapshot", { pageId: popupPage.id });
  assert.match(resultText(popupSnapshot), new RegExp(baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(resultText(popupSnapshot), /Not allowed/);
  results.popupDetectedOrigin = true;
  const popupResult = await call("evaluate_script", {
    pageId: popupPage.id,
    function: `async () => {
      document.querySelector('#allow-origin').click();
      await new Promise(resolve => setTimeout(resolve, 250));
      const {allowlist} = await chrome.storage.local.get({allowlist: []});
      return {
        status: document.querySelector('#origin-status').textContent,
        buttonHidden: document.querySelector('#allow-origin').hidden,
        allowlist
      };
    }`,
  });
  assert.match(resultText(popupResult), /Allowed by your rules/);
  assert.match(resultText(popupResult), /"buttonHidden":true/);
  assert.match(resultText(popupResult), new RegExp(baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  results.popupAddedOrigin = true;
  results.popupScreenshot = path.join(runtimeRoot, "chrome-popup.png");
  await call("take_screenshot", { pageId: popupPage.id, filePath: results.popupScreenshot });

  const optionsPageResult = await call("new_page", {
    url: `chrome-extension://${expectedExtensionId}/options.html`,
    background: true,
    timeout: 30000,
  });
  const extensionPages = optionsPageResult.structuredContent.extensionPages || [];
  const optionsPage = extensionPages.find((page) =>
    page.url.startsWith(`chrome-extension://${expectedExtensionId}/options.html`),
  );
  assert(optionsPage, "options page was not listed by MCP");

  const configured = await call("evaluate_script", {
    pageId: optionsPage.id,
    function: `async () => {
      const imported = {
        format: 'browser-proxy-allowlist',
        version: 1,
        allowlist: [${JSON.stringify(baseUrl)}, 'https://*.imported.example']
      };
      const transfer = new DataTransfer();
      transfer.items.add(new File([JSON.stringify(imported)], 'allowlist.json', {type: 'application/json'}));
      const input = document.querySelector('#import-file');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', {bubbles: true}));
      await new Promise(resolve => setTimeout(resolve, 250));
      const {allowlist} = await chrome.storage.local.get({allowlist: []});
      const importMessage = document.querySelector('#message').textContent;
      const originalCreateObjectURL = URL.createObjectURL;
      const originalRevokeObjectURL = URL.revokeObjectURL;
      const originalAnchorClick = HTMLAnchorElement.prototype.click;
      let exportBlob;
      let downloadName;
      URL.createObjectURL = blob => {
        exportBlob = blob;
        return 'blob:browser-proxy-test';
      };
      URL.revokeObjectURL = () => {};
      HTMLAnchorElement.prototype.click = function () {
        downloadName = this.download;
      };
      document.querySelector('#export').click();
      await new Promise(resolve => setTimeout(resolve, 250));
      const exported = JSON.parse(await exportBlob.text());
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
      HTMLAnchorElement.prototype.click = originalAnchorClick;
      return {
        title: document.querySelector('h1').textContent,
        importMessage,
        exportMessage: document.querySelector('#message').textContent,
        downloadName,
        allowlist,
        exported,
        mobileRulePresent: Array.from(document.styleSheets).some(sheet =>
          Array.from(sheet.cssRules || []).some(rule => rule.cssText.includes('@media (max-width: 640px)'))
        )
      };
    }`,
  });
  const configuredText = resultText(configured);
  assert.match(configuredText, /Browser Proxy/);
  assert.match(configuredText, /Imported and saved 2 origin rules/);
  assert.match(configuredText, /Exported 2 saved origin rules/);
  assert.match(configuredText, /browser-proxy-allowlist\.json/);
  assert.match(configuredText, /browser-proxy-allowlist/);
  assert.match(configuredText, /"version":1/);
  assert.match(configuredText, /https:\/\/\*\.imported\.example/);
  assert.match(configuredText, /mobileRulePresent/);
  results.allowlistImportPassed = true;

  const snapshot = await call("take_snapshot", { pageId: optionsPage.id });
  assert.match(resultText(snapshot), /Allowed origins/);
  assert.match(resultText(snapshot), /Import JSON/);
  assert.match(resultText(snapshot), /Export JSON/);
  assert.match(resultText(snapshot), /Redirects/);

  results.desktopScreenshot = path.join(runtimeRoot, "chrome-options-desktop.png");
  await call("take_screenshot", { pageId: optionsPage.id, filePath: results.desktopScreenshot });
  await call("emulate", { pageId: optionsPage.id, viewport: "390x844x1,mobile,touch" });
  const mobileViewport = await call("evaluate_script", {
    pageId: optionsPage.id,
    function: "() => ({width: window.innerWidth, height: window.innerHeight})",
  });
  assert.match(resultText(mobileViewport), /"width":390/);
  results.mobileScreenshot = path.join(runtimeRoot, "chrome-options-mobile.png");
  await call("take_screenshot", { pageId: optionsPage.id, filePath: results.mobileScreenshot });

  const pagesBefore = await call("list_pages");
  const beforeCount = pagesBefore.structuredContent.pages.length;
  const proxyWorker = (pagesBefore.structuredContent.extensionServiceWorkers || []).find((worker) =>
    worker.url.startsWith(`chrome-extension://${expectedExtensionId}/`),
  );
  assert(proxyWorker, "extension service worker was not listed by MCP");
  const nativeState = await call("evaluate_script", {
    serviceWorkerId: proxyWorker.id,
    function: "() => ({connected: Boolean(nativePort), error: lastNativeError})",
  });
  try {
    await waitForFile(chromeSocket);
  } catch (error) {
    throw new Error(`${error.message}; service worker state: ${resultText(nativeState)}`);
  }
  results.nativeConnected = true;

  const reconnectResult = await call("evaluate_script", {
    pageId: optionsPage.id,
    function: `async () => {
      const button = document.querySelector('#reconnect');
      button.click();
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
        const message = document.querySelector('#message').textContent;
        if (message !== 'Reconnecting...') {
          return {
            message,
            connection: document.querySelector('#connection').textContent,
            disabled: button.disabled
          };
        }
      }
      return {message: 'Timed out in Chrome harness'};
    }`,
  });
  assert.match(resultText(reconnectResult), /Native host reconnected/);
  assert.match(resultText(reconnectResult), /Native host connected/);
  assert.match(resultText(reconnectResult), /"disabled":false/);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await waitForFile(chromeSocket);
  results.nativeReconnectPassed = true;

  const cli = path.join(venvScripts, process.platform === "win32" ? "browser-proxy.exe" : "browser-proxy");
  const successful = await execFileAsync(
    cli,
    [
      "--browser",
      "chrome",
      "-H",
      "X-Test: chrome-mcp",
      "--json",
      '{"hello":"world"}',
      `${baseUrl}/echo`,
    ],
    {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, BROWSER_PROXY_RUNTIME_DIR: chromeRuntime },
    },
  );
  const echoed = JSON.parse(successful.stdout);
  results.cookieNamesSeen = echoed.cookie
    .split(";")
    .map((cookie) => cookie.trim().split("=", 1)[0])
    .filter(Boolean);
  results.requestMethod = echoed.method;
  assert.equal(echoed.method, "POST");
  assert.equal(echoed.testHeader, "chrome-mcp");
  assert.equal(echoed.body, '{"hello":"world"}');
  assert(results.cookieNamesSeen.includes("proxy_lax"), "HttpOnly SameSite=Lax cookie was not sent");

  const download = execFileAsync(cli, ["--browser", "chrome", "--max-time", "120", "-o", largeResponseFile, `${baseUrl}/large`], {
    encoding: "utf8",
    env: { ...process.env, BROWSER_PROXY_RUNTIME_DIR: chromeRuntime },
  });
  // Handle early rejection while checking that output precedes response completion.
  let downloadError;
  const completedDownload = download.catch((error) => { downloadError = error; });
  try {
    await waitForFile(largeResponseFile);
    const deadline = Date.now() + 10000;
    while (fs.statSync(largeResponseFile).size === 0 && Date.now() < deadline && !downloadError) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (downloadError) throw downloadError;
    assert(fs.statSync(largeResponseFile).size > 0, "CLI buffered the response instead of writing incrementally");
    assert(fs.statSync(largeResponseFile).size < largeResponseBytes);
    results.incrementalOutputPassed = true;
  } finally {
    resumeLargeResponse?.();
    await completedDownload;
  }
  if (downloadError) throw downloadError;
  await assertLargeFile(largeResponseFile);
  fs.rmSync(largeResponseFile, { force: true });
  results.largeResponsePassed = true;

  await execFileAsync(cli, ["--browser", "chrome", "--max-time", "120", "-o", largeResponseFile, `${baseUrl}/large-gzip`], {
    encoding: "utf8",
    env: { ...process.env, BROWSER_PROXY_RUNTIME_DIR: chromeRuntime },
  });
  await assertLargeFile(largeResponseFile);
  fs.rmSync(largeResponseFile, { force: true });
  results.compressedStreamingPassed = true;

  try {
    await execFileAsync(cli, ["--browser", "chrome", `http://127.0.0.1:${port}/echo`], {
      encoding: "utf8",
      env: { ...process.env, BROWSER_PROXY_RUNTIME_DIR: chromeRuntime },
    });
  } catch (error) {
    results.deniedOriginBlocked = String(error.stderr).includes("ORIGIN_NOT_ALLOWED");
  }
  assert(results.deniedOriginBlocked, "a non-allowlisted origin was not blocked");

  const echoCountBeforeRedirect = echoRequests;
  const cliOptions = { encoding: "utf8", env: { ...process.env, BROWSER_PROXY_RUNTIME_DIR: chromeRuntime } };
  const invoke = (...args) => execFileAsync(cli, ["--browser", "chrome", ...args], cliOptions);
  const rejectRedirect = async (code, ...args) => {
    await assert.rejects(invoke(...args), error => {
      assert.match(String(error.stderr), new RegExp(code));
      return true;
    });
  };
  const route = (to = "/echo", status = 302, pathname = "/r", extra = {}) =>
    `${baseUrl}${pathname}?${new URLSearchParams({ to, status: String(status), ...extra })}`;
  const unfollowed = JSON.parse((await invoke("--response-json", `${baseUrl}/redirect`)).stdout);
  assert.equal(unfollowed.ok, true);
  assert.equal(unfollowed.response.status, 302);
  assert.equal(unfollowed.response.status_text, "Found");
  assert.equal(unfollowed.response.url, `${baseUrl}/redirect`);
  assert.equal(unfollowed.response.body_unavailable, true);
  assert.equal(unfollowed.response.body.data, "");
  const unfollowedHeaders = Object.fromEntries(unfollowed.response.headers);
  assert.equal(unfollowedHeaders.location, `http://127.0.0.1:${port}/echo`);
  assert.equal(unfollowedHeaders["content-length"], String(Buffer.byteLength("redirecting")));
  assert.equal(unfollowedHeaders["content-type"], "text/plain");
  assert(!JSON.stringify(unfollowed).includes("hidden-secret"));
  assert(!JSON.stringify(unfollowed).includes("set-cookie"));
  assert(!JSON.stringify(unfollowed).includes("browser-proxy-"));
  for (const flags of [[], ["-i"], ["-I"], ["-f"], ["-s"], ["-s", "-S"]]) {
    const result = await invoke(...flags, `${baseUrl}/redirect`);
    if (flags.includes("-i") || flags.includes("-I")) {
      assert.match(result.stdout, /^HTTP\/1\.1 302 Found\r\n/);
      assert.match(result.stdout, /\r\nlocation: http:\/\/127\.0\.0\.1:/);
      assert(result.stdout.endsWith("\r\n\r\n"));
      assert(!result.stdout.includes("redirecting"));
    } else assert.equal(result.stdout, "");
    assert.equal(result.stderr.includes("response body is unavailable"), !flags.includes("-I") && !flags.includes("-s"));
  }
  const redirectHeaderFile = path.join(runtimeRoot, "unfollowed-headers.txt");
  const redirectBodyFile = path.join(runtimeRoot, "unfollowed-body.bin");
  try {
    await invoke("-D", redirectHeaderFile, "-o", redirectBodyFile, `${baseUrl}/redirect`);
    assert.match(fs.readFileSync(redirectHeaderFile, "utf8"), /^HTTP\/1\.1 302 Found/);
    assert.equal(fs.statSync(redirectBodyFile).size, 0);
  } finally {
    fs.rmSync(redirectHeaderFile, { force: true });
    fs.rmSync(redirectBodyFile, { force: true });
  }
  for (const status of [301, 302, 303, 307, 308]) {
    const result = JSON.parse((await invoke("--response-json", "--json", '{"unfollowed":true}', route("/echo", status))).stdout);
    assert.equal(result.response.status, status);
    assert.equal(result.response.body_unavailable, true);
    assert.equal(result.response.body.data, "");
    assert.equal(Object.fromEntries(result.response.headers).location, "/echo");
  }
  assert.equal(echoRequests, echoCountBeforeRedirect, "an unfollowed redirect contacted its target");
  results.unfollowedRedirectPassed = true;
  const setRedirects = async enabled => {
    const saved = await call("evaluate_script", {
      pageId: optionsPage.id,
      function: `async () => {
        const input = document.querySelector('#redirects-enabled');
        if (input.checked !== ${enabled}) input.click();
        for (let i = 0; i < 100; i++) {
          const settings = await chrome.storage.local.get({redirectsEnabled: false});
          if (settings.redirectsEnabled === ${enabled} && !input.disabled) return {saved: true};
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        return {saved: false};
      }`,
    });
    assert.match(resultText(saved), /"saved":true/);
  };
  const setRules = async rules => {
    const saved = await call("evaluate_script", {
      pageId: optionsPage.id,
      function: `async () => {
        const rules = ${JSON.stringify(rules)};
        document.querySelector('#allowlist').value = rules.join('\\n');
        document.querySelector('#save').click();
        for (let i = 0; i < 100; i++) {
          const {allowlist} = await chrome.storage.local.get({allowlist: []});
          if (JSON.stringify(allowlist) === JSON.stringify(rules)) return {saved: true};
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        return {saved: false};
      }`,
    });
    assert.match(resultText(saved), /"saved":true/);
  };
  const waitForGate = async name => {
    const deadline = Date.now() + 10000;
    while (!redirectGates.has(name) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert(redirectGates.has(name), `redirect gate ${name} was not reached`);
  };

  // The setting starts disabled, even when a local caller explicitly uses -L.
  await rejectRedirect("REDIRECT_BLOCKED", "-L", route());
  results.redirectBlocked = true;
  assert.equal(echoRequests, echoCountBeforeRedirect);
  await setRedirects(true);
  assert.equal(JSON.parse((await invoke("--response-json", route())).stdout).response.body_unavailable, true);
  await rejectRedirect("REDIRECT_NOT_ALLOWED", "-L", `${baseUrl}/redirect`);
  assert.equal(echoRequests, echoCountBeforeRedirect);

  const otherOrigin = `http://127.0.0.1:${port}`;
  const redirectRules = [baseUrl, otherOrigin, "http://github.com"];
  await setRules(redirectRules);
  if (process.env.BROWSER_PROXY_LIVE_REDIRECT_URL) {
    const liveUrl = new URL(process.env.BROWSER_PROXY_LIVE_REDIRECT_URL);
    assert(["http:", "https:"].includes(liveUrl.protocol), "live redirect probe requires HTTP(S)");
    await setRules([...new Set([...redirectRules, liveUrl.origin])]);
    const live = JSON.parse((await invoke("-I", "--response-json", liveUrl.href)).stdout);
    assert.equal(live.ok, true);
    assert([301, 302, 303, 307, 308].includes(live.response.status));
    assert.equal(live.response.body_unavailable, true);
    assert.equal(live.response.body.data, "");
    assert(Object.fromEntries(live.response.headers).location);
    assert.equal(live.response.redirected, undefined);
    results.liveHeadRedirectStatus = live.response.status;
    await setRules(redirectRules);
  }
  const multiHop = route(route(`${otherOrigin}/echo`, 307));
  const final = JSON.parse((await invoke("-L", "--response-json", multiHop)).stdout);
  assert.equal(final.response.url, `${otherOrigin}/echo`);
  assert.equal(final.response.redirects.length, 2);
  assert(final.response.redirected);
  assert.equal(final.response.body_unavailable, undefined);
  assert(!JSON.stringify(final).includes("browser-proxy-"), "internal fragment leaked into response metadata");

  const withCookie = JSON.parse((await invoke("-L", route("/echo", 302, "/r", { cookie: "1" }))).stdout);
  assert.match(withCookie.cookie, /redirect_cookie=hop-secret/);
  const chainHeaders = final.response.headers.map(([name]) => name.toLowerCase());
  assert(!chainHeaders.includes("set-cookie"));

  for (const status of [301, 302, 303, 307, 308]) {
    const result = JSON.parse((await invoke("-L", "-H", "Authorization: Bearer test-secret", "--json", '{"hello":"redirect"}', route(`${otherOrigin}/echo`, status))).stdout);
    assert.equal(result.method, status <= 303 ? "GET" : "POST");
    assert.equal(result.body, status <= 303 ? "" : '{"hello":"redirect"}');
    assert.equal(result.contentType, status <= 303 ? "" : "application/json");
    assert.equal(result.authorization, "", "Authorization crossed an origin boundary");
  }
  const binarySource = path.join(runtimeRoot, "redirect-upload.bin");
  try {
    fs.writeFileSync(binarySource, Buffer.from([0, 255, 128, 1]));
    const result = JSON.parse((await invoke("-L", "--data-binary", `@${binarySource}`, route("/echo", 308))).stdout);
    assert.equal(result.bodyBase64, "AP+AAQ==");
  } finally {
    fs.rmSync(binarySource, { force: true });
  }

  const denied = `http://127.0.0.1:${deniedServer.address().port}/back`;
  const deniedUnfollowed = JSON.parse((await invoke("--response-json", route(denied))).stdout);
  assert.equal(deniedUnfollowed.response.status, 302);
  assert.equal(Object.fromEntries(deniedUnfollowed.response.headers).location, denied);
  await rejectRedirect("REDIRECT_NOT_ALLOWED", "-L", route(denied));
  assert.equal(deniedRedirectRequests, 0, "disallowed intermediate server received a request");
  const beforeLimit = echoRequests;
  await rejectRedirect("REDIRECT_LIMIT_EXCEEDED", "-L", "--max-redirs", "0", route());
  await rejectRedirect("REDIRECT_LIMIT_EXCEEDED", "-L", "--max-redirs", "1", multiHop);
  assert.equal(echoRequests, beforeLimit);
  for (const target of ["file:///etc/passwd", "https://user:secret@example.com/"]) {
    // Browser Fetch may itself reject an unsupported Location before exposing it.
    await rejectRedirect("INVALID_REDIRECT|REQUEST_FAILED", "-L", route(target));
  }

  const cached = route("/echo", 301, "/r-cache");
  const cachedKey = new URL(cached).pathname + new URL(cached).search;
  const beforeCached = echoRequests;
  for (let index = 0; index < 2; index++) {
    const result = JSON.parse((await invoke("--response-json", cached)).stdout);
    assert.equal(result.response.status, 301);
    assert.equal(result.response.body_unavailable, true);
  }
  assert.equal(echoRequests, beforeCached);
  await invoke("-L", cached);
  await invoke("-L", cached);
  assert.equal(redirectHits.get(cachedKey), 1, "redirect response was not reused from HTTP cache");
  results.cachedRedirectPassed = true;

  // Identical URLs with independently delayed responses exercise event correlation.
  const concurrent = await Promise.all(Array.from({ length: 4 }, (_, index) =>
    invoke("-L", "-H", `X-Test: concurrent-${index}`, route()).then(result => JSON.parse(result.stdout))));
  assert.deepEqual(concurrent.map(result => result.testHeader), ["concurrent-0", "concurrent-1", "concurrent-2", "concurrent-3"]);
  const beforeUnfollowedConcurrent = echoRequests;
  const concurrentHeaders = await Promise.all(Array.from({ length: 4 }, (_, index) =>
    invoke("--response-json", "-H", `X-Test: headers-${index}`, route()).then(result => JSON.parse(result.stdout))));
  assert.deepEqual(concurrentHeaders.map(result => Object.fromEntries(result.response.headers)["x-redirect-test"]),
    ["headers-0", "headers-1", "headers-2", "headers-3"]);
  assert.equal(echoRequests, beforeUnfollowedConcurrent);

  // A preloaded HSTS upgrade is still an opaque manual redirect in Chrome.
  await rejectRedirect("REDIRECT_NOT_ALLOWED", "-L", "http://github.com/");
  const hsts = JSON.parse((await invoke("--response-json", "http://github.com/")).stdout);
  assert.equal(hsts.response.status, 307);
  assert.equal(hsts.response.body_unavailable, true);
  assert.equal(Object.fromEntries(hsts.response.headers).location, "https://github.com/");
  assert(!JSON.stringify(hsts).includes("browser-proxy-"));
  results.hstsRedirectPassed = true;

  for (const setting of ["allowlist", "redirects"]) {
    const before = echoRequests;
    const paused = rejectRedirect(setting === "allowlist" ? "REDIRECT_NOT_ALLOWED" : "REDIRECT_BLOCKED", "-L",
      route("/echo", 302, "/r-gated", { gate: setting }));
    await waitForGate(setting);
    if (setting === "allowlist") await setRules([otherOrigin]);
    else await setRedirects(false);
    redirectGates.get(setting)();
    redirectGates.delete(setting);
    await paused;
    assert.equal(echoRequests, before, "revoked policy still allowed a redirect target request");
    await setRules(redirectRules);
    await setRedirects(true);
  }
  results.redirectRevocationPassed = true;

  const timeoutGate = "timeout";
  const timed = rejectRedirect("TIMEOUT", "-L", "--max-time", "0.5", route("/echo", 302, "/r-gated", { gate: timeoutGate }));
  await waitForGate(timeoutGate);
  await timed;
  redirectGates.delete(timeoutGate);

  // Final downloads still use the streaming path after the redirect loop.
  await invoke("-L", "--max-time", "120", "-o", largeResponseFile, route("/large-gzip", 307));
  await assertLargeFile(largeResponseFile);
  fs.rmSync(largeResponseFile, { force: true });
  await setRedirects(false);
  await rejectRedirect("REDIRECT_BLOCKED", "-L", route());
  results.redirectsPassed = true;

  const pagesAfter = await call("list_pages");
  results.foregroundPageAdded = pagesAfter.structuredContent.pages.length !== beforeCount;
  assert.equal(results.foregroundPageAdded, false, "CLI request created a browser page");

  fs.writeFileSync(
    path.join(runtimeRoot, "chrome-mcp-results.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  console.log(JSON.stringify(results, null, 2));
} finally {
  await client.close().catch(() => {});
  server.closeAllConnections();
  deniedServer.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => deniedServer.close(resolve));
  fs.rmSync(profileNativeManifest, { force: true });
  fs.rmSync(largeResponseFile, { force: true });
}
