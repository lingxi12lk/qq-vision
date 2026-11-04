// qq-vision 冒烟测试：不联网、不碰桥接，只验证纯函数与模块结构。
//
// 跑法：
//   node test/smoke.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0;
let fail = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    fail += 1;
    failures.push({ label, error });
    console.log(`  ✗ ${label}：${error?.message ?? error}`);
  }
}

console.log('qq-vision 冒烟测试\n');

// ── 文件结构 ──────────────────────────────────────────────
console.log('[文件结构]');
check('package.json 存在且是合法 JSON', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-qq-vision');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, './lib/index.js');
});
check('cordis.patch.yml 存在', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'cordis.patch.yml')));
});
check('lib/vision.js 存在', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'lib', 'vision.js')));
});
check('lib/mcp-server.js 存在', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'lib', 'mcp-server.js')));
});
check('lib/ocr.ps1 存在且带 UTF-8 BOM', () => {
  const p = path.join(ROOT, 'lib', 'ocr.ps1');
  assert.ok(fs.existsSync(p), 'ocr.ps1 缺失');
  const buf = fs.readFileSync(p);
  assert.deepEqual([buf[0], buf[1], buf[2]], [0xef, 0xbb, 0xbf], 'BOM 缺失：PS 5.1 会按 GBK 解码中文而语法报错');
});

// ── 模块导出 ──────────────────────────────────────────────
console.log('\n[模块导出]');
const vision = await import('../lib/vision.js');
check('vision.js 导出 resolveRuntime', () => {
  assert.equal(typeof vision.resolveRuntime, 'function');
});
check('vision.js 导出 describeImage / describeMessage', () => {
  assert.equal(typeof vision.describeImage, 'function');
  assert.equal(typeof vision.describeMessage, 'function');
});
check('vision.js 导出 fetchMessageImages', () => {
  assert.equal(typeof vision.fetchMessageImages, 'function');
});
check('vision.js 零第三方依赖（只 import node: 内置与本地文件）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'vision.js'), 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
  for (const spec of imports) {
    // 允许两种：node: 内置模块；./ 或 ../ 开头的本仓库文件（如 ./selftest-fixture.js）。
    // 裸包名（zod、undici 之类）一律不允许 —— 那样插件就不再是"拷过去就能跑"。
    const isBuiltin = spec.startsWith('node:');
    const isLocal = spec.startsWith('./') || spec.startsWith('../');
    assert.ok(isBuiltin || isLocal, `发现非内置依赖：${spec}`);
  }
});

const plugin = await import('../lib/index.js');
check('index.js 导出 name = dsh-qq-vision', () => {
  assert.equal(plugin.name, 'dsh-qq-vision');
});
check('index.js 导出 inject 含 tools 与 webServer', () => {
  assert.deepEqual(plugin.inject, ['tools', 'webServer']);
});
check('index.js 导出 apply 函数', () => {
  assert.equal(typeof plugin.apply, 'function');
});

// ── 纯函数 ────────────────────────────────────────────────
console.log('\n[纯函数]');
check('mask 短串打码', () => {
  assert.equal(vision.mask('abc'), 'ab***');
  assert.equal(vision.mask(''), '');
});
check('mask 长串留前 6 后 4', () => {
  const out = vision.mask('sk-ws-H.abcdefghijklmnopqrstuvwxyz1234');
  assert.ok(out.startsWith('sk-ws-'));
  assert.ok(out.endsWith('1234'));
  assert.ok(out.includes('…'));
});
check('sniffMime 认 PNG', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.equal(vision.sniffMime(png), 'image/png');
});
check('sniffMime 认 JPEG', () => {
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(vision.sniffMime(jpg), 'image/jpeg');
});
check('sniffMime 认 GIF', () => {
  // 注意长度必须 >= 12：sniffMime 对短于 12 字节的缓冲一律返回 null（避免越界读）。
  const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
  assert.equal(vision.sniffMime(gif), 'image/gif');
});
check('sniffMime 认 WebP', () => {
  const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  assert.equal(vision.sniffMime(webp), 'image/webp');
});
check('sniffMime 未知返回 null', () => {
  assert.equal(vision.sniffMime(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), null);
  assert.equal(vision.sniffMime(null), null);
});
check('extOfMime 映射正确', () => {
  assert.equal(vision.extOfMime('image/png'), '.png');
  assert.equal(vision.extOfMime('image/jpeg'), '.jpg');
  assert.equal(vision.extOfMime('image/gif'), '.gif');
  assert.equal(vision.extOfMime('image/webp'), '.webp');
  assert.equal(vision.extOfMime('image/unknown'), '.bin');
});
check('isBridgeRoot 对不存在目录返回 false', () => {
  assert.equal(vision.isBridgeRoot('E:\\__not_a_bridge__'), false);
});
check('readRuntimeOverride 对缺失文件返回空对象', () => {
  const out = vision.readRuntimeOverride(path.join(ROOT, '__no_such_file__.json'));
  assert.deepEqual(out, {});
});
check('readRuntimeOverride 对坏 JSON 返回空对象', () => {
  const tmp = path.join(ROOT, 'test', '__bad_runtime__.json');
  fs.writeFileSync(tmp, '{ this is not json', 'utf8');
  try {
    assert.deepEqual(vision.readRuntimeOverride(tmp), {});
  } finally {
    fs.unlinkSync(tmp);
  }
});

