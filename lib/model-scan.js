// 扫描 DSH 已注册的 llm provider 与其模型，给「视觉模型」下拉用。
//
// 为什么要有这一层：
//   1.2.0 之前 MODEL_CATALOG 是硬编码的 5 条，用户装了新 provider（baomiao-oneapi、
//   workbuddy-global、pi-ai 里自己加的模型）下拉里根本看不见，只能手打模型名。
//   现在改成运行时问 DSH：`llm.listProviders()` → 逐个 `llm.listModels(route)`。
//
// 三档降级（任何一档失败都不抛错，只降级并记原因）：
//   1) llm 服务在 + listModels 有结果 → source='dsh'
//   2) llm 在但某个 provider 报错          → 该 provider 记 error，其余照常
//   3) llm 整个不在（旧宿主 / 手工 ctx）   → 回落到 MODEL_CATALOG，source='builtin'
//
// 关键取舍：**不按 inputModalities 硬过滤**。
//   workbuddy 那侧靠 workBuddyModelInput() 声明 image，pi-ai 那侧声明 input:[text,image]，
//   但很多第三方 OpenAI 兼容网关压根不声明 inputModalities —— 硬过滤会把它们全筛掉，
//   而它们实际上读得了图（用户自己试过就知道）。所以：声明了 image 的标 image=true，
//   声明了但没 image 的标 image=false 并排后面，没声明的标 image=null（未知，保留）。

import { MODEL_CATALOG, VISION_PROVIDERS } from './vision.js';

/** DSH provider 路由 → qq-vision 的视觉后端种类。 */
const BACKEND_BY_ROUTE = {
  workbuddy: 'workbuddy',
  'workbuddy-global': 'workbuddy',
  bailian: 'bailian'
};

/**
 * 猜一条 provider 路由该走哪个后端。
 *
 * workbuddy 系走专用通道（vault token + 强制流式）；其余 OpenAI 兼容网关走 bailian
 * 那条通用通道（baseUrl + apiKey + 非流式）。猜不出来也归 bailian —— 它是通用的那条。
 */
export function backendOfRoute(route) {
  const r = String(route || '').toLowerCase();
  if (BACKEND_BY_ROUTE[r]) return BACKEND_BY_ROUTE[r];
  if (r.includes('workbuddy') || r.includes('codebuddy')) return 'workbuddy';
  return 'bailian';
}

/** 把 DSH 的 inputModalities 归成三态：true / false / null（未声明）。 */
function imageSupportOf(info) {
  const mods = info?.inputModalities;
  if (!Array.isArray(mods) || mods.length === 0) return null;
  return mods.includes('image');
}

/**
 * 包装路由的上游：`modlens-<upstream>`，以及历史遗留的 `deepseek-modlens`
 * → `deepseek-official`。不是包装路由就返回空串。
 *
 * 依据 modlens 自己的约定（`@liustack/modlens/dsh/index.js` 的 wrapperIdEncodes）：
 * 自动发现的包装路由 id 一律是 `modlens-<upstream>`，id 自带上游来源，
 * 所以这里按名字切就行，不用问 DSH。
 */
export function upstreamOfWrapper(route) {
  const r = String(route || '');
  if (r.startsWith('modlens-')) return r.slice('modlens-'.length);
  if (r === 'deepseek-modlens') return 'deepseek-official';
  return '';
}

/**
 * 这条路由选中后，地址是不是确定的。
 *
 * 为什么必须判：vision.js 在没拿到 visionBaseUrl 时会兜底到
 * DEFAULT_VISION_BASE_URL（dashscope）。所以「地址为空」不等于「走默认」，
 * 而是「拿别家的模型名去请求阿里百炼」—— 不报错，静默错发。
 *
 * workbuddy 系例外：它的地址是本地 shim（127.0.0.1:<port>），凭据在 vault，
 * qq-vision 自己按 vault 域算得出来，不需要 baseUrl。
 */
export function addressKnownOf(backend, baseUrl) {
  if (backend === 'workbuddy') return true;
  return String(baseUrl || '').trim() !== '';
}

