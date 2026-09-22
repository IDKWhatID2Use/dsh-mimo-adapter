/**
 * Audio / video attachment handling for dsh-mimo-adapter.
 *
 * ## Why bytes are read here instead of reusing the image path
 *
 * `@deepseek-ai/dsh-compaction-image-offload` gives every retained image a
 * durable-text projection whenever the route budget is exceeded. No equivalent
 * exists for audio or video, so this module owns that projection itself and
 * applies it under the same rule the harness uses for images: a route budget
 * that is exceeded produces deterministic text naming the whole attachment,
 * never a silently truncated or silently dropped payload.
 *
 * ## What the provider actually receives
 *
 * 待补充：whether MiMo accepts inline base64 or requires an upload/URL. The
 * default is inline base64, which needs no second endpoint and no external
 * hosting, and the `mode` config switches it. A `file` mode requires an upload
 * endpoint this plugin has not been given, so it fails loudly with
 * `INVALID_CONFIG` rather than pretending to upload.
 *
 * @module dsh-mimo-adapter/media
 */

import { CODES } from './errors.js';

const BASE64_CHUNK = 0x8000;

/** The media kinds this plugin projects. */
export const MEDIA_KINDS = ['audio', 'video'];

/** The deployment rule for one media kind, read straight out of the validated config. */
export function mediaRule(connection, kind) {
    return kind === 'audio' ? connection.audio : connection.video;
}

/** Normalize a declared container to a bare format token (`audio/wav` -> `wav`). */
export function formatToken(mediaType) {
    if (typeof mediaType !== 'string' || mediaType.length === 0) return undefined;
    const slash = mediaType.indexOf('/');
    const bare = slash === -1 ? mediaType : mediaType.slice(slash + 1);
    return bare.toLowerCase().replace(/^x-/, '');
}

/**
 * Deterministic model-visible handle for one retained media occurrence.
 *
 * Shaped exactly like the harness's own attachment handles
 * (`dsh-llm/content`'s `requestImageHandleText` / `offloadedImageText`):
 * occurrence identity, display metadata, and the read-only path a model tool
 * can use to fetch the same bytes. The wording avoids claiming any vendor
 * semantics, because the MiMo prompt-level handling of these handles is
 * 待补充.
 *
 * @param kind - `audio` or `video`.
 * @param ref - the durable file reference.
 * @param detail - optional declared media type and duration.
 * @param access - optional execution-world read path.
 * @returns one line of text that precedes the media content part.
 */
export function mediaHandleText(kind, ref, detail = {}, access) {
    const parts = [
        `[${kind} attachment id=${ref.attachmentId}`,
        `name=${ref.name}`,
        `bytes=${ref.bytes}`,
    ];
    const format = formatToken(detail.mediaType);
    if (format !== undefined) parts.push(`format=${format}`);
    if (detail.durationMs !== undefined) parts.push(`durationMs=${detail.durationMs}`);
    if (access?.readonlyPath !== undefined) parts.push(`readPath=${access.readonlyPath} (read-only)`);
    return `${parts.join(' ')}]`;
}

/**
 * Deterministic placeholder for one media occurrence this request must omit.
 *
 * Same contract as an offloaded image: the durable log keeps the structured
 * reference, the provider sees text that names what was omitted and how to
 * reach it, and the omission is reversible on a later request.
 *
 * @param kind - `audio` or `video`.
 * @param ref - the durable file reference.
 * @param reason - the route-side rule that caused the omission.
 * @param access - optional execution-world read path.
 * @returns one line of placeholder text.
 */
export function omittedMediaText(kind, ref, reason, access) {
    const path = access?.readonlyPath === undefined ? 'the stored attachment' : access.readonlyPath;
    return `[${kind} attachment id=${ref.attachmentId} name=${ref.name} bytes=${ref.bytes} was NOT sent: ${reason}; the exact bytes remain stored read-only at ${path}]`;
}

/** True when a block carries an explicit omission mark. */
export function isOffloaded(block) {
    return block.offloaded === true;
}

/**
 * The route-side rule a given occurrence violates, or undefined when it fits.
 *
 * @param kind - `audio` or `video`.
 * @param rule - the resolved media rule for this kind.
 * @param ref - the durable file reference.
 * @param seenCount - how many occurrences of this kind were retained before this one.
 * @param budgetBytes - remaining request-wide media byte budget.
 * @returns a human-readable reason, or undefined when the occurrence may be sent.
 */
