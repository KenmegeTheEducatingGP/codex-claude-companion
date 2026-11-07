import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { validateBridgeRequestContract } from "../scripts/lib/bridge-contracts.mjs";
import * as bridgePolicy from "../scripts/lib/bridge-policy.mjs";
import { buildBridgeRequest } from "../scripts/lib/bridge-request.mjs";

// A namespace import keeps a missing export from failing the whole file at import time,
// so each test reports its own assertion.
const { BRIDGE_PROFILES, BRIDGE_TRUST_PROFILES, resolveBridgePolicy, resolveFamilyProfile } = bridgePolicy;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V1_POLICY_KEYS = [
  "profile", "permissionMode", "autonomous", "requiresSandbox", "writeAccess", "requestedWorkspacePath",
  "canonicalWorkspacePath", "workspacePath", "permittedRoot", "sandboxAttestation", "claudeArgs"
];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-host-"));
  const workspace = path.join(root, "repo");
  fs.mkdirSync(workspace);
  return { root, workspace };
}

function v2Options(overrides = {}) {
  const { root, workspace } = fixture();
  return {
    schemaVersion: 2,
    originFamily: "claude",
    threadId: "00000000-0000-4000-8000-0000000000aa",
    turnId: null,
    workerFamily: "codex",
    agent: "implementer",
    profile: "host",
    executor: "tmux",
    workspace: "current",
    workspacePath: workspace,
    permittedRoot: root,
    timeout: 900,
    cwd: workspace,
    repoRoot: workspace,
    branch: null,
    head: null,
    resolvedRuntimeVersion: "runtime-fixture",
    promptFile: "prompt.md",
    acceptance: ["tests pass"],
    ...overrides
  };
}

function requestError(code, field) {
  return (error) => error.name === "BridgeRequestError" && error.code === code && (field === undefined || error.field === field);
}

test("the host profile produces empty worker args and empty worker params", () => {
  assert.deepEqual(Object.keys(BRIDGE_PROFILES), ["host", "review-readonly", "standard", "trusted-autonomous", "sandbox-autonomous"]);
  assert.deepEqual(BRIDGE_PROFILES.host.claudeArgs, []);
  assert.deepEqual(BRIDGE_PROFILES.host.codexParams, {});
  assert.equal(BRIDGE_PROFILES.host.permissionMode, null);
  assert.ok(Object.isFrozen(BRIDGE_PROFILES) && Object.isFrozen(BRIDGE_PROFILES.host) && Object.isFrozen(BRIDGE_PROFILES.host.codexParams));

  const claude = resolveBridgePolicy({ profile: "host", workspacePath: ROOT, family: "claude" });
  assert.equal(claude.family, "claude");
  assert.deepEqual(claude.workerArgs, []);
  assert.equal(claude.workerParams, null);
  assert.equal(claude.permissionMode, null);
  const codex = resolveBridgePolicy({ profile: "host", workspacePath: ROOT, family: "codex" });
  assert.deepEqual(codex.workerParams, {});
  assert.equal(codex.workerArgs, null);
  assert.ok(Object.isFrozen(codex) && Object.isFrozen(codex.workerParams));
});

test("Codex profiles map to explicit params only, and unavailable profiles fail", () => {
  assert.deepEqual(resolveFamilyProfile("review-readonly", "codex"), { profile: "review-readonly", family: "codex", workerArgs: null, workerParams: { sandbox: "read-only" } });
  assert.deepEqual(resolveFamilyProfile("trusted-autonomous", "codex").workerParams, { sandbox: "danger-full-access", approvalPolicy: "never" });
  assert.deepEqual(resolveFamilyProfile("standard", "claude").workerArgs, ["--permission-mode", "default"]);
  assert.throws(() => resolveFamilyProfile("standard", "codex"), /"standard" is not available for codex/);
  assert.throws(() => resolveFamilyProfile("sandbox-autonomous", "codex"), /unavailable/);
  assert.throws(() => resolveFamilyProfile("host", "gemini"), /Unknown worker family "gemini"/);
  assert.throws(() => resolveFamilyProfile("unshackled", "claude"), /Unknown bridge profile "unshackled"/);
  assert.throws(
    () => resolveBridgePolicy({ profile: "sandbox-autonomous", workspacePath: ROOT, family: "claude" }),
    /unavailable.*executor-owned provenance verification.*not implemented/i
  );
});

