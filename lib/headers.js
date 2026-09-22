/**
 * Endpoint and header assembly for dsh-mimo-adapter.
 *
 * The harness requires every provider HTTP request to carry
 * `attributionHeaders()` ("Every provider HTTP request must include
 * `attributionHeaders()`; prove the headers are added in the wire request").
 * That call is made here and nowhere else, so there is exactly one place to
 * audit.
 *
 * @module dsh-mimo-adapter/headers
 */

import { attributionHeaders } from '@deepseek-ai/dsh-llm';

/** Default request path when the deployment has not recorded one. 待补充：official path. */
const DEFAULT_PATH = '/chat/completions';

/**
 * Compose the exact request URL.
 *
 * @param connection - validated connection facts.
 * @returns the absolute request URL.
 */
export function requestUrl(connection) {
    if (connection.baseURL === undefined) {
        const error = new Error(
            'dsh-mimo-adapter: no baseURL is configured. 待补充：MiMo API 基址。Set config.baseURL (or MIMO_BASE_URL) to the official endpoint root.',
        );
        error.code = 'INVALID_CONFIG';
        throw error;
    }
    const base = connection.baseURL.replace(/\/+$/, '');
    const path = connection.path ?? DEFAULT_PATH;
    const url = new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`);
    if (connection.auth.scheme === 'query') {
        if (url.searchParams.has(connection.auth.queryParam)) {
            const error = new Error(`dsh-mimo-adapter: the base URL already carries the "${connection.auth.queryParam}" query parameter`);
            error.code = 'INVALID_CONFIG';
            throw error;
        }
    }
    return url;
}

/**
 * Compose the exact request headers.
 *
 * Attribution headers go in first so a deployment-supplied `headers` map can
 * never accidentally replace the harness identity header with its own value
 * (it can still deliberately override one, which is a deployment's choice to
 * make — the merge is explicit rather than silent).
 *
 * @param connection - validated connection facts.
 * @param apiKey - the resolved credential.
 * @param url - the request URL, so a `query` credential can be appended.
 * @returns the header map.
 */
export function requestHeaders(connection, apiKey, url) {
    const headers = {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...attributionHeaders(),
    };

    if (apiKey !== undefined) {
        if (connection.auth.scheme === 'bearer') {
            headers.authorization = connection.auth.prefix === undefined || connection.auth.prefix === ''
                ? apiKey
                : `${connection.auth.prefix} ${apiKey}`;
        } else if (connection.auth.scheme === 'header') {
            headers[connection.auth.headerName.toLowerCase()] = connection.auth.prefix === undefined
                ? apiKey
                : `${connection.auth.prefix} ${apiKey}`;
        } else {
            url.searchParams.set(connection.auth.queryParam, apiKey);
        }
    }

    for (const [name, value] of Object.entries(connection.headers)) {
        headers[name.toLowerCase()] = value;
    }
    return headers;
}
