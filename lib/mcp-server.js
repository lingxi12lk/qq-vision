#!/usr/bin/env node
// qq-vision 的 MCP 服务端：把「识图」能力以 MCP 工具的形式交给 DSH。
//
// 为什么单独起一个 MCP server，而不是只做 DSH 插件：
//   QQ 会话（qq-chat-v2 preset）不挂载任意 DSH 插件，它只认两条路：
//     (a) 前缀在 qq-tool-restrict.mjs 的 SAFE_PREFIXES 里（或 state/tool-allow.json 的 allowPrefixes 里）
//     (b) 控制台白名单 state/tool-allow.json 精确加白
//   MCP server 的 `mcp__<serverName>__<tool>` 命名空间正好能被 (a) 覆盖，
//   只要在 tool-allow.json 里写一条 "mcp__qq-vision__" 前缀，立即生效、不用重启 DSH、不用改源码。
//
// 为什么返回纯文字而不是 image 块（这是整个项目的核心）：
//   dsh-mcp-client/lib/index.js:299 用 inputModalities 做硬门槛，
//   模型不声明 image 输入就把图片投影成 "[image unavailable: ...]"。
//   我们在这里先把图看懂，只把文字交出去，门槛根本不会被触发。
//
// 启动方式（由 cordis.patch.yml 的 mcp-qq-vision 行拉起，stdio 传输）：
//   node E:\dsh-qq\qq-vision\lib\mcp-server.js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  resolveRuntime,
  describeMessage,
  describeImage,
  fetchMessageImages,
  extOfMime,
  mask,
  readUsage,
  selftest,
  MODEL_CATALOG
} from './vision.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 把结果包成 MCP 的 content 数组。永远只有 text，绝不返回 image 块。 */
function textResult(text) {
  return { content: [{ type: 'text', text: String(text ?? '') }] };
}

function errorResult(text) {
  return { content: [{ type: 'text', text: String(text ?? '') }], isError: true };
}

const server = new McpServer({ name: 'qq-vision', version: '0.1.0' });

// ─────────────────────────── 工具 1：按消息取图并识图 ───────────────────────────

server.tool(
  'qq_describe_image',
  '看一张 QQ 消息里的图片/表情，返回中文描述（画面内容 + 图里的文字）。'
    + '纯文本模型也能用：它先把图交给视觉模型或系统 OCR 看懂，再把文字结论给你，所以不依赖你自身是否支持图片输入。'
    + '当消息里有 [图片] / [表情] / hasMedia 时调它，不要假装看得到、也不要编造内容。'
    + '计费：视觉模型默认关闭，只走免费本地 OCR；结果末尾会带【本次计费】行。要用付费模型先确认 visionEnabled，并可用 model 参数指定。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    messageId: z.union([z.number(), z.string()]).describe('消息 id（QQ 消息 id 可为负数；二代也可用本地 seq）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 下必填，见唤醒提示里的【会话令牌】）'),
    prompt: z.string().optional().describe('自定义提问。不填用默认（描述画面 + 抄写图里文字 + 判断是不是表情包）'),
    limit: z.number().int().min(1).max(5).optional().describe('最多识别几张，默认 3'),
    preferOcr: z.boolean().optional().describe('true = 强制只用系统 OCR（离线、只出文字、零花费）'),
    model: z.string().optional().describe('单次指定视觉模型：qwen3.5-omni-flash（默认最便宜）、qwen3-vl-plus（最详细）、qwen-vl-ocr（纯文字）。不传用配置里的默认模型')
  },
  async ({ key, messageId, token, prompt, limit, preferOcr, model }) => {
    try {
      const rt = resolveRuntime({});
      const result = await describeMessage(rt, {
        key,
        messageId,
        agentToken: token,
        prompt,
        limit: limit ?? 3,
        preferOcr: preferOcr === true,
        model
      });
      if (!result.ok) return errorResult(result.text);
      return textResult(`消息 ${result.messageId} 的图片内容：\n${result.text}`);
    } catch (error) {
      return errorResult(`识图失败：${error?.message ?? error}`);
    }
  }
);

