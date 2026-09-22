/**
 * Request serialization for dsh-mimo-adapter.
 *
 * Produces the OpenAI-compatible Chat Completions body MiMo is reached with by
 * default. Everything here is driven by the validated connection facts, so a
 * deployment that learns the real MiMo field names changes config only.
 *
 * Three harness rules are honoured unconditionally, because they are
 * invariants of the harness rather than choices of this adapter:
 *
 * 1. **Files never reach a provider.** Every durable `file` block — at any
 *    nesting depth — becomes the harness's own deterministic handle text
 *    (`fileHandleText`), never bytes.
 * 2. **Text-only routes receive stable placeholders.** An `image`, `audio`, or
 *    `video` block reaching a model that does not declare the modality becomes
 *    deterministic placeholder text, so durable history is preserved without
 *    sending an unsupported part.
 * 3. **A dropped occurrence is named.** Nothing is silently omitted: an
 *    over-budget or disabled occurrence leaves a placeholder that names the
 *    attachment and its read-only path.
 *
 * @module dsh-mimo-adapter/messages
 */

import { fileHandleText } from '@deepseek-ai/dsh-llm';
import { CODES } from './errors.js';
import {
    isHardRuleViolation,
    isOffloaded,
    mediaHandleText,
    mediaRule,
    omittedMediaText,
    omissionReason,
    readAttachmentBytes,
    toBase64,
} from './media.js';

/** Media kinds and the block `type` tag that carries each. */
const MEDIA_BLOCKS = [
    { type: 'audio', kind: 'audio' },
    { type: 'video', kind: 'video' },
];

/**
 * Build one request's wire messages.
 *
 * @param options - the assembled harness request.
 * @param connection - validated connection facts.
 * @param env - `{ attachments, imageAccess, mediaAccess, logger, ttlMs }`.
 * @returns the wire message list.
 */
export async function buildWireMessages(options, connection, env) {
    const state = {
        sent: { audio: 0, video: 0 },
        budget: connection.maxRequestMediaBytes,
        cache: new Map(),
    };
    const wire = [];
    if (options.system !== undefined) {
        wire.push({ role: 'system', content: options.system });
    }
    for (const message of options.messages) {
        wire.push(...(await convertMessage(message, connection, env, state)));
    }
    return wire;
}

async function convertMessage(message, connection, env, state) {
    if (message.role === 'system') {
        return [{ role: 'system', content: textOnly(message.content) }];
    }
    if (message.role === 'assistant') {
        return [serializeAssistant(message)];
    }

    const wire = [];
    const regular = message.content.filter((block) => block.type !== 'tool-result');
    const toolResults = message.content.filter((block) => block.type === 'tool-result');

    const content = await contentParts(regular, connection, env, state);
    if (content.length > 0 || toolResults.length === 0) {
        wire.push({ role: 'user', content });
    }
    for (const result of toolResults) {
        const parts = await contentParts(result.content, connection, env, state);
        const text = parts.filter((part) => part.type === 'text').map((part) => part.text).join('');
        const nonText = parts.filter((part) => part.type !== 'text');
        wire.push({
            role: 'tool',
            tool_call_id: result.toolCallId,
            content: text || '(no output)',
        });
        if (nonText.length > 0) {
            // Chat Completions has no tool-role media slot, so retained media
            // that arrived inside a tool result is delivered as a following
            // user message — the same accommodation the shipped DeepSeek
            // adapter makes for tool-result images.
            wire.push({ role: 'user', content: nonText });
        }
    }
    return wire;
}

function textOnly(content) {
    const parts = [];
    for (const block of content) {
        if (block.type === 'text') parts.push(block.text);
        else if (block.type === 'reasoning') continue;
        else parts.push(`[${block.type} content]`);
    }
    return parts.join('\n');
}

