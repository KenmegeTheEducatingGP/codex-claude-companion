// D2: delivering to a live Codex origin. While the origin session sits in
// `codex-claude wait`, its thread is loaded in that Codex process, so an
// app-server resume fails with "already has an active writer". Real state
// operations, the real broker loop and runtime, and the real CLI run here; only
// the origin adapter is a fake that throws the error a live origin returns.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { buildEnv, installFakeCodex } from "../tests/fake-codex-fixture.mjs";
import { persistBridgeBrokerSpec, runBridgeBroker } from "../scripts/lib/bridge-broker.mjs";
import { handleBridgeCommand } from "../scripts/lib/bridge-cli.mjs";
import { deliverBridgeResult, drainBridgeInbox } from "../scripts/lib/bridge-delivery.mjs";
import {
  createBridgeCoordinationOperations,
  readDelivery,
  readReceipt,
  recordVerification
} from "../scripts/lib/bridge-messaging.mjs";
import { createBridgeRuntime } from "../scripts/lib/bridge-runtime.mjs";
import {
  createBridgeJob,
  getBridgeBrokerAuthority,
  resolveBridgeJobDir,
  transitionBridgeJob,
  writeBridgeResult
} from "../scripts/lib/bridge-state.mjs";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function createRoot(prefix) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const workspace = path.join(base, "workspace");
  const stateRoot = path.join(base, "state");
  fs.mkdirSync(workspace);
  return { base, workspace, stateRoot };
}

// `root` lets several jobs of one thread share a state root and a workspace;
// `complete: false` leaves the job running, with no result yet.
function createVerifiedJob(prefix, jobId, threadId, { root = createRoot(prefix), complete = true } = {}) {
  const { workspace, stateRoot } = root;
  const origin = {
    codexThreadId: threadId, codexTurnId: `${threadId}-turn`,
    cwd: workspace, repoRoot: workspace, branch: null, head: null
  };
  const claudeSessionId = `00000000-0000-4000-8000-${jobId.slice(-12)}`.toLowerCase();
  const created = createBridgeJob({
    schemaVersion: 1,
    jobId,
    origin,
    worker: {
      provider: "anthropic", model: "opus", agent: null, inlineAgents: null,
      customAgentsFile: null, pluginDirs: [], mcpConfigPaths: [], addDirs: [],
      settingSources: [], effort: "high", resolvedRuntimeVersion: "2.1.207"
    },
    execution: {
      profile: "standard", executor: "tmux", tmuxSession: `ccb-${jobId.slice(-8).toLowerCase()}`,
      workspaceMode: "current", requestedWorkspacePath: workspace,
      canonicalWorkspacePath: workspace, permittedRoot: workspace,
      claudeSessionId, sandboxAttestation: null, timeoutSeconds: 900,
      effectiveClaudePermissionArgs: ["--setting-sources=", "--permission-mode", "default"]
    },
    task: { promptFile: "runtime/prompt.txt", acceptance: ["deliver the verified result to the live origin"] }
  }, { stateRoot });
  const brokerAuthority = getBridgeBrokerAuthority(jobId, { stateRoot });
  const brokerOptions = { stateRoot, brokerAuthority };
  transitionBridgeJob(jobId, "running", {}, brokerOptions);
  let result = null;
  if (complete) {
    transitionBridgeJob(jobId, "completed", {}, brokerOptions);
    result = {
      schemaVersion: 1, jobId, status: "completed", summary: "Implemented and verified the change.",
      filesChanged: [], commandsRun: [], testsRun: [], findings: [], blockers: [],
      claudeSessionId, exitStatus: { code: 0, signal: null }, artifactPaths: []
    };
    writeBridgeResult(jobId, result, brokerOptions);
    recordVerification(jobId, {
      state: "passed", verifiedAt: new Date(Date.now() + 1_000).toISOString(), evidence: ["independent:passed"]
    }, brokerOptions);
  }
  const jobDir = resolveBridgeJobDir(jobId, { stateRoot });
  const brokerSpec = {
    schemaVersion: 1, jobId, stateRoot, jobDir, prompt: "live origin delivery fixture",
    workerCapabilityToken: created.capabilityToken,
    tmuxBinary: process.execPath, claudeBinary: process.execPath, codexBinary: process.execPath,
    nodeBinary: process.execPath, envBinary: "/usr/bin/env",
    heartbeatFile: path.join(jobDir, "broker-heartbeat.json"),
    intervalMs: 100, maxRepairs: 0, verificationCommands: [[process.execPath, "-e", "process.exit(0)"]],
    securityRequirements: {}
  };
  persistBridgeBrokerSpec(path.join(jobDir, "broker-spec.json"), brokerSpec);
  const coordination = createBridgeCoordinationOperations({
    stateRoot,
    brokerAuthorityForJob: (candidate) => getBridgeBrokerAuthority(candidate, { stateRoot })
  });
  return { jobId, threadId, workspace, stateRoot, origin, result, brokerOptions, brokerSpec, coordination };
}

