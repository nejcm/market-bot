#!/usr/bin/env bun
import { runCli } from "./app";

try {
  const runDir = await runCli(Bun.argv.slice(2));
  process.stdout.write(`${runDir}\n`);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
