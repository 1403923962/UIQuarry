const MAX_RECENT = 50;
const MAX_LOCAL_BYTES = 8 * 1024 * 1024;
const MAX_IMPORTED_BYTES = MAX_LOCAL_BYTES;
const MAX_SCREENSHOT_CHARS = 7 * 1024 * 1024;
const MAX_COMPOSITE_CHARS = 3_000_000;
const MAX_RECORDING_CHARS = 3_000_000;
let storageWriteQueue = Promise.resolve();

function enqueueStorageWrite(operation) {
  const next = storageWriteQueue.then(operation, operation);
  storageWriteQueue = next.catch(() => {});
  return next;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "COMPONENT_CAPTURED" && message.capture) {
    enqueueStorageWrite(() => saveCapture(message.capture, {
      sender,
      includeScreenshot: message.includeScreenshot === true,
      includeComposite: message.includeComposite === true
    })).then(sendResponse).catch((error) => {
      console.error("UIQuarry local save failed", error);
      sendResponse({ ok: false, error: "本地保存失败" });
    });
    return true;
  }
  if (message?.type === "GET_RECENT") {
    chrome.storage.local.get({ captures: [] }).then(({ captures }) => sendResponse({ captures, storageBytes: storageBytes(captures) })).catch(() => sendResponse({ captures: [], storageBytes: 0 }));
    return true;
  }
  if (message?.type === "DELETE_CAPTURE" && typeof message.localId === "string") {
    enqueueStorageWrite(() => deleteCapture(message.localId)).then(sendResponse).catch(() => sendResponse({ ok: false, error: "本地删除失败" }));
    return true;
  }
  if (message?.type === "IMPORT_CAPTURE" && message.capture) {
    enqueueStorageWrite(() => importCapture(message.capture)).then(sendResponse).catch(() => sendResponse({ ok: false, error: "本地导入失败" }));
    return true;
  }
});

async function importCapture(value) {
  if (!isValidCapture(value)) return { ok: false, error: "文件不是有效的 Capture v1" };
  const capture = { ...value };
  for (const field of ["id", "createdAt", "localId", "savedAt", "sync", "syncError", "serverId"]) delete capture[field];
  if (storageBytes([capture]) > MAX_IMPORTED_BYTES) return { ok: false, error: "Capture JSON 超过大小上限" };
  return saveCapture(capture, { preserveAttachments: true });
}

function isValidCapture(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1) return false;
  for (const field of ["name", "sourceUrl", "capturedAt", "selector", "html", "css"]) {
    if (typeof value[field] !== "string" || !value[field].trim()) return false;
  }
  if (!/^https?:\/\//i.test(value.sourceUrl) || Number.isNaN(Date.parse(value.capturedAt))) return false;
  if (new TextEncoder().encode(value.html).byteLength > 2_000_000 || new TextEncoder().encode(value.css).byteLength > 1_000_000) return false;
  if (!Array.isArray(value.scripts) || !Array.isArray(value.events) || !value.viewport || !value.bounds) return false;
  if (value.canvasBitmap !== undefined && !validCanvasBitmap(value.canvasBitmap)) return false;
  if (value.screenshot !== undefined && (typeof value.screenshot !== "string" || value.screenshot.length > MAX_SCREENSHOT_CHARS || !/^data:image\/(?:jpeg|png);base64,(?=.+$)(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.screenshot))) return false;
  if (value.compositeBitmap !== undefined && !validImageBitmap(value.compositeBitmap, "jpeg", MAX_COMPOSITE_CHARS)) return false;
  if (value.canvasRecording !== undefined && !validCanvasRecording(value.canvasRecording)) return false;
  if (value.animations !== undefined && !validAnimations(value.animations)) return false;
  if (value.scripts.length > 100 || value.events.length > 1000) return false;
  if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.length > 50 || value.tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > 64))) return false;
  if (value.scripts.some((script) => !script || typeof script !== "object" || !["inline", "external", "module", "reference"].includes(script.kind) || typeof script.source !== "string" || script.source.length > 200_000 || typeof script.relation !== "string")) return false;
  if (value.events.some((event) => !event || typeof event !== "object" || typeof event.type !== "string" || typeof event.target !== "string" || !Number.isFinite(event.atMs) || event.atMs < 0)) return false;
  if (!Number.isFinite(value.viewport.width) || value.viewport.width < 0 || !Number.isFinite(value.viewport.height) || value.viewport.height < 0) return false;
  return Number.isFinite(value.bounds.x) && Number.isFinite(value.bounds.y) && Number.isFinite(value.bounds.width) && value.bounds.width >= 0 && Number.isFinite(value.bounds.height) && value.bounds.height >= 0;
}

