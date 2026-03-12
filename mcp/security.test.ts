import { describe, expect, it } from "vitest";

// ─── git tool security tests ────────────────────────────────────────────

// re-create the validation logic from git.ts for unit testing
const AUTH_REQUIRED_REDIRECT: Record<string, string> = {
  push: "Use push_branch tool instead.",
  fetch: "Use git_fetch tool instead.",
  pull: "Use git_fetch + git merge instead.",
  clone: "Repository already cloned. Use checkout_pr for PR branches.",
};

// only blocked when shell is disabled — in restricted mode the agent has shell
// in a stripped sandbox so blocking these is redundant
const NOSHELL_BLOCKED_SUBCOMMANDS: Record<string, string> = {
  config: "Blocked: git config can set up filter drivers or hooks that execute arbitrary code.",
  submodule:
    "Blocked: git submodule can reference malicious repositories and execute code on update.",
  "update-index":
    "Blocked: git update-index can modify index entries in ways that bypass file protections.",
  "filter-branch": "Blocked: git filter-branch executes arbitrary code on repository history.",
  replace: "Blocked: git replace can redirect object lookups.",
  rebase: "Blocked: git rebase --exec can execute arbitrary shell commands.",
  bisect: "Blocked: git bisect run can execute arbitrary shell commands.",
};

const NOSHELL_BLOCKED_ARGS = ["--exec", "--extcmd", "--upload-pack", "--receive-pack"];

type ShellPermission = "disabled" | "restricted" | "enabled";

type ValidateGitParams = {
  subcommand: string;
  args: string[];
  shellPermission: ShellPermission;
};

// matches the arkregex pattern used in the Git schema
const SUBCOMMAND_PATTERN = /^[a-z][a-z0-9-]*$/;

// mirrors the validation logic in GitTool.execute
function validateGitCommand(params: ValidateGitParams): string | null {
  // schema-level regex validation — applies in ALL modes
  if (!SUBCOMMAND_PATTERN.test(params.subcommand)) {
    return `subcommand must be Git subcommand (was "${params.subcommand}")`;
  }

  const redirect = AUTH_REQUIRED_REDIRECT[params.subcommand];
  if (redirect) {
    return `git ${params.subcommand} requires authentication. ${redirect}`;
  }

  // subcommand and arg blocking only applies when shell is disabled
  if (params.shellPermission === "disabled") {
    const blocked = NOSHELL_BLOCKED_SUBCOMMANDS[params.subcommand];
    if (blocked) {
      return blocked;
    }

    for (const arg of params.args) {
      const isBlocked = NOSHELL_BLOCKED_ARGS.some(
        (flag) => arg === flag || arg.startsWith(flag + "=")
      );
      if (isBlocked) {
        return `Blocked: '${arg}' flag can execute arbitrary code and is not allowed.`;
      }
    }
  }

  return null; // no error
}

describe("git tool security - subcommand regex validation", () => {
  it("blocks -c flag as subcommand in ALL modes (alias injection)", () => {
    const modes: ShellPermission[] = ["disabled", "restricted", "enabled"];
    for (const mode of modes) {
      const error = validateGitCommand({
        subcommand: "-c",
        args: ["alias.x=!evil-command", "x"],
        shellPermission: mode,
      });
      expect(error).toContain("Git subcommand");
    }
  });

  it("blocks --exec-path as subcommand", () => {
    const error = validateGitCommand({
      subcommand: "--exec-path=/malicious",
      args: ["status"],
      shellPermission: "disabled",
    });
    expect(error).toContain("Git subcommand");
  });

  it("blocks -C as subcommand (change directory)", () => {
    const error = validateGitCommand({
      subcommand: "-C",
      args: ["/tmp", "init"],
      shellPermission: "disabled",
    });
    expect(error).toContain("Git subcommand");
  });

  it("blocks --config-env as subcommand", () => {
    const error = validateGitCommand({
      subcommand: "--config-env",
      args: ["core.pager=PATH", "log"],
      shellPermission: "disabled",
    });
    expect(error).toContain("Git subcommand");
  });

  it("blocks all flags starting with - as subcommand", () => {
    const flags = ["-c", "-C", "-p", "--paginate", "--git-dir", "--work-tree", "--bare"];
    for (const flag of flags) {
      const error = validateGitCommand({
        subcommand: flag,
        args: [],
        shellPermission: "disabled",
      });
      expect(error).toContain("Git subcommand");
    }
  });

  it("blocks uppercase subcommands", () => {
    const error = validateGitCommand({
      subcommand: "STATUS",
      args: [],
      shellPermission: "disabled",
    });
    expect(error).toContain("Git subcommand");
  });

  it("blocks subcommands with special characters", () => {
    const bad = ["git;evil", "status$(cmd)", "log|cat", "diff&bg"];
    for (const sub of bad) {
      const error = validateGitCommand({
        subcommand: sub,
        args: [],
        shellPermission: "disabled",
      });
      expect(error).toContain("Git subcommand");
    }
  });

  it("allows valid subcommands", () => {
    const safe = ["status", "log", "diff", "show", "branch", "tag", "stash", "blame"];
    for (const sub of safe) {
      const error = validateGitCommand({
        subcommand: sub,
        args: [],
        shellPermission: "disabled",
      });
      expect(error).toBeNull();
    }
  });

  it("allows hyphenated subcommands", () => {
    const safe = ["filter-branch", "update-index", "ls-remote", "ls-files", "rev-parse"];
    for (const sub of safe) {
      const error = validateGitCommand({
        subcommand: sub,
        args: [],
        shellPermission: "enabled",
      });
      expect(error).toBeNull();
    }
  });
});