// The error a live origin returns (spike 5): its Codex process holds the thread.
function busyOrigin(threadId) {
  let calls = 0;
  return {
    calls: () => calls,
    adapter: async () => {
      calls += 1;
      const error = new Error(`thread ${threadId} already has an active writer`);
      error.rpcCode = -32600;
      throw error;
    }
  };
}

async function runBrokerOnce(job, originAdapter, { maxSleeps = 5, sleepMs = 0 } = {}) {
  let sleeps = 0;
  try {
    const outcome = await runBridgeBroker(job.brokerSpec, {
      createRuntime: (options) => createBridgeRuntime({ ...options, originAdapter }),
      sleep: async () => {
        sleeps += 1;
        if (sleeps > maxSleeps) throw new Error(`broker still looping after ${maxSleeps} retry sleeps`);
        if (sleepMs > 0) await delay(sleepMs);
      }
    });
    return { outcome, error: null, sleeps };
  } catch (error) {
    return { outcome: null, error, sleeps };
  }
}

// The real CLI. Broker spawning is stubbed and counted: the broker runs
// in-process in these tests.
function cliHarness({ pollMs = 10 } = {}) {
  let brokerStarts = 0;
  const deps = {
    sleep: () => delay(pollMs),
    processAlive: () => false,
    discoverBrokerPid: () => null,
    spawnDetached: () => { brokerStarts += 1; return 4_242; }
  };
  return {
    brokerStarts: () => brokerStarts,
    // `extra.write` sees each chunk after it is recorded, and may throw or return a promise.
    async run(command, argv, extra = {}) {
      let text = "";
      try {
        const exitCode = await handleBridgeCommand(command, argv, {
          ...deps,
          ...extra,
          write: (chunk) => {
            text += chunk;
            return extra.write?.(chunk);
          }
        });
        return { exitCode, text, error: null };
      } catch (error) {
        return { exitCode: null, text, error };
      }
    }
  };
}

test("a busy origin with no waiter is queued as origin-busy without spending failure quota, and the origin's next wait drains it (D2, A13)", async () => {
  const job = createVerifiedJob("ccb-live-origin-busy-", "ccb_00000000000000000000D2A001", "thread-live-origin-a");
  const origin = busyOrigin(job.threadId);
  const cli = cliHarness();

  const first = await runBrokerOnce(job, origin.adapter);
  const afterFirst = readDelivery(job.jobId, job.brokerOptions);
  assert.equal(first.error, null,
    `the broker must exit once the busy origin is queued; observed: ${first.error?.message} after ` +
    `${origin.calls()} origin resume attempt(s); delivery state=${afterFirst?.state} attempts=${afterFirst?.attempts} ` +
    `lastError=${JSON.stringify(afterFirst?.lastError)}`);
  assert.equal(first.outcome.status, "queued");
  assert.equal(origin.calls(), 1);

  const observed = await cli.run("status", [job.jobId, "--json", "--state-dir", job.stateRoot], {
    codexThreadId: "thread-observer"
  });
  assert.equal(observed.error, null, observed.error?.message);
  const status = JSON.parse(observed.text);
  assert.equal(status.deliveryQueue, "inbox");
  assert.equal(status.lastError, "origin-busy");
  assert.equal(status.receipt.delivery.state, "pending", "the v1 receipt delivery enum is unchanged");

  // Auto-recovery restarts the broker on later CLI calls, and every broker tick
  // drains the inbox. While the origin stays busy none of that is a failure.
  for (let restart = 0; restart < 2; restart += 1) {
    const again = await runBrokerOnce(job, origin.adapter);
    assert.equal(again.error, null, again.error?.message);
    assert.equal(again.outcome.status, "queued");
  }
  for (let attempt = 0; attempt < 70; attempt += 1) {
    const drained = await drainBridgeInbox({
      origin: job.origin, stateOperations: job.coordination, originAdapter: origin.adapter
    });
    assert.equal(drained.state, "queued", `busy drain ${attempt + 1}: ${JSON.stringify(drained)}`);
  }
  const queued = readDelivery(job.jobId, job.brokerOptions);
  assert.equal(queued.state, "inbox", `origin-busy retries exhausted the inbox: ${JSON.stringify(queued)}`);
  assert.equal(queued.attempts, 1, `origin-busy retries consumed failure quota: attempts=${queued.attempts}`);

  const startsBefore = cli.brokerStarts();
  const resumesBefore = origin.calls();
  const waited = await cli.run("wait", [job.jobId, "--json", "--state-dir", job.stateRoot, "--timeout", "2"], {
    codexThreadId: job.threadId
  });
  assert.equal(waited.error, null, `the origin's wait did not drain its queued result: ${waited.error?.message}`);
  assert.equal(waited.exitCode, 0);
  assert.equal(cli.brokerStarts(), startsBefore, "the origin's wait must settle the queued result before restarting a broker");
  assert.equal(origin.calls(), resumesBefore, "draining at the origin must not resume the origin thread");
  const delivered = readDelivery(job.jobId, job.brokerOptions);
  assert.equal(delivered.state, "acknowledged");
  assert.equal(delivered.route, "waiter");
  assert.equal(delivered.attempts, 1);
  assert.equal(readReceipt(job.jobId, job.brokerOptions).delivery.state, "acknowledged");
  assert.equal(JSON.parse(waited.text).receipt.delivery.state, "acknowledged");
});

