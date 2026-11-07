import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  BRIDGE_EXTENSION_API_VERSION,
  BRIDGE_EXTENSION_HOOKS,
  BridgeExtensionError,
  checkResolvedModel,
  collectExtensionGates,
  describeBridgeExtensions,
  loadBridgeExtensions,
  notifyExtensionObservers,
  recordBridgeExtensions,
  reloadBridgeExtensions,
  selectExtensionAccount
} from "../scripts/lib/bridge-extensions.mjs";
import * as bridgeExtensions from "../scripts/lib/bridge-extensions.mjs";

function writeExtension(source, name = "extension.mjs") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ext-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, source);
  return file;
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function loadFailure(detail) {
  return (error) => error instanceof BridgeExtensionError && error.reason === "extension-load-failed" &&
    (detail === undefined || detail.test(error.message));
}

test("extension API v1 names exactly five hooks", () => {
  assert.equal(BRIDGE_EXTENSION_API_VERSION, 1);
  assert.deepEqual(BRIDGE_EXTENSION_HOOKS, ["resolveRouting", "validateResolvedModel", "selectAccount", "gates", "observe"]);
  assert.ok(Object.isFrozen(BRIDGE_EXTENSION_HOOKS));
});

test("an extension loads from an absolute path with its sha256 recorded", async () => {
  const file = writeExtension(`export default { apiVersion: 1, name: "example", observe() {} };`);
  const [extension, ...rest] = await loadBridgeExtensions([file]);
  assert.equal(rest.length, 0);
  assert.equal(extension.name, "example");
  assert.equal(extension.path, file);
  assert.equal(extension.sha256, sha256File(file));
  assert.equal(typeof extension.hooks.observe, "function");
  assert.ok(Object.isFrozen(extension) && Object.isFrozen(extension.hooks));
  assert.deepEqual(recordBridgeExtensions([extension]), [{ name: "example", path: file, sha256: sha256File(file) }]);
  assert.deepEqual(describeBridgeExtensions([extension]), [{ name: "example", sha256: sha256File(file) }], "a receipt keeps the name and digest, never a local path");
  assert.deepEqual(await loadBridgeExtensions([]), []);
});

test("extension loading fails closed with extension-load-failed", async () => {
  const cases = [
    ["relative path", "relative/extension.mjs", /absolute/],
    ["missing file", path.join(os.tmpdir(), "definitely-missing-bridge-extension.mjs"), /missing|ENOENT|no such file/i],
    ["import throws", writeExtension(`throw new Error("boom at import");`), /boom at import/],
    ["syntax error", writeExtension(`export default {`), undefined],
    ["no default export", writeExtension(`export const name = "x";`), /default export/],
    ["wrong apiVersion", writeExtension(`export default { apiVersion: 2, name: "future" };`), /apiVersion/],
    ["missing name", writeExtension(`export default { apiVersion: 1 };`), /name/],
    ["hook is not a function", writeExtension(`export default { apiVersion: 1, name: "x", gates: [] };`), /gates/],
    ["unknown hook (typo)", writeExtension(`export default { apiVersion: 1, name: "x", gate() { return []; } };`), /gate/]
  ];
  for (const [label, file, detail] of cases) {
    await assert.rejects(loadBridgeExtensions([file]), loadFailure(detail), label);
  }
  const one = writeExtension(`export default { apiVersion: 1, name: "same" };`, "a.mjs");
  const two = writeExtension(`export default { apiVersion: 1, name: "same" };`, "b.mjs");
  await assert.rejects(loadBridgeExtensions([one, two]), loadFailure(/duplicate/i));
  await assert.rejects(loadBridgeExtensions("not-an-array"), loadFailure());
});

test("a recovered job re-imports its extensions and reports a changed digest", async () => {
  const file = writeExtension(`export default { apiVersion: 1, name: "drift" };`);
  const recorded = recordBridgeExtensions(await loadBridgeExtensions([file]));
  const unchanged = await reloadBridgeExtensions(recorded);
  assert.deepEqual(unchanged.changed, []);
  fs.writeFileSync(file, `export default { apiVersion: 1, name: "drift", observe() {} };`);
  const reloaded = await reloadBridgeExtensions(recorded);
  assert.equal(typeof reloaded.extensions[0].hooks.observe, "function", "the new content is imported, not a cached module");
  assert.deepEqual(reloaded.changed, [{ name: "drift", path: file, recordedSha256: recorded[0].sha256, currentSha256: sha256File(file) }]);
});

