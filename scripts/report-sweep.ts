import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { listRunDirNames } from "../src/data-paths";
import { RUN_ARTIFACT_FILES } from "../src/run-artifact-layout";
import { loadRunArtifact } from "../src/run-artifacts";
import { runEvalSample } from "../src/replay/eval-run";
import {
  reportInvariantViolations,
  type MetricSections,
  type ReportViolation,
} from "../src/corpus/report-invariants";
import {
  diffLedgers,
  formatLedgerDiff,
  parseLedger,
  serializeLedger,
  type LedgerRow,
} from "./sec-value-ledger";

interface RunViolation extends ReportViolation {
  readonly run: string;
  readonly symbol: string;
}

function ledgerStatus(status: string | undefined): LedgerRow["status"] {
  if (status === "value") {
    return "published";
  }
  return status === "not-meaningful" || status === "not-applicable" ? status : "missing";
}

export function reportLedgerRows(
  run: string,
  symbol: string,
  sections: MetricSections,
): readonly LedgerRow[] {
  const seen = new Map<string, number>();
  return sections.flatMap((section) =>
    section.metrics.map((metric): LedgerRow => {
      const base = `${section.id ?? ""}/${metric.id ?? ""}`;
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      return {
        cik: run,
        symbol,
        metric: count === 0 ? base : `${base}#${count}`,
        period: metric.periodEnd ?? "",
        status: ledgerStatus(metric.status),
        value: metric.value ?? null,
        unit: metric.unit ?? null,
        currency: metric.currency ?? null,
        reason: metric.reason ?? null,
        accession: null,
        firstPublicAt: null,
        detail: null,
      };
    }),
  );
}

interface ReportSweep {
  readonly runs: number;
  readonly replayed: number;
  readonly withSections: number;
  readonly noCapture: readonly string[];
  readonly failures: readonly { readonly run: string; readonly error: string }[];
  readonly violationCounts: Readonly<Record<string, number>>;
  readonly violations: readonly RunViolation[];
  readonly ledger: readonly LedgerRow[];
}

interface ReplayedReport {
  readonly symbol?: string;
  readonly extras?: { readonly metricSections?: unknown };
}

async function replayRun(runsDir: string, run: string, root: string) {
  const result = await runEvalSample({
    root,
    label: "sweep",
    fixture: join(runsDir, run, "replay"),
    sample: "1",
    llm: "replay",
  });
  if (result.status !== "completed" || result.runDir === undefined) {
    throw new Error(`${result.status}: ${result.error ?? "no published run"}`);
  }
  const report = (await Bun.file(
    join(result.runDir, RUN_ARTIFACT_FILES.report),
  ).json()) as ReplayedReport;
  const { artifact } = await loadRunArtifact(result.runDir);
  return { report, snapshots: artifact?.marketSnapshots ?? [] };
}

export async function sweepReports(runsDir: string, root: string): Promise<ReportSweep> {
  const names = await listRunDirNames(runsDir);
  const noCapture: string[] = [];
  const failures: { run: string; error: string }[] = [];
  const violations: RunViolation[] = [];
  const ledger: LedgerRow[] = [];
  let replayed = 0;
  let withSections = 0;
  for (const run of names) {
    if (!existsSync(join(runsDir, run, "replay"))) {
      noCapture.push(run);
      continue;
    }
    let replay: Awaited<ReturnType<typeof replayRun>>;
    try {
      // oxlint-disable-next-line no-await-in-loop -- samples share process-level index overrides
      replay = await replayRun(runsDir, run, root);
    } catch (error) {
      failures.push({ run, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    replayed += 1;
    const { report, snapshots } = replay;
    const sections = report.extras?.metricSections;
    if (!Array.isArray(sections)) {
      continue;
    }
    withSections += 1;
    const symbol = report.symbol ?? "";
    ledger.push(...reportLedgerRows(run, symbol, sections as MetricSections));
    violations.push(
      ...reportInvariantViolations(sections as MetricSections, snapshots).map((violation) => ({
        run,
        symbol,
        ...violation,
      })),
    );
  }
  const violationCounts: Record<string, number> = {};
  for (const { invariant } of violations) {
    violationCounts[invariant] = (violationCounts[invariant] ?? 0) + 1;
  }
  return {
    runs: names.length,
    replayed,
    withSections,
    noCapture,
    failures,
    violationCounts,
    violations,
    ledger,
  };
}

function formatCountDiff(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): string {
  const lines = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .toSorted()
    .map((name) => `  ${name}: ${before[name] ?? 0} -> ${after[name] ?? 0}`);
  return `Invariant counts (baseline -> current):\n${lines.join("\n") || "  none"}\n`;
}

const rejectNetwork = (): never => {
  throw new Error("Report sweep forbids network access");
};

if (import.meta.main) {
  globalThis.fetch = Object.assign(rejectNetwork, { preconnect: rejectNetwork });
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "runs-dir": { type: "string", default: "data/runs" },
      "out-dir": { type: "string", default: "data/sweeps" },
      diff: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const baselineLedger =
    values.diff === undefined ? undefined : parseLedger(await Bun.file(values.diff).text());
  const baselineJson =
    values.diff === undefined
      ? undefined
      : ((await Bun.file(values.diff.replace(/\.ledger\.jsonl$/u, ".json")).json()) as ReportSweep);
  const started = performance.now();
  const root = await mkdtemp(join(tmpdir(), "market-bot-report-sweep-"));
  const sweep = await sweepReports(resolve(values["runs-dir"]!), root).finally(() =>
    rm(root, { recursive: true, force: true }),
  );
  const outDir = resolve(values["out-dir"]!);
  const stem = join(outDir, `report-${new Date().toISOString().replaceAll(":", "-")}`);
  const { ledger, ...json } = sweep;
  await mkdir(outDir, { recursive: true });
  await writeFile(`${stem}.json`, `${JSON.stringify(json, null, 2)}\n`, { flag: "wx" });
  await writeFile(`${stem}.ledger.jsonl`, serializeLedger(ledger), { flag: "wx" });
  process.stdout.write(
    [
      `Runs: ${sweep.runs}, replayed: ${sweep.replayed} (with Metric Sections: ${sweep.withSections}), replay failed: ${sweep.failures.length}, no capture: ${sweep.noCapture.length}`,
      ...sweep.failures.map(({ run, error }) => `  failed ${run}: ${error}`),
      ...sweep.noCapture.map((run) => `  no capture ${run}`),
      `Violations: ${
        Object.entries(sweep.violationCounts)
          .map(([name, count]) => `${name} ${count}`)
          .join(", ") || "none"
      }`,
      `JSON: ${stem}.json`,
      `Ledger (${ledger.length} rows): ${stem}.ledger.jsonl`,
      `Wall time: ${((performance.now() - started) / 1000).toFixed(1)}s`,
      "",
    ].join("\n"),
  );
  if (baselineLedger !== undefined && baselineJson !== undefined) {
    process.stdout.write(formatCountDiff(baselineJson.violationCounts, sweep.violationCounts));
    process.stdout.write(formatLedgerDiff(diffLedgers(baselineLedger, ledger)));
  }
}
