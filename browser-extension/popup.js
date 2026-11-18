const $ = (id) => document.getElementById(id);
const startButton = $("start");

$("import").addEventListener("click", () => $("import-file").click());
$("import-file").addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  event.target.value = "";
  if (!file) return;
  if (file.size > 4_000_000) {
    $("status").textContent = "导入失败：JSON 文件不能超过 4 MB。";
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
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    const reply = await chrome.tabs.sendMessage(tab.id, { type: "START_PICKER", name: $("name").value.trim() || "已捕获组件", tags: $("tags").value.split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 20) });
    if (!reply?.ok) throw new Error(reply?.error || "无法打开元素选择器。");
    $("status").textContent = "悬停查看元素，点击完成捕获；按 Esc 取消。";
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
    renderRecent(response?.captures || []);
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
  if (!captures.length) { list.innerHTML = '<li class="empty">还没有捕获内容</li>'; return; }
  for (const capture of captures.slice(0, 5)) list.append(createCaptureRow(capture));
}

function createCaptureRow(capture) {
  const item = document.createElement("li");
  const info = document.createElement("div"); info.className = "capture-info";
  const name = document.createElement("strong"); name.textContent = capture.name || "未命名组件";
  const meta = document.createElement("small"); meta.textContent = `${domainOf(capture.sourceUrl)} · ${formatDate(capture.capturedAt)}`;
  info.append(name, meta);
  const actions = document.createElement("div"); actions.className = "capture-actions";
  actions.append(actionButton("详情", "查看捕获详情", () => showDetails(capture)), actionButton("导出", "下载 Capture JSON", () => downloadCapture(capture)), actionButton("删除", "删除本地捕获", () => deleteLocalCapture(capture.localId, item), "danger"));
  item.append(info, actions); return item;
}

function actionButton(label, title, handler, kind = "") {
  const button = document.createElement("button"); button.type = "button"; button.className = `capture-action ${kind}`; button.textContent = label; button.title = title; button.addEventListener("click", handler); return button;
}

function showDetails(capture) {
  const list = $("details-list"); list.replaceChildren();
  const fields = [["名称", capture.name || "未命名组件"], ["来源", capture.sourceUrl || "未知"], ["选择器", capture.selector || "未知"], ["捕获时间", formatDate(capture.capturedAt)], ["元素尺寸", capture.bounds ? `${capture.bounds.width} × ${capture.bounds.height}` : "未知"]];
  for (const [label, value] of fields) { const term = document.createElement("dt"); term.textContent = label; const description = document.createElement("dd"); description.textContent = value; description.title = value; list.append(term, description); }
  $("details-preview").textContent = capture.html || "没有 HTML 预览"; $("details").hidden = false;
}

function downloadCapture(record) {
  const { localId: _localId, savedAt: _savedAt, ...capture } = record;
  const blob = new Blob([JSON.stringify(capture, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: `${safeFilename(capture.name || "capture")}.json`, saveAs: true, conflictAction: "uniquify" }, () => {
    const error = chrome.runtime.lastError; setTimeout(() => URL.revokeObjectURL(url), 1000); $("status").textContent = error ? `导出失败：${error.message}` : "已导出 Capture JSON。";
  });
}

function deleteLocalCapture(localId, item) {
  if (!localId) return;
  chrome.runtime.sendMessage({ type: "DELETE_CAPTURE", localId }, (result) => {
    if (chrome.runtime.lastError || !result?.ok) { $("status").textContent = "删除失败，请重试。"; return; }
    item.remove(); if (!$("recent").querySelector("li")) $("recent").innerHTML = '<li class="empty">还没有捕获内容</li>'; $("status").textContent = result.deleted ? "已从本浏览器删除。" : "该捕获已经不存在。";
  });
}

function domainOf(value) { try { return new URL(value).hostname || "本地页面"; } catch { return "本地页面"; } }
function formatDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" }); }
function safeFilename(value) { return String(value).trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "capture"; }
