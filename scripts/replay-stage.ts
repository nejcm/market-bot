import { parseArgs } from "node:util";
import { replaySynthesisFile } from "../src/replay/replay-synthesis";

const rejectNetwork = (): never => {
  throw new Error("Offline stage replay forbids network access");
};
globalThis.fetch = Object.assign(rejectNetwork, { preconnect: rejectNetwork });

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    input: { type: "string" },
    label: { type: "string" },
  },
});
if (values.input === undefined || values.label === undefined) {
  throw new Error("Usage: bun run scripts/replay-stage.ts --input <file> --label <fresh>");
}
const result = await replaySynthesisFile({ input: values.input, label: values.label });
process.stdout.write(`${result.dir}\n`);
process.exitCode = result.status === "completed" ? 0 : 1;