// ── 配置解析 ──────────────────────────────────────────────
console.log('\n[配置解析]');
const rt = vision.resolveRuntime({});
check('resolveRuntime 给出 bridgeBaseUrl', () => {
  assert.ok(/^https?:\/\//.test(rt.bridgeBaseUrl), `异常：${rt.bridgeBaseUrl}`);
});
check('resolveRuntime 给出视觉模型名', () => {
  assert.ok(rt.visionModel.length > 0);
});
check('resolveRuntime 给出视觉后端地址', () => {
  assert.ok(/^https?:\/\//.test(rt.visionBaseUrl), `异常：${rt.visionBaseUrl}`);
});
check('resolveRuntime 超时是正数', () => {
  assert.ok(rt.timeoutMs > 0);
  assert.ok(rt.maxImageBytes > 0);
});
check('resolveRuntime 的 prompt 非空', () => {
  assert.ok(rt.prompt.length > 10);
});
check('视觉 key 从 .credentials.yaml 读到了', () => {
  // 这台机器环境变量里没有 *_KEY，只能从 DSH 凭据文件读。
  if (!rt.visionApiKey) {
    console.log('    （跳过：这台机器没有可用 key，不算失败）');
    return;
  }
  assert.ok(rt.visionApiKey.length > 20, `key 太短：${rt.visionApiKey.length}`);
  assert.ok(rt.visionApiKeyVia.includes('credentials') || rt.visionApiKeyVia.startsWith('env:') || rt.visionApiKeyVia === 'config');
});

// ── 工具定义 ──────────────────────────────────────────────
console.log('\n[工具定义]');
const tools = plugin.__internals;
check('7 个工具工厂都存在', () => {
  for (const k of ['toolDescribe', 'toolDescribeFile', 'toolStatus', 'toolConfig', 'toolSelftest', 'toolModels', 'toolUsage']) {
    assert.equal(typeof tools[k], 'function', `${k} 缺失`);
  }
});
check('qq_vision_describe 参数 schema 合法', () => {
  const t = tools.toolDescribe(() => rt);
  assert.equal(t.name, 'qq_vision_describe');
  assert.equal(t.parameters.type, 'object');
  assert.deepEqual(t.parameters.required, ['key', 'messageId']);
  assert.equal(t.output.schema.required.length, 3);
});
check('qq_vision_describe_file 参数 schema 合法', () => {
  const t = tools.toolDescribeFile(() => rt);
  assert.equal(t.name, 'qq_vision_describe_file');
  assert.deepEqual(t.parameters.required, ['path']);
});
check('qq_vision_status 无必填参数', () => {
  const t = tools.toolStatus(() => rt);
  assert.equal(t.name, 'qq_vision_status');
  assert.equal(t.parameters.required, undefined);
});
check('qq_vision_config 的 action 枚举正确', () => {
  const t = tools.toolConfig();
  assert.equal(t.name, 'qq_vision_config');
  assert.deepEqual(t.parameters.properties.action.enum, ['get', 'set']);
});

// ── 注册流程（假 ctx） ────────────────────────────────────
console.log('\n[注册流程]');
check('apply 用假 ctx 能注册 7 个工具', () => {
  const seen = [];
  const ctx = {
    tools: { register: (def) => { seen.push(def.name); } },
    logger: { error: () => {} }
  };
  const result = plugin.apply(ctx, {});
  assert.deepEqual(seen.sort(), [
    'qq_vision_config', 'qq_vision_describe', 'qq_vision_describe_file',
    'qq_vision_models', 'qq_vision_selftest', 'qq_vision_status', 'qq_vision_usage'
  ]);
  assert.equal(result.registered.length, 7);
});
check('apply 遇到 duplicate 不报错', () => {
  let calls = 0;
  const ctx = {
    tools: { register: () => { calls += 1; throw new Error('duplicate tool name'); } },
    logger: { error: () => {} }
  };
  const result = plugin.apply(ctx, {});
  assert.equal(calls, 7);
  assert.equal(result.registered.length, 7);
});
check('apply 遇到真错误会记录但继续注册其它工具', () => {
  let n = 0;
  const errs = [];
  const ctx = {
    tools: { register: () => { n += 1; if (n === 1) throw new Error('boom'); } },
    logger: { error: (m) => errs.push(m) }
  };
  const result = plugin.apply(ctx, {});
  assert.equal(result.registered.length, 6);
  assert.equal(errs.length, 1);
  assert.ok(errs[0].includes('boom'));
});

// ── 汇总 ──────────────────────────────────────────────────
console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
if (fail > 0) {
  console.log('\n失败详情：');
  for (const f of failures) console.log(`  - ${f.label}\n    ${f.error?.stack || f.error}`);
  process.exit(1);
}
