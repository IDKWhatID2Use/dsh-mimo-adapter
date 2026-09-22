/**
 * Zero-dependency configuration schema + validator for dsh-mimo-adapter.
 *
 * The plugin deliberately does not depend on `@deepseek-ai/schemastery`: a
 * plugin that cannot be imported without resolving a third package cannot be
 * loaded at all, and the harness only runs a plugin's config through the
 * exported `Config`'s Standard Schema interface. This module provides that
 * interface without a schema library in the dependency graph.
 *
 * Defaults below are the **official Xiaomi MiMo Open Platform facts**
 * (https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call), not
 * guesses:
 *
 * | fact | value | source |
 * |---|---|---|
 * | OpenAI-compatible root | `https://api.xiaomimimo.com/v1` | first-api-call |
 * | credential header | `api-key: <key>` (NOT `Authorization: Bearer`) | first-api-call, every curl sample |
 * | key format | `sk-…` (Token Plan: `tp-…` / `ttp-…`) | first-api-call |
 * | chat path | `/chat/completions` appended to the `/v1` root | first-api-call, video doc |
 * | thinking switch | `thinking.type` = `enabled` \| `disabled`, no level vocabulary | deep-thinking |
 *
 * @module dsh-mimo-adapter/config
 */

const MODALITIES = ['text', 'image', 'audio', 'video'];

/** Path appended to the configured root. */
const DEFAULT_PATH = '/chat/completions';

/** Official OpenAI-compatible root. */
const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1';

/**
 * The official catalog. `mimo-v2.5-pro`/`mimo-v2.5` are still serviceable but
 * Xiaomi marks them deprecated.
 *
 * Source: https://mimo.mi.com/docs/zh-CN/quick-start/summary/model
 * (1M context, 128K max output, full-modal understanding, deep thinking).
 */
const DEFAULT_MODELS = [
    {
        id: 'mimo-v2.6-pro',
        name: 'MiMo-V2.6-Pro',
        description: 'Flagship: complex projects, long-horizon tasks, difficulty-critical work.',
        contextWindow: 1048576,
        maxTokens: 131072,
        inputModalities: ['text', 'image', 'audio', 'video'],
        defaultEffort: 'high',
    },
    {
        id: 'mimo-v2.6-flash',
        name: 'MiMo-V2.6-Flash',
        description: 'High-throughput professional office and large-scale batch tasks.',
        contextWindow: 1048576,
        maxTokens: 131072,
        inputModalities: ['text', 'image', 'audio', 'video'],
        defaultEffort: 'high',
    },
    {
        id: 'mimo-v2.6-pro-ultraspeed',
        name: 'MiMo-V2.6-Pro-Ultraspeed',
        description: 'Latency-sensitive interactive production workloads.',
        contextWindow: 1048576,
        maxTokens: 131072,
        inputModalities: ['text', 'image', 'audio', 'video'],
        defaultEffort: 'high',
    },
    {
        id: 'mimo-v2.5-pro',
        name: 'MiMo-V2.5-Pro (deprecated by Xiaomi)',
        description: 'Previous generation; Xiaomi announces deprecation.',
        contextWindow: 1048576,
        maxTokens: 131072,
        inputModalities: ['text', 'image', 'audio', 'video'],
        defaultEffort: 'high',
    },
    {
        id: 'mimo-v2.5',
        name: 'MiMo-V2.5 (deprecated by Xiaomi)',
        description: 'Previous generation; Xiaomi announces deprecation.',
        contextWindow: 1048576,
        maxTokens: 131072,
        inputModalities: ['text', 'image', 'audio', 'video'],
        defaultEffort: 'high',
    },
    {
        id: 'mimo-v2.5-asr',
        name: 'MiMo-V2.5-ASR',
        description: 'Speech recognition (Chinese and English).',
        contextWindow: 8192,
        maxTokens: 2048,
        inputModalities: ['audio'],
    },
];

