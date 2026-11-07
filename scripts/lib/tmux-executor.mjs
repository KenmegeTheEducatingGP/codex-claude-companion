import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { validateBridgeRequestContract } from "./bridge-contracts.mjs";
import { initializeBridgeInput } from "./bridge-input.mjs";

const JOB_ID_PATTERN = /^ccb_[0-9A-HJKMNP-TV-Z]{26}$/;
// CLAUDE_CONFIG_DIR and CODEX_HOME are non-secret paths that select the
// delegating session's own account home; without them the worker silently
// falls back to the default home (another account, settings and quota).
const ENV_ALLOWLIST = new Set([
  "HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
  "CLAUDE_CONFIG_DIR", "CODEX_HOME",
  "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"
]);
const RUNNER_PATH = fileURLToPath(new URL("./claude-runner.mjs", import.meta.url));

export function deriveTmuxSessionName(jobId) {
  if (!JOB_ID_PATTERN.test(jobId ?? "")) throw new Error("Invalid bridge job id for tmux session identity");
  return `ccb-${jobId.slice(4)}`;
}

export function buildMinimalWorkerEnv(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => ENV_ALLOWLIST.has(key) && typeof value === "string"));
}

function verifiedBinary(binary, label) {
  if (typeof binary !== "string" || !path.isAbsolute(binary)) throw new Error(`${label} binary must be an absolute path`);
  const resolved = fs.realpathSync(binary);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`${label} binary must be a regular file`);
  fs.accessSync(resolved, fs.constants.X_OK);
  return resolved;
}

function assertPrivateDirectory(dir) {
  const resolved = fs.realpathSync(dir);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("bridge job directory must be a real directory");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("bridge job directory must not be accessible by group or other users");
  }
  return resolved;
}

