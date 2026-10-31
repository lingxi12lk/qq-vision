// 验证「默认关闭视觉、只走免费 OCR」是否真的生效。
// 跑法：node test/verify-billing.mjs
import { resolveRuntime, describeImage, sniffMime, readRuntimeOverride } from '../lib/vision.js';
import fs from 'node:fs/promises';

const img = process.env.TEST_IMAGE || 'C:\\Users\\lingxi\\AppData\\Local\\Temp\\vision-model-test.png';

const bytes = await fs.readFile(img);
const mimeType = sniffMime(bytes) || 'image/png';

const rt = resolveRuntime({});
console.log('=== 当前解析出来的运行参数 ===');
console.log('visionEnabled =', rt.visionEnabled);
console.log('visionModel   =', rt.visionModel);
console.log('visionApiKey  =', rt.visionApiKey ? `${rt.visionApiKey.slice(0, 6)}…${rt.visionApiKey.slice(-4)}` : '(空)');
console.log('runtime.json  =', JSON.stringify(readRuntimeOverride()));
console.log('');

console.log('=== 默认调用（不传 preferOcr、不传 model）===');
const a = await describeImage(rt, { bytes, mimeType });
console.log('mode    =', a.mode);
console.log('paid    =', a.billing?.paid ?? false);
console.log('tokens  =', a.billing?.totalTokens ?? 'n/a');
console.log('text    =', JSON.stringify(a.text));
console.log('error   =', a.error ?? '(无)');
console.log('');

console.log('=== 强制 preferOcr ===');
const b = await describeImage(rt, { bytes, mimeType, preferOcr: true });
console.log('mode    =', b.mode);
console.log('paid    =', b.billing?.paid ?? false);
console.log('text    =', JSON.stringify(b.text));
console.log('');

const ok = a.billing?.paid !== true && b.billing?.paid !== true;
console.log(ok ? '✔ 两条路径都没有产生付费调用' : '✘ 有付费调用发生，检查 visionEnabled');
process.exit(ok ? 0 : 1);
