// Extension API v1: local modules the user names in the config file.
//
// An extension is a module whose default export is an object
// `{ apiVersion: 1, name, ...hooks }`. Extensions carry the same trust as the CLI,
// and loading fails closed: a bad path, a failed import, a wrong apiVersion or an
// unknown key stops the delegation before anything is launched.
//
// An extension is ONE self-contained module. Its sha256 is the integrity signal a
// recovered job compares, so it must cover the code the extension runs. The loader
// imports exactly the bytes it hashed, as a module that has no location of its own:
// a relative or package import fails when the extension loads, and so does a static
// import by absolute file: URL (the one refusal the module system does not make, so
// the loader makes it from the source: it tokenizes the module, so import-like text in
// a string, a template or a comment is skipped and a comment inside an import does not
// hide it; see bridge-module-imports.mjs). Only node: modules can be imported by name.
// What no loader can refuse stays outside the digest: a dynamic import() and any
// other way an extension reads and runs other files. An extension that does that
// owns the drift.

import crypto from "node:crypto";
import fs from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { staticImportSpecifiers } from "./bridge-module-imports.mjs";

export const BRIDGE_EXTENSION_API_VERSION = 1;

/** The hooks an extension may define, in the order the bridge documents them. */
export const BRIDGE_EXTENSION_HOOKS = Object.freeze(["resolveRouting", "validateResolvedModel", "selectAccount", "gates", "observe"]);

// The only environment an extension may hand to a worker: which account home it uses.
const ACCOUNT_ENV_KEYS = Object.freeze(["CLAUDE_CONFIG_DIR", "CODEX_HOME"]);
const GATE_KEYS = Object.freeze(["name", "argv", "cwd", "timeoutSeconds"]);
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const DEFAULT_OBSERVE_TIMEOUT_MS = 5_000;

