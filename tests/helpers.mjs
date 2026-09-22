/**
 * Shared fixtures for the dsh-mimo-adapter test suite.
 *
 * These exercise the plugin through its real public boundary: the real
 * `@deepseek-ai/dsh-llm` adapter base class and its real helpers, a stub
 * Cordis-shaped context, a stub attachment service, and a stub `fetch` that
 * speaks SSE. Nothing here re-implements plugin logic.
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');

/**
 * The anchors a profile resolves harness packages from, in order: this
 * checkout's own `node_modules`, an explicit override, then the globally
 * installed `@deepseek-ai/dsh` whose nested `node_modules` carries every
 * harness package.
 *
 * A real profile resolves these through its own `node_modules`. A test run
 * outside a profile gets that for free once the harness packages are linked
 * into this package's own `node_modules` — the supported way to make bare
 * specifiers resolve, not a loader hook (a synchronous resolve hook deadlocks
 * the `node --test` child processes).
 */
const ANCHORS = [
    packageRoot,
    process.env.MIMO_HARNESS_ANCHOR,
    process.env.DSH_CHECKOUT,
    process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
    'F:\\NodeJS\\node_global\\node_modules\\@deepseek-ai\\dsh',
].filter((entry) => typeof entry === 'string' && entry.length > 0);

/** Locate the `@deepseek-ai` directory inside a harness install. */
function scopedRootOf(anchor) {
    const nested = join(anchor, 'node_modules', '@deepseek-ai');
    if (existsSync(join(nested, 'dsh-llm'))) return nested;
    const flat = join(anchor, '..', '@deepseek-ai');
    if (existsSync(join(flat, 'dsh-llm'))) return flat;
    return undefined;
}

const linkSource = ANCHORS.map(scopedRootOf).find((entry) => entry !== undefined);
const linkedRoot = join(packageRoot, 'node_modules', '@deepseek-ai');

/**
 * Make one harness package resolvable from this package.
 *
 * @param specifier - the bare `@deepseek-ai/...` specifier.
 * @returns whether the package is resolvable afterwards.
 */
export function harnessLink(specifier) {
    if (linkSource === undefined) return false;
    const bare = specifier.slice('@deepseek-ai/'.length);
    const source = join(linkSource, bare);
    if (!existsSync(source)) return false;
    const destination = join(linkedRoot, bare);
    if (existsSync(destination)) return true;
    try {
        mkdirSync(linkedRoot, { recursive: true });
        rmSync(destination, { recursive: true, force: true });
        symlinkSync(source, destination, 'junction');
        return true;
    } catch (error) {
        console.warn(`dsh-mimo-adapter tests: could not link ${specifier}: ${error?.message ?? error}`);
        return false;
    }
}

/**
 * Resolve a harness package through the same anchors a profile would use, and
 * return a `file://` URL the ESM loader accepts.
 *
 * @param specifier - the bare package specifier.
 * @returns the resolved module URL.
 */
export function harnessResolve(specifier) {
    const failures = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
        for (const anchor of ANCHORS) {
            try {
                return pathToFileURL(createRequire(join(anchor, 'noop.js')).resolve(specifier)).href;
            } catch (error) {
                failures.push(`${anchor}: ${error.code ?? error.message}`);
            }
        }
        if (attempt === 0 && harnessLink(specifier)) continue;
        break;
    }
    throw new Error(
        `cannot resolve "${specifier}"; run \`node tests/bootstrap.mjs\` to link the harness packages into this package's node_modules.\nAnchors tried:\n  ${failures.join('\n  ')}`,
    );
}

export const harnessLlm = await import(harnessResolve('@deepseek-ai/dsh-llm'));

const configModule = await import('../lib/config.js');
const adapterModule = await import('../lib/adapter.js');

export const Config = configModule.Config;
export const resolveConfig = configModule.resolveConfig;
export const MiMoAdapter = adapterModule.MiMoAdapter;

/**
 * Endpoint the stock fixtures talk to. Every unit test uses a stub `fetch`, so
 * this host is never contacted; the official default is asserted separately in
 * the config tests.
 */
export const STUB_BASE_URL = 'https://mimo.test/v1';

/**
 * A model catalog that declares every modality, so modality behaviour can be
 * exercised without depending on the official catalog's own declarations.
 */
export const ALL_MODALITY_MODELS = [
    {
        id: 'mimo-vl',
        name: 'MiMo VL fixture',
        contextWindow: 262144,
        maxTokens: 32768,
        inputModalities: ['text', 'image', 'audio', 'video'],
    },
    {
        id: 'mimo-audio',
        name: 'MiMo audio fixture',
        contextWindow: 131072,
        maxTokens: 16384,
        inputModalities: ['text', 'audio'],
    },
    {
        id: 'mimo-video',
        name: 'MiMo video fixture',
        contextWindow: 131072,
        maxTokens: 16384,
        inputModalities: ['text', 'video'],
    },
];

/** The default raw config every fixture starts from. */
export function fixtureConfig(overrides = {}) {
    return {
        baseURL: STUB_BASE_URL,
        apiKeyEnv: 'MIMO_API_KEY',
        models: ALL_MODALITY_MODELS,
        ...overrides,
    };
}

