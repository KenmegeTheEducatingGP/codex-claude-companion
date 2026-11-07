import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  BridgeConfigError,
  DEFAULT_BRIDGE_CONFIG,
  loadBridgeConfig,
  resolveBridgeConfigPath,
  resolveRouting
} from "../scripts/lib/bridge-config.mjs";
import { validateBridgeConfigContract } from "../scripts/lib/bridge-contracts.mjs";
import { BRIDGE_AGENT_PRESETS, BRIDGE_PROFILES } from "../scripts/lib/bridge-policy.mjs";
import { loadBridgeExtensions } from "../scripts/lib/bridge-extensions.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bridge-config-"));
}

function writeConfig(document) {
  const dir = tempDir();
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, typeof document === "string" ? document : JSON.stringify(document));
  return file;
}

async function extensionWith(source) {
  const dir = tempDir();
  const file = path.join(dir, "extension.mjs");
  fs.writeFileSync(file, source);
  return loadBridgeExtensions([file]);
}

function exampleConfig(extensionPath = "/path/to/extension.mjs") {
  return {
    schemaVersion: 1,
    defaults: { profile: "host", workerFamily: "claude", maxRepairs: 1, overagePolicy: "stop" },
    reviewLanePolicy: "host",
    presets: { reviewer: { profile: "review-readonly" } },
    routing: { review: { family: "codex", model: null, effort: "high" } },
    extensions: [extensionPath]
  };
}

const CODEX_MODELS = [
  { id: "model-a", model: "model-a", hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }, { reasoningEffort: "high", description: "" }] },
  { id: "model-b", model: "model-b", hidden: false, isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }] }
];

