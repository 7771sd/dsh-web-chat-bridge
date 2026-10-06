// 浏览器保活：让“调用时自动可用”，而不是每次让用户去点。
//
// 为什么需要它：桥接靠一个真实浏览器里的扩展干活。浏览器一旦被关掉，
// 调试端口就没了，扩展也没了，派单必然失败。这里在派单前把这一整套补齐。
//
// 关键约束：
// - 只启动【专用 profile】的 Edge，不碰用户日常浏览器（--user-data-dir 隔离）。
// - 调试端口只监听回环地址，仅本机可用。
// - 只做“打开页面/装扩展/连接”这类准备动作，绝不代替调用方发送任何消息。
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_DEBUG_PORT = 9222;
const EXT_ID = 'ibfhbckmkkjgokobcjlpiidjelgdmgdb';
const DEFAULT_PROFILE = 'C:\\dsh-web-chat-profile';
const DEFAULT_EXT_DIR = 'C:\\dsh-web-chat-bridge\\extension';
const DEFAULT_LAUNCHER = 'C:\\dsh-web-chat-bridge\\launch-chat-browser.cmd';
const CHAT_HOST = 'chatgpt.com';

function run(file, args) {
  return new Promise(resolve => {
    execFile(file, args, { windowsHide: true, timeout: 20000 }, error => resolve(!error));
  });
}

