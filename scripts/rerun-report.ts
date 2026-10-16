import { parseArgs } from "node:util";
import { rerunReport } from "../src/replay/rerun-report";

const rejectNetwork = (): never => {
  throw new Error("Offline report rerun forbids network access");
};
globalThis.fetch = Object.assign(rejectNetwork, { preconnect: rejectNetwork });

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { label: { type: "string" } },
  allowPositionals: true,
});
if (positionals.length !== 1 || values.label === undefined) {
  throw new Error("Usage: bun run scripts/rerun-report.ts <run-id|path> --label <fresh>");
}
const result = await rerunReport({ run: positionals[0]!, label: values.label });
process.stdout.write(`${result.dir}\n`);
process.exitCode = result.status === "completed" ? 0 : 1;
