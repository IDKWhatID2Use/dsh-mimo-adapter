/**
 * The MiMo adapter itself.
 *
 * ## Placement in the harness
 *
 * `LlmAdapter` is the one supported extension seam for a new provider route
 * ("`LlmAdapter` 是提供方后端的抽象基类"; register with
 * `ctx.llm.registerAdapter(providers, adapter)`). It is also the only seam that
 * can serve audio and video input, because request serialization — the step
 * that turns content blocks into provider wire parts — is owned by the adapter
 * and is not interceptable from outside.
 *
 * An `llm/stream` waterfall listener can rewrite a request, but the harness
 * documents that a loop-built request "arrives deep-frozen (mutation throws)"
 * and is "a pure function of the session log", so a listener may only replace
 * the whole options object — which cannot change what a foreign adapter then
 * does with an audio block it does not understand. Owning the route is the only
 * design in which audio and video actually reach the model.
 *
 * ## Generation binding
 *
 * `prepareCall()` is overridden so the model capabilities and the endpoint are
 * captured from the same configuration generation; a settings change between
 * preparation and dispatch therefore cannot pair one generation's modalities
 * with another generation's endpoint.
 *
 * @module dsh-mimo-adapter/adapter
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import { CODES, codeForStatus, isAbortError, isTransportError, summarizeBody } from './errors.js';
import { requestHeaders, requestUrl } from './headers.js';
import { buildWireMessages } from './messages.js';
import { parsePayload, readSseData } from './sse.js';
import { applyEffort, modelReasoningInfo, resolveEffort } from './thinking.js';

/** Reasoning text field names seen on OpenAI-compatible reasoning gateways, in priority order. */
const REASONING_FIELDS = ['reasoning_content', 'reasoning', 'thinking'];

/** Streaming configuration of one adapter instance. */
export class MiMoAdapter extends LlmAdapter {
    /**
     * @param options - `{ options, resolveApiKey, resolveAttachments, imageAccess, onUnknownBlock, logger, fetchImpl }`.
     */
    constructor(options) {
        super();
        this.options = options.options;
        this.resolveApiKey = options.resolveApiKey;
        this.resolveAttachments = options.resolveAttachments;
        this.imageAccess = options.imageAccess;
        this.onUnknownBlock = options.onUnknownBlock;
        this.logger = options.logger;
        this.fetch = typeof options.fetchImpl === 'function'
            ? options.fetchImpl
            : (...args) => globalThis.fetch(...args);
    }

    /** @inheritdoc */
    providerInfo(provider) {
        return { id: provider, name: this.options().displayName };
    }

    /** @inheritdoc */
    providerRetryPolicy() {
        return this.options().retryPolicy;
    }

    /** @inheritdoc */
    async listModels(provider) {
        return this.options().models.map((model) => ({
            provider,
            id: model.id,
            name: model.name,
            ...(model.description === undefined ? {} : { description: model.description }),
            inputModalities: [...model.inputModalities],
        }));
    }