/**
 * One assistant turn on the wire.
 *
 * `reasoning_content` is replayed whenever the turn carries tool calls, as the
 * MiMo deep-thinking doc requires: "回传的 assistant 如果包含了工具调用，**必须
 * 完整回传 `reasoning_content` 字段，否则 API 将返回 400 错误**". Dropping the
 * harness `reasoning` block therefore breaks every agent loop on this route.
 * A plain Q&A turn drops it, because the requirement is scoped to tool-call
 * turns and replaying it would pay thinking tokens twice.
 */
function serializeAssistant(message) {
    const content = [];
    const reasoning = [];
    const toolCalls = [];
    for (const block of message.content) {
        if (block.type === 'text') {
            content.push(block.text);
        } else if (block.type === 'reasoning') {
            reasoning.push(block.text);
        } else if (block.type === 'tool-call') {
            toolCalls.push({
                id: block.id,
                type: 'function',
                function: { name: block.name, arguments: normalizeArguments(block.arguments) },
            });
        }
    }
    const out = { role: 'assistant', content: content.join('') };
    if (toolCalls.length > 0) {
        out.tool_calls = toolCalls;
        const text = reasoning.join('').trim();
        if (text.length > 0) out.reasoning_content = text;
    }
    return out;
}

/**
 * Tool arguments stay raw JSON strings on the wire, as the harness requires
 * ("工具参数保持原始 JSON 字符串"), but a historical value that is not an object
 * is normalized to `{}` so the provider does not reject the whole request.
 */
function normalizeArguments(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return '{}';
    try {
        const parsed = JSON.parse(raw);
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? JSON.stringify(parsed) : '{}';
    } catch {
        return '{}';
    }
}

async function contentParts(content, connection, env, state) {
    const parts = [];
    for (const block of content) {
        switch (block.type) {
            case 'text':
                parts.push({ type: 'text', text: block.text });
                break;
            case 'reasoning':
                break;
            case 'file':
                parts.push({ type: 'text', text: fileHandleText(block.attachment, resolveFileReadPath(env, block.attachment)) });
                break;
            case 'image':
                parts.push(await imagePart(block, connection, env));
                break;
            case 'audio':
            case 'video':
                parts.push(...(await mediaParts(block, connection, env, state)));
                break;
            case 'tool-call':
            case 'tool-result':
                // Handled by the caller, which splits tool results out first.
                break;
            default:
                parts.push(await unknownPart(block, env));
                break;
        }
    }
    return parts;
}

async function unknownPart(block, env) {
    const reported = await env.onUnknownBlock?.(block);
    if (typeof reported === 'string' && reported.length > 0) {
        return { type: 'text', text: reported };
    }
    const error = new Error(
        `dsh-mimo-adapter: content block type "${block?.type}" is unknown to this adapter and no llm/stream listener degraded it; refusing to send an unrecorded projection`,
    );
    error.code = CODES.UNSUPPORTED_MODALITY;
    throw error;
}

function resolveFileReadPath(env, ref) {
    try {
        const hostPath = env.attachments?.fileHostPath?.(ref);
        if (hostPath === undefined) return undefined;
        return env.imageAccess?.(hostPath) ?? hostPath;
    } catch {
        return undefined;
    }
}

/** One image: declared-but-unsupported becomes placeholder text, otherwise an `image_url` part. */
async function imagePart(block, connection, env) {
    const ref = block.attachment;
    if (isOffloaded(block)) {
        return { type: 'text', text: omittedMediaText('image', ref, 'a durable omission decision', mediaAccess(env, ref)) };
    }
    if (!env.imageSupported) {
        return { type: 'text', text: omittedMediaText('image', ref, `model "${env.modelId}" does not declare the image modality`, mediaAccess(env, ref)) };
    }
    const version = await env.readImageVersion?.(ref);
    if (version === undefined) {
        return { type: 'text', text: omittedMediaText('image', ref, 'the attachment service could not produce a request version', mediaAccess(env, ref)) };
    }
    return {
        type: 'image_url',
        image_url: { url: `data:${version.mediaType};base64,${toBase64(version.data)}` },
    };
}

/**
 * One audio or video occurrence: handle text plus a content part, or a naming
 * placeholder when the occurrence must not be sent.
 */
