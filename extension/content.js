(function () {
  "use strict";
  if (globalThis.__localChatBridge) return;
  globalThis.__localChatBridge = true;
  const S = BridgeShared, A = BridgeAdapters;
  const instance = crypto.randomUUID();
  const cancelledIds = new Set();
  const TIMEOUT_MS = 10 * 60 * 1000;
  // 空转阈值：发出后这么久既没有回答内容、也没有在生成，就判为未确认并停下。
  // 正常情况下 ChatGPT 首字延迟远小于此值。
  const IDLE_MS = 75_000;
  let current = null, outgoing = null, ticking = false, observerTimer = null;

  async function message(body) {
    const reply = await chrome.runtime.sendMessage({...body, instance});
    if (!reply?.ok) throw new Error(reply?.error || "扩展后台未响应");
    return reply;
  }
  function report(status, details = {}) {
    if (!current || current.cancelled || current.finished) return;
    outgoing = {task_id: current.task_id, status, ...details, url: location.href};
    if (["complete", "uncertain", "error"].includes(status)) current.finished = true;
  }
  function fail(error) {
    report(current?.attempted ? "uncertain" : "error", {error: String(error?.message || error)});
  }
  function ensureLive(t) {
    if (current !== t || t.cancelled || t.finished || cancelledIds.has(t.task_id)) throw new Error("任务已被取消，不再发送");
  }
  // 旧消息的指纹。DeepSeek 用虚拟列表，会回收重建 DOM 节点，所以不能靠节点身份
  // 判断“旧消息还在原位”；也不能靠站点自己给的 id（两站现在都没有稳定 id）。
  // 改用正文文本签名：旧消息的文本在流式过程中不会变，位置也不会变。
  function signature(node, provider) {
    const text = A.answerText(node, provider).replace(/\s+/g, " ");
    return text.length + "|" + text.slice(0, 120) + "|" + text.slice(-40);
  }
  function sameBaseline(before, nodes, provider) {
    return before.every((entry, i) => {
      if (!nodes[i]) return false;
      const id = A.messageId(nodes[i], provider);
      if (entry.id && id) return entry.id === id;
      return entry.signature === signature(nodes[i], provider);
    });
  }
  function checkLocalRoute(t) {
    const nav = S.navigation({provider: t.provider, route: t.route,
      pending: {submitAttempted: t.attempted, phase: "sent", adoptedConversation: t.adopted}}, location.href);
    if (!nav.ok) throw new Error("对话地址发生变化，已暂停；不会在另一对话继续");
    t.route = nav.next;
    if (nav.adopt) t.adopted = true;
  }
  async function startTask(task, adapter) {
    if (current || cancelledIds.has(task.task_id)) return;
    const t = current = {...task, provider: adapter.provider, selectors: adapter.selectors,
      route: S.route(location.href), started: Date.now(), stage: "preflight", attempted: false,
      adopted: false, sawStop: false, accepted: false, finished: false, cancelled: false,
      // virtualList 可能没随 adapter 包传下来（例如该站存过更早的自定义选择器，
      // 那份旧配置里没有这个键），所以这里回退到内置默认值，不能当 false 处理。
      virtualList: adapter.virtualList ?? A.DEFAULTS[adapter.provider]?.virtualList ?? false,
      lastText: "", stableSince: 0, baseline: []};
    try {
      if (!S.validTask(task) || !t.route || t.route.provider !== t.provider) throw new Error("任务或目标聊天无效");
      const q = t.selectors;
      // All selectors are parsed before any mutation of a user draft.
      for (const selector of Object.values(q)) if (selector) document.querySelectorAll(selector);
      const composer = A.one(q.composer, "聊天输入框");
      if (!A.editable(composer)) throw new Error("聊天框不可编辑，可能未登录或页面未就绪");
      if (A.composerText(composer).trim()) throw new Error("聊天框已有用户草稿，未改动也未发送");
      if (A.all(q.stop).length) throw new Error("页面正在生成，未插入新任务");
      // 发送按钮不在这里检查：ChatGPT 与 DeepSeek 的发送按钮在输入文字前根本不渲染。
      // 它在下面“填入后、点击前”被严格核验（唯一且可用），所以安全性没有放松。
      t.composer = composer;
      // 基线只记录指纹与数量，不复制旧回答正文（签名只截取首尾片段做比对）。
      t.baseline = A.all(q.assistant).map(node => ({
        id: A.messageId(node, t.provider), signature: signature(node, t.provider)}));
      await message({type: "prepare", task_id: t.task_id});
      t.attempted = true;
      ensureLive(t);
      checkLocalRoute(t);
      if (A.one(q.composer, "聊天输入框") !== composer || A.composerText(composer).trim() || A.all(q.stop).length) {
        throw new Error("发送前页面状态改变，未覆盖用户输入");
      }
      t.writingComposer = true;
      try { A.writeComposer(composer, task.prompt); }
      finally { t.writingComposer = false; }
      // 发送按钮在写入文本后才渲染（ChatGPT / DeepSeek 都是这样），所以这里等它出现。
      const deadline = Date.now() + 6000;
      let send = null;
      while (Date.now() < deadline) {
        ensureLive(t);
        try { send = A.one(q.send, "发送按钮"); } catch { send = null; }
        if (send && A.enabled(send)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!send) throw new Error("写入文本后发送按钮仍未出现；草稿留在网页，未自动重试");
      if (!A.enabled(send)) throw new Error("写入文本后发送按钮不可用；草稿留在网页，未自动重试");
      await message({type: "authorize-click", task_id: t.task_id});
      ensureLive(t);
      checkLocalRoute(t);
      if (A.composerText(composer).replace(/\r\n/g, "\n") !== task.prompt.replace(/\r\n/g, "\n")) {
        throw new Error("输入内容被修改或网页未正确接收，未点击发送");
      }
      if (A.one(q.send, "发送按钮") !== send || !A.enabled(send) || A.all(q.stop).length) throw new Error("点击前控件状态已改变");
      t.stage = "monitor";
      send.click(); // Exactly one attempt. No Enter fallback, no retries.
      report("sent");
      observe();
    } catch (err) { if (current === t) fail(err); }
  }
  // 页面整页重载后接续监控：消息已经发出去了，只需要把答案读回来。
  // 关键安全判据：当前页面的用户消息里必须能找到本次提示词，否则说明站在
  // 别的会话上，绝不能把别处的回答当成本次结果。
  function userMessagesOf(provider) {
    const sel = provider === "chatgpt"
      ? '.group\\/user-message'
      : ".ds-message:has(> .fbb737a4)";
    return A.all(sel);
  }
  function matchCurrentTask(t) {
    const head = (t.prompt || "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!head) return false;
    return userMessagesOf(t.provider).some(node =>
      A.answerText(node, t.provider).replace(/\s+/g, " ").includes(head));
  }
  function startResume(task, adapter) {
    if (current || cancelledIds.has(task.task_id)) return;
    const t = current = {...task, provider: adapter.provider, selectors: adapter.selectors,
      route: S.route(location.href), started: Date.now(), stage: "monitor", attempted: true,
      adopted: false, sawStop: false, accepted: true, finished: false, cancelled: false,
      resumed: true,
      virtualList: adapter.virtualList ?? A.DEFAULTS[adapter.provider]?.virtualList ?? false,
      lastText: "", stableSince: 0, settleUntil: 0, baseline: []};
    try {
      if (!t.route || t.route.provider !== t.provider) throw new Error("任务或目标聊天无效");
      if (!matchCurrentTask(t)) {
        throw new Error("页面重载后找不到本次提问，无法确认站在哪个会话；未重发，结果未确认");
      }
      const nodes = A.all(t.selectors.assistant);
      if (!nodes.length) throw new Error("页面重载后找不到回答容器；未重发，结果未确认");
      // 把“当前已存在的最后一条”当作待读答案，并让它带动一次稳定性计时。
      const answer = nodes[nodes.length - 1];
      const text = A.answerText(answer, t.provider);
      if (!text.trim()) throw new Error("页面重载后回答还是空的；未重发，结果未确认");
      t.lastText = "";
      t.stableSince = Date.now();
      report("running");
      observe();
    } catch (err) { if (current === t) fail(err); }
  }
  function observe() {
    const t = current;
    if (!t || t.cancelled || t.finished || t.stage !== "monitor") return;
    try {
      checkLocalRoute(t);
      if (Date.now() - t.started > TIMEOUT_MS) throw new Error("10分钟内未确认完整回答，结果未确认；请检查网页");
      const q = t.selectors;
      const stops = A.all(q.stop);
      if (stops.length > 1) throw new Error("生成控件不唯一，无法确认任务归属");
      if (stops.length && !t.sawStop) { t.sawStop = true; report("running"); }
      const composer = A.one(q.composer, "聊天输入框", true);
      if (composer && !A.composerText(composer).trim()) t.accepted = true;
      // 空转判定：消息已经发出、输入框也空了，但既没有在生成、又迟迟没有回答内容。
      // 实测触发过 ChatGPT 的 "Unusual activity has been detected from your device."
      // ——那种情况下页面不会产出回答，一直等只会白耗到 10 分钟超时。
      // 这里不依赖站点的报错类名（实测没有稳定锚点），只看“没有进展”这个事实。
      if (t.accepted && !stops.length && !t.answerSeen && t.attempted &&
          Date.now() - t.started > IDLE_MS) {
        throw new Error(`${Math.round(IDLE_MS / 1000)} 秒内既没有回答也没有在生成，结果未确认（网页可能报错或被限流）；未重发`);
      }
      const nodes = A.all(q.assistant);
      if (!nodes.length) return;
      // 不能靠“消息数量 +1”判断新答复：DeepSeek 是虚拟列表，只渲染可视区消息，
      // 新增一条时最旧的一条会被卸载，数量可能完全不变。
      // 也不能对该站点做前缀基线比对：卸载发生在头部，会让所有索引整体前移，
      // 严格比对必然误报“旧消息重新排列”。只对非虚拟列表的站点保留严格比对。
      if (!t.virtualList && !t.resumed) {
        const keep = Math.min(t.baseline.length, nodes.length - 1);
        if (keep > 0 && !sameBaseline(t.baseline.slice(0, keep), nodes, t.provider)) {
          throw new Error("旧消息重新排列或标识改变，无法可靠区分新答复");
        }
      }
      const answer = nodes[nodes.length - 1];
      if (!A.answerReady(answer, t.provider)) return; // 新消息容器已出现但正文还没渲染
      const text = A.answerText(answer, t.provider);
      if (text.trim()) t.answerSeen = true; // 有正文出现过，空转判定就不再适用
      if (text.length > S.MAX_ANSWER) throw new Error("回答超过120000字符，未截断冒充完整结果");
      // 正文一变就重置稳定计时。能走到下面的完成判定，必然意味着这条正文在本次
      // 任务期间变化过，所以“回答与旧消息文本相同”不会被误判成旧答复。
      if (text !== t.lastText) {
        t.lastText = text;
        t.stableSince = Date.now();
        t.settleUntil = 0; // 正文又变了，说明还在写，重新开始等
        return;
      }
      // 续读模式（页面重载后接管）下，composer 可能因为长会话/滚动而短暂取不到，
      // 所以这一条不成立也不算失败。
      const composerOk = !!composer && A.editable(composer);
      if (t.resumed && !composerOk) return;
      // done 选择器为空表示该站点没有可用的完成控件。实测两站都是这样：
      // ChatGPT 的“复制消息”按钮属于用户轮次，DeepSeek 生成期间根本没有停止按钮。
      // 此时只能靠“本次新增消息的正文停止增长”判定。
      const noDoneControl = !q.done;
      if (noDoneControl) {
        if (!text || !t.accepted || stops.length) return;
        const done2 = A.messageRoot(answer, t.provider);
        // composer 可用性只在非续读模式下作为硬条件；续读时上面已单独判过。
        if (!done2 || (!composerOk && !t.resumed)) return;
        if (text.length < S.MIN_ANSWER_CHARS) return;      // 排除几乎是空的流式残片
        const quiet = Date.now() - t.stableSince;
        if (quiet < S.STABLE_MS) return;                   // 第一段静默：确认流式结束
        // 第二道等待：确认流式结束后再多等一段才交付。ChatGPT 的 Pro 模型会
        // “停一下再补内容”，只凭第一段静默容易抓到半截回答。
        if (!t.settleUntil) {
          t.settleUntil = Date.now() + S.SETTLE_MS;
          report("running");
          return;
        }
        if (Date.now() < t.settleUntil) return;
        // 缓冲期内正文若又变长，说明刚才只是停顿，回到等待状态重来。
        if (text.length !== t.lastText.length) return;
        report("complete", {text});
        return;
      }
      if (!text || !t.accepted || stops.length || !t.sawStop) return;
      if (Date.now() - t.stableSince < 2000) return;
      const done = A.all(q.done, A.messageRoot(answer, t.provider));
      if (done.length !== 1 || !composer || !A.editable(composer)) return;
      report("complete", {text});
    } catch (err) { fail(err); }
  }
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      observe();
      const sentReport = outgoing;
      const reply = await message({type: "tick", ...(sentReport ? {report: sentReport} : {})});
      if (reply.reportAck === sentReport?.task_id && outgoing === sentReport) outgoing = null;
      // 注意：后台明确给出续接入口（reply.resume）时，不能因为 pendingStatus 是
      // uncertain 就把本地任务丢掉——那正好把自愈重建的接管机会又扔掉，任务会一直
      // 卡在 uncertain 直到人工解挂。只有在“没有续接机会”时才放弃本地跟踪。
      const resumable = !!reply.resume && !current;
      if (!reply.connected || reply.paused || (reply.pendingStatus === "uncertain" && !resumable)) {
        if (current) current.cancelled = true;
        current = null;
        // The background has either persisted this report or an even more conservative state.
        if (reply.paused || !reply.connected) outgoing = null;
      } else if (current?.finished && !reply.pendingId) {
        current = null;
      }
      if (reply.task && reply.adapter && !current) void startTask(reply.task, reply.adapter);
      // 页面整页重载后本脚本是全新实例，内存里的任务状态全丢了。这里向后台
      // 申请“续接”：只接管读取答案，绝不重发消息。后台只在确实已登记过发送
      // 尝试时才答应，所以不会凭空造出任务。
      else if (reply.resume && !current) {
        const taken = await message({type: "resume-take", task_id: reply.resume.task_id});
        if (taken?.task && taken.adapter) void startResume(taken.task, taken.adapter);
      }
    } catch {
      // A lost reply never repeats a click. The background retains pending reports/tasks.
    } finally { ticking = false; }
  }
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (msg.type === "bridge/probe") { sendResponse({instance}); return false; }
    // 自省接口：只读地暴露当前任务状态，供排查“任务卡住但页面看起来正常”这类问题。
    // 不改变任何行为，也不授予任何操作。
    if (msg.type === "bridge/introspect") {
      const t = current;
      sendResponse({
        instance,
        hasTask: !!t,
        task: t ? {
          task_id: t.task_id, stage: t.stage, provider: t.provider, resumed: !!t.resumed,
          accepted: !!t.accepted, sawStop: !!t.sawStop, finished: !!t.finished,
          cancelled: !!t.cancelled, attempted: !!t.attempted, virtualList: !!t.virtualList,
          baseline: t.baseline.length, lastTextLen: (t.lastText || "").length,
          lastTextHead: (t.lastText || "").slice(0, 40),
          stableForMs: t.stableSince ? Date.now() - t.stableSince : null,
          settleInMs: t.settleUntil ? t.settleUntil - Date.now() : null,
          hadOutgoingReport: !!outgoing,
        } : null,
        thresholds: { STABLE_MS: S.STABLE_MS, SETTLE_MS: S.SETTLE_MS, MIN_ANSWER_CHARS: S.MIN_ANSWER_CHARS },
      });
      return false;
    }
    if (msg.type === "bridge/cancelLocal") {
      if (msg.task_id) cancelledIds.add(msg.task_id);
      if (current && (!msg.task_id || msg.task_id === current.task_id)) current.cancelled = true;
      if (current?.cancelled) current = null;
      outgoing = null;
      sendResponse({cancelled: true});
      return false;
    }
    return false;
  });
  const observer = new MutationObserver(() => {
    if (!current || current.finished || observerTimer) return;
    observerTimer = setTimeout(() => { observerTimer = null; observe(); }, 80);
  });
  observer.observe(document.documentElement, {subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ["disabled", "aria-disabled", "aria-busy", "data-is-streaming"]});
  document.addEventListener("input", event => {
    // 插件自己写入文本时必须豁免：execCommand("insertText") 走的是浏览器原生
    // 输入路径，产生的 input 事件 isTrusted === true，与真实用户输入无法区分。
    // 若不放行，插件会把自己写的字误判成用户改草稿而中止任务。
    if (current?.writingComposer) return;
    if (event.isTrusted && current && !current.finished &&
        (event.target === current.composer || current.composer?.contains(event.target))) {
      fail(new Error("用户修改了聊天框，自动派发已暂停，未覆盖新输入"));
    }
  }, true);
  document.addEventListener("click", event => {
    if (!event.isTrusted || !current || current.finished || current.stage !== "monitor") return;
    try {
      if (event.target instanceof Element && event.target.closest(current.selectors.stop + ", " + current.selectors.send)) {
        fail(new Error("用户操作了发送或停止按钮，结果需人工核实"));
      }
    } catch { fail(new Error("无法确认页面控件")); }
  }, true);
  setInterval(tick, 2000);
  void tick();
})();