// The digest is the recovery integrity signal, so it must cover all the code an
// extension runs. An extension is therefore one self-contained module: the loader
// executes exactly the bytes it hashed, and a relative or package import fails closed
// at load instead of leaving a helper outside the digest.
test("an extension is one self-contained module, so its digest covers all the code it runs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ext-split-"));
  fs.writeFileSync(path.join(dir, "helper.mjs"), `export const helper = () => "v1";`);
  const split = path.join(dir, "extension.mjs");
  fs.writeFileSync(split, `import { helper } from "./helper.mjs";\nexport default { apiVersion: 1, name: "split", observe() { helper(); } };`);
  await assert.rejects(loadBridgeExtensions([split]), (error) =>
    loadFailure(/self-contained/)(error) && error.message.includes("./helper.mjs") && error.message.length < 600,
  "a local import is refused, and the message names the import rather than echoing an encoded module");

  const builtin = writeExtension(`import path from "node:path";\nexport default { apiVersion: 1, name: "builtin", observe() { return path.sep; } };`);
  const [loaded] = await loadBridgeExtensions([builtin]);
  assert.equal(loaded.name, "builtin", "node: modules are part of the runtime, not of the extension");

  const lazy = path.join(dir, "lazy.mjs");
  fs.writeFileSync(lazy, `export default { apiVersion: 1, name: "lazy", async observe() { return (await import("./helper.mjs")).helper(); } };`);
  const [lazyLoaded] = await loadBridgeExtensions([lazy]);
  // The error is Node's own and its text differs by version (20 and later name the specifier, 18
  // reports a bare "Invalid URL"), so this pins what Node refused, not how it words it.
  await assert.rejects(Promise.resolve().then(() => lazyLoaded.hooks.observe({})),
    (error) => ["ERR_UNSUPPORTED_RESOLVE_REQUEST", "ERR_INVALID_URL"].includes(error?.code),
    "a lazy local import fails when it runs, never silently");
});

// Node words a refused local import differently by version: 20 and later name the specifier and
// quote the whole encoded module as its base (ERR_UNSUPPORTED_RESOLVE_REQUEST), 18 reports a bare
// "Invalid URL" (ERR_INVALID_URL). The loader's message names the import either way: from Node's
// text when that has the specifier, from the extension's own source when it does not.
test("the message for a refused import names the import whichever way this Node reports it", () => {
  const describe = bridgeExtensions.describeExtensionImportFailure;
  assert.equal(typeof describe, "function", "the loader exports the function that words the message");
  const file = "/extensions/router.mjs";
  const namesIt = Object.assign(new Error(`Failed to resolve module specifier "./helper.mjs" from "data:text/javascript;base64,${"QUJD".repeat(400)}": Invalid relative URL or base scheme is not hierarchical.`), { code: "ERR_UNSUPPORTED_RESOLVE_REQUEST" });
  const bare = Object.assign(new TypeError("Invalid URL"), { code: "ERR_INVALID_URL" });
  const forms = {
    "a named import": `import { helper } from "./helper.mjs";\nexport default {};`,
    "a default import in single quotes": `import helper from './helper.mjs';\nexport default {};`,
    "a namespace import": `import * as helper from "./helper.mjs";\nexport default {};`,
    "a side-effect import": `import "./helper.mjs";\nexport default {};`,
    "a re-export": `export { helper } from "./helper.mjs";\nexport default {};`,
    "a multi-line import": `import {\n  helper,\n  other\n} from "./helper.mjs";\nexport default {};`,
    "an import after node: and bare built-in imports": `import path from "node:path";\nimport fs from "fs";\nimport { helper } from "./helper.mjs";\nexport default { path, fs };`,
    "an import after a commented-out one": `// import { nope } from "./not-this.mjs";\nimport { helper } from "./helper.mjs";\nexport default {};`
  };
  for (const [label, source] of Object.entries(forms)) {
    const message = describe(file, Buffer.from(source), bare);
    assert.ok(message.includes(`"./helper.mjs"`), `${label}: names the import, got: ${message}`);
    assert.match(message, /self-contained/, label);
    assert.ok(message.length < 600, `${label}: stays short`);
  }
  const fromNode = describe(file, Buffer.from(`export default {};`), namesIt);
  assert.ok(fromNode.includes(`"./helper.mjs"`) && /self-contained/.test(fromNode) && fromNode.length < 600,
    "a Node that names the specifier is believed, and the encoded module is not echoed");
  const nothingToName = describe(file, Buffer.from(`import path from "node:path";\nexport default { path };`), bare);
  assert.match(nothingToName, /Invalid URL/, "with nothing to name, Node's own text is kept");
  assert.ok(!nothingToName.includes(" imports "), "no specifier is invented");
  assert.match(describe(file, Buffer.from("export default {};"), new Error("boom at import")), /failed to import: boom at import/,
    "any other failure keeps its own message");
});

