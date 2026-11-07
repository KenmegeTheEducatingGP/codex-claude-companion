# Changelog

All notable changes to this project are documented in this file.

The format follows Keep a Changelog and this project uses Semantic Versioning.

## [Unreleased]

### Added

- `npm run test:coverage` runs the full suite with Node's built-in coverage
  (including code run in spawned child processes) and prints a line, branch and
  function summary for the shipped source; CI publishes it on the Linux Node 22
  job. The reporter is development-only and not part of the npm package.

### Fixed

- Bridge delivery no longer rewrites the origin Codex thread's permissions. The
  bundled Codex client sent `sandbox: "read-only"` and `approvalPolicy: "never"`
  on every thread start and resume, and the app-server keeps such overrides in
  the thread, so each delivery downgraded the origin for good. Both keys are now
  sent only when the caller chose a value, and the user's Codex configuration
  decides otherwise. The bundled plugin's native review, adversarial review and
  `task` without `--write` no longer force read-only; `--write` still requests
  `workspace-write`.
- Delivery to a live origin. While the origin session runs `codex-claude wait`,
  its thread has an active writer and a resume from the broker fails. The
  origin's own `wait` now holds a waiter lease and receives the result itself,
  exiting `0` for verified work. With a busy origin and no waiter, the result is
  queued as `origin-busy` without spending the 64-attempt inbox quota, the
  broker exits instead of retrying, and the origin's next `wait`, `status` or
  `delegate` prints it and acknowledges it once its output was written; a command
  that times out, fails, is interrupted or cannot write its output first leaves
  the result queued, and a failed write records `origin-output-failed` without
  spending the quota. The origin's plain-text `wait` prints the result it
  delivers, not only `--json`. `status --json` shows `deliveryQueue` and
  `lastError`; the v1 receipt keeps `delivery.state: "pending"` while a result is
  queued or claimed, and the delivering command prints it before its write is
  confirmed.
- Workers and the independent verifier now receive `CLAUDE_CONFIG_DIR` and
  `CODEX_HOME` when they are set, so they run under the caller's Claude and Codex
  homes instead of the defaults. The runner identity records only the home
  directory names.
- The broker refuses a broker spec whose `schemaVersion` it does not support,
  with an error that names the supported versions, instead of running it.

## [1.2.0] — 2026-10-18

### Changed

- Renamed the canonical npm package and repository to `codex-claude-companion`.
  Both `codex-claude` and `codex-claude-review` executable names, the
  `claude-review` plugin ID, and existing state paths remain compatible. The
  legacy `codex-plugin-cc` shim remains an inert scaffold pending its coordinated
  publication.
- Released the durable bridge on the stable release channel as
  `codex-claude-companion@1.2.0` on npm dist-tag `latest`; prereleases continue
  to select `next`.

### Fixed

- A background Codex task no longer stays `queued` forever when its worker
  starts before the launcher has saved the task request: the request is now
  saved before the worker starts, and the worker records its own process id
  and progress.
- Durable steering messages and acknowledgements now validate content hashes
  and identity, publish atomically, and recover interrupted writes. Worker
  input/output failures terminate the worker instead of being silently ignored.
- Worker prompt and environment files are read through bounded private file
  descriptors; consumed environment files are claimed before removal.
- The independent verifier inherits an explicit environment allowlist, redacts
  captured verification output before persistence, escalates timed-out checks,
  and rejects a passing verdict without evidence.
- Legacy cancellation and session-end cleanup verify process identity before
  killing workers, protecting unrelated processes when a PID is reused.
- State writes sync staged files and parent directories for crash durability.
- Cancelling a running Codex task no longer fails with `Unexpected end of JSON
  input` when the background worker is rewriting the job record at that moment:
  job records and the broker session file are now replaced atomically, like the
  state snapshot already was.
- Codex task logs no longer lose a subagent's name when Codex announces the
  subagent before the `turn/start` response is processed: buffered thread
  announcements are now applied like live ones instead of being forwarded away,
  so the log says `Starting subagent design-challenger …` rather than the raw
  thread id.
- `npm test` no longer leaves hundreds of directories in the system temp
  directory on every run: `scripts/run-tests.mjs` runs `node --test` inside a
  private temporary root (`TMPDIR`/`TMP`/`TEMP`) and removes it however the run
  ends, which also isolates temp files created by the code under test and its
  child processes. Discovery is still Node's own `node --test`.
