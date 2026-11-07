import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { validateBridgeRequestContract } from "./bridge-contracts.mjs";
import { BRIDGE_FAMILIES, resolveBridgePolicy, resolveFamilyProfile } from "./bridge-policy.mjs";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ALLOWED_EXECUTORS = new Set(["tmux", "native-background"]);
const ALLOWED_WORKSPACE_MODES = new Set(["current", "worktree"]);
const ALLOWED_SETTING_SOURCES = new Set(["user", "project", "local"]);
const SECRET_KEY = /^(?:api[_-]?key|access[_-]?token|auth(?:orization)?|bearer|password|secret|token)$/i;

export class BridgeRequestError extends Error {
  constructor(code, field, message, options = {}) {
    super(message, options);
    this.name = "BridgeRequestError";
    this.code = code;
    this.field = field;
  }
}

function fail(code, field, message, options) {
  throw new BridgeRequestError(code, field, message, options);
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("required", field, `${field} must be a non-empty string.`);
  }
  return value.trim();
}

function nullableString(value, field) {
  if (value === undefined || value === null) return null;
  return requiredString(value, field);
}

function asList(value, field) {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    fail("invalid_type", field, `${field} must contain only non-empty strings.`);
  }
  return values.map((entry) => entry.trim());
}

function canonicalPath(value, field, kind) {
  const requested = requiredString(value, field);
  if (!path.isAbsolute(requested)) fail("path_not_absolute", field, `${field} must be an absolute path.`);
  let canonical;
  let stat;
  try {
    canonical = fs.realpathSync(requested);
    stat = fs.statSync(canonical);
  } catch (cause) {
    fail("path_not_found", field, `${field} must reference an existing ${kind}.`, { cause });
  }
  const valid = kind === "directory" ? stat.isDirectory() : stat.isFile();
  if (!valid) fail("path_wrong_kind", field, `${field} must reference an existing ${kind}.`);
  return canonical;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function constrainPath(candidate, root, field) {
  if (root && !isWithin(root, candidate)) {
    fail("path_outside_permitted_root", field, `${field} resolves outside permittedRoot.`);
  }
  return candidate;
}

function canonicalPaths(value, field, kind, root) {
  return asList(value, field).map((entry, index) => constrainPath(
    canonicalPath(entry, `${field}[${index}]`, kind),
    root,
    `${field}[${index}]`
  ));
}

function cloneJsonObject(value, field) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (cause) {
      fail("invalid_json", field, `${field} must be valid JSON.`, { cause });
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    fail("invalid_agents", field, `${field} must be a non-empty JSON object.`);
  }
  let clone;
  try {
    clone = JSON.parse(JSON.stringify(parsed));
  } catch (cause) {
    fail("invalid_json", field, `${field} must contain JSON-serializable values.`, { cause });
  }
  scanSecretKeys(clone, field);
  return clone;
}

function scanSecretKeys(value, field) {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      fail("secret_value_forbidden", field, `${field} must not embed secret-bearing key "${key}"; reference runtime configuration instead.`);
    }
    scanSecretKeys(nested, field);
  }
}

function resolveAgentSelection(options, permittedRoot) {
  const agent = options.agent === undefined || options.agent === null ? null : requiredString(options.agent, "agent");
  const agentsPresent = options.agents !== undefined && options.agents !== null;
  if (options.agentsFile != null && options.customAgentsFile != null) {
    fail("agent_selection_conflict", "agentsFile", "agentsFile and customAgentsFile are aliases; provide only one.");
  }
  const agentsFileValue = options.agentsFile ?? options.customAgentsFile;
  const filePresent = agentsFileValue !== undefined && agentsFileValue !== null;
  if (agentsPresent && filePresent) {
    fail("agent_selection_conflict", "agents", "agents and agentsFile are mutually exclusive definition sources.");
  }
  return {
    agent,
    inlineAgents: agentsPresent ? cloneJsonObject(options.agents, "agents") : null,
    customAgentsFile: filePresent
      ? constrainPath(canonicalPath(agentsFileValue, "agentsFile", "file"), permittedRoot, "agentsFile")
      : null
  };
}

function resolveSettingSources(value) {
  const entries = typeof value === "string" ? value.split(",") : asList(value, "settingSources");
  const normalized = entries.map((entry) => requiredString(entry, "settingSources"));
  const invalid = normalized.find((entry) => !ALLOWED_SETTING_SOURCES.has(entry));
  if (invalid) fail("invalid_setting_source", "settingSources", `Unknown setting source "${invalid}".`);
  return [...new Set(normalized)];
}

function encodeBase32(value, width) {
  let remaining = BigInt(value);
  let output = "";
  for (let index = 0; index < width; index += 1) {
    output = CROCKFORD_BASE32[Number(remaining & 31n)] + output;
    remaining >>= 5n;
  }
  return output;
}

