/**
 * Internal entrypoint for the root app.
 * Re-exports shared types, values, and utilities needed by the Next.js app.
 */

export type {
  AgentApiKeyName,
  AgentManifest,
  AuthorPermission,
  Payload,
  PayloadEvent,
  PushPermission,
  ShellPermission,
  ToolPermission,
  WriteablePayload,
} from "../external.ts";
export {
  AgentName,
  agentsManifest,
  Effort,
  ghPullfrogMcpName,
} from "../external.ts";
export type { Mode } from "../modes.ts";
export { modes } from "../modes.ts";
export type {
  AgentInfo,
  BuildPullfrogFooterParams,
  WorkflowRunFooterInfo,
} from "../utils/buildPullfrogFooter.ts";
export {
  buildPullfrogFooter,
  PULLFROG_DIVIDER,
  stripExistingFooter,
} from "../utils/buildPullfrogFooter.ts";
export type { ResourceUsage, UsageSummary } from "../utils/github.ts";
export {
  isValidTimeString,
  parseTimeString,
  TIMEOUT_DISABLED,
} from "../utils/time.ts";
