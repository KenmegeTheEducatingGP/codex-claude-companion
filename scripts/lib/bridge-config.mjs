// The optional user config file and the routing resolver.
//
// The file lives at $CODEX_CLAUDE_CONFIG, else $XDG_CONFIG_HOME/codex-claude/config.json,
// else ~/.config/codex-claude/config.json, and follows schemas/bridge-config.schema.json.
// A missing file changes nothing: every key has a built-in default.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BridgeContractValidationError, validateBridgeConfigContract } from "./bridge-contracts.mjs";
import { BridgeExtensionError } from "./bridge-extensions.mjs";
import { BRIDGE_FAMILIES } from "./bridge-policy.mjs";

const ROUTING_ANSWER_KEYS = Object.freeze(["family", "model", "effort", "reason"]);
const HOST_REASON = "No routing rule; the host configuration decides model and effort.";

export class BridgeConfigError extends Error {
  constructor(code, message, { path: file = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BridgeConfigError";
    this.code = code;
    this.path = file;
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** The configuration in effect when no config file exists. */
export const DEFAULT_BRIDGE_CONFIG = deepFreeze({
  schemaVersion: 1,
  defaults: {},
  reviewLanePolicy: null,
  presets: {},
  routing: {},
  extensions: []
});

/**
 * Where the config file is read from. A relative XDG_CONFIG_HOME is ignored, as the
 * XDG Base Directory specification requires.
 */
export function resolveBridgeConfigPath(env = process.env) {
  const explicit = env.CODEX_CLAUDE_CONFIG;
  if (explicit !== undefined && explicit !== "") {
    if (!path.isAbsolute(explicit)) {
      throw new BridgeConfigError("config_path_not_absolute", "CODEX_CLAUDE_CONFIG must be an absolute path.", { path: explicit });
    }
    return explicit;
  }
  const xdg = env.XDG_CONFIG_HOME;
  if (typeof xdg === "string" && path.isAbsolute(xdg)) return path.join(xdg, "codex-claude", "config.json");
  const home = typeof env.HOME === "string" && path.isAbsolute(env.HOME) ? env.HOME : os.homedir();
  return path.join(home, ".config", "codex-claude", "config.json");
}

/**
 * Read, validate and normalize the config file. Fails closed with a stable `code`:
 * config_path_not_absolute, config_unreadable, config_invalid_json or config_invalid.
 *
 * @returns {{path: string, exists: boolean, config: object}} with a deep-frozen config
 */
export function loadBridgeConfig({ env = process.env } = {}) {
  const file = resolveBridgeConfigPath(env);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (cause) {
    if (cause?.code === "ENOENT") return { path: file, exists: false, config: DEFAULT_BRIDGE_CONFIG };
    throw new BridgeConfigError("config_unreadable", `The bridge config file could not be read: ${cause.message}`, { path: file, cause });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new BridgeConfigError("config_invalid_json", `The bridge config file is not valid JSON: ${cause.message}`, { path: file, cause });
  }
  try {
    validateBridgeConfigContract(parsed);
  } catch (cause) {
    if (!(cause instanceof BridgeContractValidationError)) throw cause;
    throw new BridgeConfigError("config_invalid", `The bridge config file is invalid: ${cause.message}`, { path: file, cause });
  }
  return { path: file, exists: true, config: deepFreeze({ ...structuredClone(DEFAULT_BRIDGE_CONFIG), ...parsed }) };
}

function routingFailed(extension, detail, cause) {
  return new BridgeExtensionError(
    "extension-routing-failed",
    `Extension "${extension}" resolveRouting ${detail}`,
    { extension, cause }
  );
}

function validateRoutingAnswer(extension, answer) {
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) {
    throw routingFailed(extension, "must return null or { family?, model?, effort?, reason }.");
  }
  const extra = Object.keys(answer).filter((key) => !ROUTING_ANSWER_KEYS.includes(key));
  if (extra.length > 0) throw routingFailed(extension, `returned unknown keys: ${extra.join(", ")}.`);
  if (typeof answer.reason !== "string" || answer.reason.trim() === "") throw routingFailed(extension, "must give a reason.");
  if (Object.hasOwn(answer, "family") && answer.family !== null && !BRIDGE_FAMILIES.includes(answer.family)) {
    throw routingFailed(extension, `returned an unknown family; expected one of ${BRIDGE_FAMILIES.join(", ")}.`);
  }
  for (const key of ["model", "effort"]) {
    if (Object.hasOwn(answer, key) && answer[key] !== null && (typeof answer[key] !== "string" || answer[key].trim() === "")) {
      throw routingFailed(extension, `must give ${key} as a non-empty string or null.`);
    }
  }
  return answer;
}

// A routed Codex effort the model does not support is dropped, with a warning, when
// live discovery (model/list) is available. Without discovery the effort is kept.
function checkCodexEffort(routing, family, available) {
  const models = available?.codex?.models;
  if (family !== "codex" || routing.effort === null || !Array.isArray(models)) return routing;
  const entry = routing.model === null
    ? models.find((candidate) => candidate?.isDefault === true)
    : models.find((candidate) => candidate?.id === routing.model || candidate?.model === routing.model);
  if (!entry || !Array.isArray(entry.supportedReasoningEfforts)) return routing;
  const supported = entry.supportedReasoningEfforts.map((option) => option?.reasoningEffort).filter((effort) => typeof effort === "string");
  if (supported.includes(routing.effort)) return routing;
  return {
    ...routing,
    effort: null,
    warnings: [
      ...routing.warnings,
      { code: "effort-unsupported", model: routing.model ?? entry.model ?? entry.id ?? null, effort: routing.effort, supported }
    ]
  };
}

/**
 * Resolve routing for one delegation: the config `routing` table for the task family,
 * then each extension's resolveRouting in order (the first non-null answer overrides,
 * key by key), else the host decides. An extension that throws or answers badly fails
 * the job before launch with `extension-routing-failed`.
 *
 * @param {object} config a loaded config (DEFAULT_BRIDGE_CONFIG when there is no file)
 * @param {ReadonlyArray<object>} extensions loaded extensions
 * @param {{request?: object|null, taskFamily?: string|null, available?: object}} context
 *   `available.codex.models` is the Codex model/list answer, when discovered
 * @returns {Promise<{family, model, effort, source, reason, warnings}>} deep-frozen
 */
export async function resolveRouting(config, extensions, { request = null, taskFamily = null, available } = {}) {
  const table = config?.routing ?? {};
  const rule = typeof taskFamily === "string" && Object.hasOwn(table, taskFamily) ? table[taskFamily] : null;
  let routing = rule
    ? { family: rule.family ?? null, model: rule.model ?? null, effort: rule.effort ?? null, source: "config", reason: `config routing.${taskFamily}`, warnings: [] }
    : { family: null, model: null, effort: null, source: "host", reason: HOST_REASON, warnings: [] };

  for (const extension of extensions) {
    const hook = extension.hooks.resolveRouting;
    if (!hook) continue;
    let answer;
    try {
      answer = await hook({ request, taskFamily, available });
    } catch (cause) {
      throw routingFailed(extension.name, `failed: ${cause?.message ?? String(cause)}`, cause);
    }
    if (answer === null || answer === undefined) continue;
    validateRoutingAnswer(extension.name, answer);
    routing = {
      family: Object.hasOwn(answer, "family") ? answer.family : routing.family,
      model: Object.hasOwn(answer, "model") ? answer.model : routing.model,
      effort: Object.hasOwn(answer, "effort") ? answer.effort : routing.effort,
      source: "extension",
      reason: `${extension.name}: ${answer.reason}`,
      warnings: []
    };
    break;
  }

  const family = routing.family ?? request?.worker?.family ?? null;
  return deepFreeze(checkCodexEffort(routing, family, available));
}
