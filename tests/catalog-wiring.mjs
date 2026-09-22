/**
 * Catalog-wiring verification: prove the Web model selector and its Effort row
 * are driven by this adapter's own registration, with no client code.
 *
 * The Web catalog is built by the Host from the live LLM registry:
 * `dsh-api-session-controller/lib/types/catalog.js:8-57` walks
 * `ctx.llm.listProviders()`, calls `listModels(provider)` and then
 * `resolveModelInfo(provider, model)` per entry, and forwards
 * `resolved.reasoning` verbatim. The composer Effort row renders exactly those
 * efforts (`dsh-client-ui-model-selection/README.zh.md:32,86`).
 *
 * This script therefore drives the real harness pieces — a real Cordis
 * context, the real LlmRuntime, the real adapter — and asserts on the real
 * catalog payload. It is the test that would fail if `resolveModel()` stopped
 * returning reasoning metadata, which is the only thing that can make the UI
 * hide the Effort row.
 *
 * Run: `node tests/catalog-wiring.mjs`
 */

import { Context } from '@deepseek-ai/cordis';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { harnessResolve, makeAdapter, makeContext, makeLlmRegistry } from './helpers.mjs';

/**
 * Load one module from a harness package by path.
 *
 * Some harness modules this check needs (`catalog.js`) are internal to their
 * package and therefore outside its export map, so they are addressed by the
 * resolved package root rather than by specifier.
 *
 * @param specifier - the bare package specifier.
 * @param relativePath - path inside the package, e.g. `lib/types/catalog.js`.
 */
async function loadHarness(specifier, relativePath) {
    const entry = fileURLToPath(harnessResolve(specifier));
    return import(pathToFileURL(join(dirname(entry), '..', relativePath)).href);
}

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

const { buildModelCatalog } = await loadHarness('@deepseek-ai/dsh-api-session-controller', 'lib/types/catalog.js');

// --- 1. the real registry, driven by this plugin's own apply() ---------------
const { apply } = await import('../lib/index.js');
const ctx = new Context();
// Constructing the runtime registers itself as the context's `llm` service.
const runtime = new LlmRuntime(ctx);
const llm = makeLlmRegistry();

// The plugin registers into `ctx.llm`; the catalog reads the same registry.
const pluginCtx = makeContext({ llm });
apply(pluginCtx, {
    provider: 'xiaomi',
    displayName: 'Xiaomi',
    baseURL: 'https://mimo.test/v1',
    apiKeyEnv: 'MIMO_API_KEY',
});

// Re-register the adapter instance the plugin built into the real runtime, so
// `buildModelCatalog` reads the identical registration the plugin created.
const registered = llm.adapters.get('xiaomi');
check('the plugin registered the xiaomi route', registered !== undefined);
runtime.registerAdapter(['xiaomi'], registered);
check('the real LlmRuntime accepts the plugin adapter',
    runtime.listProviders().some((entry) => entry.id === 'xiaomi'),
    runtime.listProviders().map((entry) => entry.id).join(',') || 'none');
check('the real runtime publishes provider display name', runtime.listProviders().find((entry) => entry.id === 'xiaomi')?.name === 'Xiaomi');

// --- 2. the catalog the Web client actually receives -------------------------
const catalogCtx = {
    llm: runtime,
    get(name) {
        return name === 'llm' ? runtime : undefined;
    },
};
const catalog = await buildModelCatalog(catalogCtx, { provider: 'xiaomi', model: 'mimo-v2.6-pro' });

const group = catalog.groups.find((entry) => entry.id === 'xiaomi');
check('the selector receives a xiaomi group', group !== undefined,
    catalog.groups.map((entry) => entry.id).join(',') || 'none');
check('the xiaomi group is routable', catalog.routableProviders.includes('xiaomi'));
check('no provider failure is isolated away', catalog.failures.length === 0,
    catalog.failures.map((entry) => `${entry.id}: ${entry.message}`).join(' | '));

const modelIds = group?.models.map((entry) => entry.id) ?? [];
check('all official models appear in the selector', modelIds.length === 6, modelIds.join(','));

const pro = group?.models.find((entry) => entry.id === 'mimo-v2.6-pro');
check('a model with reasoning metadata carries an Effort row', pro?.reasoning !== undefined);
check('the Effort row lists the two documented levels',
    JSON.stringify(pro?.reasoning?.efforts.map((effort) => effort.id)) === JSON.stringify(['off', 'high']),
    pro?.reasoning?.efforts.map((effort) => `${effort.id}=${effort.name}`).join(','));
