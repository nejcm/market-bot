import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { listRunDirNames } from "../src/data-paths";
import { RUN_ARTIFACT_FILES } from "../src/run-artifact-layout";
import { runEvalSample } from "../src/replay/eval-run";
import {
  diffLedgers,
  formatLedgerDiff,
  parseLedger,
  serializeLedger,
  type LedgerRow,
} from "./sec-value-ledger";

interface SweepMetric {
  readonly id?: string;
  readonly status?: string;
  readonly value?: number | string | null;
  readonly unit?: string;
  readonly currency?: string;
  readonly periodEnd?: string;
  readonly periodMonths?: number;
  readonly priceAsOf?: string;
  readonly reason?: string;
}

type MetricSections = readonly { readonly id?: string; readonly metrics: readonly SweepMetric[] }[];

export interface ReportViolation {
  readonly invariant: string;
  readonly section: string;
  readonly metric: string;
  readonly detail: string;
}

interface RunViolation extends ReportViolation {
  readonly run: string;
  readonly symbol: string;
}

const REVENUE_MULTIPLES = new Set([
  "marketCapToAnnualizedRevenue",
  "evToAnnualizedRevenue",
  "priceToSales",
  "enterpriseValueToRevenue",
]);
// The shared verdict's floor and ceiling reasons from valuation-comps-contract.ts.
const REVENUE_MULTIPLE_VERDICT = /de-minimis floor|x ceiling$/u;
const CURRENT_VALUATION_SECTION = /^(financial-lens|business-framework)-/u;
const EQUIVALENT_SURFACES = [/^financial-lens-/u, /^business-framework-/u] as const;
const STALE_REASON = /^stale .+ as of (\d{4}-\d{2}-\d{2})$/u;
// Shortcut: watch threshold until the near-zero-denominator floor in plans/issues.md is decided.
const CASH_CONVERSION_WATCH = 5;

function published(sections: MetricSections) {
  return sections.flatMap((section) =>
    section.metrics
      .filter((metric) => metric.status === "value")
      .map((metric) => ({ section: section.id ?? "", metric })),
  );
}

// Class checks over one report's Metric Sections; each names a defect class from plans/issues.md.
export function reportInvariantViolations(sections: MetricSections): readonly ReportViolation[] {
  const violations: ReportViolation[] = [];
  const add = (invariant: string, section: string, metric: string, detail: string) =>
    violations.push({ invariant, section, metric, detail });
  const rows = published(sections);

  const supportabilityNotMeaningful = rows.some(
    ({ metric }) => metric.id === "valuationSupportability" && metric.value === "not-meaningful",
  );
  for (const section of sections) {
    const sectionVerdict = section.metrics.some(
      (metric) =>
        REVENUE_MULTIPLES.has(metric.id ?? "") &&
        metric.status === "not-meaningful" &&
        REVENUE_MULTIPLE_VERDICT.test(metric.reason ?? ""),
    );
    const currentVerdict =
      supportabilityNotMeaningful && CURRENT_VALUATION_SECTION.test(section.id ?? "");
    if (!sectionVerdict && !currentVerdict) {
      continue;
    }
    for (const metric of section.metrics) {
      if (metric.status === "value" && REVENUE_MULTIPLES.has(metric.id ?? "")) {
        add(
          "revenue-multiple-published-when-not-meaningful",
          section.id ?? "",
          metric.id!,
          `${String(metric.value)}: ${sectionVerdict ? "sibling revenue multiple not meaningful" : "valuationSupportability not-meaningful"}`,
        );
      }
    }
  }

  for (const section of sections) {
    const staleDates = new Set(
      section.metrics.flatMap((metric) => {
        const match = metric.status === "value" ? null : STALE_REASON.exec(metric.reason ?? "");
        return match === null ? [] : [match[1]!];
      }),
    );
    for (const metric of section.metrics) {
      if (
        metric.status === "value" &&
        metric.unit === "currency" &&
        metric.periodMonths === undefined &&
        metric.periodEnd !== undefined &&
        staleDates.has(metric.periodEnd)
      ) {
        add(
          "instant-published-beside-stale-sibling",
          section.id ?? "",
          metric.id ?? "",
          metric.periodEnd,
        );
      }
    }
  }

  const equivalents = new Map<
    string,
    { surface: number; section: string; status: string | undefined; value: SweepMetric["value"] }[]
  >();
  for (const section of sections) {
    const surface = EQUIVALENT_SURFACES.findIndex((pattern) => pattern.test(section.id ?? ""));
    if (surface === -1) {
      continue;
    }
    for (const metric of section.metrics) {
      if (metric.id === undefined || metric.periodEnd === undefined) {
        continue;
      }
      const key = [metric.id, metric.periodEnd, metric.periodMonths ?? ""].join("\n");
      equivalents.set(key, [
        ...(equivalents.get(key) ?? []),
        { surface, section: section.id ?? "", status: metric.status, value: metric.value },
      ]);
    }
  }
  for (const [key, entries] of equivalents) {
    const [id, periodEnd, periodMonths] = key.split("\n");
    const values = new Set(
      entries.filter((entry) => entry.status === "value").map((entry) => entry.value),
    );
    const statuses = new Set(entries.map((entry) => entry.status));
    if (
      new Set(entries.map((entry) => entry.surface)).size === EQUIVALENT_SURFACES.length &&
      (values.size > 1 || statuses.size > 1)
    ) {
      add(
        "surfaces-disagree",
        entries.map((entry) => entry.section).join(","),
        id!,
        `${[periodEnd, periodMonths].filter(Boolean).join(" ")}: ${entries.map((entry) => `${entry.status}=${entry.value ?? ""}`).join(" ")}`,
      );
    }
  }

  for (const { section, metric } of rows) {
    if (
      metric.id === "cashConversion" &&
      typeof metric.value === "number" &&
      Math.abs(metric.value) > CASH_CONVERSION_WATCH
    ) {
      add("watch:cash-conversion-near-zero-denominator", section, metric.id, String(metric.value));
    }
  }
  return violations;
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
  return (await Bun.file(join(result.runDir, RUN_ARTIFACT_FILES.report)).json()) as ReplayedReport;
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
    let report: ReplayedReport;
    try {
      // oxlint-disable-next-line no-await-in-loop -- samples share process-level index overrides
      report = await replayRun(runsDir, run, root);
    } catch (error) {
      failures.push({ run, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    replayed += 1;
    const sections = report.extras?.metricSections;
    if (!Array.isArray(sections)) {
      continue;
    }
    withSections += 1;
    const symbol = report.symbol ?? "";
    ledger.push(...reportLedgerRows(run, symbol, sections as MetricSections));
    violations.push(
      ...reportInvariantViolations(sections as MetricSections).map((violation) => ({
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
