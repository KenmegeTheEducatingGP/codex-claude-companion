import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createBridgeRuntime } from "./bridge-runtime.mjs";
import { createProductionBridgeRepairLifecycle } from "./bridge-repair.mjs";
import { readReceipt } from "./bridge-messaging.mjs";
import * as bridgeState from "./bridge-state.mjs";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// The broker spec versions this release can run. A spec written by a newer
// release is refused outright, so a downgrade can never misread it.
const SUPPORTED_SPEC_VERSIONS = Object.freeze([1]);

function privateRegularFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
    throw new Error(`broker spec must be a private regular file: ${file}`);
  }
}

function writeJsonAtomic(file, payload) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function safeError(error) {
  return String(error?.message ?? error)
    .replace(/\bsk-(?:ant|proj)-[A-Za-z0-9_-]+\b/gi, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 1_000);
}

function validateSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("broker spec must be an object");
  if (!SUPPORTED_SPEC_VERSIONS.includes(spec.schemaVersion)) {
    const found = Object.hasOwn(spec, "schemaVersion") ? JSON.stringify(spec.schemaVersion) : "(missing)";
    throw new Error(
      `broker spec schemaVersion ${found} is not supported by this release ` +
      `(supported: ${SUPPORTED_SPEC_VERSIONS.join(", ")}); finish or cancel this job with the release that created it`
    );
  }
  if (!/^ccb_[0-9A-HJKMNP-TV-Z]{26}$/.test(spec.jobId ?? "")) throw new Error("broker spec has an invalid job id");
  if (typeof spec.prompt !== "string" || spec.prompt.length === 0) throw new Error("broker spec requires a durable prompt");
  if (!CAPABILITY_PATTERN.test(spec.workerCapabilityToken ?? "")) throw new Error("broker spec requires a job-bound worker capability");
  for (const [key, value] of Object.entries({
    stateRoot: spec.stateRoot,
    jobDir: spec.jobDir,
    tmuxBinary: spec.tmuxBinary,
    claudeBinary: spec.claudeBinary,
    codexBinary: spec.codexBinary,
    nodeBinary: spec.nodeBinary,
    envBinary: spec.envBinary,
    heartbeatFile: spec.heartbeatFile
  })) {
    if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`broker spec ${key} must be an absolute path`);
  }
  if (spec.verificationCommands != null && (!Array.isArray(spec.verificationCommands) ||
      spec.verificationCommands.some((argv) => !Array.isArray(argv) || argv.length === 0 || argv.length > 64 ||
        argv.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 4_096)))) {
    throw new Error("broker spec verificationCommands must contain bounded argv arrays");
  }
  if (spec.maxRepairs != null && (!Number.isInteger(spec.maxRepairs) || spec.maxRepairs < 0 || spec.maxRepairs > 1)) {
    throw new Error("broker spec maxRepairs must be 0 or 1");
  }
  if (spec.internalRepair != null) {
    const repair = spec.internalRepair;
    if (!repair || typeof repair !== "object" || Array.isArray(repair) ||
        Object.keys(repair).some((key) => !["parentJobId", "attempt"].includes(key)) ||
        !/^ccb_[0-9A-HJKMNP-TV-Z]{26}$/.test(repair.parentJobId ?? "") ||
        repair.parentJobId === spec.jobId || repair.attempt !== 1 || (spec.maxRepairs ?? 0) !== 0) {
      throw new Error("broker spec internalRepair must identify a distinct parent and bounded attempt 1 with maxRepairs=0");
    }
  }
  return spec;
}

export function readBridgeBrokerSpec(file) {
  const resolved = path.resolve(file);
  privateRegularFile(resolved);
  return validateSpec(JSON.parse(fs.readFileSync(resolved, "utf8")));
}

