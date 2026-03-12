/**
 * smoke test: runs `opencode run` with each resolved model to verify they work.
 * usage: node --env-file=../../.env action/test/smoke-models.ts
 */

import { execFileSync } from "node:child_process";
import { modelAliases, type ProviderConfig, providers } from "../models.ts";

const TIMEOUT_MS = 60_000;
const PROMPT = "respond with just the word hello";

const availableKeys = new Set<string>();
for (const config of Object.values(providers) as ProviderConfig[]) {
  for (const envVar of config.envVars) {
    if (process.env[envVar]) availableKeys.add(envVar);
  }
}

function hasKey(providerKey: string): boolean {
  const config = (providers as Record<string, ProviderConfig>)[providerKey];
  if (!config) return false;
  if (config.envVars.length === 0) return true;
  return config.envVars.some((v) => process.env[v]);
}

const results: { model: string; status: "pass" | "fail" | "skip"; detail?: string }[] = [];

const seen = new Set<string>();

for (const alias of modelAliases) {
  if (seen.has(alias.resolve)) {
    results.push({ model: alias.resolve, status: "skip", detail: "duplicate resolve" });
    continue;
  }
  seen.add(alias.resolve);

  if (!hasKey(alias.provider)) {
    results.push({ model: alias.resolve, status: "skip", detail: `no key for ${alias.provider}` });
    continue;
  }

  process.stdout.write(`testing ${alias.resolve} ... `);

  try {
    const out = execFileSync("opencode", ["run", "-m", alias.resolve, PROMPT], {
      timeout: TIMEOUT_MS,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    const trimmed = out.trim().toLowerCase();
    if (trimmed.includes("hello")) {
      console.log("PASS");
      results.push({ model: alias.resolve, status: "pass" });
    } else if (trimmed.length === 0) {
      console.log("FAIL (empty output)");
      results.push({ model: alias.resolve, status: "fail", detail: "empty output" });
    } else {
      console.log("PASS (got response)");
      results.push({ model: alias.resolve, status: "pass", detail: trimmed.slice(0, 80) });
    }
  } catch (err: any) {
    if (err.killed) {
      console.log(`TIMEOUT (${TIMEOUT_MS / 1000}s)`);
      results.push({ model: alias.resolve, status: "fail", detail: "timeout" });
    } else {
      const msg =
        err.stderr?.toString().trim().slice(0, 120) ||
        err.message?.slice(0, 120) ||
        "unknown error";
      console.log(`FAIL (${msg})`);
      results.push({ model: alias.resolve, status: "fail", detail: msg });
    }
  }
}

console.log("\n=== results ===");
const passed = results.filter((r) => r.status === "pass");
const failed = results.filter((r) => r.status === "fail");
const skipped = results.filter((r) => r.status === "skip");

console.log(`passed: ${passed.length}, failed: ${failed.length}, skipped: ${skipped.length}`);

if (failed.length > 0) {
  console.log("\nfailures:");
  for (const f of failed) {
    console.log(`  ${f.model}: ${f.detail}`);
  }
}

if (skipped.length > 0) {
  console.log("\nskipped:");
  for (const s of skipped) {
    console.log(`  ${s.model}: ${s.detail}`);
  }
}

process.exit(failed.length > 0 ? 1 : 0);
