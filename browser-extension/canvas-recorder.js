(() => {
  if (globalThis.UIQuarryRecorder) return;

  const CLIP_MS = 3000;
  const DEADLINE_MS = 6000;
  const BASE64_PREFIX = "data:video/webm;base64,";
  const MAX_URL_LENGTH = 3_000_000;
  const MAX_BYTES = 3 * Math.floor((MAX_URL_LENGTH - BASE64_PREFIX.length) / 4);
  let active = false;

  async function record(canvas) {
    if (active) throw new Error("已有一段画布正在录制。");
    if (!(canvas instanceof HTMLCanvasElement) || !canvas.isConnected || !canvas.width || !canvas.height) {
      throw new Error("请选择页面中尺寸非零的 Canvas。");
    }
    if (document.hidden) throw new Error("录制时请保持标签页可见。");
    if (typeof canvas.captureStream !== "function" || typeof MediaRecorder === "undefined") {
      throw new Error("当前浏览器不支持录制画布。");
    }
    const codec = ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"]
      .find(type => MediaRecorder.isTypeSupported(type));
    if (!codec) throw new Error("当前浏览器不支持 WebM 视频编码。");

    active = true;
    let stream, recorder, reader, videoTrack, stopTimer, watchdog, removeListeners;
    try {
      stream = canvas.captureStream(24);
      videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack || videoTrack.readyState === "ended") throw new Error("画布没有可录制的视频轨道。");
      recorder = new MediaRecorder(stream, { mimeType: codec, videoBitsPerSecond: 2_000_000 });
      return await new Promise((resolve, reject) => {
        const chunks = [];
        let bytes = 0;
        let durationMs = 0;
        const fail = message => reject(new Error(message));
        const onVisibility = () => { if (document.hidden) fail("标签页已隐藏，录制已取消。"); };
        const onLeave = () => fail("页面已离开，录制已取消。");
        const onTrackLoss = () => fail("画布视频轨道已中断。");
        removeListeners = () => {
          document.removeEventListener("visibilitychange", onVisibility);
          window.removeEventListener("pagehide", onLeave);
          videoTrack.removeEventListener("ended", onTrackLoss);
          videoTrack.removeEventListener("mute", onTrackLoss);
        };
        document.addEventListener("visibilitychange", onVisibility);
        window.addEventListener("pagehide", onLeave);
        videoTrack.addEventListener("ended", onTrackLoss);
        videoTrack.addEventListener("mute", onTrackLoss);

        recorder.ondataavailable = event => {
          if (!event.data?.size) return;
          bytes += event.data.size;
          if (bytes > MAX_BYTES) { fail("画布录像超出本地大小上限。"); return; }
          chunks.push(event.data);
        };
        recorder.onerror = () => fail("浏览器未能编码画布录像。");
        recorder.onstop = () => {
          if (!durationMs || !bytes) { fail("未录到画面；请在录制期间播放动画。"); return; }
          reader = new FileReader();
          reader.onerror = () => fail("读取本地录像失败。");
          reader.onload = () => {
            const dataUrl = reader.result;
            if (typeof dataUrl !== "string" || !dataUrl.startsWith(BASE64_PREFIX) ||
                dataUrl.length <= BASE64_PREFIX.length || dataUrl.length > MAX_URL_LENGTH) {
              fail("本地录像格式无效或内容过大。");
            } else {
              resolve({ mimeType: "video/webm", durationMs, dataUrl });
            }
          };
          reader.readAsDataURL(new Blob(chunks, { type: "video/webm" }));
        };
        const started = performance.now();
        recorder.start(250);
        stopTimer = setTimeout(() => {
          if (!canvas.isConnected || document.hidden) { fail("画布已移除或标签页已隐藏。"); return; }
          durationMs = Math.round(performance.now() - started);
          if (durationMs <= 0 || durationMs > DEADLINE_MS || recorder.state !== "recording") {
            fail("画布录像中断或超时。"); return;
          }
          try { recorder.stop(); } catch { fail("无法结束画布录像。"); }
        }, CLIP_MS);
        watchdog = setTimeout(() => fail("画布录像超时。"), DEADLINE_MS);
      });
    } catch (error) {
      if (error.name === "SecurityError") throw new Error("浏览器禁止录制包含跨域资源的画布。");
      if (error instanceof DOMException) throw new Error("浏览器无法启动或编码这段画布录像。");
      throw error;
    } finally {
      clearTimeout(stopTimer);
      clearTimeout(watchdog);
      removeListeners?.();
      if (recorder) {
        recorder.ondataavailable = recorder.onerror = recorder.onstop = null;
        if (recorder.state !== "inactive") {
          try { recorder.stop(); } catch { /* Already stopped by the browser. */ }
        }
      }
      for (const track of stream?.getTracks() ?? []) track.stop();
      if (reader?.readyState === 1) reader.abort();
      active = false;
    }
  }

  globalThis.UIQuarryRecorder = { record };
})();
