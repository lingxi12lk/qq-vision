// 验证「完全自定义」三件套：models / config(get,set,备份) / usage(记账,查询,清空)
// 用法：node test/verify-custom.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { __internals } from '../lib/index.js';
import { resolveRuntime, readUsage, USAGE_FILE, RUNTIME_FILE } from '../lib/vision.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, '..');
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const rtRef = () => resolveRuntime({});

// ── 1. qq_vision_models ──
{
  const tool = __internals.toolModels(rtRef);
  const r = await tool.execute({});
  const models = r.data?.models ?? [];
  const ids = models.map((m) => m.id);
  check('qq_vision_models 返回模型菜单', models.length >= 4, `${models.length} 个：${ids.join(', ')}`);
  check('菜单含实测数据', models.every((m) => m.measured && typeof m.measured.total === 'number'), '');
  check('标记了当前默认模型', models.filter((m) => m.current).length === 1,
    `current = ${models.find((m) => m.current)?.id ?? '无'}`);
  check('qwen3.7-plus 标注为不推荐', /不推荐/.test(models.find((m) => m.id === 'qwen3.7-plus')?.label ?? ''), '');
}

// ── 2. qq_vision_config get ──
{
  const tool = __internals.toolConfig();
  const r = await tool.execute({ action: 'get' });
  check('config get 不报错', r.ok === true, r.summary);
  // 打码形式形如 sk-ws-…OfcA：保留头尾、中间省略号。判据是「含省略号且长度明显短于真 key」，
  // 不能只判 sk- 前缀 —— 打码后前缀还在。
  const shown = r.data?.visionApiKey ?? '';
  check('get 默认 key 打码', shown === '' || /…|\.\.\.|\*/.test(shown), `key = ${shown || '(空)'}`);
  // 真 key 长度（sk-ws- 开头的百炼 key 通常 30+ 字符），打码后必然远短于此。
  check('打码后不含完整 key', shown.length <= 24, `长度 ${shown.length}`);
  check('get 报出 billing 状态', typeof r.data?.billing === 'string', r.data?.billing ?? '');
  check('get 报出账本条数', typeof r.data?.usageTotal === 'number', `usageTotal = ${r.data?.usageTotal}`);
}

// ── 3. qq_vision_config set + 改前备份 ──
{
  const before = fs.existsSync(RUNTIME_FILE) ? fs.readFileSync(RUNTIME_FILE, 'utf8') : '{}';
  const tool = __internals.toolConfig();
  const r = await tool.execute({ action: 'set', visionEnabled: false, priceIn: 0.3, priceOut: 1.2, timeoutMs: 45000 });
  check('config set 成功', r.ok === true, r.summary);
  check('set 返回改前备份路径', typeof r.data?.backupFile === 'string' && fs.existsSync(r.data.backupFile),
    r.data?.backupFile ?? '');
  const rt = resolveRuntime({});
  check('visionEnabled 写成 false 没被吞', rt.visionEnabled === false, `visionEnabled = ${rt.visionEnabled}`);
  check('timeoutMs 落盘', rt.timeoutMs === 45000, `timeoutMs = ${rt.timeoutMs}`);
  const price = rt.prices?.[rt.visionModel];
  check('单价按当前模型记账', price?.in === 0.3 && price?.out === 1.2,
    `${rt.visionModel} → in ${price?.in} / out ${price?.out}`);
  // 还原
  fs.writeFileSync(RUNTIME_FILE, before, 'utf8');
  check('已还原 runtime.json', true, '');
}

// ── 4. qq_vision_usage 查询与清空 ──
{
  const tool = __internals.toolUsage();
  const r = await tool.execute({ limit: 5 });
  check('usage 查询不报错', r.ok === true, r.summary);
  check('usage 返回行数组', Array.isArray(r.data?.rows), `${r.data?.rows?.length ?? 0} 行`);

  const before = fs.existsSync(USAGE_FILE) ? fs.readFileSync(USAGE_FILE, 'utf8') : '';
  const c = await tool.execute({ clear: true });
  check('usage 清空成功', c.ok === true, c.summary);
  check('清空前有备份文件', typeof c.data?.backupFile === 'string', c.data?.backupFile ?? '');
  check('清空后文件为空', (fs.existsSync(USAGE_FILE) ? fs.readFileSync(USAGE_FILE, 'utf8') : '') === '', '');
  if (before) fs.writeFileSync(USAGE_FILE, before, 'utf8');
  check('账本已还原', true, '');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
