import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    Config,
    resolveConfig,
    makeAdapter,
    makeContext,
    makeLlmRegistry,
    makeAttachments,
    sseFetch,
    errorFetch,
    collect,
    userMessage,
    fileRef,
    imageRef,
} from './helpers.mjs';

/** The stock fixture config; the adapter never contacts this host. */
const CONFIG = { baseURL: 'https://mimo.test/v1', apiKeyEnv: 'MIMO_API_KEY' };

function delta(content) {
    return { choices: [{ index: 0, delta: content, finish_reason: null }] };
}

/**
 * Run one request through the adapter and return the wire body it produced.
 *
 * `config` is the plugin config; `request` is the harness request. Keeping the
 * two apart is what makes the thinking tests meaningful: a level is only
 * requestable when the *model* the request names was declared with it.
 */
async function wireBody({ config = {}, request = {}, env = {}, model = 'mimo-vl' } = {}) {
    let body;
    const { adapter } = makeAdapter(config, {
        ...env,
        fetchImpl: env.fetchImpl ?? sseFetch(
            [delta({ content: 'ok' }), '[DONE]'],
            { capture: ({ init }) => { body = JSON.parse(init.body); } },
        ),
    });
    await collect(adapter.stream({
        provider: 'xiaomi',
        model,
        messages: env.messages ?? [userMessage([{ type: 'text', text: 'hi' }])],
        ...request,
    }));
    return body;
}

/** One audio content block over a stub attachment. */
function audioBlock(attachmentId = 'att-audio', name = 'clip.wav', size = 3) {
    return [{ type: 'audio', attachment: fileRef(attachmentId, name, size), mediaType: 'audio/wav' }];
}

/** One video content block over a stub attachment. */
function videoBlock(attachmentId = 'att-video', name = 'take.mp4', size = 1) {
    return [{ type: 'video', attachment: fileRef(attachmentId, name, size), mediaType: 'video/mp4' }];
}

// ─────────────────────────── official-spec defaults ───────────────────────────

test('config: defaults are the official MiMo endpoint, credential header, and path', () => {
    const connection = resolveConfig({});
    assert.equal(connection.baseURL, 'https://api.xiaomimimo.com/v1');
    assert.equal(connection.path, '/chat/completions');
    assert.deepEqual(connection.auth, {
        scheme: 'header',
        headerName: 'api-key',
        queryParam: undefined,
        prefix: undefined,
    });
    assert.equal(connection.apiKeyEnv, 'XIAOMI_API_KEY');
});

test('config: the official catalog carries the documented models and limits', () => {
    const connection = resolveConfig({});
    assert.deepEqual(connection.models.map((model) => model.id), [
        'mimo-v2.6-pro',
        'mimo-v2.6-flash',
        'mimo-v2.6-pro-ultraspeed',
        'mimo-v2.5-pro',
        'mimo-v2.5',
        'mimo-v2.5-asr',
    ]);
    const pro = connection.models[0];
    assert.equal(pro.contextWindow, 1048576);
    assert.equal(pro.maxTokens, 131072);
    assert.deepEqual(pro.inputModalities, ['text', 'image', 'audio', 'video']);
    const asr = connection.models.at(-1);
    assert.deepEqual(asr.inputModalities, ['audio']);
    assert.equal(asr.contextWindow, 8192);
});

test('config: rejects a baseURL that embeds credentials or a query', () => {
    assert.throws(() => resolveConfig({ baseURL: 'https://user:pass@mimo.example/v1' }), /must not embed credentials/);
    assert.throws(() => resolveConfig({ baseURL: 'https://mimo.example/v1?key=1' }), /must not carry a query/);
});

test('config: Config implements the Standard Schema interface cordis resolves a row through', () => {
    const standard = Config['~standard'];
    assert.equal(typeof standard.validate, 'function');
    assert.equal(standard.version, 1);
    const ok = standard.validate(CONFIG);
    assert.equal(ok.value.baseURL, 'https://mimo.test/v1');
    assert.equal(ok.issues, undefined);

    const bad = standard.validate({ ...CONFIG, protocol: 'anthropic-messages' });
    assert.equal(bad.value, undefined);
    assert.match(bad.issues[0].message, /not supported/);
});

test('config: an unimplementable media mode is refused at load, not after reading the file', () => {
    assert.throws(() => resolveConfig({ video: { mode: 'file' } }), /no local-video upload/);
    assert.throws(() => resolveConfig({ video: { mode: 'frames' } }), /performs its own frame extraction/);
    assert.throws(() => resolveConfig({ audio: { mode: 'file' } }), /no audio upload endpoint/);
});

test('config: video fps and media_resolution follow the documented ranges', () => {
    assert.equal(resolveConfig({}).video.fps, 2);
    assert.equal(resolveConfig({}).video.mediaResolution, 'default');
    assert.equal(resolveConfig({ video: { fps: 0.1 } }).video.fps, 0.1);
    assert.equal(resolveConfig({ video: { fps: 10, mediaResolution: 'max' } }).video.mediaResolution, 'max');
    assert.throws(() => resolveConfig({ video: { fps: 0 } }), /0\.1 through 10/);
    assert.throws(() => resolveConfig({ video: { fps: 11 } }), /0.1 through 10/);
    assert.throws(() => resolveConfig({ video: { mediaResolution: 'high' } }), /must be "default" or "max"/);
});

