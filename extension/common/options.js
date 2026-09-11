"use strict";

const optionsApi = globalThis.browser || globalThis.chrome;
const allowlistInput = document.querySelector("#allowlist");
const countOutput = document.querySelector("#rule-count");
const messageOutput = document.querySelector("#message");
const connectionOutput = document.querySelector("#connection");
const importFileInput = document.querySelector("#import-file");
const reconnectButton = document.querySelector("#reconnect");
const redirectsInput = document.querySelector("#redirects-enabled");
const redirectsMessage = document.querySelector("#redirects-message");

function rulesFromInput() {
  return allowlistInput.value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function updateCount() {
  const count = rulesFromInput().length;
  countOutput.textContent = `${count} ${count === 1 ? "rule" : "rules"}`;
}

function showMessage(text, kind) {
  messageOutput.textContent = text;
  messageOutput.className = `message ${kind || ""}`;
}

async function updateStatus() {
  try {
    const status = await optionsApi.runtime.sendMessage({ type: "get_status" });
    connectionOutput.textContent = status.connected
      ? "Native host connected"
      : status.connecting
        ? "Native host connecting"
        : "Native host offline";
    connectionOutput.classList.toggle("connected", status.connected);
    connectionOutput.title = status.error || "";
    return status;
  } catch (error) {
    connectionOutput.textContent = "Background unavailable";
    connectionOutput.classList.remove("connected");
    connectionOutput.title = error.message;
    return { connected: false, connecting: false, error: error.message };
  }
}

async function load() {
  const { allowlist, redirectsEnabled } = await optionsApi.storage.local.get({ allowlist: [], redirectsEnabled: false });
  allowlistInput.value = allowlist.join("\n");
  redirectsInput.checked = redirectsEnabled === true;
  updateCount();
  await updateStatus();
}

async function save() {
  try {
    const parsed = BrowserProxyPolicy.normalizeRules(rulesFromInput());
    const allowlist = parsed.map((rule) => rule.canonical);
    await optionsApi.storage.local.set({ allowlist });
    allowlistInput.value = allowlist.join("\n");
    updateCount();
    showMessage(`Saved ${allowlist.length} origin ${allowlist.length === 1 ? "rule" : "rules"}.`, "success");
  } catch (error) {
    showMessage(error.message, "error");
  }
}

async function importAllowlist() {
  const [file] = importFileInput.files;
  importFileInput.value = "";
  if (!file) {
    return;
  }
  try {
    if (file.size > BrowserProxyAllowlistFile.maxFileBytes) {
      throw new Error(`Allowlist files cannot exceed ${BrowserProxyAllowlistFile.maxFileBytes} bytes`);
    }
    const allowlist = BrowserProxyAllowlistFile.parse(await file.text());
    await optionsApi.storage.local.set({ allowlist });
    allowlistInput.value = allowlist.join("\n");
    updateCount();
    showMessage(
      `Imported and saved ${allowlist.length} origin ${allowlist.length === 1 ? "rule" : "rules"}.`,
      "success",
    );
  } catch (error) {
    showMessage(`Import failed: ${error.message}`, "error");
  }
}

async function exportAllowlist() {
  try {
    const { allowlist } = await optionsApi.storage.local.get({ allowlist: [] });
    const contents = BrowserProxyAllowlistFile.serialize(allowlist);
    const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
    const download = document.createElement("a");
    download.href = url;
    download.download = "browser-proxy-allowlist.json";
    document.body.append(download);
    download.click();
    download.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    showMessage(`Exported ${allowlist.length} saved origin ${allowlist.length === 1 ? "rule" : "rules"}.`, "success");
  } catch (error) {
    showMessage(`Export failed: ${error.message}`, "error");
  }
}

document.querySelector("#save").addEventListener("click", save);
redirectsInput.addEventListener("change", async () => {
  redirectsInput.disabled = true;
  try {
    await optionsApi.storage.local.set({ redirectsEnabled: redirectsInput.checked });
    redirectsMessage.textContent = redirectsInput.checked ? "Redirects enabled for requests using -L." : "Redirects disabled.";
    redirectsMessage.className = "message success";
  } catch (error) {
    redirectsInput.checked = !redirectsInput.checked;
    redirectsMessage.textContent = `Could not save redirects: ${error.message}`;
    redirectsMessage.className = "message error";
  } finally {
    redirectsInput.disabled = false;
  }
});
document.querySelector("#import").addEventListener("click", () => importFileInput.click());
document.querySelector("#export").addEventListener("click", exportAllowlist);
importFileInput.addEventListener("change", importAllowlist);
reconnectButton.addEventListener("click", async () => {
  if (reconnectButton.disabled) {
    return;
  }
  reconnectButton.disabled = true;
  showMessage("Reconnecting...", "");
  try {
    await optionsApi.runtime.sendMessage({ type: "reconnect_native" });
    const deadline = Date.now() + 15000;
    let status;
    while (Date.now() < deadline) {
      status = await updateStatus();
      if (status.connected) {
        showMessage("Native host reconnected.", "success");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for native host${status?.error ? `: ${status.error}` : ""}`);
  } catch (error) {
    showMessage(`Reconnect failed: ${error.message}`, "error");
  } finally {
    reconnectButton.disabled = false;
  }
});
allowlistInput.addEventListener("input", updateCount);

void load();
