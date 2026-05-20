// Shared helpers for the OpenCode agent harnesses (`./opencode.ts` v1 and
// `./opencode_v2.ts` v2). Pure config / model-registry / install glue —
// nothing here touches the NDJSON event loop, which differs between v1 and v2.
//
// Once v1 is deleted post-burn-in this module collapses back into v2; until
// then it keeps both runners synchronized so a config drift can't make v1 a
// silently-broken fallback.

import { execFileSync } from "node:child_process";
import { modelAliases } from "../models.ts";
import { log } from "../utils/cli.ts";
import { installFromNpmTarball } from "../utils/install.ts";
import { getDevDependencyVersion } from "../utils/version.ts";
import { REVIEWER_AGENT_NAME, REVIEWER_SYSTEM_PROMPT } from "./reviewer.ts";
import { deriveSubagentModels } from "./subagentModels.ts";

// ── config ─────────────────────────────────────────────────────────────────────

export type OpenCodeConfig = {
  mcp?: Record<string, unknown>;
  permission?: Record<string, unknown>;
  provider?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
  model?: string;
  enabled_providers?: string[];
  [key: string]: unknown;
};

/**
 * Build the `provider.google.models[id].options` map that pins every direct-Google
 * Gemini alias to `thinkingLevel: "high"`. Sourced from the model registry so
 * adding/renaming a Google alias in `action/models.ts` flows through automatically.
 */
export function geminiHighThinkingOverrides(): Record<string, { options: object }> {
  return Object.fromEntries(
    modelAliases
      .filter((a) => a.provider === "google")
      .map((a) => [
        a.resolve.replace(/^google\//, ""),
        { options: { thinkingConfig: { thinkingLevel: "high" } } },
      ])
  );
}

/**
 * Read-only `reviewfrog` subagent for lens-based review. Non-mutative +
 * non-recursive — enforced by the system prompt in reviewer.ts.
 *
 * Per-subagent `model:` override is driven by the registry in
 * `action/models.ts` via each alias's `subagentModel` field. Currently wired:
 * Anthropic opus → sonnet, OpenAI gpt-pro → gpt and gpt → gpt-5.4, Google
 * gemini-pro → gemini-flash. Other providers inherit (no override).
 */
export function buildReviewerAgentConfig(
  orchestratorModel: string | undefined
): Record<string, unknown> {
  const overrides = deriveSubagentModels(orchestratorModel);
  return {
    [REVIEWER_AGENT_NAME]: {
      description:
        "Read-only review subagent for lens-based code review (correctness, security, billing-subsystem, etc.). " +
        "Reads only — no writes, no state-changing shell or MCP calls, no nested subagent dispatch.",
      mode: "subagent",
      prompt: REVIEWER_SYSTEM_PROMPT,
      ...(overrides.reviewer !== undefined ? { model: overrides.reviewer } : {}),
    },
  };
}

// ── install ────────────────────────────────────────────────────────────────────

/**
 * Install the opencode-ai npm tarball and return the path to the executable.
 *
 * The bin path differs by version: v1.4.x and earlier shipped `bin/opencode`;
 * v1.14+ renames the platform-specific binary to `bin/opencode.exe` for every
 * OS via the postinstall script. Callers pass the binPath that matches their
 * pinned version so a v1↔v2 swap can't silently install the wrong file.
 */
export async function installOpencodeCli(params: { binPath: string }): Promise<string> {
  return await installFromNpmTarball({
    packageName: "opencode-ai",
    version: getDevDependencyVersion("opencode-ai"),
    executablePath: params.binPath,
    installDependencies: true,
  });
}

// ── model auto-select fallback ──────────────────────────────────────────────────
//
// steps 1–2 of model resolution (PULLFROG_MODEL env, slug resolution) happen
// in resolveModel() in utils/agent.ts before the agent runs. this is step 3:
// auto-select via `opencode models`.

const AUTO_SELECT_WARNING =
  "select a model explicitly in the Pullfrog console (https://pullfrog.com/console) to avoid this.";

function getOpenCodeModels(cliPath: string): string[] {
  try {
    const output = execFileSync(cliPath, ["models"], {
      encoding: "utf-8",
      timeout: 30_000,
      env: process.env,
    });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    log.debug(
      `» failed to run \`opencode models\`: ${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }
}

export function autoSelectModel(cliPath: string): string | undefined {
  const availableModels = getOpenCodeModels(cliPath);
  const availableSet = new Set(availableModels);
  if (availableSet.size > 0) {
    log.debug(`» opencode models (${availableSet.size}): ${availableModels.join(", ")}`);
    // skip hidden aliases (internal subagent-tier targets like
    // opencode/gpt-5.4) — they should never surface as a user-facing
    // orchestrator pick. mirrors the selectable-list filter in
    // components/ModelSelector.tsx and action/commands/init.ts.
    const match =
      modelAliases.find((a) => !a.hidden && a.preferred && availableSet.has(a.resolve)) ??
      modelAliases.find((a) => !a.hidden && availableSet.has(a.resolve));
    if (match) {
      log.info(
        `» model: ${match.resolve} (auto-selected${match.preferred ? " — preferred" : ""} curated match)`
      );
      log.warning(`» model auto-selected. ${AUTO_SELECT_WARNING}`);
      return match.resolve;
    }
    log.info(
      `» opencode has ${availableSet.size} models but none match curated aliases — letting OpenCode auto-select`
    );
  }

  log.warning(`» no model resolved. letting OpenCode auto-select. ${AUTO_SELECT_WARNING}`);
  return undefined;
}