function validCanvasBitmap(bitmap) {
  const prefix = "data:image/png;base64,";
  if (!bitmap || Object.keys(bitmap).length !== 3 || typeof bitmap.dataUrl !== "string" || !bitmap.dataUrl.startsWith(prefix)
      || bitmap.dataUrl.length > 5_000_000) return false;
  if (![bitmap.width, bitmap.height].every(size => Number.isSafeInteger(size) && size > 0)) return false;
  const payload = bitmap.dataUrl.slice(prefix.length);
  return validBase64(payload);
}

function validImageBitmap(bitmap, format, maxChars) {
  const prefix = "data:image/" + format + ";base64,";
  if (!bitmap || Object.keys(bitmap).length !== 3 || typeof bitmap.dataUrl !== "string" || !bitmap.dataUrl.startsWith(prefix)
      || bitmap.dataUrl.length > maxChars) return false;
  if (![bitmap.width, bitmap.height].every(size => Number.isSafeInteger(size) && size > 0)) return false;
  const payload = bitmap.dataUrl.slice(prefix.length);
  return validBase64(payload);
}

function validCanvasRecording(recording) {
  const prefix = "data:video/webm;base64,";
  if (!recording || Object.keys(recording).length !== 3 || recording.mimeType !== "video/webm"
      || !Number.isInteger(recording.durationMs) || recording.durationMs < 1 || recording.durationMs > 6000
      || typeof recording.dataUrl !== "string" || !recording.dataUrl.startsWith(prefix) || recording.dataUrl.length > MAX_RECORDING_CHARS) return false;
  const payload = recording.dataUrl.slice(prefix.length);
  return validBase64(payload);
}

