import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { agentsManifest, type WorkflowPermissions } from "../external.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const actionDir = join(__dirname, "..");
const rootDir = join(actionDir, "..");

type WorkflowJob = {
  "runs-on": string;
  "timeout-minutes"?: number;
  permissions?: WorkflowPermissions;
  strategy?: { "fail-fast": boolean; matrix: Record<string, string[]> };
  env?: Record<string, string>;
  steps?: unknown[];
};

type Workflow = {
  name: string;
  jobs: Record<string, WorkflowJob>;
};

const rootWorkflow = parse(
  readFileSync(join(rootDir, ".github/workflows/test.yml"), "utf-8")
) as Workflow;
const actionWorkflow = parse(
  readFileSync(join(actionDir, ".github/workflows/test.yml"), "utf-8")
) as Workflow;

// read test names from .ts files in a test directory.
// matches `name: "xxx"` at the start of a line (with indentation) to skip
// inline validator check names like `{ name: "set_output", ... }`.
function getTestNamesFromDir(dir: string): string[] {
  const dirPath = join(__dirname, dir);
  const files = readdirSync(dirPath).filter((f) => f.endsWith(".ts"));
  const names: string[] = [];

  for (const file of files) {
    const content = readFileSync(join(dirPath, file), "utf-8");
    const match = content.match(/^\s+name:\s*"([^"]+)"/m);
    if (match) {
      names.push(match[1]);
    }
  }

  return names.sort();
}

function getEnvVarNames(job: WorkflowJob): string[] {
  return Object.keys(job.env ?? {}).sort();
}

const expectedAgents = Object.keys(agentsManifest).sort();
const crossagentTests = getTestNamesFromDir("crossagent");
const agnosticTests = getTestNamesFromDir("agnostic");
const adhocTests = getTestNamesFromDir("adhoc");
const dynamicAgentsExpression = "$" + "{{ fromJSON(needs.changes.outputs.agents) }}";

// all API key names from all agents + GITHUB_TOKEN + model overrides
const expectedAgentEnvVars = [
  "GITHUB_TOKEN",
  ...new Set(Object.values(agentsManifest).flatMap((a) => a.apiKeyNames)),
  "GEMINI_MODEL",
  "OPENCODE_MODEL",
].sort();

// agnostic tests only run with claude
const expectedAgnosticEnvVars = ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"].sort();

describe("ci workflow consistency", () => {
  it("workflow names match", () => {
    expect(rootWorkflow.name).toBe(actionWorkflow.name);
  });

  it("no duplicate test names across directories", () => {
    const allNames = [...crossagentTests, ...agnosticTests, ...adhocTests];
    const duplicates = allNames.filter((name, idx) => allNames.indexOf(name) !== idx);
    expect(duplicates).toEqual([]);
  });

  describe("cross-agent tests", () => {
    const rootJob = rootWorkflow.jobs["action-agents"];
    const actionJob = actionWorkflow.jobs.agents;

    it("root agent matrix uses dynamic output from changes job", () => {
      expect(rootJob.strategy!.matrix.agent).toBe(dynamicAgentsExpression);
    });

    it("changed-agents.sh falls back to claude when shared agent code changed", () => {
      const input = JSON.stringify(["action/agents/shared.ts"]);
      const output = execFileSync("bash", [join(__dirname, "changed-agents.sh")], {
        input,
        encoding: "utf-8",
      });
      expect(JSON.parse(output)).toEqual(["claude"]);
    });

    it("changed-agents.sh falls back to claude for non-agent action changes", () => {
      const output = execFileSync("bash", [join(__dirname, "changed-agents.sh")], {
        input: JSON.stringify(["action/mcp/delegate.ts"]),
        encoding: "utf-8",
      });
      expect(JSON.parse(output)).toEqual(["claude"]);
    });

    it("action agent matrix matches agentsManifest", () => {
      expect([...actionJob.strategy!.matrix.agent].sort()).toEqual(expectedAgents);
    });

    it("root test matrix matches crossagent/ directory", () => {
      expect([...rootJob.strategy!.matrix.test].sort()).toEqual(crossagentTests);
    });

    it("action test matrix matches crossagent/ directory", () => {
      expect([...actionJob.strategy!.matrix.test].sort()).toEqual(crossagentTests);
    });

    it("permissions match between root and action", () => {
      expect(rootJob.permissions).toEqual(actionJob.permissions);
    });

    it("timeout-minutes match between root and action", () => {
      expect(rootJob["timeout-minutes"]).toEqual(actionJob["timeout-minutes"]);
    });

    it("env vars match between root and action", () => {
      expect(getEnvVarNames(rootJob)).toEqual(getEnvVarNames(actionJob));
    });

    it("env vars cover all agent API keys", () => {
      expect(getEnvVarNames(rootJob)).toEqual(expectedAgentEnvVars);
    });

    it("fail-fast is enabled in both", () => {
      expect(rootJob.strategy!["fail-fast"]).toBe(true);
      expect(actionJob.strategy!["fail-fast"]).toBe(true);
    });
  });

  describe("agnostic tests", () => {
    const rootJob = rootWorkflow.jobs["action-agnostic"];
    const actionJob = actionWorkflow.jobs.agnostic;

    it("root test matrix matches agnostic/ directory", () => {
      expect([...rootJob.strategy!.matrix.test].sort()).toEqual(agnosticTests);
    });

    it("action test matrix matches agnostic/ directory", () => {
      expect([...actionJob.strategy!.matrix.test].sort()).toEqual(agnosticTests);
    });

    it("permissions match between root and action", () => {
      expect(rootJob.permissions).toEqual(actionJob.permissions);
    });

    it("timeout-minutes match between root and action", () => {
      expect(rootJob["timeout-minutes"]).toEqual(actionJob["timeout-minutes"]);
    });

    it("env vars match between root and action", () => {
      expect(getEnvVarNames(rootJob)).toEqual(getEnvVarNames(actionJob));
    });

    it("env vars are correct for claude-only tests", () => {
      expect(getEnvVarNames(rootJob)).toEqual(expectedAgnosticEnvVars);
    });

    it("fail-fast is enabled in both", () => {
      expect(rootJob.strategy!["fail-fast"]).toBe(true);
      expect(actionJob.strategy!["fail-fast"]).toBe(true);
    });
  });
});
