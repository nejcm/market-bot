import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setSourceHostMinDelayMsForTests } from "../src/sources/source-request";
import {
  DEEP_EQUITY_LEGACY_BASELINE_PATH,
  measureDeepEquityLegacyBaseline,
  readDeepEquityLegacyBaseline,
} from "../tests/support/deep-equity-pipeline-baseline";

const flag = process.argv[2] ?? "--check";
if (flag !== "--check" && flag !== "--write") {
  throw new Error("Usage: bun run scripts/deep-equity-pipeline-baseline.ts [--check|--write]");
}

setSourceHostMinDelayMsForTests(0);
const measured = await measureDeepEquityLegacyBaseline();
if (flag === "--write") {
  await mkdir(dirname(DEEP_EQUITY_LEGACY_BASELINE_PATH), { recursive: true });
  await writeFile(
    DEEP_EQUITY_LEGACY_BASELINE_PATH,
    `${JSON.stringify(measured, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${DEEP_EQUITY_LEGACY_BASELINE_PATH}\n`);
} else {
  const committed = await readDeepEquityLegacyBaseline();
  if (JSON.stringify(measured) !== JSON.stringify(committed)) {
    throw new Error(
      "Legacy deep-equity pipeline baseline drifted; inspect and rerun with --write if intentional",
    );
  }
  process.stdout.write(`${DEEP_EQUITY_LEGACY_BASELINE_PATH} matches fixture replay\n`);
}
