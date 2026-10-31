// qq-vision 的 DSH 插件层：在主 DSH 会话里注册同样的识图工具。
//
// 定位说明（别搞混两个入口）：
//   - lib/mcp-server.js  → 给 QQ 会话（qq-chat-v2 preset）用，走 MCP 命名空间 + 白名单
//   - lib/index.js（本文件）→ 给**当前这个 DSH 会话**用，走 ctx.tools.register
//   两者共用 lib/vision.js，行为完全一致，只是"谁能看见"不同。
//
// 为什么不靠 read_image：当前 DSH 跑的模型（deepseek-v4.1-flash-sg / workbuddy glm-5.3-flash）
// 在 DSH 侧没声明 image 输入，read_image 会直接报
//   model "..." does not declare image input
// 本插件绕开这条路径，先把图看懂再回文字。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveRuntime,
  describeMessage,
  describeImage,
  fetchMessageImages,
  sniffMime,
  mask,
  writeRuntimeOverride,
  readRuntimeOverride,
  detectBridgeRoot,
  readUsage,
  selftest,
  MODEL_CATALOG,
  PLUGIN_DIR
} from './vision.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const name = 'dsh-qq-vision';

// webServer 不需要：本插件不开自己的面板，配置走 qq_vision_config 工具。
export const inject = ['tools'];

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'summary', 'data'],
  properties: {
    ok: { type: 'boolean', description: '这次调用是否成功' },
    summary: { type: 'string', description: '一行结论，人读' },
    data: { type: 'object', additionalProperties: true, description: '详细数据' }
  }
};

function renderResult(_args, value) {
  const body = JSON.stringify(value.data ?? {}, null, 2);
  const clipped = body.length > 6000 ? `${body.slice(0, 6000)}\n…（已截断）` : body;
  return [{ type: 'text', text: `${value.summary}\n\n${clipped}` }];
}

const output = { schema: OUTPUT_SCHEMA, render: renderResult };

const okResult = (summary, data) => ({ ok: true, summary, data: data ?? {} });

/**
 * 把任意返回值压成「可无损 JSON 往返」的纯数据。
 *
 * DSH 对工具返回值做 JSON 往返校验，任何 undefined（含数组元素、对象属性）
 * 都会让整次调用报 `invalid output: value is not lossless JSON` 并把结果丢掉。
 * 这里统一处理：undefined → null、函数/符号丢弃、NaN/Infinity → null、
 * BigInt → 字符串、循环引用 → '[circular]'。
 */
function sanitize(value, seen = new WeakSet()) {
  if (value === undefined) return null;
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'number') return Number.isFinite(value) ? value : null;
  if (t === 'bigint') return value.toString();
  if (t === 'function' || t === 'symbol') return null;
  if (t !== 'object') return null;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => sanitize(v, seen));
  if (value instanceof Date) return value.toISOString();
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = sanitize(v, seen);
  return out;
}

// ───────────────────────────── 工具实现 ─────────────────────────────

