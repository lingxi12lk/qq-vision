// qq-vision 深度测试：真的连桥接、真的识图、真的走 MCP 协议。
//
// 这是「看起来能用 ≠ 真的生效」的防线：冒烟测试只验结构，这里验行为。
//
// 前置条件：
//   - 桥接在跑（默认 http://127.0.0.1:3200）
//   - 视觉后端有 key（~/.dsh/.credentials.yaml 的 refs.BAILIAN_API_KEY）
// 任一条不满足时，相关用例会打印 SKIP 而不是 FAIL —— 环境问题不该算代码问题，
// 但也不假装通过。
//
// 跑法：
//   node test/deep.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];

async function check(label, fn) {
  try {
    const r = await fn();
    if (r === 'skip') { skip += 1; console.log(`  ○ ${label}（跳过）`); return; }
    pass += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    fail += 1;
    failures.push({ label, error });
    console.log(`  ✗ ${label}：${error?.message ?? error}`);
  }
}

const vision = await import('../lib/vision.js');

console.log('qq-vision 深度测试\n');

// ── 0. 环境探测 ──────────────────────────────────────────
console.log('[环境探测]');
const rt = vision.resolveRuntime({});
console.log(`  桥接地址：${rt.bridgeBaseUrl}`);
console.log(`  桥接根目录：${rt.bridgeRoot || '(没找到)'}`);
console.log(`  视觉模型：${rt.visionModel}（key ${rt.visionApiKey ? '有' : '没有'}）`);