async function mediaParts(block, connection, env, state) {
    const descriptor = MEDIA_BLOCKS.find((entry) => entry.type === block.type);
    const ref = block.attachment;
    const access = mediaAccess(env, ref);
    const detail = { mediaType: block.mediaType, durationMs: block.durationMs };

    if (!env.modalities.includes(descriptor.kind)) {
        return [{
            type: 'text',
            text: omittedMediaText(descriptor.kind, ref, `model "${env.modelId}" does not declare the ${descriptor.kind} modality`, access),
        }];
    }
    if (isOffloaded(block)) {
        return [{
            type: 'text',
            text: omittedMediaText(descriptor.kind, ref, 'a durable omission decision', access),
        }];
    }

    const rule = mediaRule(connection, descriptor.kind);
    const reason = omissionReason(descriptor.kind, rule, ref, state.sent[descriptor.kind], state.budget);
    if (reason !== undefined) {
        if (rule.onOversize === 'reject' && isHardRuleViolation(reason)) {
            const error = new Error(
                `dsh-mimo-adapter: ${descriptor.kind} attachment ${ref.attachmentId} (${ref.name}) cannot be sent: ${reason}; onOversize is "reject", so the request fails instead of sending a placeholder`,
            );
            error.code = CODES.MEDIA_TOO_LARGE;
            throw error;
        }
        env.logger?.warn?.(`dsh-mimo-adapter: omitting ${descriptor.kind} ${ref.attachmentId}: ${reason}`);
        return [{ type: 'text', text: omittedMediaText(descriptor.kind, ref, reason, access) }];
    }

    let base64 = state.cache.get(ref.attachmentId);
    if (base64 === undefined) {
        const bytes = await readAttachmentBytes(env.attachments, ref, rule.maxBytes, env.ttlMs, env.signal);
        base64 = toBase64(bytes);
        state.cache.set(ref.attachmentId, base64);
    }

    const part = mediaContentPart(descriptor.kind, rule, ref, block, base64);
    state.sent[descriptor.kind] += 1;
    state.budget -= ref.bytes;
    return [
        { type: 'text', text: mediaHandleText(descriptor.kind, ref, detail, access) },
        part,
    ];
}

/**
 * The provider-facing content part for one media occurrence.
 *
 * Audio (audio-understanding doc):
 * `{ type: 'input_audio', input_audio: { data } }` where `data` is the public
 * URL or a `data:{MIME};base64,{…}` payload. MiMo puts the whole data URI in
 * `data`; it does not split out OpenAI's `format` field.
 *
 * Video (video-understanding doc):
 * `{ type: 'video_url', video_url: { url }, fps, media_resolution }` where
 * `url` is the public URL or a `data:{MIME};base64,{…}` payload, `fps` ranges
 * over `[0.1, 10]` (default 2), and `media_resolution` is `default` or `max`.
 */
function mediaContentPart(kind, rule, ref, block, base64) {
    const mediaType = block.mediaType ?? (kind === 'audio' ? 'audio/wav' : 'video/mp4');
    const dataUri = `data:${mediaType};base64,${base64}`;
    if (kind === 'audio') {
        if (rule.mode === 'audio_url') {
            return {
                type: rule.urlField,
                [rule.urlField]: { url: dataUri },
            };
        }
        return {
            type: 'input_audio',
            input_audio: { [rule.dataField]: dataUri },
        };
    }
    return {
        type: rule.urlField,
        [rule.urlField]: { url: dataUri },
        [rule.fpsField]: rule.fps,
        [rule.resolutionField]: rule.mediaResolution,
    };
}

function mediaAccess(env, ref) {
    try {
        const hostPath = env.attachments?.fileHostPath?.(ref);
        if (hostPath === undefined) return undefined;
        const readonlyPath = env.imageAccess?.(hostPath);
        return readonlyPath === undefined ? undefined : { readonlyPath };
    } catch {
        return undefined;
    }
}
