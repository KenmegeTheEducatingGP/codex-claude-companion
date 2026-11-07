import path from "node:path";

import {
  validateBridgeReceiptContract,
  validateBridgeResultContract
} from "./bridge-contracts.mjs";

const JOB_ID_PATTERN = /^ccb_[0-9A-HJKMNP-TV-Z]{26}$/;
// The delivery error recorded when the origin thread is in use. It never spends
// the inbox failure quota.
export const ORIGIN_BUSY = "origin-busy";
// The delivery error recorded when the origin's own command claimed a queued result but could not
// write its output (a closed pipe, a full disk). The result was not delivered and the inbox failure
// quota is not spent.
export const OUTPUT_FAILED = "origin-output-failed";
const INVALID_REQUEST_RPC_CODE = -32600;

// A Codex thread admits one writer process. While the origin session runs (for
// example inside `codex-claude wait`), a resume from another process fails with
// "thread <id> already has an active writer". The origin is busy, not broken.
export function isOriginBusyError(error) {
  return error?.rpcCode === INVALID_REQUEST_RPC_CODE &&
    /\balready has an active writer\b/.test(String(error?.message ?? ""));
}

function assertOrigin(origin) {
  if (!origin || typeof origin !== "object" || typeof origin.codexThreadId !== "string" ||
      origin.codexThreadId.length === 0 || !path.isAbsolute(origin.cwd ?? "") ||
      !path.isAbsolute(origin.repoRoot ?? "")) {
    throw new Error("delivery requires a valid immutable Codex origin");
  }
}

function assertTerminal(result, receipt, origin) {
  validateBridgeResultContract(result);
  validateBridgeReceiptContract(receipt);
  if (!new Set(["completed", "failed", "cancelled"]).has(result.status) || receipt.workerState !== result.status) {
    throw new Error("delivery accepts only normalized terminal worker results bound to the receipt state");
  }
  if (receipt.delivery.state !== "pending") throw new Error("delivery requires a pending durable delivery receipt");
  if (result.jobId !== receipt.jobId) throw new Error("result and receipt job ids do not match");
  assertOrigin(origin);
}

function buildEnvelope(result, receipt, origin) {
  return Object.freeze({
    schemaVersion: 1,
    jobId: result.jobId,
    origin: structuredClone(origin),
    workerStatus: result.status,
    workerCompleted: result.status === "completed",
    verified: receipt.verification.state === "passed",
    summary: redactText(result.summary).slice(0, 800),
    filesChanged: result.filesChanged.slice(0, 32).map((file) => redactText(file).slice(0, 240)),
    testsRun: result.testsRun.slice(0, 16).map((test) => ({
      status: test.status,
      summary: redactText(test.summary).slice(0, 240)
    })),
    blockers: result.blockers.slice(0, 16).map((item) => ({
      title: redactText(item.title).slice(0, 160),
      detail: redactText(item.detail).slice(0, 320)
    }))
  });
}

