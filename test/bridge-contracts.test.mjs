import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  BRIDGE_AGENT_PRESETS,
  BRIDGE_TRUST_PROFILES,
  resolveBridgePolicy
} from "../scripts/lib/bridge-policy.mjs";
import {
  BridgeContractValidationError,
  validateBridgeReceiptContract
} from "../scripts/lib/bridge-contracts.mjs";
import { buildWebFetchAllowlist } from "../scripts/lib/claude.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCHEMA_FILES = {
  request: "bridge-delegation-request.schema.json",
  event: "bridge-event.schema.json",
  messageOperation: "bridge-message-operation.schema.json",
  result: "bridge-result.schema.json",
  receipt: "bridge-receipt.schema.json"
};

function readSchema(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "schemas", SCHEMA_FILES[name]), "utf8"));
}

// Each contract file is a oneOf union on schemaVersion; the 1.2.0 contract is its
// unchanged v1 branch, whose $ref targets stay in the root $defs.
function readV1Branch(name) {
  const root = readSchema(name);
  return { ...root.$defs.v1, $defs: root.$defs };
}

const JOB_ID = "ccb_01J00000000000000000000000";
const CLAUDE_SESSION_ID = "00000000-0000-4000-8000-000000000001";

function sandboxAttestation(overrides = {}) {
  return {
    jobId: JOB_ID,
    executor: "tmux",
    canonicalWorkspacePath: ROOT,
    issuedAt: "2026-07-18T12:00:00.000Z",
    authority: "bridge-tmux-executor",
    ...overrides
  };
}

function sampleRequest(overrides = {}) {
  const request = {
    schemaVersion: 1,
    jobId: JOB_ID,
    origin: {
      codexThreadId: "thread-1",
      codexTurnId: null,
      cwd: ROOT,
      repoRoot: ROOT,
      branch: "codex/claude-agent-bridge",
      head: "c14ec0381e044fcaad0a0bb89f4a7437a5f3656a"
    },
    worker: {
      provider: "anthropic",
      model: "user-selected-model",
      agent: "reviewer",
      inlineAgents: null,
      customAgentsFile: null,
      pluginDirs: [],
      mcpConfigPaths: [],
      addDirs: [],
      settingSources: [],
      effort: "high",
      resolvedRuntimeVersion: "2.1.207"
    },
    execution: {
      profile: "standard",
      executor: "tmux",
      tmuxSession: "ccb-phase0",
      workspaceMode: "current",
      requestedWorkspacePath: ROOT,
      canonicalWorkspacePath: ROOT,
      permittedRoot: ROOT,
      claudeSessionId: CLAUDE_SESSION_ID,
      sandboxAttestation: null,
      timeoutSeconds: 900,
      effectiveClaudePermissionArgs: ["--setting-sources=", "--permission-mode", "default"]
    },
    task: { promptFile: "prompt.md", acceptance: ["tests pass"] }
  };
  return { ...request, ...overrides };
}

function compileSchemas() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return Object.fromEntries(Object.keys(SCHEMA_FILES).map((name) => [name, ajv.compile(readSchema(name))]));
}

test("bridge schemas are strict versioned object contracts", () => {
  for (const name of Object.keys(SCHEMA_FILES)) {
    assert.equal(readSchema(name).$schema, "https://json-schema.org/draft/2020-12/schema");
    const schema = readV1Branch(name);
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.ok(schema.required.includes("schemaVersion"));
    assert.deepEqual(schema.properties.schemaVersion, { const: 1 });
  }
});

test("result contract defines filesChanged as worker mutations, not review scope", () => {
  const description = readV1Branch("result").properties.filesChanged.description;
  assert.match(description, /contents, type, or existence this worker actually changed during this job/);
  assert.match(description, /Excludes files only reviewed or inspected/);
  assert.match(description, /read-only and no-edit jobs report an empty array/);
});