function generateJobId(now = Date.now()) {
  const timePart = encodeBase32(BigInt(now), 10);
  const randomPart = encodeBase32(BigInt(`0x${crypto.randomBytes(10).toString("hex")}`), 16);
  return `ccb_${timePart}${randomPart}`;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function resolvePermittedRoot(options) {
  return options.permittedRoot === undefined || options.permittedRoot === null
    ? null
    : canonicalPath(options.permittedRoot, "permittedRoot", "directory");
}

function resolvePolicyOrFail(policyOptions) {
  try {
    return resolveBridgePolicy(policyOptions);
  } catch (cause) {
    if (cause instanceof BridgeRequestError) throw cause;
    if (cause.message.includes("outside permittedRoot")) {
      fail("path_outside_permitted_root", "workspacePath", "workspacePath resolves outside permittedRoot.", { cause });
    }
    fail("policy_invalid", "profile", cause.message, { cause });
  }
}

function resolveExecutionOptions(options) {
  const executor = requiredString(options.executor, "executor");
  if (!ALLOWED_EXECUTORS.has(executor)) fail("invalid_executor", "executor", `Unknown executor "${executor}".`);
  const workspaceMode = requiredString(options.workspace ?? options.workspaceMode, "workspace");
  if (!ALLOWED_WORKSPACE_MODES.has(workspaceMode)) fail("invalid_workspace_mode", "workspace", `Unknown workspace mode "${workspaceMode}".`);

  const timeoutSeconds = options.timeout ?? options.timeoutSeconds;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) {
    fail("invalid_timeout", "timeout", "timeout must be a positive integer number of seconds.");
  }
  const acceptance = asList(options.acceptance, "acceptance");
  if (acceptance.length === 0) fail("acceptance_required", "acceptance", "acceptance must contain at least one criterion.");
  return { executor, workspaceMode, timeoutSeconds, acceptance };
}

function resolveOriginDirectories(options, permittedRoot) {
  const canonicalCwd = constrainPath(canonicalPath(options.cwd, "cwd", "directory"), permittedRoot, "cwd");
  const canonicalRepoRoot = constrainPath(canonicalPath(options.repoRoot, "repoRoot", "directory"), permittedRoot, "repoRoot");
  const mcpConfigInput = options.mcpConfigs ?? options.mcpConfigPaths;
  if (asList(mcpConfigInput, "mcpConfigs").some((entry) => entry.startsWith("{"))) {
    fail("inline_mcp_config_forbidden", "mcpConfigs", "Inline MCP configuration is not persisted in bridge requests; provide configuration file paths.");
  }
  return { canonicalCwd, canonicalRepoRoot, mcpConfigInput };
}

function validateOrFail(request) {
  try {
    validateBridgeRequestContract(request);
  } catch (cause) {
    fail("contract_invalid", "request", cause.message, { cause });
  }
  return deepFreeze(request);
}

/**
 * Build an immutable, contract-validated delegation request.
 *
 * Without `schemaVersion` (or with 1) this writes the 1.2.0 request from the 1.x
 * options, unchanged. With `schemaVersion: 2` it writes a v2 request from the options
 * `originFamily`, `threadId`, `turnId`, `accountHome`, `workerFamily`, `model`,
 * `effort`, `routing`, `verificationFamily`, `verificationProfile`, `taskFamily` and
 * `continuesJobId`, plus the 1.x workspace, executor, task and Claude worker options.
 *
 * @throws {BridgeRequestError} with a stable `code` and the offending `field`
 */
export function buildBridgeRequest(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail("invalid_options", "options", "Bridge request options must be an object.");
  }
  if (options.schemaVersion === undefined || options.schemaVersion === 1) return buildV1Request(options);
  if (options.schemaVersion === 2) return buildV2Request(options);
  return fail("invalid_schema_version", "schemaVersion", `Unsupported request schemaVersion ${JSON.stringify(options.schemaVersion)}; supported versions: 1, 2.`);
}