function toolDescribe(rtRef) {
  return {
    name: 'qq_vision_describe',
    description: '看一张 QQ 消息里的图片/表情并返回中文描述。'
      + '纯文本模型也能用：它先把图交给视觉模型（或系统 OCR）看懂，再把文字结论给你，不依赖你自己是否支持图片输入。'
      + '当消息里有 [图片] / [表情] / hasMedia 时用它，不要假装看得到、也不要编造内容。'
      + '注意计费：视觉模型默认关闭，只走免费本地 OCR；若要花钱请先确认 visionEnabled 状态，结果里会带【本次计费】行。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['key', 'messageId'],
      properties: {
        key: { type: 'string', description: '会话 key，格式 group:群号 或 private:QQ号' },
        messageId: { type: 'string', description: '消息 id（QQ 消息 id 可为负数；二代也可用本地 seq）' },
        token: { type: 'string', description: '二代会话令牌（reserved2 下必填，见唤醒提示里的【会话令牌】）' },
        prompt: { type: 'string', description: '自定义提问。不填用默认（描述画面 + 抄写图里文字 + 判断是不是表情包）' },
        limit: { type: 'number', description: '最多识别几张，默认 3，上限 5' },
        preferOcr: { type: 'boolean', description: 'true = 强制只用系统 OCR（离线、只出文字、零花费）。默认行为取决于 visionEnabled：关着就是 OCR，开着才走视觉模型' },
        model: { type: 'string', description: '单次指定视觉模型名，覆盖配置里的默认值。可选：qwen3.5-omni-flash（默认，最便宜最快）、qwen3-vl-plus（描述最详细）、qwen-vl-ocr（只 OCR 纯文字）。不传就用 qq_vision_config 里配的默认模型' }
      }
    },
    output,
    timeoutMs: 180000,
    async execute(args, exec) {
      const rt = rtRef();
      // 桥接可能离线、令牌可能过期、消息可能不存在 —— 都会抛异常。
      // 抛出去模型只看到「工具调用失败」，所以在这里接住并转成可读结果。
      let result;
      try {
        result = await describeMessage(rt, {
          key: args.key,
          messageId: args.messageId,
          agentToken: args.token,
          prompt: args.prompt,
          limit: Math.min(5, Math.max(1, Number(args.limit) || 3)),
          preferOcr: args.preferOcr === true,
          model: args.model,
          signal: exec?.signal
        });
      } catch (error) {
        const detail = error?.message ?? String(error);
        return {
          ok: false,
          summary: `取图失败：${detail}`,
          data: {
            messageId: String(args.messageId ?? ''),
            key: args.key ?? null,
            items: [],
            text: `消息 ${args.messageId} 取图失败：${detail}`
          }
        };
      }
      const summary = result.ok
        ? `消息 ${result.messageId} 共 ${result.items.length} 张图，已识别 ${result.items.filter((i) => i.ok).length} 张`
        : result.text;
      // items 里原本用 bytes: undefined 抹掉二进制，但 undefined 会让 DSH 判
      // "not lossless JSON" 而整个丢弃。改成显式删字段 + 逐项补默认值。
      const items = (result.items ?? []).map((it) => {
        const clean = {};
        for (const [k, v] of Object.entries(it)) {
          if (k === 'bytes' || v === undefined) continue;
          clean[k] = v;
        }
        return {
          index: clean.index ?? 0,
          kind: clean.kind ?? 'image',
          mimeType: clean.mimeType ?? null,
          byteLength: clean.byteLength ?? 0,
          ok: clean.ok === true,
          mode: clean.mode ?? 'none',
          text: clean.text ?? '',
          ocrText: clean.ocrText ?? null,
          error: clean.error ?? null,
          lang: clean.lang ?? null,
          model: clean.model ?? null,
          summary: clean.summary ?? null,
          file: clean.file ?? null,
          billing: clean.billing ?? null
        };
      });
      return {
        ok: result.ok === true,
        summary,
        data: {
          messageId: String(result.messageId ?? ''),
          key: result.key ?? null,
          items,
          text: result.text ?? ''
        }
      };
    }
  };
}