/**
 * 取一条路由的 baseUrl / apiKeyEnv，包装路由（modlens-*）沿上游继承。
 *
 * modlens 包装路由自己不带地址 —— 它只是把请求转发给上游 provider。所以
 * `modlens-bailian` 应该继承 `bailian` 的地址，`modlens-deepseek-account`
 * 继承 `deepseek-account`（后者本来就没有，于是仍为空，最终判为不可用）。
 *
 * 自身有非空地址就用自身的，不覆盖。上游可以再是包装路由（理论上），
 * 用 seen 挡环，最多追 4 层。
 */
export function resolveRouteMeta(route, metaByRoute) {
  const seen = new Set();
  let cur = String(route || '');
  for (let depth = 0; depth < 4 && cur && !seen.has(cur); depth += 1) {
    seen.add(cur);
    const meta = metaByRoute.get(cur);
    if (meta && String(meta.baseUrl || '').trim() !== '') {
      // 地址找到了；apiKeyEnv 若本层没写，也回落到上游的
      const own = metaByRoute.get(String(route || ''));
      return { baseUrl: meta.baseUrl, apiKeyEnv: String(own?.apiKeyEnv || meta.apiKeyEnv || '') };
    }
    cur = upstreamOfWrapper(cur);
  }
  // 一路没找到地址：返回本层原值（可能是空串），交给 addressKnownOf 判定
  return metaByRoute.get(String(route || '')) || null;
}

/**
 * 把一条 LlmModelInfo 映射成面板行。
 *
 * 保留 DSH 给的原名（name），另外把实测数据从 MODEL_CATALOG 里按 id 补上 ——
 * 同一个 id 在本机测过的 token/耗时不该因为换了数据源就丢掉。
 */
function toRow(route, info, catalogById, meta) {
  const id = String(info?.id ?? '').trim();
  if (!id) return null;
  const backend = backendOfRoute(route);
  const measured = catalogById.get(id) || null;
  const image = imageSupportOf(info);
  const baseUrl = meta?.baseUrl || '';
  return {
    provider: route,
    backend,
    id,
    name: String(info?.name ?? id),
    description: String(info?.description ?? ''),
    label: measured?.label || String(info?.name ?? ''),
    strength: measured?.strength || String(info?.description ?? ''),
    note: measured?.note || '',
    measured: measured?.measured ?? null,
    image,
    // 选中该模型时要一并写进 runtime.json 的两个字段：第三方网关的地址和 key 环境变量。
    // 空字符串表示「跟后端默认走」（workbuddy 走 vault，bailian 走 visionBaseUrl 配置）。
    baseUrl,
    apiKeyEnv: meta?.apiKeyEnv || '',
    // 地址是否确定。false 的模型选中后会错发，面板据此禁用并说明原因。
    addressKnown: addressKnownOf(backend, baseUrl),
    source: 'dsh',
    usable: false // 由调用方按当前后端再算
  };
}

/**
 * 从 settings 里读 pi-ai 的 providers 段，拿到每条路由真实配置的 baseURL / apiKeyEnv。
 *
 * 为什么要绕这一道：`llm.listConfigurableProviders()` 对**内置目录**里的 provider 会带
 * defaultBaseURL / baseURLEnv，但用户在 cordis.patch.yml 里自己加的（bailian、
 * baomiao-oneapi）走 declared 分支，那几个字段根本不存在 —— 实测 12 条路由全空。
 * 真实值只在这里。
 *
 * @param {object|undefined} settings ctx.get('settings')
 * @returns {Map<string,{baseUrl:string,apiKeyEnv:string}>} 拿不到就是空 Map
 */
export function readPiAiProfiles(settings) {
  const out = new Map();
  if (!settings || typeof settings.describe !== 'function') return out;

  let forms = [];
  try {
    forms = settings.describe();
  } catch { return out; }
  if (!Array.isArray(forms)) return out;

  for (const form of forms) {
    const ns = String(form?.ns ?? '');
    // llm-pi-ai 那份 profile entry 的 id 就是 'llm-pi-ai'。不靠包含匹配猜太多，
    // 但允许 'llm' 前缀的其它命名，反正下面还要 providers 结构对得上才收。
    if (!ns.includes('llm')) continue;
    const providers = form?.value?.providers;
    if (!providers || typeof providers !== 'object') continue;
    for (const [route, prof] of Object.entries(providers)) {
      if (!route || !prof || typeof prof !== 'object') continue;
      out.set(route, {
        baseUrl: String(prof.baseURL || prof.baseUrl || ''),
        apiKeyEnv: String(prof.apiKeyEnv || '')
      });
    }
  }
  return out;
}

