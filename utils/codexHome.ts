// Codex-to-OpenCode auth bridging for the action runtime.
//
// `pullfrog auth codex` stores a Codex CLI `auth.json` blob in the Pullfrog
// per-org secret store (production Postgres) — NOT a GitHub Actions secret.
// This is non-negotiable: the OAuth refresh chain rotates on every use, and
// `entryPost.ts` writes the rotated chain back via `PUT /api/runtime/secret`
// after each run. GH Actions secrets are immutable at runtime, so a token
// stashed there silently expires on the first refresh (~1h). See
// wiki/codex-auth.md for the full constraint.
//
// At runtime, `CODEX_AUTH_JSON` lands in process.env via `runContext.dbSecrets`
// merged in main.ts — sourced from Pullfrog Postgres through the OIDC-validated
// run-context endpoint, never from `${{ secrets.CODEX_AUTH_JSON }}` in
// workflow yaml. This utility:
//
//   1. parses + validates that env value
//   2. converts Codex's shape `{ auth_mode, tokens: { access_token, refresh_token, ... } }`
//      into OpenCode's shape `{ openai: { type: "oauth", refresh, access, expires, accountId } }`
//   3. materializes it to disk at the runner's REAL `$HOME/.local/share/opencode/auth.json`
//      (NOT the per-run tmpdir's HOME)
//   4. returns the path + the original refresh token so the post-run hook
//      can detect a refresh and write back to Pullfrog
//
// Why real $HOME and not ctx.tmpdir-redirected HOME: the broad
// `external_directory: { "/tmp/*": "allow" }` rule on OpenCode would expose
// auth.json to the agent's filesystem tools if the file lived under
// `ctx.tmpdir` = `/tmp/pullfrog-*`. Real `$HOME/.local/share/opencode/...`
// falls outside that allow zone, so OpenCode's deny-default protects it
// without any new permission rules.
//
// `expires: 0` forces OpenCode to refresh on first request (we don't trust
// the in-blob freshness — the saved token was eager-refreshed once at
// `auth codex` time but may have aged since).
//
// See [wiki/codex-auth.md] for the full data-flow picture.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./cli.ts";

const CODEX_AUTH_ENV = "CODEX_AUTH_JSON";

interface CodexAuthBlob {
  auth_mode: "chatgpt";
  tokens: {
    access_token: string;
    refresh_token: string;
    id_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

interface OpenCodeAuthFile {
  openai: {
    type: "oauth";
    refresh: string;
    access: string;
    expires: number;
    accountId?: string;
  };
}

export interface InstalledCodexAuth {
  /** absolute path of the auth.json we wrote — caller passes this to the
   * post-hook via core.saveState for refresh-detection later. */
  authPath: string;
  /** value to set as XDG_DATA_HOME for the OpenCode subprocess. */
  xdgDataHome: string;
  /** refresh_token from the env at materialization time. post-hook compares
   * against the on-disk file after the run to detect whether OpenCode
   * refreshed during the session. */
  originalRefresh: string;
}

/** materialize CODEX_AUTH_JSON from env into a disk path OpenCode reads from.
 * returns null when the env var is absent, malformed, or wrong auth mode —
 * caller treats null as "no codex auth, fall through to API key flow". */
export function installCodexAuth(): InstalledCodexAuth | null {
  const raw = process.env[CODEX_AUTH_ENV];
  if (!raw) return null;

  const blob = parseCodexBlob(raw);
  if (!blob) {
    log.warning(`» ${CODEX_AUTH_ENV} present but malformed; ignoring`);
    return null;
  }

  const xdgDataHome = join(homedir(), ".local", "share");
  const opencodeDir = join(xdgDataHome, "opencode");
  const authPath = join(opencodeDir, "auth.json");

  const opencodeAuth: OpenCodeAuthFile = {
    openai: {
      type: "oauth",
      refresh: blob.tokens.refresh_token,
      access: blob.tokens.access_token,
      // expires: 0 forces OpenCode's CodexAuthPlugin to refresh on first
      // request (it checks `expires < Date.now()`). safest default — we
      // don't carry an `expires_in` from the Codex blob.
      expires: 0,
      ...(blob.tokens.account_id ? { accountId: blob.tokens.account_id } : {}),
    },
  };

  mkdirSync(opencodeDir, { recursive: true });
  writeFileSync(authPath, `${JSON.stringify(opencodeAuth, null, 2)}\n`, { mode: 0o600 });

  log.info(`» installed Codex auth at ${authPath}`);

  return { authPath, xdgDataHome, originalRefresh: blob.tokens.refresh_token };
}

function parseCodexBlob(raw: string): CodexAuthBlob | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const v = parsed as Record<string, unknown>;
  if (v.auth_mode !== "chatgpt") return null;
  const tokens = v.tokens;
  if (!tokens || typeof tokens !== "object") return null;
  const t = tokens as Record<string, unknown>;
  if (typeof t.access_token !== "string" || t.access_token.length === 0) return null;
  if (typeof t.refresh_token !== "string" || t.refresh_token.length === 0) return null;
  return {
    auth_mode: "chatgpt",
    tokens: {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      ...(typeof t.id_token === "string" ? { id_token: t.id_token } : {}),
      ...(typeof t.account_id === "string" ? { account_id: t.account_id } : {}),
    },
    ...(typeof v.last_refresh === "string" ? { last_refresh: v.last_refresh } : {}),
  };
}

/** convert an on-disk OpenCode auth.json back to the Codex CLI shape so the
 * post-hook can write it to the Pullfrog secret store. returns null when the
 * file's `openai` entry is missing, has the wrong type, or hasn't actually
 * refreshed (refresh token unchanged from `originalRefresh`). */
export function detectCodexRefresh(params: {
  authFileContent: string;
  originalRefresh: string;
}): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(params.authFileContent);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const oauth = (parsed as Record<string, unknown>).openai;
  if (!oauth || typeof oauth !== "object") return null;
  const o = oauth as Record<string, unknown>;
  if (o.type !== "oauth") return null;
  if (typeof o.refresh !== "string" || typeof o.access !== "string") return null;
  if (o.refresh === params.originalRefresh) return null;

  const codexShape: CodexAuthBlob = {
    auth_mode: "chatgpt",
    tokens: {
      access_token: o.access,
      refresh_token: o.refresh,
      ...(typeof o.accountId === "string" ? { account_id: o.accountId } : {}),
    },
    last_refresh: new Date().toISOString(),
  };
  return `${JSON.stringify(codexShape, null, 2)}\n`;
}
