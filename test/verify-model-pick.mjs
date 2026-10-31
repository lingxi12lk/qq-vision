// 验证「开启视觉后能按调用方指定的模型识图，并把 token 用量报出来」。
// 会真的花钱（每次几十 token），但这是唯一能证明账单透明的办法。
// 跑法：node test/verify-model-pick.mjs
import { resolveRuntime, describeImage, sniffMime } from '../lib/vision.js';
import fs from 'node:fs/promises';

const img = process.env.TEST_IMAGE || 'C:\\Users\\lingxi\\AppData\\Local\\Temp\\vision-model-test.png';
const bytes = await fs.readFile(img);
const mimeType = sniffMime(bytes) || 'image/png';

// 造一个开启视觉的运行时（不写盘，只影响本次进程）
const base = resolveRuntime({});
const rt = { ...base, visionEnabled: true };

console.log('开关 =', rt.visionEnabled, ' 默认模型 =', rt.visionModel, '\n');

const models = ['qwen3.5-omni-flash', 'qwen3-vl-plus', 'qwen-vl-ocr'];
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
console.log(`\n本轮总消耗 = ${total} tokens`);