    /** @inheritdoc */
    async resolveModel(provider, model) {
        const connection = this.options();
        const entry = findModel(connection, model);
        const reasoning = modelReasoningInfo(entry, connection.reasoning);
        return {
            provider,
            id: model,
            name: entry.name,
            ...(entry.description === undefined ? {} : { description: entry.description }),
            context: { contextWindow: entry.contextWindow },
            inputModalities: [...entry.inputModalities],
            defaultMaxTokens: entry.maxTokens ?? connection.defaultMaxTokens,
            ...(reasoning === undefined ? {} : { reasoning }),
            ...(entry.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: entry.systemPromptUpdate }),
        };
    }

    /** @inheritdoc */
    async prepareCall(provider, model, signal) {
        const generation = this.options();
        return {
            model: await this.resolveModel(provider, model, signal),
            stream: (options) => this.stream(options, generation),
        };
    }

    /** @inheritdoc */
    async *stream(options, generation = this.options()) {
        const connection = generation;
        const model = findModel(connection, options.model);
        const modalities = model.inputModalities;
        const effort = resolveEffort(options, model, connection.reasoning, this.logger);
        // True only when this level actually asks the provider to think, which
        // is what makes MiMo reject a custom temperature.
        const thinkingOn = isThinkingLevel(effort, connection.reasoning);

        const apiKey = await this.resolveApiKey(connection, options.signal);
        const url = requestUrl(connection);
        const headers = requestHeaders(connection, apiKey, url);

        const attachments = this.resolveAttachments();
        const messages = await buildWireMessages(options, connection, {
            attachments,
            imageAccess: this.imageAccess,
            onUnknownBlock: this.onUnknownBlock,
            logger: this.logger,
            signal: options.signal,
            ttlMs: connection.attachTimeoutMs,
            modalities,
            imageSupported: modalities.includes('image'),
            modelId: model.id,
            thinkingOn,
            readImageVersion: (ref) => this.readImageVersion(attachments, ref, options.signal),
        });

        const body = applyEffort({
            model: options.model,
            messages,
            stream: true,
            stream_options: { include_usage: true },
            ...(options.tools === undefined || options.tools.length === 0 ? {} : {
                tools: options.tools.map((tool) => ({
                    type: 'function',
                    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
                })),
            }),
            // MiMo's own samples use `max_completion_tokens`, which caps
            // thinking content and the visible answer together. `max_tokens`
            // is not the documented field for this endpoint.
            max_completion_tokens: options.maxTokens ?? connection.maxTokens,
            // MiMo forces temperature 1.0 / top_p 0.95 while deep thinking is
            // on and documents that custom values are not supported, so a
            // caller's temperature is omitted rather than sent and ignored.
            ...(thinkingOn || options.temperature === undefined ? {} : { temperature: options.temperature }),
            ...(options.stop === undefined ? {} : { stop: options.stop }),
        }, effort);

        yield* this.consume(url, headers, body, options.signal, apiKey, connection);
    }

    /**
     * Deterministic request version of one image, produced by the mounted
     * attachment provider exactly like the shipped DeepSeek route does. Absent
     * provider support degrades to a named placeholder rather than failing the
     * whole request.
     */
    async readImageVersion(attachments, ref, signal) {
        if (attachments === undefined || typeof attachments.readImageRequest !== 'function') return undefined;
        try {
            return await attachments.readImageRequest(ref, { width: ref.width, height: ref.height, maxBytes: 2097152 }, signal);
        } catch (error) {
            this.logger?.warn?.(`dsh-mimo-adapter: could not prepare request version for image ${ref.attachmentId}: ${error?.message ?? error}`);
            return undefined;
        }
    }

    /** Perform the request and translate its SSE stream into harness chunks. */
    async *consume(url, headers, body, signal, apiKey, connection) {
        let response;
        try {
            response = await this.fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal,
            });
        } catch (error) {
            throw toTransportError(error, signal);
        }

        if (!response.ok) {
            let text;
            try {
                text = await response.text();
            } catch {
                text = undefined;
            }
            const excerpt = summarizeBody(text, apiKey);
            const code = codeForStatus(response.status, text);
            const retryAfterMs = retryAfterMsOf(response);
            throw new LlmError(
                `dsh-mimo-adapter: ${url.origin} answered ${response.status} ${response.statusText}${excerpt === undefined ? '' : `: ${excerpt}`}`,
                code,
                { status: response.status, ...(retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs }) },
            );
        }
        if (response.body === null || response.body === undefined) {
            throw new LlmError('dsh-mimo-adapter: the provider returned an empty response body for a streaming request', CODES.STREAM_CLOSED, { status: response.status });
        }

        yield* translateStream(response.body, signal, connection);
    }
}

