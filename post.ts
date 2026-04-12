#!/usr/bin/env node

import { runPullfrogCli } from "./runCli.ts";

runPullfrogCli({
  cliArgs: ["gha", "--post"],
  swallowErrors: true,
});