/** A Cordis-shaped context with only the surfaces this plugin touches. */
export function makeContext(services = {}) {
    const listeners = new Map();
    const warnings = [];
    const errors = [];
    const ctx = {
        logger: {
            warn: (message) => warnings.push(String(message)),
            error: (message) => errors.push(String(message)),
            info: () => {},
        },
        warnings,
        errors,
        on(event, listener) {
            const list = listeners.get(event) ?? [];
            list.push(listener);
            listeners.set(event, list);
            return () => {
                const current = listeners.get(event) ?? [];
                listeners.set(event, current.filter((entry) => entry !== listener));
            };
        },
        listeners,
        get(service) {
            return services[service];
        },
    };
    // Cordis exposes a resolved service both as `ctx.get(name)` and as a named
    // property; the plugin uses both spellings, so the stub does too.
    for (const [service, value] of Object.entries(services)) {
        Object.defineProperty(ctx, service, { value, enumerable: true, configurable: true });
    }
    return ctx;
}

/** The `llm` service surface `apply()` registers into. */
export function makeLlmRegistry() {
    const adapters = new Map();
    const directory = [];
    return {
        adapters,
        directory,
        registerAdapter(providers, adapter) {
            for (const provider of providers) {
                if (adapters.has(provider)) throw new Error(`DUPLICATE_ADAPTER: ${provider}`);
                adapters.set(provider, adapter);
            }
            const handle = () => {
                for (const provider of providers) adapters.delete(provider);
            };
            handle.replace = (next) => {
                for (const provider of providers) adapters.delete(provider);
                for (const nextProvider of next) adapters.set(nextProvider, adapter);
            };
            return handle;
        },
        registerConfigurableProviders(entries) {
            directory.push(...entries);
            return Object.assign(() => {
                for (const entry of entries) {
                    const index = directory.indexOf(entry);
                    if (index >= 0) directory.splice(index, 1);
                }
            }, { replace: () => {} });
        },
    };
}

/**
 * A stub attachment service backed by an in-memory file table.
 * @param files - `{ [attachmentId]: { name, bytes: Uint8Array, mediaType? } }`
 */
export function makeAttachments(files) {
    return {
        files,
        reads: 0,
        fileHostPath(ref) {
            const entry = files[ref.attachmentId];
            return entry === undefined ? undefined : `HOST\\${entry.name}`;
        },
        async *readFileStream(ref) {
            this.reads += 1;
            const entry = files[ref.attachmentId];
            if (entry === undefined) throw new Error(`no such attachment: ${ref.attachmentId}`);
            const data = entry.bytes;
            const step = 7; // deliberately awkward chunking
            for (let offset = 0; offset < data.byteLength; offset += step) {
                yield data.subarray(offset, Math.min(offset + step, data.byteLength));
            }
            if (data.byteLength === 0) yield new Uint8Array(0);
        },
        async readImageRequest(ref, target) {
            const entry = files[ref.attachmentId];
            if (entry === undefined) throw new Error(`no such attachment: ${ref.attachmentId}`);
            return {
                variantId: `variant-${ref.attachmentId}`,
                attachment: ref,
                data: entry.bytes,
                mediaType: entry.mediaType ?? 'image/png',
                bytes: entry.bytes.byteLength,
                width: target.width,
                height: target.height,
                depth: 'uchar',
                space: 'srgb',
                hasAlpha: false,
            };
        },
    };
}

/** Build a `FileAttachmentRef`-shaped value for a stub attachment. */
export function fileRef(attachmentId, name, bytes) {
    return { attachmentId, name, bytes };
}

/** Build an `ImageAttachmentRef`-shaped value. */
export function imageRef(attachmentId, name, bytes) {
    return { attachmentId, name: name ?? 'image.png', bytes, mediaType: 'image/png', width: 4, height: 4 };
}

/** A `fetch` stub that answers with one scripted SSE body. */
export function sseFetch(frames, { status = 200, statusText = 'OK', capture, headers } = {}) {
    return async (url, init) => {
        capture?.({ url, init });
        const payload = frames.map((frame) => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\r\n\r\n`).join('');
        const bytes = new TextEncoder().encode(payload);
        const body = new ReadableStream({
            start(controller) {
                for (let offset = 0; offset < bytes.byteLength; offset += 13) {
                    controller.enqueue(bytes.subarray(offset, Math.min(offset + 13, bytes.byteLength)));
                }
                controller.close();
            },
        });
        return new Response(body, { status, statusText, headers: { 'content-type': 'text/event-stream', ...(headers ?? {}) } });
    };
}

/** A `fetch` stub that answers with a non-2xx JSON error. */
export function errorFetch(status, statusText, body, headers) {
    return async () => new Response(body, { status, statusText, headers: { 'content-type': 'application/json', ...(headers ?? {}) } });
}

/**
 * Create an adapter over one config.
 * @param config - raw plugin config.
 * @param env - `{ attachments, files, fetchImpl, apiKey }`.
 */
export function makeAdapter(config = {}, env = {}) {
    const raw = fixtureConfig(config);
    const connection = resolveConfig(raw);
    const attachments = env.attachments ?? makeAttachments(env.files ?? {});
    const adapter = new MiMoAdapter({
        options: () => connection,
        resolveApiKey: async () => ('apiKey' in env ? env.apiKey : 'test-key'),
        resolveAttachments: () => attachments,
        imageAccess: (hostPath) => `WORLD/${hostPath}`,
        logger: { warn: () => {}, error: () => {}, info: () => {} },
        fetchImpl: env.fetchImpl === undefined ? sseFetch(['[DONE]']) : env.fetchImpl,
    });
    return { adapter, connection, attachments };
}

/** Collect an async chunk stream into an array. */
export async function collect(iterable) {
    const chunks = [];
    for await (const chunk of iterable) chunks.push(chunk);
    return chunks;
}

/** A minimal harness user message. */
export function userMessage(content) {
    return { id: 'msg-1', role: 'user', content, source: { kind: 'user' } };
}
