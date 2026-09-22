/**
 * Provider failure normalization for dsh-mimo-adapter.
 *
 * The harness routes on stable `LlmError.code` values and never parses message
 * text (`@deepseek-ai/dsh-llm` README: "消费方依据 code 路由，绝不解析消息文本").
 * This module is the only place that turns an HTTP status or a transport fault
 * into one of those codes, and it always strips credential material.
 *
 * @module dsh-mimo-adapter/errors
 */

/** Stable harness codes this adapter emits, with the condition each answers. */
export const CODES = {
    MISSING_CREDENTIAL: 'MISSING_CREDENTIAL',
    INVALID_CREDENTIAL: 'INVALID_CREDENTIAL',
    AUTH: 'AUTH',
    QUOTA: 'QUOTA',
    RATE_LIMIT: 'RATE_LIMIT',
    CONTEXT_WINDOW_EXCEEDED: 'CONTEXT_WINDOW_EXCEEDED',
    INVALID_REQUEST: 'INVALID_REQUEST',
    UNSUPPORTED_MODALITY: 'UNSUPPORTED_MODALITY',
    MEDIA_TOO_LARGE: 'MEDIA_TOO_LARGE',
    UNSUPPORTED_REASONING_EFFORT: 'UNSUPPORTED_REASONING_EFFORT',
    UNSUPPORTED_OPTION: 'UNSUPPORTED_OPTION',
    TRANSPORT: 'TRANSPORT',
    TIMEOUT: 'TIMEOUT',
    ABORTED: 'ABORTED',
    STREAM_CLOSED: 'STREAM_CLOSED',
    MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
    EMPTY_RESPONSE: 'EMPTY_RESPONSE',
    INVALID_CONFIG: 'INVALID_CONFIG',
};

/**
 * One bounded, credential-free excerpt of a provider error body.
 *
 * The body of a 4xx from a gateway is the single most useful diagnostic and is
 * the only place a MiMo-specific error spelling will ever appear, so it is
 * quoted rather than dropped. It is truncated hard and the credential is
 * redacted, because the body can echo request headers back.
 *
 * @param body - raw response text.
 * @param secret - the resolved credential, redacted when it appears.
 * @returns a one-line excerpt, or undefined when the body is empty.
 */
export function summarizeBody(body, secret) {
    if (typeof body !== 'string') return undefined;
    let text = body.trim();
    if (text.length === 0) return undefined;
    if (typeof secret === 'string' && secret.length > 0) {
        text = text.split(secret).join('[redacted]');
    }
    text = text.replace(/\s+/g, ' ');
    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

/**
 * Map one HTTP status to a harness failure code.
 *
 * A status this adapter has no specific meaning for falls through to
 * `HTTP_<status>`, which is more useful than folding it into a code that means
 * something else: a 404 is almost always a wrong `path`/`baseURL`, and calling
 * it `INVALID_REQUEST` sends the operator to look at their request body.
 *
 * @param status - the observed response status.
 * @param body - provider error text, used only to separate context overflow.
 * @returns a stable harness code.
 */
export function codeForStatus(status, body) {
    if (status === 401 || status === 403) return CODES.AUTH;
    if (status === 402) return CODES.QUOTA;
    if (status === 429) return CODES.RATE_LIMIT;
    if (status === 413) return CODES.MEDIA_TOO_LARGE;
    if (status === 400 || status === 422) {
        const text = typeof body === 'string' ? body.toLowerCase() : '';
        if (text.includes('context') && (text.includes('length') || text.includes('window') || text.includes('exceed'))) {
            return CODES.CONTEXT_WINDOW_EXCEEDED;
        }
        return CODES.INVALID_REQUEST;
    }
    return `HTTP_${status}`;
}

/** True when a thrown value looks like a caller cancellation. */
export function isAbortError(error) {
    if (error === undefined || error === null) return false;
    const name = typeof error === 'object' ? error.name : undefined;
    if (name === 'AbortError') return true;
    const code = typeof error === 'object' ? error.code : undefined;
    return code === 'ABORT_ERR';
}

/** True when a thrown value looks like a transport fault rather than a provider answer. */
export function isTransportError(error) {
    const code = typeof error === 'object' && error !== null ? error.code : undefined;
    if (code === undefined) return false;
    return ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
}
