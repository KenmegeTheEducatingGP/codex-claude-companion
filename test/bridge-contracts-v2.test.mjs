import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import * as bridgeContracts from "../scripts/lib/bridge-contracts.mjs";
import * as bridgeExtensions from "../scripts/lib/bridge-extensions.mjs";
import * as bridgePolicy from "../scripts/lib/bridge-policy.mjs";

// Namespace imports keep a missing export from failing the whole file at import time,
// so each test reports its own assertion.
const {
  BRIDGE_CONTRACT_VERSIONS,
  BridgeContractValidationError,
  validateBridgeEventContract,
  validateBridgeMessageOperationContract,
  validateBridgeReceiptContract,
  validateBridgeRequestContract,
  validateBridgeResultContract
} = bridgeContracts;
const { BRIDGE_PROFILES, resolveBridgePolicy } = bridgePolicy;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCHEMA_FILES = {
  request: "bridge-delegation-request.schema.json",
  event: "bridge-event.schema.json",
  messageOperation: "bridge-message-operation.schema.json",
  result: "bridge-result.schema.json",
  receipt: "bridge-receipt.schema.json"
};

// sha256 of JSON.stringify(JSON.parse(<file>)) for each schema at the 1.2.0 base commit 8b7f7cb.
// Reproduce with: git show 8b7f7cb:schemas/<file> | node -e '<parse, stringify, sha256>'.
const V1_CONTRACT_SHA256 = {
  request: "015e32dc51f61b7e7d6d4725cb20c1172a4b26712db9060ecf7e1da3786a2a69",
  event: "566c1f0dabe3e1049ba7084df6cb8ec55fa1fbeec04eaefa54b909cbd1af4eea",
  messageOperation: "22a0952976d776b0dc3e5ed0031bc6a74487a9035d5a30acbfc6b74f3cf9dbd0",
  result: "9abb43af5ecc58c11fe47060d81ca55fd78657bd54035be54be73ecd8162086d",
  receipt: "159a15322072e27005d0e8451990b97c8cd484c8b5d3e6fe00068e3dd40b4976"
};

const JOB_ID = "ccb_01J00000000000000000000000";
const OTHER_JOB_ID = "ccb_01J00000000000000000000001";
const WORKER_SESSION_ID = "00000000-0000-4000-8000-000000000001";
const ORIGIN_SESSION_ID = "00000000-0000-4000-8000-0000000000aa";
const HEAD = "c14ec0381e044fcaad0a0bb89f4a7437a5f3656a";
const CODEX_READONLY_PARAMS = { sandbox: "read-only" };
const CODEX_AUTONOMOUS_PARAMS = { sandbox: "danger-full-access", approvalPolicy: "never" };

function readSchema(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "schemas", SCHEMA_FILES[name]), "utf8"));
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

// Rebuild the standalone 1.2.0 document from the union: the v1 branch keeps every
// non-$ top-level keyword and the root keeps every 1.2.0 $defs entry in order.
function reconstructV1Contract(root) {
  const baseDefs = Object.fromEntries(Object.entries(root.$defs).filter(([key]) => !/^v[12]/.test(key)));
  const rebuilt = { $schema: root.$schema, $id: root.$id, ...root.$defs.v1 };
  if (Object.keys(baseDefs).length > 0) rebuilt.$defs = baseDefs;
  return rebuilt;
}

function claudeArgs(profile) {
  if (profile === "host") return [];
  const args = resolveBridgePolicy({ profile, workspacePath: ROOT }).claudeArgs;
  return ["--setting-sources=", ...args.filter((argument) => argument !== "--setting-sources=")];
}

function codexParams(profile) {
  return { host: {}, "review-readonly": CODEX_READONLY_PARAMS, "trusted-autonomous": CODEX_AUTONOMOUS_PARAMS }[profile];
}

function v1Request() {
  return {
    schemaVersion: 1,
    jobId: JOB_ID,
    origin: { codexThreadId: "thread-1", codexTurnId: null, cwd: ROOT, repoRoot: ROOT, branch: "feature/x", head: HEAD },
    worker: {
      provider: "anthropic", model: "user-selected-model", agent: "reviewer", inlineAgents: null,
      customAgentsFile: null, pluginDirs: [], mcpConfigPaths: [], addDirs: [], settingSources: [],
      effort: "high", resolvedRuntimeVersion: "runtime-fixture"
    },
    execution: {
      profile: "standard", executor: "tmux", tmuxSession: "ccb-phase0", workspaceMode: "current",
      requestedWorkspacePath: ROOT, canonicalWorkspacePath: ROOT, permittedRoot: ROOT,
      claudeSessionId: WORKER_SESSION_ID, sandboxAttestation: null, timeoutSeconds: 900,
      effectiveClaudePermissionArgs: ["--setting-sources=", "--permission-mode", "default"]
    },
    task: { promptFile: "prompt.md", acceptance: ["tests pass"] }
  };
}

