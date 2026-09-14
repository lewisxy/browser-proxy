"use strict";

(function (root) {
  const defaultMethods = ["POST", "PUT", "PATCH", "DELETE"];
  const methodChoices = [...defaultMethods, "GET", "HEAD", "OPTIONS"];
  const recipes = [
    ["xsrf", "Cookie → header (XSRF-TOKEN)"],
    ["django", "Cookie → header (Django)"],
    ["meta", "Page meta tag → header"],
    ["input", "Hidden form input → form field"],
    ["custom", "Custom token setup"],
  ];
  const transforms = [["url-decode", "URL decode (%2B → +)"], ["base64-decode", "Base64 decode"], ["trim", "Trim surrounding spaces"]];

  function recipe(name) {
    const rule = { sources: [], target: {}, methods: [...defaultMethods], transforms: [], prefix: "" };
    if (name === "meta") {
      rule.sources = [{ type: "dom", selector: 'meta[name="csrf-token"]', attribute: "content" }];
      rule.target = { header: "X-CSRF-Token" };
      rule.transforms = ["trim"];
    } else if (name === "input") {
      rule.sources = [{ type: "dom", selector: 'input[name="csrfmiddlewaretoken"]', property: "value" }];
      rule.target = { form: "csrfmiddlewaretoken" };
    } else {
      rule.sources = [{ type: "cookie", name: name === "django" ? "csrftoken" : name === "custom" ? "" : "XSRF-TOKEN" }];
      rule.target = { header: name === "django" ? "X-CSRFToken" : name === "custom" ? "" : "X-XSRF-TOKEN" };
      if (name === "xsrf") rule.transforms = ["url-decode"];
    }
    return rule;
  }

  function create(container, onChange) {
    const document = container.ownerDocument;
    let entries = [];
    let nextId = 0;
    const ruleViews = new WeakMap();

    function node(tag, parent, className, text) {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
      parent?.append(element);
      return element;
    }

    function button(parent, label, action, run) {
      const result = node("button", parent, "secondary compact", label);
      result.type = "button";
      result.dataset.action = action;
      result.addEventListener("click", run);
      return result;
    }

    function field(parent, key, label, value, update, options = {}) {
      const wrapper = node("div", parent, "form-field");
      const id = `profile-field-${++nextId}`;
      const caption = node("label", wrapper, null, label);
      caption.htmlFor = id;
      const input = node(options.choices ? "select" : "input", wrapper);
      input.id = id;
      input.dataset.field = key;
      if (options.choices) {
        for (const [item, title] of options.choices) {
          const option = node("option", input, null, title);
          option.value = item;
        }
      } else {
        input.type = options.type || "text";
        input.maxLength = options.maxLength || 1024;
        input.spellcheck = false;
        input.autocomplete = "off";
        if (options.pattern) input.pattern = options.pattern;
        if (options.placeholder) input.placeholder = options.placeholder;
      }
      input.value = value ?? "";
      input.required = Boolean(options.required);
      if (options.hint) {
        const hint = node("p", wrapper, "field-help", options.hint);
        hint.id = `${id}-help`;
        input.setAttribute("aria-describedby", hint.id);
      }
      input.addEventListener(options.choices ? "change" : "input", () => {
        input.setCustomValidity("");
        update(input.value);
        if (!options.transient) onChange();
      });
      return input;
    }

    function details(parent, title, open = false, className = "editor-advanced") {
      const result = node("details", parent, className);
      result.open = open;
      node("summary", result, null, title);
      return result;
    }

    function reorder(parent, items, index, kind, render, minimum = 0) {
      parent.dataset.itemKind = kind;
      parent.dataset.itemIndex = index;
      const scope = parent.closest(".token-rule");
      function refocus(position, action) {
        const item = scope.querySelector(`[data-item-kind="${kind}"][data-item-index="${position}"]`);
        const preferred = item?.querySelector(`[data-action="${kind}-${action}"]`);
        const control = preferred && !preferred.disabled ? preferred : item?.querySelector("input, select") || scope.querySelector("h4");
        reveal(control);
        control.focus();
      }
      const controls = node("div", parent, "item-actions");
      const move = delta => {
        [items[index], items[index + delta]] = [items[index + delta], items[index]];
        render();
        refocus(index + delta, delta < 0 ? "up" : "down");
        onChange();
      };
      const up = button(controls, "Move up", `${kind}-up`, () => move(-1));
      up.disabled = index === 0;
      up.setAttribute("aria-label", `Move ${kind} ${index + 1} up`);
      const down = button(controls, "Move down", `${kind}-down`, () => move(1));
      down.disabled = index === items.length - 1;
      down.setAttribute("aria-label", `Move ${kind} ${index + 1} down`);
      const remove = button(controls, "Remove", `${kind}-remove`, () => {
        items.splice(index, 1);
        render();
        refocus(Math.max(0, Math.min(index, items.length - 1)), "remove");
        onChange();
      });
      remove.disabled = items.length <= minimum;
      remove.setAttribute("aria-label", `Remove ${kind} ${index + 1}`);
    }

    function pathEditor(parent, path) {
      const group = node("fieldset", parent, "path-editor");
      node("legend", group, null, "JSON property path");
      node("p", group, "field-help", "One property name per box, in nesting order: security → token. Use 0 for the first array item.");
      const levels = node("div", group, "path-levels");
      const add = button(group, "Add nested property", "path-add", () => {
        path.push("");
        render();
        levels.querySelectorAll("input")[path.length - 1].focus();
        onChange();
      });
      function render() {
        levels.replaceChildren();
        path.forEach((key, index) => {
          const row = node("div", levels, "path-level");
          field(row, "path-part", `Property ${index + 1}`, key, value => { path[index] = value; }, { required: true, maxLength: 256 });
          const remove = button(row, "Remove", "path-remove", () => {
            path.splice(index, 1);
            render();
            levels.querySelectorAll("input")[Math.min(index, path.length - 1)].focus();
            onChange();
          });
          remove.setAttribute("aria-label", `Remove property ${index + 1}`);
          remove.disabled = path.length === 1;
        });
        add.disabled = path.length >= 16;
      }
      render();
    }

    function sourceEditor(parent, rule, index, renderSources) {
      const source = rule.sources[index];
      const card = node("fieldset", parent, "token-source");
      node("legend", card, null, index ? `Fallback source ${index + 1}` : "1. Where to read the token");
      field(card, "source-type", "Read from", source.type, type => {
        rule.sources[index] = type === "cookie" ? { type, name: "" }
          : type === "dom" ? { type, selector: "" } : { type, url: "", json_path: ["token"] };
        renderSources(index, "source-type");
      }, { choices: [["cookie", "A website cookie"], ["dom", "An element on the page"], ["bootstrap", "A token endpoint"]] });
      if (source.type === "cookie") {
        field(card, "cookie-name", "Cookie name", source.name, value => { source.name = value; }, {
          required: true, maxLength: 256, placeholder: "XSRF-TOKEN", hint: "The named cookie must be readable by the application page. Enter its name, not its value.",
        });
      } else if (source.type === "dom") {
        field(card, "source-selector", "Page element (CSS selector)", source.selector, value => { source.selector = value; }, {
          required: true, placeholder: 'meta[name="csrf-token"]', hint: "Must identify one element containing the token. The meta-tag and hidden-input setups fill this in for you.",
        });
        field(card, "dom-value", "Read this part", source.attribute ? "attribute" : source.property ? "value" : "text", choice => {
          delete source.attribute;
          delete source.property;
          if (choice === "attribute") source.attribute = "content";
          if (choice === "value") source.property = "value";
          renderSources(index, "dom-value");
        }, { choices: [["text", "Element text"], ["attribute", "An attribute (for example, content)"], ["value", "Input’s current value"]] });
        if (source.attribute !== undefined) field(card, "source-attribute", "Attribute name", source.attribute, value => { source.attribute = value; }, { required: true, maxLength: 256 });
      } else {
        field(card, "bootstrap-url", "Token endpoint URL", source.url, value => { source.url = value; }, {
          required: true, maxLength: 16384, placeholder: "/csrf", hint: "Fetched with GET before the API request. Relative URLs use the application page. The endpoint must be allowed and return success without a redirect.",
        });
        field(card, "bootstrap-value", "Read the token from", source.header !== undefined ? "header" : "json", choice => {
          delete source.header;
          delete source.json_path;
          if (choice === "header") source.header = "X-CSRF-Token";
          else source.json_path = ["token"];
          renderSources(index, "bootstrap-value");
        }, { choices: [["json", "A field in the JSON response"], ["header", "A response header"]] });
        if (source.header !== undefined) field(card, "bootstrap-header", "Response header name", source.header, value => { source.header = value; }, { required: true, maxLength: 256 });
        else pathEditor(card, source.json_path);
      }
      if (rule.sources.length > 1) reorder(card, rule.sources, index, "source", renderSources, 1);
      return card;
    }

    function ruleEditor(parent, rule, index, removeRule) {
      const card = node("section", parent, "token-rule");
      const heading = node("div", card, "editor-heading");
      const title = node("h4", heading, null, `Token rule ${index + 1}`);
      title.tabIndex = -1;
      button(heading, "Remove rule", "rule-remove", removeRule).setAttribute("aria-label", `Remove token rule ${index + 1}`);
      const mapping = node("div", card, "token-mapping");
      const primary = node("div", mapping);
      const target = node("fieldset", mapping, "token-target");
      node("legend", target, null, "2. Where to send the token");
      const targetType = Object.keys(rule.target)[0];
      const typeInput = field(target, "target-type", "Send as", targetType, type => {
        rule.target = type === "json_path" ? { json_path: ["csrf"] } : { [type]: "" };
        renderTarget();
      }, { choices: [["header", "A request header"], ["form", "A form field"], ["json_path", "A field in the JSON body"]] });
      const targetFields = node("div", target);
      function renderTarget() {
        targetFields.replaceChildren();
        const type = typeInput.value;
        if (type === "json_path") pathEditor(targetFields, rule.target.json_path);
        else field(targetFields, "target-name", type === "header" ? "Request header name" : "Form field name", rule.target[type], value => { rule.target[type] = value; }, {
          required: true, maxLength: 256, placeholder: type === "header" ? "X-CSRF-Token" : "_csrf",
        });
        node("p", targetFields, "field-help", type === "header" ? "The token is attached to this header. Existing values for this header are replaced."
          : type === "form" ? "Use with URL-encoded form requests (CLI -d). Multipart uploads need a header token instead."
            : "Use with an object request body (CLI --json). Other fields are kept; the body is re-encoded as JSON.");
      }
      renderTarget();
      const advanced = details(card, "More token options", ruleViews.get(rule)?.querySelector(".rule-advanced").open || false, "editor-advanced rule-advanced");
      ruleViews.set(rule, card);
      node("h5", advanced, null, "Fallback sources");
      node("p", advanced, "field-help", "Tried in order only when an earlier source has no token. Invalid or ambiguous sources stop the request.");
      const fallback = node("div", advanced, "fallback-sources");
      const addSource = button(advanced, "Add fallback source", "source-add", () => {
        rule.sources.push({ type: "cookie", name: "" });
        renderSources();
        fallback.lastElementChild.querySelector("select").focus();
        onChange();
      });
      function renderSources(focusIndex, focusField) {
        primary.replaceChildren();
        fallback.replaceChildren();
        const cards = rule.sources.map((_source, sourceIndex) => sourceEditor(sourceIndex ? fallback : primary, rule, sourceIndex, renderSources));
        addSource.disabled = rule.sources.length >= 8;
        if (focusField) cards[focusIndex].querySelector(`[data-field="${focusField}"]`).focus();
      }
      renderSources();
      node("h5", advanced, null, "Token adjustments");
      node("p", advanced, "field-help", "Applied in the listed order. The common XSRF cookie setup already includes URL decoding.");
      const adjustments = node("div", advanced, "token-adjustments");
      const addTransform = button(advanced, "Add adjustment", "transform-add", () => { rule.transforms.push("trim"); renderTransforms(); onChange(); });
      function renderTransforms() {
        adjustments.replaceChildren();
        rule.transforms.forEach((transform, transformIndex) => {
          const row = node("div", adjustments, "token-adjustment");
          field(row, "transform", `Adjustment ${transformIndex + 1}`, transform, value => { rule.transforms[transformIndex] = value; }, { choices: transforms });
          reorder(row, rule.transforms, transformIndex, "adjustment", renderTransforms);
        });
        addTransform.disabled = rule.transforms.length >= 4;
      }
      renderTransforms();
      field(advanced, "token-prefix", "Text before the token (optional)", rule.prefix, value => { rule.prefix = value; }, { maxLength: 256, hint: "For example, Bearer followed by a space. Spaces are kept exactly as entered." });
      const methods = node("fieldset", advanced, "method-options");
      node("legend", methods, null, "Attach to these request methods");
      const choices = node("div", methods, "method-choices");
      for (const method of methodChoices) {
        const label = node("label", choices, "checkbox-label");
        const input = node("input", label);
        input.type = "checkbox";
        input.value = method;
        input.dataset.field = "method";
        input.checked = rule.methods.includes(method);
        node("span", label, null, method);
        input.addEventListener("change", () => {
          rule.methods = input.checked ? [...rule.methods, method] : rule.methods.filter(item => item !== method);
          onChange();
        });
      }
      field(methods, "other-methods", "Other methods (optional, comma-separated)", rule.methods.filter(method => !methodChoices.includes(method)).join(", "), value => {
        const extra = value.split(",").map(method => method.trim().toUpperCase()).filter(Boolean);
        // Preserve the order of imported methods as well as nonstandard methods.
        rule.methods = [...rule.methods.filter(method => methodChoices.includes(method) || extra.includes(method)),
          ...extra.filter(method => !rule.methods.includes(method))];
      }, { hint: "Usually leave the default POST, PUT, PATCH, and DELETE selected. Form and JSON targets cannot be used with GET or HEAD." });
      node("p", card, "form-error").setAttribute("role", "status");
      return card;
    }

    function profileEditor(entry, open) {
      const profile = entry.profile;
      const card = details(container, "", open, "tab-profile");
      entry.element = card;
      const summary = card.querySelector("summary");
      const name = node("span", summary, "profile-title");
      const address = node("span", summary, "profile-address");
      const body = node("div", card, "profile-body");
      const fields = node("div", body, "profile-fields");
      const command = node("code", body, "profile-command");
      let removeProfile;
      function updateHeading() {
        name.textContent = profile.name || "New profile";
        address.textContent = profile.origin || "Add the API’s website address";
        command.textContent = `browser-proxy --tab-profile ${profile.name || "NAME"} URL`;
        removeProfile?.setAttribute("aria-label", `Remove profile ${profile.name || "unnamed"}`);
      }
      field(fields, "profile-name", "Profile name", profile.name, value => { profile.name = value; updateHeading(); }, {
        required: true, maxLength: 64, pattern: "[A-Za-z0-9._\\-]+", placeholder: "work-app", hint: "A short name for the CLI: letters, numbers, dots, underscores, or hyphens.",
      });
      field(fields, "profile-origin", "API website address", profile.origin, value => { profile.origin = value; updateHeading(); }, {
        required: true, type: "url", maxLength: 16384, placeholder: "https://api.example.com", hint: "Scheme and host only; no API path. For example, https://api.example.com.",
      });
      field(fields, "profile-page", "Application page URL (optional)", profile.page_url, value => { profile.page_url = value; }, {
        type: "url", maxLength: 16384, placeholder: "https://app.example.com/dashboard", hint: "A page you use after logging in. Leave blank to use the API website’s home page.",
      });
      updateHeading();
      const pageOptions = details(body, "Page readiness (optional)", Boolean(profile.wait_for));
      field(pageOptions, "profile-wait", "Wait for a page element", profile.wait_for, value => { profile.wait_for = value; }, {
        placeholder: 'meta[name="csrf-token"]', hint: "An optional CSS selector. Use this if the site adds its token after the page loads.",
      });
      node("h3", body, "token-heading", "CSRF tokens");
      const list = node("div", body, "token-rules");
      const addRow = node("div", body, "add-rule-row");
      let chosenRecipe = "xsrf";
      field(addRow, "rule-recipe", "Start with a common setup", chosenRecipe, value => { chosenRecipe = value; }, { choices: recipes, transient: true });
      const addRule = button(addRow, "Add token rule", "rule-add", () => {
        profile.csrf.push(recipe(chosenRecipe));
        renderRules();
        list.lastElementChild.querySelector("h4").focus();
        onChange();
      });
      function renderRules() {
        list.replaceChildren();
        if (!profile.csrf.length) node("p", list, "empty-rules", "No token rules. This profile only selects a website tab. Add a rule if the site requires a CSRF token.");
        profile.csrf.forEach((rule, index) => ruleEditor(list, rule, index, () => {
          profile.csrf.splice(index, 1);
          renderRules();
          (list.querySelectorAll("h4")[Math.min(index, profile.csrf.length - 1)] || addRule).focus();
          onChange();
        }));
        addRule.disabled = profile.csrf.length >= 8;
      }
      renderRules();
      const footer = node("div", body, "profile-footer");
      removeProfile = button(footer, "Remove profile", "profile-remove", () => {
        const index = entries.indexOf(entry);
        entries.splice(index, 1);
        card.remove();
        emptyState();
        (entries[Math.min(index, entries.length - 1)]?.element.querySelector("summary") || document.querySelector("#add-tab-profile")).focus();
        onChange();
      });
      updateHeading();
      node("p", body, "form-error profile-error").setAttribute("role", "status");
    }

    function emptyState() {
      container.querySelector(".empty-profiles")?.remove();
      if (!entries.length) node("p", container, "empty-profiles", "No website profiles yet. Add a profile to set up tab requests and automatic CSRF tokens.");
    }

    function reveal(element) {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (parent.tagName === "DETAILS") parent.open = true;
      }
    }

    function invalid(input, message) {
      input.setCustomValidity(message);
      reveal(input);
      input.reportValidity();
      input.focus();
      throw new Error(message);
    }

    function selector(input) {
      if (!input?.value.trim()) return;
      try { document.createDocumentFragment().querySelector(input.value); }
      catch { invalid(input, "Enter a valid CSS selector for the page element."); }
    }

    return {
      get count() { return entries.length; },
      load(config) {
        const normalized = BrowserProxyTabSettings.normalize(config);
        entries = normalized.profiles.map(profile => ({ profile: structuredClone(profile) }));
        container.replaceChildren();
        entries.forEach((entry, index) => profileEditor(entry, index === 0));
        emptyState();
      },
      add() {
        if (entries.length >= 64) return;
        let number = 1;
        while (entries.some(entry => entry.profile.name === `site-${number}`)) number++;
        const entry = { profile: { name: `site-${number}`, origin: "", page_url: "", csrf: [] } };
        entries.push(entry);
        profileEditor(entry, true);
        emptyState();
        entry.element.querySelector('[data-field="profile-name"]').focus();
        onChange();
      },
      read() {
        const inputs = container.querySelectorAll("input, select");
        for (const input of inputs) input.setCustomValidity("");
        for (const output of container.querySelectorAll(".form-error")) output.textContent = "";
        for (const input of inputs) {
          if (!input.checkValidity()) invalid(input, input.validationMessage);
        }
        const names = new Set();
        const profiles = entries.map(entry => {
          const card = entry.element;
          const profile = structuredClone(entry.profile);
          const originInput = card.querySelector('[data-field="profile-origin"]');
          try {
            const parsed = BrowserProxyPolicy.parseRequestUrl(profile.origin.trim());
            if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.hostname.includes("*")) throw new Error();
            profile.origin = parsed.origin;
          } catch { invalid(originInput, "Enter only an HTTP(S) website address, such as https://api.example.com, without a path or wildcard."); }
          if (!profile.page_url.trim()) delete profile.page_url;
          if (!profile.wait_for?.trim()) delete profile.wait_for;
          const nameInput = card.querySelector('[data-field="profile-name"]');
          if (names.has(profile.name)) invalid(nameInput, "Choose a unique profile name.");
          names.add(profile.name);
          selector(card.querySelector('[data-field="profile-wait"]'));
          for (const input of card.querySelectorAll('[data-field="source-selector"]')) selector(input);
          try { BrowserProxyTabSettings.normalize({ version: 1, profiles: [{ ...profile, csrf: [] }] }); }
          catch (error) {
            card.open = true;
            card.querySelector(".profile-error").textContent = error.message;
            throw new Error(`${profile.name}: ${error.message}`);
          }
          profile.csrf.forEach((rule, index) => {
            try { BrowserProxyTabSettings.normalize({ version: 1, profiles: [{ ...profile, csrf: [rule] }] }); }
            catch (error) {
              const ruleCard = card.querySelectorAll(".token-rule")[index];
              ruleCard.querySelector(".form-error").textContent = error.message;
              card.open = true;
              ruleCard.querySelector(".rule-advanced").open = true;
              ruleCard.querySelector("h4").focus();
              throw new Error(`${profile.name}, token rule ${index + 1}: ${error.message}`);
            }
          });
          return profile;
        });
        return BrowserProxyTabSettings.normalize({ version: 1, profiles });
      },
    };
  }

  root.BrowserProxyProfileEditor = { create };
})(globalThis);
