import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createBridge } from '../bridge.js';

const PAGES = {
  chatgpt: 'https://chatgpt.com/c/relay-test',
  deepseek: 'https://chat.deepseek.com/a/chat/s/relay-test',
  gemini: 'https://gemini.google.com/app/relay-test',
};
const EXTENSION_ORIGIN = `chrome-extension://${'a'.repeat(32)}`;

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-web-chat-test-'));
  const instances = [];
  let bridge;
  let secret;

  t.after(async () => {
    for (const instance of instances.reverse()) await instance.close();
    // 只清理本测试刚创建的临时目录，先核对绝对路径与父目录。
    const target = resolve(dir);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('dsh-web-chat-test-'));
    await rm(target, { recursive: true, force: true });
  });

  async function start() {
    bridge = await createBridge({ port: 0, stateDir: dir, minIntervalMs: 0 });
    instances.push(bridge);
    secret = (await readFile(join(dir, 'pairing.txt'), 'utf8')).trim();
    return bridge;
  }

  async function post(path, body, { paired = true, wrongToken = false, origin = EXTENSION_ORIGIN } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (paired) headers.authorization = `Bearer ${wrongToken ? '0'.repeat(64) : secret}`;
    if (origin !== null) headers.origin = origin;
    const response = await fetch(`${bridge.info().url}${path}`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    return { code: response.status, body: await response.json() };
  }

  function client(agent, provider = 'chatgpt', clientId = 'browser-test', tabId = 1) {
    return { agent, provider, client_id: clientId, tab_id: tabId, url: PAGES[provider] };
  }

  async function tick(connection, report) {
    return post('/v1/tick', { ...connection, ...(report ? { report } : {}) });
  }

  async function register(connection) {
    const response = await tick(connection);
    assert.equal(response.code, 200);
    return response.body;
  }

  await start();
  return { dir, get bridge() { return bridge; }, post, client, tick, register, start,
    secretIsAbsent(value) { return !JSON.stringify(value).includes(secret); } };
}

function rejectsWithCode(action, code) {
  return assert.rejects(async () => action(), error => error.statusCode === code);
}

test('未配对、错误配对码及恶意网页来源均不能注册网页助手', async t => {
  const f = await fixture(t);
  const client = f.client('chatgpt');
  assert.equal((await f.post('/v1/tick', client, { paired: false })).code, 401);
  assert.equal((await f.post('/v1/tick', client, { wrongToken: true })).code, 401);
  assert.equal((await f.post('/v1/tick', client, { origin: 'https://evil.example' })).code, 403);
  assert.equal((await f.post('/v1/tick', client, { origin: 'chrome-extension://not-an-extension' })).code, 403);
  assert.deepEqual(f.bridge.info().agents, []);
  await f.register(client);
  assert.equal(f.bridge.info().agents.length, 1);
  assert.ok(f.secretIsAbsent(f.bridge.info()), '公开状态不得包含配对码');
});

test('派单编号去重、冲突拒绝、任务只交付一次，丢包后只提供 pending', async t => {
  const f = await fixture(t);
  const client = f.client('chatgpt-review');
  await f.register(client);
  const request = { agent: client.agent, prompt: '检查指定片段', request_id: 'request-1' };
  const task = f.bridge.dispatch(request);
  assert.equal(task.status, 'queued');
  const duplicate = f.bridge.dispatch(request);
  assert.equal(duplicate.task_id, task.task_id);
  assert.equal(duplicate.deduplicated, true);
  await rejectsWithCode(() => f.bridge.dispatch({ ...request, prompt: '不同问题' }), 409);
  await rejectsWithCode(() => f.bridge.dispatch({ ...request, agent: '另一个助手' }), 409);
  const first = await f.tick(client);
  assert.equal(first.code, 200);
  assert.deepEqual(first.body.task, { task_id: task.task_id, prompt: request.prompt });
  assert.equal(f.bridge.status({ task_id: task.task_id }).status, 'claimed');
  const repeated = await f.tick(client);
  assert.equal(repeated.body.task, null);
  assert.deepEqual(repeated.body.pending, { task_id: task.task_id, status: 'claimed' });
  assert.equal(JSON.stringify(repeated.body).includes(request.prompt), false);
  assert.equal(f.bridge.dispatch(request).task_id, task.task_id);
  assert.equal((await f.tick(client)).body.task, null);
  assert.equal(f.bridge.status().tasks.length, 1);
});

