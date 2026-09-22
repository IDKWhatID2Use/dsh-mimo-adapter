# dsh-mimo-adapter

小米 MiMo 系列的 DeepSeek Harness 插件：**思考强度控制**、**音频输入模态**、**视频输入模态**。

所有实现依据 [小米 MiMo API 开放平台官方文档](https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call)，不是猜测。剩余未确认项集中在 [`docs/PENDING-CONFIRMATION.md`](docs/PENDING-CONFIRMATION.md)。

**实测状态**：单元测试 57/57、Web 目录接线 19/19、清单自检 8/8、真实 MiMo API 11/11（见 §6）。

---

## 一、官方规范（每条都带出处）

| 事实 | 值 | 出处 |
|---|---|---|
| OpenAI 兼容根地址 | `https://api.xiaomimimo.com/v1` | [首次调用 API](https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call) |
| Anthropic 兼容根地址 | `https://api.xiaomimimo.com/anthropic` | 同上 |
| 鉴权 | 请求头 **`api-key: <key>`**（不是 `Authorization: Bearer`） | 官方每个 curl 示例 |
| Key 格式 | `sk-…`（Token Plan：`tp-…` / `ttp-…`） | 同上 |
| 请求路径 | 根地址后接 `/chat/completions` | 官方示例 |
| 输出上限字段 | **`max_completion_tokens`**（限制思考 + 回答总量） | 官方全部示例 |
| 思考开关 | `thinking.type` = `enabled` \| `disabled`，**无档位词汇** | [深度思考](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/text-generation/deep-thinking) |
| 思考默认 | v2.6 系列与 v2.5 系列**默认开启** | 同上 |
| 温度限制 | 开启深度思考时**不支持**自定义 `temperature`/`top_p`，模型强制 1.0 / 0.95 | 同上 |
| 工具回合硬要求 | 历史含工具调用时，回传的 assistant **必须完整带 `reasoning_content`，否则 400** | 同上 |
| 模型目录 | `mimo-v2.6-pro`、`mimo-v2.6-flash`、`mimo-v2.6-pro-ultraspeed`、`mimo-v2.5-pro`、`mimo-v2.5`、`mimo-v2.5-asr`（后两个官方已公告弃用） | [模型列表](https://mimo.mi.com/docs/zh-CN/quick-start/summary/model) |
| 上下文 / 输出 | 1M / 128K（v2.6 与 v2.5-pro）；ASR 8K / 2K | 同上 |
| 音频 part | `{ type: 'input_audio', input_audio: { data } }`，`data` 是公网 URL 或 `data:{MIME};base64,{…}` | [音频理解](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/multimodal-understanding/audio-understanding) |
| 音频上限 | URL 方式单文件 ≤ 100 MB | 同上 |
| 视频 part | `{ type: 'video_url', video_url: { url }, fps, media_resolution }` | [视频理解](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/multimodal-understanding/video-understanding) |
| 视频参数 | `fps` 默认 2，范围 `[0.1, 10]`；`media_resolution` = `default` \| `max` | 同上 |
| 视频容器 / 上限 | MP4、MOV、AVI、WMV；URL ≤ 300 MB，**Base64 字符串 ≤ 50 MB** | 同上 |
| 不支持本地视频上传 | 只能 URL 或 Base64 | 同上（FAQ） |

### Harness 插件规范（依据已安装实现，v0.1.6-alpha.2）

| 契约 | 内容 | 出处（已安装文件） |
|---|---|---|
| 插件形态 | 函数插件导出 `name` / `inject` / `Config` / `apply(ctx, config)` | `dsh-llm-deepseek/lib/index.js:3068,3072` |
| **`Config` 接口** | Cordis 读 `Config['~standard'].validate(raw)`，须同步返回 `{value}` / `{issues}` | `cordis/lib/index.js:955-961` |
| `inject` 语义 | 未满足即行 inactive 并报 `waiting for <svc>` | `dsh-host-plugin-surface.md:22` |
| bundle 资格 | 必须在 `package.json` 声明 `dsh.bundle.patch` | `dsh-app-boot/lib/index.js:916-928` |
| 模型选择器数据 | `buildModelCatalog` 遍历 `listProviders()` → `listModels()` → `resolveModelInfo().reasoning` | `dsh-api-session-controller/lib/types/catalog.js:8-57` |
| Effort 行 | 适配器公布推理元数据才显示 Effort 行，且不给自由输入 | `dsh-client-ui-model-selection/README.zh.md:32,86` |
| 请求不可改写 | loop 请求深冻结，监听器只读 | `dsh-llm/lib/types/index.d.ts:38-41` |
| 词汇可扩 | `ContentBlockMap` / `ModelModalityMap` 为 merge-extensible | `dsh-llm/lib/types/types.d.ts:101-113,200-206` |
| 重试退避事实 | `LlmFailure.providerRetryAfterMs` | `dsh-llm/lib/types/types.d.ts:32-33` |

---

## 二、三项能力

### 2.1 思考强度控制

MiMo 的官方控制面只有一个开关 `thinking.type`，所以插件公布的档位就是**两档**，而不是编造的 `low/high/max`：

```yaml
defaultEffort: high          # off | high
efforts:
  - id: off
    name: Off
    inert: true
    thinking: { type: disabled }
  - id: high
    name: Deep thinking
    thinking: { type: enabled }
```

- 档位表通过 `resolveModel().reasoning` 公布，harness 在**任何 provider I/O 之前**校验；未公布的档位以 `UNSUPPORTED_REASONING_EFFORT` 失败（测试断言此时 fetch 未被调用）。
- 每个档位同时声明 `sends`（写什么）与 `clears`（删什么），保证请求体上只出现一个档位的字段——不 clamp、不 alias、不留残留。
- `session-title` 用途强制走惰性档。
- **部署默认档会按模型收窄**：某模型用 `reasoning.efforts` 排除了部署默认档时，默认档自动降到全模型都接受的档位，否则 harness 会把该模型不接受的档位物化进请求，并让整个 provider 分组从选择器消失（有测试与实测覆盖）。
- 部署若有自己的档位词汇（例如网关提供了 `low/high/max`），通过 `efforts` + `thinkingField` + `effortFieldName` 覆盖即可，无需改代码。

### 2.2 音频输入模态

消息里放 `audio` 块（携带持久附件引用）：

```js
{ type: 'audio', attachment: { attachmentId, name, bytes }, mediaType: 'audio/wav' }
```

线上形状（官方规范）：

```js
{ type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,…' } }
```

处理链路：`attachments.readFileStream()` 流式读字节（上限在读取过程中执行）→ 同附件只读一次 → base64 → 上面这个 part，前面再插一条确定性句柄文本：

```
[audio attachment id=att-123 name=clip.wav bytes=40960 format=wav readPath=… (read-only)]
```

降级矩阵（默认 `onOversize: degrade`，可切 `reject`）：

| 情况 | 行为 |
|---|---|
| 模型未声明 audio | 命名占位文本，不发字节 |
| 超过 `audio.maxBytes`（默认 100 MB，官方 URL 上限） | 占位文本；`reject` 则 `MEDIA_TOO_LARGE` |
| 超过 `audio.maxPerRequest`（默认 1） | 第 N+1 个起占位；`reject` 则报错 |
| 超过请求级 `maxRequestMediaBytes` | 超出者占位；`reject` 则报错 |
| 块带 `offloaded: true` | 持久省略占位（可逆） |
| 附件服务缺失 | `INVALID_CONFIG`，点名缺哪个 provider |
| 配置了 `mode: file` | **加载期就拒绝**：官方无音频上传端点 |

### 2.3 视频输入模态

```js
{ type: 'video', attachment: { … }, mediaType: 'video/mp4' }
// →
{ type: 'video_url', video_url: { url: 'data:video/mp4;base64,…' }, fps: 2, media_resolution: 'default' }
```

- `fps` 与 `mediaResolution` 可配，范围按官方 `[0.1, 10]` 与 `default|max` 校验，超范围在加载期报错。
- 默认 `maxBytes` = 52428800（官方 **Base64 字符串**上限 50 MB）。
- 容器默认 `mp4 / quicktime / x-msvideo / x-ms-wmv`，对应官方 MP4/MOV/AVI/WMV。
- `mode: file` / `mode: frames` **加载期拒绝**：官方不支持本地视频上传，抽帧由官方 `fps`/`media_resolution` 完成。

### 2.4 对其它路由的降级

拓宽 `ContentBlockMap` 后音视频块可能落到别的 adapter（如 `deepseek-official`），而它们对未知块是 switch-default 忽略。插件装 `llm/stream` 监听器，把音视频块换成与图片纯文本路由同构的命名占位文本，**递归处理 tool-result 内嵌内容**（harness 自己把递归遍历列为共享不变量），并且不修改冻结的请求对象。

---

## 三、Web UI 接入：输入栏模型选择器与 Effort 行

### 为什么路由名是 `xiaomi`

MiMo 是**模型系列**，不是提供商；提供商就是 Xiaomi，而 harness 早已把 `xiaomi` 当作该提供商的 route id（`llm-pi-ai` 的目录里有它，`settings.yaml` 里以 `llm-pi-ai.providers.xiaomi` 配置它）。所以本适配器注册的是 `xiaomi` 路由：

- 模型选择器里只有**一个** xiaomi 分组，模型是 `mimo-v2.6-pro`、`mimo-v2.6-flash` 等系列成员；
- 凭据沿用同一个引用名 `XIAOMI_API_KEY`，与既有配置一致；
- 不再出现第二个叫 `mimo` 的"提供商"。

```yaml
# 一个 xiaomi 提供商，MiMo 是它的模型
provider: xiaomi
displayName: Xiaomi
baseURL: https://api.xiaomimimo.com/v1     # MiMo 模型的官方端点
auth: { scheme: header, headerName: api-key }
apiKeyEnv: XIAOMI_API_KEY
```

**与 `llm-pi-ai` 的手工 xiaomi 路由冲突**：`ctx.llm.registerAdapter` 对同一 route 是独占的，两者同时声明 `xiaomi` 会让插件树加载失败（`DUPLICATE_ADAPTER`）。若已按 pi-ai 配过 xiaomi，请**删除 `settings.yaml` 里的那一块**，让本适配器接管该路由：

```yaml
# 删除以下整块（llm-pi-ai.providers.xiaomi）
llm-pi-ai:
  providers:
    xiaomi:
      models: [...]
      apiKeyEnv: XIAOMI_API_KEY
```

删掉之后端点、凭据引用与模型目录都由本适配器提供，并额外带来音频与视频输入。

不需要任何前端代码。DeepSeek 的强度选择走的就是这条缝：

```js
// dsh-api-session-controller/lib/types/catalog.js:8-57
const providers = ctx.llm.listProviders();                    // registerAdapter
const models = await ctx.llm.listModels(provider.id);          // adapter.listModels
const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id);
const reasoning = resolved.reasoning === undefined ? undefined // adapter.resolveModel().reasoning
    : { efforts: …, defaultEffort: … };
```

实测 19/19（`tests/catalog-wiring.mjs`，真实 `LlmRuntime` + 真实 `buildModelCatalog`）：

```
PASS  the selector receives a mimo group — mimo
PASS  all official models appear in the selector — mimo-v2.6-pro,…,mimo-v2.5-asr
PASS  the Effort row lists the two documented levels — off=Off,high=Deep thinking
PASS  the Effort row carries the deployment default — high
PASS  a level the UI offers is accepted by the runtime — off
PASS  a level the UI never offers is refused — UNSUPPORTED_REASONING_EFFORT
PASS  a narrowed model does not inherit the deployment default — off
PASS  the whole group survives the narrowed model — full,narrow
```

**Models 设置页**（API 密钥）也会自动出现一行：`registerConfigurableProviders` 的 `settingsNs` 就是行键。唯一需要客户端半包的是页面内的 `baseURL` 手写输入框（`settings.models.provider-card` slot）；当前请在 `cordis.patch.yml` 或 `settings.yaml` 的 `mimo-adapter:` 分节里填。

---

## 四、安装与启用

**已发布**：<https://github.com/IDKWhatID2Use/dsh-mimo-adapter>（公开仓库，单提交快照）

### 方式 A：在别的机器/实例上从 GitHub 安装（推荐）

```powershell
git clone https://github.com/IDKWhatID2Use/dsh-mimo-adapter.git
cd dsh-mimo-adapter
node tests/bootstrap.mjs          # 链接本机 harness 包（仅跑测试时需要）

# 装进目标 profile（以 web 为例）
$profile = "$env:USERPROFILE\.dsh\profiles\web"
cmd /c mklink /J "$profile\node_modules\dsh-mimo-adapter" (Get-Location).Path
# 或走 pnpm：dsh plugin --profile web add file:<克隆路径>
```

然后把 `"dsh-mimo-adapter"` 追加到 `$profile\package.json` 的 `dsh.profile.bundles`，重启 profile。

**用 GitHub 链接直接装**（目标 profile 用 pnpm 管理依赖时）：

```powershell
dsh plugin --profile web add github:IDKWhatID2Use/dsh-mimo-adapter
```

> **插件不含任何密钥。** 仓库里没有 key / token / 密码，历史里也没有（见 [SECURITY.md](SECURITY.md) 的扫描方法）。凭据由目标实例自己提供：把 MiMo API Key 存到 `XIAOMI_API_KEY`（凭据服务或环境变量），或改 `apiKeyEnv` 指向已有的引用名。

### 方式 B：本地开发

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\web"
cmd /c mklink /J "$profile\node_modules\dsh-mimo-adapter" "<本仓库路径>"
```

插件自带的 [cordis.patch.yml](cordis.patch.yml) 会插入自己的行，默认值即官方端点：

```yaml
- insert:
    - id: mimo-adapter
      name: 'dsh-mimo-adapter'
      config:
        baseURL: https://api.xiaomimimo.com/v1
        auth: { scheme: header, headerName: api-key }
        apiKeyEnv: XIAOMI_API_KEY      # 凭据引用名，不是密钥
        defaultEffort: high
```

---

## 五、边界情况

| 情况 | 处理 |
|---|---|
| 未公布档位 | `UNSUPPORTED_REASONING_EFFORT`（请求前） |
| 非推理模型 | 不发任何 reasoning 字段；Effort 行消失 |
| 档位限制写错（未声明的 id） | **加载期拒绝**，不拖累整个 provider 分组 |
| 部署默认档被某模型排除 | 默认档自动收窄到全模型可用档位 |
| 未知块类型且无人降级 | `UNSUPPORTED_MODALITY`，拒绝发送未记录的投影 |
| provider 空闲不发数据 | `streamIdleTimeoutMs`（默认 300 s）→ `TIMEOUT` |
| 429 | 解析 `Retry-After` → `providerRetryAfterMs` |
| 404 | `HTTP_404`（提示查 path/baseURL，不误报为请求体问题） |
| 凭据无效/空 | `INVALID_CREDENTIAL`，诊断里绝不出现密钥片段 |
| 无凭据 | 以无鉴权发出（本地部署可能合法） |

---

## 六、验证方法与实测结果

```powershell
cd <仓库目录>
node tests/bootstrap.mjs            # 链接 harness 包（profile 外运行时需要）
node --test tests/mimo.test.mjs     # 57/57
node tests/catalog-wiring.mjs       # 19/19
node tests/load-check.mjs test1     # 清单与配置树自检（需 DSH_HOME 指向 harness home）
$env:MIMO_LIVE="1"; node tests/live.mjs                                # 11/11（消耗真实额度）
```

### 真实 MiMo API 实测（11/11）

```
✔  the official endpoint accepts the api-key header — ok
✔  the request carries max_completion_tokens — max_completion_tokens=131072
✔  thinking disabled really disables — reasoning chars=0
✔  thinking enabled is accepted and streams reasoning — reasoning chars=52
✔  thinking sends thinking.type = enabled — {"type":"enabled"}
✔  a custom temperature is not sent while thinking is on — undefined
✔  the model issues a tool call — get_time({"city": "Wuhan"}) id="call_fc3208…"
✔  the replayed assistant turn carries reasoning_content — 73 chars
✔  the replayed assistant turn carries a tool_call id — {"id":"call_fc3208…",…}
✔  the tool follow-up is accepted — stop: Current time in Wuhan is 2026-09-22 23:30
```

这一轮抓出并修掉一个会让 agent loop 完全不可用的缺陷：MiMo 只在工具调用的**第一个** delta 给 `id`，后续 delta 给 `null`，而旧代码 `if (delta.id !== undefined)` 会把 `null` 覆盖进去，回传时变成 `tool_calls[].id = null`，MiMo 直接 400 ``"param":"`id` is null"``。修复 + 回归测试见 `lib/adapter.js` 的 `applyToolDeltas`。

### 真实 profile 加载（实测通过）

```
$ dsh --profile test1 --dump-config
# == dsh-mimo-adapter, patched by <DSH_HOME>\profiles\test1\cordis.patch.yml
- id: mimo-adapter
  name: dsh-mimo-adapter
  config:
    provider: xiaomi
    displayName: Xiaomi
    baseURL: https://api.xiaomimimo.com/v1
    apiKeyEnv: XIAOMI_API_KEY
    defaultEffort: high
```

---

## 七、文件清单

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 入口：`name`/`inject`/`Config`/`apply`，注册路由、目录条目、降级监听器 |
| `lib/config.js` | 配置 schema、官方默认值、Standard Schema 接口、加载期校验 |
| `lib/adapter.js` | `MiMoAdapter`：`resolveModel`/`prepareCall`/`stream`、SSE 翻译、usage 归一化 |
| `lib/thinking.js` | 档位解析、默认档收窄、`sends`/`clears` 落地 |
| `lib/messages.js` | 请求序列化：text/image/audio/video/file/tool、`reasoning_content` 回传 |
| `lib/media.js` | 附件流式读取、base64、确定性句柄与占位文本 |
| `lib/degrade.js` | 其它路由的音视频降级（递归 tool-result） |
| `lib/headers.js` | URL、鉴权头（默认 `api-key`）、attribution 头 |
| `lib/sse.js` | SSE 增量解析 + 空闲超时 |
| `lib/errors.js` | HTTP/传输错误 → 稳定码、正文截断与密钥脱敏 |
| `lib/types/content-blocks.d.ts` | `audio`/`video` 声明合并 |
| `tests/mimo.test.mjs` | 57 项单元/集成测试 |
| `tests/catalog-wiring.mjs` | Web 选择器与 Effort 行接线（19 项） |
| `tests/live.mjs` | 真实 API 端到端（`MIMO_LIVE=1`） |
| `tests/load-check.mjs` | 清单与配置树自检 |
| `tests/helpers.mjs` / `bootstrap.mjs` | 真实 harness 基类 + 联调夹具 / 依赖链接 |
| `cordis.patch.yml` | bundle 补丁（官方默认值） |
| `docs/PENDING-CONFIRMATION.md` | 待确认清单（已确认项与剩余缺口） |