/**
 * Wire spelling of the two reasoning-effort knobs.
 *
 * The MiMo deep-thinking API exposes exactly one control: `thinking.type` with
 * `enabled` or `disabled` (deep-thinking doc: "在请求中设置 `thinking.type`
 * 参数控制深度思考开关"). There is no `low`/`high`/`max` level vocabulary, so the
 * two levels below are the whole honest set and a deployment that finds a
 * documented level parameter can add more without touching code.
 */
const DEFAULT_EFFORT_FIELDS = {
    thinkingField: 'thinking',
    reasoningEffortField: 'reasoning_effort',
};

/**
 * Raw plugin configuration. Every field is optional; resolution supplies the
 * official defaults, and `resolveConfig` re-judges every bound so a settings
 * snapshot that bypassed normalization still cannot produce an invalid
 * connection.
 */
const DEFAULT_CONFIG = {
    /**
     * The provider route is `xiaomi`, not `mimo`.
     *
     * MiMo is a model *family* made by Xiaomi; the provider is Xiaomi, and the
     * harness already treats `xiaomi` as that provider's route id (the
     * `llm-pi-ai` catalog exposes it, `settings.yaml` configures it as
     * `llm-pi-ai.providers.xiaomi`). Registering a second route named `mimo`
     * would put one vendor in the selector twice and read a different
     * credential reference, so this adapter serves the `xiaomi` route instead.
     */
    provider: 'xiaomi',
    displayName: 'Xiaomi',
    baseURL: DEFAULT_BASE_URL,
    /** Official transport: an `api-key` header, not a bearer token. */
    auth: { scheme: 'header', headerName: 'api-key' },
    /** Credential reference; resolved through the credentials seam, then the environment. */
    apiKeyEnv: 'XIAOMI_API_KEY',
    path: DEFAULT_PATH,
    protocol: 'openai-chat-completions',
    headers: {},
    models: DEFAULT_MODELS,
    defaultContextWindow: 1048576,
    defaultMaxTokens: 131072,
    /** --- reasoning-effort control (思考强度) --- */
    thinking: 'enabled',
    defaultEffort: undefined,
    thinkingField: undefined,
    effortFieldName: undefined,
    efforts: undefined,
    /** --- audio input modality --- */
    audio: undefined,
    /** --- video input modality --- */
    video: undefined,
    /** --- request/transport bounds --- */
    maxRequestMediaBytes: undefined,
    attachTimeoutMs: undefined,
    streamIdleTimeoutMs: 300000,
    maxTokens: 131072,
    retryPolicy: undefined,
};

/** Deep-merge the caller's config over the defaults, without mutating either. */
function withDefaults(config) {
    const raw = config ?? {};
    return {
        ...DEFAULT_CONFIG,
        ...raw,
        headers: { ...DEFAULT_CONFIG.headers, ...(raw.headers ?? {}) },
        models: raw.models ?? DEFAULT_CONFIG.models,
        auth: raw.auth === undefined ? DEFAULT_CONFIG.auth : { ...DEFAULT_CONFIG.auth, ...raw.auth },
    };
}

function fail(path, detail) {
    throw new Error(`dsh-mimo-adapter: config.${path} ${detail}`);
}

function requireNonEmptyString(value, path) {
    if (typeof value !== 'string' || value.length === 0) fail(path, 'must be a non-empty string');
    return value;
}

function requirePositiveInteger(value, path) {
    if (!Number.isSafeInteger(value) || value <= 0) fail(path, 'must be a positive safe integer');
    return value;
}

function requireStringMap(value, path) {
    if (value === undefined) return {};
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'must be a mapping of header name to string value');
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry !== 'string') fail(`${path}.${key}`, 'must be a string');
    }
    return { ...value };
}

/**
 * Validate and detach the raw configuration.
 *
 * This is the one path from raw config to validated facts; `apply()` calls it
 * once at load (fail loud) and again for every settings snapshot.
 *
 * @param raw - the plugin config, or a settings snapshot of the same shape.
 * @returns validated, detached configuration.
 */
