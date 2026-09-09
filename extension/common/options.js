"use strict";

const optionsApi = globalThis.browser || globalThis.chrome;
const allowlistInput = document.querySelector("#allowlist");
const countOutput = document.querySelector("#rule-count");
const messageOutput = document.querySelector("#message");
const connectionOutput = document.querySelector("#connection");

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
    connectionOutput.textContent = status.connected ? "Native host connected" : "Native host offline";
    connectionOutput.classList.toggle("connected", status.connected);
    connectionOutput.title = status.error || "";
  } catch (error) {
    connectionOutput.textContent = "Background unavailable";
    connectionOutput.classList.remove("connected");
    connectionOutput.title = error.message;
  }
}

async function load() {
  const { allowlist } = await optionsApi.storage.local.get({ allowlist: [] });
  allowlistInput.value = allowlist.join("\n");
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

document.querySelector("#save").addEventListener("click", save);
document.querySelector("#reconnect").addEventListener("click", async () => {
  showMessage("Reconnecting...", "");
  try {
    await optionsApi.runtime.sendMessage({ type: "reconnect_native" });
    setTimeout(updateStatus, 500);
  } catch (error) {
    showMessage(error.message, "error");
  }
});
allowlistInput.addEventListener("input", updateCount);

void load();
