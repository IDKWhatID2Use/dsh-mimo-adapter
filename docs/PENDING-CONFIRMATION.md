# 待确认清单

上一版这里的绝大多数「待补充」已经由官方文档确认并落地为默认值。本文件只保留**仍未确认**的部分，并逐条说明现在的行为。

来源：[小米 MiMo API 开放平台](https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call)、[模型列表](https://mimo.mi.com/docs/zh-CN/quick-start/summary/model)、[深度思考](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/text-generation/deep-thinking)、[音频理解](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/multimodal-understanding/audio-understanding)、[视频理解](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/multimodal-understanding/video-understanding)。

---

## A. 已由官方文档确认（不再是待补充）

| 项 | 确认值 | 落地位置 |
|---|---|---|
| API 基址（OpenAI 兼容） | `https://api.xiaomimimo.com/v1` | `lib/config.js` `DEFAULT_BASE_URL` |
| API 基址（Anthropic 兼容） | `https://api.xiaomimimo.com/anthropic` | 未实现（本插件只做 Chat Completions） |
| 鉴权方式 | 请求头 `api-key: <key>` | `auth: { scheme: header, headerName: api-key }` |
| Key 格式 | `sk-…`；Token Plan `tp-…` / `ttp-…` | 与 `apiKeyEnv` 引用无关，值原样发送 |
| 请求路径 | `/chat/completions` | `path` 默认值 |
| 输出上限字段 | `max_completion_tokens` | `lib/adapter.js` 请求体 |
| 思考控制 | `thinking.type` = `enabled` \| `disabled`，无档位词汇 | `efforts` 默认两档 |
| 思考默认 | v2.6 / v2.5 默认开启 | 默认档 `high`（= thinking enabled） |
| 温度限制 | thinking 开启时不支持自定义 `temperature`/`top_p` | 该情形下不发 `temperature` |
| 工具回合要求 | 历史含工具调用时必须回传 `reasoning_content`，否则 400 | `serializeAssistant` |
| 模型目录与容量 | `mimo-v2.6-pro`/`flash`/`pro-ultraspeed`/`v2.5-pro`/`v2.5`（1M/128K）、`mimo-v2.5-asr`（8K/2K） | `DEFAULT_MODELS` |
| 音频 part 形状 | `{ type: input_audio, input_audio: { data: <URL 或 data URI> } }` | `mediaContentPart` |
| 视频 part 形状 | `{ type: video_url, video_url: { url }, fps, media_resolution }` | 同上 |
| 视频 fps / 分辨率 | `fps` ∈ [0.1, 10] 默认 2；`media_resolution` = `default` \| `max` | 加载期校验 |
| 视频容器 | MP4、MOV、AVI、WMV | `video.mediaTypes` 默认 |
| 尺寸上限 | 音频 URL ≤ 100 MB；视频 Base64 字符串 ≤ 50 MB（URL 300 MB） | `audio.maxBytes` / `video.maxBytes` |
| 不支持本地视频上传 | 只能 URL 或 Base64 | `mode: file` 加载期拒绝 |

**凭证引用名**：默认 `XIAOMI_API_KEY`（本机凭据里已存在该引用）。若你的部署用别的名字，改 `apiKeyEnv` 即可——它只是引用名，不是密钥。

---

## B. 仍待确认

| # | 项 | 现状 | 影响 / 怎么办 |
|---|---|---|---|
| B1 | **音频容器清单** | 官方音频文档只给了 `.wav` 示例，未列完整清单 | 默认接受 `wav/mpeg/mp4/webm/ogg`；若平台只收 wav，把 `audio.mediaTypes` 收成 `[audio/wav]`。不匹配时上游返回 400 → `INVALID_REQUEST`，可见且可改 |
| B2 | **音频 Base64 的大小上限** | 官方只写了「URL 方式 ≤ 100 MB」 | 默认 `audio.maxBytes` = 100 MB（对 Base64 也沿用该值）。若平台对 Base64 另有更小上限，调小该值即可 |
| B3 | **`media_resolution` 的取值域** | 官方文档明确为 `default` / `max` | 已按官方校验；若平台新增取值会以加载期错误暴露 |
| B4 | **单请求音频/视频个数上限** | 官方只说受上下文长度限制 | 默认各 1 个；要并发投递就调 `maxPerRequest`，超限默认降级为占位文本 |
| B5 | **`thinking` 之外是否有强度参数** | 官方文档未提及任何档位参数 | 若你的网关暴露了 `reasoning_effort` 之类的档位，用 `efforts` + `effortFieldName` 配出来，代码无需改 |
| B6 | **Anthropic Messages 协议** | 官方支持，本插件未实现 | 需要就走 `protocol` 新增实现；当前配置其它值会在加载期报错 |
| B7 | **429 的具体退避建议** | 官方建议「实现重试与退避」但未给数值 | 已透传 `Retry-After`（若有）；实际退避由 `dsh-llm-retry` 与 `retryPolicy` 决定 |
| B8 | **是否需要客户端半包（Models 页 baseURL 输入框）** | 未实现 | 当前在 `cordis.patch.yml` / `settings.yaml` 的 `mimo-adapter:` 分节配置端点。需要页面内编辑就做一个客户端半包注册 `settings.models.provider-card` slot |

---

## C. 行为决策（已按最保守方式实现，可改）

| # | 问题 | 当前默认 |
|---|---|---|
| C1 | 附件超限：报错还是降级？ | 降级为命名占位文本；`audio.onOversize` / `video.onOversize` 可设 `reject` 改为硬失败 |
| C2 | 模型未声明该模态？ | 降级为占位文本（即使 `reject` 也降级——模态关闭不是配置越限） |
| C3 | `mode: file` / `mode: frames`？ | **加载期拒绝**（官方不支持，避免每次请求读完文件才失败） |
| C4 | 其它路由收到音视频块？ | `llm/stream` 监听器换成占位文本，递归处理 tool-result，绝不静默丢弃 |
| C5 | 未列出的模型 id？ | 仍路由，按**纯文本**处理（不猜模态） |
| C6 | 无 API Key？ | 以无鉴权发出；被 provider 拒绝则 `AUTH` |
| C7 | 非推理模型收到显式档位？ | `UNSUPPORTED_REASONING_EFFORT`（本地直连也给同样结论） |

---

## D. 规范层面

| # | 项 | 现状 |
|---|---|---|
| D1 | 官方插件开发规范文档链接 | 未提供；实现依据已安装 harness 本身（含 `path:line`），见 README §1 |
| D2 | 规范版本 | `@deepseek-ai/dsh` **0.1.6-alpha.2**（本机安装版本） |
| D3 | 是否发布到 npm / 指定 scope | 未定；当前包名 `dsh-mimo-adapter`（无 scope） |
| D4 | 是否进 `dsh.profile.bundles` | 已声明 `dsh.bundle.patch`，可进；**我没有改动你的 `web` profile** |
| D5 | 是否需要 `.gitignore` 之外的发布配置 | 未定；`files` 当前包含 `lib/**`、`cordis.patch.yml`、README、docs |
