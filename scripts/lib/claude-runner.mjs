#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { validateBridgeRequestContract } from "./bridge-contracts.mjs";
import {
  bridgeStreamEnvelope,
  initializeBridgeInput,
  listPendingBridgeInput,
  recoverAuthorizedBridgeInput,
  writeBridgeInputAck
} from "./bridge-input.mjs";
import { appendBridgeEvent, readBridgeEvents } from "./bridge-state.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENV_ALLOWLIST = new Set([
  "HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
  "CLAUDE_CONFIG_DIR", "CODEX_HOME",
  "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"
]);

// The identity names which account home the worker ran under, never the path.
function accountHomeName(value) {
  return typeof value === "string" && value.length > 0 ? path.basename(value) : null;
}

function assertRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("runner request must be an object");
  validateBridgeRequestContract(value);
  if (value.worker?.provider !== "anthropic") throw new Error("runner supports only the anthropic provider");
  if (!UUID_PATTERN.test(value.execution?.claudeSessionId ?? "")) throw new Error("runner requires a valid Claude session UUID");
  if (!Array.isArray(value.execution?.effectiveClaudePermissionArgs)) throw new Error("runner requires effective Claude permission args");
  return value;
}

function mergeAgents(worker) {
  let fromFile = {};
  if (worker.customAgentsFile) {
    fromFile = JSON.parse(fs.readFileSync(worker.customAgentsFile, "utf8"));
    if (!fromFile || typeof fromFile !== "object" || Array.isArray(fromFile)) {
      throw new Error("custom agents file must contain a JSON object");
    }
  }
  const inline = worker.inlineAgents ?? {};
  for (const key of Object.keys(inline)) {
    if (Object.hasOwn(fromFile, key)) throw new Error(`duplicate custom agent definition: ${key}`);
  }
  return { ...fromFile, ...inline };
}

export function buildClaudeRunnerArgs(request) {
  assertRequest(request);
  const { worker, execution } = request;
  const args = [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--replay-user-messages",
    "--session-id", execution.claudeSessionId,
    "--model", worker.model,
    "--effort", worker.effort
  ];
  if (worker.agent) args.push("--agent", worker.agent);
  const agents = mergeAgents(worker);
  if (Object.keys(agents).length > 0) args.push("--agents", JSON.stringify(agents));
  for (const pluginDir of worker.pluginDirs) args.push("--plugin-dir", pluginDir);
  for (const mcpConfig of worker.mcpConfigPaths) args.push("--mcp-config", mcpConfig);
  for (const addDir of worker.addDirs) args.push("--add-dir", addDir);
  args.push(...execution.effectiveClaudePermissionArgs);
  return args;
}

function writeStreamEnvelope(stream, envelope) {
  return new Promise((resolve, reject) => {
    const line = `${JSON.stringify(envelope)}\n`;
    const onError = (error) => {
      stream.off("drain", onDrain);
      reject(error);
    };
    const onDrain = () => {
      stream.off("error", onError);
      resolve();
    };
    stream.once("error", onError);
    if (stream.write(line, "utf8")) {
      stream.off("error", onError);
      resolve();
    } else {
      stream.once("drain", onDrain);
    }
  });
}

function replayedMessageId(line, request, submitted) {
  let event;
  try { event = JSON.parse(line); } catch { return null; }
  if (event?.type !== "user" || event?.session_id !== request.execution.claudeSessionId) return null;
  const serialized = JSON.stringify(event);
  for (const messageId of submitted.keys()) {
    if (serialized.includes(`[Codex bridge message ${messageId}]`)) return messageId;
  }
  return null;
}

function redactedQuestionText(value) {
  return String(value ?? "")
    .replace(/\bsk-(?:ant|proj)-[A-Za-z0-9_-]+\b/gi, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .trim()
    .slice(0, 4_000);
}

function redactedProgressText(value) {
  return redactedQuestionText(value);
}

export function progressFromClaudeLine(line, request) {
  let event;
  try { event = JSON.parse(line); } catch { return []; }
  if (event?.type !== "assistant" || event?.session_id !== request.execution.claudeSessionId) return [];
  const content = Array.isArray(event?.message?.content) ? event.message.content : [];
  const progress = [];
  content.forEach((block, index) => {
    let message = "";
    if (block?.type === "text") {
      message = redactedProgressText(block.text);
    } else if (block?.type === "tool_use" && block?.name !== "AskUserQuestion") {
      const toolName = String(block?.name ?? "").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 128);
      if (toolName) message = `Claude invoked ${toolName}`;
    }
    if (!message) return;
    const stableInput = `${request.execution.claudeSessionId}\n${index}\n${JSON.stringify(block)}`;
    progress.push({
      progressId: String(block?.id ?? crypto.createHash("sha256").update(stableInput).digest("hex")).slice(0, 128),
      message
    });
  });
  return progress;
}