function toolDescribeFile(rtRef) {
  return {
    name: 'qq_vision_describe_file',
    description: '看一张本地图片文件（png/jpg/webp/gif/bmp）并返回中文描述。纯文本模型也能用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: '图片文件的绝对路径' },
        prompt: { type: 'string', description: '自定义提问，不填用默认' },
        preferOcr: { type: 'boolean', description: 'true = 强制只用系统 OCR（零花费）' },
        model: { type: 'string', description: '单次指定视觉模型名，覆盖默认。可选：qwen3.5-omni-flash（默认最便宜）、qwen3-vl-plus（最详细）、qwen-vl-ocr（纯文字）' }
      }
    },
    output,
    timeoutMs: 180000,
    async execute(args, exec) {
      const fs = await import('node:fs/promises');
      // 读文件、识图都可能失败（路径不存在、权限、格式不认识）。
      // 工具层必须自己接住：抛异常出去，模型只看到一句「工具调用失败」，
      // 拿不到任何可判断的信息。
      try {
        const bytes = await fs.readFile(args.path);
        const mimeType = sniffMime(bytes) || 'image/png';
        const rt = rtRef();
        const described = await describeImage(rt, {
          bytes, mimeType, prompt: args.prompt,
          preferOcr: args.preferOcr === true,
          model: args.model,
          signal: exec?.signal
        });
        const viaLabel = described.mode === 'vision'
          ? `视觉模型 ${described.model}，${described.billing?.totalTokens ?? '?'} tokens（计费）`
          : '系统 OCR（免费）';
        const summary = described.ok
          ? `已识别 ${args.path}（${viaLabel}，${bytes.length} 字节）`
          : `没看懂 ${args.path}：${described.error || '未知原因'}`;
        // 所有字段都必须落到具体值：DSH 的工具输出要能无损 JSON 往返，
        // undefined 会让整个返回值被判成 "not lossless JSON" 而丢掉（describeImage
        // 失败时没有 ocrText / billing，正是这条最容易踩）。
        return {
          ok: described.ok === true,
          summary,
          data: {
            path: String(args.path),
            mimeType,
            byteLength: bytes.length,
            mode: described.mode ?? 'none',
            text: described.text ?? '',
            ocrText: described.ocrText ?? null,
            error: described.error ?? null,
            lang: described.lang ?? null,
            ms: Number(described.ms) || 0,
            billing: described.billing ?? {
              paid: false, provider: null, model: null,
              promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, currency: 'CNY'
            }
          }
        };
      } catch (error) {
        const detail = error?.message ?? String(error);
        return {
          ok: false,
          summary: `读不了 ${args.path}：${detail}`,
          data: {
            path: String(args.path),
            mimeType: null,
            byteLength: 0,
            mode: 'none',
            text: '',
            ocrText: null,
            error: detail,
            lang: null,
            ms: 0,
            billing: {
              paid: false, provider: null, model: null,
              promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, currency: 'CNY'
            }
          }
        };
      }
    }
  };
}

function toolStatus(rtRef) {
  return {
    name: 'qq_vision_status',
    description: '查识图链路：桥接是否连得上、视觉后端配没配 key、用的哪个模型、OCR 脚本在不在且 BOM 正确。识图失败先跑它。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output,
    timeoutMs: 60000,
    async execute() {
      const rt = rtRef();
      const fs = await import('node:fs');

      let bridgeOnline = false;
      let bridgeError = null;
      try {
        const res = await fetch(new URL('/api/status', rt.bridgeBaseUrl), {
          headers: rt.consoleToken ? { 'x-console-token': rt.consoleToken } : {},
          signal: AbortSignal.timeout(8000)
        });
        bridgeOnline = res.ok;
        if (!res.ok) bridgeError = `HTTP ${res.status}`;
      } catch (error) {
        bridgeError = error?.message ?? String(error);
      }

      const script = path.join(HERE, 'ocr.ps1');
      let ocr = { script, exists: false, bom: false };
      try {
        ocr.exists = fs.existsSync(script);
        if (ocr.exists) {
          const buf = fs.readFileSync(script);
          ocr.bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
        }
      } catch { /* 忽略 */ }

      const summary = [
        `桥接 ${bridgeOnline ? '在线' : '离线'}（${rt.bridgeBaseUrl}）`,
        rt.visionEnabled
          ? `视觉 已开启（${rt.visionModel}，按字计费）`
          : '视觉 已关闭（只走免费 OCR，零花费）',
        `OCR ${ocr.exists ? (ocr.bom ? '就绪' : 'BOM 缺失') : '缺失'}`
      ].join('；');

      return okResult(summary, {
        bridge: {
          baseUrl: rt.bridgeBaseUrl ?? null,
          root: rt.bridgeRoot || null,
          connected: bridgeOnline,
          error: bridgeError ?? null,
          tokenSource: rt.tokenSource ?? null,
          consoleToken: mask(rt.consoleToken) ?? ''
        },
        vision: {
          enabled: rt.visionEnabled === true,
          billing: rt.visionEnabled ? 'paid（按 token 计费）' : 'free（未启用，不产生费用）',
          baseUrl: rt.visionBaseUrl ?? null,
          model: rt.visionModel ?? null,
          apiKey: mask(rt.visionApiKey) ?? '',
          apiKeyVia: rt.visionApiKeyVia ?? null,
          apiKeyEnv: rt.visionApiKeyEnv ?? null
        },
        ocr,
        runtimeFile: rt.runtimeFile ?? null,
        runtimeOverride: readRuntimeOverride()
      });
    }
  };
}