- The stalled-dispatch workspace test no longer fails under load: its 25 ms
  SIGTERM grace expired before the child's exit was observed, escalating to
  `ETIMEDOUT_KILL`; a 500 ms grace keeps the SIGTERM path deterministic.
- `--help` and `-h` on any `codex-claude` subcommand now print that command's
  usage and exit without side effects. Previously `codex-claude review --help`
  treated `--help` as focus text and ran a real review.
- Claude workspace workers write their first heartbeat immediately, so a child
  that exits before the first heartbeat interval still leaves one.
- Codex turn capture no longer adopts an unrelated thread announced on the same
  app-server connection. Events for a thread whose ownership is not yet known
  are held in a bounded buffer and replayed in order once it is.
- A job can no longer be reported both cancelled and completed when cancellation
  and completion race. The first terminal state is published once, through an
  exclusive hard link, and every later writer adopts it. A task cancelled before
  it starts no longer runs, and cancelling during startup aborts the Codex turn.
- Concurrent updates to different jobs no longer erase each other. The job list
  is now read from the per-job records, and `state.json` keeps only
  configuration. An existing job list is migrated once, keeping completion
  summaries, and finished jobs from older versions stay subject to retention.
- Cancelling by an exact job id always selects that job, even when the id is a
  prefix of another active job's id.
- Job ids are validated before any file path is built from them.
- One unreadable job record no longer makes every job command fail; it is
  skipped with a warning.
- On Windows, replacing a job record that another process is reading no longer
  fails with `EPERM` (the replacement is retried briefly), and `git` is no
  longer started through the user's shell, which made every job update slow.
- Inline option values keep everything after the first `=`, so
  `--cwd=/work/a=b` passes `/work/a=b` instead of `/work/a`.
- Markdown status tables escape backslashes and flatten carriage returns and
  Unicode line separators, so a job summary can no longer break a table row.
- A job record whose summary is not a string (for example a hand-edited
  record) no longer makes `status`, `result` or `cancel` throw; the value is
  shown as JSON text.

## [1.2.0-rc.1] — 2026-07-19

### Added

- Added a durable Codex-to-Claude bridge with tmux-owned workers, typed state
  and message contracts, recovery controls, same-session steering, origin
  delivery, and independent Codex verification.
- Added bridge CLI and slash-command surfaces for delegation, waiting, logs,
  messaging, recovery, listing, attachment, and runtime diagnostics.
- Added explicit trust profiles and fail-closed workspace, capability-token,
  lease, verification-command, and delivery boundaries.

### Changed

- The packaged `plugins/codex/` subtree now provides the production Codex
  delivery adapter instead of serving only as reference material.
- npm package-closure tests now exercise the bridge broker and packaged Codex
  adapter from an extracted tarball.
- Prerelease publication now uses the npm `next` dist-tag, preserving the
  stable `latest` install until the release candidate is promoted.
- Modified OpenAI-derived files now carry explicit Apache-2.0 modification
  notices alongside the retained licenses and notices.

### Fixed

- Detached Codex app-server brokers are now reaped reliably and test fixtures
  tear down spawned brokers, preventing stale-process leaks after the suite.

## [1.1.1] — 2026-07-11

### Changed

- Trusted npm publishing now runs only from the actual release tag, binding the
  OIDC workflow identity and generated provenance to the immutable tag ref.
- Manual release recovery must be dispatched from that same tag; recovery from
  the default branch is rejected before checkout or publication.

### Fixed

- Corrected the release workflow identity mismatch that caused v1.1.0's SLSA
  provenance to name `refs/heads/main` instead of its release tag.

## [1.1.0] — 2026-07-11

### Added

- Added a split-terminal `workspace` lane that dispatches full Claude coding
  workers in the background, opens Claude's native agent panel separately, and
  returns Claude Code's authoritative short session ID to the still-active
  Codex task.
- Added `workspace-status`, `workspace-logs`, and `workspace-stop` controls for
  Codex-led monitoring and repair loops.
- Added `--no-panel`, `--panel-only`, `--plan`, `--model`, and privacy-safe
  `--json-events` workspace controls.
- Added Windows Node 18.18 CI and packed-tarball install smoke coverage for the
  primary `codex-claude` executable and the compatibility alias.

### Changed

- The active Codex task now exclusively owns GPT-side orchestration and review;
  the workspace lane no longer blocks the invoking terminal or starts nested
  Codex processes.
- `codex-claude` is now the primary executable in help and launch guidance;
  `codex-claude-review` remains a supported compatibility alias.
- Workspace request examples use an explicit `--` option terminator so coding
  text cannot be reinterpreted as privileged CLI options.
