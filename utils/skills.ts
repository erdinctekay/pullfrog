import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { log } from "./cli.ts";

const skillsBin = resolve(import.meta.dirname, "../node_modules/.bin/skills");

export function addSkill(params: {
  ref: string;
  skill: string;
  env: Record<string, string>;
  agent: string;
}): void {
  const result = spawnSync(
    skillsBin,
    ["add", params.ref, "--skill", params.skill, "-g", "-a", params.agent, "-y"],
    {
      env: { ...process.env, ...params.env },
      stdio: "pipe",
      timeout: 30_000,
    }
  );
  if (result.status === 0) {
    log.info(`installed ${params.skill} skill (${params.agent})`);
  } else {
    log.info(`${params.skill} skill install failed: ${(result.stderr?.toString() || "").trim()}`);
  }
}
