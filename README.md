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
lib/index.js       DSH 插件 host 半边 —— 7 个工具 + 一条 /dsh-qq-vision-api 路由
client.js          DSH 插件 client 半边 —— 设置页「QQ 识图」面板 + 插件页配置
```

为什么拆成 MCP + 插件两份：QQ 会话（`qq-chat-v2` preset）不挂载任意 DSH 插件，
`qq-tool-restrict.mjs` 的执行期白名单只认两种东西 —— 内置 `SAFE_PREFIXES` 里的前缀，
或 `state/tool-allow.json` 里的精确/前缀加白。MCP 的 `mcp__<serverName>__<tool>` 命名空间
正好是第一种。插件那一份是给主会话（也就是你现在这个）用的。

## 识别链路

1. **取图**：`GET /api/images/message?key=...&messageId=...`，带 `x-console-token` + `x-agent-token` + `x-agent-call: 1`
2. **看图**（两条路，视觉优先、OCR 兜底）：
   - 视觉模型：两种后端任选
     - **WorkBuddy**（默认）：`POST https://copilot.tencent.com/v2/chat/completions`，模型 `deepseek-v4.1-flash`，
       强制 SSE 流式；token 从 `~/.dsh/workbuddy-vault/<区>/<uid>.json` 读，快过期自动刷新并回写 vault
     - **百炼 DashScope**：`POST {visionBaseUrl}/chat/completions`，模型 `qwen3.5-omni-flash`，非流式
     - 两条都用 `data:<mime>;base64,...` 传图（OpenAI 风格 `image_url` 内容块）
   - Windows OCR：`Windows.Media.Ocr`，离线，只出文字
   - 视觉成功之后**再补一刀 OCR** 存进 `ocrText`，图里的小字不容易漏
3. **回灌**：结果拼成纯文字，形如
   ```
   【图片1】（WorkBuddy 视觉模型 deepseek-v4.1-flash，245 tokens）

   1) 画面里有一只闭着眼睛、脸颊微红、举起一只爪子的卡通小猫，旁边有一个写着"好的"的对话气泡。
   2) 好的
   3) 这是一个聊天表情包，用于乖巧地表示同意、答应或确认。

   【本次计费】调用付费视觉模型 1 次，合计 245 tokens，合计 0 credit（促销期免费）（模型 WorkBuddy deepseek-v4.1-flash）
   ```

## 工具

### MCP（QQ 会话，工具名带 `mcp__qq-vision__` 前缀）

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `qq_describe_image` | `key`、`messageId`、`token`、`prompt`、`limit`(1–5)、`preferOcr`、`model` | 看一条 QQ 消息里的图片/表情 |
| `qq_describe_file` | `path`、`prompt`、`preferOcr`、`model` | 看本地图片文件 |
| `qq_vision_status` | — | 自检：桥接、令牌、视觉后端、key 来源、视觉开关、OCR 脚本 BOM |
| `qq_vision_models` | `refresh`(true=跳过 60s 缓存重扫) | 扫描 DSH 已注册的 provider/模型 + 本机实测 token/耗时 + 当前单价 |
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

## 设置页面板

跟 `qq-voice` 一个形状，除了工具，还有可视化面板，不用背参数：

- **设置 → QQ 识图**（`settings.section`，order 37，排在「QQ 语音」35 后面）
- **插件列表 → dsh-qq-vision**（`plugins.bundle.config`，key = 包名）

面板里七张卡：

| 卡 | 能做什么 |
| --- | --- |
| 识图链路 | 一眼看桥接在不在、OCR 脚本在不在、视觉开关状态 |
| 视觉模型 | **扫描 DSH 已注册的全部 provider/模型**（下拉按后端分组），带本机实测 token/耗时，点一下切换，当前用的高亮 |
| 后端与凭据 | 改后端地址、key 来源、超时、单图上限；key 默认打码，点「显示」才明文 |
| 识图测试 | 贴本地图片路径直接跑一次（`preferOcr` 勾上 = 零花费） |
| 五层自检 | 一次跑完五层，逐层给绿/红与耗时；付费层要单独勾「允许花钱」 |
| 账单 | 最近 N 条流水：时间、模型、prompt/completion token、金额 |
| 单价 | 按模型配「元/百万 token」，配了账单才会折成金额 |

