import fs from "node:fs";
import path from "node:path";

import crypto from "node:crypto";

import { acquireQueuedLock, writeJsonAtomic } from "./state.mjs";
import {
  assertBridgeBrokerAuthority,
  assertBridgeWorkerCapability,
  getBridgeJob,
  readBridgeRequest,
  redactBridgeValue,
  resolveBridgeJobDir,
  resolveBridgeStateRoot
} from "./bridge-state.mjs";
import { validateBridgeMessageOperationContract, validateBridgeReceiptContract } from "./bridge-contracts.mjs";
import { ORIGIN_BUSY } from "./bridge-delivery.mjs";
import { createBridgeReceipt, updateBridgeDeliveryReceipt, updateBridgeVerificationReceipt, updateBridgeWorkerReceipt } from "./bridge-receipt.mjs";

export const BRIDGE_MESSAGE_QUOTAS = Object.freeze({
  maxOperationBytes: 64 * 1024,
  maxOperations: 3_000,
  maxJournalBytes: 16 * 1024 * 1024,
  maxPendingMessages: 100,
  maxTextBytes: 60 * 1024
});

export const BRIDGE_DELIVERY_QUOTAS = Object.freeze({
  maxInboxItemBytes: 16 * 1024,
  maxInboxAttempts: 64,
  deliveryClaimTtlMs: 30 * 1_000,
  inboxClaimTtlMs: 5 * 60 * 1_000
});

// The origin's own `wait` holds this lease while it runs. A live lease makes the
// waiter the delivery route: the broker claims the delivery for it and the
// waiter acknowledges as it prints the result.
export const BRIDGE_WAITER_LEASE = Object.freeze({
  leaseMs: 30 * 1_000,
  refreshMs: 5 * 1_000
});

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function messagingPaths(jobId, options = {}) {
  const dir = resolveBridgeJobDir(jobId, options);
  return {
    journal: path.join(dir, "messages.jsonl"),
    lock: path.join(resolveBridgeStateRoot(options), "locks", `job-${jobId}`)
  };
}

function assertActive(jobId, options) {
  const state = getBridgeJob(jobId, options);
  if (TERMINAL_STATES.has(state.status)) {
    throw new Error(`Cannot mutate messages for terminal bridge job ${jobId} (${state.status})`);
  }
}