function buildV1Request(options) {
  const permittedRoot = resolvePermittedRoot(options);
  const requestedWorkspacePath = requiredString(options.workspacePath, "workspacePath");
  const policy = resolvePolicyOrFail({
    profile: requiredString(options.profile, "profile"),
    workspacePath: requestedWorkspacePath,
    permittedRoot: permittedRoot ?? undefined
  });

  const { executor, workspaceMode, timeoutSeconds, acceptance } = resolveExecutionOptions(options);
  const jobId = generateJobId();
  const agentSelection = resolveAgentSelection(options, permittedRoot);
  const settingSources = resolveSettingSources(options.settingSources);
  const settingSourcesArg = `--setting-sources=${settingSources.join(",")}`;
  const effectiveClaudePermissionArgs = [
    settingSourcesArg,
    ...policy.claudeArgs.filter((argument) => argument !== "--setting-sources=")
  ];
  const { canonicalCwd, canonicalRepoRoot, mcpConfigInput } = resolveOriginDirectories(options, permittedRoot);

  const request = {
    schemaVersion: 1,
    jobId,
    origin: {
      codexThreadId: requiredString(options.codexThreadId, "codexThreadId"),
      codexTurnId: nullableString(options.codexTurnId, "codexTurnId"),
      cwd: canonicalCwd,
      repoRoot: canonicalRepoRoot,
      branch: nullableString(options.branch, "branch"),
      head: nullableString(options.head, "head")
    },
    worker: {
      provider: "anthropic",
      model: requiredString(options.model, "model"),
      ...agentSelection,
      pluginDirs: canonicalPaths(options.pluginDirs, "pluginDirs", "directory", permittedRoot),
      mcpConfigPaths: canonicalPaths(mcpConfigInput, "mcpConfigs", "file", permittedRoot),
      addDirs: canonicalPaths(options.addDirs, "addDirs", "directory", permittedRoot),
      settingSources,
      effort: requiredString(options.effort, "effort"),
      resolvedRuntimeVersion: requiredString(options.resolvedRuntimeVersion, "resolvedRuntimeVersion")
    },
    execution: {
      profile: policy.profile,
      executor,
      tmuxSession: executor === "tmux" ? `ccb-${jobId.slice(4)}` : null,
      workspaceMode,
      requestedWorkspacePath: policy.requestedWorkspacePath,
      canonicalWorkspacePath: policy.canonicalWorkspacePath,
      permittedRoot: policy.permittedRoot,
      claudeSessionId: crypto.randomUUID(),
      sandboxAttestation: policy.sandboxAttestation,
      timeoutSeconds,
      effectiveClaudePermissionArgs
    },
    task: {
      promptFile: requiredString(options.promptFile, "promptFile"),
      acceptance
    }
  };

  return validateOrFail(request);
}

// Options that only a Claude worker can use; a Codex worker has no equivalent.
const CLAUDE_ONLY_OPTIONS = Object.freeze([
  "agents", "agentsFile", "customAgentsFile", "pluginDirs", "mcpConfigs", "mcpConfigPaths", "addDirs", "settingSources"
]);

function isProvided(value) {
  return value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);
}

function familyOption(value, field) {
  if (!BRIDGE_FAMILIES.includes(value)) {
    fail("invalid_family", field, `${field} must be one of ${BRIDGE_FAMILIES.join(", ")}; got ${JSON.stringify(value ?? null)}.`);
  }
  return value;
}

function resolveVerification(options, workerFamily) {
  const family = options.verificationFamily === undefined || options.verificationFamily === null
    ? BRIDGE_FAMILIES.find((candidate) => candidate !== workerFamily)
    : familyOption(options.verificationFamily, "verificationFamily");
  if (family === workerFamily) {
    fail("same_family_verification", "verificationFamily", `The verifier must be the other family than the ${workerFamily} worker.`);
  }
  const profile = options.verificationProfile === undefined || options.verificationProfile === null
    ? "host"
    : requiredString(options.verificationProfile, "verificationProfile");
  try {
    resolveFamilyProfile(profile, family);
  } catch (cause) {
    fail("policy_invalid", "verificationProfile", cause.message, { cause });
  }
  return { family, profile };
}

function resolveAccountHome(value) {
  if (value === undefined || value === null) return null;
  const accountHome = requiredString(value, "accountHome");
  if (!path.isAbsolute(accountHome)) fail("path_not_absolute", "accountHome", "accountHome must be an absolute path.");
  let stat;
  try {
    stat = fs.statSync(accountHome);
  } catch (cause) {
    fail("path_not_found", "accountHome", "accountHome must reference an existing directory.", { cause });
  }
  if (!stat.isDirectory()) fail("path_wrong_kind", "accountHome", "accountHome must reference an existing directory.");
  // Recorded as given: it is matched against the CLAUDE_CONFIG_DIR or CODEX_HOME value later.
  return accountHome;
}

function resolveRoutingOption(options, model, effort) {
  if (options.routing === undefined || options.routing === null) {
    return model !== null || effort !== null
      ? { source: "flag", reason: "Explicit model or effort option." }
      : { source: "host", reason: "No routing rule or flag; the host configuration decides model and effort." };
  }
  if (typeof options.routing !== "object" || Array.isArray(options.routing)) {
    fail("invalid_routing", "routing", "routing must be an object with source and reason.");
  }
  return { ...options.routing };
}