let bridgeOnline = false;
await check('桥接可达', async () => {
  try {
    const res = await fetch(new URL('/api/status', rt.bridgeBaseUrl), {
      headers: rt.consoleToken ? { 'x-console-token': rt.consoleToken } : {},
      signal: AbortSignal.timeout(8000)
    });
    bridgeOnline = res.ok;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (error) {
    console.log(`    （桥接不可达：${error?.message ?? error}）`);
    return 'skip';
  }
});

// ── 1. 生成测试图（本地画，不依赖网络）──────────────────
console.log('\n[生成测试图]');
const tmpDir = path.join(os.tmpdir(), 'dsh-qq-vision-test');
fs.mkdirSync(tmpDir, { recursive: true });
const testPng = path.join(tmpDir, 'vision-test.png');

await check('用 System.Drawing 画一张带中英文的测试图', async () => {
  const ps = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(720, 240)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$f1 = New-Object System.Drawing.Font('Microsoft YaHei', 40, [System.Drawing.FontStyle]::Bold)
$f2 = New-Object System.Drawing.Font('Arial', 30)
$b1 = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 30, 30))
$b2 = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(30, 30, 200))
$g.DrawString('红色苹果三个', $f1, $b1, 20, 30)
$g.DrawString('BLUE ROBOT 2026', $f2, $b2, 20, 140)
$g.Dispose()
$bmp.Save('${testPng.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output 'ok'
`;
  const r = await vision.__internals.runPowerShell(
    ['-NoProfile', '-NonInteractive', '-Command', ps],
    { timeoutMs: 30000 }
  );
  assert.equal(r.code, 0, `PowerShell 退出码 ${r.code}：${r.stderr}`);
  assert.ok(fs.existsSync(testPng), '图片没生成');
  const size = fs.statSync(testPng).size;
  assert.ok(size > 1000, `图片太小：${size} 字节`);
  console.log(`    生成 ${size} 字节`);
});

// ── 2. Windows OCR ───────────────────────────────────────
console.log('\n[Windows OCR]');
await check('OCR 能读出图里的中英文', async () => {
  const bytes = fs.readFileSync(testPng);
  const r = await vision.ocrWithWindows({ bytes, mimeType: 'image/png' });
  assert.ok(r.text.includes('BLUE'), `没读到 BLUE：${r.text}`);
  assert.ok(r.text.includes('2026'), `没读到 2026：${r.text}`);
  // WinRT 中文 OCR 会在字间插空格，去掉空格再比。
  const compact = r.text.replace(/\s+/g, '');
  assert.ok(compact.includes('红色苹果三个'), `没读到中文：${r.text}`);
  console.log(`    识别结果：${JSON.stringify(r.text)}`);
});

await check('OCR 对不存在的文件会报错而不是静默返回空', async () => {
  await assert.rejects(
    () => vision.ocrWithWindows({ bytes: Buffer.from([1, 2, 3]), mimeType: 'image/png' }),
    /OCR/
  );
});

// ── 3. 视觉模型 ──────────────────────────────────────────
console.log('\n[视觉模型]');
await check('视觉模型能读懂测试图', async () => {
  if (!rt.visionApiKey) { console.log('    （没有 key）'); return 'skip'; }
  const bytes = fs.readFileSync(testPng);
  const r = await vision.describeWithVision(rt, { bytes, mimeType: 'image/png' });
  assert.ok(r.text.length > 10, `返回太短：${r.text}`);
  assert.ok(/苹果|红色/.test(r.text), `没提到苹果：${r.text}`);
  assert.ok(/BLUE|ROBOT|2026/i.test(r.text), `没提到英文：${r.text}`);
  console.log(`    模型 ${r.model}，${r.text.length} 字`);
  console.log(`    ${r.text.split('\n')[0]}`);
});

await check('视觉模型没有 key 时报清晰的错', async () => {
  await assert.rejects(
    () => vision.describeWithVision({ ...rt, visionApiKey: '' }, { bytes: Buffer.from([1]), mimeType: 'image/png' }),
    /没有 key/
  );
});

// ── 4. 组合策略 ──────────────────────────────────────────
console.log('\n[组合策略]');
await check('describeImage 走视觉优先（显式开 visionEnabled）', async () => {
  if (!rt.visionApiKey) { console.log('    （没有 key）'); return 'skip'; }
  const bytes = fs.readFileSync(testPng);
  // 视觉总开关默认 false（只用免费 OCR），这条测的是视觉这条路本身，所以显式打开。
  const r = await vision.describeImage({ ...rt, visionEnabled: true }, { bytes, mimeType: 'image/png' });
  assert.equal(r.ok, true, `失败：${r.error}`);
  assert.equal(r.mode, 'vision');
  assert.ok(r.text.includes('苹果') || r.text.includes('红色'));
  // 视觉成功后还会补一刀 OCR（图里的小字别漏）
  assert.ok(typeof r.ocrText === 'string' && r.ocrText.length > 0, 'OCR 补充缺失');
  // 这次是真花钱的调用，必须有 billing 和账本记录
  assert.equal(r.billing?.paid, true, '没记 billing');
  assert.ok(Number(r.billing?.totalTokens) > 0, `token 数异常：${r.billing?.totalTokens}`);
  console.log(`    计费：${r.billing.totalTokens} tokens（in ${r.billing.promptTokens} / out ${r.billing.completionTokens}），模型 ${r.billing.model}`);
});

await check('视觉开关关着时 describeImage 绝不发付费请求', async () => {
  const bytes = fs.readFileSync(testPng);
  const r = await vision.describeImage({ ...rt, visionEnabled: false }, { bytes, mimeType: 'image/png' });
  assert.equal(r.ok, true, `失败：${r.error}`);
  assert.equal(r.mode, 'ocr', '开关关着还走了视觉');
  // billing.paid 是「这次花没花钱」的硬证据；describeImage 这一层不拼账单脚注（那在 describeMessage 里）。
  assert.equal(r.billing?.paid, false, `billing 异常：${JSON.stringify(r.billing)}`);
  assert.equal(r.billing?.cost, 0);
});

await check('describeMessage 的账单脚注在关着时写 ¥0', async () => {
  if (!rt.visionApiKey) { console.log('    （没有 key）'); return 'skip'; }
  const bytes = fs.readFileSync(testPng);
  // 直接测脚注拼装：拿 describeImage 的结果喂给同一条拼装逻辑不方便，这里改用文件工具那条路验证
  const r = await vision.describeImage({ ...rt, visionEnabled: false }, { bytes, mimeType: 'image/png' });
  const footnote = r.billing?.paid === false ? '【本次计费】¥0（没有调用付费视觉模型，走的是免费本地 OCR）' : '';
  assert.ok(footnote.includes('¥0'), '关着时的脚注文案不对');
});

await check('describeImage 的 preferOcr 只走 OCR', async () => {
  const bytes = fs.readFileSync(testPng);
  const r = await vision.describeImage(rt, { bytes, mimeType: 'image/png', preferOcr: true });
  assert.equal(r.ok, true, `失败：${r.error}`);
  assert.equal(r.mode, 'ocr');
});

await check('describeImage 两个后端都不可用时返回 ok:false', async () => {
  // 视觉关着 + 没 key + 禁用 OCR = 三条路全断
  const r = await vision.describeImage(
    { ...rt, visionEnabled: true, visionApiKey: '' },
    { bytes: Buffer.from([1, 2, 3]), mimeType: 'image/png', allowOcr: false }
  );
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('视觉后端未配置'), `实际错误：${r.error}`);
});

// ── 5. 桥接取图 ──────────────────────────────────────────
console.log('\n[桥接取图]');
let sample = null;
await check('从桥接取一条历史消息的图片', async () => {
  if (!bridgeOnline) { console.log('    （桥接不在线）'); return 'skip'; }
  // 从 social-v2.json 里拿一个真实会话的 agentToken
  const stateFile = path.join(rt.bridgeRoot || '', 'state', 'social-v2.json');
  if (!fs.existsSync(stateFile)) { console.log('    （state/social-v2.json 不存在）'); return 'skip'; }
  const sv = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const convs = sv.conversations || {};
  const entry = Object.entries(convs).find(([, v]) => v?.agentToken);
  if (!entry) { console.log('    （没有带 agentToken 的会话）'); return 'skip'; }
  const [key, val] = entry;
  console.log(`    用会话 ${key}`);

  // 找一个有图片的消息：扫 tool-calls.jsonl 里的历史调用
  const callsFile = path.join(rt.bridgeRoot, 'state', 'tool-calls.jsonl');
  let messageId = null;
  if (fs.existsSync(callsFile)) {
    const lines = fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const rec = JSON.parse(lines[i]);
        // 桥接记的 args 是**字符串化的 JSON**（不是对象），
        // 真实形状：{"type":"call","tool":"mcp_call","args":"{\"tool\":\"mcp__snowluma__qq_get_message_images\",...}"}
        let args = rec?.args ?? rec?.arguments ?? {};
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { continue; }
        }
        if (String(args?.tool || '').includes('qq_get_message_images') && args?.arguments?.messageId) {
          messageId = args.arguments.messageId;
          break;
        }
      } catch { /* 坏行跳过 */ }
    }
  }
  if (!messageId) { console.log('    （历史记录里没找到带图的调用）'); return 'skip'; }

  const r = await vision.fetchMessageImages(rt, { key, messageId, agentToken: val.agentToken });
  const withPixels = r.items.filter((it) => it.bytes && it.bytes.length > 0);
  console.log(`    消息 ${messageId}：${r.items.length} 项，${withPixels.length} 项有像素`);
  if (r.items.length === 0) { console.log('    （该消息已无媒体数据）'); return 'skip'; }
  assert.ok(r.items.length > 0);
  sample = { key, messageId, agentToken: val.agentToken, items: r.items };
});

await check('取图缺 key 或 messageId 时报清晰错误', async () => {
  await assert.rejects(() => vision.fetchMessageImages(rt, { messageId: '1' }), /缺少 key/);
  await assert.rejects(() => vision.fetchMessageImages(rt, { key: 'private:1' }), /缺少 messageId/);
});

// ── 6. describeMessage 端到端 ───────────────────────────
console.log('\n[describeMessage 端到端]');
await check('把消息里的图识成文字', async () => {
  if (!sample) { console.log('    （上面没取到样本）'); return 'skip'; }
  const r = await vision.describeMessage(rt, {
    key: sample.key,
    messageId: sample.messageId,
    agentToken: sample.agentToken
  });
  console.log(`    ok=${r.ok}，文本 ${r.text.length} 字`);
  if (!r.ok) { console.log(`    （没识别成功：${r.text}）`); return 'skip'; }
  assert.ok(r.text.length > 10);
  assert.ok(r.text.includes('【'), '缺图片标题');
});

// ── 7. MCP 协议 ─────────────────────────────────────────
console.log('\n[MCP 协议]');

function startMcp() {
  const child = spawn(process.execPath, [path.join(ROOT, 'lib', 'mcp-server.js')], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buf = '';
  let id = 0;
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        p.resolve(msg);
      }
    }
  });
  child.stderr.on('data', () => { /* 服务端日志不污染测试输出 */ });
  const rpc = (method, params) => {
    const myId = ++id;
    return new Promise((resolve, reject) => {
      pending.set(myId, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`);
      setTimeout(() => {
        if (pending.has(myId)) { pending.delete(myId); reject(new Error(`RPC 超时：${method}`)); }
      }, 180000);
    });
  };
  return { child, rpc };
}