// ─────────────────────────── 工具 2：本地图片文件识图 ───────────────────────────

server.tool(
  'qq_describe_file',
  '看一张本地图片文件（png/jpg/webp/gif/bmp），返回中文描述。'
    + '用于桥接目录里的表情包、截图、生成的图等；纯文本模型也能用。'
    + '计费：视觉模型默认关闭，只走免费本地 OCR；结果会标明走了哪条路和 token 用量。',
  {
    path: z.string().describe('图片文件的绝对路径'),
    prompt: z.string().optional().describe('自定义提问，不填用默认'),
    preferOcr: z.boolean().optional().describe('true = 强制只用系统 OCR（零花费）'),
    model: z.string().optional().describe('单次指定视觉模型：qwen3.5-omni-flash（默认最便宜）、qwen3-vl-plus（最详细）、qwen-vl-ocr（纯文字）')
  },
  async ({ path: filePath, prompt, preferOcr, model }) => {
    try {
      const fs = await import('node:fs/promises');
      const bytes = await fs.readFile(filePath);
      const { sniffMime } = await import('./vision.js');
      const mimeType = sniffMime(bytes) || 'image/png';
      const rt = resolveRuntime({});
      const described = await describeImage(rt, { bytes, mimeType, prompt, preferOcr: preferOcr === true, model });
      if (!described.ok) return errorResult(`没看懂 ${filePath}：${described.error || '未知原因'}`);
      const via = described.mode === 'vision'
        ? `视觉模型 ${described.model}，${described.billing?.totalTokens ?? '?'} tokens（计费）`
        : `系统 OCR（${described.lang}，免费）`;
      let text = `${filePath}（${mimeType}，${bytes.length} 字节，${via}）：\n${described.text}`;
      if (described.ocrText) text += `\nOCR 补充文字：${described.ocrText}`;
      return textResult(text);
    } catch (error) {
      return errorResult(`识图失败：${error?.message ?? error}`);
    }
  }
);

// ─────────────────────────── 工具 3：只看链路状态 ───────────────────────────

server.tool(
  'qq_vision_status',
  '查识图链路是否可用：桥接是否连得上、视觉后端配没配 key、用的是哪个模型、OCR 脚本在不在。'
    + '识图失败时先跑它，能直接看出是哪一环断了。',
  {},
  async () => {
    const rt = resolveRuntime({});
    const lines = [];
    lines.push(`桥接地址：${rt.bridgeBaseUrl}`);
    lines.push(`桥接根目录：${rt.bridgeRoot || '（没找到）'}`);
    lines.push(`控制台令牌：${rt.consoleToken ? `${mask(rt.consoleToken)}（来源 ${rt.tokenSource}）` : '（没读到）'}`);
    lines.push(`视觉后端：${rt.visionBaseUrl}`);
    lines.push(`视觉开关：${rt.visionEnabled ? '已开启（会按 token 计费）' : '已关闭（只走免费 OCR，零花费）'}`);
    lines.push(`视觉模型：${rt.visionModel}`);
    lines.push(`视觉 key：${rt.visionApiKey ? `${mask(rt.visionApiKey)}（来源 ${rt.visionApiKeyVia}）` : `（没有，检查 ${rt.visionApiKeyEnv}）`}`);

    // 探一下桥接
    try {
      const res = await fetch(new URL('/api/status', rt.bridgeBaseUrl), {
        headers: rt.consoleToken ? { 'x-console-token': rt.consoleToken } : {},
        signal: AbortSignal.timeout(8000)
      });
      lines.push(`桥接连通：${res.ok ? '在线' : `HTTP ${res.status}`}`);
    } catch (error) {
      lines.push(`桥接连通：连不上（${error?.message ?? error}）`);
    }

    // OCR 脚本
    try {
      const fs = await import('node:fs');
      const script = path.join(HERE, 'ocr.ps1');
      const exists = fs.existsSync(script);
      lines.push(`OCR 脚本：${exists ? script : '缺失'}`);
      if (exists) {
        const buf = fs.readFileSync(script);
        const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
        lines.push(`OCR 脚本 BOM：${hasBom ? '有（正确）' : '没有（PS 5.1 会按 GBK 解码中文而语法报错）'}`);
      }
    } catch { /* 忽略 */ }

    return textResult(lines.join('\n'));
  }
);

