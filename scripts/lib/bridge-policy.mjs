import fs from "node:fs";
import path from "node:path";

import {
  AGENTIC_ALLOWED_TOOLS,
  AGENTIC_DISALLOWED_TOOLS,
  AGENTIC_TOOLS,
  buildWebFetchAllowlist
} from "./claude.mjs";

const READONLY_PERMISSION_ARGS = Object.freeze([
  "--setting-sources=",
  "--tools", ...AGENTIC_TOOLS,
  "--allowedTools", ...AGENTIC_ALLOWED_TOOLS, ...buildWebFetchAllowlist(),
  "--disallowedTools", ...AGENTIC_DISALLOWED_TOOLS,
  "--permission-mode", "default",
  "--strict-mcp-config"
]);

const STANDARD_PERMISSION_ARGS = Object.freeze(["--permission-mode", "default"]);
const AUTONOMOUS_PERMISSION_ARGS = Object.freeze(["--permission-mode", "bypassPermissions"]);

// Codex thread parameters. These are the only places the bridge names a Codex sandbox
// or approval value; every other path omits the keys so the host configuration decides.
const CODEX_READONLY_PARAMS = Object.freeze({ sandbox: "read-only" });
const CODEX_AUTONOMOUS_PARAMS = Object.freeze({ sandbox: "danger-full-access", approvalPolicy: "never" });

const SANDBOX_UNAVAILABLE = "executor-owned provenance verification is not implemented";

/** Worker and verifier families a schemaVersion 2 request can name. */
export const BRIDGE_FAMILIES = Object.freeze(["claude", "codex"]);

/**
 * The schemaVersion 2 profile table. `claudeArgs` are the exact Claude argv, `codexParams`
 * the exact Codex thread parameters (null where the profile is not available for Codex),
 * and `permissionMode` the Claude permission mode the profile sets (null for host).
 * `host` passes nothing, so the host configuration decides.
 */
export const BRIDGE_PROFILES = Object.freeze({
  host: Object.freeze({
    permissionMode: null,
    claudeArgs: Object.freeze([]),
    codexParams: Object.freeze({})
  }),
  "review-readonly": Object.freeze({
    permissionMode: "default",
    claudeArgs: READONLY_PERMISSION_ARGS,
    codexParams: CODEX_READONLY_PARAMS
  }),
  standard: Object.freeze({
    permissionMode: "default",
    claudeArgs: STANDARD_PERMISSION_ARGS,
    codexParams: null
  }),
  "trusted-autonomous": Object.freeze({
    permissionMode: "bypassPermissions",
    claudeArgs: AUTONOMOUS_PERMISSION_ARGS,
    codexParams: CODEX_AUTONOMOUS_PARAMS
  }),
  "sandbox-autonomous": Object.freeze({
    permissionMode: "bypassPermissions",
    claudeArgs: AUTONOMOUS_PERMISSION_ARGS,
    codexParams: null
  })
});

export const BRIDGE_TRUST_PROFILES = Object.freeze({
  "review-readonly": Object.freeze({
    permissionMode: "default",
    autonomous: false,
    requiresSandbox: false,
    writeAccess: false,
    claudeArgs: READONLY_PERMISSION_ARGS
  }),
  standard: Object.freeze({
    permissionMode: "default",
    autonomous: false,
    requiresSandbox: false,
    writeAccess: true,
    claudeArgs: STANDARD_PERMISSION_ARGS
  }),
  "trusted-autonomous": Object.freeze({
    permissionMode: "bypassPermissions",
    autonomous: true,
    requiresSandbox: false,
    writeAccess: true,
    claudeArgs: AUTONOMOUS_PERMISSION_ARGS
  }),
  "sandbox-autonomous": Object.freeze({
    permissionMode: "bypassPermissions",
    autonomous: true,
    requiresSandbox: true,
    writeAccess: true,
    claudeArgs: AUTONOMOUS_PERMISSION_ARGS
  })
});

