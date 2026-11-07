# Codex-Claude Bridge identity and migration

This document records naming and compatibility for the shipped bridge.
`codex-claude-companion@1.2.0` is the current stable release on npm
dist-tag `latest`. It preserves the historical release-candidate approval and
unscoped cutover decision for `codex-claude-companion`.

## Product identity

The public product display name is **Codex-Claude Bridge**. The primary
executable remains `codex-claude`, preserving the command users already invoke.
Its differentiated role is a durable Codex-to-Claude control plane with tmux
process ownership, typed delegation contracts, collaboration events, delivery
acknowledgement, recovery, and independent verification.

The npm package is now `codex-claude-companion`. The inherited name
`codex-plugin-cc` is deprecated: it becomes a thin legacy shim that prints one
migration notice and forwards compatible arguments, environment, standard I/O,
exit status, and termination signals to `codex-claude-companion`. Removal of that
shim requires a separately announced major-version policy.

The native Codex plugin ID and slash-command namespace remain `claude-review`
for compatibility, so commands continue to appear as `/claude-review:*` even
though the product display name is Codex-Claude Bridge. The checked-in root
manifest and generated compatibility wrapper both retain the established local
marketplace key `claude-review-private`, with source entry `claude-review`.
Those are compatibility identifiers, not the public product name. The separate
Claude Code reference marketplace is `kenmege-codex-reference`, with source
entry `codex`; it preserves the upstream Claude-to-Codex component and is not
the bridge identity. Changing any compatibility identifier requires an explicit
migration with alias and rollback tests.

## Name guard and attribution

The public qualifier is **Codex-Claude Bridge by Kenmege**. It is an independent
community project and is not affiliated with or endorsed by OpenAI or
Anthropic. OpenAI's `openai/codex-plugin-cc` is a Claude Code-to-Codex plugin;
this bridge is a Codex-to-Claude control plane. OpenAI-derived plugin manifests,
command conventions, and bundled components retain their applicable copyright
notices and attribution. Product-owned identity remains separate from upstream
attribution.

## Target repository and package decision

The canonical repository and npm package name is `codex-claude-companion`.

**Superseded plan (2026-07-20).** An earlier plan targeted the scoped package
`@kenmege/codex-claude-bridge` as the candidate. It is SUPERSEDED by Kennedy's
decision to publish under the unscoped `codex-claude-companion` name (scoped plan
dropped: name-family confusion and discoverability — the unscoped
`codex-claude-bridge` name is already occupied by an unrelated third party, and
the scoped `@kenmege/codex-claude-bridge` candidate shared that confusable
"bridge" family). The stable release is `codex-claude-companion@1.2.0`, using
npm dist-tag `latest`. The rc.1 approval is retained below as historical evidence.

## Migration sequence

1. Keep `codex-claude-companion` authoritative while bridge commands stabilize
   behind `codex-claude` and `/claude-review:*`.
2. Prepare and test the inert legacy-shim scaffold under
   `packages/codex-plugin-cc-shim/`; it remains private before cutover.
3. Release the full bridge under `codex-claude-companion` through a prerelease and
   a clean-install compatibility gate.
4. At the next synchronized stable release, keep `codex-claude-companion`
   canonical and publish the tested exact-version `codex-plugin-cc` shim. Release
   automation must atomically replace the scaffold's `0.0.0-development` version
   and dependency with the same approved canonical version.
5. Preserve both executable names, `claude-review`, `/claude-review:*`, durable
   state paths, environment variables, and receipt schemas.
6. The GitHub repository rename to `codex-claude-companion` is complete; keep
   provenance, badges, workflows, and redirect checks green against it.
7. Support the shim for at least two stable releases plus an announced window;
   removal requires a separately announced major-version policy.

## Public cutover gate

The migration is fail-closed. Every item below must have recorded evidence before
each public package release:

- verified npmjs authentication and trusted-publisher control for
  `codex-claude-companion`;
- clean-install parity between the release candidate and the stable package
  before the legacy `codex-plugin-cc` name becomes a shim;
- successful trusted publisher, provenance, badges, workflows, and repository
  redirects against the `codex-claude-companion` repository;
- review of all modified OpenAI-derived files under `plugins/codex/` against the
  Apache-2.0 attribution requirements, including any required modification notices;
- explicit public-release approval from Kennedy.

**Existing-package prerelease verdict: APPROVED.** Kennedy approved publication
of `codex-claude-companion@1.2.0-rc.1` under npm dist-tag `next`. The trusted
publisher, CI, clean-install, provenance, and post-publish smoke gates still fail
closed.

**Unscoped cutover verdict: READY.** The canonical unscoped name is
`codex-claude-companion`, the GitHub repository rename is complete, and Kennedy
approved the direction. Each public release still fails closed on the recorded
evidence above.

## Contracts schemaVersion 2, the host profile, and the config file

This section covers the contract and configuration layer for delegation in both
directions: Codex to Claude, as today, and Claude to Codex. The command-line
flags that use it arrive in a later change; until then every command keeps
writing the 1.x contracts described above.

### Versioned contracts

Each file under `schemas/` (request, event, message operation, result, receipt)
is now a `oneOf` union on `schemaVersion`:

- `$defs.v1` is the 1.2.0 contract, unchanged. A test pins its digest, so a 1.x
  document validates exactly as before, with the same error messages.
- `$defs.v2` adds:
  - an origin family (`codex` or `claude`) and a worker family;
  - the provider bound to the worker family;
  - a verifier that is always the other family;
  - the task family, a `continuesJobId` and the routing provenance
    (`flag`, `config`, `extension` or `host`, with a reason).
- A v2 result names `workerFamily` and `workerSessionId` (the Claude session id
  or the Codex thread id) instead of `claudeSessionId`, and may carry a `plan`.