test('发送、生成、完成可取回回答；旧回执不倒退状态、不覆盖终态、不领取新任务', async t => {
  const f = await fixture(t);
  const client = f.client('deepseek', 'deepseek');
  await f.register(client);
  const task = f.bridge.dispatch({ agent: client.agent, prompt: '首问', request_id: 'first' });
  await f.tick(client);
  for (const report of [
    { status: 'sent' },
    { status: 'running', text: '正在生成' },
  ]) {
    const response = await f.tick(client, { task_id: task.task_id, ...report });
    assert.equal(response.code, 200);
    assert.deepEqual(response.body, { task: null, ack: task.task_id });
  }
  await f.tick(client, { task_id: task.task_id, status: 'sent', text: '旧内容' });
  assert.equal(f.bridge.status({ task_id: task.task_id }).status, 'running');
  assert.equal(f.bridge.status({ task_id: task.task_id }).text, '正在生成');
  await f.tick(client, { task_id: task.task_id, status: 'complete', text: '最终回答全文' });
  const final = await f.bridge.wait({ task_id: task.task_id, timeout_ms: 0, max_chars: 4 });
  assert.equal(final.status, 'complete');
  assert.equal(final.text, '最终回答');
  assert.equal(final.text_chars, 6);
  assert.equal(final.truncated, true);
  assert.equal('text' in f.bridge.status({ task_id: task.task_id, include_text: false }), false);
  const next = f.bridge.dispatch({ agent: client.agent, prompt: '追问', request_id: 'follow-up' });
  for (const stale of [
    { status: 'running', text: '旧的部分回答' },
    { status: 'complete', text: '迟到的不同回答' },
    { status: 'error', error: '迟到错误' },
  ]) {
    const response = await f.tick(client, { task_id: task.task_id, ...stale });
    assert.deepEqual(response.body, { task: null, ack: task.task_id });
    assert.equal(f.bridge.status({ task_id: next.task_id }).status, 'queued');
  }
  assert.equal(f.bridge.status({ task_id: task.task_id }).text, '最终回答全文');
  assert.equal(f.bridge.status({ task_id: task.task_id }).status, 'complete');
  assert.equal((await f.tick(client)).body.task.task_id, next.task_id);
});

test('同一网页助手互斥，不同提供方可独立派单和完成', async t => {
  const f = await fixture(t);
  const clients = [f.client('review-a', 'chatgpt', 'client-a', 1), f.client('review-b', 'gemini', 'client-a', 2)];
  await Promise.all(clients.map(client => f.register(client)));
  const tasks = clients.map((client, i) => f.bridge.dispatch({ agent: client.agent, prompt: `问题 ${i}`, request_id: `independent-${i}` }));
  await rejectsWithCode(() => f.bridge.dispatch({ agent: clients[0].agent, prompt: '重复占用', request_id: 'occupied' }), 409);
  const impostor = { ...clients[0], tab_id: 99 };
  assert.equal((await f.tick(impostor)).code, 409);
  const delivered = await Promise.all(clients.map(client => f.tick(client)));
  assert.deepEqual(delivered.map(response => response.body.task.task_id), tasks.map(task => task.task_id));
  await f.tick(clients[0], { task_id: tasks[0].task_id, status: 'complete', text: '甲完成' });
  assert.equal(f.bridge.status({ task_id: tasks[1].task_id }).status, 'claimed');
  await f.tick(clients[1], { task_id: tasks[1].task_id, status: 'complete', text: '乙完成' });
  assert.deepEqual(tasks.map(task => f.bridge.status({ task_id: task.task_id }).status), ['complete', 'complete']);
});

test('重启后 claimed、sent、running 均为 uncertain，原 queued 失败且不重发', async t => {
  const f = await fixture(t);
  const beforeStates = ['claimed', 'sent', 'running', 'queued'];
  const clients = beforeStates.map((state, i) => f.client(`restart-${state}`, 'chatgpt', 'restart-browser', i + 1));
  const tasks = [];
  for (const [i, client] of clients.entries()) {
    await f.register(client);
    const task = f.bridge.dispatch({ agent: client.agent, prompt: `重启检查 ${i}`, request_id: `restart-${i}` });
    tasks.push(task);
    if (beforeStates[i] !== 'queued') await f.tick(client);
    if (['sent', 'running'].includes(beforeStates[i])) await f.tick(client, { task_id: task.task_id, status: beforeStates[i] });
  }
  await f.bridge.close();
  await f.start();
  for (const [i, task] of tasks.entries()) {
    const expected = beforeStates[i] === 'queued' ? 'error' : 'uncertain';
    assert.equal(f.bridge.status({ task_id: task.task_id }).status, expected);
    const reconnect = await f.tick(clients[i]);
    assert.equal(reconnect.code, 200);
    assert.equal(reconnect.body.task, null);
    if (expected === 'uncertain') assert.deepEqual(reconnect.body.pending, { task_id: task.task_id, status: 'uncertain' });
  }
  // 重启后仍可接收原网页的最终结果，不再发送问题。
  const complete = await f.tick(clients[0], { task_id: tasks[0].task_id, status: 'complete', text: '网页已经完成' });
  assert.deepEqual(complete.body, { task: null, ack: tasks[0].task_id });
  assert.equal(f.bridge.status({ task_id: tasks[0].task_id }).text, '网页已经完成');
});