export function resolveConfig(raw) {
    const config = withDefaults(raw);

    requireNonEmptyString(config.provider, 'provider');
    requireNonEmptyString(config.displayName, 'displayName');
    requireNonEmptyString(config.apiKeyEnv, 'apiKeyEnv');
    requireNonEmptyString(config.protocol, 'protocol');
    if (config.protocol !== 'openai-chat-completions') {
        fail('protocol', `"${config.protocol}" is not supported; only "openai-chat-completions" is implemented`);
    }
    if (config.path !== undefined && !/^\/[^\s]*$/.test(config.path)) {
        fail('path', 'must begin with "/" when configured');
    }
    if (config.baseURL !== undefined) {
        const parsed = new URL(config.baseURL);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail('baseURL', 'must be an HTTP(S) URL');
        if (parsed.username !== '' || parsed.password !== '') fail('baseURL', 'must not embed credentials; use auth / apiKeyEnv');
        if (parsed.search !== '' || parsed.hash !== '') fail('baseURL', 'must not carry a query or fragment');
    }

    const defaultContextWindow = config.defaultContextWindow === undefined
        ? 1048576
        : requirePositiveInteger(config.defaultContextWindow, 'defaultContextWindow');

    const auth = resolveAuth(config.auth);
    const reasoning = resolveReasoning(config);
    const audio = resolveAudio(config.audio);
    const video = resolveVideo(config.video);
    const models = resolveModels(config.models, defaultContextWindow, reasoning);
    // A deployment-wide default the models cannot all accept is narrowed here,
    // before anything publishes it.
    reasoning.defaultEffort = narrowDefaultToModels(reasoning.defaultEffort, reasoning, models);

    const maxRequestMediaBytes = config.maxRequestMediaBytes === undefined
        ? 20971520
        : requirePositiveInteger(config.maxRequestMediaBytes, 'maxRequestMediaBytes');
    const attachTimeoutMs = config.attachTimeoutMs === undefined
        ? 30000
        : requirePositiveInteger(config.attachTimeoutMs, 'attachTimeoutMs');
    const streamIdleTimeoutMs = config.streamIdleTimeoutMs === undefined
        ? 300000
        : requirePositiveInteger(config.streamIdleTimeoutMs, 'streamIdleTimeoutMs');
    const maxTokens = config.maxTokens === undefined
        ? 131072
        : requirePositiveInteger(config.maxTokens, 'maxTokens');
    const defaultMaxTokens = config.defaultMaxTokens === undefined
        ? 131072
        : requirePositiveInteger(config.defaultMaxTokens, 'defaultMaxTokens');

    return {
        provider: config.provider,
        displayName: config.displayName,
        baseURL: config.baseURL,
        path: config.path,
        protocol: config.protocol,
        headers: requireStringMap(config.headers, 'headers'),
        apiKeyEnv: config.apiKeyEnv,
        auth,
        reasoning,
        audio,
        video,
        models,
        defaultContextWindow,
        defaultMaxTokens,
        maxTokens,
        maxRequestMediaBytes,
        attachTimeoutMs,
        streamIdleTimeoutMs,
        retryPolicy: config.retryPolicy,
    };
}

/** Resolve the credential transport. */
function resolveAuth(raw) {
    const auth = raw ?? DEFAULT_CONFIG.auth;
    const schemes = ['bearer', 'header', 'query'];
    if (!schemes.includes(auth.scheme)) {
        fail('auth.scheme', `must be one of ${schemes.join(', ')}`);
    }
    if (auth.scheme === 'header' && (typeof auth.headerName !== 'string' || auth.headerName.length === 0)) {
        fail('auth.headerName', 'is required when auth.scheme is "header"');
    }
    if (auth.scheme === 'query' && (typeof auth.queryParam !== 'string' || auth.queryParam.length === 0)) {
        fail('auth.queryParam', 'is required when auth.scheme is "query"');
    }
    return {
        scheme: auth.scheme,
        headerName: auth.headerName,
        queryParam: auth.queryParam,
        prefix: auth.prefix === undefined ? (auth.scheme === 'bearer' ? 'Bearer' : undefined) : auth.prefix,
    };
}