test("v1 policy resolution is unchanged and refuses host", () => {
  assert.deepEqual(Object.keys(BRIDGE_TRUST_PROFILES), ["review-readonly", "standard", "trusted-autonomous", "sandbox-autonomous"]);
  for (const profile of ["review-readonly", "standard", "trusted-autonomous"]) {
    const policy = resolveBridgePolicy({ profile, workspacePath: ROOT });
    assert.deepEqual(Object.keys(policy), V1_POLICY_KEYS, `${profile} keeps the 1.2.0 policy shape`);
    assert.deepEqual(policy.claudeArgs, [...BRIDGE_TRUST_PROFILES[profile].claudeArgs]);
  }
  assert.throws(() => resolveBridgePolicy({ profile: "host", workspacePath: ROOT }), /"host".*schemaVersion 2/);
});

test("profile names never resolve through the object prototype", () => {
  for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    assert.throws(() => resolveBridgePolicy({ profile: name, workspacePath: ROOT }), /Unknown bridge trust profile/, name);
    assert.throws(() => resolveFamilyProfile(name, "claude"), /Unknown bridge profile/, name);
  }
});

test("host refuses a contradictory permission mode", () => {
  assert.throws(
    () => resolveBridgePolicy({ profile: "host", workspacePath: ROOT, family: "claude", permissionMode: "default" }),
    /host.*does not set a permission mode/
  );
});

test("read-only arises only from an explicit review-readonly profile", () => {
  const host = buildBridgeRequest(v2Options());
  assert.equal(host.execution.profile, "host");
  assert.deepEqual(host.execution.effectiveWorkerParams, {});
  assert.deepEqual(host.verification, { family: "claude", profile: "host" });
  assert.doesNotMatch(JSON.stringify(host), /read-only|--disallowedTools|--permission-mode/);

  const claudeHost = buildBridgeRequest(v2Options({ originFamily: "codex", threadId: "thread-1", workerFamily: "claude" }));
  assert.deepEqual(claudeHost.execution.effectiveWorkerArgs, []);
  assert.equal(claudeHost.worker.claude.settingSources, null);
  assert.doesNotMatch(JSON.stringify(claudeHost), /read-only|--disallowedTools|--permission-mode|--setting-sources/);

  const readonly = buildBridgeRequest(v2Options({ profile: "review-readonly" }));
  assert.deepEqual(readonly.execution.effectiveWorkerParams, { sandbox: "read-only" });
  const readonlyVerifier = buildBridgeRequest(v2Options({ verificationProfile: "review-readonly" }));
  assert.deepEqual(readonlyVerifier.verification, { family: "claude", profile: "review-readonly" });
});

test("buildBridgeRequest writes a schema-valid v2 request for a Claude origin and a Codex worker", () => {
  const request = buildBridgeRequest(v2Options({ taskFamily: "review", continuesJobId: "ccb_01J00000000000000000000001" }));
  assert.doesNotThrow(() => validateBridgeRequestContract(request));
  assert.equal(request.schemaVersion, 2);
  assert.deepEqual(request.origin.family, "claude");
  assert.equal(request.origin.threadId, "00000000-0000-4000-8000-0000000000aa");
  assert.equal(request.origin.accountHome, null);
  assert.equal(request.worker.family, "codex");
  assert.equal(request.worker.provider, "openai");
  assert.deepEqual(request.worker.codex, {});
  assert.equal(Object.hasOwn(request.worker, "claude"), false);
  assert.equal(request.worker.model, null);
  assert.equal(request.worker.effort, null);
  assert.equal(request.execution.workerSessionId, null);
  assert.equal(Object.hasOwn(request.execution, "effectiveWorkerArgs"), false);
  assert.deepEqual(request.task, { promptFile: "prompt.md", acceptance: ["tests pass"], family: "review", continuesJobId: "ccb_01J00000000000000000000001" });
  assert.equal(request.routing.source, "host");
  assert.ok(Object.isFrozen(request) && Object.isFrozen(request.execution.effectiveWorkerParams));
});