function toolConfig() {
  return {
    name: 'qq_vision_config',
    description: '读/改识图配置（完全自定义）：视觉开关、模型、后端地址、key 来源、提示词、超时、单图上限、单价表。'
      + 'action=get 读现状（key 默认打码，revealKey=true 才回显）；action=set 只改你传了的那些字段，其余保持不动，'
      + '并且会在插件目录 usage-backup/ 留一份改前备份。所有参数写进 runtime.json，改完立即生效，不用重启 DSH。'
      + 'visionEnabled 默认 false：只用免费本地 OCR，零花费；设 true 才会调付费视觉模型。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['get', 'set'], description: 'get=读当前配置；set=改（只改传了的字段）' },
        revealKey: { type: 'boolean', description: 'get 时是否回显视觉后端 key 明文（默认打码）' },

        // ── 桥接连接 ──
        bridgeBaseUrl: { type: 'string', description: '桥接地址，如 http://127.0.0.1:3200' },
        bridgeRoot: { type: 'string', description: '桥接根目录，如 E:\\dsh-qq\\qq-bridge-v2' },
        consoleToken: { type: 'string', description: '控制台令牌。留空自动读 <bridgeRoot>/state/console-token' },

        // ── 视觉后端 ──
        visionEnabled: { type: 'boolean', description: '视觉模型总开关。false=只用免费本地 OCR（默认）；true=调付费视觉模型，每次调用都会在结果里报 token 用量并记账' },
        visionBaseUrl: { type: 'string', description: '视觉后端 OpenAI 兼容根地址，如 https://dashscope.aliyuncs.com/compatible-mode/v1' },
        visionModel: { type: 'string', description: '默认视觉模型名。实测推荐 qwen3.5-omni-flash（209 tok / 1172ms）；另有 qwen3-vl-plus（最详细）、qwen-vl-ocr（纯文字最快）。用 qq_vision_models 看完整对照表' },
        visionApiKey: { type: 'string', description: '视觉后端 key 明文。留空则按 visionApiKeyEnv 从环境变量或 .credentials.yaml 找' },
        visionApiKeyEnv: { type: 'string', description: '从哪个环境变量/凭据名取 key，默认 BAILIAN_API_KEY' },

        // ── 行为参数 ──
        prompt: { type: 'string', description: '默认识图提示词' },
        timeoutMs: { type: 'number', description: '视觉请求超时（毫秒），默认 90000' },
        maxImageBytes: { type: 'number', description: '单图字节上限，默认 8388608' },

        // ── 计价 ──
        priceIn: { type: 'number', description: '给 visionModel 配输入单价（元/百万 token）。配了账本才能把 token 折成金额' },
        priceOut: { type: 'number', description: '给 visionModel 配输出单价（元/百万 token）' },
        prices: { type: 'object', additionalProperties: true, description: '整张单价表覆盖，形状 {"模型名":{"in":0.3,"out":1.2}}，单位元/百万 token。传 {} 清空' }
      }
    },
    output,
    timeoutMs: 60000,
    async execute(args) {
      const action = args.action === 'set' ? 'set' : 'get';

      if (action === 'get') {
        const rt = resolveRuntime({});
        const usage = readUsage({ limit: 5 });
        return okResult(
          `桥接 ${rt.bridgeBaseUrl}；视觉 ${rt.visionEnabled ? `已开启 ${rt.visionModel}（计费）` : '已关闭（零花费）'}；账本 ${usage.total} 条`,
          {
            bridgeBaseUrl: rt.bridgeBaseUrl ?? null,
            bridgeRoot: rt.bridgeRoot ?? null,
            consoleToken: (args.revealKey === true ? rt.consoleToken : mask(rt.consoleToken)) ?? '',
            tokenSource: rt.tokenSource ?? null,
            visionEnabled: rt.visionEnabled === true,
            billing: rt.visionEnabled ? 'paid（按 token 计费）' : 'free（未启用，不产生费用）',
            visionBaseUrl: rt.visionBaseUrl ?? null,
            visionModel: rt.visionModel ?? null,
            visionApiKey: (args.revealKey === true ? rt.visionApiKey : mask(rt.visionApiKey)) ?? '',
            visionApiKeyVia: rt.visionApiKeyVia ?? null,
            visionApiKeyEnv: rt.visionApiKeyEnv ?? null,
            prompt: rt.prompt ?? null,
            timeoutMs: rt.timeoutMs ?? null,
            maxImageBytes: rt.maxImageBytes ?? null,
            prices: rt.prices ?? {},
            runtimeFile: rt.runtimeFile ?? null,
            usageFile: rt.usageFile ?? null,
            usageTotal: usage.total,
            usageRecent: usage.rows,
            runtimeOverride: readRuntimeOverride()
          }
        );
      }

      // ── set ──
      const current = readRuntimeOverride();
      const patch = {};
      const changed = [];

      const strKeys = ['bridgeBaseUrl', 'bridgeRoot', 'consoleToken', 'visionBaseUrl', 'visionModel', 'visionApiKey', 'visionApiKeyEnv', 'prompt'];
      for (const k of strKeys) {
        if (args[k] === undefined) continue;
        const v = String(args[k]).trim();
        patch[k] = v;           // 空字符串走 writeRuntimeOverride 的删除分支 = 清空该项
        changed.push(k);
      }
      for (const k of ['timeoutMs', 'maxImageBytes']) {
        if (!Number.isFinite(args[k])) continue;
        patch[k] = Math.max(1, Math.round(Number(args[k])));
        changed.push(k);
      }
      // visionEnabled 是布尔，false 必须能写进去，不能按空值跳过。
      if (typeof args.visionEnabled === 'boolean') {
        patch.visionEnabled = args.visionEnabled;
        changed.push('visionEnabled');
      }

      // 单价：priceIn/priceOut 是给当前（或即将设置的）模型配的单条快捷方式。
      const nextModel = patch.visionModel || current.visionModel || resolveRuntime({}).visionModel;
      if (Number.isFinite(args.priceIn) || Number.isFinite(args.priceOut)) {
        const table = { ...(current.prices || {}) };
        const cur = { ...(table[nextModel] || {}) };
        if (Number.isFinite(args.priceIn)) cur.in = Number(args.priceIn);
        if (Number.isFinite(args.priceOut)) cur.out = Number(args.priceOut);
        table[nextModel] = cur;
        patch.prices = table;
        changed.push(`prices.${nextModel}`);
      }
      // 整表覆盖
      if (args.prices && typeof args.prices === 'object' && !Array.isArray(args.prices)) {
        patch.prices = args.prices;
        changed.push('prices（整表）');
      }

      if (changed.length === 0) {
        throw new Error('action=set 但没有任何可改的字段：至少传一个要改的值（例如 visionEnabled、visionModel、visionBaseUrl、priceIn/priceOut、bridgeBaseUrl）');
      }
      if (patch.bridgeRoot && !detectBridgeRoot([patch.bridgeRoot])) {
        throw new Error(`bridgeRoot 不像桥接目录（需要同时有 config.json、state/console-token、src/bridge.js）：${patch.bridgeRoot}`);
      }

      // 改前备份：整个 runtime.json 复制一份，写坏了能直接盖回去。
      let backupFile = '';
      try {
        const fs = await import('node:fs');
        const dir = path.join(PLUGIN_DIR, 'usage-backup');
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        backupFile = path.join(dir, `runtime.bak-${stamp}.json`);
        fs.writeFileSync(backupFile, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
      } catch (error) {
        backupFile = `（备份失败：${error?.message ?? error}）`;
      }

      const next = writeRuntimeOverride(patch);
      const rtNow = resolveRuntime({});
      return okResult(
        `已改 ${changed.length} 项（${changed.join('、')}）；改前备份 ${backupFile}；`
          + `现在视觉 ${rtNow.visionEnabled ? `开启 ${rtNow.visionModel}（计费）` : '关闭（零花费）'}`,
        {
          changed,
          backupFile,
          runtimeOverride: next,
          effective: {
            bridgeBaseUrl: rtNow.bridgeBaseUrl,
            visionEnabled: rtNow.visionEnabled,
            visionModel: rtNow.visionModel,
            prices: rtNow.prices
          }
        }
      );
    }
  };
}

