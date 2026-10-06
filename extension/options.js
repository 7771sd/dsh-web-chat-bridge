"use strict";
const fieldNames = ["composer", "assistant", "send", "stop", "done"];
const el = id => document.getElementById(id);
let settings = {adapters: {}};
async function call(payload) {
  const reply = await chrome.runtime.sendMessage(payload);
  if (!reply?.ok) throw new Error(reply?.error || "扩展后台未响应");
  return reply;
}
function feedback(text, error = false) {
  el("feedback").textContent = text;
  el("feedback").className = error ? "error" : "";
}
function showProvider() {
  const p = el("provider").value;
  for (const name of fieldNames) {
    el(name).value = settings.adapters?.[p]?.[name] || "";
    el(name).placeholder = BridgeAdapters.DEFAULTS[p][name];
  }
}
async function load() {
  settings = await call({type: "ui/state"});
  el("paired").textContent = settings.paired ? "已保存配对码（不会回显）" : "尚未设置配对码";
  el("port").placeholder = String(settings.default_port ?? 32145);
  const m = /:(\d+)$/.exec(settings.endpoint || "");
  el("port").value = m ? m[1] : "";
  showProvider();
}
el("pair-form").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const port = el("port").value.trim();
    if (port) await call({type: "ui/port", port: Number(port)});
    if (!el("token").value.trim() && !settings.paired) throw new Error("请填写本机桥提供的配对码");
    await call({type: "ui/settings", token: el("token").value.trim()});
    el("token").value = "";
    await load();
    feedback("已保存；实际配对以聊天标签页的心跳确认为准");
  } catch (err) { feedback(err.message, true); }
});
el("health").addEventListener("click", async () => {
  try {
    const port = el("port").value.trim();
    if (port) await call({type: "ui/port", port: Number(port)});
    const result = await call({type: "ui/health"});
    await load();
    feedback("本机桥在线：" + result.endpoint +
      (result.followed ? "（已自动跟随实际端口并记住）" : "") + "；此检查不验证配对码或站点适配");
  } catch (err) { feedback(err.message, true); }
});
async function saveSelectors(reset) {
  const selectors = {};
  for (const name of fieldNames) {
    const text = reset ? "" : el(name).value.trim();
    if (text) document.querySelectorAll(text); // Syntax check only; no page execution.
    selectors[name] = text;
  }
  await call({type: "ui/settings", provider: el("provider").value, selectors});
  await load();
  feedback("已保存该站选择器。断开再连接后用于新任务，仍需真实页面验证");
}
el("provider").addEventListener("change", showProvider);
el("adapter-form").addEventListener("submit", async event => {
  event.preventDefault();
  try { await saveSelectors(false); } catch (err) { feedback(err.message, true); }
});
el("reset").addEventListener("click", async () => {
  try { await saveSelectors(true); } catch (err) { feedback(err.message, true); }
});
load().catch(err => feedback(err.message, true));
