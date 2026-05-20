// thin CLI for ad-hoc fixture runs against the Pullfrog action.
//
// invoke from the repo root:
//   pnpm play [args…]            # host, in-process — fast iteration (default)
//   pnpm play:docker [args…]     # local docker container that mocks GHA
//   pnpm docker play.ts [args…]  # explicit container form (equivalent to `pnpm play:docker`)
//
// see wiki/docker.md for when host vs container matters.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import arg from "arg";
import { config } from "dotenv";
import type { Inputs } from "./main.ts";
import { defineFixture } from "./test/utils.ts";
import { log } from "./utils/cli.ts";
import { run } from "./utils/runFixture.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

config();
config({ path: join(__dirname, "..", ".env") });

/**
 * default fixture for ad-hoc `pnpm play` runs. change this freely without
 * affecting any tests — it's only consumed by this script's no-arg path.
 */
export const playFixture = defineFixture(
  {
    prompt: `List every MCP tool you have access to. Call set_output with a JSON array of all tool names you can see.`,
  },
  { localOnly: true }
);

const isDirectExecution = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isDirectExecution) {
  const args = arg({
    "--help": Boolean,
    "--raw": String,
    "-h": "--help",
  });

  if (args["--help"]) {
    log.info(`
Usage: pnpm play         [--raw <input>]   (host, in-process; this entry)
       pnpm play:docker  [--raw <input>]   (local docker container that mocks GHA)

Run the Pullfrog action against an inline fixture.

Options:
  --raw <input>    raw string used as the prompt, or JSON object as full fixture
  -h, --help       show this message

Examples:
  pnpm play
  pnpm play --raw "Hello world"
  pnpm play --raw '{"prompt":"Hi","timeout":"5s"}'
    `);
    process.exit(0);
  }

  if (args["--raw"]) {
    const raw = args["--raw"];
    let input: Inputs | string = raw;
    try {
      input = JSON.parse(raw) as Inputs;
    } catch {
      // not valid JSON — treat as a literal prompt string.
    }
    const result = await run(input);
    process.exit(result.success ? 0 : 1);
  }

  const result = await run(playFixture);
  process.exit(result.success ? 0 : 1);
}