// ─────────────────────────── 工具 4：模型菜单 ───────────────────────────

server.tool(
  'qq_vision_models',
  '列可选的视觉模型，附本机实测数据（同一张测试图的 token 用量和耗时），并标出当前默认是哪个。'
    + '换模型不用重启：qq_vision_config action=set visionModel=<id>；单次临时换：qq_describe_file 传 model=<id>。',
  {},
  async () => {
    const rt = resolveRuntime({});
    const lines = [];
    lines.push(`当前默认模型：${rt.visionModel}`);
    lines.push(`视觉开关：${rt.visionEnabled ? '已开启（按 token 计费）' : '已关闭（只走免费 OCR，零花费）'}`);
    lines.push('');
    lines.push('可选模型（实测数据来自同一张 320×160 测试图）：');
    for (const m of MODEL_CATALOG) {
      const mark = m.id === rt.visionModel ? ' ← 当前' : '';
      const price = rt.prices?.[m.id];
      const priceText = price ? `，单价 in ${price.in ?? '?'} / out ${price.out ?? '?'} 元每百万 token` : '，单价未配置';
      lines.push(`  ${m.id}${mark}`);
      lines.push(`    ${m.label}｜${m.strength}`);
      lines.push(`    实测：${m.measured.total} tokens（in ${m.measured.prompt} / out ${m.measured.completion}），${m.measured.ms}ms${priceText}`);
      if (m.note) lines.push(`    备注：${m.note}`);
    }
    return textResult(lines.join('\n'));
  }
);

// ─────────────────────────── 工具 5：账单流水 ───────────────────────────

server.tool(
  'qq_vision_usage',
  '查识图账单流水：每次真调用付费视觉模型都记一条（时间、模型、token、金额）。用于回答「刚才那几次花了多少」。',
  {
    limit: z.number().int().min(1).max(200).optional().describe('回最近几条，默认 20')
  },
  async ({ limit }) => {
    const rt = resolveRuntime({});
    const usage = readUsage({ file: rt.usageFile, limit: limit ?? 20 });
    if (usage.total === 0) {
      return textResult(`账本还是空的（${rt.usageFile}）。这说明至今没有调用过付费视觉模型 —— 所有识图都走免费 OCR。`);
    }
    const sumTokens = usage.rows.reduce((a, r) => a + (Number(r.totalTokens) || 0), 0);
    const hasCost = usage.rows.some((r) => r.cost !== null && r.cost !== undefined);
    const sumCost = usage.rows.reduce((a, r) => a + (Number(r.cost) || 0), 0);
    const lines = [];
    lines.push(`账本共 ${usage.total} 条，回最近 ${usage.rows.length} 条`);
    lines.push(`合计 ${sumTokens} tokens${hasCost ? `，约 ¥${sumCost.toFixed(6)}` : '（单价未配置，只记 token 不计金额）'}`);
    lines.push('');
    for (const r of usage.rows) {
      const when = String(r.at ?? '').replace('T', ' ').slice(0, 19);
      const cost = r.cost === null || r.cost === undefined ? '未计价' : `¥${Number(r.cost).toFixed(6)}`;
      lines.push(`  ${when}  ${r.model}  ${r.totalTokens ?? '?'} tok（in ${r.promptTokens ?? '?'} / out ${r.completionTokens ?? '?'}）  ${cost}  ${r.ms ?? '?'}ms`);
    }
    return textResult(lines.join('\n'));
  }
);

