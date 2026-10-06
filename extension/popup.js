"use strict";
const el = id => document.getElementById(id);
let activeTab = null, busy = false, started = false;
async function call(payload) {
  const reply = await chrome.runtime.sendMessage(payload);
  if (!reply?.ok) throw new Error(reply?.error || "后台未响应");
  return reply;
}
function feedback(text, error = false) {
  el("feedback").textContent = text;
  el("feedback").className = error ? "error" : "";
}
async function act(action, success) {
  if (busy) return;
  busy = true;
  for (const b of document.querySelectorAll("button")) b.disabled = true;
  try { await action(); feedback(success); }
  catch (err) { feedback(err.message || "操作失败", true); }
  finally { busy = false; await refresh(); }
}
function button(text, onClick) {
  const b = document.createElement("button");
  b.textContent = text;
  b.className = "secondary";
  b.addEventListener("click", onClick);
  return b;
}
function renderBinding(b) {
  const card = document.createElement("section");
  const title = document.createElement("strong");
  title.textContent = b.agent + " · " + b.provider + " · 标签 " + b.tab_id;
  const status = document.createElement("p");
  status.textContent = BridgeShared.statusLabel(b);
  if (b.connected && !b.bridge_seen) status.textContent = "本地已绑定，等待本机桥确认（尚不能派单）";
  if (b.connected && b.bridge_seen && Date.now() - Date.parse(b.bridge_seen) > 15000) {
    status.textContent += "；心跳已过期，请保持网页打开";
  }
  const info = document.createElement("p");
  info.className = b.network_error || b.paused ? "error" : "muted";
  info.textContent = b.network_error || (b.pending ? "任务 " + b.pending.task_id + "；" : "") + (b.message || "");
  const row = document.createElement("div"); row.className = "row";
  if (b.connected) row.append(button("断开", () => act(
    () => call({type: "ui/disconnect", tab_id: b.tab_id}), "已断开；网页本身的生成未被自动停止")));
  row.append(button("我已检查网页，解除挂起任务", () => act(
    () => call({type: "ui/resolve", agent: b.agent, confirmed: true}), "已人工解除；重新连接指定聊天页后继续")));
  card.append(title, status, info, row);
  return card;
}
async function refresh() {
  if (busy) return;
  try {
    const [state, tabs] = await Promise.all([call({type: "ui/state"}), chrome.tabs.query({active: true, currentWindow: true})]);
    activeTab = tabs[0] || null;
    const route = BridgeShared.route(activeTab?.url);
    el("current-url").textContent = route ? route.url : "先打开已登录的 ChatGPT、DeepSeek 或 Gemini 普通聊天页";
    if (!started) {
      el("agent").value = state.bindings.find(b => b.tab_id === activeTab?.id)?.agent || route?.provider || "";
      started = true;
    }
    el("bindings").replaceChildren(...state.bindings.map(renderBinding));
    el("connect").disabled = !route || !state.paired;
    el("options").disabled = false;
    el("endpoint").textContent = "本机桥 " + (state.endpoint || "");
    if (!state.paired && !el("feedback").textContent) feedback("先在设置页保存本机桥的配对码");
  } catch (err) { feedback(err.message || "读取状态失败", true); }
}
el("connect").addEventListener("click", () => act(
  () => call({type: "ui/connect", tab_id: activeTab?.id, agent: el("agent").value.trim()}),
  "本地绑定已保存，等待本机桥心跳确认"));
el("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
void refresh();
setInterval(refresh, 2000);
