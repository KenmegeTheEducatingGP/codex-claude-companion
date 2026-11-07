import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMinimalWorkerEnv,
  cancelTmuxClaudeWorker,
  deriveTmuxSessionName,
  discover,
  inspectProcess,
  launchTmuxClaudeWorker
} from "../scripts/lib/tmux-executor.mjs";

const JOB_ID = "ccb_00000000000000000000000001";
const WORKER_CAPABILITY = "w".repeat(43);

function request(workspace) {
  return {
    schemaVersion: 1,
    jobId: JOB_ID,
    origin: {
      codexThreadId: "thread-1", codexTurnId: "turn-1", cwd: workspace,
      repoRoot: workspace, branch: null, head: null
    },
    worker: {
      provider: "anthropic", model: "opus", agent: "implementer", inlineAgents: null,
      customAgentsFile: null, pluginDirs: [], mcpConfigPaths: [], addDirs: [], settingSources: [],
      effort: "high", resolvedRuntimeVersion: "2.1.207"
    },
    execution: {
      profile: "standard", executor: "tmux", tmuxSession: deriveTmuxSessionName(JOB_ID),
      workspaceMode: "current", requestedWorkspacePath: workspace, canonicalWorkspacePath: workspace,
      permittedRoot: workspace, claudeSessionId: "00000000-0000-4000-8000-000000000001",
      sandboxAttestation: null, timeoutSeconds: 30,
      effectiveClaudePermissionArgs: ["--setting-sources=", "--permission-mode", "default"]
    },
    task: { promptFile: "prompt.md", acceptance: ["tests pass"] }
  };
}

test("session identity is derived solely from the bridge job id", () => {
  assert.equal(deriveTmuxSessionName(JOB_ID), "ccb-00000000000000000000000001");
  assert.throws(() => deriveTmuxSessionName("ccb_bad"), /invalid bridge job id/i);
});

test("discovery reconstructs one exact live pane after a crash before dispatch persistence", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-tmux-discover-live-"));
  const jobDir = path.join(base, "job");
  const runtimeDir = path.join(jobDir, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(runtimeDir, "identity.json"), JSON.stringify({
    workerPid: 420, claudePid: 421,
    claudeSessionId: "00000000-0000-4000-8000-000000000001",
    startedAt: "2026-07-18T10:00:00.000Z"
  }), { mode: 0o600 });
  const req = request(base);
  const candidates = await discover(JOB_ID, { request: req }, {
    jobDir, tmuxBinary: process.execPath,
    runCommand: (_binary, args) => {
      assert.deepEqual(args, ["display-message", "-p", "-t", `=${deriveTmuxSessionName(JOB_ID)}:0.0`, "#{session_name}\t#{pane_id}\t#{pane_pid}"]);
      return { status: 0, stdout: `${deriveTmuxSessionName(JOB_ID)}\t%7\t420\n`, stderr: "" };
    }
  });

  assert.deepEqual(candidates, [{
    executor: "tmux", tmuxSession: deriveTmuxSessionName(JOB_ID), paneId: "%7",
    panePid: 420, workerPid: 420, claudeSessionId: req.execution.claudeSessionId,
    origin: req.origin, recordedAt: "2026-07-18T10:00:00.000Z"
  }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtimeDir, "launch-identity.json"))), candidates[0]);
});

test("process inspection distinguishes exact live, dead, missing, and reused tmux identity", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-tmux-inspect-"));
  const jobDir = path.join(base, "job");
  const runtimeDir = path.join(jobDir, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const identity = {
    jobId: JOB_ID, executor: "tmux", tmuxSession: deriveTmuxSessionName(JOB_ID),
    paneId: "%3", panePid: 510, workerPid: 510,
    claudeSessionId: "00000000-0000-4000-8000-000000000001",
    artifacts: {
      identityFile: path.join(runtimeDir, "identity.json"),
      exitFile: path.join(runtimeDir, "exit.json")
    }
  };
  fs.writeFileSync(identity.artifacts.identityFile, JSON.stringify({
    workerPid: 510, claudePid: 511, claudeSessionId: identity.claudeSessionId
  }), { mode: 0o600 });
  const command = (stdout, status = 0) => ({
    jobDir, tmuxBinary: process.execPath,
    runCommand: () => ({ status, stdout, stderr: "" }),
    exitArtifactGraceMs: 0
  });

  assert.deepEqual(await inspectProcess(identity, {
    ...command(`${identity.tmuxSession}\t%3\t510\n`), processProbe: () => true
  }), {
    classification: "live", paneId: "%3", panePid: 510, workerPid: 510, claudePid: 511
  });
  fs.unlinkSync(identity.artifacts.identityFile);
  assert.deepEqual(await inspectProcess(identity, command("", 0)), { classification: "missing" });

  fs.writeFileSync(identity.artifacts.exitFile, JSON.stringify({
    workerPid: 510, claudeSessionId: identity.claudeSessionId, code: 0, error: null
  }), { mode: 0o600 });
  assert.deepEqual(await inspectProcess(identity, command("", 1)), {
    classification: "dead",
    exit: { workerPid: 510, claudeSessionId: identity.claudeSessionId, code: 0, error: null }
  });
  assert.deepEqual(await inspectProcess(identity, command(`${identity.tmuxSession}\t%9\t999\n`)), {
    classification: "stale", reason: "tmux pane identity mismatch"
  });
});

