const $ = (id) => document.getElementById(id);
const startButton = $("start");
let recentCaptures = [];
let selectedCapture = null;

$("library-search")?.addEventListener("input", () => renderRecent(recentCaptures));
$("domain-filter")?.addEventListener("change", () => renderRecent(recentCaptures));
$("tag-filter")?.addEventListener("change", () => renderRecent(recentCaptures));
$("export-latest-package")?.addEventListener("click", async () => {
  const capture = filterCaptures(recentCaptures)[0] || recentCaptures[0];
  if (!capture) { $("status").textContent = "没有可导出的本地捕获。"; return; }
  try {
    if (!globalThis.UIQuarryPackageExport?.download) throw new Error("组件包导出模块未加载");
    const review = await reviewForExport(capture);
    if (!review) return;
    await globalThis.UIQuarryPackageExport.download(capture, { metadata: globalThis.UIQuarryPrivacyReview.manifestMetadata(review) });
    $("status").textContent = "已开始导出最近捕获的 Git 组件包 ZIP。";
  } catch (error) { $("status").textContent = `导出失败：${error.message}`; }
});

$("import").addEventListener("click", () => $("import-file").click());
$("import-file").addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  event.target.value = "";
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    $("status").textContent = "导入失败：JSON 文件不能超过 8 MB。";
    return;
  }
  $("status").textContent = "正在读取本地文件…";
  try {
    const capture = JSON.parse(await file.text());
    const result = await sendMessage({ type: "IMPORT_CAPTURE", capture });
    if (!result?.ok) throw new Error(result?.error || "文件不是有效的 Capture v1。");
    $("status").textContent = "已导入到本浏览器。";
    loadRecent();
  } catch (error) {
    $("status").textContent = `导入失败：${error.message}`;
  }
});

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  $("status").textContent = "正在打开元素选择器…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("没有找到当前网页。");
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["canvas-recorder.js", "content.js"] });
    const reply = await chrome.tabs.sendMessage(tab.id, {
      type: "START_PICKER",
      name: $("name").value.trim() || "已捕获组件",
      tags: $("tags").value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean).slice(0, 20),
      targetSelector: $("target-selector").value.trim(),
      includeAnimations: $("include-animations").checked,
      includeScreenshot: $("include-screenshot").checked,
      includeComposite: $("include-composite").checked,
      recordAnimation: $("record-animation").checked
    });
    if (!reply?.ok) throw new Error(reply?.error || "无法打开元素选择器。");
    $("status").textContent = "选择器已开启。";
    window.close();
  } catch (error) {
    $("status").textContent = `无法开始：${error.message}`;
  } finally {
    startButton.disabled = false;
  }
});

$("close-details").addEventListener("click", () => { $("details").hidden = true; });
loadRecent();

