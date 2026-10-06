(function (root) {
  "use strict";
  // 2026-10-05 按真实页面联测结果更新（此前为未验证的保守猜测）。
  // ChatGPT：输入框是 ProseMirror contenteditable（#prompt-textarea 已废弃）；
  //   发送/停止/复制按钮都靠中文 aria-label，且发送按钮在输入文字前不渲染。
  // DeepSeek：输入框是带 placeholder 的 textarea（textarea#chat-input 已废弃）；
  //   用户消息含悬停工具栏容器 _23e1c55，助手消息不含，用 :not(:has()) 区分。
  const DEFAULTS = {
    chatgpt: {
      composer: 'div.ProseMirror[contenteditable="true"], #prompt-textarea',
      virtualList: false,
      // 助手轮次没有无歧义的语义属性，只有 Tailwind 的 group 命名空间可用：
      // 用户轮次带 group/user-message，助手轮次不带，所以用 :not(:has()) 反向选中。
      assistant: 'div.group.flex.flex-col:not(:has(.group\\/user-message))',
      send: 'button[aria-label="发送"], button[aria-label="Send"], button[data-testid="send-button"]',
      stop: 'button[aria-label="停止"], button[aria-label="Stop"], button[data-testid="stop-button"]',
      // 注意：这里曾想加“风控/错误横幅”选择器，但实测 ChatGPT 的报错横幅用的全是
      // 动态类名（conversation-turn-error / text-token-text-error / text-error 三者都 0 命中），
      // 拿不到稳定锚点。所以不靠选择器识别错误，改由 content.js 用“发出后长时间既没有
      // 回答、也没有在生成”来判定并如实报未确认（见 content.js 的 IDLE_MS）。
      // 实测触发过：ChatGPT 回 "Unusual activity has been detected from your device."
      // 那是请求密度异常引起的，已把派单最小间隔调大来避免。
      // 实测：页面上的"复制消息"按钮属于用户消息轮次，助手轮次内没有完成控件。
      // 所以留空，改由 content.js 的降级判定（正文停止增长）确认完成。
      done: ''
    },
    deepseek: {
      composer: 'textarea[placeholder], textarea#chat-input',
      // DeepSeek 用虚拟列表渲染消息：只挂载可视区，从头部卸载旧消息。
      // 因此数量基线和索引比对都不成立，content.js 会跳过严格基线检查。
      virtualList: true,
      // 用户消息的直接子元素是 .fbb737a4，助手消息没有；助手消息内才有 .ds-markdown。
      assistant: '.ds-message:not(:has(> .fbb737a4))',
      send: '.ds-button--primary, button[aria-label="发送"], button[aria-label="Send"]',
      stop: '[class*="ds-button"][aria-label*="停止"], button[aria-label="Stop"]',
      done: ''
    },
    gemini: {
      composer: 'rich-textarea [contenteditable="true"]',
      assistant: 'model-response',
      send: 'button.send-button, button[aria-label="Send message"], button[aria-label="发送消息"]',
      stop: 'button.stop-button, button[aria-label="Stop response"], button[aria-label="停止回答"]',
      done: 'button.copy-button, button[aria-label="Copy response"], button[aria-label="复制回答"]'
    }
  };
  function selectors(provider, custom) {
    const base = DEFAULTS[provider];
    if (!base) throw new Error("不支持这个聊天网站");
    return Object.fromEntries(Object.keys(base).map(k => [k, custom?.[k]?.trim() || base[k]]));
  }
  function visible(el) {
    if (!(el instanceof Element) || !el.isConnected || !el.getClientRects().length) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden";
  }
  function all(selector, scope = document) {
    return [...scope.querySelectorAll(selector)].filter(visible);
  }
  function one(selector, name, allowNone = false) {
    const nodes = all(selector);
    if (nodes.length === 0 && allowNone) return null;
    if (nodes.length !== 1) throw new Error(name + "未找到或不唯一，请检查页面/高级选择器");
    return nodes[0];
  }
  function enabled(el) {
    return !!el && !el.disabled && el.getAttribute("aria-disabled") !== "true";
  }
  function composerText(el) {
    return "value" in el ? el.value : (el.innerText || el.textContent || "");
  }
  function editable(el) {
    return enabled(el) && !el.readOnly &&
      (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement || el.isContentEditable);
  }
  function writeComposer(el, text) {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
      el.dispatchEvent(new InputEvent("input", {bubbles: true, inputType: "insertText", data: text}));
      return;
    }
    if (!el.isContentEditable) throw new Error("聊天框不支持安全填入文本");
    // 富文本编辑器（如 ChatGPT 的 ProseMirror）只改 textContent 不够：
    // 界面上的字会出现，但编辑器自身的 state 不更新，发送按钮不会渲染出来。
    // 走编辑器认可的正规输入路径，让它自己更新 state。
    el.focus();
    const selection = el.ownerDocument.getSelection();
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    range.collapse(false); // 光标移到末尾
    selection.removeAllRanges();
    selection.addRange(range);
    const previous = el.textContent;
    let viaCommand = false;
    try { viaCommand = el.ownerDocument.execCommand("insertText", false, text); }
    catch { viaCommand = false; }
    if (!viaCommand || el.textContent === previous) {
      // execCommand 不可用时退回直接赋值，但仍要补一次 input 事件。
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", {bubbles: true, inputType: "insertText", data: text}));
    }
    el.dispatchEvent(new Event("change", {bubbles: true}));
  }
  function messageId(el, provider) {
    if (provider === "deepseek") {
      const markdown = el.querySelector(".ds-assistant-message-main-content");
      if (markdown) return markdown.getAttribute("data-message-id") || markdown.id || null;
    }
    const owner = el.closest("[data-message-id], [data-turn-id], [data-response-id]");
    return owner?.getAttribute("data-message-id") || owner?.getAttribute("data-turn-id") ||
      owner?.getAttribute("data-response-id") || el.id || null;
  }
  // 助手消息容器常同时装着“思考过程”和“回答正文”。只取正文，
  // 否则思考过程会混进交回给 Harness 的回答里。
  function answerText(el, provider) {
    const scope = provider === "deepseek"
      ? el.querySelector(".ds-assistant-message-main-content") || el
      : el;
    return (scope.innerText || scope.textContent || "").trim();
  }
  // 助手消息容器出现得比正文早。编辑器类站点（ChatGPT 的 ProseMirror）在容器
  // 刚挂上时 innerText 还是空的，直接读取会误判成“回答为空”。用它判断正文是否已就绪。
  function answerReady(el, provider) {
    if (!el) return false;
    if (provider === "deepseek") return !!el.querySelector(".ds-assistant-message-main-content");
    return !!((el.innerText || "").trim());
  }
  function messageRoot(el, provider) {
    // 完成控件（复制按钮）在轮次内部的工具条里，所以要定位到所属轮次容器再找。
    if (provider === "chatgpt") {
      return el.closest('div.group.flex.flex-col:not(:has(.group\\/user-message))') ||
        el.closest('article[data-testid^="conversation-turn"]') || el;
    }
    if (provider === "deepseek") return el.closest(".ds-message") || el;
    return el;
  }
  root.BridgeAdapters = {DEFAULTS, selectors, visible, all, one, enabled, composerText, editable,
    writeComposer, messageId, answerText, answerReady, messageRoot};
})(globalThis);
