// 扩展后台脚本与真实本机 HTTP 桥联调；页面消息用内存替身，不代表实站验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createBridge } from '../bridge.js';

const extensionDir = fileURLToPath(new URL('../extension/', import.meta.url));
const extensionId = 'a'.repeat(32);
const copy = value => structuredClone(value);

async function fixture(t) {
  const stateDir = mkdtempSync(join(tmpdir(), 'web-chat-protocol-'));
  const core = await createBridge({ port: 0, stateDir, minIntervalMs: 0 });
  t.after(async () => {
    await core.close();
    assert.equal(dirname(resolve(stateDir)), resolve(tmpdir()));
    rmSync(stateDir, { recursive: true, force: true });
  });
  const storage = {};
  const tab = { id: 17, url: 'https://chat.deepseek.com/a/chat/s/protocol-test' };
  let pageInstance = 'page-before-refresh';
  let listener;
  let offline = false;
  const requests = [];
  const cancelledTasks = [];
  const chrome = {
    storage: { local: {
      async setAccessLevel(value) { assert.equal(value.accessLevel, 'TRUSTED_CONTEXTS'); },
      async get(keys) {
        if (keys === null) return copy(storage);
        const names = typeof keys === 'string' ? [keys] : keys;
        return copy(Object.fromEntries(names.filter(key => key in storage).map(key => [key, storage[key]])));
      },
      async set(value) { Object.assign(storage, copy(value)); },
    } },
    runtime: {
      id: extensionId,
      getURL: path => `chrome-extension://${extensionId}/${path}`,
      onMessage: { addListener(fn) { listener = fn; } },
    },
    tabs: {
      async get(id) { assert.equal(id, tab.id); return copy(tab); },
      async sendMessage(id, message) {
        assert.equal(id, tab.id);
        if (message.type === 'bridge/probe') return { instance: pageInstance };
        assert.equal(message.type, 'bridge/cancelLocal');
        cancelledTasks.push(message.task_id);
        return { cancelled: true };
      },
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
    },
  };
  const context = vm.createContext({
    chrome, crypto: webcrypto, URL, TextEncoder, TextDecoder, AbortController, AbortSignal,
    setTimeout, clearTimeout,
    async fetch(input, options) {
      const original = new URL(input);
      assert.equal(original.origin, 'http://127.0.0.1:32145', '禁止测试向外网发送请求');
      assert.ok(['/health', '/v1/tick', '/v1/resolve'].includes(original.pathname));
      if (original.pathname === '/v1/resolve') assert.ok(cancelledTasks.length, '解除服务端任务之前先确认页面取消');
      requests.push(original.pathname);
      if (offline) throw new TypeError('模拟本机桥暂时断线');
      const target = new URL(original.pathname, core.info().url);
      assert.equal(target.hostname, '127.0.0.1');
      return fetch(target, { ...options, headers: { ...options?.headers,
        Origin: `chrome-extension://${extensionId}` } });
    },
  });
  context.importScripts = (...files) => {
    for (const file of files) {
      assert.ok(['shared.js', 'adapters.js'].includes(file));
      vm.runInContext(readFileSync(join(extensionDir, file), 'utf8'), context, { filename: file });
    }
  };
  vm.runInContext(readFileSync(join(extensionDir, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  const send = (message, isUI = false) => new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => reject(new Error('扩展消息超时')), 3000);
    const sender = isUI
      ? { id: extensionId, url: chrome.runtime.getURL('options.html') }
      : { id: extensionId, frameId: 0, tab: copy(tab), url: tab.url };
    try {
      assert.equal(listener(message, sender, result => {
        clearTimeout(timer);
        resolveMessage(copy(result));
      }), true);
    } catch (error) { clearTimeout(timer); reject(error); }
  });
  const ui = message => send(message, true);
  const page = message => send({ instance: pageInstance, ...message });
  // 只读取本测试临时目录的随机令牌；不接触用户真实配置。
  assert.equal((await ui({ type: 'ui/settings', token: readFileSync(core.info().pairing_file, 'utf8').trim() })).ok, true);
  assert.equal((await ui({ type: 'ui/connect', tab_id: tab.id, agent: 'protocol-test' })).ok, true);
  assert.equal((await page({ type: 'tick' })).connected, true);
  assert.equal(core.info().agents[0].agent, 'protocol-test');
  const dispatch = request_id => core.dispatch({ agent: 'protocol-test', request_id, prompt: '只返回测试回答，不执行任何操作' });
  return { core, storage, requests, cancelledTasks, ui, page, dispatch,
    offline(value) { offline = value; }, refresh() { pageInstance = 'page-after-refresh'; },
    binding: () => copy(storage[`bridge_tab_${tab.id}`]),
  };
}

test('协议联调：真实后台消息领取、登记发送、回传回答并由 wait 读取', async t => {
  const f = await fixture(t);
  const task = f.dispatch('protocol-complete');
  const claimed = await f.page({ type: 'tick' });
  assert.equal(claimed.task.task_id, task.task_id);
  assert.equal(claimed.task.prompt, '只返回测试回答，不执行任何操作');
  const prepared = await f.page({ type: 'prepare', task_id: task.task_id });
  assert.deepEqual(prepared, { ok: true, allowed: true });
  assert.equal(f.binding().pending.submitAttempted, true);
  assert.equal(f.binding().pending.phase, 'attempting');
  assert.equal((await f.page({ type: 'authorize-click', task_id: task.task_id })).allowed, true);
  const sent = await f.page({ type: 'tick', report: { task_id: task.task_id, status: 'sent' } });
  assert.equal(sent.reportAck, task.task_id);
  assert.equal(f.core.status({ task_id: task.task_id }).status, 'sent');
  const complete = await f.page({ type: 'tick', report: {
    task_id: task.task_id, status: 'complete', text: '这是一条内存页面替身提供的测试回答。\n第二行完整保留。',
  } });
  assert.equal(complete.reportAck, task.task_id);
  const result = await f.core.wait({ task_id: task.task_id, timeout_ms: 0 });
  assert.equal(result.status, 'complete');
  assert.equal(result.text, '这是一条内存页面替身提供的测试回答。\n第二行完整保留。');
  assert.equal(readFileSync(result.result_file, 'utf8'), result.text);
  assert.equal(f.binding().pending, null);
  assert.equal((await f.page({ type: 'tick' })).task, undefined);
  assert.ok(f.requests.every(path => path === '/v1/tick'));
});