function redactText(value) {
  return String(value)
    .replace(/\bsk-(?:ant|proj)-[A-Za-z0-9_-]+\b/gi, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

function sameOrigin(left, right) {
  return ["codexThreadId", "codexTurnId", "cwd", "repoRoot", "branch", "head"]
    .every((key) => left?.[key] === right?.[key]);
}

function conciseOriginPrompt(envelope) {
  const tests = envelope.testsRun.slice(0, 4).map((test) => `${test.status}: ${test.summary}`).join("; ") || "none reported";
  const files = envelope.filesChanged.slice(0, 8).join(", ") || "none reported";
  const blockers = envelope.blockers.slice(0, 3).map((item) => item.title).join(", ") || "none";
  return redactText([
    `Codex-Claude Bridge result for ${envelope.jobId}.`,
    `Worker status: ${envelope.workerStatus}.`,
    `Worker completed: ${envelope.workerCompleted ? "yes" : "no"}.`,
    `Independently verified: ${envelope.verified ? "yes" : "no"}.`,
    `Summary: ${envelope.summary}`,
    `Files changed: ${files}`,
    `Tests: ${tests}`,
    `Blockers: ${blockers}`,
    "Please inspect the durable bridge artifacts and independently verify before accepting the work."
  ].join("\n")).slice(0, 1_200);
}

// A terminal result as the origin receives it, whichever route delivers it:
// the concise text an origin resume carries and a queued inbox item stores.
export function describeBridgeResult({ result, receipt, origin }) {
  validateBridgeResultContract(result);
  validateBridgeReceiptContract(receipt);
  assertOrigin(origin);
  if (result.jobId !== receipt.jobId) throw new Error("result and receipt job ids do not match");
  const envelope = buildEnvelope(result, receipt, origin);
  return Object.freeze({
    jobId: result.jobId,
    workerCompleted: envelope.workerCompleted,
    verified: envelope.verified,
    prompt: conciseOriginPrompt(envelope)
  });
}

export function createCodexOriginAdapter(options = {}) {
  return async ({ cwd, resumeThreadId, prompt }) => {
    const runTurn = options.runTurn ?? (await import("../../plugins/codex/scripts/lib/codex.mjs")).runAppServerTurn;
    const response = await runTurn(cwd, {
      resumeThreadId,
      prompt,
      disableBroker: true,
      timeoutMs: options.timeoutMs ?? 15_000
    });
    return {
      acknowledged: response?.status === 0 && response?.threadId === resumeThreadId,
      threadId: response?.threadId ?? null
    };
  };
}

function assertStateOperations(stateOperations) {
  if (typeof stateOperations?.claimDelivery !== "function" ||
      typeof stateOperations?.acknowledgeDelivery !== "function") {
    throw new Error("delivery requires broker-owned claim and acknowledgement operations");
  }
}

export async function deliverBridgeResult(options) {
  const { result, receipt, origin, stateOperations } = options;
  assertTerminal(result, receipt, origin);
  assertStateOperations(stateOperations);
  const route = typeof options.waiter === "function" ? "waiter" : "origin";
  const claim = await stateOperations.claimDelivery(result.jobId, { route, origin: structuredClone(origin) });
  if (!claim?.accepted) {
    if (["inbox", "inbox_claimed"].includes(claim?.state)) {
      return {
        state: "queued", route: "inbox", failedRoute: route, jobId: result.jobId,
        ...(claim.lastError === ORIGIN_BUSY ? { reason: ORIGIN_BUSY } : {})
      };
    }
    if (claim?.state === "claimed") {
      if (claim.route === "waiter" && route !== "waiter") {
        return { state: "awaiting-waiter", route: "waiter", jobId: result.jobId };
      }
      return { state: "deferred", route, jobId: result.jobId };
    }
    if (claim?.state === "failed") {
      return { state: "failed", route, jobId: result.jobId };
    }
    return { state: "deduplicated", route };
  }
  if (typeof claim.claimId !== "string" || claim.claimId.length === 0) {
    throw new Error("broker returned an invalid durable delivery claim");
  }
  if (claim.route === "waiter" && route !== "waiter") {
    // The origin's own `wait` holds the waiter lease, so the claim is its to
    // acknowledge as it prints the result. Resuming the origin would fail.
    return { state: "awaiting-waiter", route: "waiter", jobId: result.jobId };
  }
  const envelope = buildEnvelope(result, receipt, origin);
  try {
    const acknowledgement = route === "waiter"
      ? await options.waiter(envelope)
      : await (options.originAdapter ?? createCodexOriginAdapter())({
        cwd: origin.cwd,
        resumeThreadId: origin.codexThreadId,
        prompt: conciseOriginPrompt(envelope),
        jobId: result.jobId
      });
    if (acknowledgement?.acknowledged !== true) throw new Error(`${route} did not acknowledge delivery`);
    if (route === "origin" && acknowledgement.threadId !== origin.codexThreadId) {
      throw new Error("Codex origin adapter acknowledged the wrong thread");
    }
  } catch (error) {
    if (typeof stateOperations.failDeliveryToInbox !== "function") {
      throw new Error("delivery failed and no broker-owned durable inbox operation is available", { cause: error });
    }
    const queuedAt = (options.now ?? (() => new Date()))().toISOString();
    const originBusy = route === "origin" && isOriginBusyError(error);
    await stateOperations.failDeliveryToInbox(result.jobId, claim.claimId, {
      schemaVersion: 1,
      jobId: result.jobId,
      origin: structuredClone(origin),
      prompt: conciseOriginPrompt(envelope),
      workerStatus: result.status,
      workerCompleted: result.status === "completed",
      verified: envelope.verified,
      failedRoute: route,
      error: originBusy ? ORIGIN_BUSY : redactText(error?.message ?? error).slice(0, 320),
      attempt: 0,
      queuedAt
    });
    return {
      state: "queued", route: "inbox", failedRoute: route, jobId: result.jobId,
      ...(originBusy ? { reason: ORIGIN_BUSY } : {})
    };
  }
  const acknowledgedAt = (options.now ?? (() => new Date()))().toISOString();
  await stateOperations.acknowledgeDelivery(result.jobId, claim.claimId, {
    route, deliveredAt: acknowledgedAt, acknowledgedAt
  });
  return { state: "acknowledged", route, jobId: result.jobId };
}

// Claims the oldest queued result for `origin`, or returns null when none is claimable.
async function claimQueuedItem(origin, stateOperations) {
  const claimed = await stateOperations.claimInbox(structuredClone(origin));
  if (claimed === null) return null;
  const { inboxClaimId, deliveryClaimId, item } = claimed ?? {};
  if (typeof inboxClaimId !== "string" || typeof deliveryClaimId !== "string" ||
      !JOB_ID_PATTERN.test(item?.jobId ?? "") || !sameOrigin(item.origin, origin)) {
    throw new Error("broker returned an invalid or cross-origin inbox claim");
  }
  return { inboxClaimId, deliveryClaimId, item };
}

// A queued item as the origin's own command receives it.
function describeQueuedItem(item) {
  return Object.freeze({
    jobId: item.jobId,
    workerCompleted: item.workerCompleted === true,
    verified: item.verified === true,
    prompt: redactText(item.prompt).slice(0, 1_200)
  });
}

/**
 * Claims one queued result for the origin's own command without acknowledging it. The command's
 * output is the delivery, so it writes the result first. It then calls `acknowledge()`, or, when
 * the write failed, `release()`, which puts the result back in the inbox for the next origin
 * command without spending the failure quota. Resolves to null when nothing is queued.
 *
 * @returns {Promise<null | {result: {jobId, workerCompleted, verified, prompt},
 *   acknowledge: () => Promise<void>, release: () => Promise<void>}>}
 */
export async function claimBridgeInboxResult(options) {
  const { origin, stateOperations } = options;
  assertOrigin(origin);
  if (typeof stateOperations?.claimInbox !== "function" ||
      typeof stateOperations?.acknowledgeInboxDelivery !== "function" ||
      typeof stateOperations?.requeueInboxDelivery !== "function") {
    throw new Error("inbox claim requires broker-owned claim, acknowledgement and requeue operations");
  }
  const claimed = await claimQueuedItem(origin, stateOperations);
  if (claimed === null) return null;
  const { inboxClaimId, deliveryClaimId, item } = claimed;
  return Object.freeze({
    result: describeQueuedItem(item),
    async acknowledge() {
      const acknowledgedAt = (options.now ?? (() => new Date()))().toISOString();
      await stateOperations.acknowledgeInboxDelivery(
        structuredClone(origin), inboxClaimId, deliveryClaimId,
        { jobId: item.jobId, route: "waiter", deliveredAt: acknowledgedAt, acknowledgedAt }
      );
    },
    async release() {
      await stateOperations.requeueInboxDelivery(
        structuredClone(origin), inboxClaimId, deliveryClaimId,
        { jobId: item.jobId, reason: OUTPUT_FAILED }
      );
    }
  });
}

export async function drainBridgeInbox(options) {
  const { origin, stateOperations } = options;
  assertOrigin(origin);
  if (typeof stateOperations?.claimInbox !== "function" ||
      typeof stateOperations?.acknowledgeInboxDelivery !== "function") {
    throw new Error("inbox drain requires broker-owned claim and acknowledgement operations");
  }
  const claimed = await claimQueuedItem(origin, stateOperations);
  if (claimed === null) return { state: "empty" };
  const { inboxClaimId, deliveryClaimId, item } = claimed;
  const route = typeof options.waiter === "function" ? "waiter" : "origin";
  try {
    const acknowledgement = route === "waiter"
      ? await options.waiter(describeQueuedItem(item))
      : await (options.originAdapter ?? createCodexOriginAdapter())({
        cwd: origin.cwd,
        resumeThreadId: origin.codexThreadId,
        prompt: redactText(item.prompt).slice(0, 1_200),
        jobId: item.jobId
      });
    if (acknowledgement?.acknowledged !== true) throw new Error(`${route} did not acknowledge inbox delivery`);
    if (route === "origin" && acknowledgement.threadId !== origin.codexThreadId) {
      throw new Error("Codex origin adapter acknowledged the wrong thread");
    }
    const acknowledgedAt = (options.now ?? (() => new Date()))().toISOString();
    await stateOperations.acknowledgeInboxDelivery(
      structuredClone(origin), inboxClaimId, deliveryClaimId,
      { jobId: item.jobId, route, deliveredAt: acknowledgedAt, acknowledgedAt }
    );
    return { state: "acknowledged", route, jobId: item.jobId };
  } catch (error) {
    if (route === "origin" && isOriginBusyError(error) && typeof stateOperations.requeueInboxDelivery === "function") {
      await stateOperations.requeueInboxDelivery(
        structuredClone(origin), inboxClaimId, deliveryClaimId,
        { jobId: item.jobId, reason: ORIGIN_BUSY }
      );
      return { state: "queued", route: "inbox", reason: ORIGIN_BUSY, jobId: item.jobId };
    }
    if (typeof stateOperations.failInboxDelivery !== "function") {
      throw new Error("inbox retry failed and no broker-owned terminal failure operation is available", { cause: error });
    }
    const attemptedAt = (options.now ?? (() => new Date()))().toISOString();
    await stateOperations.failInboxDelivery(
      structuredClone(origin), inboxClaimId, deliveryClaimId,
      { jobId: item.jobId, error: redactText(error?.message ?? error).slice(0, 320), attemptedAt }
    );
    return { state: "failed", route, jobId: item.jobId };
  }
}
