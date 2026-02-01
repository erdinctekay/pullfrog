import { isAbsolute, resolve } from "node:path";
import * as core from "@actions/core";
import { type } from "arktype";
import { AgentName, type AuthorPermission, Effort, type PayloadEvent } from "../external.ts";
import packageJson from "../package.json" with { type: "json" };
import type { RepoSettings } from "./runContext.ts";
import { validateCompatibility } from "./versioning.ts";

// tool permission enum types for inputs
const ToolPermissionInput = type.enumerated("disabled", "enabled");
const BashPermissionInput = type.enumerated("disabled", "restricted", "enabled");

// schema for JSON payload passed via prompt (internal dispatch invocation)
// note: permissions are intentionally NOT included here to prevent injection attacks
// permissions are derived from event.authorPermission instead
export const JsonPayload = type({
  "~pullfrog": "true",
  version: "string",
  "agent?": AgentName.or("undefined"),
  prompt: "string",
  "eventInstructions?": "string",
  "repoInstructions?": "string",
  "event?": "object",
  "effort?": Effort.or("undefined"),
  "timeout?": type.string.or("undefined"),
  "progressCommentId?": type.string.or("undefined"),
});

// permission levels that indicate collaborator status (have push access)
const COLLABORATOR_PERMISSIONS: AuthorPermission[] = ["admin", "maintain", "write"];

// check if the event author has collaborator-level permissions
function isCollaborator(event: PayloadEvent): boolean {
  const perm = event.authorPermission;
  return perm !== undefined && COLLABORATOR_PERMISSIONS.includes(perm);
}

// inputs schema - action inputs from core.getInput()
// note: tool permissions use .or("undefined") because getInput() || undefined
// explicitly sets the property to undefined when empty, which is different from
// the property being absent. arktype's "prop?" means "optional to include" but
// if included, must match the type - so we need to explicitly allow undefined.
export const Inputs = type({
  prompt: "string",
  "effort?": Effort.or("undefined"),
  "timeout?": type.string.or("undefined"),
  "agent?": AgentName.or("undefined"),
  "web?": ToolPermissionInput.or("undefined"),
  "search?": ToolPermissionInput.or("undefined"),
  "write?": ToolPermissionInput.or("undefined"),
  "bash?": BashPermissionInput.or("undefined"),
  "cwd?": type.string.or("undefined"),
});

export type Inputs = typeof Inputs.infer;

function isAgentName(value: unknown): value is AgentName {
  return typeof value === "string" && AgentName(value) instanceof type.errors === false;
}

function isPayloadEvent(value: unknown): value is PayloadEvent {
  return typeof value === "object" && value !== null && "trigger" in value;
}

function resolveCwd(cwd: string | undefined): string | undefined {
  const workspace = process.env.GITHUB_WORKSPACE;
  if (!cwd) return workspace;
  if (isAbsolute(cwd)) return cwd;
  return workspace ? resolve(workspace, cwd) : cwd;
}

export type ResolvedPromptInput = string | typeof JsonPayload.infer;

export function resolvePromptInput(): ResolvedPromptInput {
  const prompt = core.getInput("prompt", { required: true });

  let parsed: unknown;
  try {
    parsed = JSON.parse(prompt);
  } catch {
    // JSON parse error is fine (plain text prompt)
    return prompt;
  }

  if (!parsed || typeof parsed !== "object" || !("~pullfrog" in parsed)) {
    // if it doesn't look like a pullfrog payload, return the plain text prompt
    return prompt;
  }

  // validation errors should propagate
  const jsonPayload = JsonPayload.assert(parsed);
  validateCompatibility(jsonPayload.version, packageJson.version);
  return jsonPayload;
}

function resolveNonPromptInputs() {
  return Inputs.omit("prompt").assert({
    effort: core.getInput("effort") || undefined,
    timeout: core.getInput("timeout") || undefined,
    agent: core.getInput("agent") || undefined,
    cwd: core.getInput("cwd") || undefined,
    web: core.getInput("web") || undefined,
    search: core.getInput("search") || undefined,
    write: core.getInput("write") || undefined,
    bash: core.getInput("bash") || undefined,
  });
}

export function resolvePayload(
  resolvedPromptInput: ResolvedPromptInput,
  repoSettings: RepoSettings
) {
  const [prompt, jsonPayload] =
    typeof resolvedPromptInput !== "string"
      ? [resolvedPromptInput.prompt, resolvedPromptInput]
      : [resolvedPromptInput, undefined];

  const inputs = resolveNonPromptInputs();

  // validate agent name
  const agent: AgentName | undefined =
    inputs.agent !== undefined && isAgentName(inputs.agent) ? inputs.agent : undefined;

  // resolve event - use type guard for jsonPayload.event, fallback to unknown trigger
  const rawEvent = jsonPayload?.event;
  const event: PayloadEvent = isPayloadEvent(rawEvent) ? rawEvent : { trigger: "unknown" };

  // resolve agent from jsonPayload with type guard
  const jsonAgent = jsonPayload?.agent;
  const resolvedAgent: AgentName | undefined =
    agent ?? (jsonAgent !== undefined && isAgentName(jsonAgent) ? jsonAgent : undefined);

  // determine bash permission - strictest setting wins
  // precedence: disabled > restricted > enabled
  // non-collaborators always get at least "restricted"
  const isNonCollaborator = !isCollaborator(event);
  const repoBash = repoSettings.bash ?? "restricted";
  const inputBash = inputs.bash;

  // resolve bash: start with repo setting, then apply restrictions
  let resolvedBash = repoBash;

  // input can only make it stricter (disabled > restricted > enabled)
  if (inputBash === "disabled") {
    resolvedBash = "disabled";
  } else if (inputBash === "restricted" && resolvedBash === "enabled") {
    resolvedBash = "restricted";
  }

  // non-collaborators get at least "restricted" (can't have "enabled")
  if (isNonCollaborator && resolvedBash === "enabled") {
    resolvedBash = "restricted";
  }

  // build payload - precedence: inputs > repoSettings > fallbacks
  // note: modes are NOT in payload - they come from repoSettings in main()
  return {
    "~pullfrog": true as const,
    version: jsonPayload?.version ?? packageJson.version,
    agent: resolvedAgent,
    prompt,
    eventInstructions: jsonPayload?.eventInstructions,
    repoInstructions: jsonPayload?.repoInstructions,
    event,
    effort: inputs.effort ?? jsonPayload?.effort ?? "auto",
    timeout: inputs.timeout ?? jsonPayload?.timeout,
    cwd: resolveCwd(inputs.cwd),

    // permissions: inputs > repoSettings > fallbacks
    web: inputs.web ?? repoSettings.web ?? "enabled",
    search: inputs.search ?? repoSettings.search ?? "enabled",
    write: inputs.write ?? repoSettings.write ?? "enabled",
    bash: resolvedBash,
  };
}

export type ResolvedPayload = ReturnType<typeof resolvePayload>;