test("buildBridgeRequest writes a schema-valid v2 request for a Codex origin and a Claude worker", () => {
  const { root } = fixture();
  const accountHome = path.join(root, "account");
  fs.mkdirSync(accountHome);
  const request = buildBridgeRequest(v2Options({
    originFamily: "codex", threadId: "thread-1", turnId: "turn-1", workerFamily: "claude", profile: "standard",
    settingSources: ["user"], model: "opus", effort: "high", accountHome
  }));
  assert.doesNotThrow(() => validateBridgeRequestContract(request));
  assert.equal(request.origin.accountHome, accountHome);
  assert.equal(request.worker.provider, "anthropic");
  assert.deepEqual(request.worker.claude.settingSources, ["user"]);
  assert.deepEqual(request.execution.effectiveWorkerArgs, ["--setting-sources=user", "--permission-mode", "default"]);
  assert.match(request.execution.workerSessionId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(request.routing, { source: "flag", reason: "Explicit model or effort option." });
  assert.deepEqual(request.verification, { family: "codex", profile: "host" });

  const routed = buildBridgeRequest(v2Options({ model: "routed", routing: { source: "config", reason: "config routing.review" } }));
  assert.deepEqual(routed.routing, { source: "config", reason: "config routing.review" });
});

test("buildBridgeRequest rejects same-family verification and family-incompatible options", () => {
  assert.throws(() => buildBridgeRequest(v2Options({ verificationFamily: "codex" })), requestError("same_family_verification", "verificationFamily"));
  assert.throws(
    () => buildBridgeRequest(v2Options({ workerFamily: "claude", verificationFamily: "claude" })),
    requestError("same_family_verification", "verificationFamily")
  );
  assert.throws(() => buildBridgeRequest(v2Options({ profile: "standard" })), requestError("policy_invalid", "profile"));
  assert.throws(() => buildBridgeRequest(v2Options({ verificationProfile: "standard", workerFamily: "claude" })), requestError("policy_invalid", "verificationProfile"));
  for (const option of [{ pluginDirs: [ROOT] }, { addDirs: [ROOT] }, { settingSources: ["user"] }, { agents: { a: { description: "x" } } }]) {
    assert.throws(() => buildBridgeRequest(v2Options(option)), requestError("claude_option_for_codex_worker"), JSON.stringify(option));
  }
  assert.throws(
    () => buildBridgeRequest(v2Options({ workerFamily: "claude", settingSources: ["user"] })),
    requestError("host_setting_sources", "settingSources")
  );
  assert.throws(() => buildBridgeRequest(v2Options({ originFamily: "gemini" })), requestError("invalid_family", "originFamily"));
  assert.throws(() => buildBridgeRequest(v2Options({ workerFamily: undefined })), requestError("invalid_family", "workerFamily"));
  assert.throws(() => buildBridgeRequest(v2Options({ threadId: "thread-1" })), requestError("contract_invalid", "request"));
  assert.throws(() => buildBridgeRequest(v2Options({ accountHome: "relative/home" })), requestError("path_not_absolute", "accountHome"));
  assert.throws(() => buildBridgeRequest(v2Options({ taskFamily: "has spaces" })), requestError("contract_invalid", "request"));
  assert.throws(() => buildBridgeRequest(v2Options({ model: "m", routing: { source: "host", reason: "host" } })), requestError("contract_invalid", "request"));
  assert.throws(() => buildBridgeRequest(v2Options({ schemaVersion: 3 })), requestError("invalid_schema_version", "schemaVersion"));
});

test("buildBridgeRequest keeps writing the 1.2.0 v1 request when no schemaVersion is chosen", () => {
  const { root, workspace } = fixture();
  const request = buildBridgeRequest({
    agent: "implementer", model: "opus", effort: "high", profile: "standard", executor: "tmux", workspace: "current",
    workspacePath: workspace, permittedRoot: root, timeout: 900, codexThreadId: "thread-1", codexTurnId: null,
    cwd: workspace, repoRoot: workspace, branch: null, head: null, resolvedRuntimeVersion: "runtime-fixture",
    promptFile: "prompt.md", acceptance: ["tests pass"]
  });
  assert.equal(request.schemaVersion, 1);
  assert.equal(request.origin.codexThreadId, "thread-1");
  assert.deepEqual(request.execution.effectiveClaudePermissionArgs, ["--setting-sources=", "--permission-mode", "default"]);
  assert.throws(
    () => buildBridgeRequest({ ...v2Options({ originFamily: "codex", threadId: "thread-1", workerFamily: "claude" }), schemaVersion: undefined, codexThreadId: "thread-1", model: "opus", effort: "high" }),
    requestError("policy_invalid", "profile"),
    "host is not a v1 profile"
  );
});