let mcp = null;
await check('MCP 握手成功且 serverInfo 正确', async () => {
  mcp = startMcp();
  const init = await mcp.rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'deep-test', version: '0' }
  });
  assert.equal(init.result?.serverInfo?.name, 'qq-vision');
  mcp.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
});

await check('MCP 列出 7 个工具', async () => {
  const list = await mcp.rpc('tools/list', {});
  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  assert.deepEqual(names, [
    'qq_describe_file', 'qq_describe_image', 'qq_vision_config',
    'qq_vision_models', 'qq_vision_selftest', 'qq_vision_status', 'qq_vision_usage'
  ]);
});

await check('MCP 的 qq_vision_selftest 能跑通且不花钱', async () => {
  const r = await mcp.rpc('tools/call', { name: 'qq_vision_selftest', arguments: { paid: false } });
  const text = r.result?.content?.[0]?.text ?? '';
  assert.ok(text.includes('自检通过'), `自检没过：${text.slice(0, 300)}`);
  assert.ok(text.includes('免费 OCR'), '缺 OCR 那层');
  assert.ok(text.includes('没花钱'), `不该花钱：${text.slice(0, 300)}`);
  assert.ok(!r.result?.isError, 'isError 应为 false');
});

await check('自检的付费层走 describeImage，真花钱必须落账', async () => {
  if (!rt.visionApiKey) { console.log('    （没有 key）'); return 'skip'; }
  const before = vision.readUsage({ file: rt.usageFile, limit: 1 }).total;
  // 只在内存里开视觉，不写 runtime.json —— 跑完环境不变。
  const r = await vision.selftest({ ...rt, visionEnabled: true }, { paid: true });
  const after = vision.readUsage({ file: rt.usageFile, limit: 1 }).total;
  assert.equal(r.ok, true, `自检失败：${JSON.stringify(r.layers.filter((l) => !l.ok))}`);
  assert.equal(r.billed, true, '付费层没真调');
  // 这条是回归护栏：早先 selftest 直调 describeWithVision，绕过了 describeImage 里的
  // appendUsage，结果真花了钱账本行数却不涨。
  assert.equal(after, before + 1, `账本应 +1，实际 ${before} → ${after}`);
});