- Workspace requests are transported to Claude over stdin so coding text is not
  exposed through the helper's process argument list.
- MCP configuration inputs are consumed from bounded opened descriptors and
  staged in private exclusive files before Claude starts.
- Directory snapshots now default to the private per-user
  `~/.claude-review/snapshots/` namespace, while `--snapshot-temp-root` remains
  available for an explicitly isolated override.
- Test discovery now uses Node's shell-independent `node --test` entry point.

### Fixed

- Workspace dispatch now parses the native Claude background receipt and fails
  closed when no controllable session ID is returned instead of manufacturing
  an unrelated identifier.
- Workspace dispatch now has a 30-second startup bound and terminates the
  process tree if Claude's native background handoff stalls.
- One-shot terminal launchers are created in private directories with exclusive
  permissions and remove themselves before opening the Claude agent panel.
- Snapshot secret matching is case-insensitive, repository paths are parsed as
  NUL-delimited data, and repository validation supports spaces and Unicode.
- Directory snapshots now fail closed if Git ignore discovery fails, rather
  than risking a copy that omits repository ignore rules.
- The read-only Git wrapper rejects external config, include, contents,
  exclude, and pathspec-file inputs, including attached short-option forms.
- Job-state locking now uses an immutable per-contender ticket queue, recovers
  abandoned or aged malformed contenders, and has no shared owner pathname for
  a third process to replace during stale-owner recovery.
- Value-taking CLI options fail closed on missing or option-like separate
  values; leading-hyphen values remain available through `--name=<value>`.
- Tokens following the workspace `--` terminator are preserved as coding data,
  including requests that begin with a hyphen.
- Review focus text beginning with option-like strings remains untrusted prompt
  data and cannot activate unrestricted mode, MCP inheritance, extra
  directories, or a permission-mode change.
- Safe review sessions are now shell-free and load no persistent
  user/project/local Claude settings, preventing repository configuration from
  restoring Bash permissions or hooks.
- Snapshot cleanup is confined to a versioned private ownership namespace,
  validates snapshot identity, preserves live worker PIDs, and atomically
  claims dead snapshots before removal.
- Version bumps now use fsynced staged replacements and a durable recovery
  journal. Canonical manifests are never renamed away, abrupt exits recover on
  the next invocation, and concurrent user edits are preserved.
- Process capture now stops retaining bytes at its configured ceiling while a
  noisy child is terminating, preventing post-limit memory growth.
- Job identifiers use a strict portable grammar at every artifact boundary,
  blocking absolute, relative, and separator-based path traversal.
- Explicit `--job-dir` storage is propagated through foreground reviews,
  detached workers, diagnostics, status, result, and cancel operations.
- Persistent job state fails closed when both the project and per-user paths
  are unwritable instead of silently falling back to a shared OS temp path.
- Security-sensitive file readers open descriptors before validating path
  identity, eliminating check-then-open races while retaining symlink and
  source-root containment checks.

## [1.0.14] — 2026-06-08

### Added

- Added bundled Codex skill metadata for natural-language routing into Claude
  review workflows on current Codex plugin runtimes.

### Changed

- `codex-claude-review enable` now prefers the native Codex plugin CLI
  installation flow through a local wrapper marketplace, while preserving the
  legacy TOML writer for older Codex runtimes and explicit `--config` paths.
- `codex-claude-review doctor` now reports the detected Claude Code CLI version,
  flags stale Claude Code CLI versions below 2.1.183, and recognizes native
  Codex plugin CLI installs.
- Documented the Claude Code 2.1.183 alignment decision to keep review lanes on
  explicit read-only `default`/`plan` permission modes rather than opting into
  auto mode.
- Refreshed the pinned `anthropics/claude-code-action` workflow reference to
  v1.0.152.
- Expanded `npm test` and CI coverage to include both legacy `test/` and bundled
  Codex companion `tests/` suites.
- Recentered the README around the core product promise: Codex delegates review
  work to an elite Claude reviewer for evidence-cited ship/no-ship feedback.
- Updated Claude review defaults and documentation from fixed versioned model
  IDs to Claude Code's `opus` and `opus[1m]` aliases, with `xhigh` effort for
  quality-first reviews.
- Clarified that bundled `/codex:*` commands are companion plumbing for setup,
  status, and task delegation, while `/claude-review:*` remains the primary
  review surface.
- Updated the Codex rescue forwarding guidance to `gpt-5-5-prompting`,
  preserving the thin-forwarder boundary.

