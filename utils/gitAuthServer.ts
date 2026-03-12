/**
 * ASKPASS-based git authentication server.
 *
 * serves tokens via a localhost HTTP server with single-use UUID codes.
 * each $git() call gets a unique askpass script with the port+code baked in.
 * the token never appears in subprocess env — only the script file path.
 *
 * tamper-evident: if a code is used twice, the second request triggers
 * immediate token revocation via the GitHub API as a precaution.
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { log } from "./cli.ts";

type CodeState = "pending" | "consumed";

type PendingCode = {
  token: string;
  state: CodeState;
  timeout: NodeJS.Timeout;
};

const CODE_TTL_MS = 5 * 60 * 1000;
const TAMPER_WINDOW_MS = 60_000;

export type GitAuthServer = {
  port: number;
  register: (token: string) => string;
  writeAskpassScript: (code: string) => string;
  close: () => Promise<void>;
  [Symbol.asyncDispose]: () => Promise<void>;
};

function revokeGitHubToken(token: string): void {
  fetch("https://api.github.com/installation/token", {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "pullfrog",
    },
  }).then(
    (r) => log.info(`token revocation response: ${r.status}`),
    () => log.warning("token revocation request failed")
  );
}

export async function startGitAuthServer(tmpdir: string): Promise<GitAuthServer> {
  const codes = new Map<string, PendingCode>();

  const server = createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }

    const code = req.url?.slice(1);
    if (!code) {
      res.writeHead(400).end();
      return;
    }

    const entry = codes.get(code);
    if (!entry) {
      res.writeHead(404).end();
      return;
    }

    if (entry.state === "pending") {
      // first use — return token, keep entry for tamper detection
      entry.state = "consumed";
      clearTimeout(entry.timeout);
      entry.timeout = setTimeout(() => codes.delete(code), TAMPER_WINDOW_MS);
      entry.timeout.unref();
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(entry.token);
      return;
    }

    // second request for same code — revoke token as a precaution
    log.info("askpass code used twice — revoking token");
    revokeGitHubToken(entry.token);
    clearTimeout(entry.timeout);
    codes.delete(code);
    res.writeHead(409, { "Content-Type": "text/plain" });
    res.end("compromised");
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const rawAddr = server.address();
  if (!rawAddr || typeof rawAddr === "string") {
    throw new Error("git auth server failed to bind");
  }
  const port = rawAddr.port;

  log.debug(`git auth server listening on 127.0.0.1:${port}`);

  function register(token: string): string {
    const code = randomUUID();
    const timeout = setTimeout(() => {
      codes.delete(code);
      log.debug(`git auth code expired: ${code.slice(0, 8)}...`);
    }, CODE_TTL_MS);
    timeout.unref();
    codes.set(code, { token, state: "pending", timeout });
    return code;
  }

  function writeAskpassScript(code: string): string {
    const scriptId = randomUUID();
    const scriptName = `askpass-${scriptId}.js`;
    const scriptPath = join(tmpdir, scriptName);

    // standalone node script — no project dependencies.
    // git calls this twice: once for "Username for ..." and once for "Password for ...".
    // username: return "x-access-token" locally (no server call).
    // password: fetch token from auth server, self-delete, return token.
    // 409 = code was already consumed by another process (tamper detected).
    const content = [
      `#!/usr/bin/env node`,
      `var a=process.argv[2]||"";`,
      `if(/^Username/i.test(a)){process.stdout.write("x-access-token\\n")}`,
      `else{var h=require("http");`,
      `h.get("http://127.0.0.1:${port}/${code}",function(r){`,
      `if(r.statusCode===409){process.stderr.write("askpass-compromised\\n");process.exit(1)}`,
      `if(r.statusCode!==200){process.exit(1)}`,
      `var d="";r.on("data",function(c){d+=c});`,
      `r.on("end",function(){`,
      `process.stdout.write(d+"\\n");`,
      `try{require("fs").unlinkSync("${scriptPath.replace(/\\/g, "\\\\")}")}catch(e){}`,
      `})}).on("error",function(){process.exit(1)})}`,
    ].join("\n");

    writeFileSync(scriptPath, content, { mode: 0o700 });
    return scriptPath;
  }

  async function close(): Promise<void> {
    for (const entry of codes.values()) {
      clearTimeout(entry.timeout);
    }
    codes.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    log.debug("git auth server closed");
  }

  return {
    port,
    register,
    writeAskpassScript,
    close,
    [Symbol.asyncDispose]: close,
  };
}