function buildV2Request(options) {
  const originFamily = familyOption(options.originFamily, "originFamily");
  const workerFamily = familyOption(options.workerFamily, "workerFamily");
  const claudeWorker = workerFamily === "claude";
  const permittedRoot = resolvePermittedRoot(options);
  const requestedWorkspacePath = requiredString(options.workspacePath, "workspacePath");
  const profile = requiredString(options.profile, "profile");
  const policy = resolvePolicyOrFail({
    profile,
    family: workerFamily,
    workspacePath: requestedWorkspacePath,
    permittedRoot: permittedRoot ?? undefined
  });
  const verification = resolveVerification(options, workerFamily);
  if (!claudeWorker) {
    const claudeOption = CLAUDE_ONLY_OPTIONS.find((name) => isProvided(options[name]));
    if (claudeOption) {
      fail("claude_option_for_codex_worker", claudeOption, `${claudeOption} applies only to a Claude worker; this request has a Codex worker.`);
    }
  } else if (profile === "host" && isProvided(options.settingSources)) {
    fail("host_setting_sources", "settingSources", "The host profile passes no --setting-sources; choose a non-host profile to set setting sources.");
  }

  const { executor, workspaceMode, timeoutSeconds, acceptance } = resolveExecutionOptions(options);
  const jobId = generateJobId();
  const { canonicalCwd, canonicalRepoRoot, mcpConfigInput } = resolveOriginDirectories(options, permittedRoot);
  const model = nullableString(options.model, "model");
  const effort = nullableString(options.effort, "effort");

  let workerBlock;
  let workerSettings;
  if (claudeWorker) {
    const agentSelection = resolveAgentSelection(options, permittedRoot);
    const settingSources = profile === "host" ? null : resolveSettingSources(options.settingSources);
    workerBlock = {
      claude: {
        inlineAgents: agentSelection.inlineAgents,
        customAgentsFile: agentSelection.customAgentsFile,
        pluginDirs: canonicalPaths(options.pluginDirs, "pluginDirs", "directory", permittedRoot),
        mcpConfigPaths: canonicalPaths(mcpConfigInput, "mcpConfigs", "file", permittedRoot),
        addDirs: canonicalPaths(options.addDirs, "addDirs", "directory", permittedRoot),
        settingSources
      }
    };
    workerSettings = {
      workerSessionId: crypto.randomUUID(),
      effectiveWorkerArgs: settingSources === null
        ? [...policy.workerArgs]
        : [`--setting-sources=${settingSources.join(",")}`, ...policy.workerArgs.filter((argument) => argument !== "--setting-sources=")]
    };
  } else {
    workerBlock = { codex: {} };
    workerSettings = { workerSessionId: null, effectiveWorkerParams: { ...policy.workerParams } };
  }
  const agent = options.agent === undefined || options.agent === null ? null : requiredString(options.agent, "agent");

  const request = {
    schemaVersion: 2,
    jobId,
    origin: {
      family: originFamily,
      threadId: requiredString(options.threadId, "threadId"),
      turnId: nullableString(options.turnId, "turnId"),
      cwd: canonicalCwd,
      repoRoot: canonicalRepoRoot,
      branch: nullableString(options.branch, "branch"),
      head: nullableString(options.head, "head"),
      accountHome: resolveAccountHome(options.accountHome)
    },
    worker: {
      family: workerFamily,
      provider: claudeWorker ? "anthropic" : "openai",
      model,
      effort,
      agent,
      resolvedRuntimeVersion: requiredString(options.resolvedRuntimeVersion, "resolvedRuntimeVersion"),
      ...workerBlock
    },
    execution: {
      profile: policy.profile,
      executor,
      tmuxSession: executor === "tmux" ? `ccb-${jobId.slice(4)}` : null,
      workspaceMode,
      requestedWorkspacePath: policy.requestedWorkspacePath,
      canonicalWorkspacePath: policy.canonicalWorkspacePath,
      permittedRoot: policy.permittedRoot,
      workerSessionId: workerSettings.workerSessionId,
      sandboxAttestation: policy.sandboxAttestation,
      timeoutSeconds,
      ...(claudeWorker
        ? { effectiveWorkerArgs: workerSettings.effectiveWorkerArgs }
        : { effectiveWorkerParams: workerSettings.effectiveWorkerParams })
    },
    verification,
    task: {
      promptFile: requiredString(options.promptFile, "promptFile"),
      acceptance,
      family: nullableString(options.taskFamily, "taskFamily"),
      continuesJobId: nullableString(options.continuesJobId, "continuesJobId")
    },
    routing: resolveRoutingOption(options, model, effort)
  };

  return validateOrFail(request);
}