function toolSelftest() {
  return {
    name: 'qq_vision_selftest',
    description: '绕开日常调用路径，把识图链路拆成五层逐层探：桥接连通 / 视觉凭据 / 免费 OCR / 视觉后端 / 账本可写。'
      + '一次调用就能看出"识图坏了"到底断在哪一层，返回每层的实测耗时和结果。'
      + '默认不花钱：paid=false 时视觉后端只检查配置、不发请求；想真验一次视觉模型再传 paid=true（会消耗 token 并记账）。'
      + '测试图是内嵌的 1006 字节 PNG，不依赖任何外部文件。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        paid: {
          type: 'boolean',
          description: 'true = 允许跑一次真花钱的视觉调用（默认 false，只检查配置）。visionEnabled=false 时这个参数无效'
        }
      }
    },
    output,
    timeoutMs: 120000,
    async execute(args, exec) {
      const rt = resolveRuntime({});
      const r = await selftest(rt, { paid: args.paid === true, signal: exec?.signal });
      const mark = (l) => (l.ok ? (l.skipped ? '○' : '✓') : '✗');
      const summary = r.ok
        ? `自检通过（${r.layers.length} 层，${r.skippedCount} 层跳过${r.billed ? '，本次真花了钱' : '，没花钱'}）`
        : `自检失败 ${r.failedCount} 层：${r.layers.filter((l) => !l.ok).map((l) => l.layer).join('、')}`;
      return okResult(summary, {
        ok: r.ok,
        visionEnabled: r.visionEnabled,
        visionModel: r.visionModel,
        billed: r.billed,
        layers: r.layers.map((l) => `${mark(l)} ${l.layer}：${l.detail}`),
        detail: r.layers,
        usageFile: r.usageFile,
        runtimeFile: r.runtimeFile
      });
    }
  };
}

