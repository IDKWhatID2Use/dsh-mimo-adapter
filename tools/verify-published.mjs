/**
 * Verify the published snapshot byte-for-byte against the local tree, and scan
 * it for credential material.
 *
 * Usage: `node tools/verify-published.mjs <owner>/<repo>` with GH_TOKEN set.
 */

import { execFileSync } from 'node:child_process';

const target = process.argv[2];
const token = process.env.GH_TOKEN;
if (!target) {
    console.error('usage: node tools/verify-published.mjs <owner>/<repo>');
    process.exit(2);
}

const headers = { accept: 'application/vnd.github+json', 'user-agent': 'verify', ...(token ? { authorization: `Bearer ${token}` } : {}) };
async function api(path) {
    const response = await fetch(`https://api.github.com${path}`, { headers });
    if (!response.ok) throw new Error(`${path} -> ${response.status}`);
    return response.json();
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const repo = await api(`/repos/${target}`);
const tree = await api(`/repos/${target}/git/trees/${repo.default_branch}?recursive=1`);
const remote = new Map(tree.tree.filter((item) => item.type === 'blob').map((item) => [item.path, item.sha]));

const local = new Map(
    git('ls-tree', '-r', 'HEAD')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const match = /^(\d+)\s+(\w+)\s+([0-9a-f]+)\t(.*)$/.exec(line);
            return [match[4], match[3]];
        }),
);

console.log(`remote files: ${remote.size}, local files: ${local.size}`);

let mismatched = 0;
for (const [path, sha] of local) {
    if (!remote.has(path)) {
        console.log(`  MISSING on remote: ${path}`);
        mismatched += 1;
    } else if (remote.get(path) !== sha) {
        console.log(`  CONTENT DIFFERS: ${path} (local ${sha.slice(0, 7)} vs remote ${remote.get(path).slice(0, 7)})`);
        mismatched += 1;
    }
}
for (const path of remote.keys()) if (!local.has(path)) {
    console.log(`  EXTRA on remote: ${path}`);
    mismatched += 1;
}
console.log(mismatched === 0 ? 'PASS  every file matches the local tree byte-for-byte' : `FAIL  ${mismatched} difference(s)`);

// Credential scan of the published text files.
const suspicious = [];
for (const path of remote.keys()) {
    if (/\.(png|jpg|jpeg|gif|webp|ico|zip|gz)$/i.test(path)) continue;
    const blob = await api(`/repos/${target}/git/blobs/${remote.get(path)}`);
    const text = Buffer.from(blob.content, 'base64').toString('utf8');
    for (const pattern of [/sk-[A-Za-z0-9]{16,}/g, /tp-[A-Za-z0-9]{16,}/g, /ttp-[A-Za-z0-9]{16,}/g, /gho_[A-Za-z0-9]+/g, /ghp_[A-Za-z0-9]+/g]) {
        const hit = text.match(pattern);
        if (hit) suspicious.push(`${path}: ${hit[0].slice(0, 12)}…`);
    }
}
console.log(suspicious.length === 0 ? 'PASS  no credential pattern in any published file' : `FAIL  ${suspicious.join(', ')}`);

// The published file names must not look like secrets either.
const nameIssues = [...remote.keys()].filter((path) => /(^|\/)(\.env|secrets?\.json|credentials?\.json|\.credentials|id_rsa|.*\.pem|.*\.key)$/i.test(path));
console.log(nameIssues.length === 0 ? 'PASS  no secret-shaped file name is published' : `FAIL  ${nameIssues.join(', ')}`);

console.log(`\n${repo.default_branch} @ ${(await api(`/repos/${target}/commits?per_page=1`))[0].sha.slice(0, 7)}`);
console.log(`public: ${!repo.private}`);
console.log(`clone: git clone https://github.com/${target}.git`);
process.exitCode = mismatched === 0 && suspicious.length === 0 && nameIssues.length === 0 ? 0 : 1;
