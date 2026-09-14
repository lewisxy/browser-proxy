import assert from "node:assert/strict";
import path from "node:path";

// Executed in the real extension options page by Chrome DevTools MCP. All edits
// go through visible form controls or the public import/export UI, not storage writes.
async function exerciseEditor({ baseUrl, otherOrigin }) {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const same = (actual, expected, message) => check(JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected)), message);
  const root = document.querySelector("#tab-profiles");
  const message = document.querySelector("#tab-profiles-message");
  const controls = document.querySelector("#tab-profile-controls");
  const stored = async () => (await chrome.storage.local.get({ tabProfiles: { version: 1, profiles: [] } })).tabProfiles;
  const allowlistBefore = (await chrome.storage.local.get({ allowlist: [] })).allowlist;
  const profile = () => root.querySelector(".tab-profile");
  const rule = () => profile().querySelector(".token-rule");
  const primary = () => rule().querySelector(".token-source");
  const set = (scope, name, value) => {
    const input = scope.querySelector(`[data-field="${name}"]`);
    check(input, `Missing form control ${name}`);
    input.value = value;
    input.dispatchEvent(new Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  };
  const click = (scope, action) => {
    const button = scope.querySelector(`[data-action="${action}"]`);
    check(button && !button.disabled, `Unavailable action ${action}`);
    button.click();
  };
  async function settled(success) {
    for (let i = 0; i < 100; i++) {
      if (!controls.disabled && message.textContent.startsWith(success ? "Saved" : "Could not")) return;
      if (!controls.disabled && success && message.textContent.startsWith("Could not")) throw new Error(message.textContent);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Editor did not finish: ${message.textContent}`);
  }
  async function save(success = true) {
    message.textContent = "";
    document.querySelector("#save-tab-profiles").click();
    await settled(success);
    return stored();
  }
  async function importText(contents, success = true) {
    const transfer = new DataTransfer();
    transfer.items.add(new File([contents], "profiles.json", { type: "application/json" }));
    const file = document.querySelector("#tab-profiles-file");
    message.textContent = "";
    file.files = transfer.files;
    file.dispatchEvent(new Event("change", { bubbles: true }));
    for (let i = 0; i < 100; i++) {
      if (!controls.disabled && message.textContent.startsWith(success ? "Imported and saved" : "Could not import")) return;
      if (!controls.disabled && success && message.textContent.startsWith("Could not")) throw new Error(message.textContent);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Import did not finish: ${message.textContent}`);
  }
  function addProfile(name) {
    document.querySelector("#add-tab-profile").click();
    const added = root.querySelector(".tab-profile:last-child");
    set(added, "profile-name", name);
    set(added, "profile-origin", `${baseUrl}/`);
    set(added, "profile-page", `${baseUrl}/tab-app`);
    return added;
  }

  check(!controls.disabled, "Editor did not finish loading");
  check(root.tagName !== "TEXTAREA" && root.querySelector(".empty-profiles"), "Expected a form-based empty state");
  addProfile("ui-cookie");
  click(profile(), "rule-add");
  check(primary().querySelector('[data-field="cookie-name"]').value === "XSRF-TOKEN", "Cookie preset was not applied");
  let config = await save();
  check(config.profiles[0].origin === baseUrl, "Origin trailing slash should be normalized by the form");
  same(config.profiles[0].csrf[0].sources, [{ type: "cookie", name: "XSRF-TOKEN" }], "Cookie source did not save");
  same(config.profiles[0].csrf[0].target, { header: "X-XSRF-TOKEN" }, "Header target did not save");
  same(config.profiles[0].csrf[0].transforms, ["url-decode"], "Preset decoding was lost");
  const withoutToken = addProfile("page-only");
  set(withoutToken, "profile-origin", otherOrigin);
  set(withoutToken, "profile-page", "");
  config = await save();
  same(config.profiles[1].csrf, [], "Page-only profile unexpectedly attached a token");
  check(config.profiles[1].page_url === `${otherOrigin}/`, "Blank application page did not use its default");
  set(withoutToken, "profile-name", "ui-cookie");
  same(await save(false), config, "Duplicate profile names were saved");
  click(withoutToken, "profile-remove");
  config = await save();

  // Invalid fields are revealed even inside a collapsed profile, and never saved.
  const cookieSaved = config;
  set(primary(), "cookie-name", "");
  profile().open = false;
  same(await save(false), cookieSaved, "Invalid form changed saved profiles");
  check(profile().open && document.activeElement.dataset.field === "cookie-name", "Required-field error did not reveal/focus its input");
  set(primary(), "cookie-name", "XSRF-TOKEN");
  set(rule(), "target-name", "Cookie");
  same(await save(false), cookieSaved, "Forbidden header was saved");
  check(rule().querySelector(".form-error").textContent.includes("browser-controlled"), "Expected inline rule error");
  set(rule(), "target-name", "X-CSRF-Token");
  set(profile(), "profile-origin", `${baseUrl}/api/path`);
  same(await save(false), cookieSaved, "An origin with an API path was saved");
  set(profile(), "profile-origin", baseUrl);

  // Conditional source/target forms must not retain fields from their former type.
  set(primary(), "source-type", "dom");
  check(document.activeElement.dataset.field === "source-type", "Changing source type lost keyboard focus");
  set(primary(), "source-selector", 'meta[name="csrf-token"]');
  set(primary(), "dom-value", "attribute");
  set(primary(), "source-attribute", "data-token");
  set(rule(), "target-type", "form");
  set(rule(), "target-name", "csrf");
  config = await save();
  same(config.profiles[0].csrf[0].sources[0], { type: "dom", selector: 'meta[name="csrf-token"]', attribute: "data-token" }, "DOM attribute form did not save");
  same(config.profiles[0].csrf[0].target, { form: "csrf" }, "Form target did not save");
  set(primary(), "dom-value", "value");
  config = await save();
  check(config.profiles[0].csrf[0].sources[0].property === "value" && !config.profiles[0].csrf[0].sources[0].attribute, "DOM value retained an obsolete attribute");
  set(primary(), "dom-value", "text");
  config = await save();
  same(config.profiles[0].csrf[0].sources[0], { type: "dom", selector: 'meta[name="csrf-token"]' }, "DOM text retained obsolete fields");
  set(primary(), "source-selector", "[");
  same(await save(false), config, "Invalid CSS selector changed stored configuration");
  set(primary(), "source-selector", "meta");

  set(primary(), "source-type", "bootstrap");
  set(primary(), "bootstrap-url", "/tab-bootstrap");
  set(primary(), "bootstrap-value", "header");
  set(primary(), "bootstrap-header", "X-CSRF");
  config = await save();
  same(config.profiles[0].csrf[0].sources[0], { type: "bootstrap", url: `${baseUrl}/tab-bootstrap`, header: "X-CSRF" }, "Bootstrap header did not save");
  set(primary(), "bootstrap-value", "json");
  set(primary(), "path-part", "security.details");
  click(primary(), "path-add");
  set(primary().querySelector(".path-level:last-child"), "path-part", "token/name");
  set(rule(), "target-type", "json_path");
  const target = rule().querySelector(".token-target");
  set(target, "path-part", "security");
  click(target, "path-add");
  set(target.querySelector(".path-level:last-child"), "path-part", "csrf");
  config = await save();
  same(config.profiles[0].csrf[0].sources[0].json_path, ["security.details", "token/name"], "Property names were incorrectly split");
  same(config.profiles[0].csrf[0].target, { json_path: ["security", "csrf"] }, "Nested JSON target did not save");
  click(target.querySelector(".path-level:last-child"), "path-remove");
  config = await save();
  same(config.profiles[0].csrf[0].target.json_path, ["security"], "Removing a nested property did not update the model");

  click(rule(), "source-add");
  set(rule().querySelector(".fallback-sources .token-source"), "cookie-name", "backup-token");
  click(rule().querySelector(".fallback-sources .token-source"), "source-up");
  config = await save();
  check(config.profiles[0].csrf[0].sources[0].name === "backup-token", "Fallback source order did not change");
  click(rule().querySelector(".fallback-sources .token-source"), "source-remove");
  click(rule(), "transform-add");
  set(rule().querySelector(".token-adjustment:last-child"), "transform", "base64-decode");
  click(rule().querySelector(".token-adjustment:last-child"), "adjustment-up");
  config = await save();
  same(config.profiles[0].csrf[0].transforms, ["base64-decode", "url-decode"], "Adjustment order was not preserved");
  click(rule().querySelector(".token-adjustment:last-child"), "adjustment-remove");
  set(rule(), "token-prefix", "Bearer ");
  rule().querySelector('[data-field="method"][value="POST"]').click();
  set(rule(), "other-methods", "CUSTOM");
  config = await save();
  same(config.profiles[0].csrf[0].methods, ["PUT", "PATCH", "DELETE", "CUSTOM"], "Method selection did not save");
  check(config.profiles[0].csrf[0].prefix === "Bearer ", "Prefix whitespace was lost");

  for (const choice of ["django", "meta", "input"]) {
    set(profile(), "rule-recipe", choice);
    click(profile(), "rule-add");
  }
  config = await save();
  check(config.profiles[0].csrf[1].target.header === "X-CSRFToken", "Django preset did not save");
  check(config.profiles[0].csrf[2].sources[0].attribute === "content", "Meta preset did not save");
  check(config.profiles[0].csrf[3].target.form === "csrfmiddlewaretoken", "Hidden-input preset did not save");
  set(profile(), "profile-wait", "#ready");
  config = await save();
  check(config.profiles[0].wait_for === "#ready", "Page readiness did not save");
  click(rule(), "rule-remove");
  config = await save();
  check(config.profiles[0].csrf.length === 3 && config.profiles[0].csrf[0].target.header === "X-CSRFToken", "Removing a rule changed its neighbors");

  // Round-trip every supported advanced setting through JSON import, forms, and save.
  const imported = { version: 1, profiles: [{
    name: "imported", origin: baseUrl, page_url: `${baseUrl}/tab-app`, wait_for: "[data-ready]",
    csrf: [{
      sources: [
        { type: "cookie", name: "fallback" },
        { type: "dom", selector: ".token-text" },
        { type: "dom", selector: "meta", attribute: "content" },
        { type: "dom", selector: "input", property: "value" },
        { type: "bootstrap", url: "/tab-bootstrap", json_path: ["security.details", "token/name", "0"] },
        { type: "bootstrap", url: "/tab-bootstrap", header: "X-CSRF" },
      ],
      target: { json_path: ["security.details", "token/name"] }, methods: ["CUSTOM", "PATCH"],
      transforms: ["trim", "url-decode", "trim"], prefix: " Token ",
    }],
  }, { name: "no-token", origin: otherOrigin, page_url: `${otherOrigin}/`, csrf: [] }] };
  await importText(JSON.stringify(imported));
  const importedSaved = await stored();
  same(await save(), importedSaved, "Form save lost an imported advanced setting");
  set(profile(), "profile-name", "draft-kept");
  for (const bad of ['{"version":', JSON.stringify({ version: 2, profiles: [] }),
    JSON.stringify({ ...imported, profiles: [{ ...imported.profiles[0], script: "not supported" }] })]) {
    await importText(bad, false);
    same(await stored(), importedSaved, "Invalid import changed stored profiles");
    check(profile().querySelector('[data-field="profile-name"]').value === "draft-kept", "Invalid import discarded a draft");
  }

  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;
  let exported;
  let filename;
  try {
    URL.createObjectURL = blob => { exported = blob; return "blob:profile-export-test"; };
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = function () { filename = this.download; };
    document.querySelector("#export-tab-profiles").click();
    for (let i = 0; i < 100 && !exported; i++) await new Promise(resolve => setTimeout(resolve, 20));
    check(exported && filename === "browser-proxy-tab-profiles.json", "Profile export did not create a JSON file");
    same(JSON.parse(await exported.text()), importedSaved, "Export used an unsaved draft or lost configuration");
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    HTMLAnchorElement.prototype.click = originalClick;
  }
  await importText(await exported.text());
  same(await save(), importedSaved, "Export/import/form round-trip changed configuration");
  while (profile()) click(profile(), "profile-remove");
  config = await save();
  check(config.profiles.length === 0 && root.querySelector(".empty-profiles"), "Deleting profiles did not restore the empty state");
  addProfile("example-site");
  click(profile(), "rule-add");
  await save();
  same((await chrome.storage.local.get({ allowlist: [] })).allowlist, allowlistBefore, "Profile editing changed the allowlist");
  return { formsPassed: true, validationPassed: true, advancedRoundTripPassed: true, importsExportsPassed: true };
}

