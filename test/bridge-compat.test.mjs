import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import fc from "fast-check";

import {
  V1_ROUTING,
  toInternalRequest,
  toInternalResult,
  toV1Request,
  toV1Result
} from "../scripts/lib/bridge-compat.mjs";
import {
  BridgeContractValidationError,
  validateBridgeRequestContract,
  validateBridgeResultContract
} from "../scripts/lib/bridge-contracts.mjs";
import { resolveBridgePolicy } from "../scripts/lib/bridge-policy.mjs";
import { buildBridgeRequest } from "../scripts/lib/bridge-request.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JOB_ID = "ccb_01J00000000000000000000000";
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const HEAD = "c14ec0381e044fcaad0a0bb89f4a7437a5f3656a";
const ATTESTATION = {
  jobId: JOB_ID, executor: "tmux", canonicalWorkspacePath: ROOT,
  issuedAt: "2026-07-18T12:00:00.000Z", authority: "bridge-tmux-executor"
};

function v1Args(profile, settingSources = []) {
  const args = resolveBridgePolicy({ profile: profile === "sandbox-autonomous" ? "trusted-autonomous" : profile, workspacePath: ROOT }).claudeArgs;
  return [`--setting-sources=${settingSources.join(",")}`, ...args.filter((argument) => argument !== "--setting-sources=")];
}

// The v1 request fixture shape used across the existing suite (test/bridge-contracts.test.mjs).
function sampleV1Request(overrides = {}) {
  return {
    schemaVersion: 1,
    jobId: JOB_ID,
    origin: { codexThreadId: "thread-1", codexTurnId: null, cwd: ROOT, repoRoot: ROOT, branch: "codex/claude-agent-bridge", head: HEAD },
    worker: {
      provider: "anthropic", model: "user-selected-model", agent: "reviewer", inlineAgents: null, customAgentsFile: null,
      pluginDirs: [], mcpConfigPaths: [], addDirs: [], settingSources: [], effort: "high", resolvedRuntimeVersion: "2.1.207"
    },
    execution: {
      profile: "standard", executor: "tmux", tmuxSession: "ccb-phase0", workspaceMode: "current",
      requestedWorkspacePath: ROOT, canonicalWorkspacePath: ROOT, permittedRoot: ROOT, claudeSessionId: SESSION_ID,
      sandboxAttestation: null, timeoutSeconds: 900, effectiveClaudePermissionArgs: ["--setting-sources=", "--permission-mode", "default"]
    },
    task: { promptFile: "prompt.md", acceptance: ["tests pass"] },
    ...overrides
  };
}

function sampleV1Result(overrides = {}) {
  return {
    schemaVersion: 1, jobId: JOB_ID, status: "completed", summary: "Phase 0 complete",
    filesChanged: ["scripts/lib/bridge-policy.mjs"],
    commandsRun: [{ command: "npm test", status: "passed", exitCode: 0 }],
    testsRun: [{ command: "node --test test/bridge-contracts.test.mjs", status: "passed", summary: "all passed" }],
    findings: [], blockers: [], claudeSessionId: SESSION_ID,
    exitStatus: { code: 0, signal: null }, artifactPaths: [path.join(ROOT, "result.json")],
    ...overrides
  };
}

function handwrittenV1Requests() {
  const native = sampleV1Request();
  native.execution = { ...native.execution, executor: "native-background", tmuxSession: null };
  const sandbox = sampleV1Request();
  sandbox.execution = { ...sandbox.execution, profile: "sandbox-autonomous", sandboxAttestation: ATTESTATION, effectiveClaudePermissionArgs: v1Args("sandbox-autonomous") };
  const readonly = sampleV1Request();
  readonly.execution = { ...readonly.execution, profile: "review-readonly", effectiveClaudePermissionArgs: v1Args("review-readonly") };
  const autonomous = sampleV1Request();
  autonomous.execution = { ...autonomous.execution, profile: "trusted-autonomous", effectiveClaudePermissionArgs: v1Args("trusted-autonomous") };
  const inline = sampleV1Request();
  inline.worker = { ...inline.worker, agent: null, inlineAgents: { reviewer: { description: "Reviews", prompt: "Review." } } };
  const file = sampleV1Request();
  file.worker = { ...file.worker, customAgentsFile: path.join(ROOT, "package.json"), pluginDirs: [ROOT], mcpConfigPaths: [path.join(ROOT, "package.json")], addDirs: [ROOT], settingSources: ["user", "project"] };
  file.execution = { ...file.execution, effectiveClaudePermissionArgs: v1Args("standard", ["user", "project"]) };
  const turn = sampleV1Request();
  turn.origin = { ...turn.origin, codexTurnId: "turn-1", branch: null, head: null };
  return { sample: sampleV1Request(), native, sandbox, readonly, autonomous, inline, file, turn };
}