### Fixed

- Kept the protected README command documentation aligned with the Codex
  companion command tests, including explicit model/effort forwarding examples
  and adversarial-review target-selection wording.

## [1.0.13] — 2026-05-13

### Changed

- Corrected public upstream attribution to reference OpenAI's Apache-2.0 Codex
  plugin reference preserved under `plugins/codex/`.
- Replaced launch-adjacent fixed version placeholders with generic commands so
  release docs do not carry stale example versions.

### Fixed

- Added a release-docs regression check preventing the incorrect upstream repo
  reference from returning.

## [1.0.12] — 2026-05-13

### Changed

- Documented the child-process helper's controlled command boundary for CodeQL.
- Adjusted release-docs assertions so CodeQL no longer treats the registry-host
  string check as URL substring sanitization.

## [1.0.11] — 2026-05-13

### Changed

- Reduced release workflow default token permissions to read-only and grants
  write/provenance permissions only to the release job.
- Focused CodeQL on the shipped npm package and GitHub Actions trust boundary.
- Hardened child-process execution helpers by resolving executable names before
  spawning with caller-supplied environment variables.

### Fixed

- Removed CodeQL file-race findings in MCP config and review-file reads by
  reading from the same opened file descriptor used for metadata checks.

## [1.0.10] — 2026-05-13

### Changed

- Removed the OpenSSF Scorecard badge from the README until the public score
  reflects the repository's intended trust posture.
- Updated the bug-report template to reference the public unscoped
  `codex-plugin-cc` package and current CLI version flow.

## [1.0.9] — 2026-05-13

### Changed

- Updated top-level NOTICE attribution to identify Kennedy Umege as the current
  package publisher while retaining OpenAI attribution for upstream-derived
  portions.
- Reframed the upstream Claude Code marketplace manifest so it no longer
  presents the Kenmege repository as OpenAI-owned.
- Replaced public unreleased-model-name claims with OpenAI Codex wording.
- Clarified that only Claude automation ships in this repository; Copilot,
  Codex, and Devin reviewer behavior depends on repository-installed GitHub
  Apps/settings.
- Added the GitHub Security Advisories URL to SECURITY.md.

### Fixed

- `codex-claude-review enable` now writes Codex config through a same-directory
  temp file plus atomic rename and creates a one-shot timestamped backup before
  modifying an existing config.

## [1.0.8] — 2026-05-13

### Changed

- Removed the plugin manifest `Write` capability so public metadata matches
  the default read-only reviewer trust boundary.
- Aligned README platform support with the architecture document: macOS and
  Linux are supported/tested for v1; Windows is not claimed until verified.

## [1.0.7] — 2026-05-13

### Changed

- Removed the remaining pre-publish wording from the deeper README install
  section now that npmjs is live.
- Added an explicit upgrade path for early users with the historical scoped
  package or source install who hit an `EEXIST` global binary collision.

## [1.0.6] — 2026-05-13

### Changed

- Removed stale pre-publish wording from the npm README after the public
  npmjs package went live, so first-time users see the global npm install as
  the canonical path and source install as a development fallback.

## [1.0.5] — 2026-05-13

### Added

- Added a frictionless public npmjs lane for the unscoped `codex-plugin-cc`
  package name, plus an approval-gated npm publish checklist. The previous
  GitHub Packages install path remains documented as historical/advanced
  because it requires developer-machine npm auth.
- Added `--preset quick|ship|security|research|deep` to route common user
  workflows to the right review lane without requiring users to memorize every
  command.
- Expanded `codex-claude-review doctor` with Node, Git, Claude CLI, Claude auth,
  Codex registration, writable job storage, non-Git folder readiness, and
  optional `--probe-runtime` model-access validation.
- Added launch assets: a two-minute terminal demo script and an X.com
  announcement draft that stays behind human approval.

### Changed

- Updated README installation guidance to lead with the future public npmjs
  path while clearly stating that npmjs publish must be verified before the
  command is advertised as live.
- Updated release workflow configuration from GitHub Packages publishing to
  npmjs publishing gated by `NPMJS_PUBLISH_ENABLED=true` and `NPM_TOKEN`.

## [1.0.4] — 2026-05-13

### Changed