export async function testProfileEditor(call, resultText, pageId, baseUrl, otherOrigin, runtimeRoot) {
  await call("emulate", { pageId, viewport: "1280x1000x1" });
  const result = await call("evaluate_script", {
    pageId,
    function: `async () => (${exerciseEditor.toString()})(${JSON.stringify({ baseUrl, otherOrigin })})`,
  });
  for (const field of ["formsPassed", "validationPassed", "advancedRoundTripPassed", "importsExportsPassed"]) {
    assert.match(resultText(result), new RegExp(`"${field}":true`));
  }
  const screenshots = {};
  for (const [size, viewport] of [["desktop", "1280x1000x1"], ["mobile", "390x844x1,mobile,touch"]]) {
    await call("emulate", { pageId, viewport });
    const layout = await call("evaluate_script", {
      pageId,
      function: `() => {
        document.querySelector('#tab-profiles-section').scrollIntoView();
        return {fits: document.documentElement.scrollWidth <= window.innerWidth};
      }`,
    });
    assert.match(resultText(layout), /"fits":true/);
    screenshots[size] = path.join(runtimeRoot, `chrome-csrf-${size}.png`);
    await call("take_screenshot", { pageId, filePath: screenshots[size] });
  }
  const snapshot = await call("take_snapshot", { pageId });
  assert.match(resultText(snapshot), /Profile name/);
  assert.match(resultText(snapshot), /Cookie name/);
  assert.match(resultText(snapshot), /Request header name/);
  return screenshots;
}
