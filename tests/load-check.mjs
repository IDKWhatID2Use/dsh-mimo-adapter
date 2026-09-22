/**
 * Load verification for dsh-mimo-adapter.
 *
 * ## What this checks, and what it cannot
 *
 * The load-bearing failure mode for a DSH plugin is not runtime behaviour — it
 * is whether the harness can resolve the row at all. Three checks cover that,
 * and this script performs the first two automatically:
 *
 * 1. **Manifest + patch shape** — `dsh.bundle.patch` is declared, the patch is
 *    a top-level YAML array, and the package exports a resolvable entry point.
 * 2. **Composed config tree** — `dsh --profile <p> --dump-config` succeeds and
 *    contains the loader row with the configured facts.
 * 3. **Real boot** — a profile that lists this package in `dsh.profile.bundles`
 *    boots without `plugin tree failed to load`. That check needs a profile and
 *    a working endpoint for the turn to finish, so this script prints the exact
 *    commands instead of driving them.
 *
 * Run: `node tests/load-check.mjs [profile]`
 * Exits non-zero when an automatic check fails.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const profile = process.argv[2] ?? process.env.MIMO_PROFILE ?? 'test1';
const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
const profileDir = join(dshHome, 'profiles', profile);

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
check('package.json declares dsh.bundle.patch', manifest.dsh?.bundle?.patch === './cordis.patch.yml',
    String(manifest.dsh?.bundle?.patch));
check('the declared patch file exists', existsSync(join(packageRoot, manifest.dsh?.bundle?.patch ?? '')), manifest.dsh?.bundle?.patch);
check('the entry point exists', existsSync(join(packageRoot, manifest.main ?? '')), manifest.main);
check('peer dependencies are declared', Object.keys(manifest.peerDependencies ?? {}).length > 0,
    Object.keys(manifest.peerDependencies ?? {}).join(', '));

const patch = readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8');
check('the patch inserts a row for this package', patch.includes("name: 'dsh-mimo-adapter'"));
check('the patch is a top-level loader entry list', /^- insert:/m.test(patch));

if (!existsSync(profileDir)) {
    console.log(`\nSKIP  profile "${profile}" not found at ${profileDir}; set MIMO_PROFILE to an existing profile`);
} else {
    const profileManifestPath = join(profileDir, 'package.json');
    const profileManifest = existsSync(profileManifestPath)
        ? JSON.parse(readFileSync(profileManifestPath, 'utf8').replace(/^\uFEFF/, ''))
        : {};
    const bundles = profileManifest.dsh?.profile?.bundles ?? [];
    const listed = bundles.includes(manifest.name);

    const dump = spawnSync(`dsh --profile ${profile} --dump-config`, { encoding: 'utf8', shell: true, timeout: 120000 });
    const output = `${dump.stdout ?? ''}${dump.stderr ?? ''}`;
    check('dsh --dump-config succeeds for the profile', dump.status === 0, `exit ${dump.status}`);
    check('no loader failure is reported', !/plugin tree failed to load/.test(output));
    if (listed) {
        check('the composed tree carries the plugin row', output.includes('mimo-adapter'));
    } else {
        console.log(`SKIP  the composed tree carries the plugin row — ${manifest.name} is not in this profile's dsh.profile.bundles yet`);
        console.log('      (add it to the bundles list, then re-run: this is the check that proves the patch composes.)');
    }
}

console.log('\n--- real boot check (run these by hand) ---');
console.log(`# 1. make the plugin resolvable inside the profile:`);
console.log(`#    mklink /J "${join(profileDir, 'node_modules', 'dsh-mimo-adapter')}" "${packageRoot}"`);
console.log(`#    (\`dsh plugin --profile ${profile} add file:${packageRoot.replace(/\\/g, '/')}\` is the pnpm route.)`);
console.log(`# 2. add "dsh-mimo-adapter" to dsh.profile.bundles in ${join(profileDir, 'package.json')}`);
console.log(`# 3. boot it:`);
console.log(`#    dsh --profile ${profile} --headless "reply with ok"`);
console.log('#    PASS when no "plugin tree failed to load" appears and the turn reaches the provider.');
console.log('#    The turn needs a reachable endpoint: point config.baseURL at the real host,');
console.log('#    or at a local OpenAI-compatible stub, before expecting it to finish.');

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} automatic checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