export const BRIDGE_AGENT_PRESETS = Object.freeze({
  implementer: Object.freeze({
    agent: "implementer",
    defaultProfile: "standard",
    description: "Implements a bounded change and runs the repository-native validation gate."
  }),
  debugger: Object.freeze({
    agent: "debugger",
    defaultProfile: "standard",
    description: "Reproduces, diagnoses, and fixes a concrete failure."
  }),
  reviewer: Object.freeze({
    agent: "reviewer",
    defaultProfile: "review-readonly",
    description: "Performs a shell-free, read-only correctness review."
  }),
  "security-reviewer": Object.freeze({
    agent: "security-reviewer",
    defaultProfile: "review-readonly",
    description: "Performs a shell-free, read-only security review."
  }),
  researcher: Object.freeze({
    agent: "researcher",
    defaultProfile: "review-readonly",
    description: "Investigates local and approved external evidence without workspace edits."
  }),
  "elite-reviewer": Object.freeze({
    agent: "elite-reviewer",
    defaultProfile: "review-readonly",
    description: "Performs the strongest shell-free, read-only adversarial review preset."
  })
});

const READONLY_REQUESTABLE_TOOLS = new Set([
  ...AGENTIC_ALLOWED_TOOLS,
  ...buildWebFetchAllowlist()
]);

