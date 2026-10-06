#!/usr/bin/env node
// 防泄漏扫描器：入库前检查有没有把不该公开的东西带进仓库。
//
// 设计要点：脚本本身是通用的，可以公开；
// 具体敏感词（项目名、目录名、研究主题）放在【本地私有】的
// `.leak-terms.local` 里，那个文件被 .gitignore 排除，永不入库。
// 这样公开扫描器的同时，不会把"你要藏什么"一起公开。
//
// 用法：
//   node leak-check.mjs              扫描工作区（未忽略的所有文件）
//   node leak-check.mjs --staged     只扫描已暂存内容（供 pre-commit 钩子用）
//   node leak-check.mjs --history    额外扫描提交历史里的作者与提交信息
//
// 退出码：0 = 干净；1 = 发现疑似泄漏。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// 仓库根 = tools/ 的上一级。所有 git 路径都相对它，不要用脚本所在目录当基准，
// 否则会扫到 0 个文件（实测踩过）。
const ROOT = resolve(here, '..');
const TERMS_FILE = join(ROOT, '.leak-terms.local');
const MODE_STAGED = process.argv.includes('--staged');
const MODE_HISTORY = process.argv.includes('--history');

// ---- 1) 通用凭据规则：与项目无关，任何仓库都该查 ----
const GENERIC = [
  { name: '疑似配对码/长十六进制密钥', re: /\b[0-9a-f]{32,}\b/i },
  { name: '疑似 API Key 赋值', re: /(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["'][^"'\s]{12,}["']/i },
  { name: '疑似私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: '疑似 Bearer 令牌字面量', re: /Bearer\s+[A-Za-z0-9._-]{20,}/ },
  { name: '疑似云厂商密钥', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: '疑似 GitHub 令牌', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: '疑似 OpenAI 风格密钥', re: /\bsk-[A-Za-z0-9]{20,}/ },
];

// ---- 2) 绝对路径里的本机信息：暴露目录结构与用户名 ----
const PATH_RULES = [
  { name: 'Windows 用户目录绝对路径', re: /[A-Za-z]:\\Users\\[^\\\s"']+/i },
  { name: '磁盘根下的绝对路径（可能含项目名）', re: /[A-Za-z]:\\(?!Users|Windows|Program)[^\\\s"']+\\/ },
];

// ---- 3) 本地私有敏感词：从被忽略的文件读，缺失就只跑通用规则 ----
function loadLocalTerms() {
  if (!existsSync(TERMS_FILE)) return [];
  return readFileSync(TERMS_FILE, 'utf8')
    .split(/\r?\n/)
    .map(line => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

// 允许清单：这些是仓库里正当出现的，不该报错
const ALLOW = [
  /127\.0\.0\.1/,
  /<你的用户名>/,
  /<本机插件目录>/,
  /<本机项目目录>/,
  /<本机项目根目录>/,
  /users\.noreply\.github\.com/,
];

// 代码行识别：源码里到处是反斜杠、正则和字符串，容易被规则误伤。
// 实测踩过：`/^chrome-extension:\/\/[a-p]{32}$/` 被“绝对路径”规则当成磁盘路径。
// 判断依据取“这行本身是不是代码”——路径规则提到代码行就跳过，
// 但凭据规则仍然检查（密钥可能就写在代码里）。
const CODE_HINT = /=>|function\s|new RegExp|\/\\\/|\\\/|\$\{|\.test\(|===|!==|assert\.|require\(|import\s|const\s|let\s|var\s|return\s/;

function linesOf(text) { return text.split(/\r?\n/); }

function scanText(label, text, terms) {
  const hits = [];
  const lines = linesOf(text);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (ALLOW.some(re => re.test(line))) continue;
    const looksLikeCode = CODE_HINT.test(line);
    for (const rule of GENERIC) {
      if (rule.re.test(line)) hits.push({ label, line: i + 1, rule: rule.name, sample: line.trim().slice(0, 110) });
    }
    if (!looksLikeCode) {
      for (const rule of PATH_RULES) {
        if (rule.re.test(line)) hits.push({ label, line: i + 1, rule: rule.name, sample: line.trim().slice(0, 110) });
      }
      for (const term of terms) {
        if (line.includes(term)) hits.push({ label, line: i + 1, rule: `本地敏感词「${term}」`, sample: line.trim().slice(0, 110) });
      }
    }
  }
  return hits;
}

// 取要扫描的文件与内容。git 命令一律在仓库根执行，路径基准才不会错。
function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

let items = [];
if (MODE_STAGED) {
  // 必须带 core.quotepath=false：否则中文文件名会被转义成 "\345\256\214..."，
  // 拿去 git show 会报 unknown revision，结果是这些文件【被静默跳过】。
  // 实测踩过这个坑——防泄漏工具漏扫比不扫更危险。
  const names = git(['-c', 'core.quotepath=false', 'diff', '--cached', '--name-only', '--diff-filter=ACMR'])
    .split('\n').filter(Boolean);
  const skipped = [];
  for (const name of names) {
    try { items.push({ label: name, text: git(['show', `:${name}`]) }); }
    catch { skipped.push(name); }
  }
  if (skipped.length) {
    console.log(`警告：以下暂存文件读不到内容，本次未扫描（需人工确认）：`);
    for (const s of skipped) console.log(`  - ${s}`);
  }
} else {
  const names = git(['-c', 'core.quotepath=false', 'ls-files']).split('\n').filter(Boolean);
  const untracked = git(['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard'])
    .split('\n').filter(Boolean);
  for (const name of [...new Set([...names, ...untracked])]) {
    const abs = resolve(ROOT, name);
    if (!existsSync(abs)) continue;
    try {
      const buf = readFileSync(abs);
      if (buf.includes(0)) continue;             // 二进制跳过
      items.push({ label: name, text: buf.toString('utf8') });
    } catch { /* 读不到就跳过 */ }
  }
}

const terms = loadLocalTerms();
console.log(`防泄漏扫描：${items.length} 个文件，通用规则 ${GENERIC.length + PATH_RULES.length} 条`
  + `，本地敏感词 ${terms.length} 个${terms.length ? '' : '（未提供 .leak-terms.local，仅跑通用规则）'}`);

let hits = [];
for (const it of items) hits = hits.concat(scanText(it.label, it.text, terms));

if (MODE_HISTORY) {
  try {
    const authors = git(['log', '--format=%an <%ae>']);
    for (const line of authors.split('\n').filter(Boolean)) {
      // 只看“真实邮箱域名”，不看用户名——用户名可能就是本机登录名，
      // 写在扫描器里会变成新的泄露源（本文件是要入库的）。
      if (/@(?:qq|163|126|gmail|outlook|hotmail|foxmail)\.com/i.test(line)) {
        hits.push({ label: '(git 历史)', line: 0, rule: '提交作者疑似真实邮箱', sample: line });
      }
    }
    const msgs = git(['log', '--format=%B']);
    for (const term of terms) {
      if (msgs.includes(term)) hits.push({ label: '(git 提交信息)', line: 0, rule: `提交信息含本地敏感词「${term}」`, sample: '' });
    }
  } catch { /* 没有历史，忽略 */ }
}

if (hits.length === 0) {
  console.log('结果：干净 ✓');
  process.exit(0);
}
console.log(`\n结果：发现 ${hits.length} 处疑似泄漏\n`);
const byRule = new Map();
for (const h of hits) byRule.set(h.rule, (byRule.get(h.rule) || 0) + 1);
for (const [rule, n] of [...byRule].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)} × ${rule}`);
console.log('\n前 20 条明细：');
for (const h of hits.slice(0, 20)) {
  console.log(`  ${h.label}${h.line ? ':' + h.line : ''}  [${h.rule}]`);
  if (h.sample) console.log(`      ${h.sample}`);
}
console.log('\n处理建议：改成占位符（如 <本机项目目录>），或把该文件加入 .gitignore。');
process.exit(1);