export function omissionReason(kind, rule, ref, seenCount, budgetBytes) {
    if (!rule.enabled) return `this deployment has the ${kind} modality disabled`;
    if (seenCount >= rule.maxPerRequest) {
        return `the request already carries ${rule.maxPerRequest} ${kind} occurrence(s), the configured maxPerRequest`;
    }
    if (ref.bytes > rule.maxBytes) {
        return `the attachment is ${ref.bytes} bytes and exceeds the configured maxBytes ${rule.maxBytes}`;
    }
    if (ref.bytes > budgetBytes) {
        return `sending it would exceed the request-wide maxRequestMediaBytes budget (${budgetBytes} bytes left)`;
    }
    return undefined;
}

/**
 * Whether one omission reason is a hard route bound (a configured limit) rather
 * than a policy choice.
 *
 * The distinction drives `onOversize: reject`: a deployment that asked for a
 * hard failure wants it exactly when a configured bound was broken, not when an
 * operator deliberately disabled a modality.
 *
 * @param reason - the reason {@link omissionReason} returned.
 * @returns whether the reason names a configured bound.
 */
export function isHardRuleViolation(reason) {
    return typeof reason === 'string' && (reason.includes('maxBytes') || reason.includes('maxPerRequest') || reason.includes('maxRequestMediaBytes'));
}

/**
 * Read one durable file reference as exact bytes, bounded and cancellable.
 *
 * `AttachmentStore.readFileStream` is the only interface guaranteed to work for
 * every attachment backend, so this never depends on a host path being
 * available. The cap is enforced while streaming, so an oversized attachment is
 * refused without ever being fully buffered.
 *
 * @param attachments - the mounted `ctx.attachments` service.
 * @param ref - the durable file reference.
 * @param maxBytes - hard byte cap for this read.
 * @param timeoutMs - deadline for the whole read.
 * @param signal - caller cancellation.
 * @returns the exact bytes.
 * @throws Error with `MEDIA_TOO_LARGE`, `TIMEOUT`, or `ABORTED`.
 */
export async function readAttachmentBytes(attachments, ref, maxBytes, timeoutMs, signal) {
    if (attachments === undefined) {
        throw configError('the harness attachment service is not mounted, so media bytes cannot be read; mount @deepseek-ai/dsh-attachment-local');
    }
    if (typeof attachments.readFileStream !== 'function') {
        throw configError(`the attached @deepseek-ai/dsh-attachment provider does not implement readFileStream; cannot read ${ref.attachmentId}`);
    }

    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);

    const chunks = [];
    let total = 0;
    try {
        for await (const chunk of attachments.readFileStream(ref, combined)) {
            const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
            total += bytes.byteLength;
            if (total > maxBytes) {
                throw mediaTooLarge(ref, total, maxBytes);
            }
            chunks.push(bytes);
        }
    } catch (error) {
        if (error?.code === CODES.MEDIA_TOO_LARGE) throw error;
        if (isAbort(error)) {
            if (signal?.aborted === true) throw abortedError();
            const timedOut = new Error(`dsh-mimo-adapter: reading attachment ${ref.attachmentId} exceeded ${timeoutMs}ms`);
            timedOut.code = CODES.TIMEOUT;
            throw timedOut;
        }
        throw error;
    }

    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

/** Encode bytes as canonical base64 without building an intermediate binary string. */
export function toBase64(bytes) {
    let binary = '';
    for (let index = 0; index < bytes.byteLength; index += BASE64_CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(index, index + BASE64_CHUNK));
    }
    return btoa(binary);
}

function isAbort(error) {
    return error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.code === 'ABORT_ERR';
}

function mediaTooLarge(ref, actual, limit) {
    const error = new Error(
        `dsh-mimo-adapter: attachment ${ref.attachmentId} (${ref.name}) exceeds the configured media limit: read ${actual} bytes against a ${limit} byte cap`,
    );
    error.code = CODES.MEDIA_TOO_LARGE;
    return error;
}

function configError(message) {
    const error = new Error(`dsh-mimo-adapter: ${message}`);
    error.code = CODES.INVALID_CONFIG;
    return error;
}

function abortedError() {
    const error = new Error('dsh-mimo-adapter: the request was cancelled while reading media bytes');
    error.code = CODES.ABORTED;
    return error;
}