test("process inspection waits for the runner's attributable terminal receipt", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-tmux-exit-race-"));
  const runtimeDir = path.join(base, "job", "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const identityFile = path.join(runtimeDir, "identity.json");
  const exitFile = path.join(runtimeDir, "exit.json");
  const identity = {
    jobId: JOB_ID, executor: "tmux", tmuxSession: deriveTmuxSessionName(JOB_ID),
    paneId: "%3", panePid: 510, workerPid: 510,
    claudeSessionId: "00000000-0000-4000-8000-000000000001",
    artifacts: { identityFile, exitFile }
  };
  fs.writeFileSync(identityFile, JSON.stringify({
    workerPid: 510, claudePid: 511, claudeSessionId: identity.claudeSessionId
  }), { mode: 0o600 });
  const terminal = {
    workerPid: 510, claudeSessionId: identity.claudeSessionId,
    code: 0, signal: null, error: null
  };
  setTimeout(() => fs.writeFileSync(exitFile, JSON.stringify(terminal), { mode: 0o600 }), 10);

  assert.deepEqual(await inspectProcess(identity, {
    jobDir: path.join(base, "job"), tmuxBinary: process.execPath,
    runCommand: () => ({
      status: 0, stdout: `${identity.tmuxSession}\t%3\t510\n`, stderr: ""
    }),
    processProbe: () => false,
    exitArtifactGraceMs: 100
  }), { classification: "dead", exit: terminal });
});

test("process inspection terminalizes an attributable abrupt worker disappearance", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-tmux-abrupt-exit-"));
  const runtimeDir = path.join(base, "job", "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const identityFile = path.join(runtimeDir, "identity.json");
  const exitFile = path.join(runtimeDir, "exit.json");
  const identity = {
    jobId: JOB_ID, executor: "tmux", tmuxSession: deriveTmuxSessionName(JOB_ID),
    paneId: "%3", panePid: 510, workerPid: 510,
    claudeSessionId: "00000000-0000-4000-8000-000000000001",
    artifacts: { identityFile, exitFile }
  };
  fs.writeFileSync(identityFile, JSON.stringify({
    workerPid: 510, claudePid: 511, claudeSessionId: identity.claudeSessionId
  }), { mode: 0o600 });

  assert.deepEqual(await inspectProcess(identity, {
    jobDir: path.join(base, "job"), tmuxBinary: process.execPath,
    runCommand: () => ({ status: 1, stdout: "", stderr: "" }),
    processProbe: () => false,
    exitArtifactGraceMs: 0
  }), {
    classification: "dead",
    exit: {
      workerPid: 510,
      claudeSessionId: identity.claudeSessionId,
      code: null,
      signal: null,
      error: "tmux worker disappeared without a durable exit record"
    }
  });
});

