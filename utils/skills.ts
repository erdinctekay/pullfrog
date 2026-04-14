import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { log } from "./cli.ts";
import { getDevDependencyVersion } from "./version.ts";

const skillsVersion = getDevDependencyVersion("skills");

/**
 * install a skill globally via the `skills` CLI.
 *
 * runs `npx skills add <ref> --skill <name> -g` with `cwd` set to os tmpdir
 * so npm doesn't walk up and find a project-level `.npmrc` with pnpm-specific
 * settings (e.g. `public-hoist-pattern`) that break npx binary resolution.
 * the `-g` flag writes to `$HOME/.agents/skills/` which is controlled by
 * `params.env.HOME` (the fake HOME), so cwd has no effect on install location.
 */
export function addSkill(params: {
  ref: string;
  skill: string;
  env: Record<string, string>;
  agent: string;
}): void {
  const result = spawnSync(
    "npx",
    [
      "-y",
      `skills@${skillsVersion}`,
      "add",
      params.ref,
      "--skill",
      params.skill,
      "-g",
      "-a",
      params.agent,
      "-y",
    ],
    {
      cwd: tmpdir(),
      env: { ...process.env, ...params.env },
      stdio: "pipe",
      timeout: 30_000,
    }
  );
  if (result.status === 0) {
    log.info(`installed ${params.skill} skill (${params.agent})`);
  } else {
    const stderr = (result.stderr?.toString() || "").trim();
    const errorMsg = result.error ? result.error.message : stderr;
    log.info(`${params.skill} skill install failed: ${errorMsg}`);
  }
}
