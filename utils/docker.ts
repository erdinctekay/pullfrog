/**
 * shared docker utilities for running commands in containers.
 * used by both play.ts (dev) and test/run.ts (CI).
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

export type DockerRunContext = {
  actionDir: string;
  args: string[];
  platformName: NodeJS.Platform;
  home: string | undefined;
  env: NodeJS.ProcessEnv;
  uid: number;
  gid: number;
};

export type SshSetup = {
  sshFlags: string[];
  sshSetupCmd: string;
};

export type DockerRunArgsContext = {
  ctx: DockerRunContext;
  envFlags: string[];
  nodeCmd: string;
  sshSetup: SshSetup;
  volumeName: string;
};

export type VolumeInitContext = {
  actionDir: string;
  volumeName: string;
  uid: number;
  gid: number;
};

export function buildDockerRunContext(ctx: {
  actionDir: string;
  args: string[];
}): DockerRunContext {
  return {
    actionDir: ctx.actionDir,
    args: ctx.args,
    platformName: platform(),
    home: process.env.HOME,
    env: process.env,
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
  };
}

export function assertDockerSupported(ctx: DockerRunContext): void {
  if (ctx.platformName === "win32") {
    throw new Error("docker mode is not supported on native windows. use wsl2.");
  }
}

function buildDarwinSshSetup(ctx: DockerRunContext): SshSetup {
  const sshFlags: string[] = [];
  const sshSetupCmd = "";
  if (ctx.home) {
    const knownHostsPath = join(ctx.home, ".ssh", "known_hosts");
    if (existsSync(knownHostsPath)) {
      sshFlags.push("-v", `${knownHostsPath}:/root/.ssh/known_hosts:ro`);
    }
  }
  sshFlags.push(
    "-v",
    "/run/host-services/ssh-auth.sock:/run/host-services/ssh-auth.sock",
    "-e",
    "SSH_AUTH_SOCK=/run/host-services/ssh-auth.sock"
  );
  return { sshFlags, sshSetupCmd };
}

function buildLinuxSshSetup(ctx: DockerRunContext): SshSetup {
  const sshFlags: string[] = [];
  let sshSetupCmd = "";
  if (ctx.home) {
    const sshDir = join(ctx.home, ".ssh");
    if (existsSync(sshDir)) {
      sshFlags.push("-v", `${sshDir}:/tmp/.ssh-host:ro`);
      sshSetupCmd =
        "mkdir -p /tmp/home/.ssh && cp /tmp/.ssh-host/id_* /tmp/home/.ssh/ 2>/dev/null; chmod 600 /tmp/home/.ssh/id_* 2>/dev/null; " +
        "ssh-keyscan -t ed25519,rsa github.com >> /tmp/home/.ssh/known_hosts 2>/dev/null; chmod 644 /tmp/home/.ssh/known_hosts; " +
        "export GIT_SSH_COMMAND='ssh -i /tmp/home/.ssh/id_rsa -o UserKnownHostsFile=/tmp/home/.ssh/known_hosts -o StrictHostKeyChecking=no'; ";
    }
  }
  return { sshFlags, sshSetupCmd };
}

export function buildSshSetup(ctx: DockerRunContext): SshSetup {
  if (ctx.platformName === "darwin") {
    return buildDarwinSshSetup(ctx);
  }
  return buildLinuxSshSetup(ctx);
}

// allowlist of env vars to pass through to the container for test isolation
const testEnvAllowList = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_REPOSITORY",
  "GITHUB_APP_ID",
  "GITHUB_PRIVATE_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "CURSOR_API_KEY",
  "LOG_LEVEL",
  "DEBUG",
  "NODE_ENV",
  "PLAY_LOCAL",
  "HOME",
  "USER",
  "SSH_AUTH_SOCK",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "GITHUB_API_URL",
  "GITHUB_SERVER_URL",
  "GITHUB_GRAPHQL_URL",
]);

export type EnvFilterMode = "allowlist" | "passthrough";

export function buildEnvFlags(ctx: DockerRunContext, mode: EnvFilterMode): string[] {
  const envFlags: string[] = [];
  const entries = Object.entries(ctx.env);

  for (const entry of entries) {
    const key = entry[0];
    const value = entry[1];

    if (value === undefined) continue;

    if (mode === "passthrough" || testEnvAllowList.has(key)) {
      envFlags.push("-e", `${key}=${value}`);
    }
  }
  return envFlags;
}

export function initializeNodeModulesVolume(ctx: VolumeInitContext): void {
  spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${ctx.volumeName}:/app/action/node_modules`,
      "node:24",
      "chown",
      "-R",
      `${ctx.uid}:${ctx.gid}`,
      "/app/action/node_modules",
    ],
    { stdio: "ignore", cwd: ctx.actionDir }
  );
}

export function buildDockerRunArgs(config: DockerRunArgsContext): string[] {
  const args: string[] = [
    "run",
    "--rm",
    "-t",
    "--user",
    `${config.ctx.uid}:${config.ctx.gid}`,
    "-v",
    `${config.ctx.actionDir}:/app/action:cached`,
    "-v",
    `${config.volumeName}:/app/action/node_modules`,
    "-w",
    "/app/action",
  ];
  args.push(...config.envFlags);
  args.push(...config.sshSetup.sshFlags);
  args.push(
    "-e",
    "COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
    "-e",
    "HOME=/tmp/home",
    "-e",
    "TMPDIR=/tmp",
    "node:24",
    "bash",
    "-c",
    `${config.sshSetup.sshSetupCmd}mkdir -p /tmp/home/.config /tmp/home/.cache && corepack pnpm install --frozen-lockfile --ignore-scripts && ${config.nodeCmd}`
  );
  return args;
}

export type RunInDockerOptions = {
  actionDir: string;
  args: string[];
  nodeCmd: string;
  volumeName: string;
  envFilterMode: EnvFilterMode;
  onStart?: () => void;
};

export function runInDocker(options: RunInDockerOptions): SpawnSyncReturns<Buffer> {
  const ctx = buildDockerRunContext({
    actionDir: options.actionDir,
    args: options.args,
  });
  assertDockerSupported(ctx);

  const sshSetup = buildSshSetup(ctx);
  const envFlags = buildEnvFlags(ctx, options.envFilterMode);

  initializeNodeModulesVolume({
    actionDir: ctx.actionDir,
    volumeName: options.volumeName,
    uid: ctx.uid,
    gid: ctx.gid,
  });

  if (options.onStart) {
    options.onStart();
  }

  return spawnSync(
    "docker",
    buildDockerRunArgs({
      ctx,
      envFlags,
      nodeCmd: options.nodeCmd,
      sshSetup,
      volumeName: options.volumeName,
    }),
    { stdio: "inherit", cwd: ctx.actionDir }
  );
}