test('协议联调：发送后本机断线与页面刷新只转待核实，绝不重新领单', async t => {
  const f = await fixture(t);
  const task = f.dispatch('protocol-refresh');
  await f.page({ type: 'tick' });
  assert.equal((await f.page({ type: 'prepare', task_id: task.task_id })).allowed, true);
  assert.equal((await f.page({ type: 'authorize-click', task_id: task.task_id })).allowed, true);
  await f.page({ type: 'tick', report: { task_id: task.task_id, status: 'sent' } });
  f.offline(true);
  const disconnected = await f.page({ type: 'tick' });
  assert.ok(disconnected.networkError);
  assert.equal(disconnected.task, undefined);

  // 页面整页重载 → 内容脚本换新实例。
  // 契约：消息已发出，所以既不重发（task 必须为 undefined），也不直接判失败；
  // 后台改为提供“续接”入口，由新实例把答案读回来。
  f.refresh();
  const refreshed = await f.page({ type: 'tick' });
  assert.equal(refreshed.task, undefined, '绝不重新领取任务（不重发）');
  assert.equal(refreshed.resume?.task_id, task.task_id, '应提供续接入口');
  assert.equal(f.binding().pending.submitAttempted, true);
  // 提示词保留：续接要靠它核对“当前页面是不是本次提问的那个会话”。
  assert.equal(f.binding().pending.prompt, '只返回测试回答，不执行任何操作');

  // 新实例续接：拿得到任务文本用于核对会话，但拿不到任何发送许可
  const taken = await f.page({ type: 'resume-take', task_id: task.task_id });
  assert.equal(taken.ok, true);
  assert.equal(taken.task.task_id, task.task_id);
  assert.ok(taken.task.prompt, '续接需要任务文本以便核对当前会话');
  assert.equal(taken.allowed, undefined, '续接不授予任何发送许可');

  // 续接路径绝不能退化成重发：prepare / authorize-click 必须被拒
  assert.equal((await f.page({ type: 'prepare', task_id: task.task_id })).ok, false);
  assert.equal((await f.page({ type: 'authorize-click', task_id: task.task_id })).ok, false);

  // 续接结束后提示词必须保留：它是重载后核对“站在哪个会话”的唯一依据，
  // 也是自愈能力的前提。任务进入终态时才由 applyReport 清掉。
  const doneRes = await f.page({ type: 'resume-done', task_id: task.task_id });
  assert.equal(doneRes.ok, true);
  assert.equal(f.binding().pending.prompt, '只返回测试回答，不执行任何操作',
    '续接结束后保留提示词，否则下次重载就无法安全接管');
  // 提示词还在，所以还能再次续接
  assert.equal((await f.page({ type: 'resume-take', task_id: task.task_id })).ok, true);

  f.offline(false);
  const restored = await f.page({ type: 'tick' });
  // 报告早已送出，恢复连线后不应再重复投递，也不该领到新任务。
  assert.equal(restored.reportAck, null, '报告已送达过，不重复投递');
  assert.equal(restored.task, undefined, '绝不重新领单');
  assert.equal(restored.resume?.task_id, task.task_id, '任务仍等回答，续接入口应继续提供（新一轮重载还能接管）');
  assert.equal(f.core.status({ task_id: task.task_id }).status, 'sent');
  assert.throws(() => f.dispatch('blocked-duplicate'), /仍有任务/);
});

test('续接不得凭空造任务：没登记过发送尝试时拒绝', async t => {
  const f = await fixture(t);
  const task = f.dispatch('resume-guard');
  await f.page({ type: 'tick' }); // 领取但还没 prepare
  const taken = await f.page({ type: 'resume-take', task_id: task.task_id });
  assert.equal(taken.ok, false);
  assert.match(taken.error, /没有可续接的任务/);
  const bogus = await f.page({ type: 'resume-take', task_id: '不存在的任务号' });
  assert.equal(bogus.ok, false);
});

test('协议联调：用户解除已领取任务后，旧页面发送许可失效', async t => {
  const f = await fixture(t);
  const task = f.dispatch('protocol-resolve');
  assert.equal((await f.page({ type: 'tick' })).task.task_id, task.task_id);
  assert.equal((await f.page({ type: 'prepare', task_id: task.task_id })).allowed, true);
  const resolved = await f.ui({ type: 'ui/resolve', agent: 'protocol-test', confirmed: true });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.resolved, true);
  assert.deepEqual(f.cancelledTasks, [task.task_id]);
  const stale = await f.page({ type: 'prepare', task_id: task.task_id });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /发送许可失效/);
  assert.equal((await f.page({ type: 'authorize-click', task_id: task.task_id })).ok, false);
  assert.equal(f.core.status({ task_id: task.task_id }).status, 'error');
  assert.equal(f.binding().pending, null);
  assert.equal((await f.page({ type: 'tick' })).task, undefined);
});
