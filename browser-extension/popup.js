const $ = (id) => document.getElementById(id);
const startButton = $("start");

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  $("status").textContent = "Opening element picker…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab found.");
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    const reply = await chrome.tabs.sendMessage(tab.id, {
      type: "START_PICKER",
      name: $("name").value.trim() || "Captured component",
      tags: $("tags").value.split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 20)
    });
    if (!reply?.ok) throw new Error(reply?.error || "Could not start picker.");
    $("status").textContent = "Hover an element and click to capture. Press Esc to cancel.";
    window.close();
  } catch (error) {
    $("status").textContent = `Could not start: ${error.message}`;
  } finally {
    startButton.disabled = false;
  }
});

chrome.runtime.sendMessage({ type: "GET_RECENT" }, ({ captures = [] } = {}) => {
  const list = $("recent");
  if (!captures.length) {
    list.innerHTML = '<li class="empty">No captures yet</li>';
    return;
  }
  for (const capture of captures.slice(0, 5)) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = capture.name;
    const state = document.createElement("small");
    state.textContent = "local";
    item.append(name, state);
    list.append(item);
  }
});