function toolModels() {
  return {
    name: 'qq_vision_models',
    description: '列可选的视觉模型，附本机实测数据（同一张测试图的 token 用量和耗时），以及当前默认是哪个。'
      + '换模型不用重启：拿到名字后调 qq_vision_config action=set visionModel=<名字>。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output,
    timeoutMs: 30000,
    async execute() {
      const rt = resolveRuntime({});
      const rows = MODEL_CATALOG.map((m) => ({
        ...m,
        current: m.id === rt.visionModel,
        price: rt.prices?.[m.id] ?? null
      }));
      const summary = `共 ${rows.length} 个候选模型；当前默认 ${rt.visionModel}；视觉${rt.visionEnabled ? '已开启（计费）' : '已关闭（零花费，只用本地 OCR）'}`;
      return okResult(summary, {
        current: rt.visionModel,
        visionEnabled: rt.visionEnabled,
        models: rows,
        hint: '换模型：qq_vision_config action=set visionModel=<id>；单次临时换：调 qq_vision_describe 时传 model=<id>'
      });
    }
  };
}

function toolUsage() {
  return {
    name: 'qq_vision_usage',
    description: '查识图账单流水：每次真调用付费视觉模型都记一条（时间、模型、prompt/completion/total token、金额）。'
      + '用于回答「刚才那几次花了多少」。默认回最近 20 条。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: '回最近几条，默认 20，上限 200' },
        clear: { type: 'boolean', description: 'true = 清空账本（先自动备份到 usage-backup/）' }
      }
    },
    output,
    timeoutMs: 30000,
    async execute(args) {
      const rt = resolveRuntime({});

      if (args.clear === true) {
        let backupFile = '';
        try {
          const fs = await import('node:fs');
          const dir = path.join(PLUGIN_DIR, 'usage-backup');
          fs.mkdirSync(dir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
          backupFile = path.join(dir, `usage.bak-${stamp}.jsonl`);
          if (fs.existsSync(rt.usageFile)) fs.copyFileSync(rt.usageFile, backupFile);
          fs.writeFileSync(rt.usageFile, '', 'utf8');
        } catch (error) {
          backupFile = `（备份失败：${error?.message ?? error}）`;
        }
        return okResult(`账本已清空；清空前备份 ${backupFile}`, { cleared: true, backupFile, usageFile: rt.usageFile });
      }

      const limit = Math.min(200, Math.max(1, Number(args.limit) || 20));
      const usage = readUsage({ file: rt.usageFile, limit });
      const sumTokens = usage.rows.reduce((a, r) => a + (Number(r.totalTokens) || 0), 0);
      const sumCost = usage.rows.reduce((a, r) => a + (Number(r.cost) || 0), 0);
      const hasCost = usage.rows.some((r) => r.cost !== null && r.cost !== undefined);
      const summary = `账本共 ${usage.total} 条，本次回 ${usage.rows.length} 条；合计 ${sumTokens} tokens`
        + (hasCost ? `，约 ¥${sumCost.toFixed(6)}` : '，单价未配置所以不计金额');
      return okResult(summary, {
        usageFile: rt.usageFile,
        total: usage.total,
        returned: usage.rows.length,
        sumTokens,
        sumCost: hasCost ? Number(sumCost.toFixed(8)) : null,
        currency: 'CNY',
        prices: rt.prices,
        rows: usage.rows
      });
    }
  };
}