function v2Request({ workerFamily = "claude", originFamily = "codex", profile = "host", verifierProfile = "host" } = {}) {
  const claude = workerFamily === "claude";
  return {
    schemaVersion: 2,
    jobId: JOB_ID,
    origin: {
      family: originFamily,
      threadId: originFamily === "claude" ? ORIGIN_SESSION_ID : "thread-1",
      turnId: null,
      cwd: ROOT,
      repoRoot: ROOT,
      branch: "feature/x",
      head: HEAD,
      accountHome: null
    },
    worker: {
      family: workerFamily,
      provider: claude ? "anthropic" : "openai",
      model: null,
      effort: null,
      agent: "implementer",
      resolvedRuntimeVersion: "runtime-fixture",
      ...(claude
        ? { claude: { inlineAgents: null, customAgentsFile: null, pluginDirs: [], mcpConfigPaths: [], addDirs: [], settingSources: profile === "host" ? null : [] } }
        : { codex: {} })
    },
    execution: {
      profile,
      executor: "tmux",
      tmuxSession: "ccb-phase0",
      workspaceMode: "current",
      requestedWorkspacePath: ROOT,
      canonicalWorkspacePath: ROOT,
      permittedRoot: ROOT,
      workerSessionId: claude ? WORKER_SESSION_ID : null,
      sandboxAttestation: null,
      timeoutSeconds: 900,
      ...(claude ? { effectiveWorkerArgs: claudeArgs(profile) } : { effectiveWorkerParams: codexParams(profile) })
    },
    verification: { family: claude ? "codex" : "claude", profile: verifierProfile },
    task: { promptFile: "prompt.md", acceptance: ["tests pass"], family: null, continuesJobId: null },
    routing: { source: "host", reason: "No routing rule or flag; the host configuration decides." }
  };
}

function v2Event(overrides = {}) {
  return {
    schemaVersion: 2, jobId: JOB_ID, sequence: 1, timestamp: "2026-07-18T12:00:00Z",
    type: "question", sender: "codex", deduplicationKey: "q-1",
    payload: { questionId: "q-1", text: "Approve the command?" },
    ...overrides
  };
}

function v2MessageOperation(overrides = {}) {
  return {
    schemaVersion: 2, jobId: JOB_ID, sequence: 1, kind: "claude_message", state: "pending",
    messageId: "m-1", deduplicationKey: "m-1", timestamp: "2026-07-18T12:00:00Z",
    text: "Please also cover the error path.", inReplyTo: null, continuation: null,
    ...overrides
  };
}

function v2Result(overrides = {}) {
  return {
    schemaVersion: 2, jobId: JOB_ID, workerFamily: "codex", status: "completed", summary: "Done",
    filesChanged: ["scripts/lib/example.mjs"],
    commandsRun: [{ command: "npm test", status: "passed", exitCode: 0 }],
    testsRun: [{ command: "npm test", status: "passed", summary: "all passed" }],
    findings: [], blockers: [], workerSessionId: "thread-worker-1", plan: null,
    exitStatus: { code: 0, signal: null }, artifactPaths: [path.join(ROOT, "result.json")],
    ...overrides
  };
}

function emptyEffective() {
  return { sandbox: null, approvalPolicy: null, permissionMode: null, model: null, effort: null };
}

function v2Receipt({ workerFamily = "claude", profile = "host" } = {}) {
  const claude = workerFamily === "claude";
  return {
    schemaVersion: 2,
    jobId: JOB_ID,
    createdAt: "2026-07-18T12:00:00Z",
    workerState: "completed",
    workerError: null,
    worker: {
      family: workerFamily,
      effective: claude
        ? { ...emptyEffective(), permissionMode: "bypassPermissions", model: "resolved-model" }
        : { ...emptyEffective(), sandbox: "dangerFullAccess", approvalPolicy: "never", model: "resolved-model", effort: "high" }
    },
    delivery: {
      state: "acknowledged", route: "waiter", attempts: 1,
      deliveredAt: "2026-07-18T12:01:00Z", acknowledgedAt: "2026-07-18T12:02:00Z", lastError: null
    },
    verification: {
      state: "passed", verifiedAt: "2026-07-18T12:03:00Z", evidence: ["npm test"],
      verifierFamily: claude ? "codex" : "claude",
      effective: { ...emptyEffective(), model: "resolved-verifier-model" },
      integrity: { mutated: false }
    },
    profile,
    ...(claude ? { effectiveWorkerArgs: claudeArgs(profile) } : { effectiveWorkerParams: codexParams(profile) }),
    routing: { source: "host", reason: "No routing rule or flag; the host configuration decides." },
    quota: [],
    extensions: [],
    continuesJobId: null,
    repairs: []
  };
}

// Positive control for a negative test: the unmutated fixture must be valid, so a
// rejection proves the mutation, not a validator that rejects everything.
function accepts(validate, value, message) {
  assert.equal(validate(value), value, message);
}

function rejects(validate, value, pattern, message) {
  assert.throws(
    () => validate(value),
    (error) => error instanceof BridgeContractValidationError && (pattern === undefined || pattern.test(error.message)),
    message
  );
}

test("every v1 branch is byte-identical to the 1.2.0 standalone contract", () => {
  for (const name of Object.keys(SCHEMA_FILES)) {
    const root = readSchema(name);
    assert.ok(root.$defs?.v1, `${name} keeps its v1 branch in $defs.v1`);
    assert.equal(
      sha256(JSON.stringify(reconstructV1Contract(root))),
      V1_CONTRACT_SHA256[name],
      `${name} v1 branch and 1.2.0 $defs must be unchanged`
    );
  }
});

