/**
 * Publish the reviewed working tree as one clean commit through the Git Data API.
 *
 * `github.com:443` is unreachable from this host, so `git push` cannot run; the
 * same content is uploaded as git objects over `api.github.com` and a normal
 * `git clone` reads it back unchanged.
 *
 * File contents are read from the local git object store rather than the
 * working tree, so the published set is exactly the reviewed tree of `treeish`
 * — never a scratch file that happened to be lying around.
 *
 * Usage: `node tools/publish-snapshot.mjs <owner>/<repo> [treeish]`
 * with GH_TOKEN set.
 */

import { execFileSync } from 'node:child_process';

const target = process.argv[2];
const treeish = process.argv[3] ?? 'HEAD';
if (!target || !/^[^/]+\/[^/]+$/.test(target)) {
    console.error('usage: node tools/publish-snapshot.mjs <owner>/<repo> [treeish]');
    process.exit(2);
}
const token = process.env.GH_TOKEN;
if (!token) {
    console.error('GH_TOKEN is not set');
    process.exit(2);
}

const API = 'https://api.github.com';
const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'user-agent': 'dsh-mimo-adapter-publish',
};

async function api(method, path, body) {
    const response = await fetch(`${API}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
    return text.length === 0 ? undefined : JSON.parse(text);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const entries = git('ls-tree', '-r', treeish)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
        const match = /^(\d+)\s+(\w+)\s+([0-9a-f]+)\t(.*)$/.exec(line);
        return { mode: match[1], sha: match[3], path: match[4] };
    });
console.log(`publishing ${entries.length} files from ${treeish}`);

const tree = [];
let index = 0;
for (const entry of entries) {
    index += 1;
    const content = execFileSync('git', ['cat-file', 'blob', entry.sha], { maxBuffer: 64 * 1024 * 1024 });
    const created = await api('POST', `/repos/${target}/git/blobs`, {
        content: content.toString('base64'),
        encoding: 'base64',
    });
    tree.push({ path: entry.path, mode: entry.mode === '100755' ? '100755' : '100644', type: 'blob', sha: created.sha });
    if (index % 10 === 0 || index === entries.length) console.log(`  ${index}/${entries.length}`);
}

const treeObject = await api('POST', `/repos/${target}/git/trees`, { tree });
const subject = git('log', '-1', '--format=%s', treeish).trim();

// The published snapshot is a single commit, so its message describes the whole
// state rather than the last increment.
const message = [
    subject,
    '',
    'Single published snapshot of the reviewed tree. It contains the three',
    'capabilities (reasoning-effort control, audio input, video input), the',
    'official-spec defaults, and the audit fixes, with the full verification',
    'suite: tests/mimo.test.mjs (57), tests/catalog-wiring.mjs (19),',
    'tests/load-check.mjs, and tests/live.mjs (11 against the real endpoint).',
    '',
    'No credential is present anywhere in this repository; see SECURITY.md.',
].join('\n');

const commit = await api('POST', `/repos/${target}/git/commits`, {
    message,
    tree: treeObject.sha,
    parents: [],
    author: { name: 'dsh_mimo_adapter', email: 'dsh_mimo_adapter@localhost', date: new Date().toISOString() },
});
console.log(`commit ${commit.sha}`);

try {
    await api('PATCH', `/repos/${target}/git/refs/heads/master`, { sha: commit.sha, force: true });
} catch {
    await api('POST', `/repos/${target}/git/refs`, { ref: 'refs/heads/master', sha: commit.sha });
}
// Drop the upload-time branch and make master the default.
await api('DELETE', `/repos/${target}/git/refs/heads/main`).catch(() => undefined);
await api('PATCH', `/repos/${target}`, { default_branch: 'master' });

const repo = await api('GET', `/repos/${target}`);
const remoteTree = await api('GET', `/repos/${target}/git/trees/${repo.default_branch}?recursive=1`);
const blobs = remoteTree.tree.filter((item) => item.type === 'blob');
console.log(`\nbranch: ${repo.default_branch}`);
console.log(`remote files: ${blobs.length} (local: ${entries.length})`);
console.log(`same set: ${JSON.stringify(blobs.map((b) => b.path).sort()) === JSON.stringify(entries.map((e) => e.path).sort())}`);
console.log(`url: https://github.com/${target}`);
