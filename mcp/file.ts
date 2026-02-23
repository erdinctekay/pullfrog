import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { type } from "arktype";
import type { ShellPermission } from "../external.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

export const FileReadParams = type({
  path: "string",
  "offset?": "number",
  "limit?": "number",
});

export const FileWriteParams = type({
  path: "string",
  content: "string",
});

export const FileEditParams = type({
  path: "string",
  old_string: "string",
  new_string: "string",
  "replace_all?": "boolean",
});

export const FileDeleteParams = type({
  path: "string",
});

export const ListDirectoryParams = type({
  path: "string",
});

// SECURITY: files that git interprets and can trigger code execution.
// .gitattributes can define filter drivers (clean/smudge) that execute arbitrary commands.
// .gitmodules can reference malicious submodule URLs that execute code on update.
// only blocked when shell is disabled — in restricted mode the agent already has shell
// and could write these files via shell, so blocking via MCP is redundant.
const GIT_INTERPRETED_FILES = [".gitattributes", ".gitmodules"];

// resolve and validate a read path. allows:
// 1. paths within the repo (with symlink protection to prevent malicious PR symlinks)
// 2. paths within PULLFROG_TEMP_DIR (tool result files: diffs, CI logs, review threads, etc.)
function resolveReadPath(filePath: string): string {
  const cwd = realpathSync(process.cwd());
  const resolved = resolve(cwd, filePath);

  // allow reads from PULLFROG_TEMP_DIR (tool result files)
  const tempDir = process.env.PULLFROG_TEMP_DIR;
  if (tempDir && (resolved === tempDir || resolved.startsWith(tempDir + "/"))) {
    return resolved;
  }

  // allow reads from the repo with symlink protection.
  // threat model: a malicious PR plants symlinks (e.g. `secrets -> /etc/shadow`).
  // git materializes symlinks on linux, so after checkout the working tree contains
  // live symlinks. realpathSync catches these and blocks the read.
  if (existsSync(resolved)) {
    const real = realpathSync(resolved);
    if (real === cwd || real.startsWith(cwd + "/")) {
      return real;
    }
    throw new Error(`path must be within the repository (symlink escape blocked): ${filePath}`);
  }

  // path doesn't exist — check if it's within the repo
  if (resolved === cwd || resolved.startsWith(cwd + "/")) {
    return resolved;
  }

  throw new Error(`path must be within the repository or temp directory: ${filePath}`);
}

// resolve and validate a write path. enforces:
// - repo-scoping with symlink protection (when shell !== "enabled")
// - .git/ always blocked (defense-in-depth)
// - .gitattributes/.gitmodules blocked when shell === "disabled"
//
// when shell=enabled, repo-scoping is dropped — the agent can write anywhere via native
// shell, so restricting file_write to the repo would be security theater.
function resolveWritePath(filePath: string, shellPermission: ShellPermission): string {
  const cwd = realpathSync(process.cwd());
  const resolved = resolve(cwd, filePath);

  // repo-scoping: enforced when agent doesn't have full shell
  if (shellPermission !== "enabled") {
    if (existsSync(resolved)) {
      const real = realpathSync(resolved);
      if (real !== cwd && !real.startsWith(cwd + "/")) {
        throw new Error(`path must be within the repository (symlink escape blocked): ${filePath}`);
      }
    } else {
      // target doesn't exist yet — walk up to find the first existing ancestor
      // and verify it resolves within the repo. prevents creating files through
      // symlinked parent directories.
      let ancestor = dirname(resolved);
      while (!existsSync(ancestor)) {
        const parent = dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
      if (existsSync(ancestor)) {
        const realAncestor = realpathSync(ancestor);
        if (realAncestor !== cwd && !realAncestor.startsWith(cwd + "/")) {
          throw new Error(
            `path must be within the repository (symlink escape blocked): ${filePath}`
          );
        }
      }
      if (resolved !== cwd && !resolved.startsWith(cwd + "/")) {
        throw new Error(`path must be within the repository: ${filePath}`);
      }
    }
  }

  // .git always blocked anywhere in the path (defense-in-depth even with shell=enabled)
  if (resolved.includes("/.git/") || resolved.endsWith("/.git")) {
    throw new Error(`writing to .git is not allowed: ${filePath}`);
  }

  // git-interpreted files blocked anywhere in the path when shell is disabled
  if (shellPermission === "disabled") {
    const basename = resolved.split("/").pop() || "";
    if (GIT_INTERPRETED_FILES.includes(basename)) {
      throw new Error(
        `writing to ${basename} is not allowed when shell is ${shellPermission} (can trigger code execution via git filter drivers): ${filePath}`
      );
    }
  }

  return resolved;
}

export function FileReadTool(_ctx: ToolContext) {
  return tool({
    name: "file_read",
    description:
      "Read a file. Path is relative to the repository root, or an absolute path " +
      "to read tool result files (diffs, CI logs, etc.) from the temp directory.",
    parameters: FileReadParams,
    execute: execute(async (params) => {
      const resolved = resolveReadPath(params.path);
      const raw = readFileSync(resolved, "utf-8");
      const lines = raw.split("\n");

      const offset = params.offset;
      const limit = params.limit;

      if (offset === undefined && limit === undefined) {
        return { content: raw };
      }

      // 1-indexed line numbers, clamp to valid range
      const oneBasedOffset = offset ?? 1;
      const start = Math.max(0, oneBasedOffset - 1);
      const end = limit !== undefined ? Math.min(lines.length, start + limit) : lines.length;
      const slice = lines.slice(start, end).join("\n");
      return { content: slice };
    }),
  });
}

export function FileWriteTool(ctx: ToolContext) {
  return tool({
    name: "file_write",
    description:
      "Write content to a file. Path is relative to the repository root. " +
      "Writes to .git/ are blocked. Creates parent directories if needed.",
    parameters: FileWriteParams,
    execute: execute(async (params) => {
      const resolved = resolveWritePath(params.path, ctx.payload.shell);
      const dir = dirname(resolved);
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolved, params.content, "utf-8");
      return { path: params.path, written: true };
    }),
  });
}