test('config: a model restriction naming an undeclared level is refused at load', () => {
    // Left to request time, `resolveModel()` would throw and the harness would
    // drop the whole provider group from the model selector.
    assert.throws(
        () => resolveConfig({ models: [{ id: 'x', reasoning: { efforts: ['ultra'] } }] }),
        /which the deployment does not declare/,
    );
    assert.throws(
        () => resolveConfig({ models: [{ id: 'x', reasoning: { efforts: ['off', 'off'] } }] }),
        /names "off" twice/,
    );
    assert.throws(
        () => resolveConfig({ models: [{ id: 'x', reasoning: { efforts: [] } }] }),
        /use `reasoning: false`/,
    );
    assert.throws(
        () => resolveConfig({ models: [{ id: 'x', reasoning: { efforts: ['off'], defaultEffort: 'high' } }] }),
        /excludes/,
    );
});

test('config: the deployment default is narrowed to what the models actually offer', () => {
    // Otherwise `resolveModelInfo()` materializes a level two of these models
    // cannot accept, and `buildModelCatalog` drops the group.
    const connection = resolveConfig({
        models: [
            { id: 'full', inputModalities: ['text'] },
            { id: 'narrow', inputModalities: ['text'], reasoning: { efforts: ['off'] } },
        ],
        efforts: [
            { id: 'off', name: 'Off', inert: true, thinking: { type: 'disabled' } },
            { id: 'low', name: 'Low', thinking: { type: 'enabled' } },
            { id: 'high', name: 'High', thinking: { type: 'enabled' } },
        ],
        defaultEffort: 'high',
    });
    assert.equal(connection.reasoning.defaultEffort, 'off');
});

// ─────────────────────────── reasoning effort (思考强度) ───────────────────────────

test('thinking: the documented binary vocabulary is what gets published', async () => {
    const { adapter } = makeAdapter(CONFIG);
    const info = await adapter.resolveModel('xiaomi', 'mimo-vl');
    assert.deepEqual(info.reasoning.efforts.map((effort) => effort.id), ['off', 'high']);
    assert.deepEqual(info.reasoning.efforts.map((effort) => effort.name), ['Off', 'Deep thinking']);
    assert.equal(info.reasoning.defaultEffort, 'high');
});

test('thinking: an unoffered level fails with UNSUPPORTED_REASONING_EFFORT before any provider I/O', async () => {
    let called = false;
    const { adapter } = makeAdapter(CONFIG, { fetchImpl: async () => { called = true; return new Response(''); } });
    await assert.rejects(
        collect(adapter.stream({ provider: 'xiaomi', model: 'mimo-vl', messages: [userMessage([{ type: 'text', text: 'hi' }])], reasoningEffort: 'ultra' })),
        (error) => error.code === 'UNSUPPORTED_REASONING_EFFORT',
    );
    assert.equal(called, false, 'no provider request may happen for a rejected effort');
});

test('thinking: each level applies its exact MiMo wire spelling', async () => {
    const off = await wireBody({ request: { reasoningEffort: 'off' } });
    assert.deepEqual(off.thinking, { type: 'disabled' });
    assert.equal(off.reasoning_effort, undefined);

    const high = await wireBody({ request: { reasoningEffort: 'high' } });
    assert.deepEqual(high.thinking, { type: 'enabled' });
    assert.equal(high.reasoning_effort, undefined);
});

test('thinking: the deployment default materializes when the caller omits an effort', async () => {
    const body = await wireBody({});
    assert.deepEqual(body.thinking, { type: 'enabled' });
});

test('thinking: thinking:disabled locks every request to the inert level', async () => {
    const body = await wireBody({ config: { thinking: 'disabled' }, request: { reasoningEffort: 'high' } });
    assert.deepEqual(body.thinking, { type: 'disabled' });
});

test('thinking: a deployment can rename the wire fields without touching code', async () => {
    const body = await wireBody({
        config: {
            thinkingField: 'reasoning',
            effortFieldName: 'thinking_level',
            efforts: [
                { id: 'off', name: 'Off', thinking: { enabled: false } },
                { id: 'deep', name: 'Deep', reasoningEffort: 'deep' },
            ],
        },
        request: { reasoningEffort: 'deep' },
    });
    assert.equal(body.thinking_level, 'deep');
    assert.equal(body.reasoning, undefined, 'a level writes only its own fields');
});

test('thinking: a session-title purpose call never spends the reasoning budget', async () => {
    const body = await wireBody({ request: { purpose: 'session-title' } });
    assert.deepEqual(body.thinking, { type: 'disabled' });
});