function writePrivateFile(file, contents) {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function unlinkIfPresent(file) {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function tmuxArgs(socketName, args) {
  if (socketName === undefined || socketName === null) return args;
  if (typeof socketName !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(socketName)) {
    throw new Error("tmux socket name contains unsafe characters");
  }
  return ["-L", socketName, ...args];
}

function defaultRunCommand(binary, args) {
  const result = spawnSync(binary, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

async function forceTerminateRecordedTree(identityFile, graceMilliseconds) {
  const identity = typeof identityFile === "string" ? readJsonIfPresent(identityFile) : null;
  const pid = identity?.claudePid;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return forceTerminateProcessTree(pid, graceMilliseconds);
}

async function forceTerminateProcessTree(pid, graceMilliseconds) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      try {
        process.kill(-pid, signal);
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
      const deadline = Date.now() + graceMilliseconds;
      while (processTreeAlive(pid) && Date.now() < deadline) await delay(20);
      if (!processTreeAlive(pid)) return true;
    }
  }
  return !processTreeAlive(pid);
}

function defaultProcessCommand(pid) {
  if (process.platform === "win32") return null;
  const result = spawnSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) return null;
  return String(result.stdout ?? "").trim() || null;
}

function commandOwnsClaudeSession(command, claudeBinary, claudeSessionId) {
  if (typeof command !== "string" || typeof claudeBinary !== "string" ||
      typeof claudeSessionId !== "string") return false;
  if (command !== claudeBinary && !command.startsWith(`${claudeBinary} `)) return false;
  const escapedSession = claudeSessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)--session-id(?:=|\\s+)${escapedSession}(?=\\s|$)`).test(command);
}

function readJsonIfPresent(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`unsafe runtime artifact: ${file}`);
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

function attributedExit(exit, identity) {
  return exit && exit.workerPid === identity.workerPid &&
    exit.claudeSessionId === identity.claudeSessionId ? exit : null;
}

async function awaitAttributedExit(exitFile, identity, graceMilliseconds) {
  const deadline = Date.now() + Math.max(0, graceMilliseconds);
  for (;;) {
    const exit = attributedExit(readJsonIfPresent(exitFile), identity);
    if (exit || Date.now() >= deadline) return exit;
    await delay(Math.min(20, Math.max(1, deadline - Date.now())));
  }
}

function runtimeArtifacts(jobDir) {
  const runtimeDir = path.join(assertPrivateDirectory(jobDir), "runtime");
  return {
    identityFile: path.join(runtimeDir, "identity.json"),
    launchIdentityFile: path.join(runtimeDir, "launch-identity.json"),
    heartbeatFile: path.join(runtimeDir, "heartbeat.json"),
    exitFile: path.join(runtimeDir, "exit.json")
  };
}

function queryExactPane(tmuxBinary, socketName, session, runCommand) {
  const result = runCommand(tmuxBinary, tmuxArgs(socketName, [
    "display-message", "-p", "-t", `=${session}:0.0`,
    "#{session_name}\t#{pane_id}\t#{pane_pid}"
  ]));
  if (result.status === 1) return { classification: "missing" };
  if (result.status !== 0) {
    throw new Error(`failed to inspect exact tmux pane: ${result.stderr || result.stdout}`);
  }
  // tmux 3.7b can report success with an empty expansion when an exact target
  // disappeared between lookup and formatting. A real pane always supplies
  // all three requested values, so the empty response is an attributable
  // missing-session observation rather than an identity mismatch.
  if (result.stdout.trim() === "" && result.stderr.trim() === "") {
    return { classification: "missing" };
  }
  const [actualSession, paneId, panePidText, ...extra] = result.stdout.trim().split("\t");
  const panePid = Number(panePidText);
  if (extra.length > 0 || actualSession !== session || !/^%[0-9]+$/.test(paneId ?? "") ||
      !Number.isInteger(panePid) || panePid <= 0) {
    return { classification: "stale", reason: "tmux pane identity mismatch" };
  }
  return { classification: "live", paneId, panePid };
}

function persistRecoveredIdentity(file, identity) {
  try {
    writePrivateFile(file, `${JSON.stringify(identity, null, 2)}\n`);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = readJsonIfPresent(file);
    if (JSON.stringify(existing) !== JSON.stringify(identity)) {
      throw new Error("immutable recovered tmux identity mismatch");
    }
  }
}

function assertConcreteIdentity(identity, jobId) {
  const session = deriveTmuxSessionName(jobId);
  if (!identity || identity.executor !== "tmux" || identity.tmuxSession !== session ||
      !/^%[0-9]+$/.test(identity.paneId ?? "") ||
      !Number.isInteger(identity.panePid) || identity.panePid <= 0 ||
      identity.workerPid !== identity.panePid ||
      typeof identity.claudeSessionId !== "string" || identity.claudeSessionId.length === 0) {
    throw new Error("recovered tmux worker identity is incomplete or mismatched");
  }
  return identity;
}

export async function discover(jobId, currentSnapshot, options = {}) {
  const session = deriveTmuxSessionName(jobId);
  const request = currentSnapshot?.request;
  if (request?.jobId !== jobId || request?.execution?.tmuxSession !== session ||
      request?.execution?.executor !== "tmux") {
    throw new Error("worker discovery requires the exact immutable bridge request");
  }
  const tmuxBinary = verifiedBinary(options.tmuxBinary, "tmux");
  const runCommand = options.runCommand ?? defaultRunCommand;
  const artifacts = runtimeArtifacts(options.jobDir);
  const recovered = readJsonIfPresent(artifacts.launchIdentityFile);
  if (recovered) return [structuredClone(assertConcreteIdentity(recovered, jobId))];

  const runner = readJsonIfPresent(artifacts.identityFile);
  if (!runner) return [];
  const pane = queryExactPane(tmuxBinary, options.tmuxSocketName, session, runCommand);
  if (pane.classification === "missing") return [];
  if (pane.classification !== "live" || pane.panePid !== runner.workerPid ||
      runner.claudeSessionId !== request.execution.claudeSessionId) {
    return [];
  }
  const identity = {
    executor: "tmux",
    tmuxSession: session,
    paneId: pane.paneId,
    panePid: pane.panePid,
    workerPid: runner.workerPid,
    claudeSessionId: runner.claudeSessionId,
    origin: structuredClone(request.origin),
    recordedAt: runner.startedAt ?? new Date().toISOString()
  };
  persistRecoveredIdentity(artifacts.launchIdentityFile, identity);
  return [structuredClone(identity)];
}

export async function inspectProcess(identity, options = {}) {
  const jobId = identity?.jobId ?? options.jobId ??
    (typeof identity?.tmuxSession === "string" && /^ccb-[0-9A-HJKMNP-TV-Z]{26}$/.test(identity.tmuxSession)
      ? `ccb_${identity.tmuxSession.slice(4)}` : null);
  if (!jobId) return { classification: "stale", reason: "worker job identity is unavailable" };
  try {
    assertConcreteIdentity(identity, jobId);
  } catch (error) {
    return { classification: "stale", reason: error.message };
  }
  const tmuxBinary = verifiedBinary(options.tmuxBinary, "tmux");
  const runCommand = options.runCommand ?? defaultRunCommand;
  const artifacts = identity.artifacts ?? runtimeArtifacts(options.jobDir);
  const runner = readJsonIfPresent(artifacts.identityFile);
  let exit = attributedExit(readJsonIfPresent(artifacts.exitFile), identity);
  const pane = queryExactPane(tmuxBinary, options.tmuxSocketName ?? identity.tmuxSocketName,
    identity.tmuxSession, runCommand);
  if (pane.classification === "missing") {
    exit ??= await awaitAttributedExit(artifacts.exitFile, identity, options.exitArtifactGraceMs ?? 500);
    if (exit) return { classification: "dead", exit };
    if (runner && runner.workerPid === identity.workerPid &&
        runner.claudeSessionId === identity.claudeSessionId &&
        Number.isInteger(runner.claudePid) && runner.claudePid > 0) {
      const processProbe = options.processProbe ?? processTreeAlive;
      if (!processProbe(runner.claudePid)) {
        return {
          classification: "dead",
          exit: {
            workerPid: identity.workerPid,
            claudeSessionId: identity.claudeSessionId,
            code: null,
            signal: null,
            error: "tmux worker disappeared without a durable exit record"
          }
        };
      }
      const specFile = artifacts.specFile ?? path.join(path.dirname(artifacts.identityFile), "runner-spec.json");
      const runnerSpec = readJsonIfPresent(specFile);
      const processCommand = options.processCommand ?? defaultProcessCommand;
      const command = processCommand(runner.claudePid);
      if (commandOwnsClaudeSession(command, runnerSpec?.claudeBinary, identity.claudeSessionId)) {
        const terminate = options.processTerminator ?? ((pid) => forceTerminateProcessTree(
          pid, options.orphanTerminationGraceMs ?? 500
        ));
        if (await terminate(runner.claudePid)) {
          return {
            classification: "dead",
            exit: {
              workerPid: identity.workerPid,
              claudeSessionId: identity.claudeSessionId,
              code: null,
              signal: "SIGTERM",
              error: "orphaned Claude process reaped after tmux worker disappearance"
            }
          };
        }
        return {
          classification: "stale",
          reason: "attributable orphaned Claude process survived recovery termination"
        };
      }
      return {
        classification: "stale",
        reason: "recorded Claude process tree survived a missing tmux session"
      };
    }
    return { classification: "missing" };
  }
  if (pane.classification !== "live" || pane.paneId !== identity.paneId ||
      pane.panePid !== identity.panePid) {
    return { classification: "stale", reason: "tmux pane identity mismatch" };
  }
  if (!runner || runner.workerPid !== identity.workerPid ||
      runner.claudeSessionId !== identity.claudeSessionId ||
      !Number.isInteger(runner.claudePid) || runner.claudePid <= 0) {
    return { classification: "stale", reason: "runner identity artifact mismatch" };
  }
  const processProbe = options.processProbe ?? processTreeAlive;
  if (!processProbe(runner.claudePid)) {
    // The Claude child can exit a few milliseconds before the runner has
    // fsynced its authoritative exit receipt. Treat that handoff as a bounded
    // completion race, not as stale ownership that strands recovery.
    exit ??= await awaitAttributedExit(artifacts.exitFile, identity, options.exitArtifactGraceMs ?? 500);
    if (exit) return { classification: "dead", exit };
    return { classification: "stale", reason: "recorded Claude process tree is not attributable" };
  }
  return {
    classification: "live", paneId: pane.paneId, panePid: pane.panePid,
    workerPid: runner.workerPid, claudePid: runner.claudePid
  };
}

export async function launchTmuxClaudeWorker(options) {
  const { request, prompt, stateOperations } = options;
  if (!request || typeof request !== "object") throw new Error("executor requires a bridge request");
  validateBridgeRequestContract(request);
  if (request.execution?.executor !== "tmux") throw new Error("tmux executor requires execution.executor=tmux");
  if (typeof prompt !== "string" || prompt.length === 0) throw new Error("executor requires a non-empty durable prompt");
  if (typeof stateOperations?.recordDispatch !== "function") throw new Error("executor requires a recordDispatch state operation");
  if (typeof options.workerCapabilityToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(options.workerCapabilityToken)) {
    throw new Error("executor requires a valid job-bound worker capability token");
  }
  if (options.brokerAuthority !== undefined) {
    throw new Error("broker authority must never enter the worker launch transport");
  }

  const session = deriveTmuxSessionName(request.jobId);
  if (request.execution.tmuxSession !== session) {
    throw new Error(`request tmux session must equal derived session ${session}`);
  }
  const tmuxBinary = verifiedBinary(options.tmuxBinary, "tmux");
  const claudeBinary = verifiedBinary(options.claudeBinary, "claude");
  const nodeBinary = verifiedBinary(options.nodeBinary ?? process.execPath, "node");
  const envBinary = verifiedBinary(options.envBinary ?? "/usr/bin/env", "env");
  const runnerPath = fs.realpathSync(options.runnerPath ?? RUNNER_PATH);
  const jobDir = assertPrivateDirectory(options.jobDir);
  const runtimeDir = path.join(jobDir, "runtime");
  const runCommand = options.runCommand ?? defaultRunCommand;
  const socketName = options.tmuxSocketName;
  const target = `=${session}`;

  const existing = runCommand(tmuxBinary, tmuxArgs(socketName, ["has-session", "-t", target]));
  if (existing.status === 0) throw new Error(`tmux session already exists: ${session}`);
  if (existing.status !== 1) throw new Error(`tmux session lookup failed: ${existing.stderr || existing.stdout}`);

  // Verification captures its pre-dispatch workspace baseline in runtime/
  // before the executor starts. Launch must therefore treat the durable
  // runtime directory as an idempotent shared boundary, not a new directory
  // that only the executor may create.
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const inputArtifacts = initializeBridgeInput(jobDir);
  const artifacts = {
    requestFile: path.join(runtimeDir, "request.json"),
    promptFile: path.join(runtimeDir, "prompt.txt"),
    environmentFile: path.join(runtimeDir, "environment.json"),
    specFile: path.join(runtimeDir, "runner-spec.json"),
    identityFile: path.join(runtimeDir, "identity.json"),
    launchIdentityFile: path.join(runtimeDir, "launch-identity.json"),
    heartbeatFile: path.join(runtimeDir, "heartbeat.json"),
    cancelFile: path.join(runtimeDir, "cancel.json"),
    exitFile: path.join(runtimeDir, "exit.json"),
    stdoutFile: path.join(runtimeDir, "stdout.jsonl"),
    stderrFile: path.join(runtimeDir, "stderr.log"),
    inputQueueDir: inputArtifacts.queueDir,
    inputAckDir: inputArtifacts.ackDir
  };
  writePrivateFile(artifacts.requestFile, `${JSON.stringify(request, null, 2)}\n`);
  writePrivateFile(artifacts.promptFile, prompt);
  writePrivateFile(artifacts.environmentFile, `${JSON.stringify(buildMinimalWorkerEnv(options.environment ?? process.env))}\n`);
  for (const file of [artifacts.stdoutFile, artifacts.stderrFile]) writePrivateFile(file, "");
  const spec = {
    ...artifacts,
    claudeBinary,
    workerCapabilityToken: options.workerCapabilityToken,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 1_000,
    timeoutGraceMs: options.timeoutGraceMs ?? 2_000,
    requirePermissionAttestation: true,
  };
  writePrivateFile(artifacts.specFile, `${JSON.stringify(spec, null, 2)}\n`);

  // Capture stderr from process start, before the runner can publish identity or
  // open its own durable streams. Otherwise a bootstrap/import failure exists
  // only in the tmux pane and disappears when launch cleanup reaps the session.
  const command = `exec ${shellQuote(envBinary)} -i ${shellQuote(nodeBinary)} ${shellQuote(runnerPath)} --spec ${shellQuote(artifacts.specFile)} 2>> ${shellQuote(artifacts.stderrFile)}`;
  let created;
  try {
    created = runCommand(tmuxBinary, tmuxArgs(socketName, [
      "new-session", "-d", "-s", session, "-c", request.execution.canonicalWorkspacePath, command
    ]));
  } catch (error) {
    unlinkIfPresent(artifacts.environmentFile);
    throw error;
  }
  if (created.status !== 0) {
    unlinkIfPresent(artifacts.environmentFile);
    throw new Error(`failed to create tmux worker session: ${created.stderr || created.stdout}`);
  }

  const launchDeadline = Date.now() + (options.launchTimeoutMs ?? 5_000);
  let identity;
  while (Date.now() < launchDeadline) {
    identity = readJsonIfPresent(artifacts.identityFile);
    if (identity?.permissionVerification === "verified" || identity?.permissionVerification === "mismatch") break;
    const alive = runCommand(tmuxBinary, tmuxArgs(socketName, ["has-session", "-t", target]));
    if (alive.status !== 0) break;
    await delay(25);
  }
  if (!identity || !Number.isInteger(identity.workerPid) || identity.workerPid <= 0 ||
      identity.permissionVerification !== "verified") {
    runCommand(tmuxBinary, tmuxArgs(socketName, ["kill-session", "-t", target]));
    unlinkIfPresent(artifacts.environmentFile);
    const detail = identity?.permissionVerification === "mismatch"
      ? `effective permission mode ${identity.effectivePermissionMode} did not match requested ${identity.requestedPermissionMode}`
      : "runtime permission attestation was not verified";
    throw new Error(`tmux worker did not publish a verified identity before dispatch: ${session} (${detail})`);
  }
  const pane = queryExactPane(tmuxBinary, socketName, session, runCommand);
  if (pane.classification !== "live" || pane.panePid !== identity.workerPid ||
      identity.claudeSessionId !== request.execution.claudeSessionId) {
    runCommand(tmuxBinary, tmuxArgs(socketName, ["kill-session", "-t", target]));
    unlinkIfPresent(artifacts.environmentFile);
    throw new Error(`tmux worker identity mismatch before dispatch: ${session}`);
  }

  const dispatchIdentity = {
    executor: "tmux",
    tmuxSession: session,
    paneId: pane.paneId,
    panePid: pane.panePid,
    workerPid: identity.workerPid,
    claudeSessionId: identity.claudeSessionId,
    requestedPermissionMode: identity.requestedPermissionMode,
    effectivePermissionMode: identity.effectivePermissionMode,
    permissionVerification: identity.permissionVerification,
    origin: structuredClone(request.origin),
    recordedAt: new Date().toISOString()
  };
  persistRecoveredIdentity(artifacts.launchIdentityFile, dispatchIdentity);
  try {
    await stateOperations.recordDispatch(request.jobId, dispatchIdentity);
  } catch (error) {
    runCommand(tmuxBinary, tmuxArgs(socketName, ["kill-session", "-t", target]));
    unlinkIfPresent(artifacts.environmentFile);
    const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
    throw new Error(`failed to durably record dispatch for ${request.jobId}${detail}`, { cause: error });
  }
  return { jobId: request.jobId, ...dispatchIdentity, artifacts, tmuxSocketName: socketName ?? null };
}

export function inspectTmuxClaudeWorker(launch, options) {
  const tmuxBinary = verifiedBinary(options.tmuxBinary, "tmux");
  const runCommand = options.runCommand ?? defaultRunCommand;
  const session = deriveTmuxSessionName(launch.jobId);
  if (launch.tmuxSession !== session) throw new Error("launch tmux identity does not match its job id");
  const alive = runCommand(tmuxBinary, tmuxArgs(launch.tmuxSocketName, ["has-session", "-t", `=${session}`])).status === 0;
  return {
    alive,
    heartbeat: readJsonIfPresent(launch.artifacts.heartbeatFile),
    exit: readJsonIfPresent(launch.artifacts.exitFile)
  };
}

export async function cancelTmuxClaudeWorker(launch, reason, options) {
  if (typeof options.stateOperations?.requestCancellation !== "function") {
    throw new Error("cancellation requires a requestCancellation state operation");
  }
  if (typeof options.stateOperations?.confirmCancellation !== "function") {
    throw new Error("cancellation requires a confirmCancellation state operation");
  }
  const tmuxBinary = verifiedBinary(options.tmuxBinary, "tmux");
  const runCommand = options.runCommand ?? defaultRunCommand;
  const session = deriveTmuxSessionName(launch.jobId);
  if (launch.tmuxSession !== session) throw new Error("launch tmux identity does not match its job id");
  const target = `=${session}`;
  const present = runCommand(tmuxBinary, tmuxArgs(launch.tmuxSocketName, ["has-session", "-t", target]));
  if (present.status === 1) {
    const exit = typeof launch.artifacts?.exitFile === "string"
      ? readJsonIfPresent(launch.artifacts.exitFile)
      : null;
    if (exit) return { cancelled: false, alreadyExited: true, tmuxSession: session, reason, exit };
    throw new Error(`tmux worker session is missing without a durable exit record: ${session}`);
  }
  if (present.status !== 0) {
    throw new Error(`failed to inspect tmux worker before cancellation: ${present.stderr || present.stdout}`);
  }
  try {
    await options.stateOperations.requestCancellation(launch.jobId, reason);
  } catch (error) {
    throw new Error(`failed to durably record cancellation intent for ${launch.jobId}`, { cause: error });
  }
  if (typeof launch.artifacts?.cancelFile !== "string" || !path.isAbsolute(launch.artifacts.cancelFile) ||
      typeof launch.artifacts?.exitFile !== "string" || !path.isAbsolute(launch.artifacts.exitFile)) {
    throw new Error("cancellation requires absolute cancelFile and exitFile runtime artifacts");
  }
  writePrivateFile(launch.artifacts.cancelFile, `${JSON.stringify({ reason, requestedAt: new Date().toISOString() })}\n`);
  const deadline = Date.now() + (options.cancellationTimeoutMs ?? 5_000);
  let receipt;
  let remaining;
  while (Date.now() < deadline) {
    receipt = readJsonIfPresent(launch.artifacts.exitFile);
    remaining = runCommand(tmuxBinary, tmuxArgs(launch.tmuxSocketName, ["has-session", "-t", target]));
    if (receipt) break;
    if (remaining.status === 1) {
      throw new Error(`tmux disappeared without a verified runner tree-cleanup receipt: ${session}`);
    }
    if (remaining.status !== 0) {
      throw new Error(`failed to verify tmux worker during cancellation: ${remaining.stderr || remaining.stdout}`);
    }
    await delay(25);
  }
  if (!receipt) {
    await forceTerminateRecordedTree(launch.artifacts.identityFile, options.cancellationGraceMs ?? 500);
    runCommand(tmuxBinary, tmuxArgs(launch.tmuxSocketName, ["kill-session", "-t", target]));
    throw new Error(`cancellation timed out without a verified runner tree-cleanup receipt: ${session}`);
  }
  if (receipt.cancelled !== true || receipt.treeTerminated !== true || receipt.error !== null) {
    throw new Error(`runner did not verify complete Claude tree cleanup: ${session}`);
  }
  if (remaining.status === 0) {
    const killed = runCommand(tmuxBinary, tmuxArgs(launch.tmuxSocketName, ["kill-session", "-t", target]));
    if (killed.status !== 0) throw new Error(`failed to close completed tmux worker session: ${killed.stderr || killed.stdout}`);
    remaining = runCommand(tmuxBinary, tmuxArgs(launch.tmuxSocketName, ["has-session", "-t", target]));
  }
  if (remaining.status !== 1) {
    throw new Error(`failed to verify tmux worker termination after runner cleanup: ${remaining.stderr || remaining.stdout}`);
  }
  const confirmation = {
    reason,
    executor: "tmux",
    tmuxSession: session,
    runnerExit: receipt,
    confirmedAt: new Date().toISOString()
  };
  try {
    await options.stateOperations.confirmCancellation(launch.jobId, confirmation);
  } catch (error) {
    throw new Error(`tmux worker stopped but durable cancellation confirmation failed for ${launch.jobId}`, { cause: error });
  }
  return { cancelled: true, alreadyExited: false, tmuxSession: session, reason };
}
