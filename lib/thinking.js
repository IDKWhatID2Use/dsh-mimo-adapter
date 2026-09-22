/**
 * Reasoning-effort (思考强度) selection for dsh-mimo-adapter.
 *
 * Two layers decide one request's thinking level, in this fixed order:
 *
 * 1. the deployment policy (`config.thinking: disabled` locks every request to
 *    the single inert level);
 * 2. the request's `reasoningEffort`, which the harness validates against
 *    `resolveModel()`'s declared `efforts` *before* any provider I/O and fails
 *    with `UNSUPPORTED_REASONING_EFFORT` when it is not offered.
 *
 * The adapter must still re-judge here, because a hand-built `ctx.llm.stream()`
 * call reaching the adapter directly does not pass through that validation.
 *
 * MiMo's documented vocabulary is binary — `thinking.type` is `enabled` or
 * `disabled` (deep-thinking doc) — so the default levels are those two and a
 * deployment that finds a documented level parameter adds more by config.
 *
 * @module dsh-mimo-adapter/thinking
 */

import { CODES } from './errors.js';

/** One declaration that puts nothing reasoning-related on the wire. */
const NO_EFFORT = Object.freeze({ id: '<none>', name: 'None', sends: Object.freeze({}), clears: Object.freeze([]), inert: true });

/**
 * The effective per-model reasoning restriction.
 *
 * `resolveConfig` keeps `false` (a non-reasoning model) and an object (a
 * restriction) distinct, so this is the one place that reads both shapes.
 *
 * @param model - the resolved model entry.
 * @returns `false` for a non-reasoning model, the restriction object, or undefined for no restriction.
 */
function reasoningRestriction(model) {
    const value = model?.reasoning;
    return value === false ? false : value;
}

/**
 * Selectable efforts for one resolved model, honoring a per-model restriction.
 *
 * A non-reasoning model (`reasoning: false`) offers none — which is what makes
 * both the published metadata and the wire request consistent.
 *
 * @param model - the resolved model entry.
 * @param reasoning - validated deployment reasoning config.
 * @returns the offered effort declarations, in deployment order; empty for a non-reasoning model.
 */
export function effortsForModel(model, reasoning) {
    const all = reasoning.efforts;
    const restriction = reasoningRestriction(model);
    if (restriction === undefined) return all;
    if (restriction === false) return [];
    const allowed = restriction.efforts;
    if (allowed === undefined) return all;
    const byId = new Map(all.map((effort) => [effort.id, effort]));
    return allowed.map((id) => {
        const found = byId.get(id);
        if (found === undefined) {
            // Config validation rejects this at load, so reaching here means a
            // programmatic caller bypassed `resolveConfig` entirely.
            const error = new Error(`dsh-mimo-adapter: model "${model.id}" restricts reasoning to undeclared effort "${id}"`);
            error.code = CODES.INVALID_CONFIG;
            throw error;
        }
        return found;
    });
}

/** The level explicitly marked as the inert one, if the deployment declared one. */
export function inertEffort(reasoning) {
    return reasoning.efforts.find((effort) => effort.inert === true);
}

/**
 * The one default a model is allowed to publish.
 *
 * The harness materializes this into every request that omits an effort, so it
 * must be a level this exact model offers. Precedence: the model's own
 * `defaultEffort`, a per-model restriction's, the locked level, then the
 * deployment's — the first candidate the model actually offers wins.
 *
 * @param model - the resolved model entry.
 * @param reasoning - validated deployment reasoning config.
 * @param offered - the levels this model offers.
 * @returns an offered effort id, or undefined when none applies.
 */
function effectiveDefault(model, reasoning, offered) {
    const restriction = reasoningRestriction(model);
    const candidates = [
        model.defaultEffort,
        typeof restriction === 'object' && restriction !== null ? restriction.defaultEffort : undefined,
        reasoning.lockedEffortId,
        reasoning.defaultEffort,
    ];
    const ids = new Set(offered.map((effort) => effort.id));
    return candidates.find((candidate) => candidate !== undefined && ids.has(candidate));
}