test('thinking: a non-reasoning model sends no reasoning field at all', async () => {
    const body = await wireBody({
        config: { models: [{ id: 'plain', inputModalities: ['text'], reasoning: false }] },
        model: 'plain',
    });
    assert.equal(body.thinking, undefined);
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(body.reasoning, undefined);
});

test('thinking: a restricted model publishes only its own levels and no foreign default', async () => {
    const { adapter } = makeAdapter({
        models: [{ id: 'fast-only', inputModalities: ['text'], reasoning: { efforts: ['off'] } }],
    });
    const info = await adapter.resolveModel('xiaomi', 'fast-only');
    assert.deepEqual(info.reasoning.efforts.map((effort) => effort.id), ['off']);
    assert.equal(info.reasoning.defaultEffort, 'off', 'the deployment default must not leak past the restriction');
});

// ─────────────────────────── request shape (documented fields) ───────────────────────────

test('request: MiMo uses max_completion_tokens, not max_tokens', async () => {
    const body = await wireBody({});
    assert.equal(body.max_completion_tokens, 131072);
    assert.equal(body.max_tokens, undefined);
    const capped = await wireBody({ request: { maxTokens: 512 } });
    assert.equal(capped.max_completion_tokens, 512);
});

test('request: temperature is omitted while thinking is on, sent when thinking is off', async () => {
    const thinkingOn = await wireBody({ request: { temperature: 0.3 } });
    assert.equal(thinkingOn.temperature, undefined, 'MiMo ignores custom temperature while deep thinking is on');
    const thinkingOff = await wireBody({ request: { temperature: 0.3, reasoningEffort: 'off' } });
    assert.equal(thinkingOff.temperature, 0.3);
});

test('request: an assistant turn with tool calls replays reasoning_content', async () => {
    // MiMo answers 400 when deep thinking is on, history contains tool calls,
    // and the assistant turn omits reasoning_content (deep-thinking doc).
    let body;
    const { adapter } = makeAdapter(CONFIG, {
        fetchImpl: sseFetch([delta({ content: 'ok' }), '[DONE]'], { capture: ({ init }) => { body = JSON.parse(init.body); } }),
    });
    await collect(adapter.stream({
        provider: 'xiaomi',
        model: 'mimo-vl',
        messages: [
            { id: 'a', role: 'assistant', content: [
                { type: 'reasoning', text: 'I should look it up.' },
                { type: 'text', text: 'Let me check.' },
                { type: 'tool-call', id: 'call-1', name: 'get_weather', arguments: '{"location":"Wuhan"}' },
            ], source: { kind: 'model', provider: 'xiaomi', model: 'mimo-vl' } },
            { id: 'b', role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'sunny' }] }], source: { kind: 'tool', callId: 'call-1' } },
        ],
    }));
    assert.equal(body.messages[0].reasoning_content, 'I should look it up.');
    assert.equal(body.messages[0].tool_calls[0].function.name, 'get_weather');
});

test('request: a plain assistant turn does not pay for reasoning twice', async () => {
    let body;
    const { adapter } = makeAdapter(CONFIG, {
        fetchImpl: sseFetch([delta({ content: 'ok' }), '[DONE]'], { capture: ({ init }) => { body = JSON.parse(init.body); } }),
    });
    await collect(adapter.stream({
        provider: 'xiaomi',
        model: 'mimo-vl',
        messages: [
            { id: 'a', role: 'assistant', content: [
                { type: 'reasoning', text: 'hidden chain' },
                { type: 'text', text: 'Answer.' },
            ], source: { kind: 'model', provider: 'xiaomi', model: 'mimo-vl' } },
        ],
    }));
    assert.equal(body.messages[0].reasoning_content, undefined);
    assert.equal(body.messages[0].content, 'Answer.');
});

test('transport: the default credential goes in the api-key header', async () => {
    let headers;
    await wireBody({ env: { fetchImpl: sseFetch([delta({ content: 'ok' }), '[DONE]'], { capture: ({ init }) => { headers = init.headers; } }) } });
    assert.equal(headers['api-key'], 'test-key');
    assert.equal(headers.authorization, undefined);
});

test('transport: a bearer deployment can still use Authorization', async () => {
    let headers;
    await wireBody({
        config: { auth: { scheme: 'bearer' } },
        env: { fetchImpl: sseFetch([delta({ content: 'ok' }), '[DONE]'], { capture: ({ init }) => { headers = init.headers; } }) },
    });
    assert.equal(headers.authorization, 'Bearer test-key');
    assert.equal(headers['api-key'], undefined);
});

test('transport: the mandatory attribution headers are on the wire request', async () => {
    let headers;
    await wireBody({ env: { fetchImpl: sseFetch([delta({ content: 'ok' }), '[DONE]'], { capture: ({ init }) => { headers = init.headers; } }) } });
    assert.ok(Object.keys(headers).some((key) => key.startsWith('x-') || key.includes('deepseek') || key.includes('user-agent')),
        `attribution headers missing from ${JSON.stringify(Object.keys(headers))}`);
});

// ─────────────────────────── audio input modality ───────────────────────────