function validAnimations(animations) {
  const kindSet = new Set(["CSSAnimation", "CSSTransition", "Animation"]);
  const playStates = new Set(["pending", "running", "paused", "finished"]);
  const timelines = new Set(["document", "scroll", "other", "unknown"]);
  const directions = new Set(["normal", "reverse", "alternate", "alternate-reverse"]);
  const fills = new Set(["none", "forwards", "backwards", "both", "auto"]);
  const composites = new Set(["auto", "replace", "add", "accumulate"]);
  const allowedTiming = new Set(["delay", "duration", "endDelay", "iterations", "direction", "easing", "fill"]);
  if (!Array.isArray(animations) || animations.length > 32 || storageBytes(animations) > 256 * 1024) return false;
  return animations.every(animation => {
    if (!animation || typeof animation !== "object" || Array.isArray(animation)) return false;
    const required = ["targetId", "kind", "playState", "playbackRate", "timelineType", "timing", "keyframes"];
    if (required.some(key => !(key in animation)) || Object.keys(animation).some(key => ![...required, "pseudoElement", "currentTime"].includes(key))) return false;
    if (typeof animation.targetId !== "string" || !animation.targetId || animation.targetId.length > 128 || !kindSet.has(animation.kind)) return false;
    if (animation.pseudoElement !== undefined && (typeof animation.pseudoElement !== "string" || animation.pseudoElement.length > 32)) return false;
    if (!playStates.has(animation.playState) || !Number.isFinite(animation.playbackRate) || !timelines.has(animation.timelineType)) return false;
    if (animation.currentTime !== undefined && animation.currentTime !== null && !Number.isFinite(animation.currentTime)) return false;

    const timing = animation.timing;
    if (!timing || typeof timing !== "object" || Array.isArray(timing) || Object.keys(timing).some(key => !allowedTiming.has(key)) || [...allowedTiming].some(key => !(key in timing))) return false;
    if (!Number.isFinite(timing.delay) || !Number.isFinite(timing.endDelay) || !(timing.duration === "auto" || Number.isFinite(timing.duration) && timing.duration >= 0)) return false;
    if (!(timing.iterations === "infinite" || Number.isFinite(timing.iterations) && timing.iterations >= 0) || !directions.has(timing.direction)) return false;
    if (typeof timing.easing !== "string" || timing.easing.length > 128 || !fills.has(timing.fill)) return false;

    if (!Array.isArray(animation.keyframes) || animation.keyframes.length > 32) return false;
    return animation.keyframes.every(frame => {
      if (!frame || typeof frame !== "object" || Array.isArray(frame) || !frame.properties || typeof frame.properties !== "object" || Array.isArray(frame.properties)) return false;
      if (Object.keys(frame).some(key => !["offset", "easing", "composite", "properties"].includes(key)) || Object.keys(frame.properties).length > 24) return false;
      if (frame.offset !== undefined && frame.offset !== null && (!Number.isFinite(frame.offset) || frame.offset < 0 || frame.offset > 1)) return false;
      if (frame.easing !== undefined && (typeof frame.easing !== "string" || frame.easing.length > 128)) return false;
      if (frame.composite !== undefined && !composites.has(frame.composite)) return false;
      return Object.entries(frame.properties).every(([property, value]) => /^-?[a-z][a-z0-9-]{0,80}$/.test(property) && !property.startsWith("--") && !["content", "behavior", "-moz-binding"].includes(property) &&
        (value === null || Number.isFinite(value) || typeof value === "string" && value.length <= 256 && !/url\s*\(/i.test(value)));
    });
  });
}

function validBase64(payload) {
  if (!payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return false;
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const dataLength = payload.length - padding;
  return dataLength % 4 === (padding === 0 ? 0 : padding === 1 ? 3 : 2);
}

async function saveCapture(capture, options = {}) {
  const { captures = [] } = await chrome.storage.local.get({ captures: [] });
  const storedCapture = { ...capture };
  let canvasBitmapUnavailable = false;
  if (storedCapture.canvasBitmap) {
    try {
      if (!(await canvasBitmapHasVisiblePixels(storedCapture.canvasBitmap))) {
        delete storedCapture.canvasBitmap;
        canvasBitmapUnavailable = true;
        addCaptureNote(storedCapture, "Canvas 导出的像素全透明（可能是透明画布，或 WebGL drawing buffer 在上屏后已清除）。可启用本站 WebGL 保帧并刷新后重试，也可选合成裁切或录制画布。");
      }
    } catch (error) {
      console.warn("UIQuarry canvas pixel validation unavailable", error);
    }
  }
  let screenshotUnavailable = false;
  let compositeUnavailable = false;
  const tab = options.sender?.tab;
  const wantsScreenshot = options.includeScreenshot === true;
  const wantsComposite = options.includeComposite === true;
  if (wantsScreenshot || wantsComposite) {
    let screenshot;
    try {
      if (!tab || tab.active !== true || options.sender?.frameId !== 0 || !Number.isInteger(tab.id) || !Number.isInteger(tab.windowId)) {
        throw new Error("Capture must originate from the top frame of a browser tab");
      }
      const before = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      if (before[0]?.id !== tab.id || before[0]?.windowId !== tab.windowId) throw new Error("Capture tab is no longer active");
      screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 78 });
      if (typeof screenshot !== "string" || !screenshot.startsWith("data:image/jpeg;base64,")) throw new Error("Visible viewport screenshot is unavailable");
      const after = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      if (after[0]?.id !== tab.id || after[0]?.windowId !== tab.windowId) throw new Error("Active tab changed while capturing pixels");
      if (wantsScreenshot) {
        if (screenshot.length <= MAX_SCREENSHOT_CHARS) storedCapture.screenshot = screenshot;
        else {
          screenshotUnavailable = true;
          addCaptureNote(storedCapture, "视口截图因超过单项大小限制而未保存。");
        }
      }
    } catch (error) {
      console.warn("UIQuarry compositor pixels unavailable", error);
      if (wantsScreenshot) screenshotUnavailable = true;
      if (wantsComposite) compositeUnavailable = true;
      if (wantsScreenshot) addCaptureNote(storedCapture, "未能保存视口截图。");
      if (wantsComposite) addCaptureNote(storedCapture, "未能从浏览器合成画面裁切目标区域。");
    }
    if (wantsComposite && screenshot) {
      try { storedCapture.compositeBitmap = await cropViewport(screenshot, storedCapture.bounds, storedCapture.viewport); }
      catch (error) {
        console.warn("UIQuarry compositor crop unavailable", error);
        compositeUnavailable = true;
        addCaptureNote(storedCapture, "未能从浏览器合成画面裁切目标区域。");
      }
    }
  }
  const localRecord = { ...storedCapture, localId: crypto.randomUUID(), savedAt: new Date().toISOString() };
  let screenshotCaptured = Boolean(localRecord.screenshot);
  let recordingUnavailable = false;
  if (storageBytes([localRecord]) > MAX_LOCAL_BYTES) {
    if (options.preserveAttachments) return { ok: false, error: "附件会超过本地存储配额；请先删除部分旧捕获或减小文件体积" };
    if (screenshotCaptured) {
      delete localRecord.screenshot;
      screenshotCaptured = false;
      screenshotUnavailable = true;
      addCaptureNote(localRecord, "视口截图因本地配额被省略。");
    }
    if (localRecord.compositeBitmap) {
      delete localRecord.compositeBitmap;
      compositeUnavailable = true;
      addCaptureNote(localRecord, "目标区域合成图因本地配额被省略。");
    }
    if (localRecord.canvasRecording) {
      delete localRecord.canvasRecording;
      recordingUnavailable = true;
      addCaptureNote(localRecord, "画布录像因本地配额被省略。");
    }
    if (storageBytes([localRecord]) > MAX_LOCAL_BYTES) return { ok: false, error: "捕获内容超过本地存储上限" };
  }
  const originalLength = captures.length;
  captures.unshift(localRecord);
  const removed = [];
  while (captures.length > MAX_RECENT || storageBytes(captures) > MAX_LOCAL_BYTES) removed.push(captures.pop());
  if (!captures.some((item) => item.localId === localRecord.localId)) {
    return { ok: false, error: "本地空间不足，未保存捕获内容" };
  }
  await chrome.storage.local.set({ captures });
  if (removed.length && originalLength >= MAX_RECENT) console.info(`UIQuarry pruned ${removed.length} older local capture(s) to stay within storage limits.`);
  return {
    ok: true, screenshotCaptured, screenshotUnavailable, canvasBitmapUnavailable,
    compositeCaptured: Boolean(localRecord.compositeBitmap), compositeUnavailable,
    recordingCaptured: Boolean(localRecord.canvasRecording), recordingUnavailable
  };
}

