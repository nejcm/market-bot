import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseEvalCases, resolvePointer, runEvalCase } from "../src/replay/eval-cases";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { runs: { type: "string", default: resolve(import.meta.dir, "../data/runs") } },
});
const cases = parseEvalCases(
  await Bun.file(resolve(import.meta.dir, "../tests/fixtures/eval-cases/cases.json")).json(),
);
const loaded = new Map<string, { readonly json: unknown; readonly sha256: string }>();
async function load(file: string) {
  let entry = loaded.get(file);
  if (entry === undefined) {
    const bytes = await Bun.file(join(values.runs, file)).bytes();
    entry = {
      json: JSON.parse(new TextDecoder().decode(bytes)),
      sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    };
    loaded.set(file, entry);
  }
  return entry;
}
const asText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

let failures = 0;
for (const row of cases) {
  const problems: string[] = [];
  if (existsSync(join(values.runs, row.target.file))) {
    // oxlint-disable-next-line no-await-in-loop -- files are cached and read once each
    const target = await load(row.target.file);
    if (target.sha256 !== row.target.sha256) {
      problems.push(`target hash changed: ${row.target.file}`);
    }
    const value = resolvePointer(target.json, row.target.pointer);
    if ("claim" in row && asText(resolvePointer(value, ["text"])) !== row.claim.text) {
      problems.push("frozen claim text no longer at target pointer");
    }
    for (const evidence of row.evidence) {
      // oxlint-disable-next-line no-await-in-loop -- files are cached and read once each
      const source = await load(evidence.file);
      if (!asText(resolvePointer(source.json, evidence.pointer)).includes(evidence.excerpt)) {
        problems.push(`evidence excerpt missing at ${evidence.file} ${evidence.pointer.join(".")}`);
      }
    }
  } else {
    problems.push("capture not present; frozen excerpt only");
  }
  // oxlint-disable-next-line no-await-in-loop -- deterministic, no provider calls
  const result = await runEvalCase(row);
  let status = "judge";
  if (result.pass !== undefined) {
    status = result.pass ? "pass" : "FAIL";
  }
  if (result.pass === false || problems.some((line) => !line.startsWith("capture"))) {
    failures += 1;
  }
  process.stdout.write(
    `${status.padEnd(5)} ${result.label.padEnd(16)} ${row.id}${problems.length > 0 ? `\n      ${problems.join("\n      ")}` : ""}\n`,
  );
}
process.stdout.write(
  `${String(cases.length)} case(s); contradiction labels need the k=3 judge, which this offline script never calls.\n`,
);
process.exitCode = failures > 0 ? 1 : 0;
