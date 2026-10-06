// 端口解耦回归：扩展必须能跟随非默认端口的本机桥，而不是写死 32145。
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createBridge } from '../bridge.js';

const extensionDir = fileURLToPath(new URL('../extension/', import.meta.url));
const extensionId = 'a'.repeat(32);
const copy = value => structuredClone(value);

// 先探一个确实空闲的端口，避免测试之间互相抢端口
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// bridgePort: 0 = 随机端口；数字 = 固定端口
async function fixture(t, { bridgePort = 0 } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'web-chat-port-'));
  const core = await createBridge({ port: bridgePort, stateDir, minIntervalMs: 0 });
  const realPort = Number(new URL(core.info().url).port);
  t.after(async () => {
    await core.close();
    assert.equal(join(stateDir, '..').startsWith(tmpdir()) || stateDir.startsWith(tmpdir()), true);
    rmSync(stateDir, { recursive: true, force: true });
  });
  const storage = {};
  const tab = { id: 23, url: 'https://chatgpt.com/c/port-test' };
  const reached = [];
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
        if (message.type === 'bridge/probe') return { instance: 'page-port' };
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
      // 桥只能用回环地址；端口必须是真实桥端口，否则模拟连接失败
      assert.equal(target.hostname, '127.0.0.1', '禁止测试向外网发送请求');
      reached.push(Number(target.port));
      if (Number(target.port) !== realPort) throw new TypeError('模拟该端口没有服务');
      const res = await fetch(new URL(target.pathname, core.info().url),
        {...options, headers: {...options?.headers, Origin: `chrome-extension://${extensionId}`}});
      return new Response(await res.text(), {status: res.status, headers: res.headers});
    },
  });
  context.importScripts = (...files) => {
    for (const file of files) vm.runInContext(readFileSync(join(extensionDir, file), 'utf8'), context, {filename: file});
  };
  vm.runInContext(readFileSync(join(extensionDir, 'background.js'), 'utf8'), context, {filename: 'background.js'});
  // 后台的错误路径用 {ok:false, error} 应答（不 reject），所以这里统一转成抛出
  const send = message => new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => reject(new Error('扩展消息超时')), 5000);
    const isUI = (message.type || '').startsWith('ui/');
    const sender = isUI ? {id: extensionId, url: chrome.runtime.getURL('options.html')}
      : {id: extensionId, frameId: 0, tab: copy(tab), url: tab.url};
    let settled = false;
    const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolveMessage(copy(result)); } };
    try {
      listener(message, sender, finish);
    } catch (error) {
      if (!settled) { settled = true; clearTimeout(timer); reject(error); }
    }
  });
  const call = async message => {
    const reply = await send(message);
    if (!reply?.ok) throw new Error(reply?.error || '扩展后台未响应');
    return reply;
  };
  const page = message => call({instance: 'page-port', ...message});
  return {core, realPort, storage, reached, call, ui: call, page,
    config: () => copy(storage.bridge_config)};
}

test('配对码不回显，且扩展自身 CSP 允许回环任意端口', async t => {
  const f = await fixture(t);
  const state = await f.ui({type: 'ui/state'});
  assert.equal(state.paired, false);
  assert.equal(state.default_port, 32145, '默认端口应与 Harness 插件默认值一致');
  assert.equal(state.endpoint, 'http://127.0.0.1:32145');
  const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'));
  const csp = manifest.content_security_policy.extension_pages;
  assert.match(csp, /connect-src http:\/\/127\.0\.0\.1:\*/, 'CSP 不得写死单一端口');
  assert.ok(manifest.host_permissions.includes('http://127.0.0.1/*'));
  assert.equal(csp.includes('32145'), false, 'CSP 不应再出现 32145');
});

