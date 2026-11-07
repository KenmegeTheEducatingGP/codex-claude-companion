// D1/R2: the bridge and the bundled Codex plugin never force a sandbox or an
// approval policy. Keys are absent unless the caller supplied a value, so the
// host's own Codex configuration decides, and delivery never persists a
// downgrade into the origin thread.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "../tests/fake-codex-fixture.mjs";
import {
  assertBrokerCleanupComplete,
  cleanupLeakedBrokers,
  initGitRepo,
  makeTempDir,
  run,
  waitForTerminatedProcessTrees
} from "../tests/helpers.mjs";
import { createCodexOriginAdapter } from "../scripts/lib/bridge-delivery.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { runAppServerTurn } from "../plugins/codex/scripts/lib/codex.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");
const PERMISSION_KEYS = ["sandbox", "sandboxPolicy", "approvalPolicy"];

// Companion runs keep their job state in a private temporary plugin data dir,
// and never inherit a live session filter from the host.
const hadPluginDataDir = Object.hasOwn(process.env, "CLAUDE_PLUGIN_DATA");
const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
process.env.CLAUDE_PLUGIN_DATA = makeTempDir("ccb-host-config-plugin-data-");
const hadSessionId = Object.hasOwn(process.env, "CODEX_COMPANION_SESSION_ID");
const previousSessionId = process.env.CODEX_COMPANION_SESSION_ID;
delete process.env.CODEX_COMPANION_SESSION_ID;

after(async () => {
  try {
    const cleanup = cleanupLeakedBrokers();
    assertBrokerCleanupComplete(cleanup);
    await waitForTerminatedProcessTrees(cleanup.terminatedPids);
  } finally {
    if (hadPluginDataDir) process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    else delete process.env.CLAUDE_PLUGIN_DATA;
    if (hadSessionId) process.env.CODEX_COMPANION_SESSION_ID = previousSessionId;
    else delete process.env.CODEX_COMPANION_SESSION_ID;
  }
});

function useFakeCodexPath(t, binDir) {
  const previousPath = process.env.PATH;
  process.env.PATH = buildEnv(binDir).PATH;
  t.after(() => { process.env.PATH = previousPath; });
}

function recordedRequests(binDir, method) {
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  return (state.requests ?? []).filter((entry) => entry.method === method);
}

function lastRequest(binDir, method) {
  const requests = recordedRequests(binDir, method);
  assert.ok(requests.length > 0, `fake Codex recorded no ${method} request`);
  return requests.at(-1);
}

function assertNoPermissionKeys(entry, context) {
  for (const key of PERMISSION_KEYS) {
    assert.equal(Object.hasOwn(entry.params, key), false,
      `${context}: ${entry.method} sent ${key}=${JSON.stringify(entry.params[key])}; the host config must decide`);
  }
}

async function withDirectClient(cwd, callback) {
  const client = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  try {
    return await callback(client);
  } finally {
    await client.close();
  }
}

test("bridge delivery to a Codex origin leaves the origin thread's host permissions unchanged (D1, A3)", async (t) => {
  const workspace = makeTempDir("ccb-host-config-");
  const binDir = makeTempDir("ccb-host-config-bin-");
  installFakeCodex(binDir);
  useFakeCodexPath(t, binDir);

  // Spike-2 step A: the origin thread starts with no overrides, so the host decides.
  const threadId = await withDirectClient(workspace, async (client) => {
    const started = await client.request("thread/start", { cwd: workspace, ephemeral: false });
    assert.equal(started.sandbox.type, "dangerFullAccess");
    assert.equal(started.approvalPolicy, "never");
    return started.thread.id;
  });

  // Step B': the shipped delivery adapter resumes the origin with the result.
  const acknowledgement = await createCodexOriginAdapter()({
    cwd: workspace,
    resumeThreadId: threadId,
    prompt: "Codex-Claude Bridge result for a test job."
  });
  assert.equal(acknowledgement.acknowledged, true);
  assert.equal(acknowledgement.threadId, threadId);
  assertNoPermissionKeys(lastRequest(binDir, "thread/resume"), "origin delivery");
  assertNoPermissionKeys(lastRequest(binDir, "turn/start"), "origin delivery");

  // Step C: a later fresh resume with no overrides sees what the thread persisted.
  const later = await withDirectClient(workspace, (client) =>
    client.request("thread/resume", { threadId, cwd: workspace }));
  assert.equal(later.sandbox.type, "dangerFullAccess",
    `delivery persisted sandbox ${later.sandbox.type} into the origin thread`);
  assert.equal(later.approvalPolicy, "never");
});

test("app-server task threads carry permission keys only when the caller passes a value (D1)", async (t) => {
  const workspace = makeTempDir("ccb-host-config-turn-");
  const binDir = makeTempDir("ccb-host-config-turn-bin-");
  installFakeCodex(binDir);
  useFakeCodexPath(t, binDir);

  const hostDecided = await runAppServerTurn(workspace, { prompt: "inspect the workspace", disableBroker: true });
  assert.equal(hostDecided.status, 0);
  assertNoPermissionKeys(lastRequest(binDir, "thread/start"), "task with no profile");

  const explicit = await runAppServerTurn(workspace, {
    prompt: "edit the workspace", sandbox: "workspace-write", disableBroker: true
  });
  assert.equal(explicit.status, 0);
  const start = lastRequest(binDir, "thread/start");
  assert.equal(start.params.sandbox, "workspace-write", "an explicit sandbox value must pass through unchanged");
  assert.equal(Object.hasOwn(start.params, "approvalPolicy"), false,
    `an explicit sandbox must not drag in approvalPolicy=${JSON.stringify(start.params.approvalPolicy)}`);
});

function dirtyRepository() {
  const repo = makeTempDir("ccb-host-config-repo-");
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");
  return repo;
}

test("companion task, review and adversarial review pass a sandbox only when the user asked for one (R2)", () => {
  const cases = [
    { argv: ["task", "inspect the repository"], sandbox: null },
    { argv: ["task", "--write", "edit the repository"], sandbox: "workspace-write" },
    { argv: ["review"], sandbox: null },
    { argv: ["adversarial-review"], sandbox: null }
  ];
  for (const { argv, sandbox } of cases) {
    // One repository and one fake Codex per case: the companion keeps one
    // app-server broker per repository, bound to the first PATH it saw.
    const repo = dirtyRepository();
    const binDir = makeTempDir("ccb-host-config-companion-bin-");
    installFakeCodex(binDir);
    const result = run("node", [COMPANION, ...argv], { cwd: repo, env: buildEnv(binDir) });
    const label = `codex-companion ${argv.join(" ")}`;
    assert.equal(result.status, 0, `${label}: ${result.stderr}\n${result.stdout}`);
    const start = lastRequest(binDir, "thread/start");
    if (sandbox === null) {
      assertNoPermissionKeys(start, label);
    } else {
      assert.equal(start.params.sandbox, sandbox, `${label}: explicit --write must request ${sandbox}`);
      assert.equal(Object.hasOwn(start.params, "approvalPolicy"), false,
        `${label}: sent approvalPolicy=${JSON.stringify(start.params.approvalPolicy)}`);
    }
  }
});
