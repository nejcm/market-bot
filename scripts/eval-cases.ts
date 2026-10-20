import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  historicalSourceIds,
  parseEvalCases,
  resolvePointer,
  runEvalCase,
} from "../src/replay/eval-cases";
import type { ResearchReport } from "../src/domain/report";
import { claimsForReport } from "../src/research/post-synthesis-audit";

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
const sameSet = (left: unknown, right: readonly string[]) =>
  Array.isArray(left) &&
  [...new Set(left)].toSorted().join("\n") === [...new Set(right)].toSorted().join("\n");

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
    if ("claim" in row && !sameSet(resolvePointer(value, ["sourceIds"]), row.claim.sourceIds)) {
      problems.push("frozen claim sourceIds differ from the capture");
    }
    // oxlint-disable-next-line no-await-in-loop -- files are cached and read once each
    const { input } = (await load(`${row.capture}/replay/final-synthesis-input.json`)).json as {
      input: { knownSourceIds: string[]; context: { historicalContext?: unknown } };
    };
    if (row.check === "stale-support") {
      const known = new Set(input.knownSourceIds);
      const historical = historicalSourceIds(input.context.historicalContext);
      const ids = row.claim.sourceIds;
      if (
        !sameSet(
          row.currentSourceIds,
          ids.filter((id) => known.has(id)),
        )
      ) {
        problems.push("currentSourceIds differ from knownSourceIds membership");
      }
      if (
        !sameSet(
          row.historicalSourceIds,
          ids.filter((id) => historical.has(id)),
        )
      ) {
        problems.push("historicalSourceIds differ from Historical Research Context membership");
      }
    }
    if (
      row.check === "omission" &&
      !sameSet(
        row.citedSourceIds,
        claimsForReport(value as ResearchReport).flatMap((claim) => claim.sourceIds),
      )
    ) {
      problems.push("citedSourceIds differ from the report's claim citations");
    }
    if (row.check === "extraction-error") {
      for (const fact of row.facts) {
        // oxlint-disable-next-line no-await-in-loop -- files are cached and read once each
        const source = await load(`${row.capture}/replay/final-synthesis-input.json`);
        const parsed = Number(fact.excerpt.replaceAll(",", "")) * (fact.scale ?? 1);
        if (
          !asText(resolvePointer(source.json, fact.pointer)).includes(fact.excerpt) ||
          Math.abs(parsed - fact.value) > 1e-9 * Math.max(1, Math.abs(fact.value))
        ) {
          problems.push(`fact ${String(fact.value)} not at ${fact.pointer.join(".")}`);
        }
      }
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
  `${String(cases.length)} case(s); judged labels (contradiction, unsupported-inference) need the k=3 judge, which this offline script never calls.\n`,
);
process.exitCode = failures > 0 ? 1 : 0;
