# Security

## Credentials

This plugin needs a MiMo API credential at runtime and **ships none**. There is
no key, token, or password anywhere in this repository — not in the source, not
in the tests, not in the commit history.

The credential is resolved per request, in this order:

1. the harness credentials service, under the reference named by `apiKeyEnv`
   (default `XIAOMI_API_KEY`);
2. the launching environment, under the same name.

`apiKeyEnv` is a **reference name**, never a value. Whatever stores the actual
key — the harness credentials store, a shell export, a `.env` outside this
repository — stays outside this repository.

Recommended setup on a new machine:

```powershell
# either export it in the launching environment
$env:XIAOMI_API_KEY = '<your key>'
# or point the plugin at whatever reference your credential store already uses
#   config: { apiKeyEnv: MY_EXISTING_REF }
```

## What the plugin does with a credential

- It is sent only to the configured `baseURL`, in the header selected by
  `auth` (the official transport is `api-key`).
- It is never written to logs. When a provider error body echoes the request
  back, `summarizeBody()` redacts the exact credential string before the
  excerpt reaches a diagnostic (`lib/errors.js`).
- A missing key resolves to `undefined` and the request goes out
  unauthenticated — the correct behaviour for a local deployment — rather than
  failing with a fabricated credential. A malformed key fails with
  `INVALID_CREDENTIAL` and the message names the reference, never any part of
  the secret.

## Repository hygiene

`.gitignore` excludes `node_modules/`, `.env*`, `*.pem`, `*.key`, `*.p12`,
`credentials.json`, `.credentials*`, harness session/attachment directories,
and databases, so a local working copy configured for a real deployment cannot
accidentally commit its secrets.

Before any release, the check is:

```powershell
# tracked files only
git ls-files | ForEach-Object { Select-String -Path $_ -Pattern 'sk-[A-Za-z0-9]{16,}|tp-[A-Za-z0-9]{16,}|ttp-[A-Za-z0-9]{16,}' }
# full history
git log -p --all | Select-String -Pattern 'sk-[A-Za-z0-9]{16,}|api[_-]?key\s*[:=]\s*["'']?[A-Za-z0-9]{20,}'
```

Both must return nothing.

## Reporting

Open a GitHub issue for anything security-relevant that does not involve a
live credential. **Never paste a real API key into an issue** — describe the
reference name and the symptom instead.