面板数据全走 host 侧一条同源路由 `GET/POST /dsh-qq-vision-api`：

- **只认 loopback Host**（`127.0.0.1`、`localhost`、`[::1]`、`0.0.0.0`、IPv4 字面量、方括号 IPv6），
  域名 Host 一律 403 —— 挡 DNS rebinding。
- POST 只转发 `WEB_TOOL_ALLOW` 白名单里的 7 个工具，别的一律 403。
- 改配置同样写 `runtime.json`，**改完立即生效，不用重启**；只有改 `client.js` 本身才需要重启 DSH。

## 完全自定义

跟 `qq-voice` 一个形状：所有可调项都从工具参数暴露，不用手改文件。

```js
// 读现状（key 默认打码）
qq_vision_config({ action: 'get' })
qq_vision_config({ action: 'get', revealKey: true })   // 才看明文

// 改（只改传了的字段，其余不动；改前自动备份到 usage-backup/）
qq_vision_config({ action: 'set', visionEnabled: true })
qq_vision_config({ action: 'set', visionProvider: 'workbuddy' })
qq_vision_config({ action: 'set', visionModel: 'deepseek-v4.1-flash' })
qq_vision_config({ action: 'set', visionProvider: 'bailian', visionModel: 'qwen3-vl-plus' })
qq_vision_config({ action: 'set', priceIn: 0.3, priceOut: 1.2 })
```

可改字段：`bridgeBaseUrl`、`bridgeRoot`、`consoleToken`、`visionProvider`、`visionEnabled`、
`visionBaseUrl`、`visionModel`、`visionApiKey`、`visionApiKeyEnv`、`visionVault`、`visionRegion`、
`prompt`、`timeoutMs`、`maxImageBytes`、`priceIn`/`priceOut`（按当前模型配单价）、`prices`（整表覆盖）。

全部写进插件目录的 `runtime.json`，**改完立即生效，不用重启 DSH**。

## 两种视觉后端

| | **WorkBuddy**（默认） | **百炼 DashScope** |
| --- | --- | --- |
| 上游地址 | `https://copilot.tencent.com`（CN）/ `https://www.workbuddy.ai`（国际） | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 推荐模型 | `deepseek-v4.1-flash` | `qwen3.5-omni-flash` |
| 凭据来源 | `~/.dsh/workbuddy-vault/<区>/<uid>.json` 里的 `accessToken` | `visionApiKey` / 环境变量 / `~/.dsh/.credentials.yaml#refs` |
| 协议 | **强制 SSE 流式**（网关硬要求），解析 `delta.content` | 非流式，一次返回 `choices[0].message.content` |
| 计费 | credit（促销期常为 0），上游在 `usage.credit` 里报 | 人民币，按 token × 单价表 |
| token 过期 | 401/403 时自动调 `/v2/plugin/auth/token/refresh` 刷新并**回写 vault** | 无（key 长期有效） |
| 切后端 | `qq_vision_config action=set visionProvider=workbuddy` | `action=set visionProvider=bailian` |

WorkBuddy 那条路要带的头比 OpenAI 多：`X-User-Id`、`X-No-Enterprise-Id: 1`、`X-Domain`、
`X-Product: SaaS`，外加每请求现生成的会话三连 `X-Conversation-ID` /
`X-Conversation-Request-ID` / `X-Conversation-Message-ID`。少一个就 4xx。

> **refreshToken 会轮换**：刷新一次旧的 refreshToken 立即作废，所以刷新成功后必须原子回写
> vault（tmp + rename），否则下次刷新会 401。这一步 `refreshWorkBuddyToken` 已经做了。

### 第三种后端：任意 OpenAI 兼容网关

