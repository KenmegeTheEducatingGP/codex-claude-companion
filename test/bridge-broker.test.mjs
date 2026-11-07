import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runBridgeBroker } from "../scripts/lib/bridge-broker.mjs";

function spec(base) {
  const absolute = (name) => path.join(base, name);
  return {
    schemaVersion: 1,
    jobId: "ccb_00000000000000000000000001",
    prompt: "durable prompt",
    workerCapabilityToken: "w".repeat(43),
    stateRoot: absolute("state"),
    jobDir: absolute("job"),
    tmuxBinary: absolute("tmux"),
    claudeBinary: absolute("claude"),
    codexBinary: process.execPath,
    nodeBinary: process.execPath,
    envBinary: "/usr/bin/env",
    heartbeatFile: absolute("heartbeat.json"),
    intervalMs: 100
  };
}

test("broker autonomously retries durable inbox delivery until the origin acknowledges", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-broker-"));
  let calls = 0;
  let runtimeOptions;
  const sleeps = [];
  const runtime = {
    compatibility: { ready: true },
    async run() {
      calls += 1;
      return calls === 1
        ? { action: "delivery", classification: "queued" }
        : { action: "delivery", classification: "acknowledged" };
    }
  };
  const outcome = await runBridgeBroker(spec(base), {
    createRuntime: (options) => { runtimeOptions = options; return runtime; },
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    stateApi: {
      getBridgeJob: () => ({ status: "running" }),
      readBridgeResult: () => null
    }
  });

  assert.equal(calls, 2);
  assert.equal(outcome.status, "settled");
  assert.equal(outcome.outcome.action, "delivery");
  assert.deepEqual(sleeps, [30_000]);
  assert.equal(runtimeOptions.codexBinary, process.execPath);
  assert.equal(runtimeOptions.maxRepairs, 0);
  assert.equal(runtimeOptions.leaseMs, 30_000);
});

test("broker retries a leased delivery claim instead of requiring a later CLI invocation", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-broker-deferred-"));
  let calls = 0;
  const sleeps = [];
  const outcome = await runBridgeBroker({ ...spec(base), deliveryRetryMs: 1_500 }, {
    createRuntime: () => ({
      compatibility: { ready: true },
      async run() {
        calls += 1;
        return calls === 1
          ? { action: "delivery", classification: "deferred" }
          : { action: "delivery", classification: "deduplicated" };
      }
    }),
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    stateApi: {
      getBridgeJob: () => ({ status: "running" }),
      readBridgeResult: () => null
    }
  });

  assert.equal(calls, 2);
  assert.equal(outcome.status, "settled");
  assert.deepEqual(sleeps, [1_500]);
});

test("broker preserves the prior launch error when recovery becomes ambiguous", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-broker-last-error-"));
  let calls = 0;
  const outcome = await runBridgeBroker(spec(base), {
    createRuntime: () => ({
      compatibility: { ready: true },
      async run() {
        calls += 1;
        if (calls === 1) throw new Error("launch failed before worker identity");
        return { action: "recovery-required", classification: "ambiguous" };
      }
    }),
    sleep: async () => {},
    stateApi: {
      getBridgeJob: () => ({ status: "accepted" }),
      readBridgeResult: () => null
    }
  });

  assert.equal(outcome.status, "blocked");
  assert.equal(calls, 2);
  const heartbeat = JSON.parse(fs.readFileSync(spec(base).heartbeatFile, "utf8"));
  assert.equal(heartbeat.action, "recovery-required");
  assert.equal(heartbeat.consecutiveErrors, 0);
  assert.equal(heartbeat.lastError, "launch failed before worker identity");
});

test("broker durably exposes a verifying heartbeat before a blocking verifier stage", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-broker-verifying-"));
  let observed;
  await runBridgeBroker(spec(base), {
    createRuntime(runtimeOptions) {
      return {
        compatibility: { ready: true },
        async run() {
          runtimeOptions.onVerificationProgress({
            jobId: spec(base).jobId,
            stage: "codex-review",
            attempt: 0
          });
          observed = JSON.parse(fs.readFileSync(spec(base).heartbeatFile, "utf8"));
          return { action: "terminal", classification: "settled" };
        }
      };
    },
    stateApi: {
      getBridgeJob: () => ({ status: "completed" }),
      readBridgeResult: () => ({ status: "completed" })
    }
  });

  assert.equal(observed.action, "verifying");
  assert.equal(observed.consecutiveErrors, 0);
  assert.deepEqual(observed.verification, {
    jobId: spec(base).jobId,
    stage: "codex-review",
    attempt: 0
  });
});

test("broker rejects repair counts outside the bounded 0-or-1 contract before runtime creation", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-broker-repairs-"));
  await assert.rejects(
    () => runBridgeBroker({ ...spec(base), maxRepairs: 2 }, { createRuntime() { throw new Error("must not launch"); } }),
    /maxRepairs must be 0 or 1/
  );
});

test("parent broker wires one durable production repair lifecycle into the runtime", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-broker-parent-repair-"));
  const repairLifecycle = {
    async dispatchRepair() {}, async awaitRepair() {}, async resumePendingRepair() {}
  };
  let lifecycleOptions;
  let runtimeOptions;
  const outcome = await runBridgeBroker({ ...spec(base), maxRepairs: 1 }, {
    createRepairLifecycle(options) {
      lifecycleOptions = options;
      return repairLifecycle;
    },
    createRuntime(options) {
      runtimeOptions = options;
      return {
        compatibility: { ready: true },
        async run() { return { action: "terminal", classification: "settled" }; }
      };
    },
    stateApi: {
      getBridgeJob: () => ({ status: "completed" }),
      readBridgeResult: () => ({ status: "completed" })
    }
  });
  assert.equal(outcome.status, "settled");
  assert.equal(lifecycleOptions.parentSpec.maxRepairs, 1);
  assert.equal(runtimeOptions.repairLifecycle, repairLifecycle);
  assert.equal(runtimeOptions.internalRepair, null);
  lifecycleOptions.onProgress({ childJobId: "ccb_00000000000000000000000002", attempt: 1, phase: "running" });
  const heartbeat = JSON.parse(fs.readFileSync(spec(base).heartbeatFile, "utf8"));
  assert.equal(heartbeat.action, "repairing");
  assert.equal(heartbeat.repair.phase, "running");
});

test("internal repair broker is maxRepairs=0 and exits on repair-terminal without settlement delivery", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-broker-child-repair-"));
  const childSpec = {
    ...spec(base),
    jobId: "ccb_00000000000000000000000002",
    maxRepairs: 0,
    internalRepair: { parentJobId: "ccb_00000000000000000000000001", attempt: 1 }
  };
  let runtimeOptions;
  const outcome = await runBridgeBroker(childSpec, {
    createRuntime(options) {
      runtimeOptions = options;
      return {
        compatibility: { ready: true },
        async run() {
          return { action: "repair-terminal", classification: "completed", result: { status: "completed" } };
        }
      };
    },
    stateApi: {
      getBridgeJob: () => ({ status: "completed" }),
      readBridgeResult: () => ({ status: "completed" })
    }
  });
  assert.equal(outcome.status, "settled");
  assert.deepEqual(runtimeOptions.internalRepair, childSpec.internalRepair);
  assert.equal(runtimeOptions.repairLifecycle, null);

  await assert.rejects(
    () => runBridgeBroker({ ...childSpec, maxRepairs: 1 }),
    /internalRepair must identify a distinct parent/
  );
});
