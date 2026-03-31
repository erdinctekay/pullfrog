import { spawnSync } from "node:child_process";
import { log } from "./cli.ts";

export function addSkill(params: {
  ref: string;
  skill: string;
  env: Record<string, string>;
  agent: string;
}): void {
  const result = spawnSync(
    "npx",
    ["skills", "add", params.ref, "--skill", params.skill, "-g", "-a", params.agent, "-y"],
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
