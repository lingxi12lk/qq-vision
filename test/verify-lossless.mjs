// 验证工具返回值一定能无损 JSON 往返。
//
// 背景（这是真实踩过的坑，别删）：
//   DSH 对插件工具的返回值做 JSON 往返校验，只要返回值里出现 undefined
//   （对象属性或数组元素都算），整次调用就报
//     tool "xxx" returned invalid output: value is not lossless JSON
//   并把结果丢掉。qq_vision_describe_file 在 describeImage 失败时没有
//   ocrText / billing 两个字段，原来直接拼进 data 就触发了这条。
//
// 现在有两道防线：
//   1. 每个工具自己把字段补成具体值（null 而不是 undefined）
//   2. apply() 里统一 wrap 一层 sanitize()，兜住任何漏网的 undefined / NaN
// 本脚本对两道防线都验。
import assert from 'node:assert/strict';

import * as plugin from '../lib/index.js';

const {
  sanitize, toolDescribe, toolDescribeFile, toolStatus, toolConfig,
  toolModels, toolUsage, toolSelftest
} = plugin.__internals;

let pass = 0;
let fail = 0;
async function check(label, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`PASS  ${label}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL  ${label}\n      ${error?.message ?? error}`);
  }
}

/** 无损 JSON 往返：往返后结构与原值完全一致，且不含 undefined / NaN。 */
function assertLossless(value, label) {
  const roundtrip = JSON.parse(JSON.stringify(value));
  assert.deepEqual(roundtrip, value, `${label}：往返后结构不一致（说明有 undefined 或不可序列化的值）`);
  const walk = (v, path) => {
    if (v === undefined) throw new Error(`${label}：${path} 是 undefined`);
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`${label}：${path} 是 ${v}`);
    if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v)) walk(child, `${path}.${k}`);
    }
  };
  walk(value, '$');
}

console.log('[sanitize 单元]');

await check('undefined 变 null', () => {
  assert.equal(sanitize(undefined), null);
});

await check('对象里的 undefined 属性变 null', () => {
  assert.deepEqual(sanitize({ a: 1, b: undefined }), { a: 1, b: null });
});

await check('数组里的 undefined 变 null', () => {
  assert.deepEqual(sanitize([1, undefined, 3]), [1, null, 3]);
});

await check('NaN / Infinity 变 null', () => {
  assert.deepEqual(sanitize({ a: NaN, b: Infinity, c: -Infinity }), { a: null, b: null, c: null });
});

await check('BigInt 变字符串', () => {
  assert.equal(sanitize(10n), '10');
});

await check('函数与 symbol 变 null', () => {
  assert.deepEqual(sanitize({ f() {}, s: Symbol('x') }), { f: null, s: null });
});

await check('Date 变 ISO 字符串', () => {
  assert.equal(sanitize(new Date('2026-10-31T12:00:00Z')), '2026-10-31T12:00:00.000Z');
});

await check('循环引用不会炸', () => {
  const a = { name: 'a' };
  a.self = a;
  const r = sanitize(a);
  assert.equal(r.name, 'a');
  assert.equal(r.self, '[circular]');
});

await check('嵌套深对象整体无损', () => {
  const v = { x: [1, { y: undefined, z: [NaN, 'ok'] }], d: undefined };
  assertLossless(sanitize(v), '嵌套');
});

console.log('\n[工具真实返回值]');

const rtRef = () => ({ bridgeBaseUrl: 'http://127.0.0.1:3200', visionEnabled: false, visionModel: 'qwen3.5-omni-flash' });

const cases = [
  ['qq_vision_status', toolStatus(rtRef), {}],
  ['qq_vision_config(get)', toolConfig(), { action: 'get' }],
  ['qq_vision_models', toolModels(), {}],
  ['qq_vision_usage', toolUsage(), { limit: 2 }],
  ['qq_vision_selftest', toolSelftest(), { paid: false }],
  // 关键用例：不存在的图片，原来就是这里吐出 undefined 并被 DSH 丢掉
  ['qq_vision_describe_file(不存在)', toolDescribeFile(rtRef), { path: 'E:\\__no_such_file__.png', preferOcr: true }],
  // describeImage 失败路径：图里没字，返回里原本缺 ocrText / billing
  ['qq_vision_describe_file(无字图)', toolDescribeFile(rtRef), { path: 'E:\\dsh-qq\\qq-bridge-v2\\assets\\deepseek娘.png', preferOcr: true }],
  ['qq_vision_describe(假消息)', toolDescribe(rtRef), { key: 'private:1', messageId: '999999999' }]
];

for (const [label, tool, args] of cases) {
  const r = await tool.execute(args, {});
  await check(`${label} 返回无损 JSON`, () => {
    assert.equal(typeof r, 'object');
    assertLossless(r, label);
    assert.equal(typeof r.ok, 'boolean', 'ok 必须是布尔');
    assert.equal(typeof r.summary, 'string', 'summary 必须是字符串');
    assert.equal(typeof r.data, 'object', 'data 必须是对象');
  });
}

console.log('\n[apply 包装层]');

const registered = [];
plugin.apply({ tools: { register: (t) => registered.push(t) }, logger: { error() {} } }, {});

await check('注册了 7 个工具', () => {
  assert.equal(registered.length, 7);
});

await check('每个工具都有可执行的 execute', () => {
  for (const t of registered) assert.equal(typeof t.execute, 'function');
});

// 包装层兜底：用注册表里真实的工具走失败路径，验 wrap 没漏
const wrapped = registered.find((t) => t.name === 'qq_vision_describe_file');
await check('包装后的 describe_file 失败路径仍无损', async () => {
  const r = await wrapped.execute({ path: 'E:\\__no_such_file__.png', preferOcr: true }, {});
  assertLossless(r, 'wrapped describe_file');
  assert.equal(r.ok, false, '不存在的文件必须 ok=false');
});

await check('包装层把 ok 归一成布尔', async () => {
  const r = await wrapped.execute({ path: 'E:\\__no_such_file__.png' }, {});
  assert.equal(typeof r.ok, 'boolean');
});

// wrap 的语义单独验一遍（假工具本身不进注册表，这里手工模拟 wrap 的三行）
const fake = { ok: 'yes', summary: undefined, data: { x: undefined, y: NaN } };
const afterWrap = {
  ok: fake.ok === true,
  summary: String(fake.summary ?? ''),
  data: sanitize(fake.data ?? {})
};
await check('ok 非布尔 true 归一成 false', () => {
  assert.equal(afterWrap.ok, false);
});
await check('summary undefined 归一成空串', () => {
  assert.equal(afterWrap.summary, '');
});
await check('包装后整体无损', () => {
  assertLossless(afterWrap, 'afterWrap');
});

console.log(`\n${pass}/${pass + fail} 通过`);
if (fail > 0) process.exit(1);
