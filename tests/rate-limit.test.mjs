// 频率保护回归：网页版不是编程接口，节流必须真的生效。
// 只限“两次派单的最小间隔”，不设每日配额。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createBridge } from '../bridge.js';

const PAGE = 'https://chatgpt.com/c/rate-test';

async function fixture(t, options) {
  const dir = await mkdtemp(join(tmpdir(), 'web-chat-rate-'));
  const bridge = await createBridge({ port: 0, stateDir: dir, ...options });
  t.after(async () => {
    await bridge.close();
    const target = resolve(dir);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('web-chat-rate-'));
    await rm(target, { recursive: true, force: true });
  });
  const token = (await readFile(join(dir, 'pairing.txt'), 'utf8')).trim();
  const tick = body => fetch(`${bridge.info().url}/v1/tick`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }).then(r => r.json());
  await tick({ client_id: 'rate-browser', agent: 'rate-agent', provider: 'chatgpt', tab_id: 1, url: PAGE });
  return { bridge, tick };
}

// 让一条任务走到终态，好让下一条能通过“无进行中任务”检查
async function finish(tick, taskId) {
  await tick({ client_id: 'rate-browser', agent: 'rate-agent', provider: 'chatgpt', tab_id: 1, url: PAGE });
  await tick({ client_id: 'rate-browser', agent: 'rate-agent', provider: 'chatgpt', tab_id: 1, url: PAGE,
    report: { task_id: taskId, status: 'complete', text: '答案' } });
}

test('两次派单间隔不足时拒绝，且明确告知还要等多久', async t => {
  const { bridge, tick } = await fixture(t, { minIntervalMs: 60_000 });
  const first = bridge.dispatch({ agent: 'rate-agent', prompt: '第一条', request_id: 'rate-1' });
  assert.equal(first.task_count, 1);
  await finish(tick, first.task_id);

  // 前一条已终结，此刻唯一的拦截理由就是“间隔太短”。
  // 注意：dispatch 是同步函数，同步 throw 必须用 assert.throws —— 实测本机
  // Node 的 assert.rejects 接不住同步抛出的错误（会直接冒出来当未捕获异常）。
  assert.throws(
    () => bridge.dispatch({ agent: 'rate-agent', prompt: '第二条', request_id: 'rate-2' }),
    error => error.statusCode === 429 && /间隔太短/.test(error.message),
  );
  // 被拒的派单不得留下任务痕迹
  assert.equal(bridge.status().tasks.length, 1);
});

test('不设每日配额：连续多天量级的派单只要间隔够就不会被拦', async t => {
  const { bridge, tick } = await fixture(t, { minIntervalMs: 0 });
  for (let i = 0; i < 8; i += 1) {
    const task = bridge.dispatch({ agent: 'rate-agent', prompt: `第 ${i} 条`, request_id: `many-${i}` });
    assert.equal(task.status, 'queued');
    assert.equal(task.task_count, i + 1, 'task_count 应随累计条数递增');
    await finish(tick, task.task_id);
  }
  assert.equal(bridge.status().tasks.length, 8, '八条都应记录在案');
});

test('最小间隔为 0 时完全不限制', async t => {
  const { bridge, tick } = await fixture(t, { minIntervalMs: 0 });
  const a = bridge.dispatch({ agent: 'rate-agent', prompt: 'a', request_id: 'n1' });
  await finish(tick, a.task_id);
  const b = bridge.dispatch({ agent: 'rate-agent', prompt: 'b', request_id: 'n2' });
  assert.equal(b.status, 'queued');
});

test('间隔配置非法时直接报错，不静默取默认值', async () => {
  await assert.rejects(async () => createBridge({ port: 0, minIntervalMs: -1 }), /最小派单间隔无效/);
});