test('audio: the documented input_audio shape carries a data URI in `data`', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const attachments = makeAttachments({ 'att-audio': { name: 'clip.wav', bytes, mediaType: 'audio/wav' } });
    let body;
    const { adapter } = makeAdapter({}, {
        attachments,
        fetchImpl: sseFetch([delta({ content: 'ok' }), '[DONE]'], { capture: ({ init }) => { body = JSON.parse(init.body); } }),
    });
    await collect(adapter.stream({
        provider: 'xiaomi',
        model: 'mimo-audio',
        messages: [userMessage([
            { type: 'text', text: 'transcribe' },
            { type: 'audio', attachment: fileRef('att-audio', 'clip.wav', bytes.byteLength), mediaType: 'audio/wav' },
        ])],
    }));
    const content = body.messages.find((message) => message.role === 'user').content;
    assert.equal(content[0].text, 'transcribe');
    assert.match(content[1].text, /\[audio attachment id=att-audio name=clip\.wav bytes=9 format=wav/);
    assert.equal(content[2].type, 'input_audio');
    assert.equal(content[2].input_audio.data, `data:audio/wav;base64,${Buffer.from(bytes).toString('base64')}`);
    assert.equal(content[2].input_audio.format, undefined, 'MiMo takes the whole data URI in `data`, not a separate format field');
});

test('audio: chunked attachment reads assemble exact bytes', async () => {
    const bytes = Uint8Array.from({ length: 100 }, (_, index) => index % 251);
    const attachments = makeAttachments({ 'att-big': { name: 'long.wav', bytes } });
    let body;
    const { adapter } = makeAdapter({}, {
        attachments,
        fetchImpl: sseFetch([delta({ content: 'ok' }), '[DONE]'], { capture: ({ init }) => { body = JSON.parse(init.body); } }),
    });
    await collect(adapter.stream({
        provider: 'xiaomi',
        model: 'mimo-audio',
        messages: [userMessage([{ type: 'audio', attachment: fileRef('att-big', 'long.wav', 100), mediaType: 'audio/wav' }])],
    }));
    const part = body.messages[0].content.find((entry) => entry.type === 'input_audio');
    assert.equal(part.input_audio.data, `data:audio/wav;base64,${Buffer.from(bytes).toString('base64')}`);
});

test('audio: an undeclared model receives a naming placeholder instead of bytes', async () => {
    const attachments = makeAttachments({ 'att-audio': { name: 'clip.wav', bytes: new Uint8Array([9, 9, 9]) } });
    const body = await wireBody({
        config: { models: [{ id: 'text-only', inputModalities: ['text'] }] },
        model: 'text-only',
        env: { attachments, messages: [userMessage(audioBlock())] },
    });
    const part = body.messages[0].content[0];
    assert.equal(part.type, 'text');
    assert.match(part.text, /does not declare the audio modality/);
});

test('audio: an attachment over maxBytes is omitted with a named placeholder, not truncated', async () => {
    const attachments = makeAttachments({ 'att-audio': { name: 'huge.wav', bytes: new Uint8Array(64) } });
    const body = await wireBody({
        config: { audio: { maxBytes: 16 } },
        model: 'mimo-audio',
        env: { attachments, messages: [userMessage(audioBlock('att-audio', 'huge.wav', 64))] },
    });
    const part = body.messages[0].content[0];
    assert.equal(part.type, 'text');
    assert.match(part.text, /was NOT sent: the attachment is 64 bytes/);
});

test('audio: onOversize "reject" fails on a broken configured bound instead of degrading', async () => {
    const attachments = makeAttachments({ 'att-audio': { name: 'huge.wav', bytes: new Uint8Array(64) } });
    const { adapter } = makeAdapter({ audio: { maxBytes: 16, onOversize: 'reject' } }, { attachments });
    await assert.rejects(
        collect(adapter.stream({
            provider: 'xiaomi',
            model: 'mimo-audio',
            messages: [userMessage([{ type: 'audio', attachment: fileRef('att-audio', 'huge.wav', 64), mediaType: 'audio/wav' }])],
        })),
        (error) => error.code === 'MEDIA_TOO_LARGE' && /onOversize is "reject"/.test(error.message),
    );
});

test('audio: a deployment-disabled modality degrades even under onOversize "reject"', async () => {
    const attachments = makeAttachments({ 'att-audio': { name: 'clip.wav', bytes: new Uint8Array(4) } });
    const body = await wireBody({
        config: { audio: { enabled: false, onOversize: 'reject' } },
        model: 'mimo-audio',
        env: { attachments, messages: [userMessage(audioBlock('att-audio', 'clip.wav', 4))] },
    });
    assert.match(body.messages[0].content[0].text, /has the audio modality disabled/);
});

