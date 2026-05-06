import { isAbsolute, resolve } from "node:path";
import * as core from "@actions/core";
import { type } from "arktype";
import type { AuthorPermission, PayloadEvent } from "../external.ts";
import packageJson from "../package.json" with { type: "json" };
import type { RepoSettings } from "./runContext.ts";
import { validateCompatibility } from "./versioning.ts";

// tool permission enum types for inputs
const ShellPermissionInput = type.enumerated("disabled", "restricted", "enabled");
const PushPermissionInput = type.enumerated("disabled", "restricted", "enabled");

// schema for JSON payload passed via prompt (internal dispatch invocation)
// note: permissions are intentionally NOT included here to prevent injection attacks
// permissions are derived from event.authorPermission instead
export const JsonPayload = type({
  "~pullfrog": "true",
  version: "string",
  "model?": "string | undefined",
  prompt: "string",
  "triggerer?": "string | undefined",

  "eventInstructions?": "string",
  "event?": "object",
  "timeout?": "string | undefined",
  "progressComment?": type({
    id: "string",
    type: "'issue' | 'review'",
  }).or("undefined"),
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
  "model?": type.string.or("undefined"),
  "timeout?": type.string.or("undefined"),
  "push?": PushPermissionInput.or("undefined"),
  "shell?": ShellPermissionInput.or("undefined"),
  "cwd?": type.string.or("undefined"),
  "output_schema?": type.string.or("undefined"),
});

export type Inputs = typeof Inputs.infer;

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
    model: core.getInput("model") || undefined,
    timeout: core.getInput("timeout") || undefined,
    cwd: core.getInput("cwd") || undefined,
    push: core.getInput("push") || undefined,
    shell: core.getInput("shell") || undefined,
  });
}

const isPullfrog = (actor: string | null | undefined): boolean => {
  actor = actor?.replace("[bot]", "");
  return !!actor && (actor === "pullfrog" || actor === "pullfrogdev");
};

export function resolvePayload(
  resolvedPromptInput: ResolvedPromptInput,
  repoSettings: RepoSettings
) {
  const [prompt, jsonPayload] =
    typeof resolvedPromptInput !== "string"
      ? [resolvedPromptInput.prompt, resolvedPromptInput]
      : [resolvedPromptInput, undefined];

  const inputs = resolveNonPromptInputs();

  // resolve event - use type guard for jsonPayload.event, fallback to unknown trigger
  const rawEvent = jsonPayload?.event;
  const event: PayloadEvent = isPayloadEvent(rawEvent) ? rawEvent : { trigger: "unknown" };

  const model = jsonPayload?.model ?? inputs.model ?? repoSettings.model ?? undefined;

  // determine shell permission - strictest setting wins
  // precedence: disabled > restricted > enabled
  // non-collaborators always get at least "restricted"
  const isNonCollaborator = !isCollaborator(event);
  const repoShell = repoSettings.shell ?? "restricted";
  const inputShell = inputs.shell;

  // resolve shell: start with repo setting, then apply restrictions
  let resolvedShell = repoShell;

  // input can only make it stricter (disabled > restricted > enabled)
  if (inputShell === "disabled") {
    resolvedShell = "disabled";
  } else if (inputShell === "restricted" && resolvedShell === "enabled") {
    resolvedShell = "restricted";
  }

  // non-collaborators get at least "restricted" (can't have "enabled")
  if (isNonCollaborator && resolvedShell === "enabled") {
    resolvedShell = "restricted";
  }

  // build payload - precedence: inputs > repoSettings > fallbacks
  // note: modes are NOT in payload - they come from repoSettings in main()
  return {
    "~pullfrog": true as const,
    version: jsonPayload?.version ?? packageJson.version,
    model,
    prompt,
    triggerer:
      jsonPayload?.triggerer ??
      // it's not a common use case but GITHUB_ACTOR can be a user when the workflow is manually triggered by a user through GitHub Actions UI
      (!isPullfrog(process.env.GITHUB_ACTOR) ? process.env.GITHUB_ACTOR : undefined),
    eventInstructions: jsonPayload?.eventInstructions,
    event,
    timeout: inputs.timeout ?? jsonPayload?.timeout,
    cwd: resolveCwd(inputs.cwd),
    progressComment: jsonPayload?.progressComment,

    // permissions: inputs > repoSettings > fallbacks
    push: inputs.push ?? repoSettings.push ?? "restricted",
    shell: resolvedShell,

    // set by proxy logic in main.ts when routing through OpenRouter
    proxyModel: undefined as string | undefined,
  };
}

export type ResolvedPayload = ReturnType<typeof resolvePayload>;
