/**
 * Link the harness packages this plugin declares as peer dependencies into the
 * plugin's own `node_modules`, so bare `@deepseek-ai/...` specifiers resolve
 * the same way they do inside a DSH profile.
 *
 * A profile installs the plugin into `<profile>/node_modules`, and Node then
 * resolves `@deepseek-ai/dsh-llm` by walking up from the plugin directory. A
 * test run in this checkout has no such ancestor, so this script creates the
 * missing links once.
 *
 * Run: `node tests/bootstrap.mjs`
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const anchorCandidates = [
    process.env.MIMO_HARNESS_ANCHOR,
    process.env.DSH_CHECKOUT,
    process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
    'F:\\NodeJS\\node_global\\node_modules\\@deepseek-ai\\dsh',
].filter(Boolean);

function findScopedRoot() {
    for (const anchor of anchorCandidates) {
        const scoped = join(anchor, 'node_modules', '@deepseek-ai');
        if (existsSync(scoped)) return scoped;
        const flat = join(anchor, '..', '@deepseek-ai');
        if (existsSync(join(flat, 'dsh-llm'))) return flat;
    }
    throw new Error(`no harness install found; tried:\n  ${anchorCandidates.join('\n  ')}`);
}

const scopedRoot = findScopedRoot();
const { name, peerDependencies = {} } = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));

const targetScoped = join(packageRoot, 'node_modules', '@deepseek-ai');
mkdirSync(targetScoped, { recursive: true });

const wanted = Object.keys(peerDependencies).filter((specifier) => specifier.startsWith('@deepseek-ai/'));
const linked = [];
const missing = [];

for (const specifier of wanted) {
    const bare = specifier.slice('@deepseek-ai/'.length);
    const source = join(scopedRoot, bare);
    if (!existsSync(source)) {
        missing.push(specifier);
        continue;
    }
    const destination = join(targetScoped, bare);
    rmSync(destination, { recursive: true, force: true });
    symlinkSync(source, destination, 'junction');
    linked.push(specifier);
}

// The plugin imports `@deepseek-ai/dsh-attachment` only for its TypeScript
// declaration; nothing is imported at runtime, so it is not linked here.
console.log(`${name}: linked ${linked.length} harness package(s) from ${scopedRoot}`);
for (const specifier of linked) console.log(`  ✔ ${specifier}`);
for (const specifier of missing) console.log(`  ✖ ${specifier} (not present in the harness install)`);

const probe = createRequire(join(packageRoot, 'noop.js'));
try {
    console.log(`verify: @deepseek-ai/dsh-llm -> ${probe.resolve('@deepseek-ai/dsh-llm')}`);
} catch (error) {
    console.error(`verify failed: ${error.message}`);
    process.exitCode = 1;
}

// Keep the harness's own dependency graph reachable: the linked packages live
// outside this package, so Node resolves their own dependencies from their real
// location, which is what a profile does too.
if (readdirSync(targetScoped).length === 0) {
    console.error('nothing was linked');
    process.exitCode = 1;
}