test('audio: the request-wide budget and per-request count both omit deterministically', async () => {
    const bytes = new Uint8Array(8);
    const attachments = makeAttachments({
        'att-1': { name: 'one.wav', bytes },
        'att-2': { name: 'two.wav', bytes },
    });
    const body = await wireBody({
        config: { maxRequestMediaBytes: 8, audio: { maxPerRequest: 2, maxBytes: 8 } },
        model: 'mimo-audio',
        env: {
            attachments,
            messages: [userMessage([
                { type: 'audio', attachment: fileRef('att-1', 'one.wav', 8), mediaType: 'audio/wav' },
                { type: 'audio', attachment: fileRef('att-2', 'two.wav', 8), mediaType: 'audio/wav' },
            ])],
        },
    });
    const parts = body.messages[0].content;
    assert.equal(parts.filter((part) => part.type === 'input_audio').length, 1, 'only one occurrence fits the byte budget');
    assert.match(parts.find((part) => part.type === 'text' && part.text.includes('NOT sent')).text, /maxRequestMediaBytes/);
});

// ─────────────────────────── video input modality ───────────────────────────

test('video: the documented video_url shape carries url, fps, and media_resolution', async () => {
    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
    const attachments = makeAttachments({ 'att-video': { name: 'take.mp4', bytes, mediaType: 'video/mp4' } });
    const body = await wireBody({
        model: 'mimo-video',
        env: { attachments, messages: [userMessage(videoBlock('att-video', 'take.mp4', 8))] },
    });
    const content = body.messages[0].content;
    assert.match(content[0].text, /\[video attachment id=att-video name=take\.mp4 bytes=8 format=mp4/);
    assert.equal(content[1].type, 'video_url');
    assert.equal(content[1].video_url.url, `data:video/mp4;base64,${Buffer.from(bytes).toString('base64')}`);
    assert.equal(content[1].fps, 2);
    assert.equal(content[1].media_resolution, 'default');
});

test('video: configured fps and resolution reach the wire', async () => {
    const attachments = makeAttachments({ 'att-video': { name: 'take.mp4', bytes: new Uint8Array([1]) } });
    const body = await wireBody({
        config: { video: { fps: 10, mediaResolution: 'max' } },
        model: 'mimo-video',
        env: { attachments, messages: [userMessage(videoBlock())] },
    });
    const part = body.messages[0].content.find((entry) => entry.type === 'video_url');
    assert.equal(part.fps, 10);
    assert.equal(part.media_resolution, 'max');
});

test('video: the default caps are the documented 50 MB Base64 and 100 MB URL limits', () => {
    assert.equal(resolveConfig({}).video.maxBytes, 52428800);
    assert.equal(resolveConfig({}).audio.maxBytes, 104857600);
});

test('video: a model that does not declare video gets a placeholder', async () => {
    const attachments = makeAttachments({ 'att-video': { name: 'take.mp4', bytes: new Uint8Array([1]) } });
    const body = await wireBody({
        model: 'mimo-audio',
        env: { attachments, messages: [userMessage(videoBlock())] },
    });
    assert.match(body.messages[0].content[0].text, /does not declare the video modality/);
});

test('media: the same attachment referenced twice is read and encoded once', async () => {
    const base = makeAttachments({ 'att-1': { name: 'a.wav', bytes: new Uint8Array([4, 5, 6]) } });
    let reads = 0;
    const attachments = {
        ...base,
        readFileStream(ref, signal) {
            reads += 1;
            return base.readFileStream.call(base, ref, signal);
        },
    };
    await wireBody({
        model: 'mimo-audio',
        env: {
            attachments,
            messages: [userMessage([
                { type: 'audio', attachment: fileRef('att-1', 'a.wav', 3), mediaType: 'audio/wav' },
                { type: 'audio', attachment: fileRef('att-1', 'a.wav', 3), mediaType: 'audio/wav' },
            ])],
            fetchImpl: sseFetch([delta({ content: 'ok' }), '[DONE]']),
        },
    });
    assert.equal(reads, 1, 'one attachment occurrence is read once even when referenced twice');
});

// ─────────────────────────── other content blocks ───────────────────────────

test('messages: files become harness handle text and never bytes', async () => {
    let body;
    const { adapter } = makeAdapter(CONFIG, {
        fetchImpl: sseFetch([delta({ content: 'ok' }), '[DONE]'], { capture: ({ init }) => { body = JSON.parse(init.body); } }),
    });
    await collect(adapter.stream({
        provider: 'xiaomi',
        model: 'mimo-vl',
        messages: [userMessage([{ type: 'file', attachment: fileRef('att-file', 'notes.txt', 120) }])],
    }));
    const part = body.messages[0].content[0];
    assert.equal(part.type, 'text');
    assert.match(part.text, /notes\.txt/);
    assert.match(part.text, /120/);
});

test('messages: image blocks use the documented image_url shape', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const attachments = makeAttachments({ 'att-img': { name: 'shot.png', bytes, mediaType: 'image/png' } });
    const body = await wireBody({
        env: { attachments, messages: [userMessage([{ type: 'image', attachment: imageRef('att-img', 'shot.png', 4) }])] },
    });
    const part = body.messages[0].content.find((entry) => entry.type === 'image_url');
    assert.equal(part.image_url.url, `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`);
});