test("with the origin's wait live, the broker hands delivery to that waiter and never resumes the busy origin (D2, A13)", async () => {
  const job = createVerifiedJob("ccb-live-origin-waiter-", "ccb_00000000000000000000D2B001", "thread-live-origin-b");
  const origin = busyOrigin(job.threadId);
  const cli = cliHarness();

  const waiting = cli.run("wait", [job.jobId, "--json", "--state-dir", job.stateRoot, "--timeout", "5"], {
    codexThreadId: job.threadId
  });
  await delay(100);
  const broker = await runBrokerOnce(job, origin.adapter, { maxSleeps: 300, sleepMs: 10 });
  const waited = await waiting;

  assert.equal(origin.calls(), 0, `the broker resumed the origin ${origin.calls()} time(s) while its waiter was live`);
  assert.equal(waited.error, null, `origin wait: ${waited.error?.message}`);
  assert.equal(waited.exitCode, 0, `origin wait exit ${waited.exitCode}`);
  assert.equal(broker.error, null, broker.error?.message);
  assert.equal(broker.outcome.status, "settled");
  const delivered = readDelivery(job.jobId, job.brokerOptions);
  assert.equal(delivered.state, "acknowledged");
  assert.equal(delivered.route, "waiter");
  assert.equal(delivered.attempts, 1, `a stale waiter claim was re-claimed: attempts=${delivered.attempts}`);
  assert.equal(JSON.parse(waited.text).receipt.delivery.state, "acknowledged");
});

test("an observer's wait reports but never acknowledges a queued result (guard, green at base)", async () => {
  const job = createVerifiedJob("ccb-live-origin-observer-", "ccb_00000000000000000000D2C001", "thread-live-origin-c");
  const origin = busyOrigin(job.threadId);
  const queued = await deliverBridgeResult({
    result: job.result,
    receipt: readReceipt(job.jobId, job.brokerOptions),
    origin: job.origin,
    stateOperations: job.coordination,
    originAdapter: origin.adapter
  });
  assert.equal(queued.state, "queued");

  const cli = cliHarness();
  const observed = await cli.run("wait", [job.jobId, "--json", "--state-dir", job.stateRoot, "--timeout", "1"], {
    codexThreadId: "thread-observer"
  });
  assert.match(observed.error?.message ?? "", /Timed out waiting for bridge job/);
  assert.equal(readDelivery(job.jobId, job.brokerOptions).state, "inbox");
});