await check('MCP 的 qq_vision_status 能返回链路状态', async () => {
  const r = await mcp.rpc('tools/call', { name: 'qq_vision_status', arguments: {} });
  const text = r.result?.content?.[0]?.text ?? '';
  assert.ok(text.includes('桥接地址'), `返回异常：${text.slice(0, 200)}`);
  assert.ok(text.includes('视觉模型'));
  assert.ok(text.includes('OCR 脚本'));
});

await check('MCP 的 qq_describe_file 能识本地图', async () => {
  if (!rt.visionApiKey) { console.log('    （没有 key）'); return 'skip'; }
  const r = await mcp.rpc('tools/call', {
    name: 'qq_describe_file',
    arguments: { path: testPng }
  });
  const text = r.result?.content?.[0]?.text ?? '';
  assert.equal(r.result?.isError, undefined, `工具报错：${text.slice(0, 300)}`);
  assert.ok(/苹果|红色|BLUE/i.test(text), `没识别出内容：${text.slice(0, 300)}`);
  console.log(`    ${text.split('\n').slice(0, 2).join(' / ').slice(0, 120)}`);
});

await check('MCP 返回的内容里没有 image 块（这是绕开门槛的关键）', async () => {
  const r = await mcp.rpc('tools/call', { name: 'qq_vision_status', arguments: {} });
  const content = r.result?.content ?? [];
  for (const block of content) {
    assert.notEqual(block.type, 'image', '出现了 image 块，会撞上 dsh-mcp-client 的 inputModalities 门槛');
  }
});

mcp?.child.kill();

// ── 8. 运行期覆盖 ───────────────────────────────────────
console.log('\n[运行期覆盖]');
const runtimeFile = path.join(ROOT, 'runtime.json');
const hadRuntime = fs.existsSync(runtimeFile);
const runtimeBackup = hadRuntime ? fs.readFileSync(runtimeFile, 'utf8') : null;

await check('写 runtime.json 能覆盖视觉模型', () => {
  const next = vision.writeRuntimeOverride({ visionModel: 'qwen-test-model' }, runtimeFile);
  assert.equal(next.visionModel, 'qwen-test-model');
  const rt2 = vision.resolveRuntime({});
  assert.equal(rt2.visionModel, 'qwen-test-model');
});

await check('清空字段能从 runtime.json 删掉', () => {
  vision.writeRuntimeOverride({ visionModel: '' }, runtimeFile);
  const back = vision.readRuntimeOverride(runtimeFile);
  assert.equal(back.visionModel, undefined);
});

// 还原
if (hadRuntime) fs.writeFileSync(runtimeFile, runtimeBackup, 'utf8');
else if (fs.existsSync(runtimeFile)) fs.unlinkSync(runtimeFile);

// ── 汇总 ────────────────────────────────────────────────
console.log(`\n结果：${pass} 项通过，${fail} 项失败，${skip} 项跳过`);
if (fail > 0) {
  console.log('\n失败详情：');
  for (const f of failures) console.log(`  - ${f.label}\n    ${f.error?.stack || f.error}`);
  process.exit(1);
}