test("delegation request schema captures immutable origin, worker, execution, and task contracts", () => {
  const schema = readV1Branch("request");
  assert.deepEqual(schema.required, ["schemaVersion", "jobId", "origin", "worker", "execution", "task"]);
  assert.deepEqual(schema.$defs.jobId.pattern, "^ccb_[0-9A-HJKMNP-TV-Z]{26}$");
  assert.deepEqual(schema.properties.origin.required, [
    "codexThreadId", "codexTurnId", "cwd", "repoRoot", "branch", "head"
  ]);
  for (const key of ["provider", "model", "agent", "effort"]) {
    assert.ok(schema.properties.worker.required.includes(key), `worker requires ${key}`);
  }
  for (const key of ["inlineAgents", "customAgentsFile", "pluginDirs", "mcpConfigPaths", "addDirs", "settingSources", "resolvedRuntimeVersion"]) {
    assert.ok(schema.properties.worker.required.includes(key), `worker requires ${key}`);
  }
  for (const key of ["requestedWorkspacePath", "canonicalWorkspacePath", "permittedRoot", "claudeSessionId", "sandboxAttestation"]) {
    assert.ok(schema.properties.execution.required.includes(key), `execution requires ${key}`);
  }
  assert.deepEqual(schema.properties.execution.properties.profile.enum, Object.keys(BRIDGE_TRUST_PROFILES));
  assert.deepEqual(schema.properties.task.required, ["promptFile", "acceptance"]);
});

test("event schema defines ordered, deduplicated bridge messages", () => {
  const schema = readV1Branch("event");
  assert.deepEqual(schema.required, [
    "schemaVersion", "jobId", "sequence", "timestamp", "type", "sender", "deduplicationKey", "payload"
  ]);
  assert.equal(schema.properties.sequence.minimum, 1);
  assert.deepEqual(schema.properties.type.enum, [
    "accepted", "started", "progress", "question", "codex_message", "claude_message",
    "blocked", "completed", "failed", "cancel_requested", "cancelled", "verified"
  ]);
  assert.deepEqual(schema.properties.sender.enum, ["bridge", "codex", "claude", "verifier"]);
});

test("message-operation schema makes bidirectional delivery durable and correlated", () => {
  const schema = readV1Branch("messageOperation");
  assert.deepEqual(schema.required, [
    "schemaVersion", "jobId", "sequence", "kind", "state", "messageId", "deduplicationKey",
    "timestamp", "text", "inReplyTo", "continuation"
  ]);
  assert.deepEqual(schema.properties.kind.enum, ["codex_message", "codex_applied", "claude_message"]);
  assert.deepEqual(schema.properties.state.enum, ["pending", "applied", "ack"]);
  assert.equal(schema.properties.sequence.minimum, 1);
  assert.equal(schema.properties.continuation.oneOf[1].additionalProperties, false);
  assert.deepEqual(schema.properties.continuation.oneOf[1].required, [
    "kind", "boundaryId", "fromClaudeSessionId", "toClaudeSessionId", "ordinal", "recordedAt"
  ]);
});

test("result and receipt schemas separate completion from delivery acknowledgement and verification", () => {
  const result = readV1Branch("result");
  assert.deepEqual(result.required, [
    "schemaVersion", "jobId", "status", "summary", "filesChanged", "commandsRun", "testsRun",
    "findings", "blockers", "claudeSessionId", "exitStatus", "artifactPaths"
  ]);
  assert.deepEqual(result.properties.status.enum, ["completed", "failed", "cancelled"]);

  const receipt = readV1Branch("receipt");
  assert.deepEqual(receipt.required, [
    "schemaVersion", "jobId", "createdAt", "workerState", "workerError", "delivery", "verification", "profile", "effectiveClaudePermissionArgs"
  ]);
  assert.deepEqual(receipt.properties.workerState.enum, [
    "accepted", "running", "stalled", "completed", "failed", "cancelled"
  ]);
  assert.deepEqual(receipt.properties.delivery.properties.state.enum, ["pending", "delivered", "acknowledged", "failed"]);
  assert.deepEqual(receipt.properties.verification.properties.state.enum, ["pending", "passed", "failed", "skipped"]);
});