test('messages: tool results keep their call id and a text-only route still answers', async () => {
    let body;
    const { adapter } = makeAdapter(CONFIG, {
        fetchImpl: sseFetch([delta({ content: 'ok' }), '[DONE]'], { capture: ({ init }) => { body = JSON.parse(init.body); } }),
    });
    await collect(adapter.stream({
        provider: 'xiaomi',
        model: 'mimo-vl',
        messages: [
            { id: 'a', role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"x"}' }], source: { kind: 'model', provider: 'xiaomi', model: 'mimo-vl' } },
            { id: 'b', role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'file body' }] }], source: { kind: 'tool', callId: 'call-1' } },
        ],
    }));
    assert.equal(body.messages[0].tool_calls[0].id, 'call-1');
    assert.equal(body.messages[0].tool_calls[0].function.arguments, '{"path":"x"}');
    assert.deepEqual(body.messages[1], { role: 'tool', tool_call_id: 'call-1', content: 'file body' });
});

test('stream: an unknown block type is refused rather than silently dropped', async () => {
    const { adapter } = makeAdapter(CONFIG, { fetchImpl: sseFetch([delta({ content: 'ok' }), '[DONE]']) });
    await assert.rejects(
        collect(adapter.stream({
            provider: 'xiaomi',
            model: 'mimo-vl',
            messages: [userMessage([{ type: 'hologram', payload: {} }])],
        })),
        (error) => error.code === 'UNSUPPORTED_MODALITY' && /unknown to this adapter/.test(error.message),
    );
});

// ─────────────────────────── streaming protocol ───────────────────────────

test('stream: every block is opened, closed, and followed by exactly one terminal finish', async () => {
    const { adapter } = makeAdapter(CONFIG, {
        fetchImpl: sseFetch([
            delta({ content: 'Hel' }),
            delta({ content: 'lo' }),
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-9', function: { name: 'search', arguments: '{"q":' } }] }, finish_reason: null }] },
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
            '[DONE]',
        ]),
    });
    const chunks = await collect(adapter.stream({
        provider: 'xiaomi',
        model: 'mimo-vl',
        messages: [userMessage([{ type: 'text', text: 'hi' }])],
    }));

    assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' });
    assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1);
    assert.deepEqual(chunks.filter((chunk) => chunk.type === 'block-start').map((chunk) => chunk.blockType), ['text', 'tool-call']);
    const ends = chunks.filter((chunk) => chunk.type === 'block-end');
    assert.deepEqual(ends.map((chunk) => chunk.block.type), ['text', 'tool-call']);
    assert.equal(ends[0].block.text, 'Hello');
    assert.deepEqual(ends[1].block, { type: 'tool-call', id: 'call-9', name: 'search', arguments: '{"q":"x"}' });
    assert.equal(chunks.length, chunks.findIndex((chunk) => chunk.type === 'finish') + 1, 'nothing may follow the terminal finish');
});

test('stream: a provider that reports the call id once keeps it for the whole call', async () => {
    // MiMo sends `id` on the first tool-call delta and `null` on every later
    // one. Overwriting with that null produced `tool_calls[].id = null` on the
    // replay, and MiMo answered 400 "`id` is null" — an agent loop could not
    // complete a single tool call.
    const { adapter } = makeAdapter(CONFIG, {
        fetchImpl: sseFetch([
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_abc123', type: 'function', function: { name: 'get_time', arguments: '' } }] }, finish_reason: null }] },
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: null, function: { arguments: '{"city":', name: null } }] }, finish_reason: null }] },
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: null, function: { arguments: '"Wuhan"}', name: null } }] }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
            '[DONE]',
        ]),
    });
    const chunks = await collect(adapter.stream({
        provider: 'xiaomi',
        model: 'mimo-vl',
        messages: [userMessage([{ type: 'text', text: 'hi' }])],
    }));
    const block = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block;
    assert.equal(block.id, 'call_abc123');
    assert.equal(block.name, 'get_time');
    assert.equal(block.arguments, '{"city":"Wuhan"}');
    assert.ok(chunks.filter((chunk) => chunk.type === 'tool-call-delta').every((chunk) => chunk.id === 'call_abc123'),
        'every delta must carry the id the harness will replay');
});

test('stream: an id-less provider still gets a usable synthesized call id', async () => {
    const { adapter } = makeAdapter(CONFIG, {
        fetchImpl: sseFetch([
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'read', arguments: '{}' } }] }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
            '[DONE]',
        ]),
    });
    const chunks = await collect(adapter.stream({
        provider: 'xiaomi',
        model: 'mimo-vl',
        messages: [userMessage([{ type: 'text', text: 'hi' }])],
    }));
    const block = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block;
    assert.equal(typeof block.id, 'string');
    assert.ok(block.id.length > 0, `synthesized id must be non-empty, got ${JSON.stringify(block.id)}`);
});