/**
 * Wrap one chunk stream with an idle deadline.
 *
 * `config.streamIdleTimeoutMs` is the only declared protection against a
 * provider that accepts the request and then stops sending bytes (half-open
 * gateway, silently dropped connection). Without it a step blocks forever.
 * The deadline itself lives in `readSseData`, which measures the quiet time
 * between chunks rather than the total stream duration.
 */

/**
 * Parse a provider-supplied `Retry-After` header into milliseconds.
 *
 * The harness retry executor consumes `LlmFailure.providerRetryAfterMs`
 * (`dsh-llm/lib/types/types.d.ts:32-33`), so a 429 that names a delay should
 * not be retried on a fixed backoff. Both documented forms are honoured: a
 * delta-seconds value and an HTTP date.
 *
 * @param response - the non-2xx response.
 * @returns a positive delay in milliseconds, or undefined when absent or unparsable.
 */
function retryAfterMsOf(response) {
    const raw = response.headers?.get?.('retry-after');
    if (typeof raw !== 'string' || raw.length === 0) return undefined;
    const seconds = Number(raw.trim());
    if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) {
        const delta = at - Date.now();
        if (delta > 0) return delta;
    }
    return undefined;
}

/**
 * Whether one resolved effort asks the provider to think.
 *
 * MiMo documents that a custom `temperature` is unsupported while deep
 * thinking is on (the model forces 1.0), so the adapter must know which level
 * actually enabled thinking rather than merely "is not the empty level".
 *
 * @param effort - the resolved effort declaration.
 * @param reasoning - validated deployment reasoning config.
 * @returns whether this level enables thinking.
 */
function isThinkingLevel(effort, reasoning) {
    const knob = effort?.sends?.[reasoning.thinkingField];
    if (knob !== undefined) {
        if (typeof knob === 'object' && knob !== null) return knob.type !== 'disabled' && knob.enabled !== false;
        return knob !== false && knob !== 'disabled';
    }
    // A deployment that spelled the level with `reasoning_effort` only is
    // treating any non-empty level as a thinking level.
    return Object.keys(effort?.sends ?? {}).length > 0;
}

/** Locate one model entry, falling back to a text-only route for an unlisted id. */
function findModel(connection, id) {    const found = connection.models.find((model) => model.id === id);
    if (found !== undefined) return found;
    // Catalog membership is advisory: an unlisted id is still routed, and the
    // only safe assumption about a model nobody described is that it accepts
    // text. Declaring audio or video for it would be a guess, not a fact.
    return {
        id,
        name: id,
        description: undefined,
        contextWindow: connection.defaultContextWindow,
        maxTokens: undefined,
        inputModalities: ['text'],
        reasoning: undefined,
        systemPromptUpdate: undefined,
    };
}

/** One provider or transport fault, normalized to a `LlmError` with a stable code. */
function toTransportError(error, signal) {
    // A caller cancellation is not retryable; a timeout is. They must not share
    // a code, or the retry executor cannot tell them apart.
    if (error?.code === CODES.TIMEOUT) {
        return new LlmError(`dsh-mimo-adapter: ${error.message}`, CODES.TIMEOUT, { cause: error });
    }
    if (isAbortError(error)) {
        return new LlmError(signal?.aborted === true ? 'dsh-mimo-adapter: the request was cancelled' : 'dsh-mimo-adapter: the request timed out', CODES.ABORTED, { cause: error });
    }
    if (isTransportError(error)) {
        return new LlmError(`dsh-mimo-adapter: transport failure talking to the provider: ${error.message}`, CODES.TRANSPORT, { cause: error });
    }
    return new LlmError(`dsh-mimo-adapter: request failed before a response: ${error?.message ?? String(error)}`, CODES.TRANSPORT, { cause: error });
}

/**
 * Translate one OpenAI-compatible streaming response into harness chunks.
 *
 * Emitted shape follows the harness protocol exactly: interleaved
 * `block-start`/delta/`block-end` per block index, `usage` before the single
 * terminal `finish`, and nothing after it.
 */