test("all four trust profiles resolve to exact Claude permission arguments", () => {
  const workspacePath = ROOT;

  assert.deepEqual(resolveBridgePolicy({ profile: "review-readonly", workspacePath }).claudeArgs, [
    "--setting-sources=",
    "--tools", "Read", "Glob", "Grep", "Task", "WebFetch", "WebSearch",
    "--allowedTools", "Read", "Glob", "Grep", "Task", "WebSearch", ...buildWebFetchAllowlist(),
    "--disallowedTools", "Edit", "Write", "NotebookEdit",
    "--permission-mode", "default",
    "--strict-mcp-config"
  ]);
  assert.deepEqual(resolveBridgePolicy({ profile: "standard", workspacePath }).claudeArgs, [
    "--permission-mode", "default"
  ]);
  assert.deepEqual(resolveBridgePolicy({ profile: "trusted-autonomous", workspacePath }).claudeArgs, [
    "--permission-mode", "bypassPermissions"
  ]);
  assert.throws(() => resolveBridgePolicy({
    profile: "sandbox-autonomous",
    jobId: JOB_ID,
    executor: "tmux",
    sandboxAuthority: "bridge-tmux-executor",
    workspacePath,
    sandboxAttestation: sandboxAttestation()
  }), /unavailable.*executor-owned provenance verification.*not implemented/i);
});

