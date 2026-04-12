import { runPullfrogCli } from "../runCli.ts";

runPullfrogCli({
  cliArgs: ["gha", "token", "--post"],
  swallowErrors: true,
});
