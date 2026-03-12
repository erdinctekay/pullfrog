/**
 * Internal entrypoint for the root app.
 * Re-exports shared types, values, and utilities needed by the Next.js app.
 */

export type {
  AuthorPermission,
  ModelAlias,
  ModelProvider,
  Payload,
  PayloadEvent,
  ProviderConfig,
  PushPermission,
  ShellPermission,
  ToolPermission,
  WriteablePayload,
} from "../external.ts";
export {
  getModelEnvVars,
  getModelProvider,
  ghPullfrogMcpName,
  modelAliases,
  parseModel,
  providers,
  resolveModelSlug,
} from "../external.ts";
export type { Mode } from "../modes.ts";
export { modes } from "../modes.ts";
export type {
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
