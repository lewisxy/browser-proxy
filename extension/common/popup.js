"use strict";

const popupApi = globalThis.browser || globalThis.chrome;

async function loadStatus() {
  const title = document.querySelector("#status-title");
  const detail = document.querySelector("#status-detail");
  const dot = document.querySelector("#status-dot");
  try {
    const status = await popupApi.runtime.sendMessage({ type: "get_status" });
    title.textContent = status.connected ? "Native host connected" : "Native host offline";
    detail.textContent = `${status.allowlistCount} allowed origin ${status.allowlistCount === 1 ? "rule" : "rules"}`;
    dot.classList.toggle("connected", status.connected);
  } catch (error) {
    title.textContent = "Background unavailable";
    detail.textContent = error.message;
  }
}

document.querySelector("#settings").addEventListener("click", () => popupApi.runtime.openOptionsPage());
void loadStatus();
