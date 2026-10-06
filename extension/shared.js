(function (root) {
  "use strict";
  // 端口不再写死：32145 是 DSH 插件的默认值，其余为兼容旧配置的探测候选。
  // 扩展设置里可显式指定；桥接地址改变时不必改代码。
  const DEFAULT_PORT = 32145;
  const CANDIDATE_PORTS = [32145, 32146, 32147];
  // 回答交付前的判定阈值（content.js 用）：
  //   STABLE_MS   正文连续不变多久才算“流式结束”
  //   SETTLE_MS   流式结束后再等多久才真正读取，避开“停一下又补内容”
  //   MIN_ANSWER_CHARS  短于此长度的正文不当作完整回答
  const STABLE_MS = 3000;
  const SETTLE_MS = 2500;
  const MIN_ANSWER_CHARS = 5;
  const MAX_PROMPT = 24000;
  const MAX_ANSWER = 120000;
  const MAX_BODY = 512 * 1024;
  const PROVIDERS = {
    "chatgpt.com": "chatgpt",
    "chat.deepseek.com": "deepseek",
    "gemini.google.com": "gemini"
  };
  // 会话 id 里可能带 URL 编码字符：ChatGPT 新会话会先跳到
  //   /c/local-chatgpt%3A<uuid>      （%3A 是编码后的冒号）
  // 再把地址换成正式会话。原来的 [A-Za-z0-9_-] 遇到 % 直接判为非法，
  // 导致刚发出消息就被当成“聊天页面已改变”而中止。这里放宽为 URL 编码安全的集合。
  const ID = "([A-Za-z0-9_%.-]+)";
  function route(raw) {
    let u;
    try { u = new URL(raw); } catch { return null; }
    const provider = PROVIDERS[u.hostname];
    if (u.protocol !== "https:" || !provider || u.port) return null;
    const p = u.pathname.replace(/\/+$/, "") || "/";
    let id = null;
    if (provider === "chatgpt") {
      if (p !== "/") id = new RegExp(`^/c/${ID}$`).exec(p)?.[1];
      if (p !== "/" && !id) return null;
    } else if (provider === "deepseek") {
      if (p !== "/" && p !== "/a/chat") id = new RegExp(`^/a/chat/s/${ID}$`).exec(p)?.[1];
      if (p !== "/" && p !== "/a/chat" && !id) return null;
    } else {
      if (p !== "/" && p !== "/app") id = new RegExp(`^/app/${ID}$`).exec(p)?.[1];
      if (p !== "/" && p !== "/app" && !id) return null;
    }
    return {provider, id, key: provider + ":" + (id || "new"), url: u.origin + p};
  }
  // 临时会话 id 的特征：实测形状是 local-chatgpt%3A<uuid>（含 URL 编码字符）。
  // 它随后会被换成正式会话 id，这段过渡必须当成同一次发送，不能拒绝。
  function temporaryId(id) {
    return !!id && (id.includes("%") || /^local[-_]/i.test(id));
  }
  function navigation(binding, url) {
    const next = route(url);
    if (!next || next.provider !== binding.provider) return {ok: false};
    if (next.key === binding.route.key) return {ok: true, next};
    const t = binding.pending;
    // 首页首次发送后 ChatGPT 会连续换址：/ → /c/local-chatgpt%3A<uuid> → /c/<uuid>。
    // 只要新旧地址中有一边是“还没有会话”或“临时会话”，就都属于这次发送的落点，继续跟随。
    // 反向保护：两边都是正式会话 id 且不同，才是真的切到了别的会话，必须拒绝。
    if (t?.submitAttempted && ["attempting", "sent", "running"].includes(t.phase)) {
      const transitional = !binding.route.id || !next.id ||
        temporaryId(binding.route.id) || temporaryId(next.id);
      if (transitional) return {ok: true, next, adopt: true};
    }
    return {ok: false};
  }
  function validAgent(agent) {
    return typeof agent === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(agent);
  }
  function validTask(task) {
    return task && typeof task.task_id === "string" && task.task_id.length > 0 &&
      task.task_id.length <= 160 && typeof task.prompt === "string" &&
      task.prompt.trim().length > 0 && task.prompt.length <= MAX_PROMPT;
  }
  function statusLabel(binding) {
    if (!binding) return "尚未连接";
    const labels = {delivered: "待发送", attempting: "发送待确认", sent: "已发送", running: "正在回答",
      complete: "已取得回答", uncertain: "结果未确认，已暂停", error: "已停止"};
    return (binding.connected ? "已连接" : "已断开") + " · " +
      (labels[binding.pending?.phase] || binding.message || "等待任务");
  }
  const api = {DEFAULT_PORT, CANDIDATE_PORTS, STABLE_MS, SETTLE_MS, MIN_ANSWER_CHARS,
    MAX_PROMPT, MAX_ANSWER, MAX_BODY, route, navigation, validAgent, validTask, statusLabel};
  root.BridgeShared = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