test("each bridge contract is a oneOf union on schemaVersion with a strict v2 branch", () => {
  assert.deepEqual(BRIDGE_CONTRACT_VERSIONS, [1, 2]);
  assert.ok(Object.isFrozen(BRIDGE_CONTRACT_VERSIONS));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const name of Object.keys(SCHEMA_FILES)) {
    const root = readSchema(name);
    assert.equal(root.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(root.type, "object");
    assert.deepEqual(root.required, ["schemaVersion"]);
    assert.deepEqual(root.properties.schemaVersion, { enum: [1, 2] });
    assert.deepEqual(root.oneOf, [{ $ref: "#/$defs/v1" }, { $ref: "#/$defs/v2" }]);
    const v2 = root.$defs.v2;
    assert.equal(v2.type, "object");
    assert.equal(v2.additionalProperties, false);
    assert.ok(v2.required.includes("schemaVersion"));
    assert.deepEqual(v2.properties.schemaVersion, { const: 2 });
    assert.doesNotThrow(() => ajv.compile(root), `${name} union compiles in Ajv strict mode`);
  }
  const request = ajv.getSchema(readSchema("request").$id);
  assert.equal(request(v1Request()), true, JSON.stringify(request.errors));
  assert.equal(request(v2Request()), true, JSON.stringify(request.errors));
  assert.equal(request({ ...v2Request(), schemaVersion: 3 }), false);
  assert.equal(request({ ...v1Request(), schemaVersion: 2 }), false, "a v1-shaped document is not a v2 document");
});

test("every contract validator rejects an unsupported schemaVersion with a clear error", () => {
  const cases = [
    [validateBridgeRequestContract, v2Request()],
    [validateBridgeResultContract, v2Result()],
    [validateBridgeReceiptContract, v2Receipt()],
    [(value) => validateBridgeEventContract(value, { originFamily: "claude", workerFamily: "codex" }), v2Event()],
    [(value) => validateBridgeMessageOperationContract(value, { originFamily: "claude", workerFamily: "codex" }), v2MessageOperation()]
  ];
  for (const [validate, document] of cases) {
    for (const version of [0, 3, "2"]) {
      assert.throws(
        () => validate({ ...document, schemaVersion: version }),
        (error) => error instanceof BridgeContractValidationError && error.phase === "schema" &&
          /unsupported schemaVersion/.test(error.message) && /supported versions: 1, 2/.test(error.message)
      );
    }
  }
});

test("v2 requests carry both delegation directions and host maps to empty args and params", () => {
  for (const options of [
    { workerFamily: "claude", originFamily: "codex", profile: "host" },
    { workerFamily: "claude", originFamily: "claude", profile: "host" },
    { workerFamily: "claude", originFamily: "codex", profile: "standard" },
    { workerFamily: "claude", originFamily: "codex", profile: "review-readonly" },
    { workerFamily: "claude", originFamily: "codex", profile: "trusted-autonomous" },
    { workerFamily: "codex", originFamily: "claude", profile: "host" },
    { workerFamily: "codex", originFamily: "codex", profile: "host" },
    { workerFamily: "codex", originFamily: "claude", profile: "review-readonly" },
    { workerFamily: "codex", originFamily: "claude", profile: "trusted-autonomous" }
  ]) {
    const request = v2Request(options);
    assert.equal(validateBridgeRequestContract(request), request, JSON.stringify(options));
  }
  assert.deepEqual(v2Request({ workerFamily: "claude" }).execution.effectiveWorkerArgs, []);
  assert.deepEqual(v2Request({ workerFamily: "codex" }).execution.effectiveWorkerParams, {});
  const routed = v2Request({ workerFamily: "codex" });
  routed.worker.model = "routed-model";
  routed.worker.effort = "high";
  routed.routing = { source: "config", reason: "config routing.review" };
  routed.task.family = "review";
  assert.equal(validateBridgeRequestContract(routed), routed);
  const continued = v2Request();
  continued.task.continuesJobId = OTHER_JOB_ID;
  continued.origin.accountHome = path.join(ROOT, "account-home");
  assert.equal(validateBridgeRequestContract(continued), continued);
});

test("v2 requests enforce provider, worker-block, session, and cross-family verifier invariants", () => {
  const mutations = [
    ["same-family verification (claude)", (request) => { request.verification.family = "claude"; }],
    ["provider does not match family", (request) => { request.worker.provider = "openai"; }],
    ["codex block on a claude worker", (request) => { request.worker.codex = {}; }],
    ["claude worker without claude block", (request) => { delete request.worker.claude; }],
    ["claude worker without effectiveWorkerArgs", (request) => { delete request.execution.effectiveWorkerArgs; }],
    ["claude worker with effectiveWorkerParams", (request) => { request.execution.effectiveWorkerParams = {}; }],
    ["claude worker without a session id", (request) => { request.execution.workerSessionId = null; }],
    ["claude worker with a non-uuid session id", (request) => { request.execution.workerSessionId = "not-a-uuid"; }],
    ["unknown family", (request) => { request.worker.family = "other"; }]
  ];
  accepts(validateBridgeRequestContract, v2Request(), "control: claude worker");
  for (const [label, mutate] of mutations) {
    const request = structuredClone(v2Request());
    mutate(request);
    rejects(validateBridgeRequestContract, request, undefined, label);
  }
  accepts(validateBridgeRequestContract, v2Request({ workerFamily: "codex", originFamily: "claude" }), "control: codex worker");
  const codexMutations = [
    ["same-family verification (codex)", (request) => { request.verification.family = "codex"; }],
    ["provider does not match family", (request) => { request.worker.provider = "anthropic"; }],
    ["claude block on a codex worker", (request) => { request.worker.claude = v2Request().worker.claude; }],
    ["codex worker with effectiveWorkerArgs", (request) => { request.execution.effectiveWorkerArgs = []; }],
    ["codex worker without effectiveWorkerParams", (request) => { delete request.execution.effectiveWorkerParams; }],
    ["codex worker with a pre-assigned session", (request) => { request.execution.workerSessionId = WORKER_SESSION_ID; }]
  ];
  for (const [label, mutate] of codexMutations) {
    const request = structuredClone(v2Request({ workerFamily: "codex", originFamily: "claude" }));
    mutate(request);
    rejects(validateBridgeRequestContract, request, undefined, label);
  }
});

