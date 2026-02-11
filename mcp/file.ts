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

// resolve path and validate it is within the repository.
// uses realpathSync to follow symlinks and prevent symlink-based escapes.
//
// threat model: the primary scenario where symlink protection matters is a
// malicious PR that plants symlinks in the repo (e.g. `secrets -> /etc/shadow`).
// git materializes symlinks on linux, so after checkout the working tree contains
// live symlinks. without realpathSync, file_read("secrets") would leak host files.
//
// when bash is enabled the agent can already `cat /etc/shadow` directly, so the
// symlink check is defense-in-depth for that case. the check is most meaningful
// when bash is disabled — the agent's only filesystem access is through these MCP
// tools, and pre-planted symlinks become the sole escape vector.
//
// the path traversal check (resolve + startsWith) is always useful regardless of
// bash — it blocks `../../etc/passwd` style escapes on every configuration.
function resolveAndValidatePath(filePath: string): string {
  const cwd = realpathSync(process.cwd());
  const resolved = resolve(cwd, filePath);

  // if the target exists, resolve symlinks to get the real location
  if (existsSync(resolved)) {
    const real = realpathSync(resolved);
    if (real !== cwd && !real.startsWith(cwd + "/")) {
      throw new Error(`path must be within the repository (symlink escape blocked): ${filePath}`);
    }
    return real;
  }

  // target doesn't exist yet (common for writes) — walk up to find
  // the first existing ancestor and verify it resolves within the repo.
  // this prevents creating files through symlinked parent directories.
  let ancestor = dirname(resolved);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break; // reached filesystem root
    ancestor = parent;
  }

  if (existsSync(ancestor)) {
    const realAncestor = realpathSync(ancestor);
    if (realAncestor !== cwd && !realAncestor.startsWith(cwd + "/")) {
      throw new Error(`path must be within the repository (symlink escape blocked): ${filePath}`);
    }
  }

  // also verify the resolved path (without symlink resolution) is within cwd
  if (resolved !== cwd && !resolved.startsWith(cwd + "/")) {
    throw new Error(`path must be within the repository: ${filePath}`);
  }

  return resolved;
}

// SECURITY: files that git interprets and can trigger code execution.
// .gitattributes can define filter drivers (clean/smudge) that execute arbitrary commands.
// .gitmodules can reference malicious submodule URLs that execute code on update.
// only blocked when bash is disabled — in restricted mode the agent already has bash
// and could write these files via shell, so blocking via MCP is redundant.
const GIT_INTERPRETED_FILES = [".gitattributes", ".gitmodules"];

type BashPermission = "disabled" | "restricted" | "enabled";

type ValidateWritePathParams = {
  filePath: string;
  bashPermission: BashPermission;
};

function validateWritePath(params: ValidateWritePathParams): string {
  const resolved = resolveAndValidatePath(params.filePath);
  const cwd = realpathSync(process.cwd());
  const relative = resolved.slice(cwd.length + 1);
  if (relative === ".git" || relative.startsWith(".git/")) {
    throw new Error(`writing to .git is not allowed: ${params.filePath}`);
  }

  // block git-interpreted files only when bash is disabled (no shell = no other way to create them)
  if (params.bashPermission === "disabled") {
    const basename = relative.split("/").pop() || "";
    if (GIT_INTERPRETED_FILES.includes(basename)) {
      throw new Error(
        `writing to ${basename} is not allowed when bash is ${params.bashPermission} (can trigger code execution via git filter drivers): ${params.filePath}`
      );
    }
  }

  return resolved;
}

export function FileReadTool(_ctx: ToolContext) {
  return tool({
    name: "file_read",
    description: `Read a file from the repository. Path is relative to the repository root. Only paths within the current repository are allowed.`,
    parameters: FileReadParams,
    execute: execute(async (params) => {
      const resolved = resolveAndValidatePath(params.path);
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
    description: `Write content to a file in the repository. Path is relative to the repository root. Only paths within the current repository are allowed. Writes to .git/ are blocked. Creates parent directories if needed.`,
    parameters: FileWriteParams,
    execute: execute(async (params) => {
      const resolved = validateWritePath({
        filePath: params.path,
        bashPermission: ctx.payload.bash,
      });
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
    description: `Replace text in a file. old_string must match exactly (including whitespace and indentation). By default replaces a single unique occurrence — set replace_all to replace every occurrence. Path is relative to the repository root. Writes to .git/ are blocked.`,
    parameters: FileEditParams,
    execute: execute(async (params) => {
      if (params.old_string.length === 0) {
        throw new Error("old_string must not be empty");
      }
      if (params.old_string === params.new_string) {
        throw new Error("old_string and new_string are identical");
      }

      const resolved = validateWritePath({
        filePath: params.path,
        bashPermission: ctx.payload.bash,
      });
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
    description: `Delete a file from the repository. Path is relative to the repository root. Only paths within the current repository are allowed. Deletes to .git/ are blocked. Cannot delete directories.`,
    parameters: FileDeleteParams,
    execute: execute(async (params) => {
      const resolved = validateWritePath({
        filePath: params.path,
        bashPermission: ctx.payload.bash,
      });
      unlinkSync(resolved);
      return { path: params.path, deleted: true };
    }),
  });
}

export function ListDirectoryTool(_ctx: ToolContext) {
  return tool({
    name: "list_directory",
    description: `List files and directories. Path is relative to the repository root. Only paths within the current repository are allowed. Returns entries sorted with directories first, then alphabetically.`,
    parameters: ListDirectoryParams,
    execute: execute(async (params) => {
      const resolved = resolveAndValidatePath(params.path);
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