test('在线检查自动跟随非默认端口并记住，后续请求都用该端口', async t => {
  // 桥跑到候选端口 32146 上，模拟用户改了 Harness 插件端口
  const f = await fixture(t, { bridgePort: 32146 });
  assert.equal(f.realPort, 32146);
  // 用户只填了配对码，没填端口 → 检查时应自动发现
  await f.ui({type: 'ui/settings', token: readFileSync(f.core.info().pairing_file, 'utf8').trim()});
  const health = await f.ui({type: 'ui/health'});
  assert.equal(health.ok, true);
  assert.equal(health.port, 32146);
  assert.equal(health.followed, true, '应报告发生了自动跟随');
  assert.equal(f.config().bridge_port, 32146, '发现的端口必须存盘');
  // 跟随之后，正常派单心跳必须打到真实端口
  f.reached.length = 0;
  assert.equal((await f.ui({type: 'ui/connect', tab_id: 23, agent: 'port-test'})).ok, true);
  assert.equal((await f.page({type: 'tick'})).connected, true);
  assert.ok(f.reached.length > 0);
  assert.ok(f.reached.every(p => p === 32146), `所有请求都应打到 32146，实际 ${f.reached}`);
  // 跟随一次之后不再重复探测：候选表收敛为单一端口
  const again = await f.ui({type: 'ui/state'});
  assert.deepEqual(again.candidate_ports, [32146]);
  assert.equal(again.endpoint, 'http://127.0.0.1:32146');
});

test('保持默认端口时仍保留探测能力，插件换端口后能自动跟随', async t => {
  // 桥在候选端口 32147，扩展配置仍是默认的 32145
  const f = await fixture(t, { bridgePort: 32147 });
  const before = await f.ui({type: 'ui/state'});
  assert.equal(before.endpoint, 'http://127.0.0.1:32145', '未检查前按默认端口');
  assert.deepEqual(before.candidate_ports, [32145, 32146, 32147], '默认值不得收敛成单端口');
  const health = await f.ui({type: 'ui/health'});
  assert.equal(health.port, 32147);
  assert.equal(health.followed, true);
  assert.equal(f.config().bridge_port, 32147);
});

test('显式指定端口时只试该端口，不再猜其他候选', async t => {
  const f = await fixture(t);
  const idle = await freePort();
  await f.ui({type: 'ui/port', port: idle});
  f.reached.length = 0;
  await assert.rejects(() => f.ui({type: 'ui/health'}), /本机桥未就绪/);
  assert.deepEqual([...new Set(f.reached)], [idle], '不得再去试 32145/32146/32147');
});

test('端口参数校验拒绝越界和非整数', async t => {
  const f = await fixture(t);
  for (const bad of [0, 80, 65536, 1.5, '32145', null]) {
    await assert.rejects(() => f.ui({type: 'ui/port', port: bad}), /1024～65535/);
  }
  assert.equal(f.config().bridge_port, 32145, '被拒绝的参数不得改写已存端口');
});

test('桥在非默认端口时，心跳仍能完成整条派单-回执-取回链路', async t => {
  // 必须跑在候选端口上；随机端口无法被探测到，也就测不到这条路径
  const f = await fixture(t, { bridgePort: 32146 });
  assert.equal(f.realPort, 32146);
  await f.ui({type: 'ui/settings', token: readFileSync(f.core.info().pairing_file, 'utf8').trim()});
  await f.ui({type: 'ui/health'});
  await f.ui({type: 'ui/connect', tab_id: 23, agent: 'port-e2e'});
  await f.page({type: 'tick'});
  const task = f.core.dispatch({agent: 'port-e2e', request_id: 'port-e2e-1', prompt: '端口链路检查'});
  const claimed = await f.page({type: 'tick'});
  assert.equal(claimed.task.task_id, task.task_id);
  assert.equal((await f.page({type: 'prepare', task_id: task.task_id})).allowed, true);
  assert.equal((await f.page({type: 'authorize-click', task_id: task.task_id})).allowed, true);
  await f.page({type: 'tick', report: {task_id: task.task_id, status: 'sent'}});
  const done = await f.page({type: 'tick', report: {task_id: task.task_id, status: 'complete', text: '非默认端口下取回的回答'}});
  assert.equal(done.reportAck, task.task_id);
  const result = await f.core.wait({task_id: task.task_id, timeout_ms: 0});
  assert.equal(result.status, 'complete');
  assert.equal(result.text, '非默认端口下取回的回答');
});