test('人工解除挂起只允许原浏览器，同浏览器解除后可重新绑定', async t => {
  const f = await fixture(t);
  const client = f.client('manual-unlock', 'deepseek', 'original-browser', 3);
  await f.register(client);
  const task = f.bridge.dispatch({ agent: client.agent, prompt: '需要人工核实', request_id: 'manual-task' });
  await f.tick(client);
  await f.tick(client, { task_id: task.task_id, status: 'uncertain', error: '发送回执丢失' });
  const rejected = await f.post('/v1/resolve', { agent: client.agent, client_id: 'different-browser' });
  assert.equal(rejected.code, 403);
  assert.equal(f.bridge.status({ task_id: task.task_id }).status, 'uncertain');
  const resolved = await f.post('/v1/resolve', { agent: client.agent, client_id: client.client_id });
  assert.deepEqual(resolved.body, { resolved: true, task_id: task.task_id });
  assert.equal(f.bridge.status({ task_id: task.task_id }).status, 'error');
  assert.equal(f.bridge.info().agents.some(agent => agent.agent === client.agent), false);
  const replacement = { ...client, tab_id: 4 };
  await f.register(replacement);
  assert.equal((await f.tick(replacement)).body.task, null);
  const fresh = f.bridge.dispatch({ agent: client.agent, prompt: '用户已核实后的新问题', request_id: 'new-after-unlock' });
  assert.notEqual(fresh.task_id, task.task_id);
});

test('回答上限 120000 字符，过长或空的完成回执不能变成成功', async t => {
  const f = await fixture(t);
  const client = f.client('length-check', 'gemini');
  await f.register(client);
  const task = f.bridge.dispatch({ agent: client.agent, prompt: '长度检查', request_id: 'length-task' });
  await f.tick(client);
  assert.equal((await f.tick(client, { task_id: task.task_id, status: 'complete', text: 'x'.repeat(120001) })).code, 400);
  assert.equal((await f.tick(client, { task_id: task.task_id, status: 'complete', text: '   ' })).code, 400);
  assert.equal(f.bridge.status({ task_id: task.task_id }).status, 'claimed');
  assert.equal((await f.tick(client, { task_id: task.task_id, status: 'complete', text: 'x'.repeat(120000) })).code, 200);
  const result = f.bridge.status({ task_id: task.task_id });
  assert.equal(result.text_chars, 120000);
  assert.equal(result.text.length, 12000);
  assert.equal(result.truncated, true);
  const saved = JSON.parse(await readFile(join(f.dir, 'tasks.json'), 'utf8'));
  assert.equal(saved.tasks[0].text.length, 120000);
});

test('未交付任务和错任务回执被拒绝，不会凭回执产生回答', async t => {
  const f = await fixture(t);
  const client = f.client('receipt-check');
  await f.register(client);
  const task = f.bridge.dispatch({ agent: client.agent, prompt: '检查回执', request_id: 'receipt-task' });
  assert.equal((await f.tick(client, { task_id: task.task_id, status: 'complete', text: '未经发送' })).code, 409);
  assert.equal(f.bridge.status({ task_id: task.task_id }).status, 'queued');
  assert.equal((await f.tick(client, { task_id: 'does-not-exist', status: 'sent' })).code, 409);
  assert.equal((await f.tick(client)).body.task.task_id, task.task_id);
});

test('取消等待立即退出但不终止、重发或改写已派任务', async t => {
  const f = await fixture(t);
  const client = f.client('cancel-wait');
  await f.register(client);
  const task = f.bridge.dispatch({ agent: client.agent, prompt: '等待取消检查', request_id: 'cancel-task' });
  await f.tick(client);
  const controller = new AbortController();
  const pending = f.bridge.wait({ task_id: task.task_id, timeout_ms: 45000 }, controller.signal);
  const rejection = assert.rejects(pending, error => error.name === 'AbortError');
  await delay(10);
  controller.abort();
  await rejection;
  assert.equal(f.bridge.status({ task_id: task.task_id }).status, 'claimed');
  const poll = await f.tick(client);
  assert.equal(poll.body.task, null);
  assert.equal(poll.body.pending.task_id, task.task_id);
  assert.equal((await f.bridge.wait({ task_id: task.task_id, timeout_ms: 0 })).status, 'claimed');
  assert.equal(f.bridge.status().tasks.length, 1);
});
