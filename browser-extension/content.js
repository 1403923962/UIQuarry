(() => {
  if (globalThis.__uiquarryContentInstalled) return;
  globalThis.__uiquarryContentInstalled = true;

  const STYLE_PROPERTIES = [
    "display", "position", "box-sizing", "width", "height", "min-width", "max-width", "min-height", "max-height",
    "margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom", "padding-left",
    "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "text-align", "text-transform",
    "color", "background-color", "background-image", "background-size", "background-position", "border", "border-radius",
    "box-shadow", "opacity", "overflow", "object-fit", "vertical-align", "align-items", "align-content", "justify-content",
    "flex-direction", "flex-wrap", "flex", "gap", "grid-template-columns", "grid-template-rows", "transform", "cursor"
  ];
  const OMIT_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "OBJECT", "EMBED", "TEMPLATE"]);
  const BAD_ATTRIBUTES = /^(?:on\w+|value|checked|selected|srcdoc|nonce|integrity|autofocus|style|srcset)$/i;
  const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "poster", "xlink:href"]);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "START_PICKER") {
      startPicker(message).then(sendResponse);
      return true;
    }
  });

  function startPicker(metadata) {
    return new Promise((resolve) => {
      if (!document.documentElement) return resolve({ ok: false, error: "Page is not ready." });
      const overlay = document.createElement("div");
      overlay.setAttribute("data-uiquarry-overlay", "true");
      Object.assign(overlay.style, {
        all: "initial", position: "fixed", zIndex: "2147483647", pointerEvents: "none", display: "none",
        border: "2px solid #25b981", background: "rgba(37,185,129,.13)", boxSizing: "border-box",
        font: "12px/1.2 system-ui,sans-serif", color: "#fff", textShadow: "0 1px 3px #000", padding: "3px 5px"
      });
      document.documentElement.appendChild(overlay);
      let active = true;

      const finish = (result) => {
        if (!active) return;
        active = false;
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("keydown", onKey, true);
        overlay.remove();
        resolve(result);
      };
      const onMove = (event) => {
        const node = document.elementFromPoint(event.clientX, event.clientY);
        if (!node || node === overlay || node === document.documentElement || node === document.body) {
          overlay.style.display = "none";
          return;
        }
        const rect = node.getBoundingClientRect();
        Object.assign(overlay.style, { display: "block", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
        overlay.textContent = `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}`;
      };
      const onClick = (event) => {
        if (!active) return;
        const node = document.elementFromPoint(event.clientX, event.clientY);
        if (!node || node === overlay || node === document.documentElement || node === document.body) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        try {
          const capture = createCapture(node, metadata);
          chrome.runtime.sendMessage({ type: "COMPONENT_CAPTURED", capture }, (result) => {
            const error = chrome.runtime.lastError;
            showToast(error ? "保存失败，请重试" : "已保存到本机 UIQuarry 库");
          });
          finish({ ok: true });
        } catch (error) {
          showToast(`Capture failed: ${error.message}`);
          finish({ ok: false, error: error.message });
        }
      };
      const onKey = (event) => {
        if (event.key === "Escape") finish({ ok: true, cancelled: true });
      };
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("click", onClick, true);
      document.addEventListener("keydown", onKey, true);
      resolve({ ok: true });
    });
  }

  function createCapture(root, metadata) {
    const rect = root.getBoundingClientRect();
    const selector = selectorFor(root);
    const state = { cssRules: [], count: 0 };
    const clone = cloneSanitized(root, state);
    if (!clone) throw new Error("The selected element cannot be captured.");
    const html = clone.outerHTML;
    if (new TextEncoder().encode(html).byteLength > 2_000_000) throw new Error("Selected subtree exceeds 2 MB. Select a smaller component.");
    const css = state.cssRules.join("\n");
    if (new TextEncoder().encode(css).byteLength > 1_000_000) throw new Error("Selected styles exceed 1 MB. Select a smaller component.");

    return {
      schemaVersion: 1,
      name: cleanText(metadata.name || root.getAttribute("aria-label") || root.tagName.toLowerCase(), 100),
      tags: Array.isArray(metadata.tags) ? metadata.tags.map((tag) => cleanText(tag, 40)).filter(Boolean).slice(0, 20) : [],
      sourceUrl: location.href.slice(0, 2000),
      capturedAt: new Date().toISOString(),
      selector,
      html,
      css,
      scripts: [],
      events: [],
      viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio || 1 },
      bounds: { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) },
      notes: "Scripts and interaction events are not collected automatically. Add only explicitly selected, licensed source in a later recording step. Input values are removed; review captured text and URLs before sharing."
    };
  }

  // Rebuild the tree recursively to keep each original element paired with the
  // corresponding sanitized clone, even when omitted nodes are removed.
  function cloneSanitized(original, state) {
    if (original.nodeType === Node.TEXT_NODE) return document.createTextNode(original.textContent || "");
    if (original.nodeType !== Node.ELEMENT_NODE || OMIT_TAGS.has(original.tagName) || state.count >= 300) return null;

    const copy = original.cloneNode(false);
    const quarryId = `q${state.count++}`;
    for (const attribute of [...copy.attributes]) {
      const name = attribute.name.toLowerCase();
      if (BAD_ATTRIBUTES.test(name) || name.startsWith("data-uiquarry-") || (URL_ATTRIBUTES.has(name) && !isSafeUrl(attribute.value))) {
        copy.removeAttribute(attribute.name);
      }
    }
    if (copy.matches("input,textarea,select,option")) {
      copy.removeAttribute("value");
      copy.removeAttribute("checked");
      copy.removeAttribute("selected");
      if (copy.tagName === "TEXTAREA") copy.textContent = "";
    }
    copy.setAttribute("data-quarry-capture-id", quarryId);
    const style = getComputedStyle(original);
    const declarations = STYLE_PROPERTIES.map((property) => [property, style.getPropertyValue(property)])
      .filter(([, value]) => value && value !== "normal" && value !== "none" && !/url\s*\(/i.test(value));
    if (declarations.length) {
      state.cssRules.push(`[data-quarry-capture-id="${quarryId}"]{${declarations.map(([property, value]) => `${property}:${value}`).join(";")}}`);
    }
    for (const child of original.childNodes) {
      const childCopy = cloneSanitized(child, state);
      if (childCopy) copy.appendChild(childCopy);
    }
    return copy;
  }

  function isSafeUrl(value) {
    const raw = String(value || "").trim();
    if (!raw || raw.startsWith("#")) return true;
    try {
      const parsed = new URL(raw, document.baseURI);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  function selectorFor(element) {
    if (element.id) return `#${CSS.escape(element.id)}`;
    const parts = [];
    let node = element;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id) { part += `#${CSS.escape(node.id)}`; parts.unshift(part); break; }
      const classes = [...node.classList].filter((name) => name.length < 50).slice(0, 2);
      if (classes.length) part += classes.map((name) => `.${CSS.escape(name)}`).join("");
      const siblings = node.parentElement ? [...node.parentElement.children].filter((child) => child.tagName === node.tagName) : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ") || element.tagName.toLowerCase();
  }

  function cleanText(value, maxLength) { return String(value).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, maxLength); }
  function round(value) { return Math.round(value * 100) / 100; }
  function showToast(message) {
    const toast = document.createElement("div");
    toast.textContent = message;
    Object.assign(toast.style, { all: "initial", position: "fixed", zIndex: "2147483647", bottom: "20px", left: "50%", transform: "translateX(-50%)", padding: "10px 14px", borderRadius: "8px", color: "white", background: "#202a25", font: "13px system-ui,sans-serif", boxShadow: "0 3px 16px #0004" });
    document.documentElement.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);
  }
})();