协议只有两种（WorkBuddy 的 SSE、OpenAI 的 `/chat/completions`），所以 DSH 里那些 OpenAI 兼容的
第三方 provider（比如 `baomiao-oneapi`）会自动归到 `bailian` 这一支发出去 —— 只要在模型下拉里选中它，
插件会把该 provider 的 `defaultBaseURL` 和 `baseURLEnv` 一起写进 `visionBaseUrl` / `visionApiKeyEnv`，
不用手填地址（填错就是 404）。归类规则见 `lib/model-scan.js` 的 `backendOfRoute`：
路由名含 `workbuddy` / `codebuddy` → WorkBuddy 协议，其余 → OpenAI 兼容协议。

## 计费透明化

`visionEnabled` 出厂默认 `false`（只走免费本地 OCR）；本机 runtime.json 现为 `true`。

每次真正调用付费模型都做三件事：

1. 结果文本末尾追加一行 `【本次计费】调用付费视觉模型 N 次，合计 X tokens，…（模型 Z）`
   —— WorkBuddy 报 credit，百炼报人民币
2. 返回结构里带 `billing: { paid, model, provider, providerLabel, baseUrl, promptTokens, completionTokens, totalTokens, cost, credit, currency }`
3. 往 `usage.jsonl` 追加一条流水（含 `provider` / `baseUrl` / `credit`），用 `qq_vision_usage` 随时翻

单价没有硬编码 —— 价格随时调，编个数字比不写更糟。不配单价时账本照实记 token，
金额栏留空并明说「单价未配置」。配了才折成钱。WorkBuddy 只要上游报了 credit 就直接报 credit，
不落回「单价未配置」。

**实测（同一张 400×140 测试图，2026-11-04）**

| 后端 | 模型 | prompt | completion | total | 耗时 | credit | 评价 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WorkBuddy | `deepseek-v4.1-flash` | 211 | 34 | 245 | 2923ms | 0 | 默认，中英混排都准 |
| 百炼 | `qwen3.5-omni-flash` | 152 | 57 | 209 | 1172ms | — | 快，但中文小字偶尔漏 |
| 百炼 | `qwen3-vl-plus` | 168 | 119 | 287 | 3575ms | — | 描述最细，最慢最贵 |
| 百炼 | `qwen-vl-ocr` | 146 | 18 | 164 | 376ms | — | 只出文字，最快 |

> `qwen3.7-plus` 曾测过（94 / 91 / 185 tok / 2073ms），但不在百炼大学生优惠券覆盖范围、按字真扣钱，
> 且输出比 omni-flash 啰嗦 7 成，已按用户要求从 `MODEL_CATALOG` 兜底表移除。
> 但**菜单已经不再由这张表决定** —— 它现在只做兜底。只要 DSH 里注册了这个模型，下拉和
> `qq_vision_models` 照样会把它列出来，选中也能发出去。

## 配置优先级

```
runtime.json  >  cordis.patch.yml 的 config  >  环境变量  >  自动探测
```

| 键 | 环境变量 | 默认 |
| --- | --- | --- |
| `bridgeBaseUrl` | `QQ_BRIDGE_BASE_URL` | `http://127.0.0.1:3200` |
| `bridgeRoot` | `QQ_BRIDGE_ROOT` | 按 `ROOT_CANDIDATES` 探测 |
| `consoleToken` | `QQ_BRIDGE_CONSOLE_TOKEN` | `<bridgeRoot>/state/console-token` |
| `visionProvider` | — | `workbuddy` |
| `visionEnabled` | — | `false`（只用免费 OCR） |
| `visionModel` | — | 按后端：`deepseek-v4.1-flash` / `qwen3.5-omni-flash` |
| `visionVault` | — | `~/.dsh/workbuddy-vault`（下有 `cn/` 与 `global/`） |
| `visionRegion` | — | 空 = 自动挑 `refreshedAtMs` 最新的那个区 |
| `visionBaseUrl` | — | 仅 bailian 用，`https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `visionApiKey` | 由 `visionApiKeyEnv` 指定，默认 `BAILIAN_API_KEY` | 从 `~/.dsh/.credentials.yaml` 的 `refs:` 段读（仅 bailian） |
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
node test\web-route.mjs        # 46 项：Web 路由注册、Host 判定、白名单、handler 端到端
node test\deep.mjs             # 真连桥接、真识图、真走 MCP（22 项 + 1 跳过）
node test\verify-billing.mjs   # 断言不花钱的两条路径都不产生付费调用
node test\verify-model-pick.mjs # 三模型对照，打印 token/耗时（会花钱）
node test\verify-custom.mjs    # 22 项：models / config get-set-备份 / usage 记账清空
node test\verify-lossless.mjs  # 24 项：工具返回值必须能无损 JSON 往返
node test\verify-mcp-tools.mjs # MCP 七个工具都注册上了
node test\verify-mcp-calls.mjs # MCP 真调 models/usage/config 三个新工具
node test\verify-scan.mjs      # 45 项：模型扫描（假 llm 服务 / 单 provider 报错 / 降级 / 合并兜底 / 缓存）
node test\web-route.mjs        # 46 项：Web 路由 + 工具白名单 + output schema
node test\verify-billing.mjs   # 临时关掉视觉，验「关掉后只走免费 OCR」并还原
```

