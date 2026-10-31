// 验证「开启视觉后能按调用方指定的模型识图，并把 token 用量报出来」。
// 会真的花钱（每次一两百 token），但这是唯一能证明账单透明的办法。
// 跑法：node test/verify-model-pick.mjs
//
// 测试图用 lib/selftest-fixture.js 里内嵌的 1006 字节 PNG（白底黑字「OK 123」），
// 不依赖任何外部文件 —— 换机器、换目录跑结果都一样。
import { resolveRuntime, describeImage, sniffMime, MODEL_CATALOG } from '../lib/vision.js';
import { SELFTEST_PNG_B64 } from '../lib/selftest-fixture.js';

const bytes = Buffer.from(SELFTEST_PNG_B64, 'base64');
const mimeType = sniffMime(bytes) || 'image/png';

// 造一个开启视觉的运行时（不写盘，只影响本次进程）
const base = resolveRuntime({});
const rt = { ...base, visionEnabled: true };

if (!rt.visionApiKey) {
  console.log(`没有视觉后端 key（${rt.visionApiKeyEnv}），这条测试跑不了。先跑 node test/verify-lossless.mjs 或 qq_vision_selftest。`);
  process.exit(0);
}

console.log('开关 =', rt.visionEnabled, ' 默认模型 =', rt.visionModel, ` 测试图 = ${bytes.length} 字节\n`);

// 从 MODEL_CATALOG 取模型，别再手写一份 —— 菜单变了这里跟着变。
const models = MODEL_CATALOG.map((m) => m.id);
let total = 0;
const rows = [];

for (const model of models) {
  const r = await describeImage(rt, { bytes, mimeType, model });
  const t = r.billing?.totalTokens ?? 0;
  total += Number(t) || 0;
  rows.push({
    模型: model,
    模式: r.mode,
    实际模型: r.billing?.model ?? r.model ?? '-',
    prompt: r.billing?.promptTokens ?? '-',
    completion: r.billing?.completionTokens ?? '-',
    合计token: t || '-',
    耗时ms: r.ms,
    回复: String(r.text || r.error || '').replace(/\s+/g, ' ').slice(0, 60)
  });
}

console.table(rows);
console.log(`\n本轮总消耗 = ${total} tokens（共 ${models.length} 个模型，已记入 usage.jsonl）`);
