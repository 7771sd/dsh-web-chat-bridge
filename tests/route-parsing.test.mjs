// 路由解析回归：覆盖实测撞到的“临时会话地址”漏配，防止再退化。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const extensionDir = fileURLToPath(new URL('../extension/', import.meta.url));
const context = vm.createContext({ URL, console });
vm.runInContext(readFileSync(`${extensionDir}shared.js`, 'utf8'), context, { filename: 'shared.js' });
const S = context.BridgeShared;

test('三站的正常会话地址都能解析出 id', () => {
  assert.equal(S.route('https://chatgpt.com/').key, 'chatgpt:new');
  assert.equal(S.route('https://chatgpt.com/').id, null);
  assert.equal(S.route('https://chatgpt.com/c/6ac3da72-650c-83ee-85e1-f7e41fe7e8a8').id,
    '6ac3da72-650c-83ee-85e1-f7e41fe7e8a8');
  assert.equal(S.route('https://chat.deepseek.com/a/chat/s/6c483092-b3b6-4d6f-b709-2bd93a01ca76').id,
    '6c483092-b3b6-4d6f-b709-2bd93a01ca76');
  assert.equal(S.route('https://gemini.google.com/app/abcdef123').id, 'abcdef123');
});

test('ChatGPT 新会话的临时地址必须被接受（实测踩过的坑）', () => {
  // ChatGPT 发出首条消息后会先跳到这里，%3A 是编码后的冒号。
  // 旧实现只允许 [A-Za-z0-9_-]，遇到 % 直接返回 null，于是刚发消息就被
  // 判成“聊天页面已改变”而中止整个任务。
  const url = 'https://chatgpt.com/c/local-chatgpt%3Ac2f2b126-28c8-432e-b777-2564f0ff3b1b';
  const r = S.route(url);
  assert.ok(r, '临时会话地址必须能解析，不能被判为非法');
  assert.equal(r.provider, 'chatgpt');
  assert.equal(r.id, 'local-chatgpt%3Ac2f2b126-28c8-432e-b777-2564f0ff3b1b');
  assert.equal(r.key, 'chatgpt:local-chatgpt%3Ac2f2b126-28c8-432e-b777-2564f0ff3b1b');
});

test('首页首条消息跳到新会话时允许接纳一次', () => {
  const binding = {
    provider: 'chatgpt',
    route: { id: null, key: 'chatgpt:new', provider: 'chatgpt', url: 'https://chatgpt.com/' },
    pending: { submitAttempted: true, adoptedConversation: false, phase: 'attempting' },
  };
  const first = S.navigation(binding, 'https://chatgpt.com/c/local-chatgpt%3Aabc');
  assert.equal(first.ok, true, '临时会话地址应被接纳');
  assert.equal(first.adopt, true, '应标记为接纳');

  // 临时地址再换成正式会话地址：仍属同一次接纳，不能拒绝
  // （navigation 是纯函数，不改 binding；调用方自己写回 route）
  binding.route = first.next;
  binding.pending.adoptedConversation = true;
  const second = S.navigation(binding, 'https://chatgpt.com/c/6ac3db87-7930-83ec-8b00-1234567890ab');
  assert.equal(second.ok, true, '临时地址换成正式会话地址也要接纳');

  // 两个正式会话 id 之间切换才是真的换了会话，必须拒绝
  binding.route = S.route('https://chatgpt.com/c/6ac3db87-7930-83ec-8b00-1234567890ab');
  assert.equal(temporaryId(binding.route.id), false, '正式会话 id 不应被判为临时');
  const third = S.navigation(binding, 'https://chatgpt.com/c/ffffffff-1111-2222-3333-444444444444');
  assert.equal(third.ok, false, '两个正式会话之间切换必须拒绝');
});

// 与 shared.js 内部同名逻辑保持一致（仅在测试里复刻，用于断言分类正确）
function temporaryId(id) {
  return !!id && (id.includes("%") || /^local[-_]/i.test(id));
}

test('临时会话 id 的识别规则', () => {
  assert.equal(temporaryId('local-chatgpt%3Ac2f2b126-28c8-432e-b777-2564f0ff3b1b'), true,
    '实测形状 local-chatgpt%3A<uuid> 必须判为临时');
  assert.equal(temporaryId('6ac3da72-650c-83ee-85e1-f7e41fe7e8a8'), false, '正式 uuid 不是临时');
  assert.equal(temporaryId(null), false, '无 id 不算临时（另有分支处理）');
});

test('未发送任务时换址必须拒绝', () => {
  const binding = {
    provider: 'chatgpt',
    route: { id: null, key: 'chatgpt:new', provider: 'chatgpt', url: 'https://chatgpt.com/' },
    pending: { submitAttempted: false, adoptedConversation: false, phase: 'delivered' },
  };
  assert.equal(S.navigation(binding, 'https://chatgpt.com/c/somewhere').ok, false,
    '还没点发送就换页，必须拒绝而不是盲目跟随');
});

test('分享页、登录页、跨站与非 https 一律拒绝', () => {
  for (const bad of [
    'https://chatgpt.com/share/abc',
    'https://chat.deepseek.com/sign_in',
    'http://chatgpt.com/',
    'https://evil.example/c/abc',
    'https://chatgpt.com:8443/c/abc',
  ]) {
    assert.equal(S.route(bad), null, `应拒绝: ${bad}`);
  }
});

test('provider 不匹配时不接纳', () => {
  const binding = {
    provider: 'deepseek',
    route: { id: null, key: 'deepseek:new', provider: 'deepseek', url: 'https://chat.deepseek.com/' },
    pending: { submitAttempted: true, adoptedConversation: false, phase: 'sent' },
  };
  assert.equal(S.navigation(binding, 'https://chatgpt.com/c/abc').ok, false);
});
