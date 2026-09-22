/**
 * Optional global degradation for the modality vocabulary this plugin adds.
 *
 * Widening `ContentBlockMap` means an `audio` or `video` block can now appear in
 * a message aimed at *any* route. The shipped DeepSeek and pi-ai adapters
 * switch on `type` and fall through unknown blocks, which for those routes means
 * the block is silently ignored — durable history would then reach the model
 * with a hole in it.
 *
 * The `llm/stream` waterfall closes that hole for every route this plugin does
 * not own, using the same rule the harness applies to a text-only image route:
 * the occurrence becomes deterministic placeholder text naming the whole
 * attachment and its read-only path. Nothing is silently dropped, and a
 * loop-built request is respected as read-only — this listener replaces
 * individual message objects and the `messages` array. It never mutates the
 * frozen request or any message the loop built.
 *
 * The MiMo adapter does not rely on this listener: it serializes audio and
 * video itself and is the only route that actually sends them.
 *
 * @module dsh-mimo-adapter/degrade
 */

import { omittedMediaText } from './media.js';

const MODALITY_BLOCKS = new Set(['audio', 'video']);

/**
 * Replace every audio/video block — at any nesting depth — with deterministic
 * text, in place of a block-type switch no foreign adapter can serve.
 *
 * The walk is recursive because a `tool-result` block nests its own content,
 * and the harness treats nesting depth as a shared invariant: "This is the one
 * recursive image walk shared by every image policy … so a consumer cannot
 * silently diverge on nesting depth" (`dsh-llm/lib/types/content.d.ts:52-59`).
 *
 * @param options - the request observed at the `llm/stream` waterfall.
 * @param context - `{ attachments, imageAccess, logger }`; `attachments` may be a thunk.
 * @returns the original request when there is nothing to degrade, otherwise a request carrying text in place of media.
 */
export function degradeForeignModalities(options, context) {
    if (!Array.isArray(options?.messages)) return options;
    let changed = false;

    const messages = options.messages.map((message) => {
        if (!Array.isArray(message?.content) || !hasModalityBlock(message.content)) return message;
        changed = true;
        return { ...message, content: degradeBlocks(message.content, options.provider, context) };
    });

    return changed ? { ...options, messages } : options;
}

/** True when this block list holds an audio/video block anywhere below it. */
function hasModalityBlock(content) {
    return content.some((block) => {
        if (MODALITY_BLOCKS.has(block?.type)) return true;
        return Array.isArray(block?.content) && hasModalityBlock(block.content);
    });
}

/** Rewrite one block list, recursing into nested tool-result content. */
function degradeBlocks(content, provider, context) {
    return content.map((block) => {
        if (MODALITY_BLOCKS.has(block?.type)) {
            return {
                type: 'text',
                text: omittedMediaText(
                    block.type,
                    block.attachment,
                    `route "${provider}" is not served by this plugin, which is the only adapter that can send that modality`,
                    accessOf(context, block.attachment),
                ),
            };
        }
        if (Array.isArray(block?.content) && hasModalityBlock(block.content)) {
            return { ...block, content: degradeBlocks(block.content, provider, context) };
        }
        return block;
    });
}

/**
 * Degrade the request for one named provider through the optional harness
 * `llm/stream` waterfall.
 *
 * @param ctx - the harness context, used for logging only.
 * @param ownedProvider - the route this plugin's adapter serves.
 * @param context - `{ attachments, imageAccess }`; `attachments` is a thunk so a
 *   service mounted after this plugin is still seen.
 * @returns the waterfall listener.
 */
export function makeModalityDegradeListener(ctx, ownedProvider, context) {
    return async function* degradeListener(options, next) {
        if (options.provider !== ownedProvider) {
            let degraded = options;
            try {
                degraded = degradeForeignModalities(options, context);
            } catch (error) {
                ctx.logger?.warn?.(`dsh-mimo-adapter: could not degrade media blocks for route "${options.provider}": ${error?.message ?? error}`);
            }
            yield* next.call(this, degraded);
            return;
        }
        yield* next.call(this, options);
    };
}

function accessOf(context, ref) {
    try {
        const attachments = typeof context.attachments === 'function' ? context.attachments() : context.attachments;
        const hostPath = attachments?.fileHostPath?.(ref);
        if (hostPath === undefined) return undefined;
        const readonlyPath = context.imageAccess?.(hostPath);
        return readonlyPath === undefined ? undefined : { readonlyPath };
    } catch {
        return undefined;
    }
}
