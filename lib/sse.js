/**
 * Server-Sent Events reader for dsh-mimo-adapter.
 *
 * The transport is SSE over `POST /chat/completions` with `stream: true`, the
 * documented MiMo shape. The parser is incremental and byte-exact: it splits on
 * the SSE frame separator and never buffers the whole response.
 *
 * It also owns the **idle deadline**. A provider that answers `200` and then
 * stops sending bytes (half-open gateway, silently dropped connection) would
 * otherwise block the agent step forever; the deadline is enforced around the
 * wait for the next chunk, so it measures quiet time rather than total time.
 *
 * @module dsh-mimo-adapter/sse
 */

/**
 * Wrap one iterator step with an idle deadline.
 *
 * @param step - the pending read.
 * @param idleTimeoutMs - maximum quiet period.
 * @returns the read result.
 * @throws Error with code `TIMEOUT` when no chunk arrives within the deadline.
 */
function withDeadline(step, idleTimeoutMs) {
    if (idleTimeoutMs === undefined) return step;
    return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => {
            const error = new Error(`the provider sent no data for ${idleTimeoutMs}ms`);
            error.code = 'TIMEOUT';
            reject(error);
        }, idleTimeoutMs);
        timer.unref?.();
        step.then(
            (value) => {
                clearTimeout(timer);
                resolvePromise(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

/**
 * Read one SSE byte stream and yield the payload of every `data:` line.
 *
 * @param body - the response body (`ReadableStream<Uint8Array>`).
 * @param signal - caller cancellation, honoured between chunks.
 * @param idleTimeoutMs - quiet-time deadline for one chunk; omitted disables it.
 * @returns one raw data payload per SSE frame, `[DONE]` included.
 */
export async function* readSseData(body, signal, idleTimeoutMs) {
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    const reader = body.getReader();
    try {
        for (;;) {
            if (signal?.aborted === true) {
                const error = new Error('the stream was cancelled');
                error.name = 'AbortError';
                throw error;
            }
            const { value, done } = await withDeadline(reader.read(), idleTimeoutMs);
            if (done === true) break;
            buffer += decoder.decode(value, { stream: true });
            for (;;) {
                const boundary = findFrameBoundary(buffer);
                if (boundary === undefined) break;
                const frame = buffer.slice(0, boundary.index);
                buffer = buffer.slice(boundary.index + boundary.length);
                const payload = framePayload(frame);
                if (payload !== undefined) yield payload;
            }
        }
        buffer += decoder.decode();
        const payload = framePayload(buffer);
        if (payload !== undefined) yield payload;
    } finally {
        reader.releaseLock?.();
    }
}

/** Locate the next SSE frame separator, tolerating CRLF, LF, and CR. */
function findFrameBoundary(buffer) {
    const lf = indexOfBareLfPair(buffer);
    const crlf = buffer.indexOf('\r\n\r\n');
    const cr = buffer.indexOf('\r\r');
    const candidates = [
        lf === -1 ? undefined : { index: lf, length: 2 },
        crlf === -1 ? undefined : { index: crlf, length: 4 },
        cr === -1 ? undefined : { index: cr, length: 2 },
    ].filter(Boolean).sort((left, right) => left.index - right.index);
    return candidates[0];
}

/**
 * Find an `\n\n` that is not part of a `\r\n\r\n` separator.
 *
 * A naive `indexOf('\n\n')` can match the tail of a CRLF pair (`…\r\n\r\n`
 * contains `\n\r`, not `\n\n`, but a chunk boundary can deliver `\r\n` then
 * `\n`, producing a false `\n\n` inside one separator). Checking the byte
 * before the first newline keeps the frame split exact.
 */
function indexOfBareLfPair(buffer) {
    let from = 0;
    for (;;) {
        const index = buffer.indexOf('\n\n', from);
        if (index === -1) return -1;
        if (index === 0 || buffer[index - 1] !== '\r') return index;
        from = index + 1;
    }
}

/** Concatenate every `data:` line of one frame, per the SSE specification. */
function framePayload(frame) {
    const lines = frame.split(/\r\n|\n|\r/);
    const parts = [];
    for (const line of lines) {
        if (line.startsWith(':') || line.length === 0) continue;
        if (!line.startsWith('data:')) continue;
        const value = line.slice(5);
        parts.push(value.startsWith(' ') ? value.slice(1) : value);
    }
    if (parts.length === 0) return undefined;
    return parts.join('\n');
}

/**
 * Parse one SSE payload into a JSON object.
 * @param payload - raw payload, possibly the `[DONE]` sentinel.
 * @returns the parsed object, or `undefined` for the sentinel.
 * @throws Error with `MALFORMED_RESPONSE` for a non-JSON payload.
 */
export function parsePayload(payload) {
    const text = payload.trim();
    if (text === '[DONE]') return undefined;
    try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object') {
            throw new TypeError('payload is not a JSON object');
        }
        return parsed;
    } catch (cause) {
        const error = new Error(`dsh-mimo-adapter: provider sent a stream frame that is not JSON: ${text.slice(0, 200)}`);
        error.code = 'MALFORMED_RESPONSE';
        error.cause = cause;
        throw error;
    }
}