/**
 * Resolve reasoning-effort control.
 *
 * MiMo's documented vocabulary is binary, so the default levels are `enabled`
 * and `disabled`. A deployment that discovers a level parameter overrides
 * `efforts` and both field names through configuration.
 */
function resolveReasoning(raw) {
    const thinking = raw?.thinking ?? 'enabled';
    if (thinking !== 'enabled' && thinking !== 'disabled') {
        fail('thinking', 'must be "enabled" or "disabled"');
    }
    const thinkingField = raw?.thinkingField ?? DEFAULT_EFFORT_FIELDS.thinkingField;
    const effortField = raw?.effortFieldName ?? DEFAULT_EFFORT_FIELDS.reasoningEffortField;
    requireNonEmptyString(thinkingField, 'thinkingField');
    requireNonEmptyString(effortField, 'effortFieldName');

    const source = raw?.efforts ?? [
        // The inert level explicitly disables thinking, which is a real wire
        // declaration: MiMo enables deep thinking by default for the v2.6
        // family, so a request that omits the field would still think.
        { id: 'off', name: 'Off', inert: true, thinking: { type: 'disabled' } },
        { id: 'high', name: 'Deep thinking', thinking: { type: 'enabled' } },
    ];
    if (!Array.isArray(source) || source.length === 0) {
        fail('efforts', 'must be a non-empty list when configured');
    }

    const seen = new Set();
    const efforts = source.map((entry, index) => {
        const id = requireNonEmptyString(entry?.id, `efforts[${index}].id`);
        if (seen.has(id)) fail('efforts', `declares "${id}" twice`);
        seen.add(id);
        if (entry.sends !== undefined && (typeof entry.sends !== 'object' || entry.sends === null || Array.isArray(entry.sends))) {
            fail(`efforts[${index}].sends`, 'must be a mapping of wire field name to value');
        }
        const sends = { ...(entry.sends ?? {}) };
        if (entry.thinking !== undefined) sends[thinkingField] = entry.thinking;
        if (entry.reasoningEffort !== undefined) sends[effortField] = entry.reasoningEffort;
        return {
            id,
            name: entry.name ?? id,
            description: entry.description,
            inert: entry.inert === true,
            sends,
        };
    });
    if (efforts.filter((effort) => effort.inert).length > 1) {
        fail('efforts', 'may mark at most one level as inert');
    }

    // Exactly one level's fields may appear on a request, so every level also
    // declares which reasoning-knob fields it must remove: a level that sends
    // nothing has to clear the ones another level would have set.
    const allFields = new Set([thinkingField, effortField]);
    for (const effort of efforts) for (const field of Object.keys(effort.sends)) allFields.add(field);
    for (const effort of efforts) {
        effort.clears = [...allFields].filter((field) => !(field in effort.sends));
    }

    const inert = efforts.find((effort) => effort.inert);
    const lockedEffortId = thinking === 'disabled' ? (inert?.id ?? efforts[0].id) : undefined;

    // MiMo enables deep thinking by default for the v2.6 family and the
    // documented switch is `thinking.type`. With no explicit `defaultEffort`,
    // the default is therefore the first level that is not the inert one —
    // publishing no default instead would let the harness leave the field off,
    // which MiMo reads as "thinking on" while the adapter reported otherwise.
    // A deployment whose levels are all inert keeps the first level.
    const defaultEffort = raw?.defaultEffort
        ?? efforts.find((effort) => effort.inert !== true)?.id
        ?? efforts[0].id;
    if (defaultEffort !== undefined && !seen.has(defaultEffort)) {
        fail('defaultEffort', `"${defaultEffort}" is not one of the declared effort ids (${[...seen].join(', ')})`);
    }

    return { thinking, lockedEffortId, defaultEffort, efforts, thinkingField, effortField };
}