export function persistBridgeBrokerSpec(file, spec) {
  const resolved = path.resolve(file);
  validateSpec(spec);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(resolved, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return resolved;
}

function settledSnapshot(spec, stateApi) {
  const stateOptions = { stateRoot: spec.stateRoot };
  const state = stateApi.getBridgeJob(spec.jobId, stateOptions);
  const result = stateApi.readBridgeResult(spec.jobId, stateOptions);
  if (!TERMINAL.has(state.status) || !result) return { settled: false, state, result };
  const brokerAuthority = stateApi.getBridgeBrokerAuthority(spec.jobId, stateOptions);
  const receipt = readReceipt(spec.jobId, { ...stateOptions, brokerAuthority });
  const verificationFinal = state.status === "completed"
    ? ["passed", "failed"].includes(receipt?.verification?.state)
    : true;
  const deliveryFinal = ["acknowledged", "failed"].includes(receipt?.delivery?.state);
  return { settled: verificationFinal && deliveryFinal, state, result, receipt };
}

export async function runBridgeBroker(specInput, options = {}) {
  const spec = validateSpec(structuredClone(specInput));
  const stateApi = options.stateApi ?? bridgeState;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? (() => new Date());
  const intervalMs = Math.max(100, Math.min(10_000, spec.intervalMs ?? 500));
  const deliveryRetryMs = Math.max(1_000, Math.min(60_000, spec.deliveryRetryMs ?? 30_000));
  const repairLifecycle = (spec.maxRepairs ?? 0) === 1
    ? (options.createRepairLifecycle ?? createProductionBridgeRepairLifecycle)({
        parentSpec: spec,
        stateApi,
        persistBrokerSpec: options.persistBrokerSpec ?? persistBridgeBrokerSpec,
        spawnDetached: options.spawnDetached,
        processAlive: options.processAlive,
        sleep,
        onProgress: (progress) => writeJsonAtomic(spec.heartbeatFile, {
          schemaVersion: 1,
          jobId: spec.jobId,
          brokerPid: process.pid,
          timestamp: now().toISOString(),
          action: "repairing",
          consecutiveErrors: 0,
          repair: progress
        })
      })
    : null;
  const runtime = (options.createRuntime ?? createBridgeRuntime)({
    stateOptions: { stateRoot: spec.stateRoot },
    codexBinary: spec.codexBinary,
    verificationCommands: spec.verificationCommands ?? [],
    maxRepairs: spec.maxRepairs ?? 0,
    internalRepair: spec.internalRepair ?? null,
    repairLifecycle,
    onVerificationProgress: (progress) => writeJsonAtomic(spec.heartbeatFile, {
      schemaVersion: 1,
      jobId: spec.jobId,
      brokerPid: process.pid,
      timestamp: now().toISOString(),
      action: "verifying",
      consecutiveErrors: 0,
      verification: progress
    }),
    ownerId: `bridge-broker:${os.hostname()}:${process.pid}`,
    leaseMs: Math.max(intervalMs * 4, 30_000),
    executorOptions: {
      jobDir: spec.jobDir,
      tmuxBinary: spec.tmuxBinary,
      claudeBinary: spec.claudeBinary,
      nodeBinary: spec.nodeBinary,
      envBinary: spec.envBinary,
      workerCapabilityToken: spec.workerCapabilityToken,
      tmuxSocketName: spec.tmuxSocketName ?? undefined
    },
    artifactPaths: [spec.jobDir]
  });
  if (!runtime.compatibility?.ready) throw new Error("bridge runtime compatibility gate is not ready");

  let consecutiveErrors = 0;
  let lastAction = "starting";
  let lastError = null;
  for (;;) {
    let outcome = null;
    let error = null;
    try {
      outcome = await runtime.run({
        jobId: spec.jobId,
        prompt: spec.prompt,
        securityRequirements: spec.securityRequirements ?? {},
        executorOptions: { jobDir: spec.jobDir }
      });
      lastAction = outcome?.action ?? "unknown";
      consecutiveErrors = 0;
    } catch (caught) {
      error = safeError(caught);
      lastError = error;
      consecutiveErrors += 1;
      lastAction = "retrying";
    }

    const heartbeat = {
      schemaVersion: 1,
      jobId: spec.jobId,
      brokerPid: process.pid,
      timestamp: now().toISOString(),
      action: lastAction,
      consecutiveErrors,
      ...(error ? { error } : {}),
      ...(!error && lastError && outcome?.action === "recovery-required" ? { lastError } : {})
    };
    writeJsonAtomic(spec.heartbeatFile, heartbeat);

    if (outcome?.action === "blocked" || outcome?.action === "recovery-required") {
      return { status: "blocked", outcome, heartbeat };
    }
    if (outcome?.action === "delivery" && ["acknowledged", "deduplicated"].includes(outcome.classification)) {
      return { status: "settled", outcome, heartbeat };
    }
    if (outcome?.action === "terminal" && outcome?.classification === "settled") {
      return { status: "settled", outcome, heartbeat };
    }
    if (outcome?.action === "repair-terminal") {
      return { status: "settled", outcome, heartbeat };
    }
    try {
      const snapshot = settledSnapshot(spec, stateApi);
      if (snapshot.settled) return { status: "settled", outcome, heartbeat };
    } catch (caught) {
      // Creation publication and recovery use atomic filesystem boundaries. A
      // transient read failure is retried; the next heartbeat exposes it.
      consecutiveErrors += 1;
      heartbeat.error = safeError(caught);
      writeJsonAtomic(spec.heartbeatFile, heartbeat);
    }
    const retryDelay = outcome?.action === "delivery" && ["queued", "deferred"].includes(outcome.classification)
      ? deliveryRetryMs
      : Math.min(intervalMs * Math.max(1, consecutiveErrors), 10_000);
    await sleep(retryDelay);
  }
}