test("v2 profiles map to exact Claude args and exact Codex params", () => {
  const claudeCases = [
    ["host with a permission flag", "host", (request) => { request.execution.effectiveWorkerArgs = ["--permission-mode", "default"]; }],
    ["host with explicit setting sources", "host", (request) => { request.worker.claude.settingSources = []; }],
    ["standard without setting sources", "standard", (request) => { request.worker.claude.settingSources = null; }],
    ["standard with autonomous args", "standard", (request) => { request.execution.effectiveWorkerArgs = claudeArgs("trusted-autonomous"); }],
    ["review-readonly with standard args", "review-readonly", (request) => { request.execution.effectiveWorkerArgs = claudeArgs("standard"); }],
    ["trusted-autonomous with host args", "trusted-autonomous", (request) => { request.execution.effectiveWorkerArgs = []; }],
    ["trusted-autonomous with an attestation", "trusted-autonomous", (request) => {
      request.execution.sandboxAttestation = { jobId: JOB_ID, executor: "tmux", canonicalWorkspacePath: ROOT, issuedAt: "2026-07-18T12:00:00.000Z", authority: "bridge-tmux-executor" };
    }]
  ];
  for (const [label, profile, mutate] of claudeCases) {
    accepts(validateBridgeRequestContract, v2Request({ workerFamily: "claude", profile }), `control: claude ${profile}`);
    const request = structuredClone(v2Request({ workerFamily: "claude", profile }));
    mutate(request);
    rejects(validateBridgeRequestContract, request, undefined, label);
  }
  const codexCases = [
    ["host with a sandbox", "host", (request) => { request.execution.effectiveWorkerParams = { sandbox: "read-only" }; }],
    ["host with an approval policy", "host", (request) => { request.execution.effectiveWorkerParams = { approvalPolicy: "never" }; }],
    ["review-readonly with empty params", "review-readonly", (request) => { request.execution.effectiveWorkerParams = {}; }],
    ["review-readonly with an extra key", "review-readonly", (request) => { request.execution.effectiveWorkerParams = { ...CODEX_READONLY_PARAMS, approvalPolicy: "never" }; }],
    ["trusted-autonomous without approval policy", "trusted-autonomous", (request) => { request.execution.effectiveWorkerParams = { sandbox: "danger-full-access" }; }],
    ["standard is unavailable for codex", "host", (request) => { request.execution.profile = "standard"; }],
    ["sandbox-autonomous is unavailable for codex", "host", (request) => { request.execution.profile = "sandbox-autonomous"; }]
  ];
  for (const [label, profile, mutate] of codexCases) {
    accepts(validateBridgeRequestContract, v2Request({ workerFamily: "codex", originFamily: "claude", profile }), `control: codex ${profile}`);
    const request = structuredClone(v2Request({ workerFamily: "codex", originFamily: "claude", profile }));
    mutate(request);
    rejects(validateBridgeRequestContract, request, undefined, label);
  }
});

test("verifier profiles follow the verifier family's availability", () => {
  const codexVerifierStandard = v2Request({ workerFamily: "claude", verifierProfile: "standard" });
  rejects(validateBridgeRequestContract, codexVerifierStandard, undefined, "standard is not a Codex verifier profile");
  const claudeVerifierStandard = v2Request({ workerFamily: "codex", originFamily: "claude", verifierProfile: "standard" });
  assert.equal(validateBridgeRequestContract(claudeVerifierStandard), claudeVerifierStandard);
  for (const workerFamily of ["claude", "codex"]) {
    rejects(validateBridgeRequestContract, v2Request({ workerFamily, verifierProfile: "sandbox-autonomous" }), undefined, `${workerFamily} sandbox verifier`);
    for (const verifierProfile of ["host", "review-readonly", "trusted-autonomous"]) {
      const request = v2Request({ workerFamily, originFamily: "claude", verifierProfile });
      assert.equal(validateBridgeRequestContract(request), request);
    }
  }
});

test("v2 routing from the host sends no model or effort", () => {
  for (const mutate of [
    (request) => { request.worker.model = "chosen-model"; },
    (request) => { request.worker.effort = "high"; },
    (request) => { request.routing.source = "unknown"; },
    (request) => { request.routing.reason = ""; },
    (request) => { delete request.routing; }
  ]) {
    const request = structuredClone(v2Request());
    mutate(request);
    rejects(validateBridgeRequestContract, request);
  }
  for (const source of ["flag", "config", "extension"]) {
    const request = structuredClone(v2Request());
    request.worker.model = "chosen-model";
    request.routing.source = source;
    assert.equal(validateBridgeRequestContract(request), request);
  }
});

