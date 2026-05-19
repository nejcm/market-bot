#!/usr/bin/env bun
import { commandLabel, parseArgs } from "./cli/args";

async function main(): Promise<void> {
  const command = parseArgs(Bun.argv.slice(2));
  process.stdout.write(`market-bot ${commandLabel(command)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unexpected error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
