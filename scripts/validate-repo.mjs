#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const required = [
  ".codex-plugin/plugin.json",
  ".agents/plugins/marketplace.json",
  "commands/review.md",
  "commands/adversarial-review.md",
  "commands/elite-review.md",
  "commands/deep-review.md",
  "commands/security-review.md",
  "commands/workspace.md",
  "commands/enable.md",
  "commands/doctor.md",
  "commands/setup.md",
  "commands/status.md",
  "commands/result.md",
  "commands/cancel.md",
  "commands/delegate.md",
  "commands/wait.md",
  "commands/logs.md",
  "commands/recover.md",
  "commands/list.md",
  "commands/attach.md",
  "commands/send.md",
  "commands/bridge-doctor.md",
  "skills/claude-review/SKILL.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  ".github/CODEOWNERS",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/ISSUE_TEMPLATE/security_report.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/claude-review-prompt.md",
  ".github/workflows/claude.yml",
  "docs/architecture.md",
  "scripts/claude-review-companion.mjs",
  "scripts/bridge-broker.mjs",
  "scripts/bin/git-safe.mjs",
  "plugins/codex/scripts/app-server-broker.mjs",
  "schemas/review-output.schema.json",
  "schemas/elite-review-output.schema.json",
  "schemas/agentic-review-output.schema.json",
  "schemas/bridge-delegation-request.schema.json",
  "schemas/bridge-event.schema.json",
  "schemas/bridge-message-operation.schema.json",
  "schemas/bridge-result.schema.json",
  "schemas/bridge-receipt.schema.json",
  "schemas/bridge-config.schema.json",
  "docs/bridge-capabilities.md",
  "docs/bridge-migration.md",
  "docs/bridge-runtime-compatibility.md"
];