`deep.mjs` 需要桥接在线（默认 `127.0.0.1:3200`）。桥接会自动重启，偶发连不上时重跑即可。
`verify-model-pick.mjs` 与 `deep.mjs` 的部分用例会真调付费模型并记账，跑之前确认 `visionEnabled` 的状态符合预期。
`verify-billing.mjs` 会自己把 `visionEnabled` 临时改 false 再还原，不需要手动准备环境。

`verify-lossless.mjs` 值得单独说一句：DSH 对插件工具的返回值做 JSON 往返校验，
返回值里只要出现 `undefined`（对象属性或数组元素都算），整次调用就报
`tool "xxx" returned invalid output: value is not lossless JSON` 并把结果丢掉。
本插件用两道防线挡住它 —— 每个工具自己把字段补成 `null`，`apply()` 里再统一套一层
`sanitize()`。加新工具时照这个写，否则模型只会看到一句「工具调用失败」。

## 已知边界

- **只认 Windows OCR**：`ocrWithWindows` 在非 win32 平台直接抛错，视觉后端那条路不受影响。
- **视觉后端只实现两种**：WorkBuddy（SSE 流式）与百炼（非流式）。换别的协议要改
  `describeWithWorkBuddy` / `describeWithBailian`，并在 `resolveRuntime` 里加 provider 推断。
- **WorkBuddy 凭据靠 dsh-connect-workbuddy 插件维护**：本插件只读 vault、必要时刷新并回写。
  那个插件没登录过（vault 目录空），WorkBuddy 后端就不可用，会明确报出来而不是静默退 OCR。
- **WorkBuddy 网关强制流式**：`stream:false` 会被拒。解析按 SSE `data:` 行做，
  `delta.content` 为空时用 `delta.reasoning_content` 兜底。
- **模型菜单现在扫 DSH**：`qq_vision_models` 与面板下拉都会向宿主 `llm` 服务要
  `listProviders()` + `listModels(route)`，把当前 DSH 里真正注册过的模型全列出来（`source: 'dsh'`）。
  `llm` 服务不可用（老版本宿主）或某个 provider 报错时，回落到 `MODEL_CATALOG` 那 5 条兜底表
  （`source: 'builtin-fallback'`），菜单不会空。传别的模型名照样能发出去（不当白名单用）。
- **模型列表按图能力排序但不硬过滤**：`inputModalities` 声明含 `image` 的排最前、没声明（`image: null`）
  的排中间、明确只有 `text` 的排最后。没声明不等于不能读图 —— 很多第三方 OpenAI 兼容网关不报这个字段。
- **单价要自己填**：百炼价格随时调，插件不猜。不填只记 token，不折算金额。
  WorkBuddy 按 credit 计，上游报了就直接报 credit，不需要单价表。
- **一次最多看 5 张**（`limit` 上限），再多就分批。
- **面板只在本机 Web GUI 里出现**：`client.js` 是 web 平台半边，`immediately: true` 一启动就加载，
  但改它本身必须重启 DSH；改 `runtime.json`（面板里点就是改它）不用重启。
- **`/dsh-qq-vision-api` 不做出网鉴权**：只靠 Host 判定挡 DNS rebinding。要在别的机器上开面板，
  得自己加一层反代鉴权。
