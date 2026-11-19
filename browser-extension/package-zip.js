(function exposePackageExport(global) {
  "use strict";

  const encoder = new TextEncoder();
  const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
  const CRC_TABLE = makeCrcTable();

  /**
   * Build a portable, ordinary Git package in memory. The ZIP uses STORE
   * entries so this remains dependency-free in a Manifest V3 extension page.
   */
  async function buildPackage(record, options = {}) {
    const capture = prepareCapture(record);
    const metadata = options.metadata || options.manifestMetadata ||
      (options.review && global.UIQuarryPrivacyReview?.manifestMetadata?.(options.review)) || {};
    const id = capture.id;
    const capturePath = `captures/${id}/capture.json`;
    const payloads = [{
      path: capturePath,
      bytes: encoder.encode(`${JSON.stringify(capture, null, 2)}\n`),
      mediaType: "application/json"
    }];

    addDataUrl(payloads, capture.canvasBitmap?.dataUrl, "media/canvas.png", "image/png");
    addDataUrl(payloads, capture.compositeBitmap?.dataUrl, "media/composite.jpg", "image/jpeg");
    addDataUrl(payloads, capture.canvasRecording?.dataUrl, "media/recording.webm", "video/webm");
    addDataUrl(payloads, capture.screenshot, "media/viewport.jpg", "image/jpeg");

    const files = [];
    for (const payload of payloads) {
      files.push({
        path: payload.path,
        sha256: await sha256Hex(payload.bytes),
        size: payload.bytes.byteLength,
        mediaType: payload.mediaType
      });
    }
    const manifest = {
      schemaVersion: 1,
      id,
      name: capture.name,
      kind: "capture",
      ...(capture.tags?.length ? { tags: capture.tags } : {}),
      createdAt: capture.capturedAt,
      license: packageLicense(metadata),
      ...(isHttpUrl(metadata.sourceUrl) ? { sourceUrl: metadata.sourceUrl } : isHttpUrl(capture.sourceUrl) ? { sourceUrl: capture.sourceUrl } : {}),
      files,
      entrypoints: [capturePath]
    };
    const manifestBytes = encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`);
    const entries = [{ path: "quarry.json", bytes: manifestBytes, mediaType: "application/json" }, ...payloads];
    const zipBytes = createStoredZip(entries);
    if (zipBytes.byteLength > MAX_PACKAGE_BYTES) throw new Error("组件包超过 32 MB 大小上限");
    return {
      blob: new Blob([zipBytes], { type: "application/zip" }),
      bytes: zipBytes,
      manifest,
      capture,
      entries
    };
  }

  async function download(record, options = {}) {
    const result = await buildPackage(record, options);
    if (!global.chrome?.downloads?.download) throw new Error("当前浏览器不支持下载组件包");
    const url = global.URL.createObjectURL(result.blob);
    const filename = `${safeFilename(result.capture.name)}.zip`;
    try {
      const downloadId = await new Promise((resolve, reject) => {
        let settled = false;
        const done = (id) => {
          const error = global.chrome.runtime?.lastError;
          if (settled) return;
          settled = true;
          if (error || id === undefined) reject(new Error(error?.message || "下载未开始"));
          else resolve(id);
        };
        try {
          const returned = global.chrome.downloads.download({
            url,
            filename,
            saveAs: options.saveAs !== false,
            conflictAction: "uniquify"
          }, done);
          // Promise-style Chrome APIs are used by some test harnesses and
          // newer browser bindings. The callback remains the MV3 path.
          if (returned?.then) returned.then(done, reject);
        } catch (error) {
          reject(error);
        }
      });
      return { ...result, downloadId, filename };
    } finally {
      global.setTimeout?.(() => global.URL.revokeObjectURL(url), 1000);
    }
  }

  function prepareCapture(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("无效的 Capture 记录");
    if (record.schemaVersion !== 1) throw new Error("仅支持 Capture v1 导出");
    if (!isHttpUrl(record.sourceUrl)) throw new Error("Capture 来源 URL 必须使用 http 或 https");
    const capture = { ...record };
    const localId = capture.localId;
    for (const field of ["localId", "savedAt", "sync", "syncError", "serverId"]) delete capture[field];
    const name = String(capture.name || "未命名组件").trim().slice(0, 200) || "未命名组件";
    const id = capture.id ? safeIdentifier(capture.id) : captureIdentifier(name, localId);
    const date = new Date(capture.capturedAt);
    capture.id = id;
    capture.name = name;
    capture.capturedAt = Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
    capture.createdAt = new Date().toISOString();
    if (Array.isArray(capture.tags)) {
      capture.tags = [...new Set(capture.tags.filter(tag => typeof tag === "string" && tag.trim()).map(tag => tag.trim().slice(0, 64)))].slice(0, 50);
    }
    return capture;
  }

  function addDataUrl(payloads, dataUrl, path, fallbackType) {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) return;
    if (!["image/png", "image/jpeg", "video/webm"].includes(parsed.mimeType)) return;
    const mediaType = parsed.mimeType || fallbackType;
    const extension = mediaExtension(mediaType);
    const finalPath = extension && path.includes("viewport.") ? path.replace(/\.[^.]+$/, `.${extension}`) : path;
    payloads.push({ path: finalPath, bytes: parsed.bytes, mediaType });
  }

  function mediaExtension(mediaType) {
    return { "image/png": "png", "image/jpeg": "jpg", "video/webm": "webm" }[mediaType] || "";
  }

  function isHttpUrl(value) {
    if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return false;
    try { return Boolean(new URL(value)); } catch { return false; }
  }

  function packageLicense(metadata) {
    const value = typeof metadata?.license === "string" ? metadata.license.trim().slice(0, 128) : "";
    return value || "NOASSERTION";
  }

  function parseDataUrl(value) {
    if (typeof value !== "string") return null;
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+=*)$/i.exec(value);
    if (!match) return null;
    try {
      const binary = global.atob(match[2]);
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      return { mimeType: match[1].toLowerCase(), bytes };
    } catch {
      return null;
    }
  }

  async function sha256Hex(bytes) {
    if (!global.crypto?.subtle) throw new Error("当前浏览器不支持组件包校验");
    const digest = await global.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
  }

  function createStoredZip(entries) {
    const localChunks = [];
    const centralChunks = [];
    let offset = 0;
    for (const entry of entries) {
      const name = encoder.encode(entry.path);
      const bytes = entry.bytes instanceof Uint8Array ? entry.bytes : new Uint8Array(entry.bytes);
      const crc = crc32(bytes);
      const header = new ArrayBuffer(30 + name.length);
      const view = new DataView(header);
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 0x0800, true);
      view.setUint16(8, 0, true);
      view.setUint16(10, 0, true);
      view.setUint16(12, 0, true);
      view.setUint32(14, crc, true);
      view.setUint32(18, bytes.byteLength, true);
      view.setUint32(22, bytes.byteLength, true);
      view.setUint16(26, name.length, true);
      view.setUint16(28, 0, true);
      new Uint8Array(header, 30).set(name);
      localChunks.push(new Uint8Array(header), bytes);

      const central = new ArrayBuffer(46 + name.length);
      const centralView = new DataView(central);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x0800, true);
      centralView.setUint16(10, 0, true);
      centralView.setUint16(12, 0, true);
      centralView.setUint16(14, 0, true);
      centralView.setUint32(16, crc, true);
      centralView.setUint32(20, bytes.byteLength, true);
      centralView.setUint32(24, bytes.byteLength, true);
      centralView.setUint16(28, name.length, true);
      centralView.setUint16(30, 0, true);
      centralView.setUint16(32, 0, true);
      centralView.setUint16(34, 0, true);
      centralView.setUint16(36, 0, true);
      centralView.setUint32(38, 0, true);
      centralView.setUint32(42, offset, true);
      new Uint8Array(central, 46).set(name);
      centralChunks.push(new Uint8Array(central));
      offset += 30 + name.length + bytes.byteLength;
    }

    const centralOffset = offset;
    const centralSize = centralChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const end = new ArrayBuffer(22);
    const endView = new DataView(end);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(4, 0, true);
    endView.setUint16(6, 0, true);
    endView.setUint16(8, entries.length, true);
    endView.setUint16(10, entries.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, centralOffset, true);
    endView.setUint16(20, 0, true);
    return joinChunks([...localChunks, ...centralChunks, new Uint8Array(end)]);
  }

  function joinChunks(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function makeCrcTable() {
    const table = new Uint32Array(256);
    for (let value = 0; value < table.length; value++) {
      let crc = value;
      for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
      table[value] = crc >>> 0;
    }
    return table;
  }

  function safeIdentifier(value) {
    const normalized = String(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
    const id = normalized.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/[^a-z0-9]+$/, "").slice(0, 120);
    return id || "capture";
  }

  function captureIdentifier(name, localId) {
    const namePart = safeIdentifier(name).slice(0, 72);
    const suffix = safeIdentifier(localId || Date.now()).slice(-32);
    return safeIdentifier(`${namePart}-${suffix}`).slice(0, 120) || "capture";
  }

  function safeFilename(value) {
    return safeIdentifier(value).slice(0, 80) || "capture";
  }

  global.UIQuarryPackageExport = { buildPackage, download, safeIdentifier };
})(globalThis);
