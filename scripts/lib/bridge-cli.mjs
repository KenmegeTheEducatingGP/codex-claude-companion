import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./args.mjs";
import { persistBridgeBrokerSpec } from "./bridge-broker.mjs";
import { inspectBridgeRuntimeCompatibility } from "./bridge-runtime.mjs";
import { buildBridgeRequest } from "./bridge-request.mjs";
import * as bridgeState from "./bridge-state.mjs";
import { drainBridgeInbox } from "./bridge-delivery.mjs";
import {
  BRIDGE_WAITER_LEASE,
  createBridgeCoordinationOperations,
  readDelivery,
  readReceipt
} from "./bridge-messaging.mjs";
import {
  commitBridgeInput,
  discardStagedBridgeInput,
  readBridgeInputAck,
  stageBridgeInput
} from "./bridge-input.mjs";
import { buildBridgeWorkerPrompt } from "./bridge-worker-protocol.mjs";
import { discoverBrokerProcess } from "./bridge-repair.mjs";
import { runCommand, spawnDetached } from "./process.mjs";
import { redact } from "./redact.mjs";
import { acquireQueuedLock } from "./state.mjs";

const BROKER_SCRIPT = fileURLToPath(new URL("../bridge-broker.mjs", import.meta.url));
const JOB_PATTERN = /^ccb_[0-9A-HJKMNP-TV-Z]{26}$/;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const AUTO_RECOVERY_GUARD = "CODEX_CLAUDE_BRIDGE_AUTO_RECOVERY";
const AUTO_RECOVERY_SCAN_LIMIT = 64;
const AUTO_RECOVERY_START_LIMIT = 8;
const GC_SCAN_LIMIT = 256;
const GC_APPLY_LIMIT = 64;
const QUEUE_DRAIN_LIMIT = 64;

export const BRIDGE_COMMANDS = Object.freeze(new Set([
  "delegate", "wait", "status", "logs", "cancel", "recover", "list", "attach", "bridge-doctor", "send", "gc"
]));

function usageError(message) {
  const error = new Error(message);
  error.code = "USAGE_ERROR";
  return error;
}

function parse(argv, config = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv, config);
  } catch (error) {
    throw usageError(error.message);
  }
  const unknown = parsed.positionals.find((value) => value.startsWith("--"));
  if (unknown) throw usageError(`Unknown bridge option ${unknown}`);
  return parsed;
}

function integer(value, fallback, label) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw usageError(`${label} must be a positive integer`);
  return parsed;
}

function boundedInteger(value, fallback, label, { minimum = 1, maximum }) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw usageError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function verificationCommands(value) {
  const values = value == null ? [] : (Array.isArray(value) ? value : [value]);
  return values.map((encoded, index) => {
    let argv;
    try { argv = JSON.parse(encoded); } catch {
      throw usageError(`verify-command ${index + 1} must be a JSON argv array`);
    }
    if (!Array.isArray(argv) || argv.length === 0 || argv.length > 64 ||
        argv.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 4_096)) {
      throw usageError(`verify-command ${index + 1} must be a non-empty bounded JSON string array`);
    }
    return argv;
  });
}

function resolveExecutable(nameOrPath) {
  const candidates = path.isAbsolute(nameOrPath)
    ? [nameOrPath]
    : String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, nameOrPath));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const resolved = fs.realpathSync(candidate);
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch {}
  }
  throw new Error(`Required executable not found: ${nameOrPath}`);
}

function gitMetadata(cwd) {
  const branch = runCommand("git", ["branch", "--show-current"], { cwd, timeout: 5_000 });
  const head = runCommand("git", ["rev-parse", "HEAD"], { cwd, timeout: 5_000 });
  return {
    branch: branch.status === 0 ? branch.stdout.trim() || null : null,
    head: head.status === 0 ? head.stdout.trim() || null : null
  };
}

function claudeVersion(binary, cwd) {
  const result = runCommand(binary, ["--version"], { cwd, timeout: 10_000 });
  if (result.error || result.status !== 0) throw new Error("Claude runtime version probe failed");
  return String(result.stdout || result.stderr).trim().split(/\r?\n/)[0];
}

