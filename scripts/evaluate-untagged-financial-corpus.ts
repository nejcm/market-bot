import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  evaluateUntaggedFinancialCorpus,
  UNTAGGED_FINANCIAL_CORPUS_DIR,
} from "../tests/support/untagged-financial-corpus";

const evaluation = await evaluateUntaggedFinancialCorpus();
const serialized = `${JSON.stringify(evaluation, null, 2)}\n`;
if (process.argv.includes("--write")) {
  await writeFile(join(UNTAGGED_FINANCIAL_CORPUS_DIR, "evaluation.json"), serialized, "utf8");
} else {
  process.stdout.write(serialized);
}

if (!evaluation.passed) {
  process.exitCode = 1;
}
