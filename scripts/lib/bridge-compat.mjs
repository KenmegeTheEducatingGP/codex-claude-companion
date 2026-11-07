// Reads every persisted bridge contract version into one internal layout.
//
// The internal layout is exactly the schemaVersion 2 field layout; `schemaVersion`
// keeps the version the document was persisted with, so a 1.x job already in flight
// still runs under 1.x semantics. Version 1 is read forever: a 1.x Codex thread id
// becomes a Codex origin, the worker is Claude and the verifier is Codex.

import { isDeepStrictEqual } from "node:util";

import {
  BridgeContractValidationError,
  validateBridgeRequestContract,
  validateBridgeResultContract
} from "./bridge-contracts.mjs";

/** Routing provenance recorded for a 1.x request, whose model and effort were fixed when it was built. */
export const V1_ROUTING = Object.freeze({
  source: "flag",
  reason: "schemaVersion 1 request: model and effort were fixed at delegation."
});

// The only verifier a 1.x job ever had: Codex's read-only review.
const V1_VERIFICATION = Object.freeze({ family: "codex", profile: "review-readonly" });

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function cannotExpress(kind, reasons) {
  return new BridgeContractValidationError(
    `Bridge ${kind} cannot be expressed as a schemaVersion 1 ${kind}: ${reasons.join("; ")}.`,
    { phase: "semantics" }
  );
}

/**
 * Validate a persisted delegation request of any supported version and return it in
 * the internal (schemaVersion 2) layout, deep-frozen and never aliasing the input.
 *
 * @throws {BridgeContractValidationError} when the document is not a valid request
 */
export function toInternalRequest(document) {
  validateBridgeRequestContract(document);
  const request = structuredClone(document);
  if (request.schemaVersion !== 1) return deepFreeze(request);
  const { origin, worker, execution, task } = request;
  return deepFreeze({
    schemaVersion: 1,
    jobId: request.jobId,
    origin: {
      family: "codex",
      threadId: origin.codexThreadId,
      turnId: origin.codexTurnId,
      cwd: origin.cwd,
      repoRoot: origin.repoRoot,
      branch: origin.branch,
      head: origin.head,
      accountHome: null
    },
    worker: {
      family: "claude",
      provider: worker.provider,
      model: worker.model,
      effort: worker.effort,
      agent: worker.agent,
      resolvedRuntimeVersion: worker.resolvedRuntimeVersion,
      claude: {
        inlineAgents: worker.inlineAgents,
        customAgentsFile: worker.customAgentsFile,
        pluginDirs: worker.pluginDirs,
        mcpConfigPaths: worker.mcpConfigPaths,
        addDirs: worker.addDirs,
        settingSources: worker.settingSources
      }
    },
    execution: {
      profile: execution.profile,
      executor: execution.executor,
      tmuxSession: execution.tmuxSession,
      workspaceMode: execution.workspaceMode,
      requestedWorkspacePath: execution.requestedWorkspacePath,
      canonicalWorkspacePath: execution.canonicalWorkspacePath,
      permittedRoot: execution.permittedRoot,
      workerSessionId: execution.claudeSessionId,
      sandboxAttestation: execution.sandboxAttestation,
      timeoutSeconds: execution.timeoutSeconds,
      effectiveWorkerArgs: execution.effectiveClaudePermissionArgs
    },
    verification: { ...V1_VERIFICATION },
    task: { promptFile: task.promptFile, acceptance: task.acceptance, family: null, continuesJobId: null },
    routing: { ...V1_ROUTING }
  });
}