describe("git tool security - blocked subcommands (disabled mode only)", () => {
  it("blocks config in disabled mode", () => {
    const error = validateGitCommand({
      subcommand: "config",
      args: ["core.hooksPath", "./hooks"],
      shellPermission: "disabled",
    });
    expect(error).toContain("git config");
  });

  it("allows config in restricted mode (agent has shell)", () => {
    const error = validateGitCommand({
      subcommand: "config",
      args: ["filter.evil.clean", "bash -c 'evil'"],
      shellPermission: "restricted",
    });
    expect(error).toBeNull();
  });

  it("blocks submodule in disabled mode", () => {
    const error = validateGitCommand({
      subcommand: "submodule",
      args: ["add", "https://evil.com/repo.git"],
      shellPermission: "disabled",
    });
    expect(error).toContain("submodule");
  });

  it("allows submodule in restricted mode", () => {
    const error = validateGitCommand({
      subcommand: "submodule",
      args: ["add", "https://example.com/repo.git"],
      shellPermission: "restricted",
    });
    expect(error).toBeNull();
  });

  it("blocks rebase in disabled mode", () => {
    const error = validateGitCommand({
      subcommand: "rebase",
      args: ["--exec", "evil-command", "HEAD~1"],
      shellPermission: "disabled",
    });
    expect(error).toContain("rebase");
  });

  it("allows rebase in restricted mode", () => {
    const error = validateGitCommand({
      subcommand: "rebase",
      args: ["main"],
      shellPermission: "restricted",
    });
    expect(error).toBeNull();
  });

  it("blocks bisect in disabled mode", () => {
    const error = validateGitCommand({
      subcommand: "bisect",
      args: ["run", "evil-command"],
      shellPermission: "disabled",
    });
    expect(error).toContain("bisect");
  });

  it("blocks filter-branch in disabled mode", () => {
    const error = validateGitCommand({
      subcommand: "filter-branch",
      args: ["--tree-filter", "evil-command", "HEAD"],
      shellPermission: "disabled",
    });
    expect(error).toContain("filter-branch");
  });

  it("allows blocked subcommands in enabled mode", () => {
    const blocked = ["config", "submodule", "rebase", "bisect", "filter-branch"];
    for (const sub of blocked) {
      const error = validateGitCommand({
        subcommand: sub,
        args: [],
        shellPermission: "enabled",
      });
      expect(error).toBeNull();
    }
  });

  it("allows blocked subcommands in restricted mode (stripped env is security boundary)", () => {
    const blocked = ["config", "submodule", "rebase", "bisect", "filter-branch"];
    for (const sub of blocked) {
      const error = validateGitCommand({
        subcommand: sub,
        args: [],
        shellPermission: "restricted",
      });
      expect(error).toBeNull();
    }
  });
});

