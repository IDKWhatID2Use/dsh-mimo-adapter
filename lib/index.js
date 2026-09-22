/**
 * dsh-mimo-adapter — Xiaomi MiMo provider route for DeepSeek Harness.
 *
 * Three capabilities, one plugin:
 *
 * 1. **Reasoning-effort control (思考强度)** — every model entry publishes its
 *    selectable levels through `resolveModel().reasoning`, so the harness
 *    validates and materializes the effort *before* any provider I/O
 *    (`UNSUPPORTED_REASONING_EFFORT` on an unoffered level), and the adapter
 *    overlays the level's exact wire spelling onto the request body.
 * 2. **Audio input modality** — an `audio` content block carrying a durable
 *    file attachment is read, bounded, base64-encoded, and sent as the
 *    configured wire part.
 * 3. **Video input modality** — the same path for `video` blocks.
 *
 * The plugin follows the shipped adapter convention: a function plugin whose
 * module exports `name`, `inject`, `Config`, and `apply(ctx, config)`
 * (`@deepseek-ai/dsh-llm-deepseek` is the reference implementation). All
 * registrations are effects on the plugin's own fiber, so unloading the row
 * withdraws the route.
 *
 * @module dsh-mimo-adapter
 */

import { LlmError } from '@deepseek-ai/dsh-llm';
import { Config, resolveConfig } from './config.js';
import { MiMoAdapter } from './adapter.js';
import { makeModalityDegradeListener } from './degrade.js';
import { CODES } from './errors.js';

export { Config, resolveConfig } from './config.js';
export { MiMoAdapter } from './adapter.js';
export { degradeForeignModalities, makeModalityDegradeListener } from './degrade.js';
export { buildWireMessages } from './messages.js';
export { applyEffort, resolveEffort, modelReasoningInfo } from './thinking.js';
export { mediaHandleText, omittedMediaText, readAttachmentBytes, toBase64 } from './media.js';
export { CODES } from './errors.js';

/** Stable Loader identity for this plugin. */
export const name = 'mimo-adapter';

/** Services that must resolve before this plugin's registrations run. */
export const inject = ['llm'];

/** User-settings namespace holding this route's editable connection facts. */
const NS = 'mimo-adapter';

/** Minimal environment surface this plugin reads (the harness `launchEnvironment` service). */
function launchEnvironmentOf(ctx) {
    try {
        return {
            get(key) {
                const service = ctx.get('launchEnvironment');
                const value = service?.get?.(key);
                if (value === undefined || value === null) return undefined;
                const text = typeof value === 'string' ? value : value.value;
                return typeof text === 'string' && text.length > 0 ? { value: text } : undefined;
            },
        };
    } catch {
        return { get: () => undefined };
    }
}

function settingsOf(ctx) {
    try {
        return ctx.get('settings');
    } catch {
        return undefined;
    }
}

/**
 * Attach the optional user-settings section.
 *
 * Settings are optional by design: the shipped DeepSeek route does the same, so
 * a profile without `@deepseek-ai/dsh-settings-file` still loads this plugin.
 * When the service is present, an edit in the Web settings document takes
 * effect on the next request and an edit the plugin cannot serve is rejected
 * together with the snapshot that produced it.
 */
function attachSettings(ctx, config, setSource, onChange) {
    const settings = settingsOf(ctx);
    if (settings === undefined) return;
    try {
        settings.installSection(ctx, NS, Config, config, {
            setSource: (source) => setSource(source),
            onChange,
            validate: (value) => {
                resolveConfig(value);
            },
        });
    } catch (error) {
        ctx.logger?.warn?.(`dsh-mimo-adapter: the optional settings section is unavailable: ${error?.message ?? error}`);
    }
}

/**
 * Plugin entry point.
 * @param ctx - the plugin's Cordis context.
 * @param config - the row config, validated by {@link Config}.
 */
