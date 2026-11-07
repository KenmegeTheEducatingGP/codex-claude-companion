# Codex-Claude Bridge contracts

This document describes the Codex-Claude Bridge contract shipped in
`codex-claude-companion@1.2.0`.

`codex-claude-companion@1.2.0` is the current stable release on npm
dist-tag `latest`. The earlier stable `codex-plugin-cc@1.1.1` package does not contain
this work.

## Capability matrix

| Capability | Direct `claude` CLI | Legacy workspace/review lanes | Durable bridge |
|---|---|---|---|
| Launch a prompt | Native | Wrapped for review and workspace modes | Typed delegation request |
| Agent, model, and effort selection | Native flags | Review/workspace selectors | Named or custom agent plus caller-supplied model and effort |
| Permission policy | Caller chooses flags | Read-only review fence or supervised workspace default | Named, validated trust profile with effective arguments in the receipt |
| Durable process ownership | Shell or Claude background mode | Claude background supervisor; viewer terminal is separate | Actual worker process owned by a named tmux session |
| Codex origin correlation | Manual | Not persisted as a bridge contract | Thread, turn, cwd, repository, branch, head, and job ID |
| Mid-run collaboration | Manual terminal interaction | Status/log polling | Ordered, deduplicated question, message, progress, and cancellation events |
| Result return | Manual copy/paste | Status/result polling | Active-wait return, correlated Codex follow-up, or durable inbox fallback |
| Independent verification | Manual | Codex may review after polling | Separate verification state and bounded repair workflow |
| Crash recovery | Manual archaeology | Job files for review lanes | Automatic same-origin restart on ordinary bridge CLI use, plus explicit reconciliation across ledger, tmux, Claude session, repository, and delivery state |

Live steering is deliberately scoped to the active authoritative worker. The
first authoritative Claude result closes stdin and advances the job to
verification and delivery; it is not an open-ended chat channel after worker
completion. Without `send --wait`, success proves only durable queueing; with
`--wait`, it requires replay acknowledgement from the live session. A message
queued during the terminal-result race can remain unacknowledged.

The blocking CLI contract is machine-consumable: `delegate --wait` and `wait`
return `0` only for completed, independently verified, origin-acknowledged work;
`3` for terminal failure or an unmet verification/delivery gate; and `4` when a
pending Claude question requires input. A timeout is an operational error and
returns a nonzero process exit with a diagnostic.

## Exact meaning of `trusted-autonomous`

`trusted-autonomous` is an explicit local-workspace trust profile. It is never
the default. Resolving it requires the caller to provide the profile by name and
an existing absolute workspace path. Policy resolution canonicalizes that path
with `realpath`, confirms it is a directory, and rejects a canonical workspace
outside a supplied permitted root. The request and receipt retain the requested
and canonical paths. Its complete Claude permission argument list is:

```text
--setting-sources=
--permission-mode bypassPermissions
```

That mode bypasses Claude's interactive permission checks inside the selected
workspace. It does not create an OS sandbox, restrict network access, prevent an
agent from operating outside the repository, or make arbitrary source code
trustworthy. Use a separately proven OS or container sandbox when bypass
permissions require containment.

Selecting this profile does not authorize public publishing, deployment,
credential changes, or destructive host actions. Those actions remain governed
separately from Claude's local permission mode. The receipt records the selected
profile and exact effective Claude permission arguments, excluding secrets.

`sandbox-autonomous` is unavailable. Its request contract retains an
executor-produced structured attestation bound to the job ID, executor,
canonical workspace path, issue time, and expected authority, but caller-supplied
attestations are never accepted as proof. The resolver fails closed even when
those fields appear to match. A future executor-owned verifier must validate
authority, freshness, exact job/executor/workspace binding, and runtime sandbox
evidence before this profile can become usable. A naked caller-supplied boolean
is not accepted as sandbox proof.

## Other trust profiles

