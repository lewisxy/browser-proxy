"use strict";

const popupApi = globalThis.browser || globalThis.chrome;
const originOutput = document.querySelector("#current-origin-title");
const originStatus = document.querySelector("#origin-status");
const allowOriginButton = document.querySelector("#allow-origin");
let currentOrigin = null;

async function loadStatus() {
  const title = document.querySelector("#status-title");
  const detail = document.querySelector("#status-detail");
  const dot = document.querySelector("#status-dot");
  try {
    const status = await popupApi.runtime.sendMessage({ type: "get_status" });
    title.textContent = status.connected
      ? "Native host connected"
      : status.connecting
        ? "Native host connecting"
        : "Native host offline";
    detail.textContent = `${status.allowlistCount} allowed origin ${status.allowlistCount === 1 ? "rule" : "rules"}`;
    dot.classList.toggle("connected", status.connected);
  } catch (error) {
    title.textContent = "Background unavailable";
    detail.textContent = error.message;
  }
}

function showOriginState(allowed) {
  originStatus.textContent = allowed ? "Allowed by your rules" : "Not allowed";
  originStatus.classList.toggle("allowed", allowed);
  allowOriginButton.hidden = allowed;
}

async function loadCurrentOrigin() {
  try {
    const [tab] = await popupApi.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) {
      throw new Error("The active page URL is unavailable");
    }
    const url = BrowserProxyPolicy.parseRequestUrl(tab.url);
    currentOrigin = url.origin;
    originOutput.textContent = currentOrigin;
    const { allowlist } = await popupApi.storage.local.get({ allowlist: [] });
    showOriginState(BrowserProxyPolicy.isAllowed(currentOrigin, allowlist));
  } catch (error) {
    currentOrigin = null;
    originOutput.textContent = "This page cannot be proxied";
    originStatus.textContent = error.message;
    originStatus.classList.remove("allowed");
    allowOriginButton.hidden = true;
  }
}

async function allowCurrentOrigin() {
  if (!currentOrigin) {
    return;
  }
  allowOriginButton.disabled = true;
  try {
    const { allowlist } = await popupApi.storage.local.get({ allowlist: [] });
    const rules = BrowserProxyPolicy.normalizeRules(allowlist);
    if (!BrowserProxyPolicy.isAllowed(currentOrigin, allowlist)) {
      rules.push(BrowserProxyPolicy.parseRule(currentOrigin));
      await popupApi.storage.local.set({
        allowlist: BrowserProxyPolicy.normalizeRules(rules.map((rule) => rule.canonical)).map(
          (rule) => rule.canonical,
        ),
      });
    }
    showOriginState(true);
    await loadStatus();
  } catch (error) {
    originStatus.textContent = error.message;
    originStatus.classList.remove("allowed");
  } finally {
    allowOriginButton.disabled = false;
  }
}

document.querySelector("#settings").addEventListener("click", () => popupApi.runtime.openOptionsPage());
allowOriginButton.addEventListener("click", allowCurrentOrigin);
void Promise.all([loadStatus(), loadCurrentOrigin()]);
