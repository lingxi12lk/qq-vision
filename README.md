# dsh-qq-vision

给 QQ 桥接接上「眼睛」：消息里的图片/表情先被看懂，再把**文字**交给模型。

## 为什么需要它

DSH 有一条硬门槛：MCP 工具如果返回 `{type:'image', ...}` 内容块，而当前模型没声明
`inputModalities` 含 `image`，客户端会直接把整块图投影成一行文字：

```
[image unavailable: image/gif; model "xxx" does not declare image input; raw image data remains available to programmatic callers]
```

见 `@deepseek-ai/dsh-mcp-client/lib/index.js:299`：

```js
if (info.inputModalities === void 0 || !info.inputModalities.includes("image")) {
  throw new Error(`model "${model}" does not declare image input`);
}
```

原来的 `mcp__snowluma__qq_get_message_images` 就是踩在这条上——图取回来了（日志里 `ok:true`、
37KB base64），但模型只看到表情的 `summary` 文字，画面内容完全看不见。

**本插件的做法：不跟门槛硬碰，在模型外面先把图看懂，只把文字交出去。**
返回内容里永远只有 `{type:'text'}` 块，从不返回 image 块。

## 三层结构

```
lib/vision.js      核心能力（零第三方依赖，只用 node: 内置模块 + 本仓库文件）
lib/ocr.ps1        Windows WinRT OCR 包装（离线兜底，只出文字）
lib/mcp-server.js  MCP server —— 给 QQ 会话用（走 mcp__qq-vision__ 命名空间）
lib/index.js       DSH 插件 —— 给当前 DSH 会话用（注册 7 个工具）
```

为什么拆成 MCP + 插件两份：QQ 会话（`qq-chat-v2` preset）不挂载任意 DSH 插件，
`qq-tool-restrict.mjs` 的执行期白名单只认两种东西 —— 内置 `SAFE_PREFIXES` 里的前缀，
或 `state/tool-allow.json` 里的精确/前缀加白。MCP 的 `mcp__<serverName>__<tool>` 命名空间
正好是第一种。插件那一份是给主会话（也就是你现在这个）用的。

## 识别链路

1. **取图**：`GET /api/images/message?key=...&messageId=...`，带 `x-console-token` + `x-agent-token` + `x-agent-call: 1`
2. **看图**（两条路，视觉优先、OCR 兜底）：
   - 视觉模型：默认 `qwen3.5-omni-flash`（`visionEnabled=false` 时整条路跳过），`POST {visionBaseUrl}/chat/completions`，图片走 `data:<mime>;base64,...`
   - Windows OCR：`Windows.Media.Ocr`，离线，只出文字
   - 视觉成功之后**再补一刀 OCR** 存进 `ocrText`，图里的小字不容易漏
3. **回灌**：结果拼成纯文字，形如
   ```
   【图片1】（视觉模型 qwen3.5-omni-flash，209 tokens）

   1) 画面里有一只闭着眼睛、脸颊微红、举起一只爪子的卡通小猫，旁边有一个写着"好的"的对话气泡。
   2) 好的
   3) 这是一个聊天表情包，用于乖巧地表示同意、答应或确认。

   【本次计费】调用付费视觉模型 1 次，合计 209 tokens（模型 qwen3.5-omni-flash）
   ```

## 工具

### MCP（QQ 会话，工具名带 `mcp__qq-vision__` 前缀）

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `qq_describe_image` | `key`、`messageId`、`token`、`prompt`、`limit`(1–5)、`preferOcr`、`model` | 看一条 QQ 消息里的图片/表情 |
| `qq_describe_file` | `path`、`prompt`、`preferOcr`、`model` | 看本地图片文件 |
| `qq_vision_status` | — | 自检：桥接、令牌、视觉后端、key 来源、视觉开关、OCR 脚本 BOM |
| `qq_vision_models` | — | 模型菜单 + 本机实测 token/耗时 + 当前单价 |
| `qq_vision_usage` | `limit`(1–200) | 账单流水：每次付费调用一条 |
| `qq_vision_config` | `action` + 十几个字段 | 读/改配置，改前自动备份 |
| `qq_vision_selftest` | `paid` | 五层自检（桥接/凭据/OCR/视觉/账本），默认不花钱 |

### DSH 插件（主会话）

`qq_vision_describe`、`qq_vision_describe_file`、`qq_vision_status`、`qq_vision_config`、
`qq_vision_models`、`qq_vision_usage`、`qq_vision_selftest` —— 七个，与 MCP 一一对应。

## 自检

`qq_vision_selftest` 绕开日常调用路径，把链路拆成五层逐层探，一次就能看出「识图坏了」断在哪：

| 层 | 探什么 | 怎么判 |
| --- | --- | --- |
| 桥接 | `GET {bridgeBaseUrl}/api/status` | HTTP 200 |
| 视觉凭据 | key 有没有、从哪来 | 打码显示来源 |
| 免费 OCR | 真跑一次 WinRT OCR | 认出内嵌测试图上的「OK 123」 |
| 视觉后端 | 配置 + （可选）真调一次 | `visionEnabled=false` 直接跳过；`paid=true` 才真发请求并记账 |
| 账本 | 目录可写 + 现有行数 | `fs.accessSync(W_OK)`，**不往真实账本写探针** |