| Profile | Effective permission policy | Boundary |
|---|---|---|
| `review-readonly` | `--setting-sources=`; read/search/task tools only; `Edit`, `Write`, and `NotebookEdit` denied; `--permission-mode default`; `--strict-mcp-config` | Existing shell-free review fence preserved |
| `standard` | `--setting-sources= --permission-mode default` | Claude-native supervised coding behavior with persistent settings isolated by default |
| `trusted-autonomous` | `--setting-sources= --permission-mode bypassPermissions` | Explicitly trusted absolute local workspace with persistent settings isolated by default |
| `sandbox-autonomous` | Unavailable; a future contained policy may use `--permission-mode bypassPermissions` | Executor-owned verifier must validate a job-bound OS/container sandbox attestation before dispatch |

Contradictory combinations fail closed. Examples include asking `review-readonly` for anything outside its exact read/search/task and approved WebFetch allowlist, overriding either safe profile with `bypassPermissions`, or selecting `sandbox-autonomous` before executor-owned provenance verification exists.

## Agent presets

The checked-in registry defines `implementer`, `debugger`, `reviewer`,
`security-reviewer`, `researcher`, and `elite-reviewer`. Presets choose a role and
default trust profile only. They do not freeze a Claude model ID; model and
effort remain explicit delegation inputs. The request contract supports a named
agent, inline custom-agent JSON, a custom-agent file, plugin directories, MCP
configuration paths, additional directories, setting-source policy, and the
resolved Claude runtime version. The public CLI exposes all of these through
`--agent`, `--agents-json`, `--agents-file`, repeatable `--plugin-dir`, repeatable
`--mcp-config`, repeatable `--add-dir`, and `--setting-sources`.
`--agent` selects the active Claude agent and may be combined with either
`--agents-json` or `--agents-file` to define that agent. The two definition
sources are mutually exclusive; selection and definition are complementary.

Persistent Claude settings are isolated by default with the exact
`--setting-sources=` argument. Opting in to `user`, `project`, or `local` settings
also opts in to the configuration, hooks, and plugin trust carried by those
sources. The bridge validates and records that choice, but it cannot make an
untrusted settings source safe.

## Automatic durable recovery

Every ordinary bridge CLI invocation except `recover` and `gc` performs one silent
recovery sweep before its requested operation. This is CLI-invocation behavior;
it is not a claim that Codex itself installs a generic session-start hook. The
sweep is correlated to the stable Codex thread ID, so a later turn or repository
head in the same thread can resume older queued work. It inspects at most 64
recent durable jobs and attempts at most eight broker starts. Explicit
`recover` remains available for operator-directed reconciliation and does not run
the automatic sweep. Broker descendants receive a recursion guard, so resuming a
Codex thread cannot recursively launch another sweep. A restarted broker still
drains only the full immutable origin persisted in its own request. A heartbeat
PID suppresses restart only when its exact executable, broker script, `--spec`
argument, and spec path match; stale, reused, or ambiguous PIDs fail closed and
trigger a replacement start. Acknowledged or terminally failed deliveries are not
restarted.

`codex-claude gc` is a bounded dry run by default. It scans at most 256 durable
jobs and lists at most 64 terminal jobs older than 30 days. `--older-than-days`
and `--limit` may lower or tune those documented bounds; only explicit `--apply`
removes the listed job directories. Active and recent jobs are never candidates.

## Result delivery to the origin

The bridge returns a terminal result to its Codex origin through these routes, in
order:

1. **Waiter.** A `wait` run from the origin (its `CODEX_THREAD_ID` equals the
   job's origin thread) holds `jobs/<id>/waiter.lease`, refreshed while it waits.
   While that lease is live, the broker claims the delivery with
   `route: "waiter"` and never resumes the origin thread; the waiter
   acknowledges the claim after it wrote the result. The plain-text output of that
   `wait` carries the result itself (worker status, verification, summary, files,
   tests, blockers), and `--json` carries it in `result` and `receipt`. A `wait`
   from any other thread is an observer: it prints and never acknowledges. If
   the waiter cannot write its output, the claim is not acknowledged: it lapses
   after the 30-second delivery claim TTL and the broker delivers again.
2. **Origin resume.** With no live waiter, the broker resumes the origin thread
   through the Codex app-server with no sandbox or approval override, so the
   delivery turn runs under the user's Codex configuration and leaves the
   thread's permissions unchanged.
3. **Inbox.** A failed resume queues the result in the durable inbox. A resume
   that fails because the origin thread already has an active writer is
   recorded as `origin-busy`: it spends none of the 64-attempt inbox quota, and
   the broker exits instead of retrying a thread that is in use. Other failures
   still count against the quota. The origin's next `wait`, `status` or
   `delegate` prints its thread's queued results (a "Bridge results delivered"
   block, or `queuedResults` with `--json`, which lists only other jobs' results
   because the payload already carries its own job's). Those commands claim the
   queued results when they are about to write their output, never when they
   start, and acknowledge them only after the write succeeded: a command that
   times out, fails or is interrupted first leaves them queued for the next one,
   and so does one whose write fails (a closed pipe, a full disk). A failed
   write returns the claimed results to the inbox as `origin-output-failed`,
   which, like `origin-busy`, spends none of the 64-attempt quota. A command
   that dies between the claim and the acknowledgement leaves a claim that lapses
   after the 5-minute inbox claim TTL, and the next origin command claims the
   result again.
   While such a command runs, the automatic recovery sweep leaves the queued jobs
   alone, so a result delivered this way restarts no broker.

The v1 receipt keeps `delivery.state: "pending"` while a result is queued or
claimed; its schema is unchanged. The command that delivers a result prints a
receipt read before its write is confirmed, so it too shows `"pending"`; the
stored delivery is `acknowledged` once the write succeeded, and the next
`status` shows it. `status --json` exposes the queue from the durable delivery
file as `deliveryQueue: "inbox"` and `lastError`, for example `"origin-busy"` or
`"origin-output-failed"`.

Workers, the runner and the independent verifier inherit `CLAUDE_CONFIG_DIR` and
`CODEX_HOME` when they are set, so they run under the caller's Claude and Codex
homes; other variables stay stripped. The runner identity records only the home
directory names. The broker runs only broker specs whose `schemaVersion` this
release supports and refuses any other with an error.

## Durable state contracts

- `schemas/bridge-delegation-request.schema.json` records immutable origin, worker, execution, policy, and task acceptance data.
- `schemas/bridge-event.schema.json` defines the ordered, deduplicated event journal.
- `schemas/bridge-message-operation.schema.json` validates broker-owned message delivery and acknowledgement operations.
- `schemas/bridge-result.schema.json` defines the worker outcome and its evidence. Its `filesChanged` field contains only workspace-relative paths actually mutated by that worker during the job; reviewed or pre-existing dirty-but-unchanged files are excluded, and read-only jobs report `[]`.
- `schemas/bridge-receipt.schema.json` defines delivery and verification lifecycle state.

Worker completion, delivery, acknowledgement, and verification are separate states. A Claude process exiting successfully cannot by itself mark a result delivered, acknowledged, or verified.

The receipt rejects impossible lifecycle combinations. Nonterminal workers cannot
be marked delivered or acknowledged. Every terminal worker outcome—`completed`,
`failed`, or `cancelled`—can be returned to and acknowledged by its Codex origin,
so failures and cancellations do not disappear. Delivery and acknowledgement
require at least one attempt and their corresponding timestamps, while a failed
delivery requires an error and cannot carry delivered or acknowledged timestamps.
Independent verification `passed` or `failed` requires a completed worker; failed
and cancelled worker outcomes are reported without pretending they passed a
verification gate.

Production callers validate receipts through `validateBridgeReceiptContract` in `scripts/lib/bridge-contracts.mjs`. That single entry point always applies both the JSON Schema and semantic chronology rules. Delivery follows `createdAt <= deliveredAt <= acknowledgedAt`; verification independently follows `createdAt <= verifiedAt`. Verification may therefore finish before delivery or acknowledgement without invalidating the receipt.

Cancellation is two-phase in the durable ledger: `cancel_requested` records caller intent and its timestamp; only a later schema-valid `cancelled` lifecycle event confirms that the executor stopped the worker and releases the workspace lease.

Product identity and compatibility policy are frozen separately in [Bridge identity and migration](bridge-migration.md).