/**
 * Resolve the one effort a request actually sends.
 *
 * `session-title` calls always take the inert level: the answer is a short
 * visible title and thinking would consume the output cap.
 *
 * @param options - the assembled request (`reasoningEffort`, `purpose`).
 * @param model - the resolved model entry.
 * @param reasoning - validated deployment reasoning config.
 * @param logger - optional diagnostic sink for a refusal.
 * @returns the effort declaration whose `sends` fields belong on the wire.
 * @throws Error with {@link CODES.UNSUPPORTED_REASONING_EFFORT} when the request names an unoffered level.
 */
export function resolveEffort(options, model, reasoning, logger) {
    if (options.purpose === 'session-title') {
        return inertEffort(reasoning) ?? NO_EFFORT;
    }

    const offered = effortsForModel(model, reasoning);
    const requested = options.reasoningEffort;

    if (reasoning.lockedEffortId !== undefined) {
        const locked = reasoning.efforts.find((effort) => effort.id === reasoning.lockedEffortId);
        if (requested !== undefined && requested !== locked.id) {
            logger?.warn?.(
                `dsh-mimo-adapter: thinking is disabled by deployment policy; effort "${requested}" was replaced by "${locked.id}"`,
            );
        }
        return locked;
    }

    // A model that offers nothing must receive nothing: returning a deployment
    // level here would send a reasoning field to a model that declared it has
    // no reasoning, which is exactly the defect the published metadata avoids.
    if (offered.length === 0) {
        if (requested !== undefined) {
            const error = new Error(
                `dsh-mimo-adapter: model "${model.id}" is declared non-reasoning and cannot accept reasoning effort "${requested}"`,
            );
            error.code = CODES.UNSUPPORTED_REASONING_EFFORT;
            throw error;
        }
        return NO_EFFORT;
    }

    if (requested !== undefined) {
        const found = offered.find((effort) => effort.id === requested);
        if (found === undefined) {
            const error = new Error(
                `dsh-mimo-adapter: model "${model.id}" does not offer reasoning effort "${requested}"; offered: ${offered.map((effort) => effort.id).join(', ')}`,
            );
            error.code = CODES.UNSUPPORTED_REASONING_EFFORT;
            throw error;
        }
        return found;
    }

    const defaultId = effectiveDefault(model, reasoning, offered);
    if (defaultId !== undefined) {
        const found = offered.find((effort) => effort.id === defaultId);
        if (found !== undefined) return found;
    }
    // No deployment default and no per-model one: MiMo enables deep thinking by
    // default, so the non-inert first level is the honest fallback.
    return offered.find((effort) => effort.inert !== true) ?? offered[0];
}

/**
 * Apply one effort declaration onto the outgoing request body.
 *
 * `sends` is already the exact wire spelling (`{ thinking: { type: 'disabled' } }`
 * or a deployment's own field names), and `clears` names the reasoning knobs
 * this level must remove. Together they make the body carry exactly one level's
 * fields: no level is ever clamped or aliased into another, and an earlier
 * resolution path cannot leave a stale field behind.
 *
 * @param body - the request body built so far.
 * @param effort - the resolved effort declaration.
 * @returns the request body with the reasoning fields applied.
 */
export function applyEffort(body, effort) {
    const next = { ...body };
    for (const field of effort.clears ?? []) delete next[field];
    for (const [field, value] of Object.entries(effort.sends)) {
        next[field] = value;
    }
    return next;
}

/**
 * The `LlmModelReasoningInfo` shape `resolveModel()` must return so the harness
 * can validate and materialize efforts before dispatch.
 *
 * @param model - the resolved model entry.
 * @param reasoning - validated deployment reasoning config.
 * @returns reasoning metadata, or undefined when the model offers none.
 */
export function modelReasoningInfo(model, reasoning) {
    const efforts = effortsForModel(model, reasoning);
    if (efforts.length === 0) return undefined;
    const defaultEffort = effectiveDefault(model, reasoning, efforts);
    return {
        efforts: efforts.map((effort) => ({
            id: effort.id,
            name: effort.name,
            ...(effort.description === undefined ? {} : { description: effort.description }),
        })),
        ...(defaultEffort === undefined ? {} : { defaultEffort }),
    };
}

export { NO_EFFORT };