check('the Effort row carries the deployment default', pro?.reasoning?.defaultEffort === 'high',
    String(pro?.reasoning?.defaultEffort));

// --- 3. the selection the UI submits resolves through the same registry ------
const accepted = await runtime.resolveCallConfig({ provider: 'xiaomi', model: 'mimo-v2.6-pro', reasoningEffort: 'off' });
check('a level the UI offers is accepted by the runtime', accepted.reasoningEffort === 'off', String(accepted.reasoningEffort));
const defaulted = await runtime.resolveCallConfig({ provider: 'xiaomi', model: 'mimo-v2.6-pro' });
check('an omitted level materializes the adapter default', defaulted.reasoningEffort === 'high', String(defaulted.reasoningEffort));
await runtime.resolveCallConfig({ provider: 'xiaomi', model: 'mimo-v2.6-pro', reasoningEffort: 'max' }).then(
    () => check('a level the UI never offers is refused', false, 'no error raised'),
    (error) => check('a level the UI never offers is refused', error.code === 'UNSUPPORTED_REASONING_EFFORT', error.code),
);

// --- 4. a per-model restriction narrows the row, not the route ---------------
const restricted = makeAdapter({
    baseURL: 'https://mimo.test/v1',
    models: [
        { id: 'text-only', inputModalities: ['text'], reasoning: false },
        { id: 'fast-only', inputModalities: ['text'], reasoning: { efforts: ['off'] } },
    ],
});
const restrictedRuntime = new LlmRuntime(new Context());
restrictedRuntime.registerAdapter(['xiaomi'], restricted.adapter);
const restrictedCatalog = await buildModelCatalog({
    llm: restrictedRuntime,
    get: () => restrictedRuntime,
}, { provider: 'xiaomi', model: 'text-only' });
check('a restricted route still produces a selector group', restrictedCatalog.groups.length > 0,
    JSON.stringify({ groups: restrictedCatalog.groups.map((entry) => entry.id), failures: restrictedCatalog.failures }));
const restrictedGroup = restrictedCatalog.groups[0];
const textOnly = restrictedGroup?.models.find((entry) => entry.id === 'text-only');
const fastOnly = restrictedGroup?.models.find((entry) => entry.id === 'fast-only');
check('a non-reasoning model renders no Effort row', textOnly !== undefined && textOnly.reasoning === undefined,
    JSON.stringify(textOnly));
check('a restricted model renders only its own levels',
    JSON.stringify(fastOnly?.reasoning?.efforts.map((effort) => effort.id)) === JSON.stringify(['off']),
    fastOnly?.reasoning?.efforts.map((effort) => effort.id).join(','));
check('a restricted model publishes a default it actually offers',
    fastOnly?.reasoning?.defaultEffort === 'off',
    String(fastOnly?.reasoning?.defaultEffort));

// --- 5. the deployment default never leaks past a restriction ---------------
const mixed = makeAdapter({
    baseURL: 'https://mimo.test/v1',
    defaultEffort: 'high',
    efforts: [
        { id: 'off', name: 'Off', inert: true, thinking: { type: 'disabled' } },
        { id: 'low', name: 'Low', thinking: { type: 'enabled' } },
        { id: 'high', name: 'High', thinking: { type: 'enabled' } },
    ],
    models: [
        { id: 'full', inputModalities: ['text'] },
        { id: 'narrow', inputModalities: ['text'], reasoning: { efforts: ['off'] } },
    ],
});
const mixedRuntime = new LlmRuntime(new Context());
mixedRuntime.registerAdapter(['xiaomi'], mixed.adapter);
const mixedCatalog = await buildModelCatalog({ llm: mixedRuntime, get: () => mixedRuntime }, { provider: 'xiaomi', model: 'full' });
const mixedGroup = mixedCatalog.groups[0];
const narrow = mixedGroup?.models.find((entry) => entry.id === 'narrow');
check('a narrowed model does not inherit the deployment default',
    narrow?.reasoning?.defaultEffort === 'off',
    String(narrow?.reasoning?.defaultEffort));
check('the whole group survives the narrowed model', mixedGroup?.models.length === 2,
    mixedGroup?.models.map((entry) => entry.id).join(','));

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
