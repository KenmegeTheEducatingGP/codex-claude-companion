// P1: this release understands broker spec schemaVersion 1 only. A spec written
// by a newer release (or one with no version) is refused with a clear error
// before any runtime is created, so a rollback can never misrun it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  persistBridgeBrokerSpec,
  readBridgeBrokerSpec,
  runBridgeBroker
} from "../scripts/lib/bridge-broker.mjs";

function spec(base, overrides = {}) {
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
    intervalMs: 100,
    ...overrides
  };
}

const UNSUPPORTED = /broker spec schemaVersion .* is not supported by this release \(supported: 1\)/;

test("broker refuses an unknown spec version before creating a runtime (P1)", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-spec-version-"));
  for (const schemaVersion of [2, 0, "1", null]) {
    let runtimeCreated = false;
    await assert.rejects(
      () => runBridgeBroker(spec(base, { schemaVersion }), {
        createRuntime() { runtimeCreated = true; throw new Error("runtime must not be created"); }
      }),
      UNSUPPORTED,
      `schemaVersion ${JSON.stringify(schemaVersion)} must be refused`
    );
    assert.equal(runtimeCreated, false);
  }
  const { schemaVersion: _omitted, ...unversioned } = spec(base);
  await assert.rejects(
    () => runBridgeBroker(unversioned, { createRuntime() { throw new Error("runtime must not be created"); } }),
    UNSUPPORTED
  );
});

test("a persisted spec from a newer release is refused on read and never written (P1)", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-spec-version-file-"));
  const newer = path.join(base, "newer-spec.json");
  fs.writeFileSync(newer, `${JSON.stringify(spec(base, { schemaVersion: 2 }))}\n`, { mode: 0o600 });
  assert.throws(() => readBridgeBrokerSpec(newer), UNSUPPORTED);

  const target = path.join(base, "job", "broker-spec.json");
  assert.throws(() => persistBridgeBrokerSpec(target, spec(base, { schemaVersion: 2 })), UNSUPPORTED);
  assert.equal(fs.existsSync(target), false);
});

test("a version-1 spec still runs (P1)", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-spec-version-ok-"));
  const outcome = await runBridgeBroker(spec(base), {
    createRuntime: () => ({
      compatibility: { ready: true },
      async run() { return { action: "terminal", classification: "settled" }; }
    }),
    stateApi: {
      getBridgeJob: () => ({ status: "completed" }),
      readBridgeResult: () => ({ status: "completed" })
    }
  });
  assert.equal(outcome.status, "settled");
});