/**
 * 扫描 DSH 的 llm 服务。
 *
 * @param {object|undefined} llm  ctx.get('llm') 的返回值；不在就传 undefined
 * @param {{ signal?: AbortSignal, profiles?: Map<string,{baseUrl:string,apiKeyEnv:string}> }} [opts]
 * @returns {Promise<{available:boolean, models:object[], providers:object[], errors:string[], reason:string}>}
 */
export async function scanDshModels(llm, opts = {}) {
  const errors = [];
  const catalogById = new Map(MODEL_CATALOG.map((m) => [m.id, m]));

  if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
    return {
      available: false,
      models: [],
      providers: [],
      errors: ['宿主没有 llm 服务（或版本太旧没有 listModels）'],
      reason: 'llm-unavailable'
    };
  }

  let providers = [];
  try {
    providers = await llm.listProviders();
  } catch (error) {
    errors.push(`listProviders 失败：${error?.message ?? error}`);
  }
  if (!Array.isArray(providers)) providers = [];

  // 可配置 provider 目录能给出 baseURL / apiKeyEnv —— 选非 workbuddy 的模型时顺手把这两个
  // 字段带上，否则用户得自己抄一遍地址和变量名，抄错就是 404 / 401。
  const metaByRoute = new Map();
  try {
    if (typeof llm.listConfigurableProviders !== 'function') {
      errors.push('llm 没有 listConfigurableProviders —— 拿不到 baseURL / apiKeyEnv');
    } else {
      const list = await llm.listConfigurableProviders();
      const entries = Array.isArray(list) ? list : [];
      if (entries.length === 0) errors.push('listConfigurableProviders 返回空目录');
      for (const entry of entries) {
        const route = String(entry?.provider ?? '');
        if (!route) continue;
        const envs = Array.isArray(entry?.baseURLEnv) ? entry.baseURLEnv : [];
        const native = Array.isArray(entry?.nativeAuth?.env) ? entry.nativeAuth.env : [];
        metaByRoute.set(route, {
          baseUrl: String(entry?.defaultBaseURL ?? ''),
          // baseURLEnv 是「拼地址用的变量」（如 CLOUDFLARE_ACCOUNT_ID），不是 key 变量。
          // 真正的 key 变量在 nativeAuth.env 里；两者都留，优先 baseURLEnv 里的第一个
          // 因为对 OpenAI 兼容网关来说 baseURLEnv[0] 常常就是 XXX_BASE_URL，而 key 变量
          // 用户更可能自己设。nativeAuth 兜底。
          apiKeyEnv: envs.length ? String(envs[0]) : (native.length ? String(native[0]) : '')
        });
      }
    }
  } catch (error) {
    // 目录拿不到不影响主流程，但必须留下原因 —— 否则「baseUrl 全空」这种症状查不出源头。
    errors.push(`listConfigurableProviders 失败：${error?.message ?? error}`);
  }

  // 上面那份目录只对 pi-ai 内置目录里已有的 provider 带地址/变量名。用户在
  // cordis.patch.yml 里自己加的（bailian、baomiao-oneapi）走 declared 分支，
  // defaultBaseURL / baseURLEnv / nativeAuth 一个都没有 —— 实测 12 个 provider 全空。
  // 真实值在 settings 的 providers 段里，由调用方读出来塞进 opts.profiles 覆盖。
  if (opts.profiles instanceof Map) {
    for (const [route, prof] of opts.profiles) {
      if (!route) continue;
      const prev = metaByRoute.get(route) || {};
      metaByRoute.set(route, {
        baseUrl: String(prof?.baseUrl || prev.baseUrl || ''),
        apiKeyEnv: String(prof?.apiKeyEnv || prev.apiKeyEnv || '')
      });
    }
  }

  const models = [];
  const providerRows = [];

  for (const p of providers) {
    const route = String(p?.id ?? '');
    if (!route) continue;
    let list = [];
    try {
      list = await llm.listModels(route, opts.signal);
    } catch (error) {
      const msg = `listModels(${route}) 失败：${error?.message ?? error}`;
      errors.push(msg);
      providerRows.push({
        route,
        name: String(p?.name ?? route),
        backend: backendOfRoute(route),
        baseUrl: '',
        apiKeyEnv: '',
        upstream: upstreamOfWrapper(route),
        addressKnown: false,
        count: 0,
        imageCount: 0,
        error: msg
      });
      continue;
    }
    // 包装路由（modlens-*）自身不带地址，沿上游继承；继承不到就留空，后面判为不可用。
    const meta = resolveRouteMeta(route, metaByRoute);
    const rows = (Array.isArray(list) ? list : []).map((info) => toRow(route, info, catalogById, meta)).filter(Boolean);
    // 声明支持图的排前面，未知居中，明确不支持的排最后 —— 但都留着，不删。
    const rank = (m) => (m.image === true ? 0 : m.image === null ? 1 : 2);
    rows.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
    models.push(...rows);
    providerRows.push({
      route,
      name: String(p?.name ?? route),
      backend: backendOfRoute(route),
      baseUrl: meta?.baseUrl ?? '',
      apiKeyEnv: meta?.apiKeyEnv ?? '',
      // 包装路由要标出上游，否则面板上 `modlens-bailian` 看着像个独立后端
      upstream: upstreamOfWrapper(route),
      addressKnown: addressKnownOf(backendOfRoute(route), meta?.baseUrl ?? ''),
      count: rows.length,
      imageCount: rows.filter((m) => m.image === true).length,
      error: ''
    });
  }

  if (models.length === 0) {
    return {
      available: false,
      models: [],
      providers: providerRows,
      errors: errors.length ? errors : ['DSH 没有报告任何模型'],
      reason: 'empty'
    };
  }

  // 全局再排一遍：先按「能不能读图」，同档内保持 provider 顺序、再按 id。
  // 每个 provider 内部已排过，但拼接后整体可能忽高忽低（A 的纯文本排在 B 的读图模型前面），
  // 面板卡片列表是平铺渲染的，必须全局有序才好看。
  const rank = (m) => (m.image === true ? 0 : m.image === null ? 1 : 2);
  models.sort((a, b) => rank(a) - rank(b) || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));

  return { available: true, models, providers: providerRows, errors, reason: '' };
}

