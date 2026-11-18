const MAX_RECENT = 50;
const MAX_LOCAL_BYTES = 8 * 1024 * 1024;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "COMPONENT_CAPTURED" && message.capture) {
    saveCapture(message.capture).then(sendResponse);
    return true;
  }
  if (message?.type === "GET_RECENT") {
    chrome.storage.local.get({ captures: [] }).then(({ captures }) => sendResponse({ captures }));
    return true;
  }
});

async function saveCapture(capture) {
  const { captures = [] } = await chrome.storage.local.get({ captures: [] });
  const localRecord = { ...capture, localId: crypto.randomUUID(), savedAt: new Date().toISOString() };
  captures.unshift(localRecord);
  while (captures.length > MAX_RECENT || storageBytes(captures) > MAX_LOCAL_BYTES) captures.pop();
  await chrome.storage.local.set({ captures });
  return { ok: true };
}

function storageBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
