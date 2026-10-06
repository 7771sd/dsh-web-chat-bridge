// 自愈回归：内容脚本实例被换掉（刷新/扩展重载）后任务会停滞，
// 必须能被新实例接管读回答案，且绝不重发消息。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createBridge } from '../bridge.js';

const extensionDir = fileURLToPath(new URL('../extension/', import.meta.url));
const extensionId = 'a'.repeat(32);
const copy = value => structuredClone(value);

async function fixture(t) {
  const stateDir = mkdtempSync(join(tmpdir(), 'web-chat-heal-'));
  const core = await createBridge({ port: 0, stateDir, minIntervalMs: 0 });
  t.after(async () => {
    await core.close();
    assert.equal(dirname(resolve(stateDir)), resolve(tmpdir()));
    rmSync(stateDir, { recursive: true, force: true });
  });
  const storage = {};
  const tab = { id: 41, url: 'https://chatgpt.com/c/heal-test' };
  let pageInstance = 'instance-before';
  let listener;
  const chrome = {
    storage: { local: {
      async setAccessLevel() {},
      async get(keys) {
        if (keys === null) return copy(storage);
        const names = typeof keys === 'string' ? [keys] : keys;
        return copy(Object.fromEntries(names.filter(k => k in storage).map(k => [k, storage[k]])));
      },
      async set(value) { Object.assign(storage, copy(value)); },
    } },
    runtime: { id: extensionId, getURL: p => `chrome-extension://${extensionId}/${p}`,
      onMessage: { addListener(fn) { listener = fn; } } },
    tabs: {
      async get() { return copy(tab); },
      async sendMessage(_id, message) {
        if (message.type === 'bridge/probe') return { instance: pageInstance };
        return { cancelled: true };
      },
      onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
    },
  };
  const context = vm.createContext({
    chrome, crypto: webcrypto, URL, TextEncoder, TextDecoder, AbortController, AbortSignal,
    setTimeout, clearTimeout, structuredClone,
    async fetch(input, options) {
      const target = new URL(input);
      assert.equal(target.hostname, '127.0.0.1', '禁止测试向外网发送请求');
      return fetch(new URL(target.pathname, core.info().url),
        { ...options, headers: { ...options?.headers, Origin: `chrome-extension://${extensionId}` } });
    },
  });
  context.importScripts = (...files) => {
    for (const f of files) vm.runInContext(readFileSync(join(extensionDir, f), 'utf8'), context, { filename: f });
  };
  vm.runInContext(readFileSync(join(extensionDir, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  await new Promise(r => setTimeout(r, 30));

  // 后台的错误路径用 {ok:false,error} 应答，这里统一转成抛出
  const send = message => new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => reject(new Error('扩展消息超时')), 5000);
    const isUI = (message.type || '').startsWith('ui/');
    const sender = isUI ? { id: extensionId, url: chrome.runtime.getURL('options.html') }
      : { id: extensionId, frameId: 0, tab: copy(tab), url: tab.url };
    let settled = false;
    const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolveMessage(copy(result)); } };
    try { listener(message, sender, finish); }
    catch (error) { if (!settled) { settled = true; clearTimeout(timer); reject(error); } }
  });
  const call = async message => {
    const reply = await send(message);
    if (!reply?.ok) throw new Error(reply?.error || '扩展后台未响应');
    return reply;
  };
  return {
    core, call, storage,
    page: message => call({ instance: pageInstance, ...message }),
    refresh: () => { pageInstance = `instance-${Math.random().toString(16).slice(2, 8)}`; },
    binding: () => copy(storage[`bridge_tab_${tab.id}`]),
    // 直接把“最后回执时间”推到很久以前，模拟停滞，避免测试真的等 90 秒
    ageTask: (ms = 200_000) => {
      const b = storage[`bridge_tab_${tab.id}`];
      b.pending.last_report_at = new Date(Date.now() - ms).toISOString();
      storage[`bridge_tab_${tab.id}`] = b;
    },
  };
}