/**
 * Resolve audio input handling.
 *
 * Official shape (audio-understanding doc): a content part
 * `{ type: 'input_audio', input_audio: { data } }` whose `data` is either a
 * public URL or `data:{MIME};base64,{...}`. Single file limit 100 MB when
 * passed by URL.
 */
function resolveAudio(raw) {
    const audio = raw ?? {};
    const mode = audio.mode ?? 'input_audio';
    if (mode !== 'input_audio' && mode !== 'audio_url' && mode !== 'file') {
        fail('audio.mode', 'must be "input_audio", "audio_url", or "file"');
    }
    if (mode === 'file') {
        fail('audio.mode', '"file" is not implemented: MiMo documents no audio upload endpoint (URL or Base64 only)');
    }
    return {
        enabled: audio.enabled ?? true,
        mode,
        onOversize: resolveOversizePolicy(audio.onOversize, 'audio.onOversize'),
        urlField: audio.urlField ?? (mode === 'audio_url' ? 'audio_url' : undefined),
        /** MiMo keeps the whole data URI in one field; there is no separate format knob. */
        dataField: audio.dataField ?? 'data',
        /** 待补充：MiMo 未列出音频容器清单；wav 在其示例中出现。 */
        mediaTypes: resolveMediaTypes(audio.mediaTypes, ['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/webm', 'audio/ogg'], 'audio.mediaTypes'),
        /** Official URL-path cap is 100 MB (audio-understanding doc). */
        maxBytes: audio.maxBytes === undefined ? 104857600 : requirePositiveInteger(audio.maxBytes, 'audio.maxBytes'),
        maxPerRequest: audio.maxPerRequest === undefined ? 1 : requirePositiveInteger(audio.maxPerRequest, 'audio.maxPerRequest'),
    };
}

/**
 * Resolve video input handling.
 *
 * Official shape (video-understanding doc): a content part
 * `{ type: 'video_url', video_url: { url }, fps, media_resolution }` where
 * `url` is a public URL or `data:{MIME};base64,{...}`, `fps` defaults to 2
 * within `[0.1, 10]`, and `media_resolution` is `default` or `max`.
 *
 * Caps: URL 300 MB; Base64 string 50 MB.
 */