// Guard, green at base: whatever the loader does with the bytes, an error thrown by
// an extension must still name the extension's file in its stack.
test("an error thrown by an extension names the extension's file in its stack", async () => {
  const file = writeExtension(`export default { apiVersion: 1, name: "boom", observe() { throw new Error("boom from the extension"); } };`);
  const [extension] = await loadBridgeExtensions([file]);
  let stack = "";
  try {
    extension.hooks.observe({});
  } catch (error) {
    stack = String(error.stack);
  }
  assert.match(stack, /boom from the extension/);
  assert.ok(stack.includes(file), `the stack should name ${file}, got:\n${stack.slice(0, 400)}`);
});

test("selectAccount accepts only CLAUDE_CONFIG_DIR and CODEX_HOME as absolute paths", async () => {
  const good = await loadBridgeExtensions([writeExtension(`export default { apiVersion: 1, name: "accounts",
    selectAccount({ family }) { return family === "claude" ? { env: { CLAUDE_CONFIG_DIR: "/accounts/two" }, label: "two" } : null; } };`)]);
  assert.deepEqual(await selectExtensionAccount(good, { family: "claude", request: null, rateLimit: null }), { env: { CLAUDE_CONFIG_DIR: "/accounts/two" }, label: "two", extension: "accounts" });
  assert.equal(await selectExtensionAccount(good, { family: "codex", request: null, rateLimit: null }), null);
  assert.equal(await selectExtensionAccount([], { family: "claude", request: null, rateLimit: null }), null);

  for (const answer of [
    `{ env: { PATH: "/usr/bin" }, label: "x" }`,
    `{ env: { CLAUDE_CONFIG_DIR: "/a", ANTHROPIC_API_KEY: "secret" }, label: "x" }`,
    `{ env: { CODEX_HOME: "relative/home" }, label: "x" }`,
    `{ env: {}, label: "x" }`,
    `{ env: { CODEX_HOME: "/a" } }`,
    `"not an object"`
  ]) {
    const extensions = await loadBridgeExtensions([writeExtension(`export default { apiVersion: 1, name: "bad", selectAccount() { return ${answer}; } };`)]);
    await assert.rejects(
      selectExtensionAccount(extensions, { family: "claude", request: null, rateLimit: null }),
      (error) => error instanceof BridgeExtensionError && error.reason === "extension-account-invalid" && !/secret/.test(error.message),
      answer
    );
  }
});

test("validateResolvedModel fails closed on a refusal or a throw", async () => {
  const allow = await loadBridgeExtensions([writeExtension(`export default { apiVersion: 1, name: "allow", validateResolvedModel() { return { ok: true }; } };`)]);
  assert.deepEqual(await checkResolvedModel(allow, { family: "claude", model: "m", phase: "launch" }), { ok: true });
  assert.deepEqual(await checkResolvedModel([], { family: "claude", model: "m", phase: "launch" }), { ok: true });
  const deny = await loadBridgeExtensions([writeExtension(`export default { apiVersion: 1, name: "deny", validateResolvedModel({ model }) { return { ok: false, reason: "model-not-allowed: " + model }; } };`)]);
  assert.deepEqual(await checkResolvedModel([...allow, ...deny], { family: "codex", model: "m2", phase: "routing" }), { ok: false, reason: "model-not-allowed: m2", extension: "deny" });
  const thrower = await loadBridgeExtensions([writeExtension(`export default { apiVersion: 1, name: "thrower", validateResolvedModel() { throw new Error("allowlist unreadable"); } };`)]);
  const thrown = await checkResolvedModel(thrower, { family: "claude", model: "m", phase: "launch" });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.extension, "thrower");
  assert.match(thrown.reason, /allowlist unreadable/);
  const malformed = await loadBridgeExtensions([writeExtension(`export default { apiVersion: 1, name: "malformed", validateResolvedModel() { return "yes"; } };`)]);
  assert.equal((await checkResolvedModel(malformed, { family: "claude", model: "m", phase: "launch" })).ok, false);
});

