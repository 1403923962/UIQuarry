const MAX_RECENT = 50;
const MAX_LOCAL_BYTES = 8 * 1024 * 1024;
const MAX_IMPORTED_BYTES = MAX_LOCAL_BYTES;
const MAX_SCREENSHOT_CHARS = 7 * 1024 * 1024;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "COMPONENT_CAPTURED" && message.capture) {
    saveCapture(message.capture, message.includeScreenshot === true ? (sender.tab ?? { active: false }) : null).then(sendResponse).catch((error) => {
      console.error("UIQuarry local save failed", error);
      sendResponse({ ok: false, error: "本地保存失败" });
    });
    return true;
  }
  if (message?.type === "GET_RECENT") {
    chrome.storage.local.get({ captures: [] }).then(({ captures }) => sendResponse({ captures })).catch(() => sendResponse({ captures: [] }));
    return true;
  }
  if (message?.type === "DELETE_CAPTURE" && typeof message.localId === "string") {
    deleteCapture(message.localId).then(sendResponse).catch(() => sendResponse({ ok: false, error: "本地删除失败" }));
    return true;
  }
  if (message?.type === "IMPORT_CAPTURE" && message.capture) {
    importCapture(message.capture).then(sendResponse).catch(() => sendResponse({ ok: false, error: "本地导入失败" }));
    return true;
  }
});

async function importCapture(value) {
  if (!isValidCapture(value)) return { ok: false, error: "文件不是有效的 Capture v1" };
  const capture = { ...value };
  for (const field of ["id", "createdAt", "localId", "savedAt", "sync", "syncError", "serverId"]) delete capture[field];
  if (storageBytes([capture]) > MAX_IMPORTED_BYTES) return { ok: false, error: "Capture JSON 超过大小上限" };
  return saveCapture(capture);
}

function isValidCapture(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1) return false;
  for (const field of ["name", "sourceUrl", "capturedAt", "selector", "html", "css"]) {
    if (typeof value[field] !== "string" || !value[field].trim()) return false;
  }
  if (!/^https?:\/\//i.test(value.sourceUrl) || Number.isNaN(Date.parse(value.capturedAt))) return false;
  if (new TextEncoder().encode(value.html).byteLength > 2_000_000 || new TextEncoder().encode(value.css).byteLength > 1_000_000) return false;
  if (!Array.isArray(value.scripts) || !Array.isArray(value.events) || !value.viewport || !value.bounds) return false;
  if (value.screenshot !== undefined && (typeof value.screenshot !== "string" || value.screenshot.length > MAX_SCREENSHOT_CHARS || !/^data:image\/(?:jpeg|png);base64,(?=.+$)(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.screenshot))) return false;
  if (value.scripts.length > 100 || value.events.length > 1000) return false;
  if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.length > 50 || value.tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > 64))) return false;
  if (value.scripts.some((script) => !script || typeof script !== "object" || !["inline", "external", "module", "reference"].includes(script.kind) || typeof script.source !== "string" || script.source.length > 200_000 || typeof script.relation !== "string")) return false;
  if (value.events.some((event) => !event || typeof event !== "object" || typeof event.type !== "string" || typeof event.target !== "string" || !Number.isFinite(event.atMs) || event.atMs < 0)) return false;
  if (!Number.isFinite(value.viewport.width) || value.viewport.width < 0 || !Number.isFinite(value.viewport.height) || value.viewport.height < 0) return false;
  return Number.isFinite(value.bounds.x) && Number.isFinite(value.bounds.y) && Number.isFinite(value.bounds.width) && value.bounds.width >= 0 && Number.isFinite(value.bounds.height) && value.bounds.height >= 0;
}

async function saveCapture(capture, screenshotTab = null) {
  const { captures = [] } = await chrome.storage.local.get({ captures: [] });
  const storedCapture = { ...capture };
  let screenshotUnavailable = false;
  if (screenshotTab) {
    try {
      if (screenshotTab.active !== true || !Number.isInteger(screenshotTab.windowId)) throw new Error("Capture tab is no longer active");
      const screenshot = await chrome.tabs.captureVisibleTab(screenshotTab.windowId, { format: "jpeg", quality: 78 });
      if (typeof screenshot !== "string" || !screenshot.startsWith("data:image/jpeg;base64,") || screenshot.length > MAX_SCREENSHOT_CHARS) {
        throw new Error("Screenshot was not a bounded JPEG data URL");
      }
      storedCapture.screenshot = screenshot;
    } catch (error) {
      console.warn("UIQuarry viewport screenshot unavailable", error);
      screenshotUnavailable = true;
    }
  }
  const localRecord = { ...storedCapture, localId: crypto.randomUUID(), savedAt: new Date().toISOString() };
  let screenshotCaptured = Boolean(localRecord.screenshot);
  if (storageBytes([localRecord]) > MAX_LOCAL_BYTES) {
    if (screenshotCaptured) {
      delete localRecord.screenshot;
      screenshotCaptured = false;
      screenshotUnavailable = true;
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
  return { ok: true, screenshotCaptured, screenshotUnavailable };
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
