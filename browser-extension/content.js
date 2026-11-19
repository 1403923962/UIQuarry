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

  let stopCurrentPicker;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "START_PICKER") {
      try {
        startPicker(message);
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    }
  });

  function canPick(node) {
    return node !== document.body && node !== document.documentElement && !OMIT_TAGS.has(node.tagName.toUpperCase());
  }

  function isRendered(node) {
    const rect = node.getBoundingClientRect();
    if (!node.isConnected || rect.width <= 0 || rect.height <= 0) return false;
    if (node.checkVisibility) return node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const style = getComputedStyle(node);
    return style.display !== "none" && style.visibility === "visible" && style.opacity !== "0";
  }

  function uniqueTarget(selector) {
    let matches;
    try {
      matches = document.querySelectorAll(selector);
    } catch {
      throw new Error("CSS 选择器语法有误。");
    }
    if (!matches.length) throw new Error("当前文档中没有匹配这个选择器的元素。");
    if (matches.length > 1) throw new Error(`匹配了 ${matches.length} 个元素，请缩小选择范围。`);
    if (!canPick(matches[0]) || !isRendered(matches[0])) throw new Error("匹配的元素不可见或不支持采集。");
    return matches[0];
  }

  function startPicker(metadata) {
    stopCurrentPicker?.();
    if (!document.documentElement) throw new Error("页面还没有准备好。");
    const selector = metadata.targetSelector?.trim();
    const locked = selector ? uniqueTarget(selector) : null;
    const overlay = document.createElement("div");
    overlay.setAttribute("data-uiquarry-overlay", "true");
    Object.assign(overlay.style, {
      all: "initial", position: "fixed", zIndex: "2147483647", pointerEvents: "none", display: "none",
      border: "2px solid #25b981", background: "rgba(37,185,129,.13)", boxSizing: "border-box"
    });
    const hint = document.createElement("div");
    hint.setAttribute("data-uiquarry-hint", "true");
    Object.assign(hint.style, {
      all: "initial", position: "fixed", zIndex: "2147483647", pointerEvents: "none", top: "8px", left: "8px",
      maxWidth: "calc(100vw - 16px)", boxSizing: "border-box", overflowWrap: "anywhere", padding: "6px 10px",
      background: "#182820", color: "white", borderRadius: "6px", font: "13px/1.4 system-ui,sans-serif"
    });
    document.documentElement.append(overlay, hint);

    const canvases = document.getElementsByTagName("canvas");
    const controller = new AbortController();
    const options = { capture: true, signal: controller.signal };
    let point = null;
    let pinned = false;
    let layers = locked ? [locked] : [];
    let index = 0;
    let wheelPixels = 0;
    let lastWheelTime = 0;

    function finish() {
      controller.abort();
      overlay.remove();
      hint.remove();
      stopCurrentPicker = null;
    }

    function redraw() {
      const node = layers[index];
      overlay.style.display = node ? "block" : "none";
      if (!node) {
        hint.textContent = "将鼠标移到要采集的位置 · Esc 取消";
        return;
      }
      const rect = node.getBoundingClientRect();
      Object.assign(overlay.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      const target = node.localName + (node.id ? "#" + node.id : "");
      if (locked) {
        hint.textContent = `${target} · 选择器已锁定 · 点击或 Enter 保存 · Esc 退出`;
      } else if (pinned) {
        hint.textContent = `${target} · 已定点 · 第 ${index + 1}/${layers.length} 层 · 滚轮/↑↓ 切层 · C 选画布 · 点击或 Enter 保存 · Esc 重选`;
      } else {
        hint.textContent = `${target} · 左键定点 · 滚轮翻页 · Esc 退出`;
      }
    }

    function refresh(x, y) {
      point = { x, y };
      if (!locked && !pinned) {
        const hits = document.elementsFromPoint(x, y).filter(node => node !== overlay && node !== hint && canPick(node));
        const candidates = new Set(hits);
        // Native hit testing omits pointer-transparent canvases, including fixed backgrounds.
        for (const canvas of canvases) {
          if (candidates.has(canvas)) continue;
          const rect = canvas.getBoundingClientRect();
          if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom && isRendered(canvas)) candidates.add(canvas);
        }
        layers = [...candidates];
        index = 0;
      }
      redraw();
    }

    function cycleLayer(direction) {
      index = (index + direction + layers.length) % layers.length;
      redraw();
    }

    function pin() {
      if (!layers.length) return;
      pinned = true;
      wheelPixels = 0;
      document.addEventListener("wheel", onPinnedWheel, { ...options, passive: false });
      redraw();
    }

    function unpin() {
      pinned = false;
      document.removeEventListener("wheel", onPinnedWheel, true);
      refresh(point.x, point.y);
    }

    function confirm() {
      const node = layers[index];
      if (!node) return;
      finish();
      if (!isRendered(node)) {
        showToast("选中的元素已消失，请重新选择。");
        return;
      }
      try {
        const capture = createCapture(node, metadata);
        chrome.runtime.sendMessage({ type: "COMPONENT_CAPTURED", capture, includeScreenshot: metadata.includeScreenshot === true }, (result) => {
          if (chrome.runtime.lastError || !result?.ok) {
            showToast(result?.error ? `保存失败：${result.error}` : "保存失败，请重试");
            return;
          }
          let message = "已保存到本机 UIQuarry 库";
          if (node.localName === "canvas") message = capture.canvasBitmap ? "已保存 Canvas 元素及其独立画面" : "已保存 Canvas 结构，画布像素不可用";
          if (result.screenshotUnavailable) message += "（可视区域截图不可用）";
          else if (result.screenshotCaptured) message += "（含可视区域截图）";
          showToast(message);
        });
      } catch (error) {
        showToast(`捕获失败：${error.message}`);
      }
    }

    const onViewportChange = () => {
      if (point && !pinned && !locked) refresh(point.x, point.y);
      else redraw();
    };
    document.addEventListener("mousemove", event => {
      if (pinned) point = { x: event.clientX, y: event.clientY };
      else if (!locked) refresh(event.clientX, event.clientY);
    }, options);
    function onPinnedWheel(event) {
      if (!event.cancelable || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
          Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
        wheelPixels = 0;
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (layers.length < 2) return;
      const direction = Math.sign(event.deltaY);
      if (event.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
        // Trackpads often send a stream of tiny deltas for one movement.
        if (event.timeStamp - lastWheelTime > 200 || Math.sign(wheelPixels) !== direction) wheelPixels = 0;
        lastWheelTime = event.timeStamp;
        wheelPixels += event.deltaY;
        if (Math.abs(wheelPixels) < 32) return;
      }
      wheelPixels = 0;
      cycleLayer(direction);
    }
    document.addEventListener("click", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!locked && !pinned) {
        refresh(event.clientX, event.clientY);
        pin();
        return;
      }
      confirm();
    }, options);
    document.addEventListener("keydown", event => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      const key = event.key.toLowerCase();
      if (!["escape", "enter", "arrowup", "arrowdown", "[", "]", "c"].includes(key)) return;
      if (!pinned && key !== "escape" && key !== "enter") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (key === "escape") {
        if (!event.repeat) { if (pinned) unpin(); else finish(); }
        return;
      }
      if (key === "enter") {
        if (!event.repeat) { if (locked || pinned) confirm(); else pin(); }
        return;
      }
      wheelPixels = 0;
      if (key === "c") {
        if (!layers.some(node => node.localName === "canvas")) {
          hint.textContent = "此处没有可选画布，请移动到画布上方。";
          return;
        }
        for (let i = 1; i <= layers.length; i++) {
          const next = (index + i) % layers.length;
          if (layers[next].localName === "canvas") { index = next; break; }
        }
      } else {
        cycleLayer(key === "arrowup" || key === "[" ? -1 : 1);
        return;
      }
      redraw();
    }, options);
    window.addEventListener("scroll", onViewportChange, options);
    window.addEventListener("resize", onViewportChange, options);
    window.addEventListener("pagehide", finish, options);
    stopCurrentPicker = finish;
    redraw();
  }

  function createCapture(root, metadata) {
    const rect = root.getBoundingClientRect();
    const selector = selectorFor(root);
    const state = { cssRules: [], count: 0 };
    const clone = cloneSanitized(root, state, true);
    if (!clone) throw new Error("The selected element cannot be captured.");
    const html = clone.outerHTML;
    if (new TextEncoder().encode(html).byteLength > 2_000_000) throw new Error("Selected subtree exceeds 2 MB. Select a smaller component.");
    const css = state.cssRules.join("\n");
    if (new TextEncoder().encode(css).byteLength > 1_000_000) throw new Error("Selected styles exceed 1 MB. Select a smaller component.");

    const capture = {
      schemaVersion: 1,
      name: cleanText(metadata.name || root.getAttribute("aria-label") || root.tagName.toLowerCase(), 100),
      tags: Array.isArray(metadata.tags) ? metadata.tags.map((tag) => cleanText(tag, 40)).filter(Boolean).slice(0, 20) : [],
      sourceUrl: sanitizedSourceUrl(),
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
    if (root instanceof HTMLCanvasElement) captureCanvasFrame(root, capture);
    return capture;
  }

  function captureCanvasFrame(canvas, capture) {
    const { width, height } = canvas;
    let reason;
    if (!width || !height) {
      reason = "画布尺寸为零";
    } else if (width * height > 16_777_216) {
      reason = "画布超过 1600 万像素";
    } else {
      try {
        const dataUrl = canvas.toDataURL("image/png");
        if (dataUrl.startsWith("data:image/png;base64,") && dataUrl.length <= 5_000_000) {
          capture.canvasBitmap = { width, height, dataUrl };
          return;
        }
        reason = "画布未返回 PNG 或图像过大";
      } catch (error) {
        reason = error.name === "SecurityError" ? "浏览器限制读取含跨域资源的画布" : "浏览器无法读取画布";
      }
    }
    capture.notes = `仅保存画布元素和样式。${reason}。`;
  }

  // Rebuild the tree recursively to keep each original element paired with the
  // corresponding sanitized clone, even when omitted nodes are removed.
  function cloneSanitized(original, state, isRoot = false) {
    if (original.nodeType === Node.TEXT_NODE) return document.createTextNode(original.textContent || "");
    if (original.nodeType !== Node.ELEMENT_NODE || OMIT_TAGS.has(original.tagName) || state.count >= 300) return null;
    if (!isRoot && isHidden(original)) return null;

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

  function sanitizedSourceUrl() {
    const url = new URL(location.href);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href.slice(0, 2000);
  }

  function isHidden(element) {
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return true;
    const style = getComputedStyle(element);
    return style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse";
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