// ───────────────────────────── 注册 ─────────────────────────────

export function apply(ctx, config) {
  const rtRef = () => resolveRuntime(config || {});
  const report = (label, error) => {
    const detail = error instanceof Error ? error.message : String(error);
    const text = `[dsh-qq-vision] 注册工具 ${label} 失败：${detail}`;
    console.error(text);
    try {
      if (ctx?.logger && typeof ctx.logger.error === 'function') ctx.logger.error(text);
    } catch { /* logger 缺席不连坐 */ }
  };

  const factories = [
    ['qq_vision_describe', toolDescribe],
    ['qq_vision_describe_file', toolDescribeFile],
    ['qq_vision_status', toolStatus],
    ['qq_vision_config', toolConfig],
    ['qq_vision_selftest', toolSelftest],
    ['qq_vision_models', toolModels],
    ['qq_vision_usage', toolUsage]
  ];

  // 统一兜底：任何工具返回值都过一遍 sanitize，杜绝 undefined / NaN 让 DSH
  // 报 "invalid output: value is not lossless JSON"。
  const wrap = (tool) => {
    const raw = tool.execute;
    return {
      ...tool,
      async execute(args, exec) {
        const r = await raw(args, exec);
        if (!r || typeof r !== 'object') {
          return { ok: false, summary: `工具 ${tool.name} 返回了非对象（${typeof r}）`, data: {} };
        }
        return {
          ok: r.ok === true,
          summary: String(r.summary ?? ''),
          data: sanitize(r.data ?? {})
        };
      }
    };
  };

  const registered = [];
  for (const [label, factory] of factories) {
    try {
      ctx.tools.register(wrap(factory(rtRef)));
      registered.push(label);
    } catch (error) {
      // duplicate 说明已经注册过（热重载 / 重复 apply），不算失败。
      if (/duplicate/i.test(String(error?.message ?? error))) {
        registered.push(label);
        continue;
      }
      report(label, error);
    }
  }
  return { registered };
}

export const __internals = { OUTPUT_SCHEMA, renderResult, sanitize, toolDescribe, toolDescribeFile, toolStatus, toolConfig, toolSelftest, toolModels, toolUsage };