test('自愈：任务停滞且实例被换掉后，新实例可续接读取，且不重发', async t => {
  const f = await fixture(t);
  // 连接并派一条任务
  await f.call({ type: 'ui/settings', token: readFileSync(f.core.info().pairing_file, 'utf8').trim() });
  await f.call({ type: 'ui/connect', tab_id: 41, agent: 'heal-agent' });
  await f.page({ type: 'tick' }); // 首次心跳把助手登记到桥侧
  const task = f.core.dispatch({ agent: 'heal-agent', prompt: '只回复测试回答，不执行任何操作', request_id: 'heal-1' });
  await f.page({ type: 'tick' });
  assert.equal((await f.page({ type: 'prepare', task_id: task.task_id })).allowed, true);
  assert.equal((await f.page({ type: 'authorize-click', task_id: task.task_id })).allowed, true);
  await f.page({ type: 'tick', report: { task_id: task.task_id, status: 'sent' } });
  assert.equal(f.binding().pending.phase, 'sent');

  // 模拟：跟踪这条任务的实例没了（刷新/扩展重载），任务停在 sent 很久
  f.refresh();
  f.ageTask();

  // 新实例的心跳应当拿到续接入口
  const ticked = await f.page({ type: 'tick' });
  assert.equal(ticked.task, undefined, '绝不重新领单（不重发）');
  assert.equal(ticked.resume?.task_id, task.task_id, '停滞任务应重新开放续接');

  // 续接能拿到任务文本（用于核对会话），但拿不到任何发送许可
  const taken = await f.page({ type: 'resume-take', task_id: task.task_id });
  assert.equal(taken.ok, true);
  assert.ok(taken.task.prompt, '续接需要提示词核对会话');
  assert.equal(taken.allowed, undefined, '续接不授予发送许可');

  // 续接路径绝不允许退化成重发
  await assert.rejects(async () => f.page({ type: 'prepare', task_id: task.task_id }), /拒绝再次发送|发送许可失效/);
});

test('自愈不会误伤正常任务：回执在推进时不算停滞', async t => {
  const f = await fixture(t);
  await f.call({ type: 'ui/settings', token: readFileSync(f.core.info().pairing_file, 'utf8').trim() });
  await f.call({ type: 'ui/connect', tab_id: 41, agent: 'heal-agent2' });
  await f.page({ type: 'tick' }); // 首次心跳把助手登记到桥侧
  const task = f.core.dispatch({ agent: 'heal-agent2', prompt: '正常任务', request_id: 'heal-2' });
  await f.page({ type: 'tick' });
  await f.page({ type: 'prepare', task_id: task.task_id });
  await f.page({ type: 'authorize-click', task_id: task.task_id });
  await f.page({ type: 'tick', report: { task_id: task.task_id, status: 'sent' } });

  // 刚上报过，属于正常进行中，不应被当成停滞
  const ticked = await f.page({ type: 'tick' });
  assert.equal(ticked.task, undefined, '不重发');
  // 提示词保留（续接需要），但任务阶段仍应是 sent，没有被自愈改写
  assert.equal(f.binding().pending.phase, 'sent');
  assert.ok(f.binding().pending.submitAttempted);
});

test('任务进入终态后清掉提示词，不再提供续接', async t => {
  const f = await fixture(t);
  await f.call({ type: 'ui/settings', token: readFileSync(f.core.info().pairing_file, 'utf8').trim() });
  await f.call({ type: 'ui/connect', tab_id: 41, agent: 'heal-agent3' });
  await f.page({ type: 'tick' }); // 首次心跳把助手登记到桥侧
  const task = f.core.dispatch({ agent: 'heal-agent3', prompt: '终态任务', request_id: 'heal-3' });
  await f.page({ type: 'tick' });
  await f.page({ type: 'prepare', task_id: task.task_id });
  await f.page({ type: 'authorize-click', task_id: task.task_id });
  await f.page({ type: 'tick', report: { task_id: task.task_id, status: 'complete', text: '答案' } });
  // 终态后 pending 整体清掉（提示词随之消失），不再有可续接的现场。
  assert.equal(f.binding().pending, null, '终态后不保留 pending，提示词随之清掉');

  const ticked = await f.page({ type: 'tick' });
  assert.equal(ticked.resume, undefined, '终态任务不再提供续接');
  assert.equal(ticked.task, undefined, '终态任务不重发');
});