export class BridgeExtensionError extends Error {
  constructor(reason, message, { extension = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BridgeExtensionError";
    this.reason = reason;
    this.extension = extension;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function loadFailed(message, cause) {
  return new BridgeExtensionError("extension-load-failed", message, { cause });
}

function validateDefinition(file, definition) {
  if (!isPlainObject(definition)) {
    throw loadFailed(`Extension ${file} has no default export object.`);
  }
  if (definition.apiVersion !== BRIDGE_EXTENSION_API_VERSION) {
    throw loadFailed(`Extension ${file} declares apiVersion ${JSON.stringify(definition.apiVersion)}; this bridge supports apiVersion ${BRIDGE_EXTENSION_API_VERSION}.`);
  }
  if (typeof definition.name !== "string" || !NAME_PATTERN.test(definition.name)) {
    throw loadFailed(`Extension ${file} needs a name of 1-64 letters, digits, ".", "_", ":" or "-", starting with a letter or digit.`);
  }
  for (const key of Object.keys(definition)) {
    if (key === "apiVersion" || key === "name") continue;
    if (!BRIDGE_EXTENSION_HOOKS.includes(key)) {
      throw loadFailed(`Extension "${definition.name}" has unknown key "${key}"; the hooks are ${BRIDGE_EXTENSION_HOOKS.join(", ")}.`);
    }
    if (typeof definition[key] !== "function") {
      throw loadFailed(`Extension "${definition.name}" hook ${key} must be a function.`);
    }
  }
}

// staticImportSpecifiers lists an extension's static imports and re-exports, in source order, from
// the module's tokens: a commented-out import and import-like text inside a string or a template
// are skipped, and a dynamic import() is not listed. It words messages, and it backs the one
// refusal the module system does not make itself (an absolute file: URL, see loadOne).

function selfContainedViolation(file, specifier) {
  return `Extension ${file} imports ${JSON.stringify(specifier)}; ` +
    "an extension must be one self-contained module (import only node: modules), so its digest covers all the code it runs.";
}

/**
 * The message for a failed import. Node refuses a local or package import from the module the
 * loader builds, and words it by version: 20 and later name the specifier and quote the whole
 * encoded module (ERR_UNSUPPORTED_RESOLVE_REQUEST), 18 says only "Invalid URL" (ERR_INVALID_URL).
 * A refused import is worded from Node's text when that names the specifier and from the
 * extension's own source when it does not, so the message names the import and the rule on every
 * supported Node. Exported for the tests.
 */
export function describeExtensionImportFailure(file, source, cause) {
  const message = cause?.message ?? String(cause);
  const refused = cause?.code === "ERR_UNSUPPORTED_RESOLVE_REQUEST" || cause?.code === "ERR_INVALID_URL";
  if (!refused) return `Extension ${file} failed to import: ${message}`;
  const specifier = /Failed to resolve module specifier "([^"]+)"/.exec(message)?.[1] ??
    staticImportSpecifiers(source).find((candidate) => !isBuiltin(candidate));
  if (specifier === undefined) {
    const shown = message.replace(/data:[^"'\s]+/g, "<module>").slice(0, 200);
    return `Extension ${file} failed to import: ${shown} (an extension must be one self-contained module; only node: modules may be imported)`;
  }
  return selfContainedViolation(file, specifier);
}

async function loadOne(file) {
  if (typeof file !== "string" || !path.isAbsolute(file)) {
    throw loadFailed(`Extension path ${JSON.stringify(file)} must be an absolute path.`);
  }
  let source;
  try {
    source = fs.readFileSync(file);
  } catch (cause) {
    throw loadFailed(`Extension ${file} could not be read: ${cause.message}`, cause);
  }
  const sha256 = crypto.createHash("sha256").update(source).digest("hex");
  // The module system refuses a relative or package import from the module built below, but it
  // loads an import by absolute file: URL, which would put a helper outside the digest.
  const fileImport = staticImportSpecifiers(source).find((specifier) => /^file:/i.test(specifier));
  if (fileImport !== undefined) throw loadFailed(selfContainedViolation(file, fileImport));
  let module;
  try {
    // Import the bytes that were hashed, never the file again, so the digest identifies the code
    // that runs and changed content is a new module rather than a cached one. The sourceURL
    // comment keeps an error's stack naming the extension's own file.
    const code = Buffer.concat([source, Buffer.from(`\n//# sourceURL=${pathToFileURL(file).href}\n`)]);
    module = await import(`data:text/javascript;base64,${code.toString("base64")}`);
  } catch (cause) {
    throw loadFailed(describeExtensionImportFailure(file, source, cause), cause);
  }
  const definition = module.default;
  validateDefinition(file, definition);
  const hooks = {};
  for (const hook of BRIDGE_EXTENSION_HOOKS) {
    if (typeof definition[hook] === "function") hooks[hook] = definition[hook].bind(definition);
  }
  return Object.freeze({ name: definition.name, path: file, sha256, hooks: Object.freeze(hooks) });
}

/**
 * Load extensions in order. Fails closed with reason `extension-load-failed`.
 *
 * @param {string[]} paths absolute module paths
 * @returns {Promise<ReadonlyArray<{name: string, path: string, sha256: string, hooks: object}>>}
 */
export async function loadBridgeExtensions(paths) {
  if (!Array.isArray(paths)) throw loadFailed("Extensions must be given as an array of absolute paths.");
  const extensions = [];
  for (const file of paths) {
    const extension = await loadOne(file);
    if (extensions.some((loaded) => loaded.name === extension.name)) {
      throw loadFailed(`Extension name "${extension.name}" is a duplicate (${file}).`);
    }
    extensions.push(extension);
  }
  return Object.freeze(extensions);
}

/** The digest descriptor a v2 receipt keeps for each loaded extension: its name and sha256, never a local path. */
export function describeBridgeExtensions(extensions) {
  return extensions.map(({ name, sha256 }) => ({ name, sha256 }));
}

/** The record a broker keeps to re-import its extensions for a recovered job: name, path and sha256. */
export function recordBridgeExtensions(extensions) {
  return extensions.map(({ name, path: file, sha256 }) => ({ name, path: file, sha256 }));
}

/**
 * Re-import recorded extensions (the records `recordBridgeExtensions` makes), for a
 * recovered job. A changed file is imported afresh and reported in `changed`, so the
 * caller can record it as an event.
 */
export async function reloadBridgeExtensions(recorded) {
  if (!Array.isArray(recorded) || recorded.some((entry) => !isPlainObject(entry))) {
    throw loadFailed("Recorded extensions must be an array of { name, path, sha256 } records.");
  }
  const extensions = await loadBridgeExtensions(recorded.map((entry) => entry.path));
  const changed = recorded
    .map((entry, index) => ({ entry, current: extensions[index] }))
    .filter(({ entry, current }) => entry.sha256 !== current.sha256)
    .map(({ entry, current }) => ({ name: entry.name, path: entry.path, recordedSha256: entry.sha256, currentSha256: current.sha256 }));
  return { extensions, changed };
}

function accountInvalid(extension, detail) {
  return new BridgeExtensionError(
    "extension-account-invalid",
    `Extension "${extension}" selectAccount ${detail}`,
    { extension }
  );
}

// Error messages name keys and never echo values: an answer may carry credentials.
function validateAccount(extension, answer) {
  if (!isPlainObject(answer)) throw accountInvalid(extension, "must return null or { env, label }.");
  const extra = Object.keys(answer).filter((key) => key !== "env" && key !== "label");
  if (extra.length > 0) throw accountInvalid(extension, `returned unknown keys: ${extra.join(", ")}.`);
  if (typeof answer.label !== "string" || answer.label.trim() === "") throw accountInvalid(extension, "must return a non-empty label.");
  if (!isPlainObject(answer.env) || Object.keys(answer.env).length === 0) {
    throw accountInvalid(extension, `must return env with ${ACCOUNT_ENV_KEYS.join(" or ")}.`);
  }
  for (const [key, value] of Object.entries(answer.env)) {
    if (!ACCOUNT_ENV_KEYS.includes(key)) {
      throw accountInvalid(extension, `may set only ${ACCOUNT_ENV_KEYS.join(" and ")}; it returned ${key}.`);
    }
    if (typeof value !== "string" || !path.isAbsolute(value)) {
      throw accountInvalid(extension, `must give ${key} as an absolute path.`);
    }
  }
  return { env: { ...answer.env }, label: answer.label, extension };
}

/**
 * Ask extensions, in order, for another account home. The first non-null answer wins.
 *
 * @returns {Promise<{env: object, label: string, extension: string} | null>}
 */
export async function selectExtensionAccount(extensions, { family, request, rateLimit }) {
  for (const extension of extensions) {
    const hook = extension.hooks.selectAccount;
    if (!hook) continue;
    let answer;
    try {
      answer = await hook({ family, request, rateLimit });
    } catch (cause) {
      throw new BridgeExtensionError(
        "extension-account-invalid",
        `Extension "${extension.name}" selectAccount failed: ${cause?.message ?? String(cause)}`,
        { extension: extension.name, cause }
      );
    }
    if (answer === null || answer === undefined) continue;
    return validateAccount(extension.name, answer);
  }
  return null;
}

/**
 * Check a resolved model with every extension. Fails closed: a refusal, a throw or a
 * malformed answer gives `{ ok: false, reason, extension }`.
 */
export async function checkResolvedModel(extensions, { family, model, phase }) {
  for (const extension of extensions) {
    const hook = extension.hooks.validateResolvedModel;
    if (!hook) continue;
    let answer;
    try {
      answer = await hook({ family, model, phase });
    } catch (cause) {
      return { ok: false, reason: `validateResolvedModel failed: ${cause?.message ?? String(cause)}`, extension: extension.name };
    }
    if (!isPlainObject(answer) || typeof answer.ok !== "boolean") {
      return { ok: false, reason: "validateResolvedModel returned a malformed answer.", extension: extension.name };
    }
    if (!answer.ok) {
      const reason = typeof answer.reason === "string" && answer.reason.trim() !== "" ? answer.reason : "Refused by the extension.";
      return { ok: false, reason, extension: extension.name };
    }
  }
  return { ok: true };
}

function gateInvalid(extension, detail, cause) {
  return new BridgeExtensionError("extension-gate-invalid", `Extension "${extension}" gates ${detail}`, { extension, cause });
}

function validateGate(extension, gate, index) {
  const label = `[${index}]`;
  if (!isPlainObject(gate)) throw gateInvalid(extension, `${label} must be an object.`);
  const extra = Object.keys(gate).filter((key) => !GATE_KEYS.includes(key));
  if (extra.length > 0) throw gateInvalid(extension, `${label} has unknown keys: ${extra.join(", ")}.`);
  if (typeof gate.name !== "string" || gate.name.trim() === "") throw gateInvalid(extension, `${label} needs a non-empty name.`);
  if (!Array.isArray(gate.argv) || gate.argv.length === 0 || gate.argv.some((part) => typeof part !== "string" || part === "")) {
    throw gateInvalid(extension, `${label} needs argv as a non-empty array of non-empty strings.`);
  }
  if (typeof gate.cwd !== "string" || !path.isAbsolute(gate.cwd)) throw gateInvalid(extension, `${label} needs an absolute cwd.`);
  if (!Number.isInteger(gate.timeoutSeconds) || gate.timeoutSeconds < 1) {
    throw gateInvalid(extension, `${label} needs timeoutSeconds as a positive integer.`);
  }
  return { name: gate.name, argv: [...gate.argv], cwd: gate.cwd, timeoutSeconds: gate.timeoutSeconds, extension };
}

/**
 * Collect the extra verification checks extensions require. Each gate is a required
 * check; an invalid gate or a throwing hook fails with `extension-gate-invalid`.
 */
export async function collectExtensionGates(extensions, { request, result, workspace }) {
  const gates = [];
  for (const extension of extensions) {
    const hook = extension.hooks.gates;
    if (!hook) continue;
    let answer;
    try {
      answer = await hook({ request, result, workspace });
    } catch (cause) {
      throw gateInvalid(extension.name, `failed: ${cause?.message ?? String(cause)}`, cause);
    }
    if (!Array.isArray(answer)) throw gateInvalid(extension.name, "must return an array.");
    answer.forEach((gate, index) => gates.push(validateGate(extension.name, gate, index)));
  }
  return gates;
}

/**
 * Tell every observer about an event. Best effort: a throw, a rejection or a timeout
 * is reported to `onError(error, extensionName)` and never propagates.
 */
export async function notifyExtensionObservers(extensions, event, { onError, timeoutMs = DEFAULT_OBSERVE_TIMEOUT_MS } = {}) {
  for (const extension of extensions) {
    const hook = extension.hooks.observe;
    if (!hook) continue;
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        // Not unref'd: while an observer is pending this timer is the only thing that can end the
        // wait. An unref'd timer lets Node exit mid-await when nothing else is alive. `finally`
        // clears it as soon as the race settles, so it never outlives a finished observer.
        timer = setTimeout(() => reject(new Error(`observe did not finish within ${timeoutMs} ms`)), timeoutMs);
      });
      await Promise.race([Promise.resolve().then(() => hook(event)), timeout]);
    } catch (error) {
      try {
        onError?.(error, extension.name);
      } catch {
        // The error reporter is best effort too.
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