function resolveVideo(raw) {
    const video = raw ?? {};
    const mode = video.mode ?? 'video_url';
    if (mode !== 'video_url' && mode !== 'file' && mode !== 'frames') {
        fail('video.mode', 'must be "video_url", "file", or "frames"');
    }
    if (mode === 'file') {
        fail('video.mode', '"file" is not implemented: MiMo documents no local-video upload (URL or Base64 only)');
    }
    if (mode === 'frames') {
        fail('video.mode', '"frames" is not implemented: MiMo performs its own frame extraction through fps/media_resolution');
    }
    const fps = video.fps === undefined ? 2 : video.fps;
    if (typeof fps !== 'number' || !Number.isFinite(fps) || fps < 0.1 || fps > 10) {
        fail('video.fps', 'must be a number from 0.1 through 10 (MiMo default 2)');
    }
    const mediaResolution = video.mediaResolution ?? 'default';
    if (mediaResolution !== 'default' && mediaResolution !== 'max') {
        fail('video.mediaResolution', 'must be "default" or "max"');
    }
    return {
        enabled: video.enabled ?? true,
        mode,
        onOversize: resolveOversizePolicy(video.onOversize, 'video.onOversize'),
        urlField: video.urlField ?? 'video_url',
        fpsField: video.fpsField ?? 'fps',
        resolutionField: video.resolutionField ?? 'media_resolution',
        fps,
        mediaResolution,
        /** Official container list: MP4, MOV, AVI, WMV. */
        mediaTypes: resolveMediaTypes(video.mediaTypes, ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-ms-wmv'], 'video.mediaTypes'),
        /**
         * Base64 payload cap is 50 MB for the encoded string, which is what
         * this plugin sends. The 300 MB figure is the URL path, which this
         * plugin never takes (it has no way to publish bytes at a URL).
         */
        maxBytes: video.maxBytes === undefined ? 52428800 : requirePositiveInteger(video.maxBytes, 'video.maxBytes'),
        maxPerRequest: video.maxPerRequest === undefined ? 1 : requirePositiveInteger(video.maxPerRequest, 'video.maxPerRequest'),
    };
}

/**
 * How one occurrence that breaks a route bound is handled.
 *
 * `degrade` (the default) keeps durable history intact and tells the model what
 * it did not receive. `reject` fails the request instead. Either way the
 * occurrence is never truncated and never silently dropped.
 */
function resolveOversizePolicy(raw, path) {
    if (raw === undefined) return 'degrade';
    if (raw !== 'degrade' && raw !== 'reject') fail(path, 'must be "degrade" or "reject"');
    return raw;
}

function resolveMediaTypes(raw, fallback, path) {
    if (raw === undefined) return [...fallback];
    if (!Array.isArray(raw) || raw.length === 0) fail(path, 'must be a non-empty list of media types');
    return raw.map((entry, index) => requireNonEmptyString(entry, `${path}[${index}]`));
}

/**
 * Keep one effort level out of every model's way.
 *
 * The harness materializes this level into any request that omits an effort,
 * and `resolveCallConfig` rejects the request when the exact model does not
 * offer it. A deployment-wide default that one model's `reasoning.efforts`
 * excludes would therefore break that model while looking correct in config,
 * so the default is narrowed to the levels every model accepts. A model that
 * declares `reasoning: false` is skipped: it offers nothing, so it cannot
 * constrain the default and its own requests carry no level at all.
 *
 * @param wanted - the configured or derived default level.
 * @param reasoning - validated deployment reasoning config.
 * @param models - resolved model entries.
 * @returns the level every model accepts, falling back to the first one.
 */
function narrowDefaultToModels(wanted, reasoning, models) {
    const restricting = models.filter((model) => model.reasoning !== false && model.reasoning?.efforts !== undefined);
    if (restricting.length === 0) return wanted;
    const accepted = (model) => model.reasoning.efforts;
    if (wanted !== undefined && restricting.every((model) => accepted(model).includes(wanted))) return wanted;
    const shared = reasoning.efforts
        .map((effort) => effort.id)
        .find((id) => restricting.every((model) => accepted(model).includes(id)));
    return shared ?? wanted;
}

function resolveModels(raw, defaultContextWindow, reasoning) {
    if (raw === undefined || !Array.isArray(raw) || raw.length === 0) {
        fail('models', 'must be a non-empty list');
    }
    const knownEfforts = new Set(reasoning.efforts.map((effort) => effort.id));
    const seen = new Set();
    return raw.map((entry, index) => {
        const id = requireNonEmptyString(entry?.id, `models[${index}].id`);
        if (seen.has(id)) fail('models', `declares "${id}" twice`);
        seen.add(id);
        const modalities = entry.inputModalities ?? ['text'];
        if (!Array.isArray(modalities) || modalities.length === 0) fail(`models[${index}].inputModalities`, 'must be a non-empty list');
        for (const modality of modalities) {
            if (!MODALITIES.includes(modality)) {
                fail(`models[${index}].inputModalities`, `may only contain ${MODALITIES.join(', ')}; got "${modality}"`);
            }
        }
        if (new Set(modalities).size !== modalities.length) fail(`models[${index}].inputModalities`, 'must not contain duplicates');

        const reasoningRestriction = entry.reasoning;
        if (reasoningRestriction !== undefined && reasoningRestriction !== false) {
            if (typeof reasoningRestriction !== 'object' || reasoningRestriction === null || Array.isArray(reasoningRestriction)) {
                fail(`models[${index}].reasoning`, 'must be false or a mapping');
            }
            if (reasoningRestriction.efforts !== undefined) {
                if (!Array.isArray(reasoningRestriction.efforts)) {
                    fail(`models[${index}].reasoning.efforts`, 'must be a list of effort ids');
                }
                if (reasoningRestriction.efforts.length === 0) {
                    fail(`models[${index}].reasoning.efforts`, 'must not be empty; use `reasoning: false` for a non-reasoning model');
                }
                // Reject at load rather than letting `resolveModel()` throw
                // later: such a throw makes `buildModelCatalog` drop the whole
                // provider group, hiding every other model too.
                const local = new Set();
                reasoningRestriction.efforts.forEach((effortId, position) => {
                    requireNonEmptyString(effortId, `models[${index}].reasoning.efforts[${position}]`);
                    if (local.has(effortId)) fail(`models[${index}].reasoning.efforts`, `names "${effortId}" twice`);
                    local.add(effortId);
                    if (!knownEfforts.has(effortId)) {
                        fail(`models[${index}].reasoning.efforts`, `names "${effortId}", which the deployment does not declare (declared: ${[...knownEfforts].join(', ')})`);
                    }
                });
            }
            if (reasoningRestriction.defaultEffort !== undefined) {
                requireNonEmptyString(reasoningRestriction.defaultEffort, `models[${index}].reasoning.defaultEffort`);
                if (!knownEfforts.has(reasoningRestriction.defaultEffort)) {
                    fail(`models[${index}].reasoning.defaultEffort`, `names "${reasoningRestriction.defaultEffort}", which the deployment does not declare`);
                }
                if (Array.isArray(reasoningRestriction.efforts) && !reasoningRestriction.efforts.includes(reasoningRestriction.defaultEffort)) {
                    fail(`models[${index}].reasoning.defaultEffort`, `names "${reasoningRestriction.defaultEffort}", which this model's own reasoning.efforts excludes`);
                }
            }
        }

        return {
            id,
            name: entry.name ?? id,
            description: entry.description,
            contextWindow: entry.contextWindow === undefined
                ? defaultContextWindow
                : requirePositiveInteger(entry.contextWindow, `models[${index}].contextWindow`),
            maxTokens: entry.maxTokens === undefined
                ? undefined
                : requirePositiveInteger(entry.maxTokens, `models[${index}].maxTokens`),
            inputModalities: [...modalities],
            reasoning: reasoningRestriction === undefined ? undefined : reasoningRestriction,
            defaultEffort: entry.defaultEffort === undefined
                ? undefined
                : requireNonEmptyString(entry.defaultEffort, `models[${index}].defaultEffort`),
            videoFrameFormat: entry.videoFrameFormat,
            systemPromptUpdate: entry.systemPromptUpdate,
        };
    });
}

/**
 * The `Config` export the harness reads for row-level validation.
 *
 * Cordis resolves a plugin's config through the **Standard Schema** interface:
 * `runtime.Config['~standard'].validate(raw)` must return `{ value }` or
 * `{ issues }` synchronously (`@deepseek-ai/cordis` lib/index.js:955-961).
 * A schema-shaped object without `~standard` fails the whole plugin tree at
 * boot, so that interface — not the `parse`/`toString` shape — is the contract
 * this export must satisfy.
 */
export const Config = {
    '~standard': {
        version: 1,
        vendor: 'dsh-mimo-adapter',
        /**
         * @param raw - the row config.
         * @returns `{ value }` with the validated configuration, or `{ issues }` describing every refusal.
         */
        validate(raw) {
            try {
                return { value: resolveConfig(raw) };
            } catch (error) {
                return { issues: [{ message: error instanceof Error ? error.message : String(error), path: [] }] };
            }
        },
    },
    /** Convenience alias used by tests and by code that wants the throw form. */
    parse(raw) {
        return resolveConfig(raw);
    },
    toString() {
        return 'dsh-mimo-adapter config (provider, baseURL, apiKeyEnv, auth, models, thinking/efforts, audio, video, bounds)';
    },
};
