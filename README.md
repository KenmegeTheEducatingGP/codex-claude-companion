# Codex-Claude Bridge

[![CI](https://github.com/Kenmege/codex-claude-companion/actions/workflows/pull-request-ci.yml/badge.svg)](https://github.com/Kenmege/codex-claude-companion/actions/workflows/pull-request-ci.yml)
[![CodeQL](https://github.com/Kenmege/codex-claude-companion/actions/workflows/codeql.yml/badge.svg)](https://github.com/Kenmege/codex-claude-companion/actions/workflows/codeql.yml)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/15660/badge)](https://www.bestpractices.dev/projects/15660)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.18-brightgreen.svg)](#requirements)

> A durable Codex-to-Claude control plane with tmux process ownership, recovery,
> collaboration, result delivery, and independent verification.

> **Delegate to Claude from Codex, keep control, and get verified work back.**

**Identity:** this is an independent community project by Kennedy Umege. It is
not affiliated with or endorsed by OpenAI or Anthropic. OpenAI's
`openai/codex-plugin-cc` is a Claude Code plugin that invokes Codex; this project
runs in the opposite direction, letting Codex supervise durable Claude workers.
This project was renamed from `codex-plugin-cc` to `codex-claude-companion` to
avoid confusion with OpenAI's plugin of that name; the legacy `codex-plugin-cc`
npm package is deprecated and forwards here. See
[the identity and migration contract](docs/bridge-migration.md).

The bridge keeps the originating Codex task responsive while a Claude worker is
owned by a named tmux session. A detached local broker records heartbeats,
leases, ordered collaboration messages, recovery state, delivery acknowledgement,
and verification evidence. When a delegation finishes, the bridge runs the
origin-supplied verification command as a bounded local subprocess with a
secret-stripped environment. A separate ephemeral, read-only Codex process
then independently reviews the recorded outcome; it does not hardcode a GPT
model.

The package has three explicit surfaces: the durable bridge, a legacy writable
Claude workspace, and isolated read-only review lanes. Reviews can use Claude Code's
current Opus alias, including the Opus 1M long-context alias, with `Read`,
`Glob`, `Grep`, Task sub-agents, and domain-fenced web access. They do not get
`Edit`, `Write`, Bash, raw shell, or repository-controlled Claude settings by
default. Every elite-tier finding must cite tool-call evidence, and malformed
structured output fails closed.

## Review automation (maintainer)

- **Copilot automatic code review** is enabled on `main` (including draft PRs) via the repository ruleset *Automatic Copilot code review*.
- **Human review is required.** `main` needs an approving code-owner review, and automated reviewers (Copilot, CodeRabbit, Codex, Devin) may comment or approve, but only a code owner's approval satisfies that requirement. Pull requests are reviewed by a second party: `@Kenmege` and `@kenmege-claude` (Kennedy's machine account for Claude) co-own general paths and never approve their own pull requests, while workflow, release and security paths need `@Kenmege`'s review. See [`.github/CODEOWNERS`](https://github.com/Kenmege/codex-claude-companion/blob/main/.github/CODEOWNERS).
- **CodeRabbit** is configured in [`.coderabbit.yaml`](https://github.com/Kenmege/codex-claude-companion/blob/main/.coderabbit.yaml).

## 60-Second Quickstart

`codex-claude-companion@1.2.0` is the current stable release on npm
dist-tag `latest`. Install the stable bridge:

```bash
npm install -g codex-claude-companion
codex-claude enable
codex-claude doctor
codex-claude bridge-doctor --json
```

Or pin this release explicitly:

```bash
npm install -g codex-claude-companion@1.2.0
codex-claude enable
codex-claude doctor
codex-claude bridge-doctor --json
```

`codex-plugin-cc@1.1.1` was the last stable release before the durable bridge.
Upgrading from `1.2.0-rc.1` automatically migrates the job-state index once;
jobs from older versions keep their summaries. Both executable names remain
supported. See [the release notes](https://github.com/Kenmege/codex-claude-companion/blob/v1.2.0/RELEASE_NOTES_v1.2.0.md).

For source development or an unpublished-commit test:

```bash
git clone https://github.com/Kenmege/codex-claude-companion.git
cd codex-claude-companion
npm install -g .
codex-claude enable
codex-claude doctor
```

`enable` registers the plugin with Codex. On current Codex CLI versions it
uses `codex plugin marketplace add` + `codex plugin add` through a local wrapper
marketplace; on older runtimes or custom `--config` paths it falls back to the
legacy TOML stanza writer. Run it once after install; it is idempotent. Restart
Codex CLI after running it. `doctor` checks Node, Git, Claude Code CLI/version
(minimum `2.1.183` for the default `opus` / `xhigh` review profile), Claude
auth, Codex registration, job storage, non-Git folder support, and optional live
Claude runtime access with `--probe-runtime`.

Delegate a durable coding job from a Codex task. The verification command is a
JSON argv array supplied by the origin, not shell text interpreted by the worker:

```bash
codex-claude delegate \
  --thread-id "$CODEX_THREAD_ID" \
  --profile trusted-autonomous \
  --verify-command '["npm","test"]' \
  -- "implement the requested change and report validation evidence"
codex-claude list --json
codex-claude wait <ccb_job-id>
codex-claude logs <ccb_job-id>
codex-claude send <ccb_job-id> --message "Focus on the failing integration test"
codex-claude recover <ccb_job-id>
codex-claude gc                         # bounded dry run
codex-claude gc --older-than-days 30 --apply
```

The write-capable quickstart selects `trusted-autonomous` explicitly. It runs
Claude with `bypassPermissions` on the same user account so the detached worker
can execute the implementation without interactive permission prompts. Omit
that option to keep the default `standard` profile, which is appropriate for
non-writing headless work.

`delegate --wait` and `wait` use stable orchestration exit codes: `0` means the
worker completed, independent verification passed, and origin delivery was
acknowledged; `3` means the terminal job failed or did not satisfy verification
and delivery; `4` means Claude has a pending question that needs a reply. A wait
timeout is an operational error and exits nonzero with a diagnostic.

`send` provides live same-session steering only while the authoritative Claude
worker is still running. The first authoritative result closes that input
window so verification and delivery can begin. Without `--wait`, exit `0` means
the message was durably queued, not that Claude observed it; with `--wait`, exit
`0` requires a replay acknowledgement from that session. Use a new or resumed
job for follow-up work after the worker becomes terminal.

`CODEX_THREAD_ID` may supply `--thread-id`. The bridge also supports `status`,
`cancel`, and `attach` for `ccb_...` job IDs. `trusted-autonomous` is an explicit
same-user host-trust mode that uses Claude's `bypassPermissions`; it is not an OS
sandbox. `sandbox-autonomous` remains unavailable until independently proven
containment exists.

The older workspace lane remains available for compatibility:

```bash
codex-claude workspace --path . -- "implement the requested change and run tests"
codex-claude workspace-status --path . --all --json
codex-claude workspace-logs <session-id>
codex-claude workspace-stop <session-id>
```

The dispatch returns Claude Code's authoritative short session ID immediately;
it fails closed if Claude does not provide one, and a 30-second startup guard
terminates a stalled dispatch process tree. Use
`--no-panel` for focused follow-up workers and `--panel-only` to reopen the
control panel. Claude defaults to its rolling `opus` selector; pass `--model`
when a different Claude selector is required. Normal mode has native coding
capabilities and permission prompts; `--plan` is analysis-only. Coding requests
are delivered to Claude over stdin instead of the process argument list, and
privacy-safe lifecycle events exclude prompts and tool arguments.

`codex-claude-review` remains a fully supported compatibility alias for every
command, including the isolated read-only review lanes.

Every public subcommand accepts `--help` and `-h`. When used before an option
terminator (`--`), help is side-effect free: the helper prints static usage
without taking a directory snapshot, reading Claude credentials, creating
review or bridge state, starting tmux, or launching Claude/Codex. Malformed
inline help forms such as `--help=value` are rejected as usage errors before
dispatch.

Or run a read-only review from any git workspace:

```bash
codex-claude review
codex-claude review --preset ship --base main
codex-claude review --preset security --add-dir ../shared-libs
```

Codex slash commands are available once the plugin marketplace is loaded:
`/claude-review:delegate`, `/claude-review:wait`, `/claude-review:logs`,
`/claude-review:send`, `/claude-review:recover`, `/claude-review:bridge-doctor`,
`/claude-review:gc`, `/claude-review:list`, `/claude-review:attach`,
`/claude-review:workspace`, `/claude-review:review`,
`/claude-review:elite-review`, `/claude-review:deep-review`,
`/claude-review:security-review`, and `/claude-review:doctor`.

## Requirements

- Node.js 18.18 or newer.
- Git on `PATH`.
- tmux on `PATH` for durable bridge workers.
- Claude Code CLI authenticated locally for direct helper usage.
- Codex CLI with local plugin marketplace support for slash-command usage.

## Bridge, Workspace, And Review Lanes

| Lane | Purpose |
|---|---|
| `delegate` | Durable tmux-owned Claude worker with typed state, collaboration, recovery, delivery, and independent verification. |
| `workspace` | Writable Claude background worker with a separate control panel and active-session Codex supervision. |
| `review` | Quick agentic Claude review for everyday diffs. |
| `adversarial-review` | Skeptical challenge pass for risky changes. |
| `elite-review` | Exhaustive ship/no-ship review with systemic risks and blind spots. |
| `deep-review` | Opus max effort with parallel Task sub-agent investigation. |
| `security-review` | OWASP/CWE-focused review with exploitability classification. |

## Presets

Use presets when you want one command that chooses the right lane:

| Preset | Command | Use when |
|---|---|---|
| `quick` | `codex-claude review --preset quick` | Everyday review with high-signal findings. |
| `ship` | `codex-claude review --preset ship --base main` | Pre-merge ship/no-ship gate. Routes to the elite lane. |
| `security` | `codex-claude review --preset security` | Security review without remembering the dedicated command. |
| `research` | `codex-claude folder ./paper --preset research --long-context` | Evidence-heavy code, papers, notes, or research folders. |
| `deep` | `codex-claude review --preset deep --background` | Large or ambiguous tasks that need sub-agent investigation. |

## Why Trust The Boundary?

- Explicit bridge trust profiles: `standard` retains Claude-native prompts;
  `trusted-autonomous` is opt-in cooperative same-UID host trust, not isolation;
  and unsupported `sandbox-autonomous` requests fail closed.
- Durable authority separation: worker completion, result delivery,
  acknowledgement, and independent verification are distinct recorded states.
- Bounded verification: the origin supplies JSON argv verification commands,
  which run as bounded local subprocesses with a secret-stripped environment;
  a separate ephemeral Codex process with a read-only sandbox independently
  reviews their recorded outcomes.
- Read-only by default: `Edit`, `Write`, `NotebookEdit`, raw shell, and raw git
  are outside the safe-mode tool catalog.
- Prompt-injection resistant framing: diff, focus text, and workspace guidance
  are wrapped as untrusted data before Claude sees them.
- Fenced external access: `WebFetch` starts with a domain allowlist and expands
  only through explicit `--web-domain` flags.
- Fail-closed local inputs: snapshots require successful Git ignore discovery,
  run inside a private per-user namespace, preserve live sessions during
  cleanup, and exclude secret-bearing files by default.
- Strict release controls: pinned GitHub Actions, Node 18/20/22 CI, package
  content checks, tag/package version matching, and npmjs publishing with
  provenance attestation once the human publish gate is enabled.
- Runtime validation: structured review output is validated before rendering,
  including persisted background-job results.

This repository started from OpenAI's Apache-2.0 Codex plugin reference
preserved under `plugins/codex/`, and keeps that history. The runtime here is
deliberately reversed:

- upstream plugin: Claude Code -> Codex review/runtime
- this plugin: Codex -> Claude review/runtime

## Reviewer Composition

This repository dogfoods its own thesis: every pull request is designed for
review by four agents with distinct strengths.

| Reviewer | Trigger | Strength |
|---|---|---|
| **GitHub Copilot** | GitHub App / repository setting | breadth, fast, high-recall on style and obvious bugs |
| **Codex (OpenAI)** | installed GitHub App or `@codex` PR comment where configured | senior-engineer reasoning, forensic depth on architecture and release safety |
| **Devin (Cognition)** | installed GitHub App or `@devin` PR comment where configured | autonomous engineering; can implement fixes, not just review |
| **Claude (Anthropic Opus alias)** | `@claude` PR comment, plus automatic on PR open | adversarial code review, evidence-cited findings, schema-enforced output through this plugin |

This repository ships Claude automation in `.github/workflows/claude.yml`.
Copilot, Codex, and Devin reviewer behavior depends on the GitHub Apps and
repository settings installed on the target repository; forks must configure
those separately. Contributors should expect overlapping but complementary
feedback on the maintained repository.
Claude auto-review is skipped on untrusted fork PRs when GitHub withholds
repository Actions secrets; maintainers can still trigger a safe follow-up once
the PR is ready for deeper review.
Disagreements between reviewers are productive. The v0.2.x to v0.2.1
hardening of this plugin came from a Claude Opus plus OpenAI Codex
adversarial review pair where both returned independent NO_SHIP verdicts on
convergent control-plane issues.

## Detailed Capabilities

Five review lanes plus workspace and doctor lanes, all agentic by default:

- `/claude-review:workspace` — dispatch a writable Claude worker, open its
  native agent panel in another terminal, and keep the active Codex task in
  control for status polling, verification, review, and focused repairs.

- `/claude-review:review` — quick agentic Claude review (Opus alias, xhigh effort).
- `/claude-review:adversarial-review` — agentic skeptical challenge pass.
- `/claude-review:elite-review` — exhaustive single-agent ship/no-ship review
  with evidence-cited findings, systemic risks, blind spots, and exploration
  log.
- `/claude-review:deep-review` — Opus alias at `max` effort with parallel
  sub-agent dispatch (up to four `Task` sub-investigations per turn).
- `/claude-review:security-review` — security-focused agentic pass with
  OWASP/CWE mapping and exploitability classification.
- `/claude-review:doctor` — first-run diagnostics for installation and runtime
  readiness.

Plus the operational surface:

- `/claude-review:setup` — verify local Claude CLI readiness and report
  whether subscription auth is detected (which suppresses budget caps).
  Use `--json` for machine-parseable hook output.
- `codex-claude doctor` — first-run diagnostic for Node, Git, Claude,
  Codex registration, writable job storage, and optional live runtime probing.
- `/claude-review:status`, `/claude-review:result`, `/claude-review:cancel` —
  manage background review jobs.
- `codex-claude` — direct CLI fallback outside slash commands.
- Bundled Codex skill metadata (`skills/claude-review/SKILL.md`) lets current
  Codex plugin runtimes discover when to route natural-language review requests
  to the helper, not just explicit slash-command invocations.

## Agent Capabilities (safe-mode default)

Each review lane spawns a Claude session with a shell-free, fenced tool
catalog. Native workspace tools provide structured investigation without
exposing repository-defined shell permissions.

| Tool                          | Notes                                                                  |
|-------------------------------|------------------------------------------------------------------------|
| `Read`                        | Workspace-scoped file read with line ranges. Replaces `cat/head/tail`. |
| `Glob`                        | Workspace-scoped file pattern search. Replaces `find/ls`.              |
| `Grep`                        | Ripgrep-backed regex with structured matches. Replaces `grep/rg`.      |
| `Task`                        | Dispatch parallel sub-agents (deep-review may fan out 4-way).          |
| `WebSearch`                   | Web search (broad).                                                    |
| `WebFetch`                    | Default domain allowlist (vendor docs, NIST/CWE/OWASP, package         |
|                               | registries, NICE/BNF/BMJ/Lancet/NHS); extend with `--web-domain`.      |

`Edit`, `Write`, and `NotebookEdit` are explicitly disallowed, and `Bash` is
absent from both the safe tool catalog and permission rules. Persistent
user/project/local Claude settings are not loaded in safe mode. The bundled
`git-safe.mjs` remains a hardened standalone compatibility helper, but is not
exposed to safe review sessions. Runtime test execution remains the outer
Codex orchestrator's verification responsibility.

`--permission-mode` is whitelisted to `default` and `plan` only. Passing
anything else (`bypassPermissions`, `acceptEdits`, etc.) causes the helper
to refuse to launch the review.

The reviewer system prompt establishes a hard trust boundary: review
material is wrapped in `<untrusted_diff>` / `<untrusted_focus>` /
`<workspace_guidance>` tags and the agent is instructed to treat their
contents as data, never as instructions — defeating prompt-injection from
hostile diff content.

### Escape hatch

For workflows where the diff is fully trusted (your own branch on a private
repo) and you want raw shell access:

```bash
codex-claude review --unrestricted
```

`--unrestricted` switches the agent to the full default tool catalog
(including raw Bash) and emits a loud `WARNING: --unrestricted set. Trust
boundary disabled.` note in the rendered output and run log. **Never use
`--unrestricted` against an untrusted diff.**

## Default Profile

Quality-first reviews default to:

- model: `opus`
- effort: `xhigh`
- mode: agentic-safe (read-only fenced tools enabled)

Large review snapshots automatically switch to a long-context profile:

- model: `opus[1m]`
- effort: `xhigh`
- Claude Code accepts model aliases such as `opus` and `sonnet`, and the
  `[1m]` suffix selects the long-context variant where the user's Claude plan
  and model access support it.

Deep-review lane defaults:

- model: `opus`
- effort: `max`
- budget cap: `--max-budget-usd 25` *(only honored on api-key auth; on
  subscription auth the helper suppresses `--max-budget-usd` and surfaces a
  NOTE. Use `--timeout-ms` for a wall-clock cap.)*

`/claude-review:setup` now reports whether subscription auth is detected so
you know up-front whether the budget cap will apply.

## Two-Way Contracts, Host Profile, And Config File

The bridge contracts now have a schemaVersion 2 that describes delegation in
both directions: Codex to Claude, and Claude to Codex. The verifier is always
the other family. The command-line flags that use it arrive in a later change;
until then the commands keep writing the 1.x contracts, and every 1.x job stays
readable.

- **`host` profile.** For a schemaVersion 2 request, `host` passes no
  permission, sandbox or approval setting, so the host's own Claude or Codex
  configuration decides. Read-only access comes only from an explicit
  `review-readonly`.
- **Config file.** An optional `~/.config/codex-claude/config.json` (or
  `$XDG_CONFIG_HOME/codex-claude/config.json`, or the path in
  `CODEX_CLAUDE_CONFIG`) sets defaults, per-preset profiles and routing by task
  family. A missing file changes nothing, and an invalid one fails closed.
- **Extensions.** Local modules listed by absolute path in the config file can
  route models, check a resolved model, pick an account home, add required
  verification checks and observe events. An extension is one self-contained
  module (it may import `node:` modules only; a relative or package import fails
  when it loads). Loading fails closed, and each module's sha256 is recorded, so
  a recovered job reports a changed one.

See [the migration contract](docs/bridge-migration.md) for the profile table,
the config keys and the extension API.

## Install

### npmjs public install

Install from npmjs:

```bash
npm install -g codex-claude-companion
codex-claude enable
codex-claude doctor --probe-runtime
```

If you previously installed the historical scoped package or a source checkout
and npm reports `EEXIST` for `codex-claude-review`, remove the old global
package first:

```bash
npm uninstall -g @kenmege/codex-plugin-cc codex-plugin-cc
npm install -g codex-claude-companion
codex-claude enable
codex-claude doctor
```

### Source install

Install the helper binary:

```bash
npm install -g .
```

Or link it during development:

```bash
npm link
```

Then load the plugin in Codex from this repository root. The plugin manifest
is:

- `.codex-plugin/plugin.json`

The private Codex lane (this repo's local marketplace) should stay local-only:

```bash
codex plugin marketplace add <repo-root>
```

This loads `.agents/plugins/marketplace.json` as the
`claude-review-private` marketplace. That established key is retained only for
local-registration compatibility; the public product name is Codex-Claude
Bridge. Do not install the private lane from a GitHub URL unless intentionally
testing the public marketplace path.

### GitHub Packages historical install

v1.0.4 was also published under the historical GitHub Packages name
`@kenmege/codex-plugin-cc`. This is no longer the recommended public install
path because GitHub Packages npm installs require developer-machine auth.

```bash
echo "@kenmege:registry=https://npm.pkg.github.com" > ~/.npmrc
echo "//npm.pkg.github.com/:_authToken=YOUR_CLASSIC_PAT" >> ~/.npmrc
npm install -g @kenmege/codex-plugin-cc
```

Do not commit a token-bearing `.npmrc`.

## Direct CLI Usage

```bash
codex-claude doctor
codex-claude doctor --probe-runtime
codex-claude setup
codex-claude setup --json
codex-claude review
codex-claude review --preset ship --base main
codex-claude review --preset security
codex-claude folder ./paper --preset research --long-context
codex-claude review --preset deep --background
codex-claude review --base main
codex-claude adversarial-review --background look for migration risk
codex-claude elite-review focus on architecture and rollback
codex-claude deep-review --background --timeout-ms 1800000
codex-claude security-review --add-dir ../shared-libs --web-domain 'https://snyk.io/*'
codex-claude review --inherit-mcp --mcp-config /tmp/linear.mcp.json
codex-claude review --unrestricted   # trust boundary off, raw shell
codex-claude status
codex-claude result <job-id>
codex-claude cancel <job-id>
```

`setup --json` redacts local auth identity by default. It may still report
auth method, API provider, and subscription type so automation can distinguish
subscription auth from API-key auth without exposing the account address.

## Slash Commands

Once the plugin marketplace is loaded, these `/claude-review:*` commands are
available from inside a Codex CLI session. They are thin wrappers that invoke
the bundled `codex-claude` helper and return its output directly.

### Review commands

- `/claude-review:review` — Run an agentic Claude review (Opus alias by default)
  against the current git workspace.
- `/claude-review:elite-review` — Run an elite, high-scrutiny review.
- `/claude-review:deep-review` — Run a deep, multi-agent review (Opus alias, max
  effort).
- `/claude-review:adversarial-review` — Run a harder challenge review against the
  current workspace.
- `/claude-review:security-review` — Run a security-focused agentic review.

```text
/claude-review:review --preset ship --base main
/claude-review:adversarial-review --base main
```

### Job and setup commands

- `/claude-review:status` — Show running and recent review jobs for the current
  workspace.
- `/claude-review:result` — Show the stored final output for a finished job.
- `/claude-review:cancel` — Cancel an active background review job.
- `/claude-review:setup` — Verify that the local Claude review runtime is
  installed and authenticated.
- `/claude-review:enable` — Register the plugin in the local Codex CLI config.
- `/claude-review:doctor` — Diagnose installation, Claude auth, Codex
  registration, and runtime readiness.

## Flags

All review-like commands accept:

| Flag                          | Purpose                                                          |
|-------------------------------|------------------------------------------------------------------|
| `--background`                | Detach the review as a background job                            |
| `--base <ref>`                | Base ref for branch diff (default: auto-detect origin/main)      |
| `--scope auto\|working-tree\|branch\|directory` | Override scope detection                       |
| `--preset quick\|ship\|security\|research\|deep` | Choose a role workflow                          |
| `--model <name>`              | Override the model (e.g., `opus[1m]` or a full Claude model name) |
| `--effort low\|medium\|high\|xhigh\|max` | Override effort                                       |
| `--profile quality\|long-context` | Force a profile                                              |
| `--long-context`              | Opt into Claude Code's Opus 1M long-context alias                |
| `--legacy`                    | Disable agentic mode (structured output only, no tool access)    |
| `--agentic`                   | Force agentic mode on (default for all lanes)                    |
| `--unrestricted`              | Disable the safe-mode tool fence (raw shell, loud banner).       |
| `--mcp-config <file-or-json>` | Attach an MCP server (repeatable)                                |
| `--inherit-mcp`               | Also inherit project/local MCPs (default off → strict-mcp on)   |
| `--max-budget-usd <n>`        | Cap review spend (api-key auth only; suppressed under subscription) |
| `--add-dir <path>`            | Grant tool access to extra directories (repeatable)              |
| `--web-domain <pattern>`      | Add a WebFetch allowlist entry (repeatable)                      |
| `--system-prompt-extra <s>`   | Append workspace-specific reviewer guidance                      |
| `--quiet`                     | Suppress non-essential rendered detail                           |
| `--debug`                     | Add diagnostic job-log lines                                     |
| `--permission-mode <mode>`    | One of: `default`, `plan` (others rejected)                      |
| `--timeout-ms <n>`            | Override review timeout (lane default: 30 minutes)               |

Setup accepts `--json` for machine-parseable readiness checks. Doctor accepts
`--json`, `--config <path>`, `--job-dir <path>`, and `--probe-runtime`.

## Runtime Hardening

- `--setting-sources=` excludes persistent user, project, and local Claude
  settings from safe reviews, preventing repository settings from restoring
  shell permissions or hooks. Unrestricted and setup flows retain their
  documented settings behavior.
- `--strict-mcp-config` is **on by default** so the agent's MCP tool surface
  is exactly the set the user passed via `--mcp-config`. Opt out with
  `--inherit-mcp`.
- `--no-session-persistence` keeps review sessions off-disk.
- `--exclude-dynamic-system-prompt-sections` improves cross-user prompt-cache
  reuse.
- `--include-partial-messages` so the streaming activity log captures
  tool-call telemetry, token counts, cost, and duration.
- Subscription auth detection (`isSubscriptionAuth`) automatically suppresses
  `--max-budget-usd` (which Claude only enforces on api-key auth) and surfaces
  a NOTE in rendered output, job logs, and invocation metadata explaining why
  the cap is not honored.
- The stream parser tracks malformed JSON line count, exposes it under
  `activity.parseErrors`, and fails closed when no structured output can be
  recovered.
- Structured output is validated again after parsing. Missing arrays,
  malformed rich findings, or empty agentic evidence fail the job before
  rendering.
- `--add-dir` resolves symlinks with `realpath`, rejects filesystem root,
  unreadable paths, non-directories, and paths outside the allowed boundary
  before Claude starts.
  The default boundary is the parent of the workspace root; set
  `CODEX_CLAUDE_ADD_DIR_BOUNDARY=/absolute/path` to tighten or intentionally
  extend that boundary for a trusted monorepo layout.
- `--mcp-config` values are parsed as JSON and checked for MCP server
  structure before they are passed to Claude.
- Foreground Claude calls are launched with timeout/interruption handling; a
  timeout kills the spawned process tree and marks the job failed.
- `setup` performs a live non-interactive structured-output probe instead of
  trusting `claude auth status` alone.

`elite-review`, `deep-review`, and `security-review` use a richer agentic
schema (`schemas/agentic-review-output.schema.json`) that **schema-enforces**
`evidence` as `minItems: 1` per finding, `minLength: 1` on every string
field. The agent cannot emit empty evidence and pass validation.

After schema validation, every finding's `evidence[].tool` is cross-checked
against the actual tool-use stream observed in this run via
`crossCheckEvidenceAgainstStream`. Citations whose tool name does not match
any observed call are flagged with a `⚠ Evidence cross-check` annotation in
the rendered output and counted in the aggregate. The check is lenient —
findings are not deleted or downgraded, since tools invoked inside `Task`
sub-agent calls do not appear in the parent stream and a citation may
legitimately reference one of those. The annotation is a "treat as a
fabrication-or-subagent signal" prompt for the operator, not a hard failure.

## Workspace State

Per-workspace review state is stored under:

- `.claude-review/jobs/*.job.json`
- `.claude-review/jobs/*.input.json`
- `.claude-review/jobs/*.log`

Background jobs survive across Codex turns without polluting global state.
The `.claude-review/` directory is excluded from review snapshots so review
artefacts do not feed back into themselves.

Pass `--job-dir <path>` (or set `CODEX_CLAUDE_REVIEW_JOB_DIR`) to keep every
job record, immutable input, prompt, and log in an alternate directory. Reuse
the same option with `status`, `result`, and `cancel`. Job IDs accept only
1–128 ASCII letters, digits, underscores, and hyphens.

Directory snapshots live under the versioned, privately owned
`~/.claude-review/snapshots/` namespace by default. Pass
`--snapshot-temp-root <path>` to select another isolated root.
Stale cleanup validates the namespace and snapshot metadata, preserves workers
whose owner PID is still live, atomically claims dead snapshots, and never
scans or deletes similarly named directories outside that namespace.

Job records are versioned with `schemaVersion: 1`, created with exclusive file
creation, and updated with atomic writes. `status` marks long-running jobs as
`stalled` when their timeout window has elapsed.

## Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Clean command or review with no ship-blocking findings |
| `1` | Operational/runtime error |
| `2` | Invalid usage or validation error |
| `3` | Review found ship blockers, or bridge wait reached terminal non-success/failed verification or delivery |
| `4` | Bridge wait stopped for a pending Claude question while the worker remains nonterminal |

The same gating contract applies when a review is run in the background:
`codex-claude result <job-id>` re-validates the persisted result and
exits `3` when the completed job contains ship-blocking findings.

For `codex-claude wait` and `codex-claude delegate --wait`, exit `0` has the
narrower orchestration meaning documented above: completed worker, passed
independent verification, and acknowledged origin delivery. Other subcommands
retain their command-specific contracts; for example, `bridge-doctor` can use
exit `2` when the runtime is not ready.

## Supported Platforms

Supported and tested development platforms are macOS and Linux with Node.js
18.18 or newer. Windows is not a supported v1 platform because process-tree
termination and shell/tool semantics have not been verified there. Run
`codex-claude doctor --probe-runtime` on a new machine before trusting a
release gate there, because Claude Code runtime behavior and local auth state
still depend on the host environment.

## Development

```bash
npm run lint
npm test
npm run check
npm run pack:check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how changes are tested and reviewed.
Report bugs and request features in the
[issue tracker](https://github.com/Kenmege/codex-claude-companion/issues);
report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

The npm package intentionally omits `package.json.private` so npmjs publishing
can run when explicitly enabled. The release workflow validates tags and only
publishes when repository variable `NPMJS_PUBLISH_ENABLED=true` and the npm
trusted publisher for the `Kenmege/codex-claude-companion` `release.yml` workflow is
configured. GitHub OIDC supplies short-lived publishing access; the workflow
does not use a long-lived npm publishing secret. Release tags must match the
package version exactly:
`package.json` version `X.Y.Z` is published only from tag `vX.Y.Z`; a
prerelease smoke must first commit matching `X.Y.Z-rc.1` metadata before
pushing tag `vX.Y.Z-rc.1`.

## Repository Layout

```text
.codex-plugin/plugin.json
commands/
  delegate.md
  wait.md
  logs.md
  recover.md
  gc.md
  list.md
  attach.md
  send.md
  bridge-doctor.md
  review.md
  adversarial-review.md
  elite-review.md
  deep-review.md
  security-review.md
  setup.md
  status.md
  result.md
  cancel.md
docs/plans/
schemas/
  bridge-delegation-request.schema.json
  bridge-event.schema.json
  bridge-message-operation.schema.json
  bridge-result.schema.json
  bridge-receipt.schema.json
  bridge-config.schema.json
  review-output.schema.json
  elite-review-output.schema.json
  agentic-review-output.schema.json
scripts/
  claude-review-companion.mjs
  bridge-broker.mjs
  bin/
    git-safe.mjs
  lib/
    args.mjs
    claude.mjs
    git.mjs
    process.mjs
    render.mjs
    state.mjs
    workspace.mjs
test/
```

The Claude Code plugin subtree under `plugins/codex/` now supplies the packaged
Codex delivery adapter used by the durable bridge; it is no longer
reference-only. Its Codex prompt guidance tracks the current OpenAI model family:
`gpt-5.5` for complex coding/research work, `gpt-5.4-mini` for lighter
subtasks, and the `spark` shortcut for `gpt-5.3-codex-spark` preview runs when
that model is available to the user.