function builtV1Requests() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-compat-"));
  const workspace = path.join(root, "repo");
  fs.mkdirSync(workspace);
  const agentsFile = path.join(root, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify({ reviewer: { description: "Reviews", prompt: "Review." } }));
  const requests = [];
  for (const profile of ["standard", "trusted-autonomous", "review-readonly"]) {
    for (const executor of ["tmux", "native-background"]) {
      for (const selection of [{}, { agents: { helper: { description: "Helps", prompt: "Help." } } }, { agentsFile }]) {
        requests.push(buildBridgeRequest({
          agent: "implementer", model: "opus", effort: "high", profile, executor, workspace: "current",
          workspacePath: workspace, permittedRoot: root, timeout: 900, codexThreadId: "thread-1",
          codexTurnId: "turn-1", cwd: workspace, repoRoot: workspace, branch: "feature/x", head: "a".repeat(40),
          resolvedRuntimeVersion: "runtime-fixture", promptFile: "prompt.md", acceptance: ["tests pass", "lint passes"],
          settingSources: profile === "standard" ? ["user", "project"] : undefined,
          ...selection
        }));
      }
    }
  }
  return requests;
}

test("toInternalRequest maps a v1 request to the v2 field layout", () => {
  const v1 = sampleV1Request();
  const internal = toInternalRequest(v1);
  assert.deepEqual(internal, {
    schemaVersion: 1,
    jobId: JOB_ID,
    origin: { family: "codex", threadId: "thread-1", turnId: null, cwd: ROOT, repoRoot: ROOT, branch: "codex/claude-agent-bridge", head: HEAD, accountHome: null },
    worker: {
      family: "claude", provider: "anthropic", model: "user-selected-model", effort: "high", agent: "reviewer",
      resolvedRuntimeVersion: "2.1.207",
      claude: { inlineAgents: null, customAgentsFile: null, pluginDirs: [], mcpConfigPaths: [], addDirs: [], settingSources: [] }
    },
    execution: {
      profile: "standard", executor: "tmux", tmuxSession: "ccb-phase0", workspaceMode: "current",
      requestedWorkspacePath: ROOT, canonicalWorkspacePath: ROOT, permittedRoot: ROOT, workerSessionId: SESSION_ID,
      sandboxAttestation: null, timeoutSeconds: 900, effectiveWorkerArgs: ["--setting-sources=", "--permission-mode", "default"]
    },
    verification: { family: "codex", profile: "review-readonly" },
    task: { promptFile: "prompt.md", acceptance: ["tests pass"], family: null, continuesJobId: null },
    routing: V1_ROUTING
  });
  assert.deepEqual(V1_ROUTING, { source: "flag", reason: "schemaVersion 1 request: model and effort were fixed at delegation." });
  assert.ok(Object.isFrozen(internal) && Object.isFrozen(internal.worker.claude.pluginDirs) && Object.isFrozen(internal.routing));
  v1.origin.codexThreadId = "mutated-after-conversion";
  assert.equal(internal.origin.threadId, "thread-1", "the internal form never aliases its input");
});

test("every v1 request fixture round-trips losslessly and its internal form is v2-valid", () => {
  const fixtures = [...Object.values(handwrittenV1Requests()), ...builtV1Requests()];
  assert.ok(fixtures.length >= 26);
  for (const v1 of fixtures) {
    validateBridgeRequestContract(v1);
    const internal = toInternalRequest(v1);
    assert.equal(internal.schemaVersion, 1, "the internal form records the persisted contract version");
    assert.deepEqual(toV1Request(internal), v1);
    const asV2 = { ...structuredClone(internal), schemaVersion: 2 };
    assert.equal(validateBridgeRequestContract(asV2), asV2, "the internal layout is exactly the v2 layout");
  }
});

test("property: arbitrary schema-valid v1 requests round-trip", () => {
  const profileArb = fc.constantFrom("standard", "trusted-autonomous", "review-readonly", "sandbox-autonomous");
  const sources = fc.subarray(["user", "project", "local"]);
  const token = fc.stringMatching(/^[A-Za-z0-9._-]{1,24}$/);
  fc.assert(fc.property(
    profileArb, sources, fc.boolean(), fc.option(token, { nil: null }), fc.option(token, { nil: null }),
    fc.option(fc.stringMatching(/^[0-9a-f]{40}$/), { nil: null }), token, token, fc.integer({ min: 1, max: 86_400 }),
    fc.array(fc.string({ minLength: 1, maxLength: 40 }), { minLength: 1, maxLength: 4 }),
    (profile, settingSources, tmux, turnId, branch, head, model, effort, timeoutSeconds, acceptance) => {
      const v1 = sampleV1Request();
      v1.origin = { ...v1.origin, codexTurnId: turnId, branch, head };
      v1.worker = { ...v1.worker, model, effort, settingSources };
      v1.execution = {
        ...v1.execution,
        profile,
        executor: tmux ? "tmux" : "native-background",
        tmuxSession: tmux ? "ccb-fuzz" : null,
        sandboxAttestation: profile === "sandbox-autonomous" ? { ...ATTESTATION, executor: tmux ? "tmux" : "native-background" } : null,
        timeoutSeconds,
        effectiveClaudePermissionArgs: profile === "review-readonly" ? v1Args(profile) : v1Args(profile, settingSources)
      };
      v1.task = { ...v1.task, acceptance };
      validateBridgeRequestContract(v1);
      assert.deepEqual(toV1Request(toInternalRequest(v1)), v1);
    }
  ), { numRuns: 200 });
});