export function questionsFromClaudeLine(line, request) {
  let event;
  try { event = JSON.parse(line); } catch { return []; }
  if (event?.type !== "assistant" || event?.session_id !== request.execution.claudeSessionId) return [];
  const content = Array.isArray(event?.message?.content) ? event.message.content : [];
  const questions = [];
  for (const block of content) {
    if (block?.type !== "tool_use" || block?.name !== "AskUserQuestion") continue;
    const candidates = Array.isArray(block.input?.questions)
      ? block.input.questions
      : [block.input];
    candidates.forEach((candidate, index) => {
      const text = redactedQuestionText(candidate?.question ?? candidate?.text);
      if (!text) return;
      const baseId = String(block.id ?? crypto.createHash("sha256").update(line).digest("hex").slice(0, 32));
      questions.push({
        questionId: `${baseId}${candidates.length > 1 ? `:${index + 1}` : ""}`.slice(0, 256),
        text
      });
    });
  }
  return questions;
}

function requestedPermissionMode(request) {
  const args = request.execution.effectiveClaudePermissionArgs;
  const index = args.indexOf("--permission-mode");
  return index >= 0 ? args[index + 1] ?? null : null;
}

function permissionModeFromInit(line, request) {
  let event;
  try { event = JSON.parse(line); } catch { return null; }
  if (event?.type !== "system" || event?.subtype !== "init" ||
      event?.session_id !== request.execution.claudeSessionId) return null;
  return event.permissionMode ?? event.permission_mode ?? null;
}

function isAuthoritativeResult(line, request) {
  let event;
  try { event = JSON.parse(line); } catch { return false; }
  return event?.type === "result" &&
    event?.session_id === request.execution.claudeSessionId;
}

function writeJsonAtomic(file, payload) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function readPrivateRegularFile(file, label, maximumBytes = 16 * 1024 * 1024) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maximumBytes ||
        (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
      throw new Error(`${label} must be a bounded private regular file`);
    }
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function consumePrivateRegularFile(file, label, maximumBytes = 16 * 1024 * 1024) {
  const claimedFile = `${file}.consuming-${process.pid}-${crypto.randomUUID()}`;
  fs.renameSync(file, claimedFile);
  try {
    return readPrivateRegularFile(claimedFile, label, maximumBytes);
  } finally {
    fs.unlinkSync(claimedFile);
  }
}

function consumePrivateEnvironment(file) {
  if (typeof file !== "string" || !path.isAbsolute(file)) {
    throw new Error("runner environmentFile must be an absolute path");
  }
  const parsed = JSON.parse(consumePrivateRegularFile(file, "runner environmentFile"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("runner environmentFile must contain a JSON object");
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!ENV_ALLOWLIST.has(key)) throw new Error(`runner environment key is not allowlisted: ${key}`);
    if (typeof value !== "string") throw new Error(`runner environment value must be a string: ${key}`);
  }
  return parsed;
}

function processTreeAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function signalProcessTree(child, signal) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) return;
  if (process.platform === "win32") {
    const args = ["/PID", String(child.pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitForProcessTreeExit(pid, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (processTreeAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !processTreeAlive(pid);
}

async function terminateProcessTree(child, graceMilliseconds) {
  signalProcessTree(child, "SIGTERM");
  if (await waitForProcessTreeExit(child.pid, graceMilliseconds)) return true;
  signalProcessTree(child, "SIGKILL");
  return waitForProcessTreeExit(child.pid, Math.max(1_000, graceMilliseconds));
}

export async function runClaudeWorker(spec) {
  if (typeof spec.workerCapabilityToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(spec.workerCapabilityToken)) {
    throw new Error("runner requires a valid job-bound worker capability token");
  }
  if (spec.brokerAuthority !== undefined) throw new Error("runner spec must not contain broker authority");
  const request = assertRequest(JSON.parse(fs.readFileSync(spec.requestFile, "utf8")));
  const childEnvironment = consumePrivateEnvironment(spec.environmentFile);
  const promptFile = path.resolve(spec.promptFile);
  const prompt = readPrivateRegularFile(promptFile, "runner promptFile");
  const jobDir = path.dirname(path.dirname(path.resolve(spec.requestFile)));
  const inputPaths = initializeBridgeInput(jobDir);
  const stdoutFd = fs.openSync(spec.stdoutFile, "a", 0o600);
  const stderrFd = fs.openSync(spec.stderrFile, "a", 0o600);
  const startedAt = new Date().toISOString();
  const identity = {
    workerPid: process.pid,
    claudeSessionId: request.execution.claudeSessionId,
    startedAt,
    requestedPermissionMode: requestedPermissionMode(request),
    effectivePermissionMode: null,
    permissionVerification: "pending",
    accountHomes: {
      claudeConfigDir: accountHomeName(childEnvironment.CLAUDE_CONFIG_DIR),
      codexHome: accountHomeName(childEnvironment.CODEX_HOME)
    }
  };
  writeJsonAtomic(spec.identityFile, identity);

  const child = spawn(spec.claudeBinary, buildClaudeRunnerArgs(request), {
    cwd: request.execution.canonicalWorkspacePath,
    detached: process.platform !== "win32",
    env: childEnvironment,
    stdio: ["pipe", "pipe", stderrFd]
  });
  let timedOut = false;
  let cancelled = false;
  let terminationError = null;
  let inputError = null;
  let termination;
  const beginTermination = (reason, error = null) => {
    if (error && !terminationError) terminationError = String(error?.message ?? error);
    if (termination) return;
    if (reason === "timeout") timedOut = true;
    if (reason === "cancellation") cancelled = true;
    termination = terminateProcessTree(child, spec.timeoutGraceMs ?? 2_000);
  };
  child.stdin.on("error", (error) => beginTermination("input", error));
  child.stdout.on("error", (error) => beginTermination("worker-output", error));
  const hostSignalHandlers = new Map();
  for (const signal of process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGHUP", "SIGINT", "SIGTERM"]) {
    const handler = () => beginTermination("host-shutdown", new Error(`runner received ${signal}`));
    hostSignalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  const initialMessageId = crypto.randomUUID();
  try {
    await writeStreamEnvelope(child.stdin, bridgeStreamEnvelope(initialMessageId, prompt));
  } catch (error) {
    beginTermination("input", error);
  }

  const submitted = new Map();
  let outputBuffer = "";
  let terminalResultObserved = false;
  child.stdout.on("data", (chunk) => {
    try {
      fs.writeSync(stdoutFd, chunk);
      outputBuffer += chunk.toString("utf8");
      for (;;) {
        const newline = outputBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = outputBuffer.slice(0, newline);
        outputBuffer = outputBuffer.slice(newline + 1);
        const effectivePermissionMode = permissionModeFromInit(line, request);
        if (effectivePermissionMode !== null && identity.permissionVerification === "pending") {
          identity.claudePid = child.pid;
          identity.effectivePermissionMode = effectivePermissionMode;
          identity.permissionVerification = effectivePermissionMode === identity.requestedPermissionMode ? "verified" : "mismatch";
          writeJsonAtomic(spec.identityFile, identity);
          if (identity.permissionVerification === "mismatch") {
            beginTermination("permission-mismatch", new Error(
              `effective Claude permission mode ${effectivePermissionMode} does not match requested ${identity.requestedPermissionMode}`
            ));
          }
        }
        if (!terminalResultObserved && isAuthoritativeResult(line, request)) {
          // Claude Code keeps stream-json sessions open while stdin remains
          // writable so callers can send same-session continuation messages.
          // Once the authoritative session emits its result, the bridge job is
          // terminal: close stdin so Claude exits and the durable runner receipt
          // can advance to independent verification and delivery.
          terminalResultObserved = true;
          child.stdin.end();
        }
        for (const progress of progressFromClaudeLine(line, request)) {
          appendBridgeEvent(request.jobId, {
            type: "progress",
            sender: "claude",
            deduplicationKey: `claude-progress:${progress.progressId}`,
            payload: { message: progress.message }
          }, {
            stateRoot: path.dirname(path.dirname(jobDir)),
            capabilityToken: spec.workerCapabilityToken
          });
        }
        for (const question of questionsFromClaudeLine(line, request)) {
          appendBridgeEvent(request.jobId, {
            type: "question",
            sender: "claude",
            deduplicationKey: `claude-question:${question.questionId}`,
            payload: question
          }, {
            stateRoot: path.dirname(path.dirname(jobDir)),
            capabilityToken: spec.workerCapabilityToken
          });
        }
        const messageId = replayedMessageId(line, request, submitted);
        if (!messageId) continue;
        const message = submitted.get(messageId);
        writeBridgeInputAck(jobDir, message, {
          claudeSessionId: request.execution.claudeSessionId,
          observedEventType: "user"
        });
        submitted.delete(messageId);
      }
    } catch (error) {
      beginTermination("worker-output", error);
    }
  });

  let pumping = false;
  const pump = async () => {
    if (pumping || child.stdin.destroyed || child.stdin.writableEnded) return;
    pumping = true;
    try {
      const hasInputCandidate = [inputPaths.stagingDir, inputPaths.queueDir].some((directory) =>
        fs.readdirSync(directory, { withFileTypes: true })
          .some((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json"))
      );
      if (!hasInputCandidate) return;
      const authorizedEvents = readBridgeEvents(request.jobId, {
        stateRoot: path.dirname(path.dirname(jobDir))
      });
      recoverAuthorizedBridgeInput(jobDir, request.jobId, authorizedEvents);
      for (const message of listPendingBridgeInput(jobDir, request.jobId, {
        authorizedEvents,
        claudeSessionId: request.execution.claudeSessionId
      })) {
        if (submitted.has(message.messageId)) continue;
        submitted.set(message.messageId, message);
        try {
          await writeStreamEnvelope(child.stdin, bridgeStreamEnvelope(message.messageId, message.content));
        } catch (error) {
          submitted.delete(message.messageId);
          throw error;
        }
      }
    } catch (error) {
      inputError = error;
      beginTermination("input", error);
    } finally {
      pumping = false;
    }
  };
  const inputPump = setInterval(() => { void pump(); }, Math.max(25, spec.inputPollIntervalMs ?? 100));
  inputPump.unref();
  await pump();
  identity.claudePid = child.pid;
  try {
    writeJsonAtomic(spec.identityFile, identity);
  } catch (error) {
    beginTermination("worker-identity", error);
  }
  const writeHeartbeat = () => {
    try {
      writeJsonAtomic(spec.heartbeatFile, {
        workerPid: process.pid, claudePid: child.pid, timestamp: new Date().toISOString()
      });
    } catch (error) {
      beginTermination("worker-heartbeat", error);
    }
  };
  writeHeartbeat();
  const heartbeat = setInterval(writeHeartbeat, Math.max(100, spec.heartbeatIntervalMs ?? 1_000));
  heartbeat.unref();
  const cancellation = setInterval(() => {
    if (typeof spec.cancelFile !== "string") return;
    try {
      JSON.parse(consumePrivateRegularFile(spec.cancelFile, "runner cancelFile"));
      beginTermination("cancellation");
    } catch (error) {
      if (error?.code === "ENOENT") return;
      terminationError = error.message;
      beginTermination("cancellation");
    }
  }, 25);
  cancellation.unref();
  const timeout = setTimeout(() => {
    beginTermination("timeout");
  }, request.execution.timeoutSeconds * 1_000);
  timeout.unref();
  const outcome = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error: error.message }));
    child.once("close", (code, signal) => resolve({ code, signal, error: null }));
  });
  for (const [signal, handler] of hostSignalHandlers) process.off(signal, handler);
  clearInterval(heartbeat);
  clearInterval(inputPump);
  clearInterval(cancellation);
  clearTimeout(timeout);
  let treeTerminated = true;
  if (termination) {
    try {
      treeTerminated = await termination;
    } catch (error) {
      if (!terminationError) terminationError = String(error?.message ?? error);
      treeTerminated = false;
    }
  }
  for (const fd of [stdoutFd, stderrFd]) fs.closeSync(fd);
  if (spec.requirePermissionAttestation === true && identity.permissionVerification !== "verified" && !terminationError) {
    terminationError = `Claude runtime did not attest requested permission mode ${identity.requestedPermissionMode}`;
  }
  const normalized = {
    workerPid: process.pid,
    claudeSessionId: request.execution.claudeSessionId,
    code: outcome.code,
    signal: outcome.signal,
    error: outcome.error ?? terminationError ?? inputError?.message ?? (treeTerminated ? null : "Claude process tree remained alive after termination"),
    timedOut,
    cancelled,
    treeTerminated,
    exitedAt: new Date().toISOString()
  };
  writeJsonAtomic(spec.exitFile, normalized);
  return normalized;
}

async function main() {
  const index = process.argv.indexOf("--spec");
  if (index < 0 || !process.argv[index + 1]) throw new Error("runner requires --spec <absolute-path>");
  const specPath = path.resolve(process.argv[index + 1]);
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const result = await runClaudeWorker(spec);
  process.exitCode = result.code === 0 && !result.error ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