// 极简 CDP 客户端：只用到 Runtime.evaluate 和 Extensions.loadUnpacked
function connect(url) {
  return new Promise((resolve, reject) => {
    let seq = 0;
    const pending = new Map();
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('CDP 连接超时')); }, 10000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve({
        send(method, params = {}, ms = 20000) {
          const id = ++seq;
          return new Promise((res, rej) => {
            const t = setTimeout(() => { pending.delete(id); rej(new Error(method + ' 超时')); }, ms);
            pending.set(id, { res, rej, t });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() { try { ws.close(); } catch {} },
      });
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')); });
    ws.addEventListener('message', event => {
      const msg = JSON.parse(event.data);
      if (!msg.id || !pending.has(msg.id)) return;
      const { res, rej, t } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(t);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    });
  });
}

export function createBrowserKeeper({
  debugPort = DEFAULT_DEBUG_PORT,
  profileDir = DEFAULT_PROFILE,
  extensionDir = DEFAULT_EXT_DIR,
  launcher = DEFAULT_LAUNCHER,
  agent = 'chatgpt',
} = {}) {
  const base = `http://127.0.0.1:${debugPort}`;
  // 每次检查都记下来，方便状态查询告诉用户“上次卡在哪一步”
  let lastReport = { at: null, ok: null, stage: null, detail: '尚未检查' };
  // 按需维修用的缓存。原来每次派单都固定跑十几秒的准备（重装扩展、探脚本、
  // 开菜单拖思考强度），而绝大多数时候环境本来就是好的。改成：验过一次就信一段时间，
  // 只在超时或出过事之后才重新完整检查。
  let lastReadyAt = 0;
  let lastThinkingAt = 0;
  let lastThinkingTab = null;
  const READY_TTL_MS = 30_000;          // 环境验过后 30 秒内直接信
  const THINKING_TTL_MS = 10 * 60_000;  // 思考强度 10 分钟内不重复查

  const note = (ok, stage, detail) => {
    lastReport = { at: new Date().toISOString(), ok, stage, detail };
    if (ok && stage === 'ready') lastReadyAt = Date.now();
    return lastReport;
  };
  // 供外部在派单失败时强制下一次做完整检查
  const invalidate = () => { lastReadyAt = 0; lastThinkingAt = 0; };

  async function portAlive() {
    try {
      const r = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(2500) });
      return r.ok;
    } catch { return false; }
  }

  async function targets() {
    try {
      const r = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(4000) });
      return await r.json();
    } catch { return []; }
  }

  // 启动专用浏览器。launcher 是一个 .cmd，用 cmd /c 调用；
  // 它内部用 start 分离进程，所以这里不会挂着等浏览器退出。
  async function launch() {
    const started = await run('cmd.exe', ['/c', launcher]);
    if (!started) return false;
    for (let i = 0; i < 30; i += 1) {          // 最多等 30 秒
      await delay(1000);
      if (await portAlive()) return true;
    }
    return false;
  }

  // 把扩展挂进浏览器。--load-extension 已经在启动参数里，这里只是兜底补一次，
  // 覆盖“浏览器本来就开着、但扩展没起来”的情况。
  async function loadExtension() {
    const version = await (await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(4000) })).json();
    const br = await connect(version.webSocketDebuggerUrl);
    try {
      const r = await br.send('Extensions.loadUnpacked', { path: extensionDir });
      return !!(r && r.id);
    } finally { br.close(); }
  }

  // 从扩展自己的 chrome.tabs 里取 ChatGPT 标签页 id。
  // 注意：必须用扩展认的 id，CDP 的 target id 是另一套编号，混用会得到
  // "SyntaxError: Invalid or unexpected token" 这种指错方向的报错（实测踩过）。
  async function chatTab(tabIdHint) {
    const all = await targets();
    const opt = all.find(t => t.type === 'page' && (t.url || '').includes(EXT_ID));
    if (!opt) {
      const version = await (await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(4000) })).json();
      const br = await connect(version.webSocketDebuggerUrl);
      try { await br.send('Target.createTarget', { url: `chrome-extension://${EXT_ID}/options.html` }); }
      finally { br.close(); }
      await delay(3000);
      return chatTab(tabIdHint);
    }
    const oc = await connect(opt.webSocketDebuggerUrl);
    try {
      const list = await oc.send('Runtime.evaluate', {
        expression: `(async () => {
          const all = await chrome.tabs.query({});
          const hit = all.filter(t => (t.url || '').includes(${JSON.stringify(CHAT_HOST)}))
            .map(t => ({ id: t.id, url: t.url, status: t.status }));
          return JSON.stringify(hit);
        })()`,
        returnByValue: true, awaitPromise: true,
      });
      const tabs = JSON.parse(list.result?.value || '[]');
      return { optionsTarget: opt, oc, tabs };
    } catch (error) {
      oc.close();
      throw error;
    }
  }

  // 通过 CDP 刷新指定 URL 的那个页面，让扩展重新注入内容脚本。
  // CDP 的 target id 与扩展的 tabs id 不是同一套编号，所以按 URL 匹配。
  async function reloadPage(url) {
    if (!url) return false;
    const version = await (await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(4000) })).json();
    const br = await connect(version.webSocketDebuggerUrl);
    try {
      const all = await targets();
      const pages = all.filter(t => t.type === 'page' && /^https?:/.test(t.url || ''));
      const want = url.split('#')[0];
      const hit = pages.find(t => (t.url || '').split('#')[0] === want);
      if (!hit) return false;
      const pc = await connect(hit.webSocketDebuggerUrl);
      try {
        await pc.send('Page.enable');
        await pc.send('Page.reload');
      } finally { pc.close(); }
      return true;
    } catch { return false; } finally { br.close(); }
  }

  // 轻量快检：只问一句“还活着吗”，不重装扩展、不探脚本、不碰思考强度。
  // 常态下派单走这条路，几毫秒就过。
  async function quickOk() {
    if (Date.now() - lastReadyAt > READY_TTL_MS) return false;
    const t = await targets();
    const ok = t.some(x => x.type === 'service_worker' && (x.url || '').includes(EXT_ID)) &&
      t.some(x => x.type === 'page' && (x.url || '').includes(CHAT_HOST));
    if (!ok) lastReadyAt = 0;   // 环境变了，下次走完整检查
    return ok;
  }

  // 确认浏览器可用且 ChatGPT 已连接；必要时逐级补齐。
  // 返回 { ok, stage, detail, agent }；不抛异常，让调用方决定怎么处理。
  //
  // force=true 时跳过缓存做完整检查（派单失败后重试、或用户主动要求排查时用）。
  async function ensure({ force = false } = {}) {
    if (!force && await quickOk()) {
      return note(true, 'ready', `${lastReport.detail || '环境正常'}（快检通过，未重做完整检查）`);
    }
    if (!(await portAlive())) {
      const ok = await launch();
      if (!ok) return note(false, 'launch', `调试端口 ${debugPort} 起不来；请手动运行「DSH 网页桥接」快捷方式`);
    }
    // 装扩展（幂等）
    let extOk = false;
    try { extOk = await loadExtension(); } catch { extOk = false; }
    if (!extOk) {
      const workers = (await targets()).filter(t => t.type === 'service_worker' && (t.url || '').includes(EXT_ID));
      if (!workers.length) return note(false, 'extension', '桥接扩展没起来；确认扩展目录存在且未被浏览器禁用');
    }
    await delay(2500);

    let ctxTab;
    try { ctxTab = await chatTab(); } catch (error) {
      return note(false, 'inspecting', '读不到扩展标签页：' + String(error.message).slice(0, 80));
    }
    const { oc, tabs } = ctxTab;
    try {
      if (!tabs.length) {
        // 没有 ChatGPT 标签页：新开一个并对齐会话（复用最近一条，避免开新对话）
        const created = await oc.send('Runtime.evaluate', {
          expression: `(async () => {
            const t = await chrome.tabs.create({ url: 'https://${CHAT_HOST}/' });
            return String(t.id);
          })()`,
          returnByValue: true, awaitPromise: true,
        });
        return note(true, 'opened-tab', '已新开 ChatGPT 标签页（id=' + created.result?.value + '），稍后自动连接');
      }
      const tabId = tabs[0].id;
      const tabUrl = tabs[0].url || '';
      const probeOnce = () => oc.send('Runtime.evaluate', {
        expression: `(async () => {
          try {
            const r = await chrome.tabs.sendMessage(${tabId}, { type: 'bridge/probe' });
            return r && r.instance ? 'ready' : 'no-instance';
          } catch (e) { return 'no-script'; }
        })()`,
        returnByValue: true, awaitPromise: true,
      });
      let probe = await probeOnce();
      if (probe.result?.value === 'no-script') {
        // 扩展被重载后，已打开的页面里旧的内容脚本会失效，必须重新注入。
        // 这一步原来是让用户手点刷新，现在自动做掉。
        const reloaded = await reloadPage(tabUrl);
        if (reloaded) {
          for (let i = 0; i < 8; i += 1) {      // 最多等 16 秒
            await delay(2000);
            probe = await probeOnce();
            if (probe.result?.value !== 'no-script') break;
          }
        }
        if (probe.result?.value === 'no-script') {
          return note(false, 'content-script', `标签页 ${tabId} 里的桥接脚本注入失败；请手动刷新该标签页一次`);
        }
      }
      // 注册别名（幂等）
      await oc.send('Runtime.evaluate', {
        expression: `(async () => {
          try { return JSON.stringify(await chrome.runtime.sendMessage({ type: 'ui/connect', tab_id: ${tabId}, agent: ${JSON.stringify(agent)} })); }
          catch (e) { return 'ERR ' + e.message; }
        })()`,
        returnByValue: true, awaitPromise: true,
      });
      const state = await oc.send('Runtime.evaluate', {
        expression: `(async () => {
          const s = await chrome.runtime.sendMessage({ type: 'ui/state' });
          return JSON.stringify(s.bindings.filter(b => b.agent === ${JSON.stringify(agent)})
            .map(b => ({ connected: b.connected, paused: b.paused, msg: b.message })));
        })()`,
        returnByValue: true, awaitPromise: true,
      });
      const bindings = JSON.parse(state.result?.value || '[]');
      if (!bindings.length) return note(false, 'connect', '连接后仍看不到绑定，请检查扩展是否被浏览器禁用');

      // 思考强度：网页版默认可能停在低档（实测遇到“中”＝1/4），
      // 低档时它给的是快速反应式回答，对研究工作基本没用。这里顺手拉满。
      // 但它要开菜单、拖滑块，是这几步里最贵的（约 4 秒），
      // 所以带缓存：同一个标签页 10 分钟内不重复查。
      const tabKey = `${tabs[0].id}:${tabUrl}`;
      let thinking;
      if (!force && lastThinkingTab === tabKey && Date.now() - lastThinkingAt < THINKING_TTL_MS) {
        thinking = { ok: true, detail: '沿用上次结果（未重复检查）' };
      } else {
        thinking = await ensureThinkingMax();
        if (thinking.ok) { lastThinkingAt = Date.now(); lastThinkingTab = tabKey; }
      }
      const base = `已连接：${bindings.map(b => b.msg).join('；')}`;
      if (!thinking.ok) {
        // 拉不满不算致命：仍然可以派单，只是回答质量可能差。如实报出来。
        return note(true, 'ready', `${base}｜思考强度未确认：${thinking.detail}`);
      }
      return note(true, 'ready', `${base}｜思考强度 ${thinking.detail}`);
    } finally { oc.close(); }
  }

  // 把 ChatGPT 的思考强度拉到最高档。
  //
  // 实测结构：输入框右侧 aria-label="选择 ChatGPT 模型" 的按钮，文本就是当前档位
  // （即时／中／6 Pro…）。点开后弹层里有一个 5 档滑块（aria-valuemin=0、max=4）。
  //
  // 两个必须绕开的坑：
  //  1) 同一个 aria-label 在 DOM 里有 4 个元素，3 个是隐藏残骸 → 取元素必须先过滤可见性
  //  2) 合成 PointerEvent 的 isTrusted=false，React 处理器直接忽略 → 必须用 CDP 的
  //     Input.dispatchMouseEvent 派发真实鼠标事件，且要分步移动加延迟
  async function ensureThinkingMax() {
    const version = await (await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(4000) })).json();
    const br = await connect(version.webSocketDebuggerUrl);
    try {
      const pg = (await targets()).find(t => t.type === 'page' && (t.url || '').includes(CHAT_HOST));
      if (!pg) return { ok: false, detail: '找不到 ChatGPT 标签页' };
      const pc = await connect(pg.webSocketDebuggerUrl);
      try {
        await pc.send('Page.enable').catch(() => {});
        const ev = async expression => {
          const r = await pc.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
          return r.exceptionDetails ? null : r.result?.value;
        };
        const VIS = `const vis = el => { const b = el.getClientRects(); return b.length > 0 && getComputedStyle(el).display !== 'none'; };`;
        const BTN = `[...document.querySelectorAll('button')].filter(vis).find(b => (b.getAttribute('aria-label') || '') === '选择 ChatGPT 模型')`;
        const geom = async () => {
          const raw = await ev(`(() => { ${VIS}
            const sl = [...document.querySelectorAll('[role="slider"]')].filter(vis)[0];
            if (!sl) return null;
            const track = sl.closest('[class*="Container"], [class*="Root"]') || sl.parentElement;
            const r = (track || sl).getBoundingClientRect();
            const t = sl.getBoundingClientRect();
            return JSON.stringify({ value: Number(sl.getAttribute('aria-valuenow')), max: Number(sl.getAttribute('aria-valuemax')),
              tx: r.left, ty: r.top, tw: r.width, th: r.height, hx: t.left, hy: t.top, hw: t.width, hh: t.height });
          })()`);
          return raw ? JSON.parse(raw) : null;
        };
        const clickModelButton = () => ev(`(() => { ${VIS} const b = ${BTN}; if (b) b.click(); return !!b; })()`);

        // 页面刚切换或正在重渲染时，按钮与滑块会短暂不存在（实测碰过）。
        // 重试几轮再判定，避免把瞬时状态当成“不支持”。
        let g = null;
        let lastLabel = null;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          await clickModelButton();
          await delay(2200);
          g = await geom();
          lastLabel = await ev(`(() => { ${VIS} const b = ${BTN}; return b ? (b.innerText || '').trim() : null; })()`);
          if (g) break;
        }
        if (!g) {
          await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
          return { ok: false, detail: '页面上没有强度滑块（重试 4 次仍未出现，可能不在带输入框的页面）' };
        }
        if (g.value >= g.max) {
          await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
          return { ok: true, detail: `已是最高档（${g.value}/${g.max}，档位「${lastLabel || '未知'}」）` };
        }

        // 用真实鼠标事件拖动（合成事件会被忽略）
        const y = g.ty + g.th / 2;
        const fromX = g.hx + g.hw / 2;
        const toX = g.tx + g.tw - 3;
        await pc.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX, y, button: 'none', buttons: 0 });
        await pc.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y, button: 'left', buttons: 1, clickCount: 1 });
        for (let i = 1; i <= 14; i += 1) {
          await pc.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved', x: fromX + (toX - fromX) * (i / 14), y, button: 'left', buttons: 1,
          });
          await delay(35);
        }
        await pc.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y, button: 'left', buttons: 0, clickCount: 1 });
        await delay(900);
        const after = await geom();
        const label = await ev(`(() => { ${VIS} const b = ${BTN}; return b ? (b.innerText || '').trim() : null; })()`);
        await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
        if (after && after.value >= after.max) {
          return { ok: true, detail: `已拉满 ${after.value}/${after.max}（当前档位「${label || '未知'}」）` };
        }
        return { ok: false, detail: `拖到 ${after ? after.value : '?'}/${after ? after.max : '?'}，未到最高档` };
      } finally { pc.close(); }
    } catch (error) {
      return { ok: false, detail: String(error.message || error).slice(0, 80) };
    } finally { br.close(); }
  }

  return { ensure, ensureThinkingMax, invalidate, quickOk, portAlive, report: () => lastReport, debugPort };
}