function canonicalDirectory(profile, label, workspacePath) {
  if (typeof workspacePath !== "string" || !path.isAbsolute(workspacePath)) {
    throw new Error(`Bridge trust profile "${profile}" requires an explicit absolute ${label}.`);
  }
  try {
    const canonicalPath = fs.realpathSync(workspacePath);
    if (!fs.statSync(canonicalPath).isDirectory()) throw new Error("not a directory");
    return canonicalPath;
  } catch {
    throw new Error(`Bridge trust profile "${profile}" requires ${label} to be an existing directory.`);
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function validateSandboxAttestation(profile, options) {
  const attestation = options.sandboxAttestation;
  if (profile !== "sandbox-autonomous") {
    if (attestation !== undefined && attestation !== null) {
      throw new Error(`Bridge trust profile "${profile}" forbids sandbox attestation.`);
    }
    return null;
  }
  throw new Error(
    `Bridge trust profile "${profile}" is unavailable: ${SANDBOX_UNAVAILABLE}.`
  );
}

function validateRequestedTools(profile, requestedTools) {
  if (requestedTools === undefined) return;
  if (!Array.isArray(requestedTools) || requestedTools.some((tool) => typeof tool !== "string" || tool.trim() === "")) {
    throw new Error("requestedTools must be an array of non-empty tool names.");
  }
  if (profile !== "review-readonly") return;
  const unsupported = requestedTools.find((tool) => !READONLY_REQUESTABLE_TOOLS.has(tool.trim()));
  if (unsupported) {
    throw new Error(`Bridge trust profile "review-readonly" cannot request tool "${unsupported}" outside its explicit allowlist.`);
  }
}

/**
 * Resolve a schemaVersion 2 profile for one family: the exact Claude argv for a Claude
 * worker or verifier, or the exact Codex thread params for a Codex one.
 *
 * @param {string} profileName a key of BRIDGE_PROFILES
 * @param {"claude"|"codex"} family
 * @returns {{profile: string, family: string, workerArgs: string[]|null, workerParams: object|null}} deep-frozen
 */
export function resolveFamilyProfile(profileName, family) {
  if (!BRIDGE_FAMILIES.includes(family)) {
    throw new Error(`Unknown worker family "${String(family)}". Allowed families: ${BRIDGE_FAMILIES.join(", ")}.`);
  }
  const profile = Object.hasOwn(BRIDGE_PROFILES, profileName) ? BRIDGE_PROFILES[profileName] : undefined;
  if (!profile) {
    throw new Error(
      `Unknown bridge profile "${String(profileName)}". Allowed profiles: ${Object.keys(BRIDGE_PROFILES).join(", ")}.`
    );
  }
  if (profileName === "sandbox-autonomous") {
    throw new Error(`Bridge profile "${profileName}" is unavailable: ${SANDBOX_UNAVAILABLE}.`);
  }
  if (family === "codex" && profile.codexParams === null) {
    const available = Object.keys(BRIDGE_PROFILES).filter((name) => BRIDGE_PROFILES[name].codexParams !== null);
    throw new Error(`Bridge profile "${profileName}" is not available for codex; choose one of: ${available.join(", ")}.`);
  }
  return deepFreeze({
    profile: profileName,
    family,
    workerArgs: family === "claude" ? [...profile.claudeArgs] : null,
    workerParams: family === "codex" ? { ...profile.codexParams } : null
  });
}

function resolveWorkspace(profileName, options) {
  if (Object.hasOwn(options, "sandboxed")) {
    throw new Error("sandboxed booleans are not accepted; provide an executor-produced sandboxAttestation.");
  }

  if (typeof options.workspacePath !== "string" || !path.isAbsolute(options.workspacePath)) {
    throw new Error(`Bridge trust profile "${profileName}" requires an explicit absolute workspacePath.`);
  }
  const requestedWorkspacePath = options.workspacePath;
  const canonicalWorkspacePath = canonicalDirectory(profileName, "workspacePath", requestedWorkspacePath);
  const canonicalPermittedRoot = options.permittedRoot === undefined
    ? null
    : canonicalDirectory(profileName, "permittedRoot", options.permittedRoot);
  if (canonicalPermittedRoot && !isWithin(canonicalPermittedRoot, canonicalWorkspacePath)) {
    throw new Error(`Canonical workspace is outside permittedRoot for bridge trust profile "${profileName}".`);
  }
  validateRequestedTools(profileName, options.requestedTools);
  return { requestedWorkspacePath, canonicalWorkspacePath, canonicalPermittedRoot };
}

// schemaVersion 2: a family is named, and the profile comes from BRIDGE_PROFILES.
function resolveFamilyPolicy(options) {
  const profileName = options.profile;
  const { family, workerArgs, workerParams } = resolveFamilyProfile(profileName, options.family);
  const profile = BRIDGE_PROFILES[profileName];
  const { requestedWorkspacePath, canonicalWorkspacePath, canonicalPermittedRoot } = resolveWorkspace(profileName, options);
  if (options.permissionMode !== undefined) {
    if (profileName === "host") {
      throw new Error(
        `Bridge profile "host" does not set a permission mode; the host configuration decides (got "${String(options.permissionMode)}").`
      );
    }
    if (family === "codex") {
      throw new Error(`Bridge profile "${profileName}" takes no permission mode for a codex worker.`);
    }
    if (options.permissionMode !== profile.permissionMode) {
      throw new Error(
        `Bridge trust profile "${profileName}" requires permissionMode "${profile.permissionMode}", not "${options.permissionMode}".`
      );
    }
  }
  const sandboxAttestation = validateSandboxAttestation(profileName, options);

  return deepFreeze({
    profile: profileName,
    family,
    permissionMode: family === "claude" ? profile.permissionMode : null,
    requestedWorkspacePath,
    canonicalWorkspacePath,
    workspacePath: canonicalWorkspacePath,
    permittedRoot: canonicalPermittedRoot,
    sandboxAttestation,
    workerArgs,
    workerParams
  });
}

/**
 * Resolve the trust policy for a delegation.
 *
 * Without `family` this is the 1.x resolver, unchanged: BRIDGE_TRUST_PROFILES and
 * `claudeArgs`. With `family` ("claude" or "codex") it resolves a schemaVersion 2
 * profile from BRIDGE_PROFILES and returns `workerArgs` or `workerParams` instead.
 */
export function resolveBridgePolicy(options = {}) {
  if (options.family !== undefined) return resolveFamilyPolicy(options);
  const profileName = options.profile;
  if (profileName === "host") {
    throw new Error('Bridge profile "host" exists only for schemaVersion 2 requests; pass the worker family to resolve it.');
  }
  const profile = Object.hasOwn(BRIDGE_TRUST_PROFILES, profileName) ? BRIDGE_TRUST_PROFILES[profileName] : undefined;
  if (!profile) {
    throw new Error(
      `Unknown bridge trust profile "${String(profileName)}". Allowed profiles: ${Object.keys(BRIDGE_TRUST_PROFILES).join(", ")}.`
    );
  }

  const { requestedWorkspacePath, canonicalWorkspacePath, canonicalPermittedRoot } = resolveWorkspace(profileName, options);

  if (options.permissionMode !== undefined && options.permissionMode !== profile.permissionMode) {
    throw new Error(
      `Bridge trust profile "${profileName}" requires permissionMode "${profile.permissionMode}", not "${options.permissionMode}".`
    );
  }

  const sandboxAttestation = validateSandboxAttestation(profileName, options);

  return deepFreeze({
    profile: profileName,
    permissionMode: profile.permissionMode,
    autonomous: profile.autonomous,
    requiresSandbox: profile.requiresSandbox,
    writeAccess: profile.writeAccess,
    requestedWorkspacePath,
    canonicalWorkspacePath,
    workspacePath: canonicalWorkspacePath,
    permittedRoot: canonicalPermittedRoot,
    sandboxAttestation,
    claudeArgs: [...profile.claudeArgs]
  });
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