async function canvasBitmapHasVisiblePixels(bitmap) {
  const source = await createImageBitmap(dataUrlToBlob(bitmap.dataUrl));
  try {
    const probe = new OffscreenCanvas(32, 32);
    const context = probe.getContext("2d", { willReadFrequently: true });
    if (!context) return true;
    context.clearRect(0, 0, 32, 32);
    context.drawImage(source, 0, 0, 32, 32);
    const pixels = context.getImageData(0, 0, 32, 32).data;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 0) return true;
    return false;
  } finally {
    source.close();
  }
}

function addCaptureNote(capture, note) {
  const previous = typeof capture.notes === "string" ? capture.notes.trim() : "";
  capture.notes = (previous ? previous + " " : "") + note;
}

async function cropViewport(dataUrl, bounds, viewport) {
  if (!bounds || !viewport || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) {
    throw new Error("Selected element has invalid viewport geometry");
  }
  const source = await createImageBitmap(dataUrlToBlob(dataUrl));
  try {
    const scaleX = source.width / viewport.width;
    const scaleY = source.height / viewport.height;
    const x0 = Math.max(0, Math.floor(bounds.x * scaleX));
    const y0 = Math.max(0, Math.floor(bounds.y * scaleY));
    const x1 = Math.min(source.width, Math.ceil((bounds.x + bounds.width) * scaleX));
    const y1 = Math.min(source.height, Math.ceil((bounds.y + bounds.height) * scaleY));
    const width = x1 - x0;
    const height = y1 - y0;
    if (width <= 0 || height <= 0) throw new Error("Selected element is outside the visible viewport");
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Cannot create a local pixel crop");
    context.drawImage(source, x0, y0, width, height, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 });
    const dataUrl = await blobToDataUrl(blob);
    if (dataUrl.length > MAX_COMPOSITE_CHARS) throw new Error("Selected element pixel crop exceeds its size limit");
    return { width, height, dataUrl };
  } finally {
    source.close();
  }
}

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("Invalid image data URL");
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new Blob([bytes], { type: "image/jpeg" });
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type};base64,${btoa(binary)}`;
}

function storageBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

async function deleteCapture(localId) {
  const { captures = [] } = await chrome.storage.local.get({ captures: [] });
  const next = captures.filter((capture) => capture.localId !== localId);
  await chrome.storage.local.set({ captures: next });
  return { ok: true, deleted: next.length !== captures.length };
}
