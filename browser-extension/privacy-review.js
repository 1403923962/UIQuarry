// Local-only sharing review used by export actions.
(function initPrivacyReview(global) {
  "use strict";

  const LICENSES = [
    ["NOASSERTION", "未知 / 不声明"],
    ["MIT", "MIT"],
    ["Apache-2.0", "Apache-2.0"],
    ["GPL-3.0-only", "GPL-3.0-only"],
    ["CUSTOM", "其他（自定义）"]
  ];

  function sourceDetails(capture) {
    const sourceUrl = typeof capture?.sourceUrl === "string" ? capture.sourceUrl : "";
    try {
      const parsed = new URL(sourceUrl);
      return { sourceUrl, domain: parsed.hostname || "未知域名" };
    } catch {
      return { sourceUrl, domain: "未知域名" };
    }
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function addStyles() {
    if (document.getElementById("uiquarry-review-styles")) return;
    const style = createElement("style");
    style.id = "uiquarry-review-styles";
    style.textContent = `
      .uiquarry-review-backdrop { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 16px; background: rgba(16, 28, 22, .42); }
      .uiquarry-review-dialog { width: min(480px, 100%); max-height: min(680px, 100%); overflow: auto; padding: 18px; border: 1px solid #cbd8d0; border-radius: 10px; color: #18211e; background: #fff; box-shadow: 0 18px 48px rgba(24, 33, 30, .25); font: 13px/1.45 system-ui, sans-serif; }
      .uiquarry-review-dialog h2 { margin: 0 0 6px; color: #18211e; font-size: 16px; }
      .uiquarry-review-dialog p { margin: 7px 0; }
      .uiquarry-review-warning { margin: 12px 0; padding: 9px 10px; border-left: 3px solid #b46a35; color: #59351d; background: #fff5e9; }
      .uiquarry-review-source { margin: 10px 0 14px; padding: 8px; border-radius: 6px; background: #f4f7f5; overflow-wrap: anywhere; }
      .uiquarry-review-source strong { display: block; margin-bottom: 2px; color: #53615a; font-size: 11px; }
      .uiquarry-review-source code { color: #34463c; font: 11px/1.4 ui-monospace, monospace; }
      .uiquarry-review-dialog label { display: block; margin: 12px 0 5px; font-weight: 650; }
      .uiquarry-review-dialog select, .uiquarry-review-dialog textarea { width: 100%; padding: 8px; border: 1px solid #d7ded9; border-radius: 6px; color: inherit; background: #fff; font: inherit; }
      .uiquarry-review-dialog textarea { min-height: 58px; resize: vertical; }
      .uiquarry-review-license-help { margin: 4px 0 0; color: #69766f; font-size: 11px; }
      .uiquarry-review-check { display: flex !important; gap: 8px; align-items: flex-start; margin-top: 14px !important; font-weight: 550 !important; }
      .uiquarry-review-check input { flex: none; width: 15px; height: 15px; margin-top: 2px; accent-color: #237a5b; }
      .uiquarry-review-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
      .uiquarry-review-actions button { padding: 8px 12px; border: 1px solid #cbd8d0; border-radius: 7px; color: #28634d; background: #fff; font: 650 13px system-ui, sans-serif; cursor: pointer; }
      .uiquarry-review-actions button.primary { border-color: #237a5b; color: #fff; background: #237a5b; }
      .uiquarry-review-actions button:disabled { cursor: not-allowed; opacity: .5; }
      .uiquarry-review-error { min-height: 16px; margin: 7px 0 0; color: #a33e39; font-size: 11px; }
    `;
    document.head?.append(style);
  }

  function reviewExport(capture, options = {}) {
    if (!global.document?.createElement) return Promise.reject(new Error("当前环境不支持导出审核。"));
    const current = document.getElementById("uiquarry-review");
    current?.remove();
    addStyles();
    const source = sourceDetails(capture);
    const backdrop = createElement("div", "uiquarry-review-backdrop");
    backdrop.id = "uiquarry-review";
    const dialog = createElement("section", "uiquarry-review-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "uiquarry-review-title");
    const title = createElement("h2", "", options.title || "导出前检查");
    title.id = "uiquarry-review-title";
    dialog.append(title, createElement("p", "", options.description || "请确认来源和授权信息，再生成本地导出文件。"));

    const warning = createElement("div", "uiquarry-review-warning", "导出内容可能包含个人信息、版权素材、第三方资源 URL 或页面文字。请先确认你有权分享这些内容。审核不会上传数据，也不会修改本地捕获。");
    dialog.append(warning);
    const sourceBox = createElement("div", "uiquarry-review-source");
    sourceBox.append(createElement("strong", "", `来源域名：${source.domain}`), createElement("code", "", source.sourceUrl || "未记录来源 URL"));
    dialog.append(sourceBox);

    const licenseLabel = createElement("label", "", "导出声明的许可证");
    const license = createElement("select");
    license.id = "uiquarry-review-license";
    for (const [value, label] of LICENSES) {
      const option = createElement("option", "", label);
      option.value = value;
      license.append(option);
    }
    license.value = options.license && LICENSES.some(([value]) => value === options.license) ? options.license : "NOASSERTION";
    licenseLabel.append(license);
    dialog.append(licenseLabel);

    const custom = createElement("textarea");
    custom.id = "uiquarry-review-license-text";
    custom.maxLength = 128;
    custom.placeholder = "例如：仅供内部参考，禁止再分发";
    custom.hidden = license.value !== "CUSTOM";
    dialog.append(custom);
    dialog.append(createElement("p", "uiquarry-review-license-help", "许可证声明只描述你准备分享的导出包，不代表源站素材自动获得授权。"));

    const checkLabel = createElement("label", "uiquarry-review-check");
    const check = createElement("input");
    check.type = "checkbox";
    check.id = "uiquarry-review-confirm";
    checkLabel.append(check, createElement("span", "", "我已检查来源内容、个人数据和再分发权利，确认可以导出。"));
    dialog.append(checkLabel);
    const error = createElement("p", "uiquarry-review-error");
    error.setAttribute("role", "alert");
    dialog.append(error);

    const actions = createElement("div", "uiquarry-review-actions");
    const cancel = createElement("button", "", "取消");
    cancel.type = "button";
    const confirm = createElement("button", "primary", "确认导出");
    confirm.type = "button";
    confirm.disabled = true;
    actions.append(cancel, confirm);
    dialog.append(actions);
    backdrop.append(dialog);
    (document.body || document.documentElement).append(backdrop);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        backdrop.remove();
        resolve(value);
      };
      const update = () => {
        custom.hidden = license.value !== "CUSTOM";
        const customOk = license.value !== "CUSTOM" || custom.value.trim().length > 0;
        confirm.disabled = !check.checked || !customOk;
        error.textContent = !customOk ? "请填写自定义许可证说明。" : "";
      };
      check.addEventListener("change", update);
      license.addEventListener("change", update);
      custom.addEventListener("input", update);
      cancel.addEventListener("click", () => finish(null));
      confirm.addEventListener("click", () => {
        update();
        if (confirm.disabled) return;
        const customText = custom.value.trim();
        finish({
          license: license.value === "CUSTOM" ? customText.slice(0, 128) : license.value,
          licenseId: license.value,
          licenseText: license.value === "CUSTOM" ? customText.slice(0, 128) : undefined,
          sourceReviewed: true,
          reviewedAt: new Date().toISOString(),
          sourceUrl: source.sourceUrl,
          sourceDomain: source.domain
        });
      });
      backdrop.addEventListener("click", (event) => { if (event.target === backdrop) finish(null); });
      dialog.addEventListener("keydown", (event) => { if (event.key === "Escape") finish(null); });
      (license.value === "CUSTOM" ? custom : check).focus?.();
    });
  }

  function isComplete(review) {
    return Boolean(review?.sourceReviewed === true && review?.reviewedAt && typeof review.license === "string" && review.license.trim());
  }

  function manifestMetadata(review) {
    if (!isComplete(review)) throw new Error("导出前需要完成来源和授权审核。");
    // quarry.json has a strict schema; keep only fields it defines. The
    // checkbox and review timestamp are intentionally not copied into the
    // captured component or package manifest.
    const metadata = { license: review.license.trim().slice(0, 128) };
    if (review.sourceUrl) metadata.sourceUrl = String(review.sourceUrl).slice(0, 2048);
    return metadata;
  }

  global.UIQuarryPrivacyReview = Object.freeze({ reviewExport, isComplete, manifestMetadata, licenses: LICENSES.map(([value, label]) => ({ value, label })) });
})(globalThis);
