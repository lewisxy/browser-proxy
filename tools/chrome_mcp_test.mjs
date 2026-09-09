#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
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
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
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
        }),
      );
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
  deniedOriginBlocked: false,
  foregroundPageAdded: false,
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

  await call("new_page", { url: `${baseUrl}/login`, background: true, timeout: 30000 });
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
      const input = document.querySelector('#allowlist');
      input.value = ${JSON.stringify(baseUrl)};
      input.dispatchEvent(new Event('input', {bubbles: true}));
      document.querySelector('#save').click();
      await new Promise(resolve => setTimeout(resolve, 250));
      return {
        title: document.querySelector('h1').textContent,
        message: document.querySelector('#message').textContent,
        mobileRulePresent: Array.from(document.styleSheets).some(sheet =>
          Array.from(sheet.cssRules || []).some(rule => rule.cssText.includes('@media (max-width: 640px)'))
        )
      };
    }`,
  });
  const configuredText = resultText(configured);
  assert.match(configuredText, /Browser Proxy/);
  assert.match(configuredText, /Saved 1 origin rule/);
  assert.match(configuredText, /mobileRulePresent/);

  const snapshot = await call("take_snapshot", { pageId: optionsPage.id });
  assert.match(resultText(snapshot), /Allowed origins/);
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
    await waitForFile(path.join(runtimeRoot, "run", "chrome.sock"));
  } catch (error) {
    throw new Error(`${error.message}; service worker state: ${resultText(nativeState)}`);
  }
  results.nativeConnected = true;

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
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
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

  try {
    await execFileAsync(cli, ["--browser", "chrome", `http://127.0.0.1:${port}/echo`], {
      encoding: "utf8",
    });
  } catch (error) {
    results.deniedOriginBlocked = String(error.stderr).includes("ORIGIN_NOT_ALLOWED");
  }
  assert(results.deniedOriginBlocked, "a non-allowlisted origin was not blocked");

  const echoCountBeforeRedirect = echoRequests;
  try {
    await execFileAsync(cli, ["--browser", "chrome", `${baseUrl}/redirect`], { encoding: "utf8" });
  } catch (error) {
    results.redirectBlocked = String(error.stderr).includes("REQUEST_FAILED");
  }
  assert(results.redirectBlocked, "redirect was not rejected");
  assert.equal(echoRequests, echoCountBeforeRedirect, "redirect target received a request");

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
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(profileNativeManifest, { force: true });
}