// The routing resolver reports what it adjusted after live model discovery, for example an effort the
// resolved model does not list. The request is the one record that reaches the broker, so it keeps those
// warnings in the shape the receipt keeps, and a request and a receipt can carry the same routing.
test("a v2 request records the routing warnings the resolver reports, in the receipt's own shape", () => {
  const warning = { code: "effort-unsupported", model: "model-b", effort: "high", supported: ["medium"] };
  for (const warnings of [[], [warning], [warning, { ...warning, model: null }]]) {
    const request = structuredClone(v2Request());
    request.routing = { source: "config", reason: "config routing.review", warnings };
    accepts(validateBridgeRequestContract, request, `a request routing with ${warnings.length} warning(s)`);
    const receipt = structuredClone(v2Receipt());
    receipt.routing = structuredClone(request.routing);
    accepts(validateBridgeReceiptContract, receipt, "the receipt keeps the same routing");
  }
  for (const [label, bad] of [
    ["an unknown code", { ...warning, code: "model-unsupported" }],
    ["an extra property", { ...warning, note: "x" }],
    ["a missing supported list", { code: warning.code, model: warning.model, effort: warning.effort }],
    ["an empty effort", { ...warning, effort: "" }]
  ]) {
    const request = structuredClone(v2Request());
    request.routing = { source: "config", reason: "config routing.review", warnings: [bad] };
    rejects(validateBridgeRequestContract, request, undefined, label);
  }
  const notAList = structuredClone(v2Request());
  notAList.routing = { source: "config", reason: "config routing.review", warnings: warning };
  rejects(validateBridgeRequestContract, notAList, undefined, "warnings is a list");
  // Each contract describes a warning once; the two descriptions must not drift apart.
  assert.deepEqual(
    readSchema("request").$defs.v2Routing.properties.warnings,
    readSchema("receipt").$defs.v2Routing.properties.warnings
  );
});

test("a v2 receipt names an earlier job as the one it continues, as the request does", () => {
  const continuing = structuredClone(v2Receipt());
  continuing.continuesJobId = OTHER_JOB_ID;
  accepts(validateBridgeReceiptContract, continuing, "a receipt may continue an earlier job");
  accepts(validateBridgeReceiptContract, structuredClone(v2Receipt()), "and null means it continues none");
  const selfContinuation = structuredClone(v2Receipt());
  selfContinuation.continuesJobId = JOB_ID;
  assert.throws(
    () => validateBridgeReceiptContract(selfContinuation),
    (error) => error instanceof BridgeContractValidationError && error.phase === "semantics" && /continuesJobId/.test(error.message),
    "a receipt cannot continue its own job: a persisted cycle would loop any code that follows the chain"
  );
});

test("v2 origin and task fields are validated, including continuation identity", () => {
  for (const [label, mutate] of [
    ["claude origin with a non-uuid session id", (request) => { request.origin.family = "claude"; request.origin.threadId = "thread-1"; }],
    ["relative account home", (request) => { request.origin.accountHome = "relative/home"; }],
    ["malformed task family", (request) => { request.task.family = "has spaces"; }],
    ["malformed continuation job id", (request) => { request.task.continuesJobId = "ccb_short"; }],
    ["v1 origin field in a v2 request", (request) => { request.origin.codexThreadId = "thread-1"; }]
  ]) {
    const request = structuredClone(v2Request());
    mutate(request);
    rejects(validateBridgeRequestContract, request, undefined, label);
  }
  const selfContinuation = structuredClone(v2Request());
  selfContinuation.task.continuesJobId = JOB_ID;
  assert.throws(
    () => validateBridgeRequestContract(selfContinuation),
    (error) => error instanceof BridgeContractValidationError && error.phase === "semantics" && /continuesJobId/.test(error.message)
  );
});

test("v2 events allow either family as author but bind authors to the job's families", () => {
  const claudeToCodex = { originFamily: "claude", workerFamily: "codex" };
  const question = v2Event();
  assert.equal(validateBridgeEventContract(question, claudeToCodex), question);
  for (const event of [
    v2Event({ type: "progress", sender: "codex", payload: { message: "working" } }),
    v2Event({ type: "codex_message", sender: "codex", payload: { messageId: "m-1", text: "reply" } }),
    v2Event({ type: "claude_message", sender: "claude", payload: { messageId: "m-2", text: "note" } }),
    v2Event({ type: "cancel_requested", sender: "claude", payload: { reason: "origin cancelled", requestedAt: "2026-07-18T12:00:00Z" } }),
    v2Event({ type: "verified", sender: "verifier", payload: { verdict: "passed", evidence: ["npm test"] } }),
    v2Event({ type: "accepted", sender: "bridge", payload: { acceptedAt: "2026-07-18T12:00:00Z" } })
  ]) {
    assert.equal(validateBridgeEventContract(event, claudeToCodex), event, event.type);
  }
  assert.throws(
    () => validateBridgeEventContract(v2Event({ sender: "claude" }), claudeToCodex),
    (error) => error.phase === "semantics" && /question/.test(error.message),
    "a question must come from the worker family"
  );
  assert.throws(
    () => validateBridgeEventContract(v2Event({ type: "progress", sender: "codex", payload: { message: "x" } }), { originFamily: "claude", workerFamily: "claude" }),
    (error) => error.phase === "semantics" && /codex/.test(error.message),
    "an author family must be the origin or worker family"
  );
  assert.throws(
    () => validateBridgeEventContract(question),
    (error) => error instanceof BridgeContractValidationError && /origin and worker families/.test(error.message),
    "v2 events cannot be validated without the job's families"
  );
  rejects((value) => validateBridgeEventContract(value, claudeToCodex), v2Event({ type: "codex_message", sender: "claude", payload: { messageId: "m-1", text: "x" } }));
  rejects((value) => validateBridgeEventContract(value, claudeToCodex), v2Event({ type: "accepted", sender: "codex", payload: { acceptedAt: "2026-07-18T12:00:00Z" } }));
  const v1Question = { ...v2Event({ sender: "claude" }), schemaVersion: 1 };
  assert.equal(validateBridgeEventContract(v1Question), v1Question, "v1 events need no family context");
  rejects(validateBridgeEventContract, { ...v1Question, sender: "codex" }, undefined, "v1 questions still come only from Claude");
});