async function* translateStream(body, signal, connection) {
    const state = {
        textIndex: undefined,
        reasoningIndex: undefined,
        toolIndexes: new Map(),
        toolCalls: new Map(),
        /** Open blocks in index order; each entry is `{ index, kind }`. */
        open: [],
        nextIndex: 0,
        usage: undefined,
        finish: undefined,
        providerError: undefined,
    };

    for await (const payload of readSseData(body, signal, connection.streamIdleTimeoutMs)) {
        const event = parsePayload(payload);
        if (event === undefined) continue;
        if (typeof event.error === 'object' && event.error !== null) {
            state.providerError = event.error;
            continue;
        }
        const choice = Array.isArray(event.choices) && event.choices.length > 0 ? event.choices[0] : undefined;
        if (choice !== undefined) {
            const delta = choice.delta ?? choice.message ?? {};
            yield* applyTextDelta(state, 'text', typeof delta.content === 'string' ? delta.content : '');
            const reasoning = REASONING_FIELDS
                .map((field) => delta[field])
                .find((value) => typeof value === 'string' && value.length > 0);
            yield* applyTextDelta(state, 'reasoning', reasoning ?? '');
            yield* applyToolDeltas(state, delta.tool_calls, signal);
            if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
                state.finish = choice.finish_reason;
            }
        }
        if (event.usage !== undefined && event.usage !== null) {
            state.usage = normalizeUsage(event.usage);
        }
    }

    if (state.providerError !== undefined) {
        yield {
            type: 'finish',
            reason: {
                kind: 'error',
                failure: {
                    message: `dsh-mimo-adapter: the provider reported an error mid-stream: ${streamErrorMessage(state.providerError)}`,
                    code: state.providerError.code ?? CODES.MALFORMED_RESPONSE,
                },
            },
        };
        return;
    }

    // Emit usage before any terminal outcome: a provider that answered and
    // billed but produced no content block must still be metered, and the
    // protocol requires usage to precede `finish`.
    if (state.usage !== undefined) {
        yield { type: 'usage', usage: state.usage };
    }

    // Close every open block before finish, ascending by block index so the
    // closing order matches the order the blocks were opened in. A block index
    // is a stream position, not a content type, and the harness assembler
    // correlates deltas by it.
    for (const record of state.open) {
        yield { type: 'block-end', index: record.index, block: assembleBlock(record, state) };
    }

    if (state.open.length === 0) {
        yield {
            type: 'finish',
            reason: {
                kind: 'error',
                failure: {
                    message: 'dsh-mimo-adapter: the provider ended the stream without producing any content block',
                    code: CODES.EMPTY_RESPONSE,
                },
            },
        };
        return;
    }

    yield { type: 'finish', reason: finishReason(state.finish) };
}

async function* applyTextDelta(state, kind, text) {
    if (typeof text !== 'string' || text.length === 0) return;
    const indexField = kind === 'text' ? 'textIndex' : 'reasoningIndex';
    if (state[indexField] === undefined) {
        const index = state.nextIndex++;
        state[indexField] = index;
        state[kind === 'text' ? 'text' : 'reasoning'] = [];
        state.open.push({ index, kind });
        yield { type: 'block-start', index, blockType: kind };
    }
    state[kind === 'text' ? 'text' : 'reasoning'].push(text);
    yield kind === 'text'
        ? { type: 'text-delta', index: state[indexField], text }
        : { type: 'reasoning-delta', index: state[indexField], text };
}

/** Assemble one closed block from the deltas accumulated for its index. */
function assembleBlock(record, state) {
    if (record.kind === 'text') return { type: 'text', text: state.text.join('') };
    if (record.kind === 'reasoning') return { type: 'reasoning', text: state.reasoning.join('') };
    const call = state.toolCalls.get(record.index);
    return { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments };
}