test("policy canonicalizes real directories and enforces a canonical permitted-root boundary", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-policy-"));
  const permitted = path.join(temp, "permitted");
  const workspace = path.join(permitted, "workspace");
  const outside = path.join(temp, "outside");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(outside);
  const alias = path.join(permitted, "alias");
  fs.symlinkSync(workspace, alias, "dir");
  const escape = path.join(permitted, "escape");
  fs.symlinkSync(outside, escape, "dir");

  try {
    const policy = resolveBridgePolicy({ profile: "standard", workspacePath: alias, permittedRoot: permitted });
    assert.equal(policy.requestedWorkspacePath, alias);
    assert.equal(policy.canonicalWorkspacePath, fs.realpathSync(workspace));
    assert.equal(policy.workspacePath, fs.realpathSync(workspace));
    assert.throws(
      () => resolveBridgePolicy({ profile: "standard", workspacePath: escape, permittedRoot: permitted }),
      /outside permittedRoot/
    );
    assert.throws(
      () => resolveBridgePolicy({ profile: "standard", workspacePath: path.join(temp, "missing") }),
      /existing directory/
    );
    const file = path.join(temp, "file");
    fs.writeFileSync(file, "x");
    assert.throws(() => resolveBridgePolicy({ profile: "standard", workspacePath: file }), /existing directory/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("autonomous profiles require explicit canonical workspace and sandbox autonomy fails closed", () => {
  assert.throws(
    () => resolveBridgePolicy({ profile: "trusted-autonomous", workspacePath: "relative/path" }),
    /absolute workspacePath/
  );
  assert.throws(
    () => resolveBridgePolicy({ profile: "sandbox-autonomous", workspacePath: ROOT }),
    /unavailable.*provenance verification.*not implemented/i
  );
  assert.throws(
    () => resolveBridgePolicy({
      profile: "sandbox-autonomous", workspacePath: ROOT, jobId: JOB_ID, executor: "tmux",
      sandboxAuthority: "bridge-tmux-executor",
      sandboxAttestation: sandboxAttestation({ canonicalWorkspacePath: path.dirname(ROOT) })
    }),
    /unavailable.*provenance verification.*not implemented/i
  );
  assert.throws(
    () => resolveBridgePolicy({
      profile: "trusted-autonomous", workspacePath: ROOT,
      sandboxAttestation: sandboxAttestation()
    }),
    /forbids sandbox attestation/
  );
  for (const overrides of [
    { authority: "attacker-chosen-authority" },
    { issuedAt: "2099-07-18T12:00:00.000Z" },
    { attackerPayload: "self-attested" }
  ]) {
    assert.throws(
      () => resolveBridgePolicy({
        profile: "sandbox-autonomous", workspacePath: ROOT, jobId: JOB_ID, executor: "tmux",
        sandboxAuthority: "bridge-tmux-executor",
        sandboxAttestation: sandboxAttestation(overrides)
      }),
      /unavailable.*executor-owned provenance verification.*not implemented/i
    );
  }
  assert.throws(
    () => resolveBridgePolicy({ profile: "sandbox-autonomous", workspacePath: ROOT, sandboxed: true }),
    /sandboxed booleans are not accepted/
  );
});

test("published policy values are deeply immutable", () => {
  const policy = resolveBridgePolicy({ profile: "standard", workspacePath: ROOT, requestedTools: ["Read"] });
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.claudeArgs));
  assert.ok(Object.isFrozen(BRIDGE_TRUST_PROFILES));
  assert.ok(Object.isFrozen(BRIDGE_TRUST_PROFILES.standard));
  assert.ok(Object.isFrozen(BRIDGE_TRUST_PROFILES.standard.claudeArgs));
  assert.ok(Object.isFrozen(BRIDGE_AGENT_PRESETS));
  assert.throws(() => policy.claudeArgs.push("--dangerously-skip-permissions"), TypeError);
  assert.throws(() => { BRIDGE_AGENT_PRESETS.reviewer.agent = "mutated"; }, TypeError);
});

test("policy validation rejects contradictory permission and tool combinations", () => {
  assert.throws(
    () => resolveBridgePolicy({ profile: "review-readonly", workspacePath: ROOT, requestedTools: ["Write"] }),
    /review-readonly.*Write/
  );
  for (const tool of ["Bash", "mcp__filesystem__read_file", "CustomRead", "WebFetch", "WebFetch(https://evil.example/*)"]) {
    assert.throws(
      () => resolveBridgePolicy({ profile: "review-readonly", workspacePath: ROOT, requestedTools: [tool] }),
      new RegExp(`review-readonly.*${tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  }
  assert.doesNotThrow(() => resolveBridgePolicy({
    profile: "review-readonly",
    workspacePath: ROOT,
    requestedTools: ["Read", "Task", ...buildWebFetchAllowlist().slice(0, 2)]
  }));
  assert.throws(
    () => resolveBridgePolicy({ profile: "review-readonly", workspacePath: ROOT, permissionMode: "bypassPermissions" }),
    /requires permissionMode "default"/
  );
  assert.throws(
    () => resolveBridgePolicy({ profile: "standard", workspacePath: ROOT, permissionMode: "bypassPermissions" }),
    /requires permissionMode "default"/
  );
  assert.throws(
    () => resolveBridgePolicy({ profile: "trusted-autonomous", workspacePath: ROOT, permissionMode: "default" }),
    /requires permissionMode "bypassPermissions"/
  );
});

test("bridge agent preset registry exposes the six promised roles without hard-coded model IDs", () => {
  assert.deepEqual(Object.keys(BRIDGE_AGENT_PRESETS), [
    "implementer", "debugger", "reviewer", "security-reviewer", "researcher", "elite-reviewer"
  ]);
  for (const [name, preset] of Object.entries(BRIDGE_AGENT_PRESETS)) {
    assert.equal(preset.agent, name);
    assert.equal(typeof preset.description, "string");
    assert.ok(preset.description.length > 0);
    assert.ok(Object.hasOwn(BRIDGE_TRUST_PROFILES, preset.defaultProfile));
    assert.equal(Object.hasOwn(preset, "model"), false);
  }
  assert.equal(BRIDGE_AGENT_PRESETS.reviewer.defaultProfile, "review-readonly");
  assert.equal(BRIDGE_AGENT_PRESETS["security-reviewer"].defaultProfile, "review-readonly");
  assert.equal(BRIDGE_AGENT_PRESETS["elite-reviewer"].defaultProfile, "review-readonly");
});

test("bridge capability documentation contrasts the three product generations and defines trusted autonomy", () => {
  const docs = fs.readFileSync(path.join(ROOT, "docs", "bridge-capabilities.md"), "utf8");
  assert.match(docs, /\| Capability \| Direct `claude` CLI \| Legacy workspace\/review lanes \| Durable bridge \|/);
  assert.match(docs, /contract shipped in\s+`codex-claude-companion@1\.2\.0`/i);
  assert.match(docs, /`codex-claude-companion@1\.2\.0` is the current stable release on npm\s+dist-tag `latest`/i);
  assert.doesNotMatch(docs, /contract prepared for|Publication requires separate\s+approval/i);
  assert.match(docs, /earlier stable\s+`codex-plugin-cc@1\.1\.1` package does not contain\s+this work/i);
  assert.match(docs, /## Exact meaning of `trusted-autonomous`/);
  assert.match(docs, /`--permission-mode bypassPermissions`/);
  assert.match(docs, /existing absolute workspace path/);
  assert.match(docs, /does not authorize public publishing, deployment,[\s\S]*credential changes, or destructive host actions/i);
  assert.match(docs, /completion, delivery, acknowledgement, and verification are separate states/i);
  assert.match(docs, /executor-produced structured attestation/i);
  assert.match(docs, /`sandbox-autonomous` is unavailable/i);
  assert.match(docs, /authority, freshness, exact job\/executor\/workspace binding/i);
});

test("Draft 2020-12 schemas compile and accept or reject representative contracts", () => {
  const validators = compileSchemas();
  const request = sampleRequest();
  assert.equal(validators.request(request), true, JSON.stringify(validators.request.errors));

  const wrongArgs = structuredClone(request);
  wrongArgs.execution.effectiveClaudePermissionArgs = ["--setting-sources=", "--permission-mode", "bypassPermissions"];
  assert.equal(validators.request(wrongArgs), false);

  for (const [profile, args, expected] of [
    ["trusted-autonomous", ["--setting-sources=", "--permission-mode", "bypassPermissions"], true],
    ["trusted-autonomous", ["--setting-sources=", "--permission-mode", "default"], false],
    ["review-readonly", ["--permission-mode", "default"], false]
  ]) {
    const candidate = structuredClone(request);
    candidate.execution.profile = profile;
    candidate.execution.effectiveClaudePermissionArgs = args;
    assert.equal(validators.request(candidate), expected, `${profile} args invariant`);
  }

  const noTmuxSession = structuredClone(request);
  noTmuxSession.execution.tmuxSession = null;
  assert.equal(validators.request(noTmuxSession), false);

  const native = structuredClone(request);
  native.execution.executor = "native-background";
  native.execution.tmuxSession = null;
  assert.equal(validators.request(native), true, JSON.stringify(validators.request.errors));

  const sandbox = structuredClone(request);
  sandbox.execution.profile = "sandbox-autonomous";
  sandbox.execution.effectiveClaudePermissionArgs = ["--setting-sources=", "--permission-mode", "bypassPermissions"];
  sandbox.execution.sandboxAttestation = sandboxAttestation();
  assert.equal(validators.request(sandbox), true, JSON.stringify(validators.request.errors));
  const sandboxWithExtraAttestationPayload = structuredClone(sandbox);
  sandboxWithExtraAttestationPayload.execution.sandboxAttestation.attackerPayload = "self-attested";
  assert.equal(validators.request(sandboxWithExtraAttestationPayload), false);

  const trustedWithAttestation = structuredClone(sandbox);
  trustedWithAttestation.execution.profile = "trusted-autonomous";
  assert.equal(validators.request(trustedWithAttestation), false);

  const event = {
    schemaVersion: 1, jobId: JOB_ID, sequence: 1, timestamp: "2026-07-18T12:00:00Z",
    type: "question", sender: "claude", deduplicationKey: "q-1",
    payload: { questionId: "q-1", text: "Proceed?" }
  };
  assert.equal(validators.event(event), true, JSON.stringify(validators.event.errors));
  assert.equal(validators.event({ ...event, sender: "codex" }), false);
  assert.equal(validators.event({ ...event, payload: { text: "missing id" } }), false);

  const result = {
    schemaVersion: 1, jobId: JOB_ID, status: "completed", summary: "Phase 0 complete",
    filesChanged: ["scripts/lib/bridge-policy.mjs"],
    commandsRun: [{ command: "npm test", status: "passed", exitCode: 0 }],
    testsRun: [{ command: "node --test test/bridge-contracts.test.mjs", status: "passed", summary: "all passed" }],
    findings: [], blockers: [], claudeSessionId: CLAUDE_SESSION_ID,
    exitStatus: { code: 0, signal: null }, artifactPaths: [path.join(ROOT, "result.json")]
  };
  assert.equal(validators.result(result), true, JSON.stringify(validators.result.errors));
  for (const mutate of [
    (candidate) => { candidate.status = "delivered"; },
    (candidate) => { candidate.commandsRun[0].extra = "not allowed"; },
    (candidate) => { candidate.testsRun[0].status = "unknown"; },
    (candidate) => { candidate.artifactPaths = ["relative/result.json"]; },
    (candidate) => { delete candidate.exitStatus.signal; }
  ]) {
    const invalid = structuredClone(result);
    mutate(invalid);
    assert.equal(validators.result(invalid), false, "invalid result fixture must be rejected");
  }

  const receipt = {
    schemaVersion: 1, jobId: JOB_ID, createdAt: "2026-07-18T12:00:00Z", workerState: "completed", workerError: null,
    delivery: { state: "acknowledged", attempts: 1, deliveredAt: "2026-07-18T12:01:00Z", acknowledgedAt: "2026-07-18T12:02:00Z", lastError: null },
    verification: { state: "passed", verifiedAt: "2026-07-18T12:03:00Z", evidence: ["npm test"] },
    profile: "standard", effectiveClaudePermissionArgs: ["--setting-sources=", "--permission-mode", "default"]
  };
  assert.equal(validateBridgeReceiptContract(receipt), receipt);
  assert.throws(
    () => validateBridgeReceiptContract({}),
    (error) => error instanceof BridgeContractValidationError && error.phase === "schema" && /required property/.test(error.message)
  );
  const failedWithoutError = structuredClone(receipt);
  failedWithoutError.workerState = "failed";
  assert.equal(validators.receipt(failedWithoutError), false);
  const verifiedWithoutEvidence = structuredClone(receipt);
  verifiedWithoutEvidence.verification.evidence = [];
  assert.equal(validators.receipt(verifiedWithoutEvidence), false);
  for (const mutate of [
    (candidate) => { candidate.workerState = "accepted"; candidate.delivery.state = "delivered"; candidate.delivery.acknowledgedAt = null; candidate.verification = { state: "pending", verifiedAt: null, evidence: [] }; },
    (candidate) => { candidate.workerState = "running"; candidate.delivery = { state: "pending", attempts: 0, deliveredAt: null, acknowledgedAt: null, lastError: null }; },
    (candidate) => { candidate.workerState = "stalled"; candidate.delivery.state = "acknowledged"; candidate.verification = { state: "pending", verifiedAt: null, evidence: [] }; },
    (candidate) => { candidate.delivery.attempts = 0; },
    (candidate) => { candidate.delivery.acknowledgedAt = null; },
    (candidate) => { candidate.delivery.state = "failed"; candidate.delivery.attempts = 0; candidate.delivery.deliveredAt = null; candidate.delivery.acknowledgedAt = null; candidate.delivery.lastError = "callback failed"; },
    (candidate) => { candidate.delivery.state = "failed"; candidate.delivery.deliveredAt = null; candidate.delivery.acknowledgedAt = "2026-07-18T12:02:00Z"; candidate.delivery.lastError = "callback failed"; },
    (candidate) => { candidate.workerState = "cancelled"; candidate.verification.state = "failed"; }
  ]) {
    const invalid = structuredClone(receipt);
    mutate(invalid);
    assert.throws(
      () => validateBridgeReceiptContract(invalid),
      (error) => error instanceof BridgeContractValidationError && error.phase === "schema",
      "impossible receipt fixture must be rejected"
    );
  }

  for (const [label, mutate] of [
    ["delivery before receipt creation", (candidate) => { candidate.delivery.deliveredAt = "2026-07-18T11:59:59Z"; }],
    ["acknowledgement before delivery", (candidate) => { candidate.delivery.acknowledgedAt = "2026-07-18T12:00:30Z"; }]
  ]) {
    const invalid = structuredClone(receipt);
    mutate(invalid);
    assert.equal(validators.receipt(invalid), true, `${label} is structurally valid`);
    assert.throws(
      () => validateBridgeReceiptContract(invalid),
      /chronology is invalid/,
      `${label} must fail semantic validation`
    );
  }

  const verifiedBeforeDeliveryAndAcknowledgement = structuredClone(receipt);
  verifiedBeforeDeliveryAndAcknowledgement.verification.verifiedAt = "2026-07-18T12:00:30Z";
  assert.equal(
    validateBridgeReceiptContract(verifiedBeforeDeliveryAndAcknowledgement),
    verifiedBeforeDeliveryAndAcknowledgement,
    "verification is independent of the later delivery and acknowledgement chain"
  );

  const verifiedWhileDeliveryPending = structuredClone(receipt);
  verifiedWhileDeliveryPending.delivery = {
    state: "pending", attempts: 0, deliveredAt: null, acknowledgedAt: null, lastError: null
  };
  verifiedWhileDeliveryPending.verification.verifiedAt = "2026-07-18T12:00:30Z";
  assert.equal(validateBridgeReceiptContract(verifiedWhileDeliveryPending), verifiedWhileDeliveryPending);

  const equalTimestamps = structuredClone(receipt);
  equalTimestamps.delivery.deliveredAt = equalTimestamps.createdAt;
  equalTimestamps.delivery.acknowledgedAt = equalTimestamps.createdAt;
  equalTimestamps.verification.verifiedAt = equalTimestamps.createdAt;
  assert.equal(validateBridgeReceiptContract(equalTimestamps), equalTimestamps, "nondecreasing chronology permits equal timestamps");

  const verifiedBeforeCreation = structuredClone(receipt);
  verifiedBeforeCreation.delivery = {
    state: "pending", attempts: 0, deliveredAt: null, acknowledgedAt: null, lastError: null
  };
  verifiedBeforeCreation.verification.verifiedAt = "2026-07-18T11:59:59Z";
  assert.equal(validators.receipt(verifiedBeforeCreation), true, JSON.stringify(validators.receipt.errors));
  assert.throws(
    () => validateBridgeReceiptContract(verifiedBeforeCreation),
    /verifiedAt must not precede createdAt/,
    "missing intermediate lifecycle timestamps must not bypass creation chronology"
  );
});

test("migration documentation allows the existing-package RC and the unscoped cutover", () => {
  const docs = fs.readFileSync(path.join(ROOT, "docs", "bridge-migration.md"), "utf8");
  assert.match(docs, /Codex-Claude Bridge/);
  assert.match(docs, /codex-claude/);
  assert.match(docs, /legacy shim/i);
  assert.match(docs, /OpenAI-derived/i);
  assert.match(docs, /canonical repository and npm package name is `codex-claude-companion`/i);
  assert.match(docs, /`@kenmege\/codex-claude-bridge` as the candidate\. It is SUPERSEDED/i);
  assert.match(docs, /unscoped\s+`codex-claude-bridge` name is already occupied/i);
  assert.match(docs, /existing-package prerelease verdict:\s*approved/i);
  assert.match(docs, /unscoped cutover verdict:\s*ready/i);
  assert.match(docs, /GitHub repository rename to `codex-claude-companion` is complete/i);
});