test("the shipped origin adapter's active-writer protocol error is classified origin-busy (D2)", async (t) => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-live-origin-codex-"));
  installFakeCodex(binDir, "active-writer");
  const previousPath = process.env.PATH;
  process.env.PATH = buildEnv(binDir).PATH;
  t.after(() => { process.env.PATH = previousPath; });
  const job = createVerifiedJob("ccb-live-origin-adapter-", "ccb_00000000000000000000D2D001", "thread-live-origin-d");

  const outcome = await deliverBridgeResult({
    result: job.result,
    receipt: readReceipt(job.jobId, job.brokerOptions),
    origin: job.origin,
    stateOperations: job.coordination
  });

  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(fakeState.requests.filter((entry) => entry.method === "thread/resume").length, 1);
  assert.deepEqual({ state: outcome.state, reason: outcome.reason }, { state: "queued", reason: "origin-busy" });
  const queued = readDelivery(job.jobId, job.brokerOptions);
  assert.equal(queued.state, "inbox");
  assert.equal(queued.lastError, "origin-busy");
  assert.equal(queued.attempts, 1);
});

// A queued result is claimed when a command is about to print it, never when
// the command starts. A command that ends first (timeout, error, signal)
// therefore leaves it queued for the next origin command.
const CLI_URL = new URL("../scripts/lib/bridge-cli.mjs", import.meta.url).href;

// One thread, one workspace: a job that finished and was queued while the
// origin was busy, and a second job still running.
async function threadWithQueuedResult(prefix, thread) {
  const root = createRoot(prefix);
  const done = createVerifiedJob(prefix, "ccb_00000000000000000000D2E001", thread, { root });
  const running = createVerifiedJob(prefix, "ccb_00000000000000000000D2E002", thread, { root, complete: false });
  const queued = await deliverBridgeResult({
    result: done.result,
    receipt: readReceipt(done.jobId, done.brokerOptions),
    origin: done.origin,
    stateOperations: done.coordination,
    originAdapter: busyOrigin(thread).adapter
  });
  assert.equal(queued.state, "queued");
  assert.equal(readDelivery(done.jobId, done.brokerOptions).state, "inbox");
  return { root, done, running };
}

async function assertNextOriginCommandDelivers(cli, { root, done, running }, thread) {
  const next = await cli.run("status", [running.jobId, "--json", "--state-dir", root.stateRoot], { codexThreadId: thread });
  assert.equal(next.error, null, next.error?.message);
  assert.deepEqual(JSON.parse(next.text).queuedResults.map((entry) => entry.jobId), [done.jobId],
    "the next origin command must still find the result queued and print it");
  const delivered = readDelivery(done.jobId, done.brokerOptions);
  assert.equal(delivered.state, "acknowledged");
  assert.equal(delivered.route, "waiter");
}

test("an origin wait that times out leaves another job's queued result queued (D2, A13)", async () => {
  const thread = "thread-live-origin-e";
  const fixture = await threadWithQueuedResult("ccb-live-origin-timeout-", thread);
  const { root, done, running } = fixture;
  const cli = cliHarness();

  const waited = await cli.run("wait", [running.jobId, "--json", "--state-dir", root.stateRoot, "--timeout", "1"], {
    codexThreadId: thread
  });
  assert.match(waited.error?.message ?? "", /Timed out waiting for bridge job/);
  assert.equal(waited.text, "", "a wait that times out prints nothing");
  assert.equal(readDelivery(done.jobId, done.brokerOptions).state, "inbox",
    "the timed-out wait printed no result, so the queued one must stay queued");
  assert.equal(cli.brokerStarts(), 1, "only the waited job gets a broker; a queued result restarts none");

  await assertNextOriginCommandDelivers(cli, fixture, thread);
});

const WAIT_CHILD = `
import { handleBridgeCommand } from ${JSON.stringify(CLI_URL)};
const [stateRoot, jobId, thread] = process.argv.slice(1);
process.exitCode = await handleBridgeCommand("wait", [jobId, "--json", "--state-dir", stateRoot, "--timeout", "600"], {
  codexThreadId: thread, processAlive: () => false, discoverBrokerPid: () => null, spawnDetached: () => 4242
});
`;