test("v2 events keep each author's 1.x role: worker-side events from the worker family, a cancel request from the origin", () => {
  const payloads = {
    progress: { message: "working" },
    question: { questionId: "q-1", text: "Approve the command?" },
    blocked: { reason: "waiting for input" },
    completed: { resultPath: "/tmp/ccb/result.json" },
    failed: { error: "tests failed" },
    cancelled: { reason: "origin cancelled" },
    cancel_requested: { reason: "origin cancelled", requestedAt: "2026-07-18T12:00:00Z" }
  };
  const roleOf = (type) => (type === "cancel_requested" ? "origin" : "worker");
  // Every type either family may author in v2 has a role here, so a new one cannot arrive unbound.
  const eitherFamilyTypes = readSchema("event").$defs.v2.oneOf
    .filter((branch) => ["claude", "codex"].every((family) => branch.properties.sender.enum?.includes(family)))
    .map((branch) => branch.properties.type.const);
  assert.deepEqual(eitherFamilyTypes.sort(), Object.keys(payloads).sort());
  const semantics = (pattern) => (error) =>
    error instanceof BridgeContractValidationError && error.phase === "semantics" && pattern.test(error.message);

  for (const [originFamily, workerFamily] of [["claude", "codex"], ["codex", "claude"]]) {
    const job = { originFamily, workerFamily };
    for (const [type, payload] of Object.entries(payloads)) {
      const role = roleOf(type);
      const [author, other] = role === "worker" ? [workerFamily, originFamily] : [originFamily, workerFamily];
      accepts((value) => validateBridgeEventContract(value, job), v2Event({ type, sender: author, payload }), `${type} from the ${role}, ${author}`);
      assert.throws(
        () => validateBridgeEventContract(v2Event({ type, sender: other, payload }), job),
        semantics(new RegExp(`${type} must come from the ${role} family \\(${author}\\), not ${other}`)),
        `${type} from ${other}, which is not the job's ${role}`
      );
      if (type !== "question") {
        accepts((value) => validateBridgeEventContract(value, job), v2Event({ type, sender: "bridge", payload }), `${type} from the bridge`);
      }
    }
  }
  // A job whose origin and worker are the same family: the family holds both roles.
  for (const [type, payload] of Object.entries(payloads)) {
    accepts(
      (value) => validateBridgeEventContract(value, { originFamily: "claude", workerFamily: "claude" }),
      v2Event({ type, sender: "claude", payload }),
      `${type} in a Claude-to-Claude job`
    );
  }
  // 1.x fixed the same roles in the schema itself, with Codex always the origin and Claude always the worker.
  for (const [type, payload] of Object.entries(payloads)) {
    const [author, other] = roleOf(type) === "worker" ? ["claude", "codex"] : ["codex", "claude"];
    const v1Event = (sender) => ({ ...v2Event({ type, sender, payload }), schemaVersion: 1 });
    accepts(validateBridgeEventContract, v1Event(author), `1.x ${type} from ${author}`);
    rejects(validateBridgeEventContract, v1Event(other), undefined, `1.x ${type} from ${other}`);
  }
});

test("v2 message operations add claude_applied and bind authors to the job's families", () => {
  const claudeToCodex = { originFamily: "claude", workerFamily: "codex" };
  for (const operation of [
    v2MessageOperation(),
    v2MessageOperation({ kind: "claude_applied", state: "applied", text: null, inReplyTo: null }),
    v2MessageOperation({ kind: "codex_message", state: "ack", text: "Covered.", inReplyTo: "m-1" })
  ]) {
    assert.equal(validateBridgeMessageOperationContract(operation, claudeToCodex), operation, operation.kind);
  }
  for (const operation of [
    v2MessageOperation({ kind: "claude_applied", state: "applied", text: "text", inReplyTo: null }),
    v2MessageOperation({ kind: "codex_message", state: "ack", text: "reply", inReplyTo: null }),
    v2MessageOperation({ kind: "claude_message", state: "applied" }),
    v2MessageOperation({ kind: "other_message" })
  ]) {
    rejects((value) => validateBridgeMessageOperationContract(value, claudeToCodex), operation, undefined, JSON.stringify(operation));
  }
  assert.throws(
    () => validateBridgeMessageOperationContract(v2MessageOperation(), { originFamily: "codex", workerFamily: "codex" }),
    (error) => error.phase === "semantics" && /claude/.test(error.message)
  );
  assert.throws(
    () => validateBridgeMessageOperationContract(v2MessageOperation()),
    (error) => error instanceof BridgeContractValidationError && /origin and worker families/.test(error.message)
  );
  const v1Applied = { ...v2MessageOperation({ kind: "claude_applied", state: "applied", text: null }), schemaVersion: 1 };
  rejects(validateBridgeMessageOperationContract, v1Applied, undefined, "claude_applied is v2-only");
});

test("v2 results name the worker family and session without Claude-specific fields", () => {
  const result = v2Result();
  assert.equal(validateBridgeResultContract(result), result);
  const claudeResult = v2Result({ workerFamily: "claude", workerSessionId: WORKER_SESSION_ID, plan: "1. Reproduce. 2. Fix." });
  assert.equal(validateBridgeResultContract(claudeResult), claudeResult);
  for (const mutate of [
    (candidate) => { candidate.claudeSessionId = WORKER_SESSION_ID; },
    (candidate) => { delete candidate.workerFamily; },
    (candidate) => { delete candidate.plan; },
    (candidate) => { candidate.plan = ""; },
    (candidate) => { candidate.workerFamily = "other"; },
    (candidate) => { candidate.status = "delivered"; }
  ]) {
    const invalid = structuredClone(result);
    mutate(invalid);
    rejects(validateBridgeResultContract, invalid);
  }
});