test('stream: reasoning arrives as reasoning deltas, separate from visible text', async () => {
    const { adapter } = makeAdapter(CONFIG, {
        fetchImpl: sseFetch([
            { choices: [{ index: 0, delta: { reasoning_content: 'think ' }, finish_reason: null }] },
            { choices: [{ index: 0, delta: { reasoning_content: 'more' }, finish_reason: null }] },
            { choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
            '[DONE]',
        ]),
    });
    const chunks = await collect(adapter.stream({
        provider: 'xiaomi',
        model: 'mimo-vl',
        messages: [userMessage([{ type: 'text', text: 'hi' }])],
    }));
    assert.equal(chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join(''), 'think more');
    assert.equal(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), 'answer');
    assert.deepEqual(chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block.type), ['reasoning', 'text']);
});

test('stream: cache reads are subtracted from the aggregate prompt count', async () => {
    const { adapter } = makeAdapter(CONFIG, {
        fetchImpl: sseFetch([
            { choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_tokens_details: { cached_tokens: 80 } } },
            '[DONE]',
        ]),
    });
    const chunks = await collect(adapter.stream({
        provider: 'xiaomi',
        model: 'mimo-vl',
        messages: [userMessage([{ type: 'text', text: 'hi' }])],
    }));
    const usage = chunks.find((chunk) => chunk.type === 'usage').usage;
    assert.equal(usage.inputTokens, 20);
    assert.equal(usage.cacheReadTokens, 80);
    assert.equal(usage.outputTokens, 5);
});

test('stream: a usage-only empty stream still reports its usage', async () => {
    const { adapter } = makeAdapter(CONFIG, {
        fetchImpl: sseFetch([
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 0, total_tokens: 7 } },
            '[DONE]',
        ]),
    });
    const chunks = await collect(adapter.stream({
        provider: 'xiaomi',
        model: 'mimo-vl',
        messages: [userMessage([{ type: 'text', text: 'hi' }])],
    }));
    assert.equal(chunks.at(-1).reason.kind, 'error');
    assert.equal(chunks.at(-1).reason.failure.code, 'EMPTY_RESPONSE');
    assert.equal(chunks.find((chunk) => chunk.type === 'usage')?.usage?.inputTokens, 7, 'a paid empty response must still be metered');
});

test('stream: a mid-stream provider error becomes a terminal error finish', async () => {
    const { adapter } = makeAdapter(CONFIG, {
        fetchImpl: sseFetch([delta({ content: 'partial' }), { error: { message: 'upstream exploded', code: 'SERVER' } }, '[DONE]']),
    });
    const chunks = await collect(adapter.stream({
        provider: 'xiaomi',
        model: 'mimo-vl',
        messages: [userMessage([{ type: 'text', text: 'hi' }])],
    }));
    assert.equal(chunks.at(-1).reason.kind, 'error');
    assert.equal(chunks.at(-1).reason.failure.code, 'SERVER');
    assert.match(chunks.at(-1).reason.failure.message, /upstream exploded/);
});

test('stream: an idle provider is cut off with TIMEOUT, not left hanging', async () => {
    const hanging = async () => {
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}\n\n'));
            },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const { adapter } = makeAdapter({ streamIdleTimeoutMs: 120 }, { fetchImpl: hanging });
    await assert.rejects(
        collect(adapter.stream({ provider: 'xiaomi', model: 'mimo-vl', messages: [userMessage([{ type: 'text', text: 'hi' }])] })),
        (error) => error.code === 'TIMEOUT',
    );
});

test('stream: HTTP failures map to stable harness codes and never leak the key', async () => {
    const cases = [
        [401, 'AUTH'],
        [403, 'AUTH'],
        [429, 'RATE_LIMIT'],
        [402, 'QUOTA'],
        [400, 'INVALID_REQUEST'],
        [413, 'MEDIA_TOO_LARGE'],
        [404, 'HTTP_404'],
        [503, 'HTTP_503'],
    ];
    for (const [status, code] of cases) {
        const { adapter } = makeAdapter(CONFIG, {
            apiKey: 'sk-super-secret',
            fetchImpl: errorFetch(status, 'Error', '{"error":{"message":"nope sk-super-secret"}}'),
        });
        await assert.rejects(
            collect(adapter.stream({ provider: 'xiaomi', model: 'mimo-vl', messages: [userMessage([{ type: 'text', text: 'hi' }])] })),
            (error) => {
                assert.equal(error.code, code, `status ${status} must map to ${code}`);
                assert.doesNotMatch(error.message, /sk-super-secret/, 'the credential must never appear in a diagnostic');
                return true;
            },
        );
    }
});

test('stream: a 429 Retry-After reaches the harness retry fact', async () => {
    const { adapter } = makeAdapter(CONFIG, {
        fetchImpl: errorFetch(429, 'Too Many Requests', '{}', { 'retry-after': '7' }),
    });
    await assert.rejects(
        collect(adapter.stream({ provider: 'xiaomi', model: 'mimo-vl', messages: [userMessage([{ type: 'text', text: 'hi' }])] })),
        (error) => {
            assert.equal(error.code, 'RATE_LIMIT');
            assert.equal(error.failure.providerRetryAfterMs, 7000);
            return true;
        },
    );
});