test("an origin wait that is interrupted leaves another job's queued result queued (D2, A13)", async (t) => {
  if (process.platform === "win32") {
    t.skip("a signal is an abrupt kill on Windows; the timeout test covers the same ground there");
    return;
  }
  const thread = "thread-live-origin-f";
  const fixture = await threadWithQueuedResult("ccb-live-origin-signal-", thread);
  const { root, done, running } = fixture;
  const child = spawn(process.execPath, ["--input-type=module", "-e", WAIT_CHILD, root.stateRoot, running.jobId, thread], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  let ended = null;
  child.once("exit", (code, signal) => { ended = { code, signal }; });

  // The wait is blocking once it holds the job's waiter lease.
  const deadline = Date.now() + 15_000;
  while (running.coordination.readWaiterLease(running.jobId)?.live !== true) {
    if (ended !== null || Date.now() > deadline) {
      child.kill("SIGKILL");
      assert.fail(`the wait never reached its blocking loop (exit ${JSON.stringify(ended)}): ${output}`);
    }
    await delay(20);
  }
  child.kill("SIGINT");
  while (ended === null) await delay(20);

  assert.equal(ended.signal, "SIGINT", `the wait was not interrupted by the signal: ${JSON.stringify(ended)} ${output}`);
  assert.equal(output, "", "an interrupted wait prints nothing");
  assert.equal(readDelivery(done.jobId, done.brokerOptions).state, "inbox",
    "the interrupted wait printed no result, so the queued one must stay queued");

  await assertNextOriginCommandDelivers(cliHarness(), fixture, thread);
});

test("a delegate that fails after the queue was found leaves the queued result queued (D2, A13)", async () => {
  const thread = "thread-live-origin-g";
  const fixture = await threadWithQueuedResult("ccb-live-origin-delegate-", thread);
  const { root, done } = fixture;
  const cli = cliHarness();

  // The running job holds the workspace, so creating the new job fails.
  const delegated = await cli.run("delegate", [
    "--prompt", "second task", "--verify-command", JSON.stringify([process.execPath, "-e", "0"]),
    "--path", root.workspace, "--thread-id", thread, "--state-dir", root.stateRoot,
    "--tmux", process.execPath, "--claude", process.execPath, "--codex", process.execPath, "--json"
  ]);
  assert.match(delegated.error?.message ?? "", /Workspace already leased by/);
  assert.equal(delegated.text, "", "a delegate that fails prints nothing");
  assert.equal(readDelivery(done.jobId, done.brokerOptions).state, "inbox",
    "the failed delegate printed no result, so the queued one must stay queued");

  await assertNextOriginCommandDelivers(cli, fixture, thread);
});

const countOf = (text, needle) => text.split(needle).length - 1;

test("the origin's plain-text wait prints the result it delivers as the waiter (D2, A13)", async () => {
  const job = createVerifiedJob("ccb-live-origin-plain-", "ccb_00000000000000000000D2F001", "thread-live-origin-h");
  const origin = busyOrigin(job.threadId);
  const cli = cliHarness();

  const waiting = cli.run("wait", [job.jobId, "--state-dir", job.stateRoot, "--timeout", "5"], {
    codexThreadId: job.threadId
  });
  await delay(100);
  const broker = await runBrokerOnce(job, origin.adapter, { maxSleeps: 300, sleepMs: 10 });
  const waited = await waiting;

  assert.equal(origin.calls(), 0, "the broker must hand delivery to the live waiter");
  assert.equal(waited.error, null, `origin wait: ${waited.error?.message}`);
  assert.equal(waited.exitCode, 0);
  assert.equal(broker.error, null, broker.error?.message);
  assert.equal(readDelivery(job.jobId, job.brokerOptions).state, "acknowledged");
  assert.equal(countOf(waited.text, "Implemented and verified the change."), 1,
    `the wait that delivers the result must print it (once); its plain-text output was:\n${waited.text}`);
  assert.match(waited.text, /Worker completed: yes/);
  assert.match(waited.text, /Independently verified: yes/);
});

test("the origin's wait for a queued job reports its result once, in plain text and in --json (D2, A13)", async () => {
  const thread = "thread-live-origin-i";
  const results = {};
  for (const [mode, jobId] of [["plain", "ccb_00000000000000000000D2F002"], ["json", "ccb_00000000000000000000D2F003"]]) {
    const job = createVerifiedJob(`ccb-live-origin-once-${mode}-`, jobId, thread);
    await deliverBridgeResult({
      result: job.result,
      receipt: readReceipt(job.jobId, job.brokerOptions),
      origin: job.origin,
      stateOperations: job.coordination,
      originAdapter: busyOrigin(thread).adapter
    });
    assert.equal(readDelivery(job.jobId, job.brokerOptions).state, "inbox");
    const argv = [job.jobId, "--state-dir", job.stateRoot, "--timeout", "2", ...(mode === "json" ? ["--json"] : [])];
    results[mode] = await cliHarness().run("wait", argv, { codexThreadId: thread });
    assert.equal(results[mode].error, null, results[mode].error?.message);
    assert.equal(results[mode].exitCode, 0);
    assert.equal(readDelivery(job.jobId, job.brokerOptions).state, "acknowledged");
  }
  assert.equal(countOf(results.plain.text, "Implemented and verified the change."), 1, results.plain.text);
  const payload = JSON.parse(results.json.text);
  assert.equal(payload.result.summary, "Implemented and verified the change.");
  assert.equal(payload.queuedResults, undefined,
    "the payload already carries this job's result, so queuedResults must not repeat it");
});

// The inbox is claimed across the whole state root, but the CLI looks for a
// thread's queued origins only among the newest 64 jobs (its auto-recovery scan
// window). An origin command that names an older job must still deliver that
// job's result, so the job it names always counts.
const JOBS_NEWER_THAN_THE_SCAN_WINDOW = 65;

async function queuedResultsBehindNewerJobs(prefix, queuedJobs) {
  const root = createRoot(prefix);
  const jobs = [];
  for (const { jobId, thread } of queuedJobs) {
    const job = createVerifiedJob(prefix, jobId, thread, { root });
    const queued = await deliverBridgeResult({
      result: job.result,
      receipt: readReceipt(job.jobId, job.brokerOptions),
      origin: job.origin,
      stateOperations: job.coordination,
      originAdapter: busyOrigin(thread).adapter
    });
    assert.equal(queued.state, "queued");
    assert.equal(readDelivery(job.jobId, job.brokerOptions).state, "inbox");
    jobs.push(job);
  }
  // Newer jobs of another thread, one workspace each, created after the queued ones.
  for (let index = 1; index <= JOBS_NEWER_THAN_THE_SCAN_WINDOW; index += 1) {
    const workspace = path.join(root.base, `workspace-${index}`);
    fs.mkdirSync(workspace);
    createVerifiedJob(prefix, `ccb_00000000000000000000D2B${String(index).padStart(3, "0")}`, "thread-live-origin-bystander", {
      root: { ...root, workspace }, complete: false
    });
  }
  const newest = fs.readdirSync(path.join(root.stateRoot, "jobs")).sort().reverse().slice(0, 64);
  for (const job of jobs) {
    assert.ok(!newest.includes(job.jobId), `${job.jobId} must lie outside the 64 newest jobs for this test to mean anything`);
  }
  return { root, jobs };
}

test("an origin's status of a queued job older than the newest 64 delivers its result (D2, A13)", async () => {
  const { root, jobs: [asJson, asText] } = await queuedResultsBehindNewerJobs("ccb-live-origin-window-", [
    { jobId: "ccb_00000000000000000000D2A001", thread: "thread-live-origin-j" },
    { jobId: "ccb_00000000000000000000D2A002", thread: "thread-live-origin-k" }
  ]);

  // Guard, green at base: a caller that is not the job's origin only observes.
  const observed = await cliHarness().run("status", [asJson.jobId, "--json", "--state-dir", root.stateRoot], {
    codexThreadId: "thread-observer"
  });
  assert.equal(observed.error, null, observed.error?.message);
  assert.equal(readDelivery(asJson.jobId, asJson.brokerOptions).state, "inbox", "an observer's status claims nothing");

  const asked = await cliHarness().run("status", [asJson.jobId, "--json", "--state-dir", root.stateRoot], {
    codexThreadId: asJson.threadId
  });
  assert.equal(asked.error, null, asked.error?.message);
  assert.equal(JSON.parse(asked.text).result.summary, "Implemented and verified the change.");
  const delivered = readDelivery(asJson.jobId, asJson.brokerOptions);
  assert.deepEqual({ state: delivered.state, route: delivered.route }, { state: "acknowledged", route: "waiter" },
    "the origin asked about this exact job, so its status must deliver the queued result");
  assert.equal(readDelivery(asText.jobId, asText.brokerOptions).state, "inbox",
    "another thread's queued result is not this command's to deliver");

  const askedPlain = await cliHarness().run("status", [asText.jobId, "--state-dir", root.stateRoot], {
    codexThreadId: asText.threadId
  });
  assert.equal(askedPlain.error, null, askedPlain.error?.message);
  assert.equal(countOf(askedPlain.text, "Implemented and verified the change."), 1,
    `the status that delivers the result must print it (once); its plain-text output was:\n${askedPlain.text}`);
  assert.equal(readDelivery(asText.jobId, asText.brokerOptions).state, "acknowledged");
});

// The origin's output is the delivery, so a result is acknowledged only after that
// output was written. A write that fails (a closed pipe, a full disk) leaves the
// result deliverable instead of recorded as delivered (review P1). A command
// claims, writes, and then acknowledges.
const refusedWrite = () => {
  throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
};

test("an origin command acknowledges a queued result only after it wrote it (D2, P1)", async () => {
  const thread = "thread-live-origin-l";
  const { root, done, running } = await threadWithQueuedResult("ccb-live-origin-order-", thread);
  const duringWrite = [];
  const asked = await cliHarness().run("status", [running.jobId, "--json", "--state-dir", root.stateRoot], {
    codexThreadId: thread,
    write: () => { duringWrite.push(readDelivery(done.jobId, done.brokerOptions).state); }
  });
  assert.equal(asked.error, null, asked.error?.message);
  assert.deepEqual(duringWrite, ["inbox_claimed"],
    "while the output is written the result is claimed, not yet acknowledged");
  assert.equal(readDelivery(done.jobId, done.brokerOptions).state, "acknowledged");
});

test("a failed write leaves the queued result queued, and the next origin command delivers it (D2, P1)", async () => {
  const thread = "thread-live-origin-m";
  const fixture = await threadWithQueuedResult("ccb-live-origin-writefail-", thread);
  const { root, done, running } = fixture;
  const cli = cliHarness();

  const failed = await cli.run("status", [running.jobId, "--json", "--state-dir", root.stateRoot], {
    codexThreadId: thread, write: refusedWrite
  });
  assert.match(failed.error?.message ?? "", /write EPIPE/, "the command reports the failed write");
  assert.equal(readDelivery(done.jobId, done.brokerOptions).state, "inbox",
    "the output was not written, so the queued result must be deliverable again");

  await assertNextOriginCommandDelivers(cli, fixture, thread);
});

test("the origin's wait for a queued job acknowledges it only after it wrote it, and exits 0 (D2, P1)", async () => {
  const job = createVerifiedJob("ccb-live-origin-wait-order-", "ccb_00000000000000000000D2F010", "thread-live-origin-n");
  await deliverBridgeResult({
    result: job.result,
    receipt: readReceipt(job.jobId, job.brokerOptions),
    origin: job.origin,
    stateOperations: job.coordination,
    originAdapter: busyOrigin(job.threadId).adapter
  });
  assert.equal(readDelivery(job.jobId, job.brokerOptions).state, "inbox");
  const duringWrite = [];
  const waited = await cliHarness().run("wait", [job.jobId, "--json", "--state-dir", job.stateRoot, "--timeout", "2"], {
    codexThreadId: job.threadId,
    write: () => { duringWrite.push(readDelivery(job.jobId, job.brokerOptions).state); }
  });
  assert.equal(waited.error, null, waited.error?.message);
  assert.equal(waited.exitCode, 0, "the acknowledgement that follows the write is what exit 0 reports");
  assert.deepEqual(duringWrite, ["inbox_claimed"]);
  assert.equal(readDelivery(job.jobId, job.brokerOptions).state, "acknowledged");
});

test("the origin's wait acknowledges the waiter's claim only after it wrote the result, and exits 0 (D2, P1)", async () => {
  const job = createVerifiedJob("ccb-live-origin-waiter-order-", "ccb_00000000000000000000D2F011", "thread-live-origin-o");
  const origin = busyOrigin(job.threadId);
  const duringWrite = [];
  const waiting = cliHarness().run("wait", [job.jobId, "--json", "--state-dir", job.stateRoot, "--timeout", "5"], {
    codexThreadId: job.threadId,
    write: () => { duringWrite.push(readDelivery(job.jobId, job.brokerOptions).state); }
  });
  await delay(100);
  const broker = await runBrokerOnce(job, origin.adapter, { maxSleeps: 300, sleepMs: 10 });
  const waited = await waiting;
  assert.equal(origin.calls(), 0, "the broker must hand delivery to the live waiter");
  assert.equal(waited.error, null, waited.error?.message);
  assert.equal(waited.exitCode, 0);
  assert.equal(broker.error, null, broker.error?.message);
  assert.deepEqual(duringWrite, ["claimed"], "while the output is written the waiter's claim is held, not acknowledged");
  assert.equal(readDelivery(job.jobId, job.brokerOptions).state, "acknowledged");
});

test("a failed write leaves the waiter's claim unacknowledged (D2, P1)", async () => {
  const job = createVerifiedJob("ccb-live-origin-waiter-writefail-", "ccb_00000000000000000000D2F012", "thread-live-origin-p");
  const origin = busyOrigin(job.threadId);
  const waiting = cliHarness().run("wait", [job.jobId, "--json", "--state-dir", job.stateRoot, "--timeout", "5"], {
    codexThreadId: job.threadId, write: refusedWrite
  });
  await delay(100);
  // The broker keeps waiting for the acknowledgement that never comes and gives up.
  await runBrokerOnce(job, origin.adapter, { maxSleeps: 30, sleepMs: 10 });
  const waited = await waiting;
  assert.match(waited.error?.message ?? "", /write EPIPE/, "the wait reports the failed write");
  assert.notEqual(readDelivery(job.jobId, job.brokerOptions).state, "acknowledged",
    "the result was not written, so it must not be recorded as delivered");
});

test("a delegate whose write fails leaves the queued result queued (D2, P1)", async () => {
  const thread = "thread-live-origin-q";
  const root = createRoot("ccb-live-origin-delegate-write-");
  const done = createVerifiedJob("ccb-live-origin-delegate-write-", "ccb_00000000000000000000D2F013", thread, { root });
  await deliverBridgeResult({
    result: done.result,
    receipt: readReceipt(done.jobId, done.brokerOptions),
    origin: done.origin,
    stateOperations: done.coordination,
    originAdapter: busyOrigin(thread).adapter
  });
  assert.equal(readDelivery(done.jobId, done.brokerOptions).state, "inbox");

  const delegated = await cliHarness().run("delegate", [
    "--prompt", "second task", "--verify-command", JSON.stringify([process.execPath, "-e", "0"]),
    "--path", root.workspace, "--thread-id", thread, "--state-dir", root.stateRoot,
    "--tmux", process.execPath, "--claude", process.execPath, "--codex", process.execPath, "--json"
  ], { write: refusedWrite });
  assert.match(delegated.error?.message ?? "", /write EPIPE/, "the delegate reports the failed write");
  assert.equal(readDelivery(done.jobId, done.brokerOptions).state, "inbox",
    "the output was not written, so the queued result must be deliverable again");
});

// The real thing: process.stdout reports a failed write through the write callback,
// never as an exception. The child's reader is gone before it writes.
const STATUS_CHILD = `
import { handleBridgeCommand } from ${JSON.stringify(CLI_URL)};
const [stateRoot, jobId, thread] = process.argv.slice(1);
await new Promise((resolve) => process.stdin.once("data", resolve));
try {
  await handleBridgeCommand("status", [jobId, "--json", "--state-dir", stateRoot], {
    codexThreadId: thread, processAlive: () => false, discoverBrokerPid: () => null, spawnDetached: () => 4242
  });
  process.stderr.write("STATUS-WRITTEN\\n");
} catch (error) {
  process.stderr.write("STATUS-FAILED " + (error?.code ?? error?.message) + "\\n");
}
`;

test("a closed stdout leaves the queued result queued (D2, P1)", async (t) => {
  if (process.platform === "win32") {
    t.skip("a closed pipe reports a different error on Windows; the injected-write tests cover the same ground there");
    return;
  }
  const thread = "thread-live-origin-r";
  const fixture = await threadWithQueuedResult("ccb-live-origin-epipe-", thread);
  const { root, done, running } = fixture;
  const child = spawn(process.execPath, ["--input-type=module", "-e", STATUS_CHILD, root.stateRoot, running.jobId, thread], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  let diagnostics = "";
  child.stderr.on("data", (chunk) => { diagnostics += chunk; });
  const ended = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.stdout.destroy();
  child.stdin.end("go\n");
  const exit = await ended;

  assert.equal(readDelivery(done.jobId, done.brokerOptions).state, "inbox",
    `the child could not write its output, so the queued result must stay deliverable (exit ${JSON.stringify(exit)}): ${diagnostics}`);
  assert.match(diagnostics, /STATUS-FAILED EPIPE/, "the command reports the failed write");

  await assertNextOriginCommandDelivers(cliHarness(), fixture, thread);
});
