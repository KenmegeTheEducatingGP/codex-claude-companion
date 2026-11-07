// D3: workers and verifiers run under the delegating session's own account
// homes. CLAUDE_CONFIG_DIR and CODEX_HOME are non-secret paths, so every env
// allowlist passes them through when set; credentials and unknown variables
// stay stripped.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildMinimalWorkerEnv } from "../scripts/lib/tmux-executor.mjs";
import { verifierEnvironment } from "../scripts/lib/bridge-production-verifier.mjs";
import { runClaudeWorker } from "../scripts/lib/claude-runner.mjs";

const WORKER_CAPABILITY = "w".repeat(43);

function homes(base) {
  return {
    claudeConfigDir: path.join(base, "homes", "claude-alt-account"),
    codexHome: path.join(base, "homes", "codex-alt-account")
  };
}

test("tmux worker environment carries both account homes and still drops unlisted variables (A12)", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-env-homes-"));
  const { claudeConfigDir, codexHome } = homes(base);
  const environment = buildMinimalWorkerEnv({
    HOME: base,
    PATH: "/usr/bin:/bin",
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    CODEX_HOME: codexHome,
    OPENAI_API_KEY: "not-for-workers",
    GITHUB_TOKEN: "not-for-workers",
    CODEX_THREAD_ID: "origin-thread"
  });
  assert.deepEqual(environment, {
    HOME: base,
    PATH: "/usr/bin:/bin",
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    CODEX_HOME: codexHome
  });
});

test("verifier environment carries both account homes and never a credential (A12)", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-env-homes-verifier-"));
  const { claudeConfigDir, codexHome } = homes(base);
  const environment = verifierEnvironment({
    HOME: base,
    PATH: "/usr/bin:/bin",
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    CODEX_HOME: codexHome,
    ANTHROPIC_API_KEY: "not-for-verifiers",
    OPENAI_API_KEY: "not-for-verifiers",
    CLAUDE_CODE_OAUTH_TOKEN: "not-for-verifiers"
  }, "darwin");
  assert.equal(environment.CODEX_HOME, codexHome);
  assert.equal(environment.CLAUDE_CONFIG_DIR, claudeConfigDir);
  for (const secret of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    assert.equal(Object.hasOwn(environment, secret), false, `${secret} leaked into the verifier environment`);
  }
});

function runnerRequest(workspace) {
  return {
    schemaVersion: 1,
    jobId: "ccb_00000000000000000000000001",
    origin: {
      codexThreadId: "thread-1", codexTurnId: "turn-1", cwd: workspace,
      repoRoot: workspace, branch: "main", head: "a".repeat(40)
    },
    worker: {
      provider: "anthropic", model: "opus", agent: null, inlineAgents: null,
      customAgentsFile: null, pluginDirs: [], mcpConfigPaths: [], addDirs: [],
      settingSources: [], effort: "high", resolvedRuntimeVersion: "2.1.207"
    },
    execution: {
      profile: "trusted-autonomous", executor: "tmux", tmuxSession: "ccb-env-homes",
      workspaceMode: "current", requestedWorkspacePath: workspace, canonicalWorkspacePath: workspace,
      permittedRoot: workspace, claudeSessionId: "00000000-0000-4000-8000-000000000001",
      sandboxAttestation: null, timeoutSeconds: 30,
      effectiveClaudePermissionArgs: ["--setting-sources=", "--permission-mode", "bypassPermissions"]
    },
    task: { promptFile: "prompt.md", acceptance: ["tests pass"] }
  };
}

test("Claude runner hands CLAUDE_CONFIG_DIR to the worker and records only the home basenames (D3)", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-env-homes-runner-"));
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace);
  const { claudeConfigDir, codexHome } = homes(base);
  const runtimeDir = path.join(base, "job", "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const requestFile = path.join(runtimeDir, "request.json");
  const promptFile = path.join(base, "prompt.txt");
  const environmentFile = path.join(base, "environment.json");
  const captured = path.join(base, "captured-homes.txt");
  const fakeClaude = path.join(base, "fake-claude");
  fs.writeFileSync(requestFile, JSON.stringify(runnerRequest(workspace)), { mode: 0o600 });
  fs.writeFileSync(promptFile, "account home probe", { mode: 0o600 });
  fs.writeFileSync(environmentFile, JSON.stringify({
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    CODEX_HOME: codexHome
  }), { mode: 0o600 });
  fs.writeFileSync(fakeClaude,
    `#!/bin/sh\nIFS= read -r line\nprintf '%s|%s' "$CLAUDE_CONFIG_DIR" "$CODEX_HOME" > '${captured}'\n`,
    { mode: 0o700 });
  const spec = {
    requestFile, promptFile, environmentFile, claudeBinary: fakeClaude,
    workerCapabilityToken: WORKER_CAPABILITY,
    identityFile: path.join(base, "identity.json"), heartbeatFile: path.join(base, "heartbeat.json"),
    exitFile: path.join(base, "exit.json"), stdoutFile: path.join(base, "stdout.log"),
    stderrFile: path.join(base, "stderr.log"), heartbeatIntervalMs: 20
  };

  const result = await runClaudeWorker(spec);

  assert.equal(result.code, 0);
  assert.equal(fs.readFileSync(captured, "utf8"), `${claudeConfigDir}|${codexHome}`);
  const identityText = fs.readFileSync(spec.identityFile, "utf8");
  assert.deepEqual(JSON.parse(identityText).accountHomes, {
    claudeConfigDir: "claude-alt-account",
    codexHome: "codex-alt-account"
  });
  assert.equal(identityText.includes(path.join(base, "homes")), false,
    "the runner identity must record home basenames only, never the full path");
});
