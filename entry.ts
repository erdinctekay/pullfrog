#!/usr/bin/env node

/**
 * entry point for pullfrog/pullfrog - unified action
 */

import { dirname } from "node:path";
import * as core from "@actions/core";
import { main } from "./main.ts";

// GitHub Actions runs the action entry point with the node24 binary specified
// in action.yml, but doesn't add that binary's directory to PATH. Without this,
// spawned processes (pnpm, npm, etc.) resolve to the runner's default node (v20).
process.env.PATH = `${dirname(process.execPath)}:${process.env.PATH}`;

async function run(): Promise<void> {
  try {
    const result = await main();

    if (!result.success) {
      throw new Error(result.error || "Agent execution failed");
    }

    if (result.result) {
      core.setOutput("result", result.result);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
    core.setFailed(`Action failed: ${errorMessage}`);
  }
}

await run();