test("v2 receipts add the waiter route, queued delivery, cross-family verifier, and integrity", () => {
  const receipt = v2Receipt();
  assert.equal(validateBridgeReceiptContract(receipt), receipt);
  const codexReceipt = v2Receipt({ workerFamily: "codex", profile: "trusted-autonomous" });
  assert.equal(validateBridgeReceiptContract(codexReceipt), codexReceipt);

  const queued = structuredClone(receipt);
  queued.delivery = { state: "queued", route: "inbox", attempts: 1, deliveredAt: null, acknowledgedAt: null, lastError: "origin-busy" };
  assert.equal(validateBridgeReceiptContract(queued), queued);

  const pending = structuredClone(receipt);
  pending.workerState = "running";
  pending.delivery = { state: "pending", route: null, attempts: 0, deliveredAt: null, acknowledgedAt: null, lastError: null };
  pending.verification = { state: "pending", verifiedAt: null, evidence: [], verifierFamily: "codex", effective: null, integrity: null };
  assert.equal(validateBridgeReceiptContract(pending), pending);

  const enriched = structuredClone(receipt);
  enriched.quota = [{ family: "claude", observedAt: "2026-07-18T12:00:30Z", reason: "rate-limited", resetsAt: "2026-07-18T17:00:00Z" }];
  enriched.extensions = [{ name: "example-extension", sha256: "a".repeat(64) }];
  enriched.continuesJobId = OTHER_JOB_ID;
  enriched.repairs = [{ attempt: 1, jobId: OTHER_JOB_ID, findings: ["missing test"], plan: "Add the test first.", verdict: "passed" }];
  assert.equal(validateBridgeReceiptContract(enriched), enriched);

  for (const [label, mutate] of [
    ["queued outside the inbox", (candidate) => { candidate.delivery = { ...queued.delivery, route: "waiter" }; }],
    ["acknowledged without a route", (candidate) => { candidate.delivery.route = null; }],
    ["unknown route", (candidate) => { candidate.delivery.route = "resume"; }],
    ["same-family verifier", (candidate) => { candidate.verification.verifierFamily = "claude"; }],
    ["passed without an integrity check", (candidate) => { candidate.verification.integrity = null; }],
    ["passed after the verifier mutated the workspace", (candidate) => { candidate.verification.integrity = { mutated: true }; }],
    ["host receipt with permission args", (candidate) => { candidate.effectiveWorkerArgs = ["--permission-mode", "default"]; }],
    ["claude receipt with codex params", (candidate) => { candidate.effectiveWorkerParams = {}; }],
    ["v1 args field in a v2 receipt", (candidate) => { candidate.effectiveClaudePermissionArgs = []; }],
    ["running worker with a queued result", (candidate) => {
      candidate.workerState = "running";
      candidate.delivery = { ...queued.delivery };
      candidate.verification = { ...pending.verification };
    }],
    ["malformed extension digest", (candidate) => { candidate.extensions = [{ name: "x", sha256: "abc" }]; }],
    ["unknown quota reason", (candidate) => { candidate.quota = [{ family: "codex", observedAt: "2026-07-18T12:00:30Z", reason: "credits-low", resetsAt: null }]; }],
    ["repair attempt zero", (candidate) => { candidate.repairs = [{ attempt: 0, jobId: OTHER_JOB_ID, findings: ["x"], plan: null, verdict: "failed" }]; }]
  ]) {
    const invalid = structuredClone(receipt);
    mutate(invalid);
    rejects(validateBridgeReceiptContract, invalid, undefined, label);
  }

  const failedVerificationAfterMutation = structuredClone(receipt);
  failedVerificationAfterMutation.verification.state = "failed";
  failedVerificationAfterMutation.verification.evidence = ["verifier-mutated-workspace"];
  failedVerificationAfterMutation.verification.integrity = { mutated: true };
  assert.equal(validateBridgeReceiptContract(failedVerificationAfterMutation), failedVerificationAfterMutation);

  const codexHostWithSandbox = v2Receipt({ workerFamily: "codex", profile: "host" });
  codexHostWithSandbox.effectiveWorkerParams = { sandbox: "read-only" };
  rejects(validateBridgeReceiptContract, codexHostWithSandbox);

  const v1Queued = {
    schemaVersion: 1, jobId: JOB_ID, createdAt: "2026-07-18T12:00:00Z", workerState: "completed", workerError: null,
    delivery: { state: "queued", attempts: 1, deliveredAt: null, acknowledgedAt: null, lastError: "origin-busy" },
    verification: { state: "passed", verifiedAt: "2026-07-18T12:03:00Z", evidence: ["npm test"] },
    profile: "standard", effectiveClaudePermissionArgs: ["--setting-sources=", "--permission-mode", "default"]
  };
  rejects(validateBridgeReceiptContract, v1Queued, undefined, "queued is a v2-only delivery state");

  const deliveredBeforeCreation = structuredClone(receipt);
  deliveredBeforeCreation.delivery.deliveredAt = "2026-07-18T11:59:59Z";
  assert.throws(
    () => validateBridgeReceiptContract(deliveredBeforeCreation),
    (error) => error.phase === "semantics" && /chronology is invalid/.test(error.message)
  );
});