test("process inspection reaps an exact orphaned Claude session after its tmux runner disappears", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-tmux-orphan-recovery-"));
  const runtimeDir = path.join(base, "job", "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const identityFile = path.join(runtimeDir, "identity.json");
  const exitFile = path.join(runtimeDir, "exit.json");
  const specFile = path.join(runtimeDir, "runner-spec.json");
  const claudeBinary = "/opt/claude/bin/claude";
  const identity = {
    jobId: JOB_ID, executor: "tmux", tmuxSession: deriveTmuxSessionName(JOB_ID),
    paneId: "%3", panePid: 510, workerPid: 510,
    claudeSessionId: "00000000-0000-4000-8000-000000000001",
    artifacts: { identityFile, exitFile, specFile }
  };
  fs.writeFileSync(identityFile, JSON.stringify({
    workerPid: 510, claudePid: 511, claudeSessionId: identity.claudeSessionId
  }), { mode: 0o600 });
  fs.writeFileSync(specFile, JSON.stringify({ claudeBinary }), { mode: 0o600 });
  let terminatedPid = null;

  assert.deepEqual(await inspectProcess(identity, {
    jobDir: path.join(base, "job"), tmuxBinary: process.execPath,
    runCommand: () => ({ status: 1, stdout: "", stderr: "" }),
    processProbe: () => true,
    processCommand: () => `${claudeBinary} -p --session-id ${identity.claudeSessionId} --model claude-opus-4-8`,
    processTerminator: async (pid) => { terminatedPid = pid; return true; },
    exitArtifactGraceMs: 0
  }), {
    classification: "dead",
    exit: {
      workerPid: 510,
      claudeSessionId: identity.claudeSessionId,
      code: null,
      signal: "SIGTERM",
      error: "orphaned Claude process reaped after tmux worker disappearance"
    }
  });
  assert.equal(terminatedPid, 511);
});

test("discovery and inspection fail closed on missing artifacts and PID identity mismatch", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-tmux-discover-stale-"));
  const jobDir = path.join(base, "job");
  fs.mkdirSync(path.join(jobDir, "runtime"), { recursive: true, mode: 0o700 });
  const req = request(base);
  assert.deepEqual(await discover(JOB_ID, { request: req }, {
    jobDir, tmuxBinary: process.execPath,
    runCommand: () => ({ status: 1, stdout: "", stderr: "" })
  }), []);

  const identityFile = path.join(jobDir, "runtime", "identity.json");
  fs.writeFileSync(identityFile, JSON.stringify({
    workerPid: 700, claudePid: 701, claudeSessionId: req.execution.claudeSessionId
  }), { mode: 0o600 });
  const identity = {
    jobId: JOB_ID, executor: "tmux", tmuxSession: deriveTmuxSessionName(JOB_ID),
    paneId: "%1", panePid: 700, workerPid: 700,
    claudeSessionId: req.execution.claudeSessionId,
    artifacts: { identityFile, exitFile: path.join(jobDir, "runtime", "exit.json") }
  };
  assert.deepEqual(await inspectProcess(identity, {
    jobDir, tmuxBinary: process.execPath,
    runCommand: () => ({ status: 0, stdout: `${identity.tmuxSession}\t%1\t700\n`, stderr: "" }),
    processProbe: (pid) => pid !== 701,
    exitArtifactGraceMs: 0
  }), { classification: "stale", reason: "recorded Claude process tree is not attributable" });
});