- `.github/workflows/claude.yml`: bumped `--max-turns` from 35 to 80 on
  both auto-review steps (OAuth + API-key). PR #11's substantive M2
  implementation diff exhausted the 35-turn budget mid-review (the action
  surfaced `error_max_turns`), even though Codex on the same diff
  returned "no major issues." Interactive jobs stay at 10 turns — short
  Q&A doesn't need more, and the interactive lane has its own
  defense-in-depth (author_association gate + Bash fence + fork-PR
  resolution via `gh api`) so a longer budget there only enlarges the
  blast radius for prompt-injection without comparable benefit.

### Added

- Evidence cross-check (`crossCheckEvidenceAgainstStream`) closes M2 from
  the original adversarial review of v0.2.x: schema validation enforced
  `evidence: [{tool, query, confirmed}]` with non-empty strings, but the
  agent could fabricate the cited tool name entirely — the schema cannot
  check that the cited tool was actually invoked. The new function
  intersects each finding's `evidence[].tool` against the observed
  `toolUses` from the stream-event reducer and exposes per-finding
  `{verified, unverified, unverifiedTools}` plus an aggregate
  `findingsWithUnverifiedEvidence` count on the review result. The
  renderer surfaces a `⚠ Evidence cross-check` annotation on offending
  findings and a one-line aggregate at the bottom of the report. The
  check is lenient: findings are not deleted or severity-downgraded
  (sub-agent `Task` calls do not appear in the parent stream, so an
  unverified annotation can be a sub-agent signal rather than a
  fabrication). Operator judgment, not hard failure.
  - Tightened Bash-family equivalence post-Copilot review on PR #11:
    parametrized citations must match exactly (or against a bare-family
    observed). Pre-fix, any `Bash(...)` citation matched if any
    `Bash(...)` had been observed — hiding fabricated citations like
    `Bash(rm -rf /:*)` when the run only invoked the git-safe wrapper.
    Bare-family leniency remains for one-side-bare cases (cited `Bash`
    vs observed `Bash(...)`, or cited `Bash(...)` vs observed `Bash`).
  - Markdown fallback path now also returns the
    `evidenceVerification` field (zero-shape — no structured findings
    in the fallback) so the function's return shape is consistent
    regardless of whether the structured probe or the markdown
    fallback ran. Avoids consumer-side branching on
    `result.evidenceVerification == null` (Copilot review on PR #11).
- Supply-chain quality bundle for the public repo:
  - `.github/dependabot.yml` for weekly grouped npm + GitHub Actions
    version-updates. Security advisories flow individually (no
    `applies-to: security-updates` group is configured); GitHub's
    Dependabot docs note that a security-update group with no
    `patterns` matches every advisory, so one incompatible bump
    could block other security PRs in the same window — the
    grouping was removed (Codex review on PR #7, 2026-05-10).
    `target-branch` is intentionally NOT set: when explicit, it
    causes security updates to fall back to the default branch
    and ignore per-update-config options (Codex review on PR #7).
  - `.github/workflows/codeql.yml` running CodeQL `security-extended`
    on a matrix of `javascript-typescript` AND `actions` languages on
    every PR, every push to `main`, and weekly. The `actions` language
    covers `.github/workflows/*.yml` (workflow injection, permissions,
    SHA-pinning) — part of the supply-chain trust boundary the
    matrix is meant to defend (Codex review on PR #7). No `paths`
    filter: a path-filtered required check leaves non-matching PRs
    (e.g., README-only) permanently "Pending" since GitHub's docs
    are explicit that skipped-by-paths checks do not auto-pass.
    Results land in the Security tab and as inline PR annotations.
  - `.github/workflows/scorecard.yml` running OpenSSF Scorecard weekly
    and on push to `main`, with `publish_results: true` so the score is
    visible publicly via scorecard.dev and surfaced as a README badge.
    Workflow-level permissions narrowed from `read-all` to `contents:
    read` per Copilot review on PR #7; the `analysis` job already
    declares its full required scope (id-token, security-events,
    contents, actions) explicitly.
  - `.github/workflows/dependency-review.yml` blocking PRs that
    introduce moderate-or-higher CVEs in the npm dependency closure
    and denying AGPL licenses at the gate to protect Apache-2.0
    downstream consumers. `fail-on-scopes` is set to
    `runtime, development, unknown` so the gate covers the entire
    closure, not just runtime (the action's default is `runtime`
    only). Deny list includes both the current SPDX identifiers
    (`AGPL-*-only`, `AGPL-*-or-later`) AND the deprecated bare
    forms (`AGPL-1.0`, `AGPL-3.0`); SPDX still treats deprecated
    identifiers as valid, and npm metadata can contain legacy
    strings — without the bare forms a legacy AGPL dep would slip
    through (both refinements: Codex review on PR #7).
- Added CodeQL and OpenSSF Scorecard badges to the README badge row.
- Added public-launch community files: issue templates, PR template,
  CODEOWNERS, Code of Conduct, and v1.0.2 release notes.
- Added README launch hero, quickstart, CI/license/Node badges, and reviewer
  composition documentation.

### Fixed

- Fixed `codex-claude-review folder <path>` / `--scope directory` so directory
  snapshot reviews scan the copied snapshot contents directly instead of
  falling back to a no-op branch diff against the snapshot baseline.
- Directory snapshot reviews now use a separate 1 MB per-file review ceiling
  instead of the 24 KB untracked-file preview cap, and surface skipped
  oversized/binary files in the review context summary.
- Directory snapshots now exclude common secret-bearing files and source
  `.gitignore` matches before content is copied into the review prompt, and
  stale temp snapshots older than 24 hours are reaped on the next snapshot run.
- Raised default agentic timeout behavior so structured reviews can use the
  full review timeout by default, while no-output guards act as long stall
  detectors rather than short ceilings on real Opus work.
- Updated the documented and actual long-context profile from plain Sonnet
  4.6 to explicit `claude-opus-4-7[1m]`, matching current Claude Code docs:
  Opus 4.7 / Opus 4.6 / Sonnet 4.6 support 1M context, `[1m]` selects the
  1M variant, and availability varies by model and plan.
- Relaxed marketplace-name validation so forks can rename their private Codex
  marketplace without breaking `npm run check`.
- Hardened Claude review workflow auth selection so public fork PRs are skipped
  with a notice when GitHub withholds repository Actions secrets.

### Security

- `.github/workflows/claude.yml` hardening pass (PR #8, 2026-05-10),
  surfaced by an external review of the same workflow file when ported
  to a sister repo:
  - Added `Bash`, `BashOutput`, and `KillShell` to `--disallowedTools`
    on **both** the `auto-review` and `interactive` jobs. Closes a
    prompt-injection-to-secret-exfil vector where a crafted file in a
    PR diff could instruct Claude to `curl` the runner's
    `CLAUDE_CODE_OAUTH_TOKEN` out of the environment. The interactive
    fence was added in a follow-up commit on this same branch after a
    residual maintainer-on-fork-PR exfil path was identified mid-
    review (the env-level fork-head check cannot detect fork PRs from
    `issue_comment` events because the PR object is not in that
    payload). Cost is the occasional ability to ask Claude to run
    shell during interactive sessions; that capability is mostly
    covered by Pull Request CI anyway, and the token is the higher-
    value asset.
  - Restricted the `interactive` job trigger to OWNER, MEMBER, and
    COLLABORATOR `author_association` values across all four event
    types (`issue_comment`, `pull_request_review_comment`,
    `pull_request_review`, `issues`). The previous fork-PR guard
    used `github.event.pull_request`, which is null on `issue_comment`
    events on PR threads, so the guard failed open for the very case
    it was supposed to defend against (Copilot finding on PR #8). The
    fork-head check at the env level is retained as defense-in-depth
    for `pull_request_review*` events where the PR object is in the
    payload.
  - Skip Dependabot-authored `@claude` triggers in the `interactive`
    job (`sender.login != dependabot[bot]`). Maintainer `@claude`
    invocations on a Dependabot PR are intentionally allowed: a
    maintainer commenting `@claude` is a deliberate request for
    review, even when the PR author is Dependabot.
  - Skip Dependabot PRs in `auto-review`. Dependabot-triggered
    workflows do not receive repository Actions secrets by default,
    so the auth preflight always failed; routing around it cleanly
    avoids noisy red checks on dep-update PRs.
  - Deduplicated the OAuth and API-key prompt blocks via job-scoped
    env vars (`CLAUDE_AUTO_REVIEW_PROMPT` on `auto-review`,
    `CLAUDE_INTERACTIVE_PROMPT` on `interactive`) so future prompt
    edits only need to land in one place. Job-scope rather than
    workflow-scope means the auto-review prompt's interpolation of
    `github.event.pull_request.number` only fires for `pull_request`
    events (fix #6 from Copilot's second-pass review on PR #8).
  - Added `persist-credentials: false` to all `actions/checkout` steps
    so the default `GITHUB_TOKEN` is not left on disk inside the
    runner's `.git/config`.
  - **Reverted attempted F1**: an earlier commit on this branch
    removed workflow-level `id-token: write` under the assumption
    that no step uses OIDC. That was wrong:
    `anthropics/claude-code-action` itself exchanges an OIDC token
    for a GitHub installation token at runtime
    (`src/github/token.ts:138 setupGitHubToken`). Removing the scope
    causes the action to fail with `Could not fetch an OIDC token. Did
    you remember to add id-token: write to your workflow permissions?`
    (verified on PR #8 run 25627012564). The scope is restored with a
    comment block explaining why it is load-bearing.
  - **L1 fix (Codex review of PR #8)**: added `|| ''` defensiveness on
    `github.event.comment.body` references in the `issue_comment` and
    `pull_request_review_comment` arms of the `interactive` trigger
    gate, matching the pattern already used for `review.body` and
    `issue.body`/`issue.title`.
  - **INFO-1 fix (Codex review of PR #8)**: narrowed the `issues`
    trigger from `[opened, assigned]` to `[opened]`. The `assigned`
    action would re-fire the @claude trigger every time someone is
    assigned to an issue whose title or body contains @claude — a
    redundant trigger surface without added signal.
  - **Comment + notice cleanup (fixes #7 and #9 from Copilot's
    second-pass review on PR #8)**: removed the obsolete "interactive
    job has Bash permitted" wording from the trigger-gate comment
    block; rewrote the fork-PR skip notice to accurately describe
    *why* the guard exists (CLAUDE_CODE_OAUTH_TOKEN is in scope on
    `issue_comment` / `pull_request_review*` events; the guard skips
    so Claude is not run with token access against fork-controlled
    diff content). The previous notice incorrectly claimed secrets
    were withheld, which is the opposite of why the guard is needed.
  - **`--disallowedTools` argument format**: switched all four
    `--disallowedTools` invocations from comma-separated
    (`Edit,Write,...`) to space-separated multi-value
    (`Edit Write NotebookEdit Bash BashOutput KillShell`). Both
    forms are documented as supported by the Claude Code CLI, but
    the repo's own helper (`scripts/lib/claude.mjs:194-196`) builds
    the argv as `args.push("--disallowedTools", ...disallowedTools)`
    — i.e., one flag followed by individual tool values as separate
    args. Aligning the workflow with that convention removes any
    parser-version ambiguity (Copilot review on PR #8, 2026-05-10).
  - **`issue_comment` fork-PR resolution (Codex P1, 2026-05-10)**:
    added a `resolve_pr_head` step that, on `issue_comment` events
    on PR threads, calls `gh api repos/<repo>/pulls/<n>` to fetch
    `head.repo.full_name` and exposes `is_fork` as a step output.
    The preflight step now consults both the env-level
    `IS_UNTRUSTED_FORK_PR` (which works for `pull_request_review*`
    events where the PR object is in the payload) and the resolved
    `IC_FORK` from the lookup step. Without this, a maintainer
    commenting `@claude` on a fork-authored PR thread would still
    pass the author_association gate and reach the Claude action
    with `CLAUDE_CODE_OAUTH_TOKEN` in scope, with only the Bash
    fence as a defense — closing the residual M1 path Codex
    flagged in the second round.

## [1.0.3] — 2026-05-08

First public OSS release of @kenmege/codex-plugin-cc.

- Repository visibility flipped from private to public.
- `release.yml`: `npm publish --access public --provenance` so the
  package is consumable by anyone and ships with a provenance
  attestation. Replaces the `--access restricted` private-era
  publish path used for 1.0.1 and 1.0.2.
- `release.yml`: new step that auto-creates a GitHub Release for
  every published tag, sourced from `RELEASE_NOTES_v${VERSION}.md`.
- 1.0.0 / 1.0.1 / 1.0.2 were private-era launch attempts; 1.0.3 is
  the version readers should depend on.

## [1.0.2] — 2026-05-08

- Workflow fix: removed npm provenance from the restricted GitHub Packages
  publish path. The v1.0.1 tag reached `npm publish` but GitHub Packages rejected
  `npm publish --provenance --access restricted` with `EUSAGE` because npm
  provenance requires public-access publishing for a first publish.
- Removed `publishConfig.provenance` and the unused `id-token: write`
  permission from `release.yml`; the workflow continues to publish to
  `https://npm.pkg.github.com` with `GITHUB_TOKEN` and `--access restricted`.
- Initial public release version-bumped to 1.0.2; the v1.0.0 and v1.0.1 tags
  were launch attempts that never produced a published package or GitHub release.

## [1.0.1] — 2026-05-08

- Workflow fix: removed `npm pkg set private=false` from `release.yml`. The
  defensive line wrote the string "false" to `package.json.private` (truthy in
  JS), which caused npm publish to exit `EPRIVATE`. The package.json shape
  regression test added in PR #2 already enforces the absence of the `private`
  field at source, so the workflow-side normalization is no longer needed.
- Initial public release version-bumped to 1.0.1; the v1.0.0 tag was created
  during launch but never produced a published package or a GitHub release.
- Removed the legacy `context-1m-2025-08-07` beta-header injection from the
  long-context profile. Current Claude Code selection uses `[1m]` model
  variants instead of beta-header injection.

### Added

- Added agentic review lanes for `review`, `adversarial-review`, `elite-review`, `deep-review`, and `security-review`.
- Added read-only Claude tool fencing with native `Read`, `Glob`, `Grep`, `Task`, `WebFetch`, `WebSearch`, and a single `git-safe.mjs` Bash wrapper.
- Added strict structured-output validation so malformed Claude payloads fail closed before rendering.
- Added versioned job records with `schemaVersion`, atomic writes, exclusive job creation, stale-running detection, and persisted `invocationMeta`.
- Added `setup --json`, `--quiet`, `--debug`, validated `--add-dir`, validated `--mcp-config`, and exit-code contract support.
- Added CI matrix for Node 18.18, 20, and 22 plus package-content verification.
- Added release workflow scaffolding. Publishing is disabled by default while `package.json` remains `private: true`.
- Added `SECURITY.md`, `CONTRIBUTING.md`, and `docs/architecture.md`.

### Security

- Hardened the Bash surface against command/path escape by replacing raw git/cat/find/grep-style shell rules with `scripts/bin/git-safe.mjs`.
- Fixed prompt-injection exposure by consistently framing external review material inside `<untrusted_diff>`, `<untrusted_focus>`, and `<workspace_guidance>`.
- Blocked unsafe permission modes such as `bypassPermissions`, `acceptEdits`, and arbitrary auto-approval modes.
- Added WebFetch domain allowlisting and explicit `--unrestricted` warning behavior.
- Added validation for extra directory access and MCP config inputs before launching Claude.

### Changed

- Promoted default model to `claude-opus-4-7`.
- Agentic safe mode is now the default; legacy structured-output-only behavior remains available with `--legacy`.
- Subscription auth detection now suppresses API-key-only budget flags and surfaces the suppression in rendered output, logs, and invocation metadata.
- Repackaged for GitHub Packages publishing under `@kenmege/codex-plugin-cc`; the release workflow now uses `GITHUB_TOKEN` and publishes to `https://npm.pkg.github.com`.
  References: GitHub Docs "Working with the npm registry" (https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry), "About permissions for GitHub Packages" (https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages), and "Automatic token authentication" (https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication).

### Fixed

- Fixed stream parsing to count malformed JSON lines and fail closed when no structured output can be recovered.
- Fixed renderer crashes on missing findings arrays by validating live output and defensively rendering persisted legacy records.
- Fixed background job state corruption risk from partial writes.
- Fixed stale CI that referenced a missing build script and only tested one Node version.
- Fixed release workflow safety so a tag must match `package.json` before GitHub Packages publish can run.
- Fixed CLI help so `--help`, `-h`, and `help` exit successfully while unknown commands still return usage error code `2`.
- Fixed the `review` lane so positional focus text is preserved instead of silently discarded.
- Fixed stale job lock recovery when a lock holder has died, and routed detached worker stdout/stderr into the job log for early-crash diagnostics.
- Documented the `CODEX_CLAUDE_ADD_DIR_BOUNDARY` override for symlinked monorepo and tighter-boundary deployments.

## [0.2.1] - 2026-05-07

### Added

- Added hardening for the v0.2.0 agentic refactor, including permission-mode checks, schema evidence requirements, trust-boundary tags, WebFetch allowlists, strict MCP defaulting, and subscription-auth notes.

### Security

- Addressed reviewer-identified NO_SHIP risks in Bash allowlisting, prompt injection, empty evidence, unsafe permission modes, and unscoped MCP inheritance.

## [0.2.0] - 2026-05-07

### Added

- Added the first agentic review implementation with Claude tool access, new review lanes, and richer structured output.

### Changed

- Replaced structured-output-only review with agentic review as the default path.

## [0.1.0] - 2026-04-12

### Added

- Initial Codex-native Claude review helper.
- Added `review`, `adversarial-review`, and `elite-review` lanes using structured output without agentic tools.