function assertRegularPrivateFile(file, { allowMissing = false } = {}) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Bridge message journal must be a regular file: ${file}`);
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error(`Bridge message journal must be private: ${file}`);
    }
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return;
    throw error;
  }
}

function readOperations(file, jobId) {
  try {
    assertRegularPrivateFile(file);
  } catch (error) {
    if (error?.code === "ENOENT" || /ENOENT/.test(error.message)) return [];
    throw error;
  }
  const bytes = fs.readFileSync(file);
  if (bytes.length > BRIDGE_MESSAGE_QUOTAS.maxJournalBytes) {
    throw new Error(`Bridge message journal exceeds ${BRIDGE_MESSAGE_QUOTAS.maxJournalBytes}-byte quota`);
  }
  const completeLength = bytes.at(-1) === 0x0a ? bytes.length : bytes.lastIndexOf(0x0a) + 1;
  const complete = bytes.subarray(0, completeLength).toString("utf8");
  const operations = complete.split("\n").filter(Boolean).map((line, index) => {
    let operation;
    try {
      operation = JSON.parse(line);
    } catch (error) {
      throw new Error(`Bridge message journal has malformed operation ${index + 1}`, { cause: error });
    }
    validateBridgeMessageOperationContract(operation);
    if (operation.jobId !== jobId || operation.sequence !== index + 1) {
      throw new Error(`Bridge message operation identity/order mismatch at sequence ${index + 1}`);
    }
    return operation;
  });
  if (operations.length > BRIDGE_MESSAGE_QUOTAS.maxOperations) {
    throw new Error(`Bridge message journal exceeds ${BRIDGE_MESSAGE_QUOTAS.maxOperations}-operation quota`);
  }
  return operations;
}

function continuationKey(value) {
  return value ? JSON.stringify(value) : "null";
}

function reduceOperations(operations) {
  const codex = new Map();
  const claude = new Map();
  const dedupe = new Map();
  const boundaries = new Map();
  const boundaryOrdinals = new Map();
  for (const operation of operations) {
    if (dedupe.has(operation.deduplicationKey)) {
      throw new Error(`Duplicate durable message deduplication key ${operation.deduplicationKey}`);
    }
    dedupe.set(operation.deduplicationKey, operation);
    if (operation.continuation) {
      const prior = boundaries.get(operation.continuation.boundaryId);
      if (prior && continuationKey(prior) !== continuationKey(operation.continuation)) {
        throw new Error(`Conflicting Claude continuation boundary ${operation.continuation.boundaryId}`);
      }
      boundaries.set(operation.continuation.boundaryId, operation.continuation);
      const ordinalBoundary = boundaryOrdinals.get(operation.continuation.ordinal);
      if (ordinalBoundary && ordinalBoundary !== operation.continuation.boundaryId) {
        throw new Error(`Conflicting Claude continuation ordinal ${operation.continuation.ordinal}`);
      }
      boundaryOrdinals.set(operation.continuation.ordinal, operation.continuation.boundaryId);
    }
    if (operation.kind === "codex_message") {
      if (codex.has(operation.messageId) || claude.has(operation.messageId)) {
        throw new Error(`Duplicate bridge message id ${operation.messageId}`);
      }
      codex.set(operation.messageId, { ...operation, applied: null, reply: null });
      continue;
    }
    if (operation.kind === "codex_applied") {
      const message = codex.get(operation.messageId);
      if (!message || message.state !== "pending") throw new Error(`Invalid applied operation for ${operation.messageId}`);
      message.state = "applied";
      message.applied = operation;
      continue;
    }
    if (claude.has(operation.messageId) || codex.has(operation.messageId)) {
      throw new Error(`Duplicate bridge message id ${operation.messageId}`);
    }
    const source = codex.get(operation.inReplyTo);
    if (!source || source.state !== "applied") throw new Error(`Invalid acknowledgement for ${operation.inReplyTo}`);
    claude.set(operation.messageId, operation);
    source.state = "ack";
    source.reply = operation;
  }
  return { codex, claude, dedupe, boundaries };
}

function assertContinuationChain(jobId, reduced, options = {}, candidate = null) {
  const boundaries = [...reduced.boundaries.values()].sort((a, b) => a.ordinal - b.ordinal);
  if (candidate && !reduced.boundaries.has(candidate.boundaryId)) boundaries.push(candidate);
  if (boundaries.length === 0) return;
  let expectedFrom = readBridgeRequest(jobId, options).execution.claudeSessionId;
  for (let index = 0; index < boundaries.length; index += 1) {
    const boundary = boundaries[index];
    if (boundary.ordinal !== index + 1) throw new Error("Claude continuation ordinals must be contiguous from 1");
    if (boundary.fromClaudeSessionId !== expectedFrom) throw new Error("Claude continuation chain does not match authoritative session identity");
    if (boundary.fromClaudeSessionId === boundary.toClaudeSessionId) throw new Error("Claude continuation must advance to a different session");
    expectedFrom = boundary.toClaudeSessionId;
  }
}

function semanticPayload(operation) {
  const { sequence: _sequence, timestamp: _timestamp, ...payload } = operation;
  return payload;
}

function normalizeInput(input, { textRequired = false, inReplyToDefault = null } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Bridge message input must be an object");
  for (const key of ["messageId", "deduplicationKey"]) {
    if (typeof input[key] !== "string" || !ID_PATTERN.test(input[key])) throw new Error(`Invalid bridge message ${key}`);
  }
  const text = input.text ?? null;
  if (textRequired && (typeof text !== "string" || text.length === 0)) throw new Error("Bridge message text is required");
  if (typeof text === "string" && Buffer.byteLength(text) > BRIDGE_MESSAGE_QUOTAS.maxTextBytes) {
    throw new Error(`Bridge message text exceeds ${BRIDGE_MESSAGE_QUOTAS.maxTextBytes}-byte quota`);
  }
  const inReplyTo = input.inReplyTo ?? inReplyToDefault;
  if (inReplyTo !== null && (typeof inReplyTo !== "string" || !ID_PATTERN.test(inReplyTo))) {
    throw new Error("Invalid bridge message inReplyTo");
  }
  return { messageId: input.messageId, deduplicationKey: input.deduplicationKey, text, inReplyTo, continuation: input.continuation ?? null };
}

function validateProspectiveOperation(jobId, operationInput) {
  validateBridgeMessageOperationContract({
    schemaVersion: 1,
    jobId,
    sequence: 1,
    timestamp: "2000-01-01T00:00:00.000Z",
    ...operationInput
  });
}

function appendOperation(jobId, operationInput, options = {}) {
  const paths = messagingPaths(jobId, options);
  const operations = readOperations(paths.journal, jobId);
  const reduced = reduceOperations(operations);
  const timestamp = options.clock ? options.clock().toISOString() : new Date().toISOString();
  const operation = redactBridgeValue({
    schemaVersion: 1,
    jobId,
    sequence: operations.length + 1,
    ...operationInput,
    timestamp
  });
  validateBridgeMessageOperationContract(operation);
  const replay = reduced.dedupe.get(operation.deduplicationKey);
  if (replay) {
    if (JSON.stringify(semanticPayload(replay)) !== JSON.stringify(semanticPayload(operation))) {
      throw new Error(`Bridge message deduplication conflict for ${operation.deduplicationKey}`);
    }
    return structuredClone(replay);
  }
  if (operations.length >= BRIDGE_MESSAGE_QUOTAS.maxOperations) throw new Error("Bridge message operation-count quota exceeded");
  const line = `${JSON.stringify(operation)}\n`;
  const lineBytes = Buffer.byteLength(line);
  if (lineBytes > BRIDGE_MESSAGE_QUOTAS.maxOperationBytes) throw new Error("Bridge message operation quota exceeded");
  assertRegularPrivateFile(paths.journal, { allowMissing: true });
  const handle = fs.openSync(paths.journal, fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    if (process.platform !== "win32") fs.fchmodSync(handle, 0o600);
    const opened = fs.fstatSync(handle);
    const current = fs.lstatSync(paths.journal);
    if (!opened.isFile() || current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error("Bridge message journal changed identity while opening");
    }
    if (opened.size + lineBytes > BRIDGE_MESSAGE_QUOTAS.maxJournalBytes) throw new Error("Bridge message journal-byte quota exceeded");
    if (opened.size > 0) {
      const bytes = Buffer.alloc(opened.size);
      fs.readSync(handle, bytes, 0, opened.size, 0);
      if (bytes.at(-1) !== 0x0a) fs.ftruncateSync(handle, bytes.lastIndexOf(0x0a) + 1);
    }
    fs.writeFileSync(handle, line, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  return structuredClone(operation);
}

function withJobMutationLock(jobId, options, callback) {
  const release = acquireQueuedLock(messagingPaths(jobId, options).lock);
  try {
    return callback();
  } finally {
    release();
  }
}

function withJobLock(jobId, options, callback) {
  return withJobMutationLock(jobId, options, () => {
    assertActive(jobId, options);
    return callback();
  });
}

export function appendCodexMessage(jobId, input, options = {}) {
  return withJobLock(jobId, options, () => {
    assertBridgeBrokerAuthority(jobId, options);
    const normalized = normalizeInput(input, { textRequired: true });
    validateProspectiveOperation(jobId, { kind: "codex_message", state: "pending", ...normalized, continuation: null });
    const current = reduceOperations(readOperations(messagingPaths(jobId, options).journal, jobId));
    assertContinuationChain(jobId, current, options, normalized.continuation);
    if (!current.dedupe.has(normalized.deduplicationKey) && normalized.inReplyTo && !current.claude.has(normalized.inReplyTo)) {
      throw new Error(`Codex message references unknown Claude message ${normalized.inReplyTo}`);
    }
    if (!current.dedupe.has(normalized.deduplicationKey) && [...current.codex.values()].filter((message) => message.state === "pending").length >= BRIDGE_MESSAGE_QUOTAS.maxPendingMessages) {
      throw new Error(`Bridge pending-message quota exceeded (${BRIDGE_MESSAGE_QUOTAS.maxPendingMessages})`);
    }
    return appendOperation(jobId, { kind: "codex_message", state: "pending", ...normalized, continuation: null }, options);
  });
}

export function markCodexMessageApplied(jobId, input, options = {}) {
  return withJobLock(jobId, options, () => {
    assertBridgeWorkerCapability(jobId, options);
    const normalized = normalizeInput(input);
    validateProspectiveOperation(jobId, { kind: "codex_applied", state: "applied", ...normalized, text: null, inReplyTo: null });
    const current = reduceOperations(readOperations(messagingPaths(jobId, options).journal, jobId));
    assertContinuationChain(jobId, current, options, normalized.continuation);
    const replay = current.dedupe.get(normalized.deduplicationKey);
    if (!replay) {
      const message = current.codex.get(normalized.messageId);
      if (!message) throw new Error(`Cannot apply unknown Codex message ${normalized.messageId}`);
      if (message.state !== "pending") throw new Error(`Codex message ${normalized.messageId} is already ${message.state}`);
    }
    return appendOperation(jobId, { kind: "codex_applied", state: "applied", ...normalized, text: null, inReplyTo: null }, options);
  });
}

export function appendClaudeMessage(jobId, input, options = {}) {
  return withJobLock(jobId, options, () => {
    assertBridgeWorkerCapability(jobId, options);
    const normalized = normalizeInput(input, { textRequired: true });
    if (!normalized.inReplyTo) throw new Error("Claude reply requires inReplyTo");
    validateProspectiveOperation(jobId, { kind: "claude_message", state: "ack", ...normalized });
    const current = reduceOperations(readOperations(messagingPaths(jobId, options).journal, jobId));
    assertContinuationChain(jobId, current, options);
    const replay = current.dedupe.get(normalized.deduplicationKey);
    if (!replay) {
      const source = current.codex.get(normalized.inReplyTo);
      if (!source) throw new Error(`Claude reply references unknown Codex message ${normalized.inReplyTo}`);
      if (source.state !== "applied") throw new Error(`Codex message ${normalized.inReplyTo} must be applied before acknowledgement`);
      if (continuationKey(source.applied.continuation) !== continuationKey(normalized.continuation)) {
        throw new Error(`Claude reply continuation does not match applied message ${normalized.inReplyTo}`);
      }
    }
    return appendOperation(jobId, { kind: "claude_message", state: "ack", ...normalized }, options);
  });
}

export function readBridgeMessages(jobId, options = {}) {
  const operations = readOperations(messagingPaths(jobId, options).journal, jobId);
  const reduced = reduceOperations(operations);
  assertContinuationChain(jobId, reduced, options);
  const messages = [...reduced.codex.values()].map((message) => structuredClone(message));
  return {
    jobId,
    semantics: "durable-queued-resume-continuations-not-live-steering",
    operations: structuredClone(operations),
    pending: messages.filter((message) => message.state === "pending"),
    applied: messages.filter((message) => message.state === "applied"),
    acknowledged: messages.filter((message) => message.state === "ack"),
    claudeMessages: structuredClone([...reduced.claude.values()]),
    continuationBoundaries: structuredClone([...reduced.boundaries.values()].sort((a, b) => a.ordinal - b.ordinal))
  };
}

function sameOrigin(left, right) {
  return ["codexThreadId", "codexTurnId", "cwd", "repoRoot", "branch", "head"]
    .every((key) => left?.[key] === right?.[key]);
}

function deliveryPath(jobId, options = {}) {
  return path.join(resolveBridgeJobDir(jobId, options), "delivery.json");
}

export function readDelivery(jobId, options = {}) {
  assertBridgeBrokerAuthority(jobId, options);
  const file = deliveryPath(jobId, options);
  try {
    assertRegularPrivateFile(file);
  } catch (error) {
    if (error?.code === "ENOENT" || /ENOENT/.test(error.message)) return null;
    throw error;
  }
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  assertDeliveryState(jobId, value);
  if (!sameOrigin(readBridgeRequest(jobId, options).origin, value.origin)) throw new Error(`Invalid durable delivery origin for ${jobId}`);
  return value;
}

function coordinationPath(jobId, options = {}) {
  return path.join(resolveBridgeJobDir(jobId, options), "coordination.json");
}

function receiptPath(jobId, options = {}) {
  return path.join(resolveBridgeJobDir(jobId, options), "receipt.json");
}

function blankCoordination(jobId) {
  return { schemaVersion: 1, jobId, supervisor: null, starting: null, cancellation: null };
}

function readCoordination(jobId, options = {}) {
  const file = coordinationPath(jobId, options);
  try {
    assertRegularPrivateFile(file);
  } catch (error) {
    if (error?.code === "ENOENT" || /ENOENT/.test(error.message)) return blankCoordination(jobId);
    throw error;
  }
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value?.schemaVersion !== 1 || value.jobId !== jobId ||
      !Object.hasOwn(value, "supervisor") || !Object.hasOwn(value, "starting") || !Object.hasOwn(value, "cancellation")) {
    throw new Error(`Invalid durable coordination state for ${jobId}`);
  }
  return value;
}

function writeCoordination(jobId, value, options = {}) {
  const redacted = redactBridgeValue(structuredClone(value));
  if (Buffer.byteLength(JSON.stringify(redacted)) > BRIDGE_DELIVERY_QUOTAS.maxInboxItemBytes) {
    throw new Error("Bridge coordination state exceeds quota");
  }
  writeJsonAtomic(coordinationPath(jobId, options), redacted);
  if (process.platform !== "win32") fs.chmodSync(coordinationPath(jobId, options), 0o600);
  return structuredClone(redacted);
}

function assertLease(current, leaseToken, options = {}) {
  if (!current.supervisor || current.supervisor.leaseToken !== leaseToken) {
    throw new Error("Supervisor lease mismatch");
  }
  if (Date.parse(current.supervisor.expiresAt) <= Date.parse(now(options))) {
    throw new Error("Supervisor lease expired");
  }
  return current.supervisor;
}

export function claimSupervisor(jobId, claim = {}, options = {}) {
  return withJobMutationLock(jobId, options, () => {
    assertBridgeBrokerAuthority(jobId, options);
    if (typeof claim.ownerId !== "string" || !ID_PATTERN.test(claim.ownerId)) throw new Error("Invalid supervisor ownerId");
    const leaseMs = claim.leaseMs ?? 30_000;
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 10 * 60_000) throw new Error("Invalid supervisor leaseMs");
    const current = readCoordination(jobId, options);
    const currentTime = Date.parse(now(options));
    if (current.supervisor && Date.parse(current.supervisor.expiresAt) > currentTime) {
      return { acquired: false, ownerId: current.supervisor.ownerId, expiresAt: current.supervisor.expiresAt };
    }
    const acquiredAt = now(options);
    const leaseToken = `supervisor-${crypto.randomUUID()}`;
    current.supervisor = {
      leaseToken,
      ownerId: claim.ownerId,
      acquiredAt,
      expiresAt: new Date(Date.parse(acquiredAt) + leaseMs).toISOString()
    };
    if (current.starting) {
      current.starting = { ...current.starting, leaseToken, recoveredAt: acquiredAt };
    }
    if (current.cancellation?.state === "claimed") {
      current.cancellation = { ...current.cancellation, leaseToken, recoveredAt: acquiredAt };
    }
    writeCoordination(jobId, current, options);
    return { acquired: true, leaseToken, expiresAt: current.supervisor.expiresAt };
  });
}

export function releaseSupervisor(jobId, leaseToken, options = {}) {
  return withJobMutationLock(jobId, options, () => {
    assertBridgeBrokerAuthority(jobId, options);
    const current = readCoordination(jobId, options);
    if (current.supervisor === null) return false;
    assertLease(current, leaseToken, options);
    current.supervisor = null;
    writeCoordination(jobId, current, options);
    return true;
  });
}

export function markStarting(jobId, leaseToken, options = {}) {
  return withJobMutationLock(jobId, options, () => {
    assertBridgeBrokerAuthority(jobId, options);
    const current = readCoordination(jobId, options);
    assertLease(current, leaseToken, options);
    if (current.starting && current.starting.leaseToken !== leaseToken) throw new Error("Starting reservation lease mismatch");
    if (!current.starting) current.starting = { leaseToken, markedAt: now(options) };
    writeCoordination(jobId, current, options);
    return structuredClone(current.starting);
  });
}

export function clearStartingReservation(jobId, leaseToken, options = {}) {
  return withJobMutationLock(jobId, options, () => {
    assertBridgeBrokerAuthority(jobId, options);
    const current = readCoordination(jobId, options);
    if (!current.starting) return false;
    assertLease(current, leaseToken, options);
    if (current.starting.leaseToken !== leaseToken) throw new Error("Starting reservation lease mismatch");
    current.starting = null;
    writeCoordination(jobId, current, options);
    return true;
  });
}

export function readStartingReservation(jobId, options = {}) {
  assertBridgeBrokerAuthority(jobId, options);
  return structuredClone(readCoordination(jobId, options).starting);
}

export function claimCancellation(jobId, leaseToken, options = {}) {
  return withJobMutationLock(jobId, options, () => {
    assertBridgeBrokerAuthority(jobId, options);
    const current = readCoordination(jobId, options);
    assertLease(current, leaseToken, options);
    const job = getBridgeJob(jobId, options);
    if (!job.cancelRequestedAt && job.status !== "cancelled") return { accepted: false, state: "none" };
    if (current.cancellation) {
      if (current.cancellation.state === "claimed" && current.cancellation.leaseToken !== leaseToken) {
        current.cancellation.leaseToken = leaseToken;
        current.cancellation.recoveredAt = now(options);
        writeCoordination(jobId, current, options);
      }
      return { accepted: current.cancellation.state === "claimed", ...structuredClone(current.cancellation) };
    }
    current.cancellation = {
      state: "claimed",
      claimId: `cancel-${crypto.randomUUID()}`,
      leaseToken,
      requestedAt: job.cancelRequestedAt,
      claimedAt: now(options),
      confirmedAt: null,
      confirmation: null
    };
    writeCoordination(jobId, current, options);
    return { accepted: true, ...structuredClone(current.cancellation) };
  });
}

export function confirmCancellation(jobId, leaseToken, claimId, confirmation, options = {}) {
  return withJobMutationLock(jobId, options, () => {
    assertBridgeBrokerAuthority(jobId, options);
    const current = readCoordination(jobId, options);
    assertLease(current, leaseToken, options);
    if (!current.cancellation || current.cancellation.claimId !== claimId || current.cancellation.leaseToken !== leaseToken) {
      throw new Error("Cancellation claim mismatch");
    }
    const redacted = redactBridgeValue(structuredClone(confirmation));
    if (current.cancellation.state === "confirmed") {
      if (JSON.stringify(current.cancellation.confirmation) !== JSON.stringify(redacted)) throw new Error("Cancellation confirmation conflict");
      return structuredClone(current.cancellation);
    }
    current.cancellation.state = "confirmed";
    current.cancellation.confirmedAt = redacted.confirmedAt ?? now(options);
    current.cancellation.confirmation = redacted;
    writeCoordination(jobId, current, options);
    return structuredClone(current.cancellation);
  });
}

export function readCancellationClaim(jobId, options = {}) {
  assertBridgeBrokerAuthority(jobId, options);
  return structuredClone(readCoordination(jobId, options).cancellation);
}

function projectReceipt(jobId, options = {}) {
    const file = receiptPath(jobId, options);
    let receipt;
    try {
      assertRegularPrivateFile(file);
      receipt = JSON.parse(fs.readFileSync(file, "utf8"));
      validateBridgeReceiptContract(receipt);
    } catch (error) {
      if (error?.code !== "ENOENT" && !/ENOENT/.test(error.message)) throw error;
      receipt = createBridgeReceipt(readBridgeRequest(jobId, options), {
        now: options.now ?? (() => new Date())
      });
    }
    const job = getBridgeJob(jobId, options);
    if (receipt.workerState !== job.status) {
      receipt = updateBridgeWorkerReceipt(
        receipt,
        job.status,
        job.status === "failed" ? "Worker failed; inspect durable result and event evidence" : null
      );
    }
    const delivery = readDelivery(jobId, options);
    const deliveryReceipt = delivery?.state === "acknowledged"
      ? { state: "acknowledged", attempts: Math.max(1, delivery.attempts), deliveredAt: delivery.deliveredAt, acknowledgedAt: delivery.acknowledgedAt, lastError: null }
      : delivery?.state === "failed"
        ? { state: "failed", attempts: Math.max(1, delivery.attempts), deliveredAt: null, acknowledgedAt: null, lastError: delivery.lastError ?? "Delivery attempts exhausted" }
        : { state: "pending", attempts: delivery?.attempts ?? 0, deliveredAt: null, acknowledgedAt: null, lastError: null };
    receipt = updateBridgeDeliveryReceipt(receipt, deliveryReceipt);
    writeJsonAtomic(file, receipt);
    if (process.platform !== "win32") fs.chmodSync(file, 0o600);
    return structuredClone(receipt);
}

export function readReceipt(jobId, options = {}) {
  return withJobMutationLock(jobId, options, () => {
    assertBridgeBrokerAuthority(jobId, options);
    return projectReceipt(jobId, options);
  });
}

export function recordVerification(jobId, verification, options = {}) {
  return withJobMutationLock(jobId, options, () => {
    assertBridgeBrokerAuthority(jobId, options);
    let receipt = projectReceipt(jobId, options);
    if (receipt.workerState !== "completed") throw new Error("Verification requires a completed worker receipt");
    if (receipt.verification.state !== "pending") {
      if (JSON.stringify(receipt.verification) === JSON.stringify(verification)) return receipt;
      throw new Error("Verification receipt is already final");
    }
    receipt = updateBridgeVerificationReceipt(receipt, redactBridgeValue(structuredClone(verification)));
    writeJsonAtomic(receiptPath(jobId, options), receipt);
    if (process.platform !== "win32") fs.chmodSync(receiptPath(jobId, options), 0o600);
    return structuredClone(receipt);
  });
}

function assertDeliveryState(jobId, value) {
  const states = new Set(["claimed", "inbox", "inbox_claimed", "acknowledged", "failed"]);
  const allowed = new Set(["schemaVersion", "jobId", "origin", "state", "route", "deliveryClaimId", "claimedAt", "inboxClaim", "item", "attempts", "deliveredAt", "acknowledgedAt", "lastError", "lastInboxFailure"]);
  const originKeys = ["codexThreadId", "codexTurnId", "cwd", "repoRoot", "branch", "head"];
  if (!value || value.schemaVersion !== 1 || value.jobId !== jobId || !states.has(value.state) ||
      typeof value.deliveryClaimId !== "string" || !ID_PATTERN.test(value.deliveryClaimId) ||
      !Number.isInteger(value.attempts) || value.attempts < 1 || !value.origin ||
      !new Set(["waiter", "origin"]).has(value.route) || !Number.isFinite(Date.parse(value.claimedAt)) ||
      Object.keys(value).some((key) => !allowed.has(key)) ||
      Object.keys(value.origin).some((key) => !originKeys.includes(key)) || originKeys.some((key) => !Object.hasOwn(value.origin, key))) {
    throw new Error(`Invalid durable delivery state for ${jobId}`);
  }
  if (value.state === "inbox_claimed" && (!value.inboxClaim || typeof value.inboxClaim.inboxClaimId !== "string" || !Number.isFinite(Date.parse(value.inboxClaim.claimedAt)))) {
    throw new Error(`Invalid durable delivery state for ${jobId}`);
  }
  if (value.state === "acknowledged") assertDeliveryTimestamps(value);
  if (value.state === "failed" && (typeof value.lastError !== "string" || value.lastError.length === 0)) {
    throw new Error(`Invalid durable delivery state for ${jobId}`);
  }
  if (new Set(["claimed", "inbox", "inbox_claimed", "failed"]).has(value.state) && (value.deliveredAt !== null || value.acknowledgedAt !== null)) {
    throw new Error(`Invalid durable delivery state for ${jobId}`);
  }
  if (value.state === "claimed" && (value.inboxClaim !== null || value.item !== null || value.lastError !== null)) {
    throw new Error(`Invalid durable delivery state for ${jobId}`);
  }
  if (new Set(["inbox", "inbox_claimed", "failed"]).has(value.state) && (!value.item || typeof value.item !== "object" || Array.isArray(value.item))) {
    throw new Error(`Invalid durable delivery state for ${jobId}`);
  }
  if (new Set(["inbox", "failed"]).has(value.state) && value.inboxClaim !== null) throw new Error(`Invalid durable delivery state for ${jobId}`);
  if (value.lastInboxFailure !== undefined &&
      (!value.lastInboxFailure || typeof value.lastInboxFailure.inboxClaimId !== "string" || !ID_PATTERN.test(value.lastInboxFailure.inboxClaimId) ||
       typeof value.lastInboxFailure.error !== "string" || !Number.isFinite(Date.parse(value.lastInboxFailure.attemptedAt)))) {
    throw new Error(`Invalid durable delivery state for ${jobId}`);
  }
}

function writeDelivery(jobId, value, options = {}) {
  const redacted = redactBridgeValue(structuredClone(value));
  assertDeliveryState(jobId, redacted);
  if (!sameOrigin(readBridgeRequest(jobId, options).origin, redacted.origin)) throw new Error(`Invalid durable delivery origin for ${jobId}`);
  const bytes = Buffer.byteLength(JSON.stringify(redacted));
  if (bytes > BRIDGE_DELIVERY_QUOTAS.maxInboxItemBytes) throw new Error("Bridge delivery/inbox item exceeds quota");
  writeJsonAtomic(deliveryPath(jobId, options), redacted);
  if (process.platform !== "win32") fs.chmodSync(deliveryPath(jobId, options), 0o600);
  return structuredClone(redacted);
}

function assertOriginBound(jobId, origin, options = {}) {
  const request = readBridgeRequest(jobId, options);
  if (!sameOrigin(request.origin, origin)) throw new Error(`Delivery origin mismatch for ${jobId}`);
  return request.origin;
}

function now(options = {}) {
  return (options.now ? options.now() : new Date()).toISOString();
}

function assertDeliveryTimestamps(metadata) {
  const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
  for (const field of ["deliveredAt", "acknowledgedAt"]) {
    const value = metadata?.[field];
    if (typeof value !== "string" || !timestampPattern.test(value) || !Number.isFinite(Date.parse(value))) {
      throw new Error(`Delivery ${field} must be a valid RFC 3339 UTC timestamp`);
    }
  }
  if (Date.parse(metadata.acknowledgedAt) < Date.parse(metadata.deliveredAt)) {
    throw new Error("Delivery acknowledgedAt must not precede deliveredAt");
  }
}

function authorityForJob(jobId, options = {}) {
  if (options.brokerAuthority) return options;
  if (typeof options.brokerAuthorityForJob !== "function") {
    throw new Error("Inbox operation requires brokerAuthorityForJob(jobId)");
  }
  return { ...options, brokerAuthority: options.brokerAuthorityForJob(jobId) };
}

function waiterLeasePath(jobId, options = {}) {
  return path.join(resolveBridgeJobDir(jobId, options), "waiter.lease");
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readWaiterLeaseFile(jobId, options = {}) {
  const file = waiterLeasePath(jobId, options);
  try {
    assertRegularPrivateFile(file);
  } catch (error) {
    if (error?.code === "ENOENT" || /ENOENT/.test(error.message)) return null;
    throw error;
  }
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value?.schemaVersion !== 1 || value.jobId !== jobId ||
      typeof value.leaseId !== "string" || !ID_PATTERN.test(value.leaseId) ||
      !Number.isInteger(value.pid) || value.pid < 1 ||
      !Number.isFinite(Date.parse(value.acquiredAt)) || !Number.isFinite(Date.parse(value.expiresAt))) {
    throw new Error(`Invalid waiter lease for ${jobId}`);
  }
  return value;
}

function waiterLeaseLive(lease, options = {}) {
  return Boolean(lease) && Date.parse(lease.expiresAt) > Date.parse(now(options)) &&
    (options.processAlive ?? processAlive)(lease.pid);
}

// Delivery routing reads the lease under the job lock. An unreadable lease file
// cannot name a live waiter, so delivery keeps the origin route it had before.
function liveWaiterLease(jobId, options = {}) {
  let lease;
  try {
    lease = readWaiterLeaseFile(jobId, options);
  } catch {
    return null;
  }
  return waiterLeaseLive(lease, options) ? lease : null;
}

export function readWaiterLease(jobId, options = {}) {
  assertBridgeBrokerAuthority(jobId, options);
  const lease = readWaiterLeaseFile(jobId, options);
  return lease ? { ...structuredClone(lease), live: waiterLeaseLive(lease, options) } : null;
}

// Acquires the waiter lease, or refreshes it when `claim.leaseId` already holds it.
export function acquireWaiterLease(jobId, claim = {}, options = {}) {
  return withJobMutationLock(jobId, options, () => {
    assertBridgeBrokerAuthority(jobId, options);
    const pid = claim.pid ?? process.pid;
    if (!Number.isInteger(pid) || pid < 1) throw new Error("Invalid waiter lease pid");
    const leaseMs = claim.leaseMs ?? BRIDGE_WAITER_LEASE.leaseMs;
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 10 * 60_000) throw new Error("Invalid waiter leaseMs");
    if (claim.leaseId != null && (typeof claim.leaseId !== "string" || !ID_PATTERN.test(claim.leaseId))) {
      throw new Error("Invalid waiter leaseId");
    }
    let current = null;
    try {
      current = readWaiterLeaseFile(jobId, options);
    } catch {
      current = null;
    }
    const refresh = claim.leaseId != null && current?.leaseId === claim.leaseId;
    if (current && !refresh && waiterLeaseLive(current, options)) {
      return { acquired: false, leaseId: current.leaseId, expiresAt: current.expiresAt };
    }
    const heartbeatAt = now(options);
    const lease = {
      schemaVersion: 1,
      jobId,
      leaseId: refresh ? current.leaseId : `waiter-${crypto.randomUUID()}`,
      pid,
      acquiredAt: refresh ? current.acquiredAt : heartbeatAt,
      heartbeatAt,
      expiresAt: new Date(Date.parse(heartbeatAt) + leaseMs).toISOString()
    };
    const file = waiterLeasePath(jobId, options);
    writeJsonAtomic(file, lease);
    if (process.platform !== "win32") fs.chmodSync(file, 0o600);
    return { acquired: true, leaseId: lease.leaseId, expiresAt: lease.expiresAt };
  });
}

export function releaseWaiterLease(jobId, leaseId, options = {}) {
  return withJobMutationLock(jobId, options, () => {
    assertBridgeBrokerAuthority(jobId, options);
    let current = null;
    try {
      current = readWaiterLeaseFile(jobId, options);
    } catch {
      current = null;
    }
    if (!current || current.leaseId !== leaseId) return false;
    fs.rmSync(waiterLeasePath(jobId, options), { force: true });
    return true;
  });
}

export function claimDelivery(jobId, metadata, options = {}) {
  return withJobMutationLock(jobId, options, () => {
    assertBridgeBrokerAuthority(jobId, options);
    const origin = assertOriginBound(jobId, metadata?.origin, options);
    if (!new Set(["waiter", "origin"]).has(metadata?.route)) throw new Error("Invalid delivery route");
    // A live origin waiter is the delivery route: resuming the origin thread
    // while its own `wait` runs always fails with an active-writer error.
    const route = metadata.route === "origin" && liveWaiterLease(jobId, options) ? "waiter" : metadata.route;
    const current = readDelivery(jobId, options);
    if (current) {
      const claimedAt = Date.parse(current.claimedAt);
      const currentTime = now(options);
      const claimAgeMs = Date.parse(currentTime) - claimedAt;
      const claimTtlMs = options.deliveryClaimTtlMs ?? BRIDGE_DELIVERY_QUOTAS.deliveryClaimTtlMs;
      if (current.state !== "claimed" || !Number.isFinite(claimedAt) || claimAgeMs < claimTtlMs) {
        return {
          accepted: false,
          state: current.state,
          claimId: current.deliveryClaimId,
          route: current.route,
          lastError: current.lastError ?? null
        };
      }
      current.deliveryClaimId = `delivery-${crypto.randomUUID()}`;
      current.origin = origin;
      current.route = route;
      current.claimedAt = currentTime;
      current.attempts += 1;
      current.lastError = null;
      writeDelivery(jobId, current, options);
      return { accepted: true, claimId: current.deliveryClaimId, route, recovered: true };
    }
    const deliveryClaimId = `delivery-${crypto.randomUUID()}`;
    writeDelivery(jobId, {
      schemaVersion: 1, jobId, origin, state: "claimed", route,
      deliveryClaimId, claimedAt: now(options), inboxClaim: null, item: null,
      attempts: 1, deliveredAt: null, acknowledgedAt: null, lastError: null
    }, options);
    return { accepted: true, claimId: deliveryClaimId, route };
  });
}

export function acknowledgeDelivery(jobId, claimId, metadata, options = {}) {
  return withJobMutationLock(jobId, options, () => {
    assertBridgeBrokerAuthority(jobId, options);
    const current = readDelivery(jobId, options);
    if (!current || current.deliveryClaimId !== claimId) throw new Error("Delivery claim mismatch");
    if (current.state === "acknowledged") {
      if (current.route === metadata?.route && current.deliveredAt === metadata?.deliveredAt && current.acknowledgedAt === metadata?.acknowledgedAt) return current;
      throw new Error("Delivery acknowledgement replay conflict");
    }
    if (current.state !== "claimed" || metadata?.route !== current.route) throw new Error("Delivery is not claimable for acknowledgement");
    assertDeliveryTimestamps(metadata);
    current.state = "acknowledged";
    current.deliveredAt = metadata.deliveredAt;
    current.acknowledgedAt = metadata.acknowledgedAt;
    return writeDelivery(jobId, current, options);
  });
}

export function failDeliveryToInbox(jobId, claimId, item, options = {}) {
  return withJobMutationLock(jobId, options, () => {
    assertBridgeBrokerAuthority(jobId, options);
    assertOriginBound(jobId, item?.origin, options);
    const current = readDelivery(jobId, options);
    if (!current || current.deliveryClaimId !== claimId) throw new Error("Delivery claim mismatch");
    if (current.state === "inbox" || current.state === "inbox_claimed") return current;
    if (current.state !== "claimed" || item.jobId !== jobId) throw new Error("Delivery cannot be queued to inbox");
    current.state = "inbox";
    current.item = { ...redactBridgeValue(structuredClone(item)), attempt: current.attempts };
    current.lastError = current.item.error ?? null;
    return writeDelivery(jobId, current, options);
  });
}

export function claimInbox(origin, options = {}) {
  const root = resolveBridgeStateRoot(options);
  const releaseInbox = acquireQueuedLock(path.join(root, "locks", "delivery-inbox"));
  try {
    const jobsRoot = path.join(root, "jobs");
    for (const entry of fs.readdirSync(jobsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const jobId = entry.name;
      let authorized;
      try {
        authorized = authorityForJob(jobId, options);
        assertBridgeBrokerAuthority(jobId, authorized);
        assertOriginBound(jobId, origin, options);
      } catch {
        continue;
      }
      const releaseJob = acquireQueuedLock(messagingPaths(jobId, options).lock);
      try {
        const current = readDelivery(jobId, authorized);
        if (!current || !sameOrigin(current.origin, origin)) continue;
        if (current.state === "inbox_claimed") {
          const age = Date.parse(now(options)) - Date.parse(current.inboxClaim.claimedAt);
          if (age < (options.inboxClaimTtlMs ?? BRIDGE_DELIVERY_QUOTAS.inboxClaimTtlMs)) continue;
          current.state = "inbox";
          current.inboxClaim = null;
        }
        if (current.state !== "inbox") continue;
        const inboxClaimId = `inbox-${crypto.randomUUID()}`;
        current.state = "inbox_claimed";
        current.inboxClaim = { inboxClaimId, claimedAt: now(options) };
        writeDelivery(jobId, current, options);
        return { inboxClaimId, deliveryClaimId: current.deliveryClaimId, item: structuredClone(current.item) };
      } finally {
        releaseJob();
      }
    }
    return null;
  } finally {
    releaseInbox();
  }
}

function mutateInboxClaim(origin, inboxClaimId, deliveryClaimId, metadata, options, mutation) {
  const jobId = metadata?.jobId;
  return withJobMutationLock(jobId, options, () => {
    assertBridgeBrokerAuthority(jobId, options);
    assertOriginBound(jobId, origin, options);
    const current = readDelivery(jobId, options);
    if (!current || current.deliveryClaimId !== deliveryClaimId || current.inboxClaim?.inboxClaimId !== inboxClaimId) {
      throw new Error("Inbox claim mismatch");
    }
    return mutation(current);
  });
}

export function acknowledgeInboxDelivery(origin, inboxClaimId, deliveryClaimId, metadata, options = {}) {
  return mutateInboxClaim(origin, inboxClaimId, deliveryClaimId, metadata, options, (current) => {
    if (current.state === "acknowledged") {
      if (current.route === metadata?.route && current.deliveredAt === metadata?.deliveredAt && current.acknowledgedAt === metadata?.acknowledgedAt) return current;
      throw new Error("Inbox acknowledgement replay conflict");
    }
    if (current.state !== "inbox_claimed") throw new Error("Inbox item is not claimed");
    if (!new Set(["waiter", "origin"]).has(metadata?.route)) throw new Error("Invalid inbox acknowledgement route");
    assertDeliveryTimestamps(metadata);
    current.state = "acknowledged";
    // Record the route that actually delivered the queued item.
    current.route = metadata.route;
    current.deliveredAt = metadata.deliveredAt;
    current.acknowledgedAt = metadata.acknowledgedAt;
    return writeDelivery(metadata.jobId, current, options);
  });
}

// Returns a claimed inbox item to the queue after an origin-busy attempt. The
// origin is in use, not failing, so the attempt count and quota are unchanged.
export function requeueInboxDelivery(origin, inboxClaimId, deliveryClaimId, metadata, options = {}) {
  if (metadata?.reason !== ORIGIN_BUSY) throw new Error("Only an origin-busy inbox attempt can be requeued without spending quota");
  return mutateInboxClaim(origin, inboxClaimId, deliveryClaimId, metadata, options, (current) => {
    if (current.state !== "inbox_claimed") throw new Error("Inbox item is not claimed");
    current.state = "inbox";
    current.inboxClaim = null;
    current.lastError = ORIGIN_BUSY;
    return writeDelivery(metadata.jobId, current, options);
  });
}

export function failInboxDelivery(origin, inboxClaimId, deliveryClaimId, metadata, options = {}) {
  const jobId = metadata?.jobId;
  return withJobMutationLock(jobId, options, () => {
    assertBridgeBrokerAuthority(jobId, options);
    assertOriginBound(jobId, origin, options);
    const current = readDelivery(jobId, options);
    if (current?.lastInboxFailure?.inboxClaimId === inboxClaimId &&
        current.deliveryClaimId === deliveryClaimId && sameOrigin(current.origin, origin)) {
      const expectedError = String(metadata.error ?? "Inbox delivery failed").slice(0, 320);
      if (current.lastInboxFailure.error === expectedError && current.lastInboxFailure.attemptedAt === metadata.attemptedAt) return current;
      throw new Error("Inbox failure replay conflict");
    }
    if (!current || current.deliveryClaimId !== deliveryClaimId || current.inboxClaim?.inboxClaimId !== inboxClaimId) {
      throw new Error("Inbox claim mismatch");
    }
    if (current.state !== "inbox_claimed") throw new Error("Inbox item is not claimed");
    current.attempts += 1;
    current.lastError = String(metadata.error ?? "Inbox delivery failed").slice(0, 320);
    current.lastInboxFailure = { inboxClaimId, attemptedAt: metadata.attemptedAt ?? now(options), error: current.lastError };
    current.item.attempt = current.attempts;
    current.inboxClaim = null;
    current.state = current.attempts >= BRIDGE_DELIVERY_QUOTAS.maxInboxAttempts ? "failed" : "inbox";
    return writeDelivery(jobId, current, options);
  });
}

export function createBridgeDeliveryStateOperations(options = {}) {
  if (typeof options.brokerAuthorityForJob !== "function") {
    throw new Error("Bridge delivery operations require brokerAuthorityForJob(jobId)");
  }
  const jobOptions = (jobId) => ({ ...options, brokerAuthority: options.brokerAuthorityForJob(jobId) });
  return Object.freeze({
    claimDelivery: (jobId, metadata) => claimDelivery(jobId, metadata, jobOptions(jobId)),
    acknowledgeDelivery: (jobId, claimId, metadata) => acknowledgeDelivery(jobId, claimId, metadata, jobOptions(jobId)),
    failDeliveryToInbox: (jobId, claimId, item) => failDeliveryToInbox(jobId, claimId, item, jobOptions(jobId)),
    readDelivery: (jobId) => readDelivery(jobId, jobOptions(jobId)),
    readReceipt: (jobId) => readReceipt(jobId, jobOptions(jobId)),
    recordVerification: (jobId, verification) => recordVerification(jobId, verification, jobOptions(jobId)),
    claimInbox: (origin) => claimInbox(origin, options),
    acknowledgeInboxDelivery: (origin, inboxClaimId, deliveryClaimId, metadata) => acknowledgeInboxDelivery(origin, inboxClaimId, deliveryClaimId, metadata, jobOptions(metadata.jobId)),
    failInboxDelivery: (origin, inboxClaimId, deliveryClaimId, metadata) => failInboxDelivery(origin, inboxClaimId, deliveryClaimId, metadata, jobOptions(metadata.jobId)),
    requeueInboxDelivery: (origin, inboxClaimId, deliveryClaimId, metadata) => requeueInboxDelivery(origin, inboxClaimId, deliveryClaimId, metadata, jobOptions(metadata.jobId)),
    readWaiterLease: (jobId) => readWaiterLease(jobId, jobOptions(jobId)),
    acquireWaiterLease: (jobId, claim) => acquireWaiterLease(jobId, claim, jobOptions(jobId)),
    releaseWaiterLease: (jobId, leaseId) => releaseWaiterLease(jobId, leaseId, jobOptions(jobId))
  });
}

export function createBridgeCoordinationOperations(options = {}) {
  const delivery = createBridgeDeliveryStateOperations(options);
  const jobOptions = (jobId) => ({ ...options, brokerAuthority: options.brokerAuthorityForJob(jobId) });
  return Object.freeze({
    claimSupervisor: (jobId, claim) => claimSupervisor(jobId, claim, jobOptions(jobId)),
    releaseSupervisor: (jobId, leaseToken) => releaseSupervisor(jobId, leaseToken, jobOptions(jobId)),
    markStarting: (jobId, leaseToken) => markStarting(jobId, leaseToken, jobOptions(jobId)),
    clearStartingReservation: (jobId, leaseToken) => clearStartingReservation(jobId, leaseToken, jobOptions(jobId)),
    readStartingReservation: (jobId) => readStartingReservation(jobId, jobOptions(jobId)),
    claimCancellation: (jobId, leaseToken) => claimCancellation(jobId, leaseToken, jobOptions(jobId)),
    confirmCancellation: (jobId, leaseToken, claimId, confirmation) => confirmCancellation(jobId, leaseToken, claimId, confirmation, jobOptions(jobId)),
    readCancellationClaim: (jobId) => readCancellationClaim(jobId, jobOptions(jobId)),
    ...delivery
  });
}