test("cancellation verifies exact-session runner tree cleanup before confirming ledger cancellation", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-tmux-cancel-ok-"));
  const exitFile = path.join(base, "exit.json");
  const calls = [];
  let intent;
  let confirmation;
  let hasSessionCalls = 0;
  const launch = {
    jobId: JOB_ID,
    tmuxSession: deriveTmuxSessionName(JOB_ID),
    artifacts: { cancelFile: path.join(base, "cancel.json"), exitFile }
  };
  const result = await cancelTmuxClaudeWorker(launch, "operator request", {
    tmuxBinary: process.execPath,
    runCommand: (binary, args) => {
      calls.push([binary, args]);
      if (args[0] === "has-session") {
        hasSessionCalls += 1;
        if (hasSessionCalls === 1) {
          setTimeout(() => fs.writeFileSync(exitFile, JSON.stringify({
            cancelled: true, treeTerminated: true, error: null
          }), { mode: 0o600 }), 5);
        }
        return { status: hasSessionCalls < 3 ? 0 : 1, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    stateOperations: {
      requestCancellation: async (jobId, reason) => { intent = { jobId, reason }; },
      confirmCancellation: async (jobId, details) => { confirmation = { jobId, details }; }
    }
  });
  assert.deepEqual(calls.map(([, args]) => args[0]), ["has-session", "has-session", "has-session"]);
  assert.deepEqual(intent, { jobId: JOB_ID, reason: "operator request" });
  assert.equal(confirmation.jobId, JOB_ID);
  assert.deepEqual({ ...confirmation.details, confirmedAt: "<timestamp>" }, {
    reason: "operator request", executor: "tmux",
    tmuxSession: "ccb-00000000000000000000000001",
    runnerExit: { cancelled: true, treeTerminated: true, error: null },
    confirmedAt: "<timestamp>"
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.alreadyExited, false);
});

test("cancellation fails closed before touching tmux when broker intent or confirmation is unavailable", async () => {
  const launch = {
    jobId: JOB_ID,
    tmuxSession: deriveTmuxSessionName(JOB_ID),
    artifacts: {}
  };
  let commandCount = 0;
  const common = {
    tmuxBinary: process.execPath,
    runCommand: () => {
      commandCount += 1;
      return { status: 0, stdout: "", stderr: "" };
    }
  };

  await assert.rejects(() => cancelTmuxClaudeWorker(launch, "operator request", {
    ...common,
    stateOperations: { confirmCancellation: async () => {} }
  }), /requestCancellation state operation/i);
  await assert.rejects(() => cancelTmuxClaudeWorker(launch, "operator request", {
    ...common,
    stateOperations: { requestCancellation: async () => {} }
  }), /confirmCancellation state operation/i);
  assert.equal(commandCount, 0);
});

test("cancellation does not terminate a live worker when durable broker intent fails", async () => {
  const launch = {
    jobId: JOB_ID,
    tmuxSession: deriveTmuxSessionName(JOB_ID),
    artifacts: {}
  };
  const commands = [];
  let confirmed = false;
  await assert.rejects(() => cancelTmuxClaudeWorker(launch, "operator request", {
    tmuxBinary: process.execPath,
    runCommand: (_binary, args) => {
      commands.push(args);
      return { status: 0, stdout: "", stderr: "" };
    },
    stateOperations: {
      requestCancellation: async () => { throw new Error("ledger unavailable"); },
      confirmCancellation: async () => { confirmed = true; }
    }
  }), /durably record cancellation intent/i);
  assert.deepEqual(commands, [["has-session", "-t", "=ccb-00000000000000000000000001"]]);
  assert.equal(confirmed, false);
});

test("cancellation reports a stopped worker as unconfirmed when durable confirmation fails", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-tmux-cancel-confirm-"));
  const exitFile = path.join(base, "exit.json");
  const launch = {
    jobId: JOB_ID,
    tmuxSession: deriveTmuxSessionName(JOB_ID),
    artifacts: { cancelFile: path.join(base, "cancel.json"), exitFile }
  };
  let hasSessionCalls = 0;
  let intentRecorded = false;
  await assert.rejects(() => cancelTmuxClaudeWorker(launch, "operator request", {
    tmuxBinary: process.execPath,
    runCommand: (_binary, args) => {
      if (args[0] === "has-session") {
        hasSessionCalls += 1;
        if (hasSessionCalls === 1) {
          setTimeout(() => fs.writeFileSync(exitFile, JSON.stringify({
            cancelled: true, treeTerminated: true, error: null
          }), { mode: 0o600 }), 5);
        }
        return { status: hasSessionCalls < 3 ? 0 : 1, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    stateOperations: {
      requestCancellation: async () => { intentRecorded = true; },
      confirmCancellation: async () => { throw new Error("ledger unavailable"); }
    }
  }), /stopped but durable cancellation confirmation failed/i);
  assert.equal(intentRecorded, true);
  assert.equal(hasSessionCalls, 3);
});

test("cancellation does not confirm from tmux disappearance without a verified runner tree-cleanup receipt", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-tmux-cancel-receipt-"));
  const launch = {
    jobId: JOB_ID,
    tmuxSession: deriveTmuxSessionName(JOB_ID),
    artifacts: {
      cancelFile: path.join(base, "cancel.json"),
      exitFile: path.join(base, "exit.json")
    }
  };
  let hasSessionCalls = 0;
  let confirmed = false;
  await assert.rejects(() => cancelTmuxClaudeWorker(launch, "operator request", {
    tmuxBinary: process.execPath,
    cancellationTimeoutMs: 30,
    runCommand: (_binary, args) => {
      if (args[0] === "has-session") {
        hasSessionCalls += 1;
        return { status: hasSessionCalls === 1 ? 0 : 1, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    stateOperations: {
      requestCancellation: async () => {},
      confirmCancellation: async () => { confirmed = true; }
    }
  }), /verified runner tree-cleanup receipt/i);
  assert.equal(confirmed, false);
});

test("cancellation distinguishes an already-exited worker from a missing unaccounted session", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-tmux-cancel-exit-"));
  const exitFile = path.join(base, "exit.json");
  fs.writeFileSync(exitFile, JSON.stringify({ code: 0, timedOut: false }), { mode: 0o600 });
  const operations = {
    requestCancellation: async () => { throw new Error("must not record intent for an exited worker"); },
    confirmCancellation: async () => { throw new Error("must not confirm cancellation for an exited worker"); }
  };
  const common = {
    jobId: JOB_ID,
    tmuxSession: deriveTmuxSessionName(JOB_ID)
  };
  const options = {
    tmuxBinary: process.execPath,
    runCommand: () => ({ status: 1, stdout: "", stderr: "" }),
    stateOperations: operations
  };

  const exited = await cancelTmuxClaudeWorker({ ...common, artifacts: { exitFile } }, "operator request", options);
  assert.equal(exited.cancelled, false);
  assert.equal(exited.alreadyExited, true);
  await assert.rejects(
    () => cancelTmuxClaudeWorker({ ...common, artifacts: { exitFile: path.join(base, "missing.json") } }, "operator request", options),
    /missing without a durable exit record/i
  );
});

test("worker environment uses an explicit minimal allowlist", () => {
  const env = buildMinimalWorkerEnv({
    HOME: "/home/test", PATH: "/bin", LANG: "C", ANTHROPIC_API_KEY: "secret",
    SSH_AUTH_SOCK: "/private/socket", RANDOM_SECRET: "must-not-pass"
  });
  assert.deepEqual(env, {
    HOME: "/home/test", PATH: "/bin", LANG: "C", ANTHROPIC_API_KEY: "secret"
  });
});

test("executor requires only the job-bound worker capability in the private runner spec", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-tmux-capability-"));
  const jobDir = path.join(workspace, "job");
  fs.mkdirSync(jobDir, { mode: 0o700 });
  await assert.rejects(() => launchTmuxClaudeWorker({
    request: request(workspace), prompt: "do work", jobDir,
    tmuxBinary: process.execPath, claudeBinary: process.execPath,
    nodeBinary: process.execPath,
    runCommand: () => ({ status: 1, stdout: "", stderr: "" }),
    stateOperations: { recordDispatch: async () => {} }
  }), /worker capability/i);
});

test("executor rejects a pre-existing session before writing dispatch authority", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-tmux-preexisting-"));
  const jobDir = path.join(workspace, "job");
  fs.mkdirSync(jobDir, { mode: 0o700 });
  let recorded = false;
  await assert.rejects(() => launchTmuxClaudeWorker({
    request: request(workspace), prompt: "do work", jobDir, workerCapabilityToken: WORKER_CAPABILITY,
    tmuxBinary: process.execPath, claudeBinary: process.execPath,
    nodeBinary: process.execPath,
    runCommand: (binary, args) => {
      assert.equal(binary, fs.realpathSync(process.execPath));
      assert.deepEqual(args, ["has-session", "-t", "=ccb-00000000000000000000000001"]);
      return { status: 0, stdout: "", stderr: "" };
    },
    stateOperations: { recordDispatch: async () => { recorded = true; } }
  }), /already exists/i);
  assert.equal(recorded, false);
  assert.equal(fs.readdirSync(jobDir).length, 0);
});

test("executor transports current auth in a private artifact without exposing it to tmux or the durable spec", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-tmux-env-"));
  const jobDir = path.join(workspace, "job");
  const runtimeDir = path.join(jobDir, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const verificationBaseline = path.join(runtimeDir, "verification-before.json");
  fs.writeFileSync(verificationBaseline, "{}\n", { mode: 0o600 });
  const req = request(workspace);
  const secret = "current-auth-must-not-reach-command";
  let command;
  let environmentFile;
  const launched = await launchTmuxClaudeWorker({
    request: req, prompt: "do work", jobDir, workerCapabilityToken: WORKER_CAPABILITY,
    tmuxBinary: process.execPath, claudeBinary: process.execPath,
    nodeBinary: process.execPath, envBinary: "/usr/bin/env",
    environment: { PATH: process.env.PATH, ANTHROPIC_API_KEY: secret },
    runCommand: (_binary, args) => {
      if (args[0] === "has-session") return { status: 1, stdout: "", stderr: "" };
      if (args[0] === "new-session") {
        command = args.at(-1);
        const spec = JSON.parse(fs.readFileSync(path.join(jobDir, "runtime", "runner-spec.json"), "utf8"));
        environmentFile = spec.environmentFile;
        const environmentFd = fs.openSync(environmentFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        try {
          assert.equal(fs.fstatSync(environmentFd).mode & 0o077, 0);
          assert.deepEqual(JSON.parse(fs.readFileSync(environmentFd, "utf8")), {
            PATH: process.env.PATH,
            ANTHROPIC_API_KEY: secret
          });
        } finally {
          fs.closeSync(environmentFd);
        }
        fs.unlinkSync(environmentFile);
        fs.writeFileSync(spec.identityFile, JSON.stringify({
          workerPid: 4242,
          claudeSessionId: req.execution.claudeSessionId,
          requestedPermissionMode: "default",
          effectivePermissionMode: "default",
          permissionVerification: "verified"
        }), { mode: 0o600 });
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "display-message") {
        return { status: 0, stdout: `${deriveTmuxSessionName(JOB_ID)}\t%4\t4242\n`, stderr: "" };
      }
      throw new Error(`unexpected tmux command: ${args.join(" ")}`);
    },
    stateOperations: { recordDispatch: async () => {} }
  });

  const persistedSpec = fs.readFileSync(launched.artifacts.specFile, "utf8");
  assert.doesNotMatch(persistedSpec, new RegExp(secret));
  assert.match(persistedSpec, new RegExp(WORKER_CAPABILITY));
  assert.doesNotMatch(persistedSpec, /brokerAuthority|bridge-broker/);
  assert.doesNotMatch(command, new RegExp(secret));
  assert.doesNotMatch(command, new RegExp(WORKER_CAPABILITY));
  // The executor runs env by its verified real path (verifiedBinary resolves symlinks). Where
  // /usr/bin/env is itself a symlink, as with rust coreutils on current Linux runners, that path
  // is not the literal "/usr/bin/env".
  const expectedEnvStart = `exec '${fs.realpathSync("/usr/bin/env")}' -i `;
  assert.ok(command.startsWith(expectedEnvStart), `command should start with ${expectedEnvStart}; it starts with ${command.slice(0, 80)}`);
  assert.equal(command.endsWith(`2>> '${launched.artifacts.stderrFile}'`), true);
  assert.equal(fs.readFileSync(verificationBaseline, "utf8"), "{}\n");
  assert.equal(fs.existsSync(environmentFile), false);
  assert.equal(launched.paneId, "%4");
  assert.equal(launched.panePid, 4242);
});

test("executor preserves pre-identity bootstrap stderr after rejecting the launch", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-tmux-bootstrap-stderr-"));
  const jobDir = path.join(workspace, "job");
  fs.mkdirSync(jobDir, { mode: 0o700 });
  const runnerPath = path.join(workspace, "bootstrap-failure.mjs");
  fs.writeFileSync(runnerPath, 'process.stderr.write("BOOTSTRAP_MARKER\\n"); process.exit(17);\n', { mode: 0o600 });
  let launchedCommand;

  await assert.rejects(() => launchTmuxClaudeWorker({
    request: request(workspace), prompt: "do work", jobDir,
    workerCapabilityToken: WORKER_CAPABILITY,
    tmuxBinary: process.execPath, claudeBinary: process.execPath,
    nodeBinary: process.execPath, envBinary: "/usr/bin/env", runnerPath,
    launchTimeoutMs: 50,
    environment: { PATH: process.env.PATH },
    runCommand: (_binary, args) => {
      if (args[0] === "has-session") return { status: 1, stdout: "", stderr: "" };
      if (args[0] === "new-session") {
        launchedCommand = args.at(-1);
        spawnSync("/bin/sh", ["-c", launchedCommand], { cwd: workspace, encoding: "utf8" });
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "kill-session") return { status: 0, stdout: "", stderr: "" };
      throw new Error(`unexpected tmux command: ${args.join(" ")}`);
    },
    stateOperations: { recordDispatch: async () => {} }
  }), /did not publish a verified identity/i);

  assert.match(launchedCommand, /2>> /);
  assert.equal(fs.readFileSync(path.join(jobDir, "runtime", "stderr.log"), "utf8"), "BOOTSTRAP_MARKER\n");
});

test("dispatch failure reports the rejected durable contract cause and reaps the launched session", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-tmux-dispatch-failure-"));
  const jobDir = path.join(workspace, "job");
  fs.mkdirSync(jobDir, { mode: 0o700 });
  const req = request(workspace);
  let killed = false;
  await assert.rejects(() => launchTmuxClaudeWorker({
    request: req, prompt: "do work", jobDir, workerCapabilityToken: WORKER_CAPABILITY,
    tmuxBinary: process.execPath, claudeBinary: process.execPath,
    nodeBinary: process.execPath, envBinary: "/usr/bin/env",
    runCommand: (_binary, args) => {
      if (args[0] === "has-session") return { status: 1, stdout: "", stderr: "" };
      if (args[0] === "new-session") {
        const spec = JSON.parse(fs.readFileSync(path.join(jobDir, "runtime", "runner-spec.json"), "utf8"));
        fs.unlinkSync(spec.environmentFile);
        fs.writeFileSync(spec.identityFile, JSON.stringify({
          workerPid: 4242,
          claudeSessionId: req.execution.claudeSessionId,
          requestedPermissionMode: "default",
          effectivePermissionMode: "default",
          permissionVerification: "verified"
        }), { mode: 0o600 });
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "display-message") {
        return { status: 0, stdout: `${deriveTmuxSessionName(JOB_ID)}\t%4\t4242\n`, stderr: "" };
      }
      if (args[0] === "kill-session") {
        killed = true;
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected tmux command: ${args.join(" ")}`);
    },
    stateOperations: {
      recordDispatch: async () => { throw new Error("Unknown dispatch identity field: permissionVerification"); }
    }
  }), /failed to durably record dispatch.*Unknown dispatch identity field: permissionVerification/i);
  assert.equal(killed, true);
});

test("executor times out an unproven launch, kills its exact session, and scrubs unconsumed auth", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-tmux-timeout-"));
  const jobDir = path.join(workspace, "job");
  fs.mkdirSync(jobDir, { mode: 0o700 });
  let recorded = false;
  let killed = false;
  await assert.rejects(() => launchTmuxClaudeWorker({
    request: request(workspace), prompt: "do work", jobDir, workerCapabilityToken: WORKER_CAPABILITY,
    tmuxBinary: process.execPath, claudeBinary: process.execPath,
    nodeBinary: process.execPath, envBinary: "/usr/bin/env",
    environment: { ANTHROPIC_API_KEY: "timeout-secret" },
    launchTimeoutMs: 15,
    runCommand: (_binary, args) => {
      if (args[0] === "has-session") {
        return { status: args.includes("=ccb-00000000000000000000000001") && fs.existsSync(path.join(jobDir, "runtime")) ? 0 : 1, stdout: "", stderr: "" };
      }
      if (args[0] === "new-session") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "kill-session") {
        killed = true;
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected tmux command: ${args.join(" ")}`);
    },
    stateOperations: { recordDispatch: async () => { recorded = true; } }
  }), /did not publish a verified identity before dispatch/i);
  assert.equal(killed, true);
  assert.equal(recorded, false);
  assert.equal(fs.existsSync(path.join(jobDir, "runtime", "environment.json")), false);
});

test("executor rejects a pane identity mismatch before dispatch and scrubs auth", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-tmux-mismatch-"));
  const jobDir = path.join(workspace, "job");
  fs.mkdirSync(jobDir, { mode: 0o700 });
  const req = request(workspace);
  let recorded = false;
  let killed = false;
  await assert.rejects(() => launchTmuxClaudeWorker({
    request: req, prompt: "do work", jobDir, workerCapabilityToken: WORKER_CAPABILITY,
    tmuxBinary: process.execPath, claudeBinary: process.execPath,
    nodeBinary: process.execPath, envBinary: "/usr/bin/env",
    environment: { ANTHROPIC_API_KEY: "mismatch-secret" },
    runCommand: (_binary, args) => {
      if (args[0] === "has-session") return { status: 1, stdout: "", stderr: "" };
      if (args[0] === "new-session") {
        const spec = JSON.parse(fs.readFileSync(path.join(jobDir, "runtime", "runner-spec.json"), "utf8"));
        fs.unlinkSync(spec.environmentFile);
        fs.writeFileSync(spec.identityFile, JSON.stringify({
          workerPid: 1111,
          claudeSessionId: req.execution.claudeSessionId,
          requestedPermissionMode: "default",
          effectivePermissionMode: "default",
          permissionVerification: "verified"
        }), { mode: 0o600 });
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "display-message") return { status: 0, stdout: "2222\n", stderr: "" };
      if (args[0] === "kill-session") {
        killed = true;
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected tmux command: ${args.join(" ")}`);
    },
    stateOperations: { recordDispatch: async () => { recorded = true; } }
  }), /identity mismatch before dispatch/i);
  assert.equal(killed, true);
  assert.equal(recorded, false);
  assert.equal(fs.existsSync(path.join(jobDir, "runtime", "environment.json")), false);
});

const tmuxAvailable = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;

test("real tmux owns the actual worker, survives launcher return, and records before reporting dispatch", {
  skip: process.platform === "win32" || !tmuxAvailable,
  timeout: 15_000
}, async (context) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-tmux-real-"));
  const workspace = path.join(base, "workspace");
  const jobDir = path.join(base, "job");
  fs.mkdirSync(workspace);
  fs.mkdirSync(jobDir, { mode: 0o700 });
  const fakeClaude = path.join(base, "fake-claude");
  const capturedAuth = path.join(base, "captured-auth.txt");
  fs.writeFileSync(fakeClaude, `#!/bin/sh\nprintf '%s' "$ANTHROPIC_API_KEY" > '${capturedAuth}'\nIFS= read -r _\nprintf '%s\\n' '{"type":"system","subtype":"init","session_id":"00000000-0000-4000-8000-000000000001","permissionMode":"default"}'\nsleep 2\nprintf '%s\\n' '{"type":"result","result":"ok"}'\n`, { mode: 0o700 });
  const tmuxBinary = fs.realpathSync(spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim());
  const socketName = `ccb-test-${process.pid}-${Date.now()}`;
  let validatedSocketPath;
  assert.equal(spawnSync(tmuxBinary, ["-L", socketName, "new-session", "-d", "-s", "env-seed", "sleep 10"]).status, 0);
  context.after(() => {
    spawnSync(tmuxBinary, ["-L", socketName, "kill-server"]);
    if (validatedSocketPath) {
      fs.rmSync(validatedSocketPath, { force: true });
      assert.equal(fs.existsSync(validatedSocketPath), false, `tmux socket leaked: ${validatedSocketPath}`);
    }
  });
  // tmux (3.7c verified) does not unlink its socket on kill-server, so resolve the
  // path while the server is alive and remove it ourselves during cleanup.
  const socketPath = spawnSync(tmuxBinary, ["-L", socketName, "display-message", "-p", "#{socket_path}"], { encoding: "utf8" }).stdout.trim();
  assert.ok(path.isAbsolute(socketPath) && path.basename(socketPath) === socketName, `unexpected tmux socket path: ${socketPath}`);
  validatedSocketPath = socketPath;
  assert.equal(spawnSync(tmuxBinary, ["-L", socketName, "set-environment", "-g", "ANTHROPIC_API_KEY", "stale-server-auth"]).status, 0);
  const req = request(workspace);
  const session = deriveTmuxSessionName(req.jobId);
  let dispatchIdentity;

  const launched = await launchTmuxClaudeWorker({
    request: req, prompt: "integration prompt", jobDir, tmuxBinary, workerCapabilityToken: WORKER_CAPABILITY,
    claudeBinary: fakeClaude, nodeBinary: process.execPath, tmuxSocketName: socketName,
    environment: { ...process.env, ANTHROPIC_API_KEY: "current-launch-auth" },
    stateOperations: { recordDispatch: async (_jobId, identity) => { dispatchIdentity = identity; } }
  });

  assert.equal(launched.tmuxSession, session);
  assert.equal(dispatchIdentity.workerPid, launched.workerPid);
  assert.equal(dispatchIdentity.claudeSessionId, req.execution.claudeSessionId);
  assert.deepEqual(dispatchIdentity.origin, req.origin);
  const persistedSpec = fs.readFileSync(launched.artifacts.specFile, "utf8");
  assert.doesNotMatch(persistedSpec, /current-launch-auth|ANTHROPIC_API_KEY/);
  assert.equal(fs.existsSync(launched.artifacts.environmentFile), false);
  const authDeadline = Date.now() + 2_000;
  while (!fs.existsSync(capturedAuth) && Date.now() < authDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(fs.readFileSync(capturedAuth, "utf8"), "current-launch-auth");
  assert.equal(spawnSync(tmuxBinary, ["-L", socketName, "has-session", "-t", `=${session}`]).status, 0);
  const panePid = Number(spawnSync(tmuxBinary, ["-L", socketName, "display-message", "-p", "-t", `=${session}:0.0`, "#{pane_pid}"], { encoding: "utf8" }).stdout.trim());
  assert.equal(panePid, launched.workerPid);
});