function v1RequestBlockers(internal) {
  const reasons = [];
  if (internal.origin?.family !== "codex") reasons.push("the origin is not Codex");
  if (internal.origin?.accountHome !== null) reasons.push("the origin names an account home");
  if (internal.worker?.family !== "claude") reasons.push("the worker is not Claude");
  if (internal.worker?.model === null) reasons.push("the host decides the model");
  if (internal.worker?.effort === null) reasons.push("the host decides the effort");
  if (internal.execution?.profile === "host") reasons.push("the host profile does not exist in 1.x");
  if (!isDeepStrictEqual(internal.verification, V1_VERIFICATION)) reasons.push("the verifier is not the Codex read-only review");
  if (internal.task?.family !== null) reasons.push("the task names a task family");
  if (internal.task?.continuesJobId !== null) reasons.push("the task continues an earlier job");
  if (!isDeepStrictEqual(internal.routing, V1_ROUTING)) reasons.push("routing was resolved by the 2.x resolver");
  return reasons;
}

/**
 * Convert an internal-layout request back to a schemaVersion 1 document. Only a
 * request that 1.x can express converts; anything else is refused, never truncated.
 *
 * @throws {BridgeContractValidationError} when the request cannot be expressed in 1.x
 */
export function toV1Request(internal) {
  const reasons = v1RequestBlockers(internal);
  if (reasons.length > 0) throw cannotExpress("request", reasons);
  const { origin, worker, execution, task } = structuredClone(internal);
  const request = {
    schemaVersion: 1,
    jobId: internal.jobId,
    origin: {
      codexThreadId: origin.threadId,
      codexTurnId: origin.turnId,
      cwd: origin.cwd,
      repoRoot: origin.repoRoot,
      branch: origin.branch,
      head: origin.head
    },
    worker: {
      provider: worker.provider,
      model: worker.model,
      agent: worker.agent,
      inlineAgents: worker.claude.inlineAgents,
      customAgentsFile: worker.claude.customAgentsFile,
      pluginDirs: worker.claude.pluginDirs,
      mcpConfigPaths: worker.claude.mcpConfigPaths,
      addDirs: worker.claude.addDirs,
      settingSources: worker.claude.settingSources,
      effort: worker.effort,
      resolvedRuntimeVersion: worker.resolvedRuntimeVersion
    },
    execution: {
      profile: execution.profile,
      executor: execution.executor,
      tmuxSession: execution.tmuxSession,
      workspaceMode: execution.workspaceMode,
      requestedWorkspacePath: execution.requestedWorkspacePath,
      canonicalWorkspacePath: execution.canonicalWorkspacePath,
      permittedRoot: execution.permittedRoot,
      claudeSessionId: execution.workerSessionId,
      sandboxAttestation: execution.sandboxAttestation,
      timeoutSeconds: execution.timeoutSeconds,
      effectiveClaudePermissionArgs: execution.effectiveWorkerArgs
    },
    task: { promptFile: task.promptFile, acceptance: task.acceptance }
  };
  validateBridgeRequestContract(request);
  return deepFreeze(request);
}

/**
 * Validate a worker result of any supported version and return it in the internal
 * (schemaVersion 2) layout, deep-frozen and never aliasing the input.
 *
 * @throws {BridgeContractValidationError} when the document is not a valid result
 */
export function toInternalResult(document) {
  validateBridgeResultContract(document);
  const result = structuredClone(document);
  if (result.schemaVersion !== 1) return deepFreeze(result);
  const { claudeSessionId, ...rest } = result;
  return deepFreeze({ ...rest, workerFamily: "claude", workerSessionId: claudeSessionId, plan: null });
}

/**
 * Convert an internal-layout result back to a schemaVersion 1 document.
 *
 * @throws {BridgeContractValidationError} when the result cannot be expressed in 1.x
 */
export function toV1Result(internal) {
  const reasons = [];
  if (internal?.workerFamily !== "claude") reasons.push("the worker is not Claude");
  if (internal?.plan !== null) reasons.push("the result carries a plan");
  if (reasons.length > 0) throw cannotExpress("result", reasons);
  const { workerFamily, workerSessionId, plan, ...rest } = structuredClone(internal);
  const result = { ...rest, schemaVersion: 1, claudeSessionId: workerSessionId };
  validateBridgeResultContract(result);
  return deepFreeze(result);
}
