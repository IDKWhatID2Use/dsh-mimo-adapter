# tools/

Maintenance scripts for publishing this repository when `git push` cannot be
used.

## Why they exist

On the machine where this plugin was built, `github.com:443` is blocked:
`git push` fails with

```
fatal: unable to access 'https://github.com/.../': Failed to connect to
github.com port 443 after 21487 ms
```

`api.github.com` is reachable, so the same content is published as git objects
over the REST API instead. A normal `git clone` on a machine without that
restriction reads the result back unchanged — the transport is an artefact of
this host and leaves no trace in the repository.

An empty repository also refuses the Git Data API (`409 Git Repository is
empty`), which is why the first upload had to go through the Contents API.

## Scripts

| script | purpose |
|---|---|
| `publish-snapshot.mjs` | Upload the reviewed tree of one commit as a single clean commit and point `refs/heads/master` at it. File contents are read from the local git object store, so the published set is exactly the reviewed tree — never a scratch file lying in the working directory. |
| `verify-published.mjs` | Compare the published tree against the local one blob-by-blob, and scan every published file for credential patterns and secret-shaped names. Exits non-zero on any difference. |

## Usage

```powershell
$env:GH_TOKEN = gh auth token
node tools/publish-snapshot.mjs <owner>/<repo> HEAD
node tools/verify-published.mjs <owner>/<repo>
```

`GH_TOKEN` is read from the environment only — never logged, never written to
disk. The verification step is the gate: it must print three `PASS` lines
(matching tree, no credential pattern, no secret-shaped file name) before the
snapshot is considered published.