// ─────────────────────────── 工具 6：改配置 ───────────────────────────
server.tool(
  'qq_vision_config',
  '读/改识图配置（完全自定义）：视觉开关、模型、后端地址、key 来源、提示词、超时、单图上限、单价表。'
    + 'action=get 读现状（key 打码，revealKey=true 才回显）；action=set 只改传了的字段，改前自动备份到 usage-backup/。'
    + '写进 runtime.json，立即生效，不用重启 DSH。',
  {
    action: z.enum(['get', 'set']).describe('get=读，set=改'),
    revealKey: z.boolean().optional().describe('get 时回显 key 明文（默认打码）'),
    bridgeBaseUrl: z.string().optional().describe('桥接地址，如 http://127.0.0.1:3200'),
    bridgeRoot: z.string().optional().describe('桥接根目录'),
    visionEnabled: z.boolean().optional().describe('视觉总开关。false=只用免费 OCR（默认）；true=调付费模型'),
    visionBaseUrl: z.string().optional().describe('视觉后端根地址'),
    visionModel: z.string().optional().describe('默认视觉模型名'),
    visionApiKey: z.string().optional().describe('视觉后端 key 明文，留空按 visionApiKeyEnv 找'),
    visionApiKeyEnv: z.string().optional().describe('从哪个环境变量/凭据名取 key，默认 BAILIAN_API_KEY'),
    prompt: z.string().optional().describe('默认识图提示词'),
    timeoutMs: z.number().optional().describe('视觉请求超时（毫秒）'),
    maxImageBytes: z.number().optional().describe('单图字节上限'),
    priceIn: z.number().optional().describe('给当前模型配输入单价（元/百万 token）'),
    priceOut: z.number().optional().describe('给当前模型配输出单价（元/百万 token）')
  },
  async (args) => {
    const { __internals } = await import('./index.js');
    try {
      const tool = __internals.toolConfig();
      const r = await tool.execute(args);
      return textResult(`${r.summary}\n\n${JSON.stringify(r.data, null, 2)}`);
    } catch (error) {
      return errorResult(`改配置失败：${error?.message ?? error}`);
    }
  }
);

// ─────────────────────────── 工具 7：自检 ───────────────────────────

server.tool(
  'qq_vision_selftest',
  '绕开日常调用路径，把识图链路拆成五层逐层探：桥接连通 / 视觉凭据 / 免费 OCR / 视觉后端 / 账本可写。'
    + '一次调用就能看出「识图坏了」断在哪一层。默认不花钱（paid=false 只查配置）；paid=true 才真打一次视觉模型（会记账）。'
    + '测试图是内嵌的 1006 字节 PNG，不依赖外部文件。',
  {
    paid: z.boolean().optional().describe('true=允许真花钱跑一次视觉调用（默认 false）。visionEnabled=false 时无效')
  },
  async ({ paid }) => {
    const rt = resolveRuntime({});
    try {
      const r = await selftest(rt, { paid: paid === true });
      const mark = (l) => (l.ok ? (l.skipped ? '○' : '✓') : '✗');
      const lines = [];
      lines.push(r.ok
        ? `自检通过（${r.layers.length} 层，${r.skippedCount} 层跳过${r.billed ? '，本次真花了钱' : '，没花钱'}）`
        : `自检失败 ${r.failedCount} 层：${r.layers.filter((l) => !l.ok).map((l) => l.layer).join('、')}`);
      lines.push(`视觉开关：${r.visionEnabled ? `已开启（模型 ${r.visionModel}，按 token 计费）` : '已关闭（只走免费 OCR，零花费）'}`);
      lines.push('');
      for (const l of r.layers) lines.push(`  ${mark(l)} ${l.layer}：${l.detail}`);
      lines.push('');
      lines.push(`账本：${r.usageFile}`);
      lines.push(`配置：${r.runtimeFile}`);
      return textResult(lines.join('\n'));
    } catch (error) {
      return errorResult(`自检本身出错：${error?.message ?? error}`);
    }
  }
);

// ─────────────────────────── 启动 ───────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