export function FileEditTool(ctx: ToolContext) {
  return tool({
    name: "file_edit",
    description:
      "Replace text in a file. old_string must match exactly (including whitespace and indentation). " +
      "By default replaces a single unique occurrence — set replace_all to replace every occurrence. " +
      "Path is relative to the repository root. Writes to .git/ are blocked.",
    parameters: FileEditParams,
    execute: execute(async (params) => {
      if (params.old_string.length === 0) {
        throw new Error("old_string must not be empty");
      }
      if (params.old_string === params.new_string) {
        throw new Error("old_string and new_string are identical");
      }

      const resolved = resolveWritePath(params.path, ctx.payload.shell);
      const content = readFileSync(resolved, "utf-8");
      const count = content.split(params.old_string).length - 1;

      if (count === 0) {
        throw new Error(`old_string not found in ${params.path}`);
      }
      if (count > 1 && !params.replace_all) {
        throw new Error(
          `old_string found ${count} times in ${params.path}. Set replace_all to replace all occurrences, or include more context to make the match unique.`
        );
      }

      const updated = params.replace_all
        ? content.replaceAll(params.old_string, params.new_string)
        : content.replace(params.old_string, params.new_string);

      writeFileSync(resolved, updated, "utf-8");
      return { path: params.path, replacements: params.replace_all ? count : 1 };
    }),
  });
}

export function FileDeleteTool(ctx: ToolContext) {
  return tool({
    name: "file_delete",
    description:
      "Delete a file. Path is relative to the repository root. " +
      "Deletes to .git/ are blocked. Cannot delete directories.",
    parameters: FileDeleteParams,
    execute: execute(async (params) => {
      const resolved = resolveWritePath(params.path, ctx.payload.shell);
      unlinkSync(resolved);
      return { path: params.path, deleted: true };
    }),
  });
}

export function ListDirectoryTool(_ctx: ToolContext) {
  return tool({
    name: "list_directory",
    description:
      "List files and directories. Path is relative to the repository root, or an absolute path " +
      "to list tool result files from the temp directory. Returns entries sorted with directories first, then alphabetically.",
    parameters: ListDirectoryParams,
    execute: execute(async (params) => {
      const resolved = resolveReadPath(params.path);
      const entries = readdirSync(resolved, { withFileTypes: true });
      const sorted = entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });
      const listing = sorted.map((e) => (e.isDirectory() ? `[DIR] ${e.name}` : e.name)).join("\n");
      return { listing };
    }),
  });
}
