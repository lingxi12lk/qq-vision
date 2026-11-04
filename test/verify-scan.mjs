// 验证「模型菜单改为扫描 DSH」这条链路：
//   1) model-scan 本身（假 llm 服务）—— 分组、图能力排序、单 provider 报错不连坐、无 llm 降级
//   2) 合并兜底表 —— DSH 报的为准，同名不重复
//   3) toolModels 在真 ctx（假 llm）下真的走扫描、带 source / backend / current / usable
//   4) toolModels 在没有 llm 的 ctx 下自动降级到兜底表，不抛错
// 用法：node test/verify-scan.mjs
import { scanDshModels, builtinRows, mergeRows, backendOfRoute } from '../lib/model-scan.js';
import { __internals } from '../lib/index.js';
import { resolveRuntime } from '../lib/vision.js';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ── 1. 假 llm 服务 ──
const fakeLlm = {
  listProviders: () => [
    { id: 'workbuddy', name: 'WorkBuddy CN' },
    { id: 'workbuddy-global', name: 'WorkBuddy Global' },
    { id: 'bailian', name: '百炼' },
    { id: 'baomiao-oneapi', name: '暴喵API' },
    { id: 'broken', name: '坏掉的' }
  ],
  listConfigurableProviders: () => [
    { provider: 'bailian', displayName: '百炼', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'bailian'], defaultBaseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', baseURLEnv: ['BAILIAN_API_KEY'] },
    { provider: 'baomiao-oneapi', displayName: '暴喵API', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'baomiao-oneapi'], defaultBaseURL: 'https://open-ai.baomiao.cn/v1', baseURLEnv: ['BAOMIAO_API_KEY'] }
  ],
  async listModels(route) {
    if (route === 'broken') throw new Error('boom');
    if (route === 'workbuddy') {
      return [
        { provider: 'workbuddy', id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', inputModalities: ['text', 'image'] },
        { provider: 'workbuddy', id: 'hy4free', name: 'Hy4', inputModalities: ['text'] }
      ];
    }
    if (route === 'workbuddy-global') {
      return [{ provider: 'workbuddy-global', id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', inputModalities: ['text', 'image'] }];
    }
    if (route === 'bailian') {
      return [
        { provider: 'bailian', id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', inputModalities: ['text', 'image'] },
        { provider: 'bailian', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', inputModalities: ['text'] }
      ];
    }
    return [{ provider: 'baomiao-oneapi', id: 'GLM-5.3 (3.20x)', name: 'GLM-5.3' }];
  }
};

// ── 2. scanDshModels 基本行为 ──
{
  const r = await scanDshModels(fakeLlm);
  check('扫描成功时 available=true', r.available === true);
  check('扫到 4 个可用 provider', r.providers.filter((p) => !p.error).length === 4,
    r.providers.map((p) => `${p.route}/${p.count}`).join(' '));
  check('扫到 6 条模型', r.models.length === 6, `${r.models.length} 条`);
  check('单个 provider 抛错不连坐', r.errors.length === 1 && r.errors[0].includes('broken'),
    r.errors.join(' | '));
  check('报错的 provider 仍出现在 providers 列表里且带 error',
    r.providers.some((p) => p.route === 'broken' && p.error));

  const wb = r.models.filter((m) => m.backend === 'workbuddy');
  const bl = r.models.filter((m) => m.backend === 'bailian');
  check('workbuddy-global 归到 workbuddy 后端', wb.length === 3, `${wb.length} 条`);
  check('baomiao-oneapi 归到 bailian 后端', bl.length === 3, `${bl.length} 条`);
  check('每条都带 source=dsh', r.models.every((m) => m.source === 'dsh'));

  const img = r.models.find((m) => m.id === 'deepseek-v4.1-flash' && m.provider === 'workbuddy');
  check('声明含 image 的标 image=true', img?.image === true);
  const txt = r.models.find((m) => m.id === 'hy4free');
  check('明确只有 text 的标 image=false', txt?.image === false);
  const undeclared = r.models.find((m) => m.id === 'GLM-5.3 (3.20x)');
  check('没声明 inputModalities 的标 image=null', undeclared?.image === null);

  check('第三方网关模型带上 defaultBaseURL',
    undeclared?.baseUrl === 'https://open-ai.baomiao.cn/v1', undeclared?.baseUrl);
  check('第三方网关模型带上 baseURLEnv 的第一个环境变量',
    undeclared?.apiKeyEnv === 'BAOMIAO_API_KEY', undeclared?.apiKeyEnv);
  check('百炼模型也带上地址', bl.find((m) => m.id === 'qwen3.7-plus')?.baseUrl === 'https://dashscope.aliyuncs.com/compatible-mode/v1');

  // 排序：能读图的最前，没声明的中间，纯文本最后
  const rankOf = (m) => (m.image === true ? 0 : m.image === null ? 1 : 2);
  const ranks = r.models.map(rankOf);
  check('按图能力排序（能读图 → 未声明 → 纯文本）',
    ranks.every((v, i) => i === 0 || ranks[i - 1] <= v), ranks.join(''));
}

// ── 3. 无 llm / 残缺 llm 的降级 ──
{
  const none = await scanDshModels(undefined);
  check('没有 llm 时 available=false', none.available === false);
  check('没有 llm 时给明确 reason', none.reason === 'llm-unavailable', none.reason);
  check('没有 llm 时不抛错、errors 有说明', Array.isArray(none.errors) && none.errors.length === 1);

  const partial = await scanDshModels({ listProviders: () => [] });
  check('llm 缺 listModels 时也判不可用', partial.available === false, partial.reason);

  const empty = await scanDshModels({ listProviders: () => [], listModels: async () => [] });
  check('一个 provider 都没有时 available=false', empty.available === false, empty.reason);
}

// ── 4. backendOfRoute ──
{
  const cases = {
    workbuddy: 'workbuddy',
    'workbuddy-global': 'workbuddy',
    bailian: 'bailian',
    'baomiao-oneapi': 'bailian',
    'my-codebuddy-thing': 'workbuddy',
    random: 'bailian'
  };
  const bad = Object.entries(cases).filter(([k, v]) => backendOfRoute(k) !== v);
  check('路由归类规则正确', bad.length === 0,
    Object.keys(cases).map((k) => `${k}→${backendOfRoute(k)}`).join(' '));
}

// ── 5. 合并兜底表 ──
{
  const r = await scanDshModels(fakeLlm);
  const builtin = builtinRows();
  check('兜底表本身有内容', builtin.length >= 3, `${builtin.length} 条`);
  check('兜底表全部标 source=builtin', builtin.every((m) => m.source === 'builtin'));

  const merged = mergeRows(r.models, builtin);
  const ids = merged.map((m) => `${m.provider}::${m.id}`);
  check('合并后没有重复的 provider::id', new Set(ids).size === ids.length,
    `${ids.length} 行 / ${new Set(ids).size} 唯一`);

  const dshHit = merged.find((m) => m.provider === 'workbuddy' && m.id === 'deepseek-v4.1-flash');
  check('DSH 报的优先，不被兜底表覆盖', dshHit?.source === 'dsh', dshHit?.source);
  check('DSH 报的保留 image 信息（兜底表里是 null）', dshHit?.image === true);

  const fallback = merged.filter((m) => m.source === 'builtin-fallback');
  check('兜底表补上了 DSH 没报的模型', fallback.length > 0,
    fallback.map((m) => m.id).join(', '));
  check('补上的标 builtin-fallback', fallback.every((m) => m.source === 'builtin-fallback'));
}

// ── 6. toolModels 走真 ctx ──
{
  const { toolModels } = __internals;
  const rt = resolveRuntime({});

  // 有 llm 的 ctx
  const ctxWithLlm = { get: (name) => (name === 'llm' ? fakeLlm : undefined) };
  const t = toolModels(() => rt, ctxWithLlm);
  check('toolModels 接受第二个参数（ctx）', typeof t.execute === 'function');

  const out1 = await t.execute({});
  const d1 = out1.data ?? out1;
  check('toolModels 真的走了扫描', d1.scanAvailable === true, `scanAvailable=${d1.scanAvailable}`);
  check('toolModels 返回 providers 明细', Array.isArray(d1.providers) && d1.providers.length === 5,
    `${d1.providers?.length} 个`);
  check('toolModels 带回 provider 的报错', Array.isArray(d1.errors) && d1.errors.length === 1);
  check('返回行里带 backend 字段', d1.models.every((m) => typeof m.backend === 'string'));
  check('返回行里带 source 字段', d1.models.every((m) => typeof m.source === 'string'));
  check('恰好一个 current', d1.models.filter((m) => m.current).length === 1,
    `current = ${d1.models.find((m) => m.current)?.id ?? '无'}`);
  check('usable 与当前后端一致',
    d1.models.every((m) => m.usable === (m.backend === d1.provider)),
    `provider=${d1.provider}`);
  check('scannedAt 是 ISO 时间', /^\d{4}-\d{2}-\d{2}T/.test(String(d1.scannedAt)), d1.scannedAt);

  // 缓存：第二次不带 refresh 应命中
  const out2 = await t.execute({});
  check('60 秒内第二次走缓存', (out2.data ?? out2).cached === true);
  const out3 = await t.execute({ refresh: true });
  check('refresh=true 绕过缓存', (out3.data ?? out3).cached === false);

  // 没有 llm 的 ctx → 兜底
  const ctxNoLlm = { get: () => undefined };
  const t2 = toolModels(() => rt, ctxNoLlm);
  const out4 = await t2.execute({});
  const d4 = out4.data ?? out4;
  check('没有 llm 时降级到兜底表', d4.scanAvailable === false, `scanAvailable=${d4.scanAvailable}`);
  check('降级后仍有模型可选', Array.isArray(d4.models) && d4.models.length >= 3,
    `${d4.models?.length} 条`);
  check('降级后所有行都是 builtin 来源',
    d4.models.every((m) => m.source === 'builtin'), [...new Set(d4.models.map((m) => m.source))].join(','));

  // 完全不传 ctx 也不该炸
  const t3 = toolModels(() => rt);
  const out5 = await t3.execute({});
  check('不传 ctx 也不抛错', Boolean(out5), 'ok');
}

// ── 7. summary 说得清来源 ──
{
  const { toolModels } = __internals;
  const rt = resolveRuntime({});
  const t = toolModels(() => rt, { get: (n) => (n === 'llm' ? fakeLlm : undefined) });
  const out = await t.execute({ refresh: true });
  const s = String(out.summary ?? '');
  check('summary 提到「扫描 DSH」', s.includes('扫描 DSH'), s.slice(0, 60));
  check('summary 提到 provider 报错数', s.includes('provider 报错'), s.slice(-60));
}

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\n${passed}/${results.length} 通过${failed ? `，${failed} 项失败` : ''}`);
if (failed) {
  console.log('失败项：');
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
}
process.exit(failed ? 1 : 0);