/**
 * 兜底表（MODEL_CATALOG）映射成同样的行形状。
 * llm 不在、或者扫描结果为空时用，保证下拉永远有东西可选。
 */
export function builtinRows() {
  return MODEL_CATALOG.map((m) => {
    const provider = String(m.provider || 'bailian');
    return {
      provider,
      backend: VISION_PROVIDERS.includes(provider) ? provider : 'bailian',
      id: m.id,
      name: m.label || m.id,
      description: m.strength || '',
      label: m.label || m.id,
      strength: m.strength || '',
      note: m.note || '',
      measured: m.measured ?? null,
      image: null,
      baseUrl: '',
      apiKeyEnv: '',
      source: 'builtin',
      usable: false
    };
  });
}

/**
 * 合并扫描结果与兜底表。
 *
 * 合并规则：DSH 报的为准；兜底表里**本机实测过但 DSH 没报**的条目补在后面
 * （source='builtin'）。这样既不会漏掉新 provider，也不会因为某个 provider
 * 临时拉不到目录就把用户熟悉的模型从下拉里弄没。
 */
export function mergeRows(scanned, builtin) {
  const seen = new Set(scanned.map((m) => `${m.provider}::${m.id}`));
  const seenId = new Set(scanned.map((m) => m.id));
  const extra = builtin
    .filter((m) => !seen.has(`${m.provider}::${m.id}`) && !seenId.has(m.id))
    .map((m) => ({ ...m, source: 'builtin-fallback' }));
  return [...scanned, ...extra];
}
