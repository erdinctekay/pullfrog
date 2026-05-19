import { spawnSync } from "node:child_process";
import { type EnvMode, resolveEnv } from "./secrets.ts";

interface ShellOptions {
  cwd?: string;
  encoding?:
    | "utf-8"
    | "utf8"
    | "ascii"
    | "base64"
    | "base64url"
    | "hex"
    | "latin1"
    | "ucs-2"
    | "ucs2"
    | "utf16le";
  log?: boolean;
  /**
   * env mode: "restricted" (default) filters secrets, "inherit" passes full env,
   * or provide a custom env object (merged with restricted base)
   */
  env?: EnvMode;
  onError?: (result: { status: number; stdout: string; stderr: string }) => void;
}

/**
 * Execute a shell command safely using spawnSync with argument arrays.
 * Prevents shell injection by avoiding string interpolation in shell commands.
 *
 * SECURITY: by default, env vars are filtered to remove secrets (tokens, keys, passwords).
 * this prevents malicious code (git hooks, npm scripts, etc.) from exfiltrating credentials.
 * use env: "inherit" only when absolutely necessary.
 *
 * @param cmd - The command to execute
 * @param args - Array of arguments to pass to the command
 * @param options - Optional configuration (cwd, encoding, onError)
 * @returns The trimmed stdout output
 * @throws Error if command fails and no onError handler is provided
 */
export function $(cmd: string, args: string[], options?: ShellOptions): string {
  const encoding = options?.encoding ?? "utf-8";
  const env = resolveEnv(options?.env);

  // CRITICAL: use "ignore" for stdin instead of "inherit" to avoid breaking MCP transport
  // when running inside an MCP server, stdin is used for JSON-RPC protocol
  const result = spawnSync(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding,
    cwd: options?.cwd,
    env,
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  // Write output to process streams so it behaves like stdio: "inherit"
  // CRITICAL: when running inside an MCP server, stdout is used for JSON-RPC protocol
  // so we must write to stderr instead to avoid corrupting the protocol
  // Only log if log option is not explicitly set to false
  if (options?.log !== false) {
    // if stdout is a TTY, it's safe to write to it; otherwise it's likely a pipe used for JSON-RPC
    const canWriteToStdout = process.stdout.isTTY === true;
    if (stdout) {
      if (canWriteToStdout) {
        process.stdout.write(stdout);
      } else {
        // stdout is a pipe (MCP context) - write to stderr instead
        process.stderr.write(stdout);
      }
    }
    if (stderr) {
      process.stderr.write(stderr);
    }
  }

  // Handle errors
  if (result.status !== 0) {
    const errorResult = {
      status: result.status ?? -1,
      stdout,
      stderr,
    };

    if (options?.onError) {
      options.onError(errorResult);
      return stdout.trim();
    }

    // many git subcommands write context-bearing diagnostics to stdout, not
    // stderr (merge conflicts, cherry-pick rejections, diff --exit-code,
    // ls-files --error-unmatch). Falling back to "Unknown error" robbed the
    // agent of any signal and forced an extra MCP round-trip. see #766.
    const detail = [stderr, stdout]
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `Command failed with exit code ${errorResult.status}: ${detail || "Unknown error"}`
    );
  }

  return stdout.trim();
}
