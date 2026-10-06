"use strict";
importScripts("shared.js", "adapters.js");
const S = BridgeShared;
const CONFIG = "bridge_config";
const PREFIX = "bridge_tab_";
const locks = new Map();
const ACTIVE = new Set(["delivered", "attempting", "sent", "running"]);
// 任务停滞阈值：已发出但这么久没有新回执推进，就认为跟踪它的内容脚本实例没了，
// 需要让当前实例去核对并接管（自愈）。取得比一次正常问答的停顿更长，避免误判。
const STALL_MS = 90_000;
const startup = (async () => {
  // Do not expose the pairing token to content scripts through chrome.storage.
  await chrome.storage.local.setAccessLevel({accessLevel: "TRUSTED_CONTEXTS"});
  const saved = (await chrome.storage.local.get(CONFIG))[CONFIG];
  if (!saved?.client_id) await chrome.storage.local.set({[CONFIG]: {
    token: "", adapters: {}, bridge_port: S.DEFAULT_PORT, ...saved, client_id: crypto.randomUUID()
  }});
})();

function serial(key, action) {
  const previous = locks.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  locks.set(key, next);
  next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => {});
  return next;
}
// 本机桥地址不写死：设置页可指定端口，插件换端口后由在线检查自动跟随。
function loopback(port) {
  return `http://127.0.0.1:${port}`;
}
async function endpoint(cfg) {
  const saved = cfg?.bridge_port;
  return loopback(Number.isInteger(saved) && saved > 0 && saved < 65536 ? saved : S.DEFAULT_PORT);
}
function candidatePorts(cfg) {
  const saved = cfg?.bridge_port;
  const valid = Number.isInteger(saved) && saved > 0 && saved < 65536;
  // 只有用户显式改过端口（不等于默认值）才收敛为单一候选；
  // 保持默认值时必须继续探测，否则插件换端口后永远自动跟随不上。
  const list = valid && saved !== S.DEFAULT_PORT ? [saved] : [...S.CANDIDATE_PORTS];
  return [...new Set(list)];
}
async function config() { await startup; return (await chrome.storage.local.get(CONFIG))[CONFIG]; }
async function binding(tabId) { return (await chrome.storage.local.get(PREFIX + tabId))[PREFIX + tabId]; }
async function save(b) {
  b.updated_at = new Date().toISOString();
  await chrome.storage.local.set({[PREFIX + b.tab_id]: b});
}
async function allBindings() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all).filter(([k]) => k.startsWith(PREFIX)).map(([, v]) => v);
}
function publicBinding(b) {
  if (!b) return null;
  return {tab_id: b.tab_id, agent: b.agent, provider: b.provider, url: b.url,
    connected: b.connected, paused: b.paused, message: b.message, updated_at: b.updated_at,
    network_error: b.network_error || null, bridge_seen: b.bridge_seen || null,
    pending: b.pending ? {task_id: b.pending.task_id, phase: b.pending.phase} : null};
}
function response(b, cfg) {
  const result = {ok: true, connected: !!b?.connected, paused: !!b?.paused,
    message: b?.message || "", pendingStatus: b?.pending?.phase || null,
    pendingId: b?.pending?.task_id || null};
  if (b?.connected) result.adapter = {provider: b.provider,
    selectors: BridgeAdapters.selectors(b.provider, cfg.adapters?.[b.provider])};
  if (b?.connected && !b.paused && b.pending?.phase === "delivered") {
    result.task = {task_id: b.pending.task_id, prompt: b.pending.prompt};
  }
  // 页面整页重载后内容脚本会换成新实例，内存里的任务状态丢失。此时把“已发出、
  // 正在等回答”的任务标出来，让新实例来续接读取（绝不重发）。后台只在确实
  // 登记过发送尝试时才提供，所以新实例不会凭空造出任务。
  // 提示词必须还在：续接要靠它核对“当前页面是不是本次提问的那个会话”。
  if (b?.connected && !b.paused && b.pending?.submitAttempted && b.pending?.prompt &&
      !["complete", "error"].includes(b.pending.phase) && !b.pending.report) {
    result.resume = {task_id: b.pending.task_id};
  }
  return result;
}
// 任务停滞判定：已登记发送尝试、还没终结，但很久没有新的回执推进。
// 这种状态通常是内容脚本实例被换掉（刷新/扩展重载）后没人接管，需要自愈。
function stalled(b, now = Date.now()) {
  const p = b?.pending;
  if (!p || !p.submitAttempted) return false;
  if (["complete", "error"].includes(p.phase)) return false;
  const last = Date.parse(p.last_report_at || p.attempted_at || p.claimed_at || 0);
  return Number.isFinite(last) && now - last > STALL_MS;
}
function halt(b, message, status = "uncertain") {
  b.paused = true;
  b.message = message;
  if (b.pending && !["complete", "error"].includes(b.pending.phase)) {
    b.pending.phase = status;
    b.pending.report = {task_id: b.pending.task_id, status, error: message, url: b.url};
    delete b.pending.prompt;
  }
}
function checkNavigation(b, url) {
  const nav = S.navigation(b, url);
  if (!nav.ok) {
    halt(b, "聊天页面已改变，未继续派发或重发；请检查网页后重新连接",
      b.pending?.submitAttempted ? "uncertain" : "error");
    b.connected = false;
    return false;
  }
  b.route = nav.next;
  b.url = nav.next.url;
  if (nav.adopt && b.pending) b.pending.adoptedConversation = true;
  return true;
}
async function http(path, cfg, body) {
  if (!cfg.token) throw new Error("尚未设置本机配对码");
  if (path !== "/health") {
    const fresh = await config();
    if (fresh?.bridge_port !== cfg.bridge_port) cfg = fresh;
  }
  const encoded = JSON.stringify(body);
  if (new TextEncoder().encode(encoded).length > S.MAX_BODY) throw new Error("上报正文超过512KB，未发送");
  const base = await endpoint(cfg);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(base + path, {method: "POST", credentials: "omit", redirect: "error",
      cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal,
      headers: {"Content-Type": "application/json", "Authorization": "Bearer " + cfg.token}, body: encoded});
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let size = 0, text = "";
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > S.MAX_BODY) { await reader.cancel(); throw new Error("本机桥响应过大"); }
      text += decoder.decode(value, {stream: true});
    }
    text += decoder.decode();
    if (!res.ok) {
      let detail = "";
      try { const problem = JSON.parse(text); if (typeof problem.error === "string") detail = problem.error.slice(0, 500); } catch { /* Do not display HTML or arbitrary response bodies. */ }
      throw new Error(res.status === 401 ? "配对码未通过，请检查设置" : detail || "本机桥暂未接受请求，请检查服务状态");
    }
    return JSON.parse(text);
  } finally { clearTimeout(timer); }
}
function envelope(b, cfg, report) {
  return {client_id: cfg.client_id, agent: b.agent, provider: b.provider,
    tab_id: b.tab_id, url: b.url, ...(report ? {report} : {})};
}
async function flushReport(b, cfg) {
  const report = b.pending?.report;
  if (!report) return null;
  const data = await http("/v1/tick", cfg, envelope(b, cfg, report));
  if (data.task) throw new Error("本机桥在报告请求中意外派发新任务，已停止接收");
  if (data.ack !== report.task_id) throw new Error("报告未获确认，保留本地记录");
  b.pending.report = null;
  if (["complete", "error"].includes(report.status)) {
    b.last_task = {task_id: report.task_id, status: report.status, at: new Date().toISOString()};
    b.pending = null;
  }
  await save(b);
  return data.ack;
}
// 自愈：任务停滞说明跟踪它的内容脚本实例已经没了（刷新 / 扩展重载 / 页面被换掉）。
// 这里只做一件事——把状态清理成“可以续接”：撤销挂起、把阶段拉回 sent。
// 内容脚本下一次心跳就会看到续接入口，由它核对会话后接管读取，绝不重发消息。
// 返回 true 表示本次做了自愈动作（调用方需要落盘）。
function revive(b, now = Date.now()) {
  if (!stalled(b, now)) return false;
  b.paused = false;
  if (b.pending.report) {
    // 上一实例留下的回执还没送出去，先留着按正常流程冲掉；
    // 但它不能挡住续接，所以不在这里动它。
    b.message = "任务停滞，已重新开放续接（原回执仍待上报）";
    return true;
  }
  b.pending.phase = "sent";
  b.message = "任务停滞，已重新开放续接（不重发消息）";
  return true;
}
function applyReport(b, report) {
  if (!report || !b.pending || b.pending.task_id !== report.task_id) return;
  if (b.pending.phase === "uncertain") return; // Manual resolution is required after ambiguous execution.
  if (!["sent", "running", "complete", "uncertain", "error"].includes(report.status)) throw new Error("无效的任务状态");
  if (["sent", "running", "complete"].includes(report.status) && !b.pending.submitAttempted) throw new Error("尚未登记发送尝试");
  if (report.status === "complete" && (typeof report.text !== "string" || !report.text.trim() || report.text.length > S.MAX_ANSWER)) {
    halt(b, "回答为空或超过120000字符，不能标记完整"); return;
  }
  const clean = {task_id: report.task_id, status: report.status, url: b.url};
  if (report.status === "complete") clean.text = report.text;
  if (typeof report.error === "string") clean.error = report.error.slice(0, 1000);
  if (new TextEncoder().encode(JSON.stringify(clean)).length > S.MAX_BODY - 4096) {
    halt(b, "回答上报超过512KB，保留网页供人工检查"); return;
  }
  b.pending.phase = report.status;
  b.pending.report = clean;
  // 停滞判定要看这个：只要有回执推进，就不算停滞。
  b.pending.last_report_at = new Date().toISOString();
  if (["uncertain", "error"].includes(report.status)) { b.paused = true; b.message = clean.error || "任务已暂停"; }
  if (["complete", "uncertain", "error"].includes(report.status)) delete b.pending.prompt;
}
async function pageMessage(msg, sender) {
  await startup;
  if (sender.frameId !== 0 || !sender.tab || typeof msg.instance !== "string" || msg.instance.length > 100) throw new Error("无效页面来源");
  const id = sender.tab.id;
  return serial(id, async () => {
    const cfg = await config();
    const b = await binding(id);
    if (!b) return response(null, cfg);
    const actualTab = await chrome.tabs.get(id);
    checkNavigation(b, actualTab.url || sender.url || "");
    const instanceSwapped = !!b.instance && b.instance !== msg.instance;
    if (instanceSwapped && b.pending?.submitAttempted && ACTIVE.has(b.pending.phase)) {
      // 内容脚本换了实例（页面整页重载）。消息已经发出去了，所以不重发；
      // 交给新实例续接读取答案。真正拿到结果前一律维持“结果未确认”。
      b.paused = false;
      b.message = "页面已重新加载；消息早已发出，改为续接读取回答（不重发）";
    }
    if (!b.instance || instanceSwapped) b.instance = msg.instance;
    b.last_seen = Date.now();
    if (msg.type === "resume-take") {
      // 新实例申请续接：只在确实登记过发送尝试、且还没终结时答应。
      // 不因“有回执在排队”而拒绝——回执该由随后的 tick 正常冲出去，
      // 这不影响续接只是读答案这件事。
      // 也允许从 uncertain 恢复：停滞正是自愈要处理的情形。
      if (stalled(b)) revive(b);
      if (!b.connected || b.paused || !b.pending || !b.pending.submitAttempted ||
          ["complete", "error"].includes(b.pending.phase) ||
          !b.pending.prompt || b.pending.task_id !== msg.task_id) {
        await save(b);
        throw new Error("没有可续接的任务；不会重发网页消息");
      }
      await save(b);
      return {ok: true, task: {task_id: b.pending.task_id, prompt: b.pending.prompt},
        adapter: {provider: b.provider,
          selectors: BridgeAdapters.selectors(b.provider, cfg.adapters?.[b.provider])}};
    }
    if (msg.type === "resume-done") {
      // 续接结束时保留提示词：它是重载后核对“站在哪个会话”的唯一依据，
      // 删掉就等于放弃后续自愈能力。提示词本来也已存在桥的 tasks.json 里，
      // 留一份不会扩大暴露面；任务进入终态时由 applyReport 统一清掉。
      if (b.pending && b.pending.task_id === msg.task_id) {
        b.pending.resumed_at = new Date().toISOString();
        await save(b);
      }
      return {ok: true};
    }
    if (msg.type === "prepare" || msg.type === "authorize-click") {
      const wantedPhase = msg.type === "prepare" ? "delivered" : "attempting";
      if (!b.connected || b.paused || !b.pending || b.pending.phase !== wantedPhase || b.pending.task_id !== msg.task_id) {
        await save(b); throw new Error("发送许可失效，未提交网页消息");
      }
      // prepare 是“允许动输入框”的唯一入口。已登记过发送尝试的任务绝不能再放行，
      // 否则续接场景会退化成重发（同一条消息发第二遍）。
      // 注意：authorize-click 正常就发生在 prepare 之后，那时 submitAttempted 已经
      // 为真，所以这个判断只对 prepare 生效。
      if (msg.type === "prepare" && b.pending.submitAttempted) {
        await save(b); throw new Error("该任务已登记发送尝试，拒绝再次发送");
      }
      if (msg.type === "prepare") {
        b.pending.phase = "attempting";
        b.pending.submitAttempted = true;
        b.pending.attempted_at = new Date().toISOString();
      }
      await save(b); // This must complete before the page is permitted to touch the composer.
      return {ok: true, allowed: true};
    }
    if (msg.type !== "tick") throw new Error("未知页面操作");
    // 自愈：这笔任务若已停滞（跟踪它的旧实例没了），先把状态放开，好让当前实例
    // 在本次应答里拿到续接入口并接管。绝不重发消息。
    const revived = revive(b);
    if (b.connected && !b.paused) applyReport(b, msg.report);
    await save(b);
    let ack = null;
    try {
      if (b.pending?.report) {
        ack = await flushReport(b, cfg);
        b.bridge_seen = new Date().toISOString();
      } else if (b.connected && !b.paused && b.pending?.phase !== "delivered") {
        const data = await http("/v1/tick", cfg, envelope(b, cfg));
        b.bridge_seen = new Date().toISOString();
        if (data.task) {
          if (b.pending) { halt(b, "任务仍在处理中却收到新任务，已停止"); }
          else if (S.validTask(data.task) && data.task.task_id !== b.last_task?.task_id) {
            b.pending = {...data.task, phase: "delivered", submitAttempted: false,
              adoptedConversation: false, claimed_at: new Date().toISOString(), report: null};
            b.message = "任务已领取，尚未点击发送";
          } else {
            b.paused = true;
            b.message = "收到格式错误或已完成的重复任务，未发送；请人工解除";
          }
        } else if (data.pending && !b.pending) {
          b.pending = {task_id: data.pending.task_id, phase: "uncertain", submitAttempted: true,
            report: {task_id: data.pending.task_id, status: "uncertain", error: "服务端已有任务，本地发送现场缺失，禁止重发", url: b.url}};
          b.paused = true;
          b.message = "发现已领取任务但本地现场缺失，请人工检查并解除";
        }
        await save(b);
      }
      b.network_error = null;
      if (b.bridge_seen && !b.pending && !b.paused) b.message = "本机桥已确认，等待任务";
      await save(b);
    } catch (err) {
      b.network_error = "本机桥暂不可用或回执未确认：" + (err.message || "连接失败");
      await save(b);
    }
    const out = response(b, cfg);
    out.reportAck = ack;
    out.networkError = b.network_error;
    return out;
  });
}
function isUI(sender) { return sender.url?.startsWith(chrome.runtime.getURL("")); }
async function uiMessage(msg) {
  const cfg = await config();
  if (msg.type === "ui/state") {
    return {ok: true, paired: !!cfg.token, endpoint: await endpoint(cfg),
      default_port: S.DEFAULT_PORT, candidate_ports: candidatePorts(cfg),
      adapters: cfg.adapters || {}, bindings: (await allBindings()).map(publicBinding)};
  }
  if (msg.type === "ui/port") return serial("settings", async () => {
    const fresh = await config();
    if (!Number.isInteger(msg.port) || msg.port < 1024 || msg.port > 65535) throw new Error("端口需为 1024～65535 的整数");
    fresh.bridge_port = msg.port;
    await chrome.storage.local.set({[CONFIG]: fresh});
    return {ok: true, endpoint: loopback(msg.port)};
  });
  if (msg.type === "ui/settings") return serial("settings", async () => {
    const fresh = await config();
    if (msg.token) {
      if (typeof msg.token !== "string" || msg.token.length > 2048 || /[\s\x00-\x1f]/.test(msg.token)) throw new Error("配对码格式无效");
      fresh.token = msg.token;
    }
    if (msg.provider) {
      if (!BridgeAdapters.DEFAULTS[msg.provider]) throw new Error("不支持的网站");
      const custom = {};
      for (const k of ["composer", "assistant", "send", "stop", "done"]) {
        const v = msg.selectors?.[k];
        if (typeof v !== "string" || v.length > 1500) throw new Error("选择器过长或格式错误");
        if (v.trim()) custom[k] = v.trim();
      }
      fresh.adapters = {...fresh.adapters, [msg.provider]: custom};
    }
    await chrome.storage.local.set({[CONFIG]: fresh});
    return {ok: true};
  });
  if (msg.type === "ui/health") {
    const fresh = await config();
    const ports = candidatePorts(fresh);
    const failures = [];
    for (const port of ports) {
      try {
        const res = await fetch(loopback(port) + "/health", {credentials: "omit", redirect: "error",
          cache: "no-store", signal: AbortSignal.timeout(5000)});
        const body = res.ok ? await res.json().catch(() => null) : null;
        if (!res.ok || body?.service !== "dsh-web-chat-bridge") { failures.push(port + ": 不是本机桥"); continue; }
        if (fresh.bridge_port !== port) {
          fresh.bridge_port = port;
          await chrome.storage.local.set({[CONFIG]: fresh});
        }
        return {ok: true, endpoint: loopback(port), port, followed: ports[0] !== port};
      } catch (err) { failures.push(port + ": " + (err?.name === "TimeoutError" ? "超时" : "无法连接")); }
    }
    throw new Error("本机桥未就绪（已试 " + failures.join("；") + "）。请确认 Harness 插件已启动，或在上面填写正确端口");
  }
  if (msg.type === "ui/resolve") {
    if (!S.validAgent(msg.agent) || msg.confirmed !== true) throw new Error("必须由用户明确点击解除");
    return serial("registry", async () => {
      // Revoke local dispatch before resolving remotely. Await the page's cancellation
      // acknowledgement so a previously granted prepare response cannot click afterwards.
      for (const item of await allBindings()) if (item.agent === msg.agent) await serial(item.tab_id, async () => {
        const b = await binding(item.tab_id);
        b.connected = false; b.paused = true;
        await save(b);
        let tabExists = true;
        try { await chrome.tabs.get(item.tab_id); } catch { tabExists = false; }
        if (tabExists) {
          try {
            const reply = await chrome.tabs.sendMessage(item.tab_id, {type: "bridge/cancelLocal", task_id: b.pending?.task_id});
            if (!reply?.cancelled) throw new Error("未确认");
          } catch {
            throw new Error("旧页面尚未确认停止派发。请先关闭该聊天标签页，再人工解除");
          }
        }
      });
      const result = await http("/v1/resolve", cfg, {client_id: cfg.client_id, agent: msg.agent});
      for (const item of await allBindings()) if (item.agent === msg.agent) await serial(item.tab_id, async () => {
        const b = await binding(item.tab_id);
        b.pending = null; b.connected = false; b.paused = false;
        b.message = "用户已人工解除；重新连接聊天后才继续";
        await save(b);
      });
      return {ok: true, resolved: !!result.resolved};
    });
  }
  if (!Number.isInteger(msg.tab_id)) throw new Error("请选择一个聊天标签页");
  if (msg.type === "ui/connect") return serial("registry", () => serial(msg.tab_id, async () => {
    if (!cfg.token) throw new Error("先在设置页保存本机配对码");
    if (!S.validAgent(msg.agent)) throw new Error("别名用1～80位英文字母、数字、点、横线或下划线");
    const tab = await chrome.tabs.get(msg.tab_id);
    const r = S.route(tab.url);
    if (!r) throw new Error("只支持三站的普通新聊天页或已有对话页；不支持分享页/登录页/自定义GPT页");
    const existing = await binding(tab.id);
    if (existing?.pending) throw new Error("当前标签页有未确认任务；先检查网页并人工解除");
    for (const other of await allBindings()) {
      if (other.tab_id !== tab.id && other.agent === msg.agent && (other.connected || other.pending)) {
        throw new Error("该别名已绑定标签页 " + other.tab_id + "，不会自动替换；请先断开或人工解除旧绑定");
      }
    }
    let probe;
    try { probe = await chrome.tabs.sendMessage(tab.id, {type: "bridge/probe"}); }
    catch { throw new Error("页面脚本未加载。请先刷新此聊天页面，再连接"); }
    if (!probe?.instance) throw new Error("页面脚本没有响应");
    const b = {tab_id: tab.id, agent: msg.agent, provider: r.provider, route: r, url: r.url,
      connected: true, paused: false, instance: probe.instance, pending: null,
      message: "本地已绑定，等待首次心跳确认；三站适配未联测"};
    await save(b);
    return {ok: true, binding: publicBinding(b)};
  }));
  if (msg.type === "ui/disconnect") return serial(msg.tab_id, async () => {
    const b = await binding(msg.tab_id);
    if (!b) return {ok: true};
    b.connected = false;
    halt(b, "用户已断开；网页生成不会被自动停止", b.pending?.submitAttempted ? "uncertain" : "error");
    await save(b);
    try { await chrome.tabs.sendMessage(b.tab_id, {type: "bridge/cancelLocal", task_id: b.pending?.task_id}); }
    catch { b.message = "本地绑定已断开，但页面取消未确认；请关闭旧聊天标签页"; await save(b); }
    try { await flushReport(b, cfg); } catch { /* Keep report for a later tick or manual resolution. */ }
    return {ok: true};
  });
  throw new Error("未知扩展操作");
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender.id !== chrome.runtime.id) return false;
  const promise = isUI(sender) ? uiMessage(msg) : pageMessage(msg, sender);
  promise.then(sendResponse, err => sendResponse({ok: false, error: err.message || "操作失败"}));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  serial(tabId, async () => {
    const b = await binding(tabId);
    if (!b) return;
    b.connected = false;
    halt(b, "标签页已关闭；未自动重发", b.pending?.submitAttempted ? "uncertain" : "error");
    await save(b);
    try { await flushReport(b, await config()); } catch { /* A user can resolve this alias from the popup. */ }
  }).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!change.url && change.status !== "loading") return;
  serial(tabId, async () => {
    const b = await binding(tabId);
    if (!b || !b.connected) return;
    if (change.url) checkNavigation(b, change.url);
    if (change.status === "loading" && b.pending?.submitAttempted && ACTIVE.has(b.pending.phase)) {
      // 页面整页重载：消息在重载之前已经发出去了，所以既不能重发，也不该直接
      // 判失败。保持任务在“已发出”状态，等新内容脚本实例来续接读取答案；
      // 拿到结果之前一律维持结果未确认。
      b.paused = false;
      if (!b.pending.report && !["complete", "error"].includes(b.pending.phase)) {
        b.pending.phase = "sent";
        b.message = "页面已重新加载；消息早已发出，改为续接读取回答（不重发）";
      }
    }
    await save(b);
  }).catch(() => {});
});
