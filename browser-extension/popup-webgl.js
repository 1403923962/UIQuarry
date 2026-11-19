(() => {
  const toggle = document.getElementById("webgl-toggle");
  const status = document.getElementById("webgl-status");
  const reload = document.getElementById("webgl-reload");
  let site, registered = false, granted = false;

  async function getSite() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let url;
    try { url = new URL(tab?.url); } catch { /* not a regular web page */ }
    if (!tab?.id || !url || !["http:", "https:"].includes(url.protocol)) {
      throw new Error("请在普通 HTTP 或 HTTPS 网页使用 WebGL 保帧。");
    }
    // Chrome host match patterns apply to all ports for this scheme and exact hostname.
    const host = url.protocol + "//" + url.hostname;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(host));
    const id = "uq-webgl-" + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
    return { host, match: host + "/*", id, tabId: tab.id };
  }

  async function readState() {
    const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [site.id] });
    registered = scripts.length !== 0;
    granted = await chrome.permissions.contains({ origins: [site.match] });
  }
  function render(note) {
    const enabled = registered && granted;
    toggle.disabled = false;
    toggle.textContent = enabled ? "关闭此站 WebGL 保帧" : "开启此站 WebGL 保帧";
    toggle.setAttribute("aria-pressed", String(enabled));
    status.textContent = note || (enabled ? site.host + " 已启用保帧；已打开的页面可能需要刷新。"
      : site.host + " 默认关闭。启用后，此主机后续页面的 WebGL 可能占用更多显存。");
  }

  toggle.disabled = true;
  reload.hidden = true;
  getSite().then(async target => {
    site = target;
    await readState();
    render();
    reload.hidden = !(registered && granted);
  }).catch(error => { status.textContent = error.message; });

  toggle.addEventListener("click", async () => {
    if (!site || toggle.disabled) return;
    toggle.disabled = true;
    const origins = [site.match];
    let note;
    try {
      if (registered && granted) {
        await chrome.scripting.unregisterContentScripts({ ids: [site.id] });
        await chrome.permissions.remove({ origins });
        note = "此站保帧已关闭。刷新页面以恢复默认行为。";
        reload.hidden = false;
      } else {
        // Keep request() inside the user gesture, before any asynchronous lookup.
        if (!await chrome.permissions.request({ origins })) {
          note = "未获得此站授权，未开启保帧。";
        } else {
          try {
            if (!registered) await chrome.scripting.registerContentScripts([{
              id: site.id, js: ["webgl-preserve.js"], matches: origins,
              runAt: "document_start", world: "MAIN", allFrames: false, persistAcrossSessions: true
            }]);
          } catch (error) {
            if (!granted) await chrome.permissions.remove({ origins });
            throw error;
          }
          note = "此站保帧已开启。刷新页面后重新采集；只作用于新建的 WebGL 上下文。";
          reload.hidden = false;
        }
      }
    } catch (error) {
      note = "保帧设置未完成：" + error.message;
    }
    try { await readState(); render(note); }
    catch (error) { status.textContent = "无法读取保帧设置：" + error.message; }
  });

  reload.addEventListener("click", async () => {
    try {
      const current = await getSite();
      if (current.id !== site.id || current.tabId !== site.tabId) throw new Error("当前页面已切换，请重新打开扩展。");
      await chrome.tabs.reload(site.tabId);
      window.close();
    } catch (error) { status.textContent = error.message; }
  });
})();