测试图是内嵌的 1006 字节 PNG（`lib/selftest-fixture.js`），不依赖任何外部文件，所以在任何目录、任何机器上跑结果都一样。

```js
qq_vision_selftest({})              // 默认 paid=false：只查配置，零花费
qq_vision_selftest({ paid: true })  // 真调一次视觉模型（会记账），验证付费路径
```

## 完全自定义

跟 `qq-voice` 一个形状：所有可调项都从工具参数暴露，不用手改文件。

```js
// 读现状（key 默认打码）
qq_vision_config({ action: 'get' })
qq_vision_config({ action: 'get', revealKey: true })   // 才看明文

// 改（只改传了的字段，其余不动；改前自动备份到 usage-backup/）
qq_vision_config({ action: 'set', visionEnabled: true })
qq_vision_config({ action: 'set', visionModel: 'qwen3-vl-plus' })
qq_vision_config({ action: 'set', priceIn: 0.3, priceOut: 1.2 })
```

可改字段：`bridgeBaseUrl`、`bridgeRoot`、`consoleToken`、`visionEnabled`、`visionBaseUrl`、
`visionModel`、`visionApiKey`、`visionApiKeyEnv`、`prompt`、`timeoutMs`、`maxImageBytes`、
`priceIn`/`priceOut`（按当前模型配单价）、`prices`（整表覆盖）。

全部写进插件目录的 `runtime.json`，**改完立即生效，不用重启 DSH**。

## 计费透明化

`visionEnabled` 默认 `false`：只走免费本地 OCR，零花费。设 `true` 才会调付费模型。

每次真正调用付费模型都做三件事：

1. 结果文本末尾追加一行 `【本次计费】调用付费视觉模型 N 次，合计 X tokens，约 ¥Y（模型 Z）`
2. 返回结构里带 `billing: { paid, model, promptTokens, completionTokens, totalTokens, cost, currency }`
3. 往 `usage.jsonl` 追加一条流水，用 `qq_vision_usage` 随时翻

单价没有硬编码 —— 百炼价格随时调，编个数字比不写更糟。不配单价时账本照实记 token，
金额栏留空并明说「单价未配置」。配了才折成钱。

**2026-10-31 实测（同一张 320×160 测试图）**

| 模型 | prompt | completion | total | 耗时 | 评价 |
| --- | --- | --- | --- | --- | --- |
| `qwen3.5-omni-flash` | 152 | 57 | 209 | 1172ms | 默认，描述完整 |
| `qwen3-vl-plus` | 168 | 119 | 287 | 3575ms | 描述最细，最慢最贵 |
| `qwen-vl-ocr` | 146 | 18 | 164 | 376ms | 只出文字，最快 |
| `qwen3.7-plus` | 94 | 91 | 185 | 2073ms | 已停用：不在大学生券范围，输出啰嗦 |

## 配置优先级

```
runtime.json  >  cordis.patch.yml 的 config  >  环境变量  >  自动探测
```

| 键 | 环境变量 | 默认 |
| --- | --- | --- |
| `bridgeBaseUrl` | `QQ_BRIDGE_BASE_URL` | `http://127.0.0.1:3200` |
| `bridgeRoot` | `QQ_BRIDGE_ROOT` | 按 `ROOT_CANDIDATES` 探测 |
| `consoleToken` | `QQ_BRIDGE_CONSOLE_TOKEN` | `<bridgeRoot>/state/console-token` |
| `visionEnabled` | — | `false`（只用免费 OCR） |
| `visionBaseUrl` | — | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `visionModel` | — | `qwen3.5-omni-flash` |
| `visionApiKey` | 由 `visionApiKeyEnv` 指定，默认 `BAILIAN_API_KEY` | 从 `~/.dsh/.credentials.yaml` 的 `refs:` 段读 |
| `prices` | — | `{}`（空 = 只记 token 不计金额） |
| `timeoutMs` | — | 90000 |
| `maxImageBytes` | — | 8388608（8 MB） |

`ROOT_CANDIDATES` 顺序（`detectBridgeRoot` 依次试，第一个「像桥接」的胜出）：

0. 环境变量 `QQ_BRIDGE_ROOT` / `DSH_QQ_BRIDGE_ROOT`（**换机器请用这个，或直接 `qq_vision_config action=set bridgeRoot=<路径>`**）
1. `E:\dsh-qq\qq-bridge-v2`
2. `E:\qq-bridge\qq-bridge-enhanced-v1.1.2`
3. `E:\qq-bridge-enhanced\qq-bridge-enhanced-v1.1.0`
4. `E:\qq-bridge-enhanced`
5. `E:\qq-bridge\qq-bridge-0.2.1-r1`
6. `E:\qq-bridge`