test('stream: a request without baseURL refuses with INVALID_CONFIG instead of a malformed URL', async () => {
    const { adapter } = makeAdapter({ baseURL: undefined, apiKeyEnv: 'MIMO_API_KEY' }, { fetchImpl: null });
    await assert.rejects(
        collect(adapter.stream({ provider: 'xiaomi', model: 'mimo-vl', messages: [userMessage([{ type: 'text', text: 'hi' }])] })),
        (error) => error.code === 'INVALID_CONFIG',
    );
});

// ─────────────────────────── plugin load ───────────────────────────

test('load: apply() registers the route, the directory entry, and the degradation listener', async () => {
    const { apply, name, inject } = await import('../lib/index.js');
    assert.equal(name, 'mimo-adapter');
    assert.deepEqual(inject, ['llm']);

    const llm = makeLlmRegistry();
    const ctx = makeContext({ llm });
    apply(ctx, { ...CONFIG, provider: 'xiaomi' });

    assert.ok(llm.adapters.get('xiaomi'), 'the route must be registered');
    assert.deepEqual(llm.directory.map((entry) => entry.provider), ['xiaomi']);
    assert.equal(llm.directory[0].settingsNs, 'mimo-adapter');
    assert.equal(ctx.listeners.get('llm/stream').length, 1);
});

test('load: an unusable row config fails at load, not at first request', async () => {
    const { apply } = await import('../lib/index.js');
    const ctx = makeContext({ llm: makeLlmRegistry() });
    assert.throws(() => apply(ctx, { ...CONFIG, protocol: 'anthropic-messages' }), /not supported/);
});

test('load: a settings section takes effect on the next request and the route stays fixed', async () => {
    const { apply } = await import('../lib/index.js');
    const llm = makeLlmRegistry();
    let source = () => ({ ...CONFIG, provider: 'xiaomi', defaultEffort: 'off' });
    const ctx = makeContext({
        llm,
        settings: {
            installSection(owner, ns, schema, entry, hooks) {
                hooks.setSource(() => source());
                hooks.onChange();
            },
        },
    });
    apply(ctx, { ...CONFIG, provider: 'xiaomi', defaultEffort: 'off' });

    const adapter = llm.adapters.get('xiaomi');
    let body;
    adapter.fetch = sseFetch([delta({ content: 'ok' }), '[DONE]'], { capture: ({ init }) => { body = JSON.parse(init.body); } });
    await collect(adapter.stream({ provider: 'xiaomi', model: 'mimo-vl', messages: [userMessage([{ type: 'text', text: 'hi' }])] }));
    assert.deepEqual(body.thinking, { type: 'disabled' });

    source = () => ({ ...CONFIG, provider: 'other', defaultEffort: 'high' });
    await collect(adapter.stream({ provider: 'xiaomi', model: 'mimo-vl', messages: [userMessage([{ type: 'text', text: 'hi' }])] }));
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.ok(llm.adapters.has('xiaomi'), 'the route name is fixed at load');
});

// ─────────────────────────── foreign-route degradation ───────────────────────────

test('degrade: a foreign route receives placeholder text instead of an unhandled media block', async () => {
    const { degradeForeignModalities } = await import('../lib/degrade.js');
    const attachments = makeAttachments({ 'att-audio': { name: 'clip.wav', bytes: new Uint8Array([1, 2, 3]) } });
    const options = {
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        messages: [userMessage([{ type: 'audio', attachment: fileRef('att-audio', 'clip.wav', 3), mediaType: 'audio/wav' }])],
    };
    const degraded = degradeForeignModalities(options, { attachments, imageAccess: (path) => `WORLD/${path}` });
    assert.notEqual(degraded, options);
    assert.equal(degraded.messages[0].content[0].type, 'text');
    assert.match(degraded.messages[0].content[0].text, /not served by this plugin/);
    assert.equal(options.messages[0].content[0].type, 'audio', 'the observed request must not be mutated');
});

test('degrade: media nested inside a tool result is degraded too, never silently dropped', async () => {
    const { degradeForeignModalities } = await import('../lib/degrade.js');
    const attachments = makeAttachments({ 'att-video': { name: 'take.mp4', bytes: new Uint8Array([1]) } });
    const nested = {
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        messages: [userMessage([{
            type: 'tool-result',
            toolCallId: 'call-1',
            content: [{ type: 'video', attachment: fileRef('att-video', 'take.mp4', 1), mediaType: 'video/mp4' }],
        }])],
    };
    const degraded = degradeForeignModalities(nested, { attachments: () => attachments, imageAccess: (path) => `WORLD/${path}` });
    const block = degraded.messages[0].content[0];
    assert.equal(block.type, 'tool-result');
    assert.equal(block.content[0].type, 'text');
    assert.match(block.content[0].text, /not served by this plugin/);
});

test('degrade: a request with nothing to degrade is returned unchanged', async () => {
    const { degradeForeignModalities } = await import('../lib/degrade.js');
    const options = { provider: 'deepseek-official', model: 'x', messages: [userMessage([{ type: 'text', text: 'hi' }])] };
    assert.equal(degradeForeignModalities(options, {}), options);
});