test("gates are validated required checks and an invalid gate fails verification setup", async () => {
  const extensions = await loadBridgeExtensions([writeExtension(`export default { apiVersion: 1, name: "gatekeeper",
    gates({ workspace }) { return [{ name: "lint", argv: ["npm", "run", "lint"], cwd: workspace, timeoutSeconds: 120 }]; } };`)]);
  assert.deepEqual(
    await collectExtensionGates(extensions, { request: null, result: null, workspace: "/repo" }),
    [{ name: "lint", argv: ["npm", "run", "lint"], cwd: "/repo", timeoutSeconds: 120, extension: "gatekeeper" }]
  );
  assert.deepEqual(await collectExtensionGates([], { request: null, result: null, workspace: "/repo" }), []);
  for (const gate of [
    `{ name: "x", argv: [], cwd: "/repo", timeoutSeconds: 1 }`,
    `{ name: "x", argv: "npm test", cwd: "/repo", timeoutSeconds: 1 }`,
    `{ name: "x", argv: ["npm"], cwd: "relative", timeoutSeconds: 1 }`,
    `{ name: "x", argv: ["npm"], cwd: "/repo", timeoutSeconds: 0 }`,
    `{ name: "", argv: ["npm"], cwd: "/repo", timeoutSeconds: 1 }`,
    `{ name: "x", argv: ["npm"], cwd: "/repo", timeoutSeconds: 1, shell: true }`
  ]) {
    const bad = await loadBridgeExtensions([writeExtension(`export default { apiVersion: 1, name: "bad", gates() { return [${gate}]; } };`)]);
    await assert.rejects(
      collectExtensionGates(bad, { request: null, result: null, workspace: "/repo" }),
      (error) => error instanceof BridgeExtensionError && error.reason === "extension-gate-invalid",
      gate
    );
  }
  const thrower = await loadBridgeExtensions([writeExtension(`export default { apiVersion: 1, name: "t", gates() { throw new Error("no gates today"); } };`)]);
  await assert.rejects(collectExtensionGates(thrower, { request: null, result: null, workspace: "/repo" }), (error) => error.reason === "extension-gate-invalid");
});

test("observers are best effort: errors are reported, never thrown", async () => {
  const seen = [];
  const extensions = await loadBridgeExtensions([
    writeExtension(`export default { apiVersion: 1, name: "fails", observe() { throw new Error("observer down"); } };`, "a.mjs"),
    writeExtension(`export default { apiVersion: 1, name: "async-fails", async observe() { throw new Error("async down"); } };`, "b.mjs"),
    writeExtension(`export default { apiVersion: 1, name: "records", observe(event) { globalThis.__bridgeObserved = event.type; } };`, "c.mjs")
  ]);
  await notifyExtensionObservers(extensions, { type: "started" }, { onError: (error, extension) => seen.push(`${extension}: ${error.message}`) });
  assert.deepEqual(seen, ["fails: observer down", "async-fails: async down"]);
  assert.equal(globalThis.__bridgeObserved, "started");
  await assert.doesNotReject(notifyExtensionObservers(extensions, { type: "completed" }));
});

test("an observer that never settles is reported as timed out and does not hold the job", async () => {
  const seen = [];
  const extensions = await loadBridgeExtensions([
    writeExtension(`export default { apiVersion: 1, name: "hangs", observe() { return new Promise(() => {}); } };`)
  ]);
  await notifyExtensionObservers(extensions, { type: "started" }, { timeoutMs: 50, onError: (error, extension) => seen.push(`${extension}: ${error.message}`) });
  assert.deepEqual(seen, ["hangs: observe did not finish within 50 ms"]);
});

test("a hung observer is reported as timed out even when nothing else keeps the process alive", () => {
  // In-process, the test runner's own handles can keep the event loop alive and hide the defect
  // (it failed on Linux CI and passed on macOS and Windows), so run the notifier alone in a
  // fresh Node process: the timeout timer is then the only thing that can end the wait.
  const moduleUrl = new URL("../scripts/lib/bridge-extensions.mjs", import.meta.url).href;
  const script = [
    `const { notifyExtensionObservers } = await import(${JSON.stringify(moduleUrl)});`,
    "const seen = [];",
    "await notifyExtensionObservers(",
    '  [{ name: "hangs", hooks: { observe: () => new Promise(() => {}) } }],',
    '  { type: "started" },',
    '  { timeoutMs: 50, onError: (error, extension) => seen.push(extension + ": " + error.message) }',
    ");",
    'console.log("continued " + JSON.stringify(seen));'
  ].join("\n");
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 20_000 });
  assert.equal(run.status, 0, `exit ${run.status}; stderr: ${run.stderr}`);
  assert.equal(run.stdout.trim(), `continued ${JSON.stringify(["hangs: observe did not finish within 50 ms"])}`);
});