test("v2 completed results name the worker's native session, a UUID for Claude", () => {
  for (const workerFamily of ["claude", "codex"]) {
    const nativeSession = workerFamily === "claude" ? WORKER_SESSION_ID : "thread-worker-1";
    accepts(validateBridgeResultContract, v2Result({ workerFamily, workerSessionId: nativeSession }), `${workerFamily} completed with its session`);
    rejects(validateBridgeResultContract, v2Result({ workerFamily, workerSessionId: null }), undefined,
      `${workerFamily} completed without a session leaves messaging and continuation unable to find the worker`);
    // A worker that failed or was cancelled may never have started a session.
    for (const status of ["failed", "cancelled"]) {
      accepts(validateBridgeResultContract, v2Result({ workerFamily, status, workerSessionId: null }), `${workerFamily} ${status} without a session`);
    }
  }
  rejects(validateBridgeResultContract, v2Result({ workerFamily: "claude", workerSessionId: "thread-worker-1" }), undefined, "a Claude session id is a UUID");
  rejects(validateBridgeResultContract, v2Result({ workerFamily: "claude", status: "failed", workerSessionId: "not-a-uuid" }), undefined,
    "a Claude session id is a UUID whatever the status");
});

test("v2 receipts record the effective settings once the worker has completed or the verifier has finished", () => {
  const receipt = v2Receipt();
  accepts(validateBridgeReceiptContract, receipt);

  // Members are null where a family reports none; the record itself still exists.
  const reportedNothing = structuredClone(receipt);
  reportedNothing.worker.effective = emptyEffective();
  reportedNothing.verification.effective = emptyEffective();
  accepts(validateBridgeReceiptContract, reportedNothing, "an all-null record means the family reported nothing");

  // Before the worker reports, and when nothing ran, null is the honest value.
  const running = structuredClone(receipt);
  running.workerState = "running";
  running.worker.effective = null;
  running.delivery = { state: "pending", route: null, attempts: 0, deliveredAt: null, acknowledgedAt: null, lastError: null };
  running.verification = { state: "pending", verifiedAt: null, evidence: [], verifierFamily: "codex", effective: null, integrity: null };
  accepts(validateBridgeReceiptContract, running, "a running worker has not reported yet");
  const failedWorker = structuredClone(running);
  failedWorker.workerState = "failed";
  failedWorker.workerError = "the worker never started";
  accepts(validateBridgeReceiptContract, failedWorker, "a worker that failed before reporting has no settings to record");
  const skipped = structuredClone(receipt);
  skipped.verification = { state: "skipped", verifiedAt: "2026-07-18T12:03:00Z", evidence: ["no verifier available"], verifierFamily: "codex", effective: null, integrity: null };
  accepts(validateBridgeReceiptContract, skipped, "a skipped verification ran no verifier");

  for (const [label, mutate] of [
    ["a completed worker without its effective settings", (candidate) => { candidate.worker.effective = null; }],
    ["a passed verification without the verifier's effective settings", (candidate) => { candidate.verification.effective = null; }],
    ["a failed verification without the verifier's effective settings", (candidate) => {
      candidate.verification.state = "failed";
      candidate.verification.evidence = ["verifier-mutated-workspace"];
      candidate.verification.integrity = { mutated: true };
      candidate.verification.effective = null;
    }]
  ]) {
    const invalid = structuredClone(receipt);
    mutate(invalid);
    rejects(validateBridgeReceiptContract, invalid, undefined, label);
  }
});

test("a skipped verification ran no verifier, so it carries no verifier settings and no integrity record", () => {
  const skipped = v2Receipt();
  skipped.verification = { state: "skipped", verifiedAt: "2026-07-18T12:03:00Z", evidence: ["no verifier available"], verifierFamily: "codex", effective: null, integrity: null };
  accepts(validateBridgeReceiptContract, skipped, "a skipped verification records that nothing ran");

  for (const [label, mutate] of [
    ["stale effective settings", (candidate) => { candidate.verification.effective = emptyEffective(); }],
    ["a stale integrity record", (candidate) => { candidate.verification.integrity = { mutated: false }; }]
  ]) {
    const invalid = structuredClone(skipped);
    mutate(invalid);
    rejects(validateBridgeReceiptContract, invalid, undefined, `a skipped verification with ${label} is a contradictory audit record`);
  }
});

test("the extension digests a v2 receipt keeps carry no path, and the recovery record keeps it", async () => {
  const { describeBridgeExtensions, loadBridgeExtensions, recordBridgeExtensions, reloadBridgeExtensions } = bridgeExtensions;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ext-receipt-")), "extension.mjs");
  fs.writeFileSync(file, `export default { apiVersion: 1, name: "example", observe() {} };`);
  const digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const loaded = await loadBridgeExtensions([file]);

  const receipt = v2Receipt();
  receipt.extensions = describeBridgeExtensions(loaded);
  assert.deepEqual(receipt.extensions, [{ name: "example", sha256: digest }]);
  accepts(validateBridgeReceiptContract, receipt, "the descriptor a receipt keeps must validate in that receipt");

  assert.equal(typeof recordBridgeExtensions, "function", "the broker's recovery record is its own export");
  const recorded = recordBridgeExtensions(loaded);
  assert.deepEqual(recorded, [{ name: "example", path: file, sha256: digest }]);
  assert.deepEqual((await reloadBridgeExtensions(recorded)).changed, [], "a recovered job re-imports the recorded path");
});

test("the v2 profile enum matches the published profile table", () => {
  const root = readSchema("request");
  assert.deepEqual(root.$defs.v2Profile.enum, Object.keys(BRIDGE_PROFILES));
  assert.deepEqual(readSchema("receipt").$defs.v2Profile.enum, Object.keys(BRIDGE_PROFILES));
});
