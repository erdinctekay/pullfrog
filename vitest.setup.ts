import { resolve } from "node:path";
import { config } from "dotenv";
import { ensureGitHubToken } from "./utils/github.ts";

config({ path: resolve(import.meta.dirname, "../.env") });

await ensureGitHubToken();