for (const relative of required) {
  const fullPath = path.join(root, relative);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing required file: ${relative}`);
  }
}

const pluginManifest = JSON.parse(fs.readFileSync(path.join(root, ".codex-plugin/plugin.json"), "utf8"));
const marketplaceManifest = JSON.parse(fs.readFileSync(path.join(root, ".agents/plugins/marketplace.json"), "utf8"));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const currentReleaseNotes = `RELEASE_NOTES_v${packageJson.version}.md`;
if (!fs.existsSync(path.join(root, currentReleaseNotes))) {
  throw new Error(`Missing current release notes file: ${currentReleaseNotes}`);
}
// Normalize CRLF so the line-anchored contract checks behave the same on Windows checkouts.
const claudeWorkflow = fs.readFileSync(path.join(root, ".github/workflows/claude.yml"), "utf8").replaceAll("\r\n", "\n");
JSON.parse(fs.readFileSync(path.join(root, "schemas/review-output.schema.json"), "utf8"));
JSON.parse(fs.readFileSync(path.join(root, "schemas/elite-review-output.schema.json"), "utf8"));
JSON.parse(fs.readFileSync(path.join(root, "schemas/agentic-review-output.schema.json"), "utf8"));
JSON.parse(fs.readFileSync(path.join(root, "schemas/bridge-delegation-request.schema.json"), "utf8"));
JSON.parse(fs.readFileSync(path.join(root, "schemas/bridge-event.schema.json"), "utf8"));
JSON.parse(fs.readFileSync(path.join(root, "schemas/bridge-message-operation.schema.json"), "utf8"));
JSON.parse(fs.readFileSync(path.join(root, "schemas/bridge-result.schema.json"), "utf8"));
JSON.parse(fs.readFileSync(path.join(root, "schemas/bridge-receipt.schema.json"), "utf8"));
JSON.parse(fs.readFileSync(path.join(root, "schemas/bridge-config.schema.json"), "utf8"));

const bridgeMigration = fs.readFileSync(path.join(root, "docs/bridge-migration.md"), "utf8")
  .replace(/\r\n/g, "\n");
if (
  !bridgeMigration.includes("Codex-Claude Bridge") ||
  !bridgeMigration.includes("canonical repository and npm package name is `codex-claude-companion`") ||
  !bridgeMigration.includes("`@kenmege/codex-claude-bridge` as the candidate. It is SUPERSEDED") ||
  !bridgeMigration.includes("unscoped\n`codex-claude-bridge` name is already occupied") ||
  !bridgeMigration.includes("Existing-package prerelease verdict: APPROVED") ||
  !bridgeMigration.includes("Unscoped cutover verdict: READY") ||
  !bridgeMigration.includes("not affiliated with or endorsed by OpenAI or\nAnthropic")
) {
  throw new Error("Bridge migration documentation must preserve differentiated identity, compatibility, and the superseded-scoped-package boundary.");
}

if (pluginManifest.skills !== "./skills/") {
  throw new Error('plugin.json must expose bundled Codex skills through the "skills": "./skills/" field.');
}

if (!Array.isArray(pluginManifest.interface?.defaultPrompt) || pluginManifest.interface.defaultPrompt.length === 0) {
  throw new Error("plugin.json interface.defaultPrompt must be a non-empty array.");
}

if (pluginManifest.interface.defaultPrompt.length > 3) {
  throw new Error("plugin.json interface.defaultPrompt must contain at most 3 prompts.");
}

if (packageJson.version !== pluginManifest.version) {
  throw new Error("package.json and .codex-plugin/plugin.json versions must match.");
}

if (packageJson.name !== "codex-claude-companion") {
  throw new Error("package.json name must be the public npm package name: codex-claude-companion.");
}

const repositoryUrl = packageJson.repository?.url?.replace(/^git\+/, "");
if (repositoryUrl !== "https://github.com/Kenmege/codex-claude-companion.git") {
  throw new Error(
    "package.json repository.url must point at the canonical GitHub repository (with or without the git+ prefix)."
  );
}

if (
  packageJson.publishConfig?.registry !== "https://registry.npmjs.org" ||
  packageJson.publishConfig?.access !== "public" ||
  Object.hasOwn(packageJson.publishConfig, "provenance")
) {
  throw new Error("package.json publishConfig must target public npmjs publishing without package-level npm provenance.");
}

if (!/anthropics\/claude-code-action@[a-f0-9]{40}/.test(claudeWorkflow)) {
  throw new Error(".github/workflows/claude.yml must pin anthropics/claude-code-action by full commit SHA.");
}

if (/anthropics\/claude-code-action@v1/.test(claudeWorkflow)) {
  throw new Error(".github/workflows/claude.yml must not use the floating anthropics/claude-code-action@v1 ref.");
}

if (/^\s+mode:/m.test(claudeWorkflow) || /^\s+prompt-file:/m.test(claudeWorkflow)) {
  throw new Error(".github/workflows/claude.yml must use current v1 inputs, not deprecated mode or prompt-file inputs.");
}

function requireClaudeContract(condition, message) {
  if (!condition) throw new Error(`.github/workflows/claude.yml ${message}`);
}

function claudeStep(job, name) {
  const lines = job.split("\n");
  const start = lines.findIndex((line) => line === `      - name: ${name}`);
  requireClaudeContract(start !== -1, `must include ${name}.`);
  let end = start + 1;
  while (end < lines.length && !/^      - name: /.test(lines[end])) end += 1;
  return lines.slice(start, end).join("\n");
}

requireClaudeContract(/^  id-token: write$/m.test(claudeWorkflow), "must retain OIDC permission.");
for (const [jobName, label] of [["auto-review", "auto review"], ["interactive", "interactive response"]]) {
  const job = claudeWorkflow.match(new RegExp(`^  ${jobName}:\\n[\\s\\S]*?(?=^  [a-zA-Z0-9_-]+:|$(?![\\s\\S]))`, "m"))?.[0] ?? "";
  requireClaudeContract(job.includes("HAS_ANTHROPIC_FEDERATION: ${{ vars.ANTHROPIC_FEDERATION_RULE_ID != '' && vars.ANTHROPIC_ORGANIZATION_ID != '' }}"), `${jobName} must detect federation from both repository variables.`);
  const preflight = claudeStep(job, jobName === "auto-review"
    ? "Verify Claude auth configured" : "Verify Claude auth configured + fork-PR guard");
  requireClaudeContract(/^        id: preflight$/m.test(preflight), `${jobName} must expose a single preflight mode.`);
  requireClaudeContract(/if \[ "\$IS_UNTRUSTED_FORK_PR" = "true" \]/.test(preflight), `${jobName} must exclude fork PRs first.`);
  requireClaudeContract(/::notice::[^\n]+\n\s+echo "mode=skip" >> "\$GITHUB_OUTPUT"\s+exit 0\s+fi\s+if \[ "\$HAS_ANTHROPIC_FEDERATION" = "true" \]; then\s+echo "mode=federation" >> "\$GITHUB_OUTPUT"\s+elif \[ "\$HAS_CLAUDE_CODE_OAUTH_TOKEN" = "true" \]; then\s+echo "mode=oauth" >> "\$GITHUB_OUTPUT"\s+elif \[ "\$HAS_ANTHROPIC_API_KEY" = "true" \]; then\s+echo "mode=api" >> "\$GITHUB_OUTPUT"\s+else\s+echo "::error::[^\n]+\n\s+exit 1\s+fi/.test(preflight), `${jobName} must skip forks, then select federation, OAuth, API, or fail closed in that order.`);
  requireClaudeContract(/Claude Code Action requires workload identity federation .*ANTHROPIC_FEDERATION_RULE_ID.*ANTHROPIC_ORGANIZATION_ID.*CLAUDE_CODE_OAUTH_TOKEN.*ANTHROPIC_API_KEY/.test(preflight), `${jobName} must name all auth options on failure.`);
  const checkout = claudeStep(job, "Check out repository");
  requireClaudeContract(/^        if: steps\.preflight\.outputs\.mode != 'skip'$/m.test(checkout) && checkout.includes("persist-credentials: false") && /uses: actions\/checkout@[a-f0-9]{40}(?:\s|$)/.test(checkout), `${jobName} must skip checkout for forks and retain pinned, credential-free checkout.`);
  if (jobName === "interactive") {
    requireClaudeContract(preflight.includes('|| [ "$IC_FORK" = "true" ]') && preflight.includes("IC_FORK: ${{ steps.resolve_pr_head.outputs.is_fork }}"), "interactive must retain the issue-comment fork guard.");
    const lookup = claudeStep(job, "Resolve PR head for issue_comment events");
    requireClaudeContract(lookup.includes("if: github.event_name == 'issue_comment' && github.event.issue.pull_request != null") && /if \[ "\$\{HEAD_REPO\}" = "\$\{\{ github\.repository \}\}" \]; then\s+echo "is_fork=false" >> "\$GITHUB_OUTPUT"\s+else\s+echo "is_fork=true" >> "\$GITHUB_OUTPUT"/.test(lookup), "interactive must resolve PR comment heads and fail closed for non-matching repositories.");
    for (const field of ["comment", "review", "issue"]) {
      requireClaudeContract(job.includes(`contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.${field}.author_association)`), `interactive must retain the ${field} author-association gate.`);
    }
  }
  const actionSteps = job.match(/^        uses: anthropics\/claude-code-action@.*$/gm) ?? [];
  requireClaudeContract(actionSteps.length === 3, `${jobName} must have exactly three separate auth action steps.`);
  for (const [mode, suffix, input, secret] of [
    ["federation", "workload identity", null, null],
    ["oauth", "OAuth", "claude_code_oauth_token", "CLAUDE_CODE_OAUTH_TOKEN"],
    ["api", "API key", "anthropic_api_key", "ANTHROPIC_API_KEY"]
  ]) {
    const step = claudeStep(job, `Run Claude ${label} with ${suffix}`);
    requireClaudeContract(step.includes(`if: steps.preflight.outputs.mode == '${mode}'`) && /uses: anthropics\/claude-code-action@[a-f0-9]{40}(?:\s|$)/.test(step), `${jobName}/${mode} must use its selected mode and a full action SHA.`);
    requireClaudeContract(step.includes("--disallowedTools Edit Write NotebookEdit Bash BashOutput KillShell") && step.includes("--model opus") && step.includes("--max-turns 80"), `${jobName}/${mode} must preserve the model, turn budget, and Bash/write-tool fence.`);
    if (input) {
      requireClaudeContract(step.includes(input + ": ${{ secrets." + secret + " }}"), `${jobName}/${mode} must use its matching secret input.`);
    } else {
      for (const name of ["FEDERATION_RULE_ID", "ORGANIZATION_ID", "SERVICE_ACCOUNT_ID", "WORKSPACE_ID"]) {
        requireClaudeContract(step.includes("anthropic_" + name.toLowerCase() + ": ${{ vars.ANTHROPIC_" + name + " }}"), `${jobName}/federation must read ${name} from vars.`);
      }
      requireClaudeContract(!/^\s+(?:anthropic_api_key|claude_code_oauth_token):/m.test(step) && !step.includes("secrets."), `${jobName}/federation must not pass static auth inputs.`);
    }
    requireClaudeContract(jobName === "auto-review"
      ? step.includes("use_sticky_comment: true") && step.includes("prompt: ${{ env.CLAUDE_AUTO_REVIEW_PROMPT }}")
      : step.includes('--append-system-prompt "${{ env.CLAUDE_INTERACTIVE_PROMPT }}"'), `${jobName}/${mode} must retain its shared prompt and comment behavior.`);
  }
}

// JUSTIFIED: structural rather than name-locked validation so forks
// can rename their private marketplace without lint breaking. The
// previous string-equality check on "claude-review-private" was a
// forkability bug: anyone forking this repo for their own private
// Codex marketplace would hit a hard lint failure on first
// `npm run check`. Now we enforce shape only; operator chooses the
// name.
if (typeof marketplaceManifest.name !== "string" || marketplaceManifest.name.trim() === "") {
  throw new Error(".agents/plugins/marketplace.json must declare a non-empty `name`.");
}

if (!Array.isArray(marketplaceManifest.plugins) || marketplaceManifest.plugins.length === 0) {
  throw new Error(".agents/plugins/marketplace.json must list at least one plugin.");
}

const marketplacePlugin = marketplaceManifest.plugins.find((entry) => entry?.name === pluginManifest.name);
if (!marketplacePlugin) {
  throw new Error(".agents/plugins/marketplace.json must expose the .codex-plugin plugin name.");
}

if (marketplacePlugin.source?.source !== "local" || marketplacePlugin.source?.path !== "./") {
  throw new Error(".agents/plugins/marketplace.json must install the plugin from the local repo root.");
}

if (packageLock.version !== packageJson.version || packageLock.packages?.[""]?.version !== packageJson.version) {
  throw new Error("package-lock.json version metadata must match package.json.");
}

if (!Array.isArray(packageJson.files) || packageJson.files.length === 0) {
  throw new Error("package.json files must explicitly list publishable contents.");
}

if (!packageJson.files.includes("skills/")) {
  throw new Error("package.json files must include bundled Codex skills.");
}

for (const file of [
  "scripts/claude-review-companion.mjs",
  "scripts/bridge-broker.mjs",
  "scripts/bin/git-safe.mjs",
  "plugins/codex/scripts/app-server-broker.mjs",
  ...fs.readdirSync(path.join(root, "scripts", "lib"))
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => path.join("scripts", "lib", name)),
  ...fs.readdirSync(path.join(root, "plugins", "codex", "scripts", "lib"))
    .filter((name) => name.endsWith(".mjs"))
    .map((name) =>
    path.join("plugins", "codex", "scripts", "lib", name)
  )
]) {
  const result = spawnSync("node", ["--check", path.join(root, file)], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Syntax check failed for ${file}\n${result.stderr || result.stdout}`);
  }
}

console.log("Repository validation passed.");