async function* applyToolDeltas(state, deltas, signal) {
    if (!Array.isArray(deltas)) return;
    for (const delta of deltas) {
        if (delta === null || typeof delta !== 'object') continue;
        if (signal?.aborted === true) return;
        const providerIndex = Number.isInteger(delta.index) ? delta.index : state.toolIndexes.size;
        let index = state.toolIndexes.get(providerIndex);
        if (index === undefined) {
            index = state.nextIndex++;
            state.toolIndexes.set(providerIndex, index);
            state.toolCalls.set(index, {
                id: typeof delta.id === 'string' && delta.id.length > 0 ? delta.id : `mimo-tool-${providerIndex}`,
                name: delta.function?.name ?? '',
                arguments: '',
            });
            state.open.push({ index, kind: 'tool-call' });
            yield { type: 'block-start', index, blockType: 'tool-call' };
        }
        const entry = state.toolCalls.get(index);
        // MiMo sends the call id only on the first delta of a call and `null`
        // on every later one, so a non-string value must not overwrite the id
        // the harness will replay back to the provider.
        if (typeof delta.id === 'string' && delta.id.length > 0) entry.id = delta.id;
        if (typeof delta.function?.name === 'string' && delta.function.name.length > 0) entry.name = delta.function.name;
        const argumentsDelta = typeof delta.function?.arguments === 'string' ? delta.function.arguments : '';
        if (argumentsDelta.length === 0) continue;
        entry.arguments += argumentsDelta;
        yield { type: 'tool-call-delta', index, id: entry.id, name: entry.name || undefined, argumentsDelta };
    }
}

/** Map a provider finish reason onto the harness vocabulary. */
function finishReason(reason) {
    if (reason === 'tool_calls' || reason === 'function_call') return { kind: 'tool-calls' };
    if (reason === 'length') return { kind: 'max-tokens' };
    if (reason === 'content_filter') return { kind: 'stop' };
    return { kind: 'stop' };
}

/**
 * Normalize provider usage into the harness's disjoint token buckets.
 * The harness contract is explicit: `inputTokens` is uncached input only, so a
 * provider's aggregate prompt count must have cache reads subtracted out.
 */
function normalizeUsage(raw) {
    const input = numberOrZero(raw.prompt_tokens);
    const output = numberOrZero(raw.completion_tokens);
    const cacheRead = cacheReadOf(raw);
    const cacheWrite = cacheWriteOf(raw);
    const details = raw.completion_tokens_details;
    const reasoning = typeof details?.reasoning_tokens === 'number' ? details.reasoning_tokens : undefined;
    const total = typeof raw.total_tokens === 'number' ? raw.total_tokens : input + output;
    return {
        inputTokens: Math.max(0, input - cacheRead - cacheWrite),
        outputTokens: output,
        totalTokens: total,
        ...(cacheRead === 0 ? {} : { cacheReadTokens: cacheRead }),
        ...(cacheWrite === 0 ? {} : { cacheWriteTokens: cacheWrite }),
        ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    };
}

function cacheReadOf(raw) {
    const details = raw.prompt_tokens_details;
    if (typeof details?.cached_tokens === 'number') return details.cached_tokens;
    if (typeof raw.prompt_cache_hit_tokens === 'number') return raw.prompt_cache_hit_tokens;
    if (typeof raw.cache_read_input_tokens === 'number') return raw.cache_read_input_tokens;
    return 0;
}

function cacheWriteOf(raw) {
    if (typeof raw.prompt_cache_miss_tokens === 'number') return 0;
    if (typeof raw.cache_creation_input_tokens === 'number') return raw.cache_creation_input_tokens;
    return 0;
}

function numberOrZero(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function streamErrorMessage(error) {
    if (typeof error.message === 'string' && error.message.length > 0) return error.message;
    if (typeof error.type === 'string') return error.type;
    return JSON.stringify(error);
}