export function apply(ctx, config) {
    let current = () => config;
    let lastRaw;
    let lastGood;

    /** Re-read and re-judge the configuration on every operation. */
    const options = () => {
        const raw = current();
        if (raw === lastRaw && lastGood !== undefined) return lastGood;
        try {
            const next = resolveConfig(raw);
            lastRaw = raw;
            lastGood = next;
            return next;
        } catch (error) {
            if (lastGood === undefined) throw error;
            lastRaw = raw;
            ctx.logger?.error(`dsh-mimo-adapter: keeping the last good configuration after an invalid settings section: ${error?.message ?? error}`);
            return lastGood;
        }
    };

    // Fail loud at load: a row whose config cannot be served must not mount a
    // route that fails on first use.
    options();

    /**
     * The route name is the settings key, the credential stem, and the id every
     * recorded session cites. It is therefore fixed at load and cannot be
     * changed by a settings edit; `resolveConfig` accepts any non-empty string,
     * so a mismatch would otherwise be silently ignored.
     */
    const route = options().provider;

    const readEnvironment = () => launchEnvironmentOf(ctx);

    /**
     * Resolve the credential through the harness credentials seam first, then
     * the launching environment, exactly like the shipped DeepSeek route.
     * A route with no key resolves to `undefined` and reaches the provider
     * unauthenticated, which is the only correct behaviour for a local
     * deployment that needs no key.
     */
    const resolveApiKey = async (connection, signal) => {
        signal?.throwIfAborted?.();
        const ref = connection.apiKeyEnv;
        let raw;
        const credentials = (() => {
            try {
                return ctx.get('credentials');
            } catch {
                return undefined;
            }
        })();
        if (credentials !== undefined) {
            const hit = await credentials.resolve(ref);
            raw = hit?.value;
        } else {
            raw = readEnvironment().get(ref)?.value;
        }
        if (raw === undefined) return undefined;
        const trimmed = raw.trim();
        if (trimmed.length === 0) {
            throw new LlmError(
                `dsh-mimo-adapter: the credential resolved from ${ref} is blank; store the raw key through the credentials service or export ${ref}`,
                CODES.INVALID_CREDENTIAL,
            );
        }
        if (/[^\x21-\x7e]/.test(trimmed)) {
            throw new LlmError(
                `dsh-mimo-adapter: the credential resolved from ${ref} contains characters no HTTP header can carry; store the raw key alone`,
                CODES.INVALID_CREDENTIAL,
            );
        }
        return trimmed;
    };

    const resolveAttachments = () => {
        try {
            return ctx.get('attachments');
        } catch {
            return undefined;
        }
    };

    const imageAccess = (hostPath) => {
        try {
            return ctx.get('fs')?.processPathFromHostPath?.(hostPath);
        } catch {
            return undefined;
        }
    };

    const adapter = new MiMoAdapter({
        options,
        resolveApiKey,
        resolveAttachments,
        imageAccess,
        logger: ctx.logger,
    });

    attachSettings(ctx, config, (source) => {
        current = source;
    }, () => {
        // A settings edit re-reads and re-judges the configuration. It cannot
        // change the registered route (see `route` above), so nothing is
        // re-registered here; a rejected snapshot keeps the last good facts.
        try {
            options();
        } catch (error) {
            ctx.logger?.warn?.(`dsh-mimo-adapter: rejected a settings snapshot: ${error?.message ?? error}`);
        }
    });

    /**
     * Publish the route in the configurable-provider directory.
     *
     * `LlmRuntime` rejects a second declaration of the same provider with
     * `DUPLICATE_DIRECTORY`, and that rejection happens while the plugin tree
     * is being built, so an unhandled conflict takes the whole profile down.
     * A conflict is reported and skipped instead: the route is then owned by
     * whatever declared it first, and this adapter's capabilities stay
     * unavailable for it rather than the profile failing to boot.
     */
    try {
        ctx.llm.registerConfigurableProviders([{
            provider: route,
            displayName: options().displayName,
            settingsNs: NS,
            settingsPath: [],
        }]);
    } catch (error) {
        const declared = (() => {
            try {
                return (ctx.llm.listConfigurableProviders() ?? []).map((entry) => entry.provider).join(', ');
            } catch {
                return 'unknown';
            }
        })();
        ctx.logger?.error(
            `dsh-mimo-adapter: the "${route}" route is already declared, so this adapter stays dormant `
            + `(declared providers: ${declared}). Remove the other declaration of "${route}" — for llm-pi-ai that means `
            + `the "llm-pi-ai.providers.${route}:" section — then restart. Original error: ${error?.message ?? error}`,
        );
        return;
    }

    try {
        ctx.llm.registerAdapter([route], adapter);
    } catch (error) {
        ctx.logger?.error(
            `dsh-mimo-adapter: the "${route}" route already bound to an adapter, so this adapter stays dormant; `
            + `remove the other declaration of "${route}" and restart. Original error: ${error?.message ?? error}`,
        );
        return;
    }

    // Close the modality hole this plugin opens for every route it does not
    // own. A failure here is survivable (the owned route serializes media
    // itself) and must not take the plugin down.
    try {
        ctx.on('llm/stream', makeModalityDegradeListener(ctx, route, {
            attachments: resolveAttachments,
            imageAccess,
        }));
    } catch (error) {
        ctx.logger?.warn?.(`dsh-mimo-adapter: could not install the foreign-route modality degradation listener: ${error?.message ?? error}`);
    }
}