- A v2 receipt adds:
  - the effective worker and verifier settings as each reported them;
  - the delivery route (`waiter`, `origin` or `inbox`) and the `queued` state;
  - a verifier integrity record: a passed verification requires
    `integrity.mutated: false`;
  - quota events, extension digests, the continuation and repair attempts.
- In v2, events and message operations can come from either family. The
  validators check each author against the job's origin and worker families:
  a `question` comes from the worker, a pending message from the origin, and an
  acknowledgement from the worker.

Any other `schemaVersion` is a schema error that names the supported versions.

### Reading older jobs

`scripts/lib/bridge-compat.mjs` reads every supported version into one internal
layout, the v2 field layout:

- `toInternalRequest(doc)` maps a 1.x request to a Codex origin, a Claude worker
  and the Codex read-only verifier. `claudeSessionId` becomes `workerSessionId`,
  and `effectiveClaudePermissionArgs` becomes `effectiveWorkerArgs`.
- `toInternalResult(doc)` does the same for results.
- `schemaVersion` keeps the persisted version. A 1.x job already in flight
  therefore finishes under 1.x semantics.
- The conversion is lossless: every 1.x fixture converts back unchanged with
  `toV1Request` and `toV1Result`. A document that 1.x cannot express is
  refused, never truncated.

### The host profile

`host` is a new profile for schemaVersion 2 requests. It passes nothing that
would override the host's own configuration:

| Profile | The profile passes to a Claude worker or verifier | The profile passes to a Codex worker or verifier |
|---|---|---|
| `host` | No permission or setting-source flag | No sandbox or approval parameter |
| `review-readonly` | The read-only argument set | `sandbox: "read-only"` |
| `standard` | `--permission-mode default` | Not available |
| `trusted-autonomous` | `--permission-mode bypassPermissions` | `sandbox: "danger-full-access"`, `approvalPolicy: "never"` |
| `sandbox-autonomous` | Unavailable | Unavailable |

A model or an effort is sent only when routing resolved one; otherwise the
host's own configuration chooses them. Read-only access comes only from an
explicit `review-readonly`. Requests built without a `schemaVersion` are still
1.x requests, and `host` is not a 1.x profile.

### The config file

The bridge reads an optional JSON file from the first of these that applies:

1. `CODEX_CLAUDE_CONFIG`, which must be an absolute path;
2. `$XDG_CONFIG_HOME/codex-claude/config.json`, when `XDG_CONFIG_HOME` is
   absolute;
3. `~/.config/codex-claude/config.json`.

A missing file changes nothing. A present file must match
`schemas/bridge-config.schema.json`; otherwise loading fails closed with
`config_path_not_absolute` (a relative `CODEX_CLAUDE_CONFIG`),
`config_unreadable`, `config_invalid_json` or `config_invalid`. Older versions do
not read this file. Example:

```json
{
  "schemaVersion": 1,
  "defaults": { "profile": "host", "workerFamily": "claude", "maxRepairs": 1, "overagePolicy": "stop" },
  "reviewLanePolicy": "host",
  "presets": { "reviewer": { "profile": "review-readonly" } },
  "routing": { "review": { "family": "codex", "model": null, "effort": "high" } },
  "extensions": ["/path/to/extension.mjs"]
}
```

- `defaults.profile` cannot be `sandbox-autonomous`. `overagePolicy` accepts only
  `stop`: the bridge never continues into overage billing.
- `reviewLanePolicy` is `host`, `review-readonly`, `standard` or `null` (1.x
  behaviour); it never grants `trusted-autonomous`.
- `routing` maps a task family to a worker family, a model and an effort. A
  field left out, or `null`, is left to the host configuration.

Routing resolves in this order: the config entry for the task family supplies
the initial values; then the first extension whose `resolveRouting` answers
overrides, field by field, the fields its answer names, and the other fields keep
the config values; with neither a config entry nor an answer, the host decides
and the bridge sends no model or effort. When live Codex model discovery is
available, a routed effort that the model does not list in
`supportedReasoningEfforts` is dropped, with an `effort-unsupported` warning.

### Extensions

An extension is a local module named by absolute path in `extensions`. Its
default export is `{ apiVersion: 1, name, ...hooks }`:

| Hook | Called with | Returns | On failure |
|---|---|---|---|
| `resolveRouting` | `{ request, taskFamily, available }` | `{ family?, model?, effort?, reason }` or `null` | The job fails before launch (`extension-routing-failed`) |
| `validateResolvedModel` | `{ family, model, phase }` | `{ ok, reason? }` | `ok: false` or a throw fails closed |
| `selectAccount` | `{ family, request, rateLimit }` | `{ env: { CLAUDE_CONFIG_DIR?, CODEX_HOME? }, label }` or `null` | Any other key, or a relative path, is refused (`extension-account-invalid`) |
| `gates` | `{ request, result, workspace }` | `[{ name, argv, cwd, timeoutSeconds }]` | An invalid gate fails verification setup (`extension-gate-invalid`) |
| `observe` | `event` | nothing | Reported and ignored; never fatal |

Loading fails closed with `extension-load-failed` for a relative or missing
path, a failed import, a wrong `apiVersion`, a missing name, an unknown key or a
duplicate name. The loader records each file's sha256. A recovered job imports
the file again and reports any digest change, so changed code never runs
unnoticed. Extensions carry the same trust as the command-line tool itself.

### Rollback

A release that reads only schemaVersion 1 cannot run a v2 job. Before
downgrading, settle or cancel the non-terminal v2 jobs (`codex-claude list
--json`, then `codex-claude cancel <id>`). 1.x jobs stay readable by every
version, and older versions ignore the config file.