「像桥接」的判据：目录里同时存在 `config.json`、`state/console-token`、`src/bridge.js`。
硬编码那几个只是为了让「装在本机默认位置」的人零配置可用，不是唯一解。

## 设计上的几个决定

**为什么视觉 key 要手工解析 `.credentials.yaml`，不引 yaml 依赖**
实测本机进程级/用户级/机器级环境变量里一个 `*_KEY` 都没有 —— DSH 只在它自己 spawn 的
子进程里注入。`vision.js` 用 6 行正则扫 `refs:` 段就够了，不值得为此拉一个 yaml 包
（它还要同时被插件、MCP server、测试三处调用）。

**为什么 OCR 写文件而不是读 stdout**
`powershell.exe` 子进程的 stdout 在中文环境按 GBK 回传，node 侧读出来是
`�� �� �� ��`。所以 `ocr.ps1` 把结果写 UTF-8 文件，node 读文件；`spawn` 的
`stdio` 干脆设成 `['ignore','ignore','pipe']`，只收 stderr。

**为什么 `ocr.ps1` 必须带 BOM**
PowerShell 5.1 读无 BOM 的 .ps1 会按 GBK 解码，中文注释直接导致解析错位，
报的是 `The Try statement is missing its Catch or Finally block.` 这类莫名其妙的语法错。
smoke 测试里有一条断言专门守着这件事。

**为什么 `sniffMime` 要自己嗅文件头**
桥接把 gif 表情标成 `image/jpeg`（`mimeType: "image/gif"` 和文件名 `.jpg` 同时存在）。
信它就会把 gif 当 jpeg 发给视觉模型，所以按文件头重新判，`length < 12` 一律返回 null。

**为什么 `bridgeCall` 不带 Origin 头**
桥接的 CSRF 逻辑是「带了 Origin 才校验同源」。不带就不校验，正好。

## 安装

本仓库可以直接 `git clone` 到任意目录。两种装法：

**A. 作为 DSH 插件（主会话可见 7 个 `qq_vision_*` 工具）**

```powershell
cd $HOME\.dsh\profiles\desktop
npm install link:<本仓库路径>          # 或手工在 package.json 里加 "dsh-qq-vision": "link:<路径>"
# 再把 "dsh-qq-vision" 加进 package.json 的 dsh.profile.bundles 数组
```

**B. 作为 MCP server（QQ 会话可见 `mcp__qq-vision__*`）**

在 profile 的 `cordis.patch.yml` 里加一条 MCP 客户端：

```yaml
- insert:
    - id: mcp-qq-vision
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: qq-vision
        transport: stdio
        command: node
        args: ['<本仓库路径>/lib/mcp-server.js']
        toolCallTimeoutMs: 300000
```

MCP server 需要 `@modelcontextprotocol/sdk` 与 `zod`（DSH 自带的 profile 里已有，可直接 junction 复用；也可以在本仓库 `npm i` 一份）。

工具白名单（只对 QQ 会话生效）：`state/tool-allow.json` 的 `allowPrefixes` 加 `mcp__qq-vision__`，
或把 7 个工具名逐个加进 `allow`。`qq-tool-restrict.mjs` 的内置 `SAFE_PREFIXES` 里也有同一个前缀，
两处都留着是为了「即使控制台白名单被清空，识图也不会突然消失」。

## 测试

```powershell
cd <本仓库路径>
node test\smoke.mjs            # 不联网不碰桥接（37 项）
node test\deep.mjs             # 真连桥接、真识图、真走 MCP（22 项 + 1 跳过）
node test\verify-billing.mjs   # 断言不花钱的两条路径都不产生付费调用
node test\verify-model-pick.mjs # 三模型对照，打印 token/耗时（会花钱）
node test\verify-custom.mjs    # 21 项：models / config get-set-备份 / usage 记账清空
node test\verify-mcp-tools.mjs # MCP 七个工具都注册上了
node test\verify-mcp-calls.mjs # MCP 真调 models/usage/config 三个新工具
```

`deep.mjs` 需要桥接在线（默认 `127.0.0.1:3200`）。桥接会自动重启，偶发连不上时重跑即可。
`verify-model-pick.mjs` 与 `deep.mjs` 的部分用例会真调付费模型并记账，跑之前确认 `visionEnabled` 的状态符合预期。

## 已知边界

- **只认 Windows OCR**：`ocrWithWindows` 在非 win32 平台直接抛错，视觉后端那条路不受影响。
- **视觉后端只实现 OpenAI 兼容的 `/chat/completions`**：换别的协议要改 `describeWithVision`。
- **模型菜单是硬编码的四个**：`MODEL_CATALOG` 里只有本机实测过的四个。传别的模型名照样能发出去（不当白名单用），但 `qq_vision_models` 不会列出来。
- **单价要自己填**：百炼价格随时调，插件不猜。不填只记 token，不折算金额。
- **一次最多看 5 张**（`limit` 上限），再多就分批。