test("the config path honours CODEX_CLAUDE_CONFIG, then XDG_CONFIG_HOME, then HOME", () => {
  assert.equal(resolveBridgeConfigPath({ CODEX_CLAUDE_CONFIG: "/etc/ccb/config.json", XDG_CONFIG_HOME: "/xdg", HOME: "/home/u" }), "/etc/ccb/config.json");
  assert.equal(resolveBridgeConfigPath({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/u" }), "/xdg/codex-claude/config.json");
  assert.equal(resolveBridgeConfigPath({ XDG_CONFIG_HOME: "relative/xdg", HOME: "/home/u" }), "/home/u/.config/codex-claude/config.json", "a relative XDG_CONFIG_HOME is ignored per the XDG spec");
  assert.equal(resolveBridgeConfigPath({ HOME: "/home/u" }), "/home/u/.config/codex-claude/config.json");
  assert.throws(() => resolveBridgeConfigPath({ CODEX_CLAUDE_CONFIG: "relative.json", HOME: "/home/u" }), (error) => error instanceof BridgeConfigError && error.code === "config_path_not_absolute");
});

test("a missing config file yields the empty defaults and changes nothing", () => {
  const file = path.join(tempDir(), "absent.json");
  const loaded = loadBridgeConfig({ env: { CODEX_CLAUDE_CONFIG: file } });
  assert.deepEqual(loaded, { path: file, exists: false, config: DEFAULT_BRIDGE_CONFIG });
  assert.deepEqual(DEFAULT_BRIDGE_CONFIG, { schemaVersion: 1, defaults: {}, reviewLanePolicy: null, presets: {}, routing: {}, extensions: [] });
  assert.ok(Object.isFrozen(DEFAULT_BRIDGE_CONFIG) && Object.isFrozen(DEFAULT_BRIDGE_CONFIG.defaults));
});

test("the documented example config loads, validates, and is normalized and frozen", () => {
  const file = writeConfig(exampleConfig());
  const loaded = loadBridgeConfig({ env: { CODEX_CLAUDE_CONFIG: file } });
  assert.equal(loaded.exists, true);
  assert.deepEqual(loaded.config, exampleConfig());
  assert.ok(Object.isFrozen(loaded.config.routing.review));
  const partial = loadBridgeConfig({ env: { CODEX_CLAUDE_CONFIG: writeConfig({ schemaVersion: 1, routing: { review: { family: "codex" } } }) } });
  assert.deepEqual(partial.config, { ...DEFAULT_BRIDGE_CONFIG, routing: { review: { family: "codex" } } });
});

test("the config schema is a strict Draft 2020-12 contract aligned with the profile and preset tables", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "schemas", "bridge-config.schema.json"), "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.schemaVersion, { const: 1 });
  assert.deepEqual(schema.properties.defaults.properties.profile.enum, Object.keys(BRIDGE_PROFILES).filter((name) => name !== "sandbox-autonomous"));
  assert.deepEqual(schema.properties.presets.propertyNames.enum, Object.keys(BRIDGE_AGENT_PRESETS));
  assert.deepEqual(schema.properties.defaults.properties.overagePolicy.enum, ["stop"]);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  assert.equal(ajv.compile(schema)(exampleConfig()), true);
  assert.equal(validateBridgeConfigContract(exampleConfig()).schemaVersion, 1);
});

test("invalid config files fail closed with stable error codes", () => {
  const cases = [
    ["{not json", "config_invalid_json"],
    [{ schemaVersion: 2 }, "config_invalid"],
    [{ schemaVersion: 1, unknown: true }, "config_invalid"],
    [{ schemaVersion: 1, defaults: { profile: "sandbox-autonomous" } }, "config_invalid"],
    [{ schemaVersion: 1, defaults: { profile: "unshackled" } }, "config_invalid"],
    [{ schemaVersion: 1, defaults: { overagePolicy: "continue" } }, "config_invalid"],
    [{ schemaVersion: 1, defaults: { maxRepairs: 4 } }, "config_invalid"],
    [{ schemaVersion: 1, defaults: { workerFamily: "gemini" } }, "config_invalid"],
    [{ schemaVersion: 1, reviewLanePolicy: "trusted-autonomous" }, "config_invalid"],
    [{ schemaVersion: 1, presets: { "made-up-preset": { profile: "host" } } }, "config_invalid"],
    [{ schemaVersion: 1, routing: { review: {} } }, "config_invalid"],
    [{ schemaVersion: 1, routing: { review: { family: "codex", extra: 1 } } }, "config_invalid"],
    [{ schemaVersion: 1, routing: { "has spaces": { family: "codex" } } }, "config_invalid"],
    [{ schemaVersion: 1, extensions: ["relative/extension.mjs"] }, "config_invalid"],
    [[], "config_invalid"]
  ];
  for (const [document, code] of cases) {
    const file = writeConfig(document);
    assert.throws(
      () => loadBridgeConfig({ env: { CODEX_CLAUDE_CONFIG: file } }),
      (error) => error instanceof BridgeConfigError && error.code === code && error.path === file,
      JSON.stringify(document)
    );
  }
  const directory = tempDir();
  assert.throws(
    () => loadBridgeConfig({ env: { CODEX_CLAUDE_CONFIG: directory } }),
    (error) => error instanceof BridgeConfigError && error.code === "config_unreadable"
  );
});

test("routing resolves through the config table, then extensions, else the host", async () => {
  const config = exampleConfig();
  const fromConfig = await resolveRouting(config, [], { request: null, taskFamily: "review" });
  assert.deepEqual(fromConfig, { family: "codex", model: null, effort: "high", source: "config", reason: "config routing.review", warnings: [] });
  assert.ok(Object.isFrozen(fromConfig));

  const host = await resolveRouting(config, [], { request: null, taskFamily: "unlisted" });
  assert.deepEqual(host, { family: null, model: null, effort: null, source: "host", reason: "No routing rule; the host configuration decides model and effort.", warnings: [] });
  assert.deepEqual(await resolveRouting(DEFAULT_BRIDGE_CONFIG, [], { request: null, taskFamily: null }), host);

  const extensions = await extensionWith(`export default { apiVersion: 1, name: "router",
    resolveRouting({ taskFamily, available }) {
      if (taskFamily !== "review") return null;
      return { model: "model-b", effort: "medium", reason: "cheaper reviewer" };
    } };`);
  const overridden = await resolveRouting(config, extensions, { request: null, taskFamily: "review", available: { codex: { models: CODEX_MODELS } } });
  assert.deepEqual(overridden, { family: "codex", model: "model-b", effort: "medium", source: "extension", reason: "router: cheaper reviewer", warnings: [] });

  const declined = await resolveRouting(config, extensions, { request: null, taskFamily: "other" });
  assert.equal(declined.source, "host");
});

test("an extension routing failure fails the job before launch", async () => {
  for (const source of [
    `export default { apiVersion: 1, name: "thrower", resolveRouting() { throw new Error("routing table offline"); } };`,
    `export default { apiVersion: 1, name: "no-reason", resolveRouting() { return { model: "m" }; } };`,
    `export default { apiVersion: 1, name: "bad-family", resolveRouting() { return { family: "gemini", reason: "x" }; } };`,
    `export default { apiVersion: 1, name: "extra-key", resolveRouting() { return { model: "m", sandbox: "read-only", reason: "x" }; } };`
  ]) {
    const extensions = await extensionWith(source);
    await assert.rejects(
      resolveRouting(exampleConfig(), extensions, { request: null, taskFamily: "review" }),
      (error) => error.name === "BridgeExtensionError" && error.reason === "extension-routing-failed",
      source
    );
  }
});

test("a routed Codex effort outside the model's supported efforts is dropped with a warning", async () => {
  const config = { ...DEFAULT_BRIDGE_CONFIG, routing: { review: { family: "codex", model: "model-b", effort: "high" }, plain: { family: "codex", effort: "xhigh" }, ok: { family: "codex", effort: "low" } } };
  const available = { codex: { models: CODEX_MODELS } };
  const dropped = await resolveRouting(config, [], { request: null, taskFamily: "review", available });
  assert.equal(dropped.effort, null);
  assert.equal(dropped.model, "model-b");
  assert.deepEqual(dropped.warnings, [{ code: "effort-unsupported", model: "model-b", effort: "high", supported: ["medium"] }]);
  const defaultModel = await resolveRouting(config, [], { request: null, taskFamily: "plain", available });
  assert.equal(defaultModel.effort, null);
  assert.deepEqual(defaultModel.warnings, [{ code: "effort-unsupported", model: "model-a", effort: "xhigh", supported: ["low", "high"] }]);
  const kept = await resolveRouting(config, [], { request: null, taskFamily: "ok", available });
  assert.equal(kept.effort, "low");
  assert.deepEqual(kept.warnings, []);
  const undiscovered = await resolveRouting(config, [], { request: null, taskFamily: "review" });
  assert.equal(undiscovered.effort, "high", "without live discovery the routed effort is kept");
});