test("toInternalRequest returns a frozen copy of a v2 request and refuses invalid documents", () => {
  const v1Internal = toInternalRequest(sampleV1Request());
  const v2 = { ...structuredClone(v1Internal), schemaVersion: 2 };
  const internal = toInternalRequest(v2);
  assert.deepEqual(internal, v2);
  assert.notEqual(internal, v2);
  assert.ok(Object.isFrozen(internal.execution));
  for (const invalid of [
    { ...sampleV1Request(), schemaVersion: 3 },
    sampleV1Request({ origin: { codexThreadId: "" } }),
    null,
    "request"
  ]) {
    assert.throws(() => toInternalRequest(invalid), BridgeContractValidationError);
  }
});

test("toV1Request refuses an internal request that v1 cannot express", () => {
  const base = toInternalRequest(sampleV1Request());
  for (const [label, mutate] of [
    ["claude origin", (doc) => { doc.origin.family = "claude"; doc.origin.threadId = SESSION_ID; }],
    ["account home", (doc) => { doc.origin.accountHome = ROOT; }],
    ["codex worker", (doc) => { doc.worker.family = "codex"; }],
    ["host model", (doc) => { doc.worker.model = null; }],
    ["host effort", (doc) => { doc.worker.effort = null; }],
    ["host profile", (doc) => { doc.execution.profile = "host"; doc.execution.effectiveWorkerArgs = []; doc.worker.claude.settingSources = null; }],
    ["non-v1 verifier", (doc) => { doc.verification.profile = "host"; }],
    ["task family", (doc) => { doc.task.family = "review"; }],
    ["continuation", (doc) => { doc.task.continuesJobId = "ccb_01J00000000000000000000001"; }],
    ["v2 routing", (doc) => { doc.routing = { source: "config", reason: "config routing.review" }; }]
  ]) {
    const internal = structuredClone(base);
    mutate(internal);
    assert.throws(() => toV1Request(internal), /cannot be expressed as a schemaVersion 1 request/, label);
  }
});

test("toInternalResult maps claudeSessionId to workerSessionId and every v1 result round-trips", () => {
  const v1 = sampleV1Result();
  const internal = toInternalResult(v1);
  const { claudeSessionId, ...rest } = v1;
  assert.deepEqual(internal, { ...rest, workerFamily: "claude", workerSessionId: claudeSessionId, plan: null });
  assert.equal(internal.schemaVersion, 1);
  assert.ok(Object.isFrozen(internal) && Object.isFrozen(internal.commandsRun[0]));
  for (const fixture of [
    v1,
    sampleV1Result({ claudeSessionId: null, status: "failed", blockers: [{ title: "Blocked", detail: "No credentials" }] }),
    sampleV1Result({ status: "cancelled", exitStatus: { code: null, signal: "SIGTERM" }, filesChanged: [], commandsRun: [], testsRun: [] })
  ]) {
    validateBridgeResultContract(fixture);
    assert.deepEqual(toV1Result(toInternalResult(fixture)), fixture);
    const asV2 = { ...structuredClone(toInternalResult(fixture)), schemaVersion: 2 };
    assert.equal(validateBridgeResultContract(asV2), asV2);
  }
  const v2 = { ...structuredClone(internal), schemaVersion: 2, workerFamily: "codex", workerSessionId: "thread-worker-1" };
  assert.deepEqual(toInternalResult(v2), v2);
  assert.throws(() => toV1Result(toInternalResult(v2)), /cannot be expressed as a schemaVersion 1 result/);
  assert.throws(() => toInternalResult({ ...v1, schemaVersion: 3 }), BridgeContractValidationError);
});

test("property: arbitrary schema-valid v1 results round-trip", () => {
  const item = fc.record({ title: fc.string({ minLength: 1, maxLength: 20 }), detail: fc.string({ minLength: 1, maxLength: 40 }) });
  fc.assert(fc.property(
    fc.constantFrom("completed", "failed", "cancelled"), fc.string({ maxLength: 60 }),
    fc.array(fc.string({ minLength: 1, maxLength: 30 }), { maxLength: 5 }), fc.array(item, { maxLength: 3 }),
    fc.array(item, { maxLength: 3 }), fc.option(fc.uuid(), { nil: null }), fc.option(fc.integer({ min: -1, max: 255 }), { nil: null }),
    (status, summary, filesChanged, findings, blockers, session, code) => {
      const v1 = sampleV1Result({ status, summary, filesChanged, findings, blockers, claudeSessionId: session, exitStatus: { code, signal: null } });
      validateBridgeResultContract(v1);
      assert.deepEqual(toV1Result(toInternalResult(v1)), v1);
    }
  ), { numRuns: 200 });
});