function readJson(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error(`unsafe bridge artifact: ${file}`);
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function diagnosticMessage(error) {
  return redact(error?.message ?? error ?? "Unknown bridge artifact error").slice(0, 2_048);
}

function output(payload, json, write = (text) => process.stdout.write(text)) {
  if (json) return write(`${JSON.stringify(payload, null, 2)}\n`);
  const lines = [`Bridge job: ${payload.jobId ?? "n/a"}`];
  for (const [key, value] of Object.entries(payload)) {
    if (key === "jobId" || value == null || typeof value === "object") continue;
    lines.push(`${key}: ${redact(value)}`);
  }
  write(`${lines.join("\n")}\n`);
}

function stateOptions(options) {
  return options["state-dir"] ? { stateRoot: path.resolve(options["state-dir"]) } : {};
}

function requireJobId(positionals) {
  const jobId = positionals[0];
  if (!JOB_PATTERN.test(jobId ?? "")) throw usageError("A full ccb_ bridge job id is required");
  return jobId;
}

function artifacts(jobId, options) {
  const jobDir = bridgeState.resolveBridgeJobDir(jobId, options);
  return {
    jobDir,
    brokerSpec: path.join(jobDir, "broker-spec.json"),
    brokerHeartbeat: path.join(jobDir, "broker-heartbeat.json"),
    stdout: path.join(jobDir, "runtime", "stdout.jsonl"),
    stderr: path.join(jobDir, "runtime", "stderr.log"),
    brokerLog: path.join(jobDir, "broker.log")
  };
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function readProcessArgv(pid, deps = {}) {
  if (process.platform === "linux") {
    const contents = (deps.readFileSync ?? fs.readFileSync)(`/proc/${pid}/cmdline`);
    return contents.toString("utf8").split("\0").filter((entry) => entry.length > 0);
  }
  if (process.platform === "darwin") {
    const result = (deps.spawnSync ?? spawnSync)("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 5_000
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
      throw result.error ?? new Error(`Unable to inspect broker process ${pid}`);
    }
    return result.stdout.replace(/[\r\n]+$/, "");
  }
  throw new Error(`Exact broker process inspection is unavailable on ${process.platform}`);
}

function exactBrokerProcess(jobId, files, heartbeat, deps = {}) {
  if (heartbeat?.jobId !== jobId || !Number.isInteger(heartbeat?.brokerPid)) return false;
  if (!(deps.processAlive ?? processAlive)(heartbeat.brokerPid)) return false;
  const expected = [deps.nodeBinary ?? process.execPath, deps.brokerScript ?? BROKER_SCRIPT, "--spec", files.brokerSpec];
  const observed = (deps.readProcessArgv ?? readProcessArgv)(heartbeat.brokerPid, deps);
  if (Array.isArray(observed)) {
    return observed.length === expected.length && observed.every((value, index) => value === expected[index]);
  }
  return observed === expected.join(" ");
}

export function startBroker(jobId, options, deps = {}) {
  const files = artifacts(jobId, options);
  const nodeBinary = deps.nodeBinary ?? process.execPath;
  const brokerScript = deps.brokerScript ?? BROKER_SCRIPT;
  const release = (deps.acquireQueuedLock ?? acquireQueuedLock)(path.join(
    bridgeState.resolveBridgeStateRoot(options), "locks", `broker-start-${jobId}`
  ));
  try {
    const heartbeat = readJson(files.brokerHeartbeat);
    if (heartbeat && Number.isInteger(heartbeat.brokerPid) && (deps.processAlive ?? processAlive)(heartbeat.brokerPid)) {
      if (exactBrokerProcess(jobId, files, heartbeat, deps)) {
        return { started: false, pid: heartbeat.brokerPid, reason: "already-running" };
      }
    }
    if (!fs.existsSync(files.brokerSpec)) throw new Error(`Bridge broker spec is unavailable for ${jobId}`);
    const discoveredPid = (deps.discoverBrokerPid ?? ((candidateNode, candidateBroker, specFile) =>
      discoverBrokerProcess(candidateNode, candidateBroker, specFile, deps.listProcesses ?? runCommand)
    ))(nodeBinary, brokerScript, files.brokerSpec);
    if (Number.isInteger(discoveredPid) && discoveredPid > 0) {
      return { started: false, pid: discoveredPid, reason: "reconciled-before-heartbeat" };
    }
    const pid = (deps.spawnDetached ?? spawnDetached)(nodeBinary, [brokerScript, "--spec", files.brokerSpec], {
      cwd: files.jobDir,
      logFile: files.brokerLog,
      env: { ...(deps.env ?? process.env), [AUTO_RECOVERY_GUARD]: "1" }
    });
    deps.afterBrokerSpawn?.({ jobId, pid, specFile: files.brokerSpec });
    return { started: true, pid };
  } finally {
    release();
  }
}

function snapshot(jobId, options, { tolerateReceiptError = false } = {}) {
  const files = artifacts(jobId, options);
  const state = bridgeState.getBridgeJob(jobId, options);
  const brokerAuthority = bridgeState.getBridgeBrokerAuthority(jobId, options);
  const events = bridgeState.readBridgeEvents(jobId, options);
  const answeredQuestionIds = new Set(events
    .filter((event) => event.type === "codex_message" && event.payload.replyTo)
    .map((event) => event.payload.replyTo));
  const pendingQuestions = events
    .filter((event) => event.type === "question" && !answeredQuestionIds.has(event.payload.questionId))
    .map((event) => event.payload);
  const nextQuestion = pendingQuestions[0] ?? null;
  const artifactErrors = [];
  let receipt = null;
  try {
    receipt = readReceipt(jobId, { ...options, brokerAuthority });
  } catch (error) {
    if (!tolerateReceiptError) throw error;
    artifactErrors.push({ artifact: "receipt", message: diagnosticMessage(error) });
  }
  let delivery = null;
  try {
    delivery = readDelivery(jobId, { ...options, brokerAuthority });
  } catch (error) {
    if (!tolerateReceiptError) throw error;
    artifactErrors.push({ artifact: "delivery", message: diagnosticMessage(error) });
  }
  return {
    schemaVersion: 1,
    jobId,
    status: state.status,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    terminalAt: state.terminalAt,
    tmuxSession: state.dispatch?.tmuxSession ?? null,
    claudeSessionId: state.dispatch?.claudeSessionId ?? null,
    cancellationRequested: Boolean(state.cancelRequestedAt),
    pendingQuestionCount: pendingQuestions.length,
    pendingQuestionId: nextQuestion?.questionId ?? null,
    pendingQuestionText: nextQuestion?.text ?? null,
    pendingQuestions,
    broker: readJson(files.brokerHeartbeat),
    receipt,
    // The v1 receipt keeps delivery "pending" while a result waits in the
    // inbox; the queue and its last error come from the durable delivery file.
    deliveryQueue: ["inbox", "inbox_claimed"].includes(delivery?.state) ? "inbox" : null,
    lastError: delivery && delivery.state !== "acknowledged" ? delivery.lastError ?? null : null,
    result: bridgeState.readBridgeResult(jobId, options),
    artifactErrors
  };
}

function unreadableSnapshot(jobId, error) {
  return {
    schemaVersion: 1,
    jobId,
    status: "unreadable",
    createdAt: null,
    updatedAt: null,
    terminalAt: null,
    tmuxSession: null,
    claudeSessionId: null,
    cancellationRequested: false,
    pendingQuestionCount: 0,
    pendingQuestionId: null,
    pendingQuestionText: null,
    pendingQuestions: [],
    broker: null,
    receipt: null,
    deliveryQueue: null,
    lastError: null,
    result: null,
    artifactErrors: [{ artifact: "job", message: diagnosticMessage(error) }]
  };
}

function snapshotSettled(current) {
  if (!TERMINAL.has(current.status) || !current.result) return false;
  const deliveryFinal = ["acknowledged", "failed"].includes(current.receipt?.delivery?.state);
  if (current.status !== "completed") return deliveryFinal;
  return deliveryFinal && ["passed", "failed"].includes(current.receipt?.verification?.state);
}

function listBridgeJobIds(options) {
  const jobsDir = path.join(bridgeState.resolveBridgeStateRoot(options), "jobs");
  try {
    return fs.readdirSync(jobsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && JOB_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function originMatchesScope(origin, scope) {
  return Boolean(origin?.codexThreadId && origin.codexThreadId === scope?.codexThreadId);
}

export function autoRecoverBridgeJobs(bridgeOptions, scope, deps = {}, excludedJobIds = new Set()) {
  if (deps.autoRecoveryGuarded === true || process.env[AUTO_RECOVERY_GUARD] === "1" || !scope?.codexThreadId) {
    return { inspected: 0, attempted: 0, started: 0, jobs: [], errors: [] };
  }
  const jobs = [];
  const errors = [];
  let attempted = 0;
  let inspected = 0;
  const candidates = listBridgeJobIds(bridgeOptions).reverse().slice(0, AUTO_RECOVERY_SCAN_LIMIT);
  for (const jobId of candidates) {
    if (attempted >= AUTO_RECOVERY_START_LIMIT) break;
    inspected += 1;
    if (excludedJobIds.has(jobId)) continue;
    try {
      const request = bridgeState.readBridgeRequest(jobId, bridgeOptions);
      if (!originMatchesScope(request.origin, scope)) continue;
      const current = snapshot(jobId, bridgeOptions);
      if (snapshotSettled(current)) continue;
      attempted += 1;
      const broker = startBroker(jobId, bridgeOptions, deps);
      jobs.push({ jobId, started: broker.started, pid: broker.pid ?? null, reason: broker.reason ?? null });
    } catch (error) {
      errors.push({ jobId, message: redact(error?.message ?? error).slice(0, 320) });
    }
  }
  return {
    inspected,
    attempted,
    started: jobs.filter((job) => job.started).length,
    jobs,
    errors
  };
}

function originCoordination(bridgeOptions) {
  return createBridgeCoordinationOperations({
    ...bridgeOptions,
    brokerAuthorityForJob: (candidate) => bridgeState.getBridgeBrokerAuthority(candidate, bridgeOptions)
  });
}

// Delivers queued (inbox) results for one exact origin to this command's
// output. The caller is that origin, so printing them is the delivery.
async function drainOriginQueue(coordination, origin, queued) {
  for (let index = 0; index < QUEUE_DRAIN_LIMIT; index += 1) {
    const drained = await drainBridgeInbox({
      origin,
      stateOperations: coordination,
      waiter: async (item) => {
        queued.push({ jobId: item.jobId, workerCompleted: item.workerCompleted, verified: item.verified, prompt: item.prompt });
        return { acknowledged: true };
      }
    });
    if (drained.state !== "acknowledged") return;
  }
}

// Drains every queued result addressed to this Codex thread, bounded like
// auto-recovery. It runs before auto-recovery, so a result delivered here never
// restarts a broker.
async function drainOriginThreadQueue(bridgeOptions, codexThreadId) {
  const queued = [];
  if (!codexThreadId) return queued;
  const coordination = originCoordination(bridgeOptions);
  const origins = new Map();
  for (const jobId of listBridgeJobIds(bridgeOptions).reverse().slice(0, AUTO_RECOVERY_SCAN_LIMIT)) {
    try {
      const { origin } = bridgeState.readBridgeRequest(jobId, bridgeOptions);
      if (origin?.codexThreadId !== codexThreadId) continue;
      if (!["inbox", "inbox_claimed"].includes(coordination.readDelivery(jobId)?.state)) continue;
      origins.set(JSON.stringify(origin), origin);
    } catch {
      // An unreadable job is reported by status and list; the drain skips it.
    }
  }
  for (const origin of origins.values()) await drainOriginQueue(coordination, origin, queued);
  return queued;
}

// The origin's own `wait` holds the job's waiter lease, which makes it the
// delivery route: it acknowledges a waiter claim, or drains the job's queued
// result, as it prints the result.
function createOriginWaiter(jobId, bridgeOptions, queued) {
  const coordination = originCoordination(bridgeOptions);
  const { origin } = bridgeState.readBridgeRequest(jobId, bridgeOptions);
  let leaseId = null;
  let refreshAt = 0;
  return {
    async settle() {
      if (Date.now() >= refreshAt) {
        const lease = coordination.acquireWaiterLease(jobId, { leaseId, pid: process.pid });
        leaseId = lease.acquired ? lease.leaseId : null;
        refreshAt = Date.now() + BRIDGE_WAITER_LEASE.refreshMs;
      }
      const delivery = coordination.readDelivery(jobId);
      if (leaseId !== null && delivery?.state === "claimed" && delivery.route === "waiter") {
        const acknowledgedAt = new Date().toISOString();
        coordination.acknowledgeDelivery(jobId, delivery.deliveryClaimId, {
          route: "waiter", deliveredAt: acknowledgedAt, acknowledgedAt
        });
      } else if (delivery?.state === "inbox") {
        await drainOriginQueue(coordination, origin, queued);
      }
    },
    release() {
      if (leaseId !== null) coordination.releaseWaiterLease(jobId, leaseId);
    }
  };
}

function outputWithQueuedResults(payload, queued, json, write) {
  if (queued.length === 0) return output(payload, json, write);
  if (json) return output({ ...payload, queuedResults: queued }, json, write);
  (write ?? ((text) => process.stdout.write(text)))(
    `Queued bridge results delivered to this Codex thread:\n${queued.map((entry) => redact(entry.prompt)).join("\n\n")}\n\n`
  );
  return output(payload, json, write);
}

async function delegate(argv, deps) {
  const { options, positionals } = parse(argv, {
    booleanOptions: ["json", "wait"],
    valueOptions: ["path", "repo-root", "permitted-root", "profile", "agent", "agents-json", "agents-file", "model", "effort", "timeout", "accept", "verify-command", "thread-id", "turn-id", "prompt", "state-dir", "tmux", "claude", "codex", "interval", "max-repairs", "plugin-dir", "mcp-config", "add-dir", "setting-sources"],
    repeatableValueOptions: ["accept", "verify-command", "plugin-dir", "mcp-config", "add-dir"]
  });
  const configuredVerificationCommands = verificationCommands(options["verify-command"]);
  if (configuredVerificationCommands.length === 0) {
    throw usageError("delegate requires at least one origin-supplied --verify-command JSON argv array");
  }
  const maxRepairs = boundedInteger(options["max-repairs"], 0, "max-repairs", { minimum: 0, maximum: 1 });
  const cwd = fs.realpathSync(path.resolve(options.path ?? process.cwd()));
  const repoRoot = fs.realpathSync(path.resolve(options["repo-root"] ?? cwd));
  const permittedRoot = fs.realpathSync(path.resolve(options["permitted-root"] ?? repoRoot));
  const userPrompt = options.prompt ?? positionals.join(" ").trim();
  if (!userPrompt) throw usageError("delegate requires --prompt <text> or positional task text");
  const codexThreadId = options["thread-id"] ?? process.env.CODEX_THREAD_ID;
  if (!codexThreadId) throw usageError("delegate requires --thread-id or CODEX_THREAD_ID for durable result routing");
  const claudeBinary = resolveExecutable(options.claude ?? "claude");
  const tmuxBinary = resolveExecutable(options.tmux ?? "tmux");
  const codexBinary = resolveExecutable(options.codex ?? "codex");
  const metadata = gitMetadata(repoRoot);
  const accept = options.accept == null ? ["Complete the requested task and report repository-native validation evidence."]
    : (Array.isArray(options.accept) ? options.accept : [options.accept]);
  const request = buildBridgeRequest({
    agent: options.agent,
    agents: options["agents-json"],
    agentsFile: options["agents-file"],
    model: options.model ?? "opus",
    effort: options.effort ?? "high",
    profile: options.profile ?? "standard",
    executor: "tmux",
    workspace: "current",
    workspacePath: cwd,
    permittedRoot,
    timeout: integer(options.timeout, 1_800, "timeout"),
    codexThreadId,
    codexTurnId: options["turn-id"] ?? process.env.CODEX_TURN_ID ?? null,
    cwd,
    repoRoot,
    branch: metadata.branch,
    head: metadata.head,
    resolvedRuntimeVersion: claudeVersion(claudeBinary, cwd),
    promptFile: "runtime/prompt.txt",
    acceptance: accept,
    pluginDirs: options["plugin-dir"],
    mcpConfigs: options["mcp-config"],
    addDirs: options["add-dir"],
    settingSources: options["setting-sources"]
  });
  const bridgeOptions = stateOptions(options);
  const queuedResults = await drainOriginThreadQueue(bridgeOptions, codexThreadId);
  autoRecoverBridgeJobs(bridgeOptions, request.origin, deps);
  const created = bridgeState.createBridgeJob(request, bridgeOptions);
  const files = artifacts(request.jobId, bridgeOptions);
  const prompt = buildBridgeWorkerPrompt({ request, userPrompt });
  persistBridgeBrokerSpec(files.brokerSpec, {
    schemaVersion: 1,
    jobId: request.jobId,
    stateRoot: bridgeState.resolveBridgeStateRoot(bridgeOptions),
    jobDir: files.jobDir,
    prompt,
    workerCapabilityToken: created.capabilityToken,
    tmuxBinary,
    claudeBinary,
    codexBinary,
    nodeBinary: fs.realpathSync(process.execPath),
    envBinary: fs.realpathSync("/usr/bin/env"),
    heartbeatFile: files.brokerHeartbeat,
    intervalMs: integer(options.interval, 500, "interval"),
    maxRepairs,
    verificationCommands: configuredVerificationCommands,
    securityRequirements: {}
  });
  const broker = startBroker(request.jobId, bridgeOptions, deps);
  outputWithQueuedResults({
    schemaVersion: 1,
    jobId: request.jobId,
    status: "accepted",
    profile: request.execution.profile,
    containment: request.execution.profile === "trusted-autonomous" ? "cooperative same-UID host trust; not a security sandbox" : "profile-enforced Claude permissions",
    tmuxSession: request.execution.tmuxSession,
    brokerPid: broker.pid,
    monitor: "detached durable broker",
    next: `codex-claude wait ${request.jobId}`
  }, queuedResults, options.json, deps.write);
  if (options.wait) return waitForJob(request.jobId, bridgeOptions, { json: options.json, originCaller: true }, deps);
  return 0;
}

async function waitForJob(jobId, bridgeOptions, options, deps = {}) {
  const queued = [...(options.queuedResults ?? [])];
  const emit = (payload) => outputWithQueuedResults(payload, queued, options.json, deps.write);
  // Only the origin's own wait becomes the delivery route; any other caller
  // observes and never acknowledges.
  const originWaiter = options.originCaller === true ? createOriginWaiter(jobId, bridgeOptions, queued) : null;
  try {
    await originWaiter?.settle();
    const initial = snapshot(jobId, bridgeOptions);
    if (!TERMINAL.has(initial.status) && initial.pendingQuestionCount > 0) {
      emit(initial);
      return 4;
    }
    if (snapshotSettled(initial)) {
      emit(initial);
      if (initial.status !== "completed") return 3;
      return initial.receipt?.verification?.state === "passed" && initial.receipt?.delivery?.state === "acknowledged" ? 0 : 3;
    }
    startBroker(jobId, bridgeOptions, deps);
    const timeoutSeconds = integer(options.timeout, 86_400, "timeout");
    const deadline = Date.now() + timeoutSeconds * 1_000;
    while (Date.now() < deadline) {
      await originWaiter?.settle();
      const current = snapshot(jobId, bridgeOptions);
      if (!TERMINAL.has(current.status) && current.pendingQuestionCount > 0) {
        emit(current);
        return 4;
      }
      if (TERMINAL.has(current.status) && current.result && current.status !== "completed" &&
          ["acknowledged", "failed"].includes(current.receipt?.delivery?.state)) {
        emit(current);
        return 3;
      }
      const verificationState = current.receipt?.verification?.state;
      const deliveryState = current.receipt?.delivery?.state;
      if (current.status === "completed" && current.result &&
          ["passed", "failed"].includes(verificationState) &&
          ["acknowledged", "failed"].includes(deliveryState)) {
        emit(current);
        return verificationState === "passed" && deliveryState === "acknowledged" ? 0 : 3;
      }
      await (deps.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(250);
    }
    throw new Error(`Timed out waiting for bridge job ${jobId}`);
  } finally {
    originWaiter?.release();
  }
}

function tail(file, bytes = 64 * 1024) {
  return readLogRange(file, null, bytes).text;
}

function readLogRange(file, start, maximumBytes = 64 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error?.code === "ENOENT") return { text: "", offset: 0 };
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`unsafe bridge log: ${file}`);
    const offset = start === null ? Math.max(0, stat.size - maximumBytes) : stat.size < start ? 0 : start;
    const length = Math.min(maximumBytes, stat.size - offset);
    if (length <= 0) return { text: "", offset };
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
    return { text: redact(buffer.subarray(0, bytesRead).toString("utf8")), offset: offset + bytesRead };
  } finally { fs.closeSync(fd); }
}

export async function followBridgeLog(file, options = {}) {
  const write = options.write ?? ((text) => process.stdout.write(text));
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? (() => Date.now());
  const timeoutMs = boundedInteger(options.timeoutMs, 300_000, "follow timeout", { minimum: 1, maximum: 3_600_000 });
  const pollMs = boundedInteger(options.pollMs, 250, "follow poll interval", { minimum: 50, maximum: 5_000 });
  const deadline = now() + timeoutMs;
  const initial = readLogRange(file, null);
  let offset = initial.offset;
  if (initial.text) write(initial.text);

  while (now() < deadline) {
    const chunk = readLogRange(file, offset);
    offset = chunk.offset;
    if (chunk.text) write(chunk.text);
    if (!chunk.text && options.isTerminal?.()) return { reason: "terminal", offset };
    await sleep(pollMs);
  }
  return { reason: "timeout", offset };
}

export async function handleBridgeCommand(command, argv, deps = {}) {
  if (!BRIDGE_COMMANDS.has(command)) return false;
  if (command === "delegate") return delegate(argv, deps);
  const { options, positionals } = parse(argv, {
    booleanOptions: ["json", "stderr", "broker", "exec", "wait", "follow", "all", "apply"],
    valueOptions: ["state-dir", "timeout", "reason", "lines", "message", "poll-interval", "question-id", "older-than-days", "limit"]
  });
  const bridgeOptions = stateOptions(options);
  let originCaller = false;
  let queuedResults = [];

  if (command !== "recover" && command !== "gc") {
    const targetJobId = JOB_PATTERN.test(positionals[0] ?? "") ? positionals[0] : null;
    let targetOrigin = null;
    if (targetJobId) {
      try { targetOrigin = bridgeState.readBridgeRequest(targetJobId, bridgeOptions).origin; } catch {}
    }
    const callerThreadId = deps.codexThreadId ?? process.env.CODEX_THREAD_ID ?? null;
    // The caller is the job's origin when its Codex thread is the one that
    // delegated the job. Its wait and status receive the thread's queued
    // results before auto-recovery, so a delivered result restarts no broker.
    originCaller = Boolean(callerThreadId) && targetOrigin?.codexThreadId === callerThreadId;
    if (originCaller && (command === "wait" || command === "status")) {
      queuedResults = await drainOriginThreadQueue(bridgeOptions, callerThreadId);
    }
    let scope = deps.codexOrigin ?? targetOrigin;
    if (!scope && callerThreadId) scope = { codexThreadId: callerThreadId };
    const commandStartsTarget = new Set(["wait", "cancel", "send"]);
    const excluded = targetJobId && commandStartsTarget.has(command) ? new Set([targetJobId]) : new Set();
    autoRecoverBridgeJobs(bridgeOptions, scope, deps, excluded);
  }

  if (command === "bridge-doctor") {
    let tmux = null;
    let claude = null;
    let codex = null;
    try { tmux = resolveExecutable("tmux"); } catch {}
    try { claude = resolveExecutable("claude"); } catch {}
    try { codex = resolveExecutable("codex"); } catch {}
    const compatibility = inspectBridgeRuntimeCompatibility({ stateOptions: bridgeOptions, codexBinary: codex ?? undefined });
    const payload = {
      schemaVersion: 1,
      jobId: null,
      ready: compatibility.ready && Boolean(tmux && claude && codex),
      runtimeReady: compatibility.ready,
      tmuxAvailable: Boolean(tmux),
      claudeAvailable: Boolean(claude),
      codexAvailable: Boolean(codex),
      independentVerifierReady: compatibility.ready && Boolean(codex),
      trustedAutonomousContainment: "cooperative same-UID host trust; not a security sandbox",
      sandboxAutonomousAvailable: false,
      monitoring: "detached broker with durable heartbeats, leases, and explicit recovery"
    };
    output(payload, options.json, deps.write);
    return payload.ready ? 0 : 2;
  }
  if (command === "list") {
    const jobs = listBridgeJobIds(bridgeOptions).map((jobId) => {
      try {
        return snapshot(jobId, bridgeOptions, { tolerateReceiptError: true });
      } catch (error) {
        return unreadableSnapshot(jobId, error);
      }
    });
    if (options.json) (deps.write ?? ((text) => process.stdout.write(text)))(`${JSON.stringify({ schemaVersion: 1, jobs }, null, 2)}\n`);
    else if (jobs.length === 0) (deps.write ?? ((text) => process.stdout.write(text)))("No bridge jobs.\n");
    else (deps.write ?? ((text) => process.stdout.write(text)))(`${jobs.map((job) => `${job.jobId}\t${job.status}\t${job.updatedAt}`).join("\n")}\n`);
    return 0;
  }
  if (command === "gc") {
    if (positionals.length > 0) throw usageError("gc does not accept a job id");
    const olderThanDays = boundedInteger(options["older-than-days"], 30, "older-than-days", { minimum: 1, maximum: 3_650 });
    const limit = boundedInteger(options.limit, GC_APPLY_LIMIT, "limit", { minimum: 1, maximum: GC_APPLY_LIMIT });
    const olderThanMs = olderThanDays * 24 * 60 * 60 * 1_000;
    const nowMs = Date.now();
    const scannedJobIds = listBridgeJobIds(bridgeOptions).slice(0, GC_SCAN_LIMIT);
    const candidates = scannedJobIds.filter((jobId) => {
      try {
        const state = bridgeState.getBridgeJob(jobId, bridgeOptions);
        return TERMINAL.has(state.status) && state.terminalAt && nowMs - Date.parse(state.terminalAt) >= olderThanMs;
      } catch {
        return false;
      }
    }).slice(0, limit);
    const removed = options.apply ? bridgeState.collectBridgeJobs({
      ...bridgeOptions,
      olderThanMs,
      nowMs,
      candidateJobIds: candidates,
      brokerAuthorityForJob: (jobId) => bridgeState.getBridgeBrokerAuthority(jobId, bridgeOptions)
    }) : [];
    const payload = {
      schemaVersion: 1,
      dryRun: !options.apply,
      olderThanDays,
      scanLimit: GC_SCAN_LIMIT,
      applyLimit: limit,
      scanned: scannedJobIds.length,
      candidates,
      removed
    };
    if (options.json) (deps.write ?? ((text) => process.stdout.write(text)))(`${JSON.stringify(payload, null, 2)}\n`);
    else if (!options.apply) (deps.write ?? ((text) => process.stdout.write(text)))(candidates.length === 0
      ? "No expired terminal bridge jobs. Dry run; nothing removed.\n"
      : `${candidates.join("\n")}\nDry run; rerun with --apply to remove up to ${limit} listed jobs.\n`);
    else (deps.write ?? ((text) => process.stdout.write(text)))(removed.length === 0
      ? "No expired terminal bridge jobs removed.\n"
      : `${removed.join("\n")}\nRemoved ${removed.length} expired terminal bridge job(s).\n`);
    return 0;
  }
  if (command === "recover" && options.all) {
    if (positionals.length > 0) throw usageError("recover --all does not accept a job id");
    const recovered = [];
    const errors = [];
    for (const jobId of listBridgeJobIds(bridgeOptions)) {
      try {
        const authority = bridgeState.getBridgeBrokerAuthority(jobId, bridgeOptions);
        const state = bridgeState.recoverBridgeJob(jobId, { ...bridgeOptions, brokerAuthority: authority });
        const current = snapshot(jobId, bridgeOptions, { tolerateReceiptError: true });
        if (current.artifactErrors.length > 0) {
          errors.push({
            jobId,
            message: current.artifactErrors.map((entry) => `${entry.artifact}: ${entry.message}`).join("; ")
          });
          continue;
        }
        const broker = snapshotSettled(current)
          ? { started: false, pid: null, reason: "settled" }
          : startBroker(jobId, bridgeOptions, deps);
        recovered.push({ jobId, status: state.status, brokerStarted: broker.started, brokerPid: broker.pid ?? null, reason: broker.reason ?? null });
      } catch (error) {
        errors.push({ jobId, message: diagnosticMessage(error) });
      }
    }
    if (options.json) (deps.write ?? ((text) => process.stdout.write(text)))(`${JSON.stringify({ schemaVersion: 1, recovered, errors }, null, 2)}\n`);
    else if (recovered.length === 0 && errors.length === 0) (deps.write ?? ((text) => process.stdout.write(text)))("No bridge jobs to recover.\n");
    else {
      const lines = [
        ...recovered.map((item) => `${item.jobId}\t${item.status}\t${item.brokerStarted ? "broker-started" : item.reason}`),
        ...errors.map((item) => `${item.jobId}\terror\t${item.message}`)
      ];
      (deps.write ?? ((text) => process.stdout.write(text)))(`${lines.join("\n")}\n`);
    }
    return errors.length === 0 ? 0 : 3;
  }
  const jobId = requireJobId(positionals);
  if (command === "wait") return waitForJob(jobId, bridgeOptions, { ...options, originCaller, queuedResults }, deps);
  if (command === "status") {
    outputWithQueuedResults(snapshot(jobId, bridgeOptions, { tolerateReceiptError: true }), queuedResults, options.json, deps.write);
    return 0;
  }
  if (command === "logs") {
    const files = artifacts(jobId, bridgeOptions);
    const selected = options.broker ? files.brokerLog : (options.stderr ? files.stderr : files.stdout);
    if (options.follow) {
      await followBridgeLog(selected, {
        write: deps.write,
        sleep: deps.sleep,
        now: deps.now,
        timeoutMs: boundedInteger(options.timeout, 300, "timeout", { minimum: 1, maximum: 3_600 }) * 1_000,
        pollMs: boundedInteger(options["poll-interval"], 250, "poll-interval", { minimum: 50, maximum: 5_000 }),
        isTerminal: () => TERMINAL.has(bridgeState.getBridgeJob(jobId, bridgeOptions).status)
      });
    } else {
      (deps.write ?? ((text) => process.stdout.write(text)))(tail(selected));
    }
    return 0;
  }
  if (command === "cancel") {
    const authority = bridgeState.getBridgeBrokerAuthority(jobId, bridgeOptions);
    const state = bridgeState.requestBridgeCancellation(jobId, options.reason ?? "Cancellation requested by Codex bridge CLI", {
      ...bridgeOptions, brokerAuthority: authority
    });
    startBroker(jobId, bridgeOptions, deps);
    output({ schemaVersion: 1, jobId, status: state.status, cancellation: "requested; broker confirmation pending" }, options.json, deps.write);
    return 0;
  }
  if (command === "recover") {
    const authority = bridgeState.getBridgeBrokerAuthority(jobId, bridgeOptions);
    const state = bridgeState.recoverBridgeJob(jobId, { ...bridgeOptions, brokerAuthority: authority });
    const broker = snapshotSettled(snapshot(jobId, bridgeOptions))
      ? { started: false, pid: null, reason: "settled" }
      : startBroker(jobId, bridgeOptions, deps);
    output({ schemaVersion: 1, jobId, status: state.status, brokerStarted: broker.started, brokerPid: broker.pid, reason: broker.reason }, options.json, deps.write);
    return 0;
  }
  if (command === "attach") {
    const state = bridgeState.getBridgeJob(jobId, bridgeOptions);
    const session = state.dispatch?.tmuxSession ?? bridgeState.readBridgeRequest(jobId, bridgeOptions).execution.tmuxSession;
    if (!options.exec) {
      output({ schemaVersion: 1, jobId, tmuxSession: session, command: `tmux attach-session -t =${session}`, note: "observation only; input can interfere with the managed worker" }, options.json, deps.write);
      return 0;
    }
    const result = (deps.spawnSync ?? spawnSync)(resolveExecutable("tmux"), ["attach-session", "-t", `=${session}`], { stdio: "inherit" });
    return result.status ?? 1;
  }
  if (command === "send") {
    const state = bridgeState.getBridgeJob(jobId, bridgeOptions);
    if (TERMINAL.has(state.status)) throw new Error(`Cannot send to terminal bridge job ${jobId} (${state.status})`);
    const questionId = options["question-id"] ?? null;
    if (questionId !== null) {
      const current = snapshot(jobId, bridgeOptions);
      if (!current.pendingQuestions.some((question) => question.questionId === questionId)) {
        throw new Error(`No pending Claude question ${questionId} exists for ${jobId}`);
      }
    }
    const suppliedContent = options.message ?? positionals.slice(1).join(" ").trim();
    const content = questionId ? `[Answer to Claude question ${questionId}]\n${suppliedContent}` : suppliedContent;
    const authority = bridgeState.getBridgeBrokerAuthority(jobId, bridgeOptions);
    const jobDir = artifacts(jobId, bridgeOptions).jobDir;
    const message = stageBridgeInput(jobDir, jobId, content);
    try {
      bridgeState.appendBridgeCodexMessage(jobId, {
        messageId: message.messageId,
        text: suppliedContent,
        contentSha256: message.contentSha256,
        ...(questionId ? { replyTo: questionId } : {})
      }, { ...bridgeOptions, brokerAuthority: authority });
    } catch (error) {
      let authorized = false;
      try {
        authorized = bridgeState.readBridgeEvents(jobId, bridgeOptions).some((event) =>
          event.type === "codex_message" &&
          event.sender === "codex" &&
          event.payload.messageId === message.messageId &&
          event.payload.contentSha256 === message.contentSha256
        );
      } catch {
        authorized = false;
      }
      if (!authorized) {
        discardStagedBridgeInput(jobDir, message);
        throw error;
      }
    }
    commitBridgeInput(jobDir, message);
    startBroker(jobId, bridgeOptions, deps);
    const acknowledgementOptions = {
      expectedMessage: message,
      claudeSessionId: state.dispatch?.claudeSessionId
    };
    let acknowledgement = readBridgeInputAck(jobDir, message.messageId, acknowledgementOptions);
    if (options.wait) {
      const deadline = Date.now() + integer(options.timeout, 60, "timeout") * 1_000;
      while (!acknowledgement && Date.now() < deadline) {
        const current = bridgeState.getBridgeJob(jobId, bridgeOptions);
        if (TERMINAL.has(current.status)) break;
        await (deps.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(50);
        acknowledgement = readBridgeInputAck(jobDir, message.messageId, acknowledgementOptions);
      }
      if (!acknowledgement) throw new Error(`Bridge input ${message.messageId} was not replay-acknowledged before timeout or worker exit`);
    }
    output({
      schemaVersion: 1,
      jobId,
      status: acknowledgement ? "observed" : "queued",
      messageId: message.messageId,
      claudeSessionId: acknowledgement?.claudeSessionId ?? state.dispatch?.claudeSessionId ?? null,
      acknowledgement: acknowledgement ? "Claude replayed the user event in the authoritative session" : "pending"
    }, options.json, deps.write);
    return 0;
  }
  return false;
}

export function isBridgeJobInvocation(argv) {
  return argv.some((value) => JOB_PATTERN.test(value));
}