describe("git tool security - blocked arg flags (disabled mode only)", () => {
  it("blocks --exec in args (disabled)", () => {
    const error = validateGitCommand({
      subcommand: "log",
      args: ["--exec", "evil-command"],
      shellPermission: "disabled",
    });
    expect(error).toContain("arbitrary code");
  });

  it("blocks --exec= in args (disabled)", () => {
    const error = validateGitCommand({
      subcommand: "log",
      args: ["--exec=evil-command"],
      shellPermission: "disabled",
    });
    expect(error).toContain("arbitrary code");
  });

  it("blocks --extcmd in args (disabled)", () => {
    const error = validateGitCommand({
      subcommand: "difftool",
      args: ["--extcmd=evil-command", "HEAD~1"],
      shellPermission: "disabled",
    });
    expect(error).toContain("arbitrary code");
  });

  it("blocks --upload-pack in args (disabled)", () => {
    const error = validateGitCommand({
      subcommand: "ls-remote",
      args: ["--upload-pack=evil"],
      shellPermission: "disabled",
    });
    expect(error).toContain("arbitrary code");
  });

  it("allows --exec in restricted mode (agent has shell)", () => {
    const error = validateGitCommand({
      subcommand: "rebase",
      args: ["--exec", "npm test", "HEAD~1"],
      shellPermission: "restricted",
    });
    expect(error).toBeNull();
  });

  it("allows --extcmd in restricted mode", () => {
    const error = validateGitCommand({
      subcommand: "difftool",
      args: ["--extcmd=less"],
      shellPermission: "restricted",
    });
    expect(error).toBeNull();
  });

  it("allows blocked args in enabled mode", () => {
    const error = validateGitCommand({
      subcommand: "difftool",
      args: ["--extcmd=less"],
      shellPermission: "enabled",
    });
    expect(error).toBeNull();
  });

  it("allows normal args in disabled mode", () => {
    const error = validateGitCommand({
      subcommand: "log",
      args: ["--oneline", "-10", "--format=%H %s"],
      shellPermission: "disabled",
    });
    expect(error).toBeNull();
  });

  it("does not false-positive on --exclude-standard (not --exec)", () => {
    const error = validateGitCommand({
      subcommand: "ls-files",
      args: ["--exclude-standard"],
      shellPermission: "disabled",
    });
    expect(error).toBeNull();
  });

  it("does not false-positive on --execute (not --exec=)", () => {
    const error = validateGitCommand({
      subcommand: "log",
      args: ["--execute-something"],
      shellPermission: "disabled",
    });
    expect(error).toBeNull();
  });

  it("does not false-positive on -c (combined diff format for git log)", () => {
    const error = validateGitCommand({
      subcommand: "log",
      args: ["-c", "--oneline"],
      shellPermission: "disabled",
    });
    expect(error).toBeNull();
  });
});

describe("git tool security - auth redirect", () => {
  it("redirects push in all modes", () => {
    const modes: ShellPermission[] = ["disabled", "restricted", "enabled"];
    for (const mode of modes) {
      const error = validateGitCommand({
        subcommand: "push",
        args: [],
        shellPermission: mode,
      });
      expect(error).toContain("authentication");
    }
  });

  it("redirects fetch", () => {
    const error = validateGitCommand({
      subcommand: "fetch",
      args: [],
      shellPermission: "enabled",
    });
    expect(error).toContain("authentication");
  });

  it("redirects pull", () => {
    const error = validateGitCommand({
      subcommand: "pull",
      args: [],
      shellPermission: "enabled",
    });
    expect(error).toContain("authentication");
  });

  it("redirects clone", () => {
    const error = validateGitCommand({
      subcommand: "clone",
      args: [],
      shellPermission: "enabled",
    });
    expect(error).toContain("authentication");
  });
});

// ─── dependency install security tests ──────────────────────────────────

// mirrors the logic in dependencies.ts startInstallation()
function shouldIgnoreScripts(shellPermission: ShellPermission): boolean {
  return shellPermission === "disabled";
}

describe("dependency install - ignore-scripts logic", () => {
  it("ignoreScripts is true when shell is disabled", () => {
    expect(shouldIgnoreScripts("disabled")).toBe(true);
  });

  it("ignoreScripts is false when shell is restricted (scripts run in stripped env)", () => {
    expect(shouldIgnoreScripts("restricted")).toBe(false);
  });

  it("ignoreScripts is false when shell is enabled", () => {
    expect(shouldIgnoreScripts("enabled")).toBe(false);
  });
});