function loadRecent() {
  chrome.runtime.sendMessage({ type: "GET_RECENT" }, (response) => {
    const error = chrome.runtime.lastError;
    if (error) {
      $("status").textContent = "无法读取本地捕获，请重新加载扩展。";
      renderRecent([]);
      return;
    }
    recentCaptures = Array.isArray(response?.captures) ? response.captures : [];
    updateStorageUsage(response?.storageBytes);
    updateLibraryFilters(recentCaptures);
    renderRecent(recentCaptures);
  });
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

function renderRecent(captures) {
  const list = $("recent");
  list.replaceChildren();
  const visible = filterCaptures(captures);
  const summary = $("library-summary");
  if (summary) summary.textContent = captures.length ? `显示 ${visible.length} / ${captures.length} 条捕获` : "";
  if (!visible.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = captures.length ? "没有符合条件的捕获" : "还没有捕获内容";
    list.append(empty);
    return;
  }
  for (const capture of visible) list.append(createCaptureRow(capture));
}

function createCaptureRow(capture) {
  const item = document.createElement("li");
  const info = document.createElement("div"); info.className = "capture-info";
  const previewUrl = capturePreviewUrl(capture);
  if (previewUrl) {
    const preview = document.createElement("img");
    preview.className = "capture-preview";
    preview.alt = "捕获预览";
    preview.src = previewUrl;
    info.append(preview);
  }
  const name = document.createElement("strong"); name.textContent = capture.name || "未命名组件";
  const meta = document.createElement("small"); meta.textContent = `${domainOf(capture.sourceUrl)} · ${formatDate(capture.capturedAt)}`;
  const metaLine = document.createElement("div"); metaLine.className = "capture-meta";
  metaLine.append(meta, ...mediaBadges(capture));
  const tags = Array.isArray(capture.tags) && capture.tags.length ? ` · ${capture.tags.slice(0, 3).join("、")}` : "";
  meta.textContent += tags;
  info.append(name, metaLine);
  const actions = document.createElement("div"); actions.className = "capture-actions";
  actions.append(actionButton("详情", "查看捕获详情", () => showDetails(capture)), actionButton("导出", "下载 Capture JSON", () => downloadCapture(capture)), actionButton("删除", "删除本地捕获", () => deleteLocalCapture(capture.localId, item), "danger"));
  item.append(info, actions); return item;
}

function actionButton(label, title, handler, kind = "") {
  const button = document.createElement("button"); button.type = "button"; button.className = `capture-action ${kind}`; button.textContent = label; button.title = title; button.addEventListener("click", handler); return button;
}

function showDetails(capture) {
  selectedCapture = capture;
  const list = $("details-list"); list.replaceChildren();
  const fields = [["名称", capture.name || "未命名组件"], ["来源", capture.sourceUrl || "未知"], ["来源域名", domainOf(capture.sourceUrl)], ["选择器", capture.selector || "未知"], ["捕获时间", formatDate(capture.capturedAt)], ["元素尺寸", capture.bounds ? `${capture.bounds.width} × ${capture.bounds.height}` : "未知"], ["本地占用", formatBytes(estimateCaptureBytes(capture))]];
  if (Array.isArray(capture.tags) && capture.tags.length) fields.push(["标签", capture.tags.join("、")]);
  const bitmap = capture.canvasBitmap?.dataUrl?.startsWith?.("data:image/png;base64,") ? capture.canvasBitmap : null;
  $("canvas-frame").hidden = !bitmap;
  $("canvas-image").removeAttribute("src");
  $("export-canvas").onclick = null;
  if (bitmap) {
    fields.push(["画布分辨率", `${bitmap.width} × ${bitmap.height} px`]);
    $("canvas-image").src = bitmap.dataUrl;
    $("export-canvas").onclick = async () => {
      try {
        await downloadDataUrl(bitmap.dataUrl, `${safeFilename(capture.selector)}.png`);
        $("status").textContent = "已开始导出画布 PNG。";
      } catch (error) {
        $("status").textContent = `导出失败：${error.message}`;
      }
    };
  } else if (capture.notes?.startsWith?.("仅保存画布元素和样式。")) {
    fields.push(["画布状态", capture.notes]);
  }
  $("details-preview").textContent = capture.html || "没有 HTML 预览";
  const screenshot = $("details-shot");
  screenshot.hidden = typeof capture.screenshot !== "string";
  screenshot.removeAttribute("src");
  if (!screenshot.hidden) screenshot.src = capture.screenshot;
  const composite = capture.compositeBitmap?.dataUrl?.startsWith?.("data:image/jpeg;base64,") ? capture.compositeBitmap : null;
  $("composite-frame").hidden = !composite;
  $("composite-image").removeAttribute("src");
  $("export-composite").onclick = null;
  if (composite) {
    fields.push(["合成裁切", `${composite.width} × ${composite.height} px`]);
    $("composite-image").src = composite.dataUrl;
    $("export-composite").onclick = async () => {
      try {
        await downloadDataUrl(composite.dataUrl, `${safeFilename(capture.selector)}-composite.jpg`);
        $("status").textContent = "已开始导出目标区域合成图。";
      } catch (error) { $("status").textContent = `导出失败：${error.message}`; }
    };
  }
  const recording = capture.canvasRecording?.dataUrl?.startsWith?.("data:video/webm;base64,") ? capture.canvasRecording : null;
  $("recording-frame").hidden = !recording;
  $("recording-video").removeAttribute("src");
  $("export-recording").onclick = null;
  if (recording) {
    fields.push(["录像时长", `${recording.durationMs} ms · WebM`]);
    $("recording-video").src = recording.dataUrl;
    $("export-recording").onclick = async () => {
      try {
        await downloadDataUrl(recording.dataUrl, `${safeFilename(capture.selector)}-recording.webm`);
        $("status").textContent = "已开始导出画布 WebM。";
      } catch (error) { $("status").textContent = `导出失败：${error.message}`; }
    };
  }
  const animations = Array.isArray(capture.animations) ? capture.animations : [];
  $("animations-frame").hidden = animations.length === 0;
  $("animations-preview").textContent = animations.length ? JSON.stringify(animations, null, 2) : "";
  $("animations-summary").textContent = `DOM 动画观察 · ${animations.length} 条（不含动画实现代码）`;
  const notes = $("details-notes");
  if (notes) {
    notes.textContent = typeof capture.notes === "string" && capture.notes.trim() ? capture.notes : "";
    notes.hidden = !notes.textContent;
  }
  const warnings = $("details-warnings");
  if (warnings) {
    const items = [];
    if (capture.sourceUrl) items.push("来源 URL 会随本地记录一起导出，请确认你有权分享该页面内容。");
    if (typeof capture.screenshot === "string") items.push("视口截图可能包含所选元素之外的页面内容。");
    if (animations.length || capture.canvasRecording) items.push("Canvas 录制和动画关键帧是观察数据，不是原始源码或可执行脚本。");
    if (Array.isArray(capture.scripts) && capture.scripts.length) items.push(`记录中包含 ${capture.scripts.length} 条脚本引用，请在分享前检查许可证。`);
    warnings.textContent = items.join("\n");
    warnings.hidden = items.length === 0;
  }
  const packageButton = $("export-package-selected");
  if (packageButton) {
    packageButton.onclick = async () => {
      try {
        if (!globalThis.UIQuarryPackageExport?.download) throw new Error("组件包导出模块未加载");
        const review = await reviewForExport(capture);
        if (!review) return;
        await globalThis.UIQuarryPackageExport.download(capture, { metadata: globalThis.UIQuarryPrivacyReview.manifestMetadata(review) });
        $("status").textContent = "已开始导出 Git 组件包 ZIP。";
      } catch (error) { $("status").textContent = `导出失败：${error.message}`; }
    };
  }
  list.replaceChildren();
  for (const [label, value] of fields) {
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value;
    description.title = value;
    list.append(term, description);
  }
  $("details").hidden = false;
}

async function downloadCapture(record) {
  const review = await reviewForExport(record);
  if (!review) return;
  const { localId: _localId, savedAt: _savedAt, ...capture } = record;
  const blob = new Blob([JSON.stringify(capture, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: `${safeFilename(capture.name || "capture")}.json`, saveAs: true, conflictAction: "uniquify" }, () => {
    const error = chrome.runtime.lastError; setTimeout(() => URL.revokeObjectURL(url), 1000); $("status").textContent = error ? `导出失败：${error.message}` : "已导出 Capture JSON。";
  });
}

async function reviewForExport(capture) {
  if (!globalThis.UIQuarryPrivacyReview?.reviewExport) {
    $("status").textContent = "导出失败：来源审阅模块未加载。";
    return null;
  }
  try {
    return await globalThis.UIQuarryPrivacyReview.reviewExport(capture);
  } catch (error) {
    $("status").textContent = `导出失败：${error.message}`;
    return null;
  }
}

function deleteLocalCapture(localId, item) {
  if (!localId) return;
  chrome.runtime.sendMessage({ type: "DELETE_CAPTURE", localId }, (result) => {
    if (chrome.runtime.lastError || !result?.ok) { $("status").textContent = "删除失败，请重试。"; return; }
    item.remove(); $("details").hidden = true; loadRecent(); $("status").textContent = result.deleted ? "已从本浏览器删除。" : "该捕获已经不存在。";
  });
}

function filterCaptures(captures) {
  const query = $("library-search")?.value.trim().toLocaleLowerCase() || "";
  const domain = $("domain-filter")?.value || "";
  const tag = $("tag-filter")?.value || "";
  return captures.filter((capture) => {
    if (domain && domainOf(capture.sourceUrl) !== domain) return false;
    if (tag && !(Array.isArray(capture.tags) && capture.tags.includes(tag))) return false;
    if (!query) return true;
    const haystack = [capture.name, capture.sourceUrl, capture.selector, ...(capture.tags || [])].filter(Boolean).join(" ").toLocaleLowerCase();
    return haystack.includes(query);
  });
}

function updateLibraryFilters(captures) {
  const domainSelect = $("domain-filter");
  const tagSelect = $("tag-filter");
  if (!domainSelect || !tagSelect) return;
  const oldDomain = domainSelect.value;
  const oldTag = tagSelect.value;
  const domains = [...new Set(captures.map((capture) => domainOf(capture.sourceUrl)).filter(Boolean))].sort();
  const tags = [...new Set(captures.flatMap((capture) => Array.isArray(capture.tags) ? capture.tags : []).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  domainSelect.replaceChildren(option("", "所有来源"), ...domains.map((value) => option(value, value)));
  tagSelect.replaceChildren(option("", "所有标签"), ...tags.map((value) => option(value, value)));
  domainSelect.value = domains.includes(oldDomain) ? oldDomain : "";
  tagSelect.value = tags.includes(oldTag) ? oldTag : "";
}

function option(value, label) {
  const element = document.createElement("option"); element.value = value; element.textContent = label; return element;
}

function updateStorageUsage(value) {
  const element = $("library-usage");
  if (!element) return;
  const bytes = Number.isFinite(value) ? value : estimateCaptureBytes(recentCaptures);
  element.textContent = `${formatBytes(bytes)} / 8 MiB`;
}

function estimateCaptureBytes(value) {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { return 0; }
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function capturePreviewUrl(capture) {
  const candidates = [capture.compositeBitmap?.dataUrl, capture.canvasBitmap?.dataUrl, capture.screenshot];
  return candidates.find((value) => typeof value === "string" && /^data:image\/(?:png|jpeg);base64,/.test(value)) || "";
}

function mediaBadges(capture) {
  const values = [];
  if (capture.canvasBitmap?.dataUrl) values.push(["PNG", "画布 PNG"]);
  if (capture.compositeBitmap?.dataUrl) values.push(["裁切", "合成裁切 JPEG"]);
  if (capture.canvasRecording?.dataUrl) values.push(["WebM", "Canvas 录制"]);
  if (Array.isArray(capture.animations) && capture.animations.length) values.push(["动效", "动画观察"]);
  return values.map(([label, title]) => { const badge = document.createElement("span"); badge.className = "media-badge"; badge.textContent = label; badge.title = title; return badge; });
}

function downloadDataUrl(dataUrl, filename) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return Promise.reject(new Error("媒体文件格式无效"));
  const mimeType = /^data:([^;,]+);base64$/i.exec(dataUrl.slice(0, comma))?.[1];
  if (!mimeType) return Promise.reject(new Error("媒体文件格式无效"));
  const bytes = Uint8Array.from(atob(dataUrl.slice(comma + 1)), char => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: true, conflictAction: "uniquify" }, id => {
      const error = chrome.runtime.lastError;
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (error || id === undefined) reject(new Error(error?.message || "下载未开始"));
      else resolve(id);
    });
  });
}

function domainOf(value) { try { return new URL(value).hostname || "本地页面"; } catch { return "本地页面"; } }
function formatDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" }); }
function safeFilename(value) { return String(value).trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "capture"; }
