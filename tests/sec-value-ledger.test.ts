import { describe, expect, test } from "bun:test";
import {
  diffLedgers,
  formatLedgerDiff,
  parseLedger,
  serializeLedger,
  secValueLedgerRows,
  type LedgerRow,
} from "../scripts/sec-value-ledger";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectLedgerInputs } from "../scripts/sec-cache-sweep";
import { makeReplayFetch } from "../src/replay/data-cassette";
import { withReplaySession } from "../src/replay/session";
import {
  fetchSecCompanyFactsForSymbol,
  secProviderResultFromCompanyFacts,
  type SecProviderResult,
} from "../src/sources/extended-evidence/sec-edgar";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import { collectValuationWorkbench } from "../src/sources/extended-evidence/valuation-workbench";
import type { MetricSection } from "../src/sources/extended-evidence/metric-engine";
import { createCollectContext } from "../src/sources/source-request";
import {
  createFixtureConfig,
  fixtureCommand,
  loadFixture,
  runFixture,
} from "../src/replay/fixture-run";
import { replayedRunOutput } from "./support/run-fixtures/artifacts";

function row(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    cik: "0000000001",
    symbol: "TEST",
    metric: "statement.debt",
    period: "instant|2025-12-31",
    status: "published",
    value: 100,
    unit: "USD",
    currency: "USD",
    reason: null,
    accession: "0000000001-26-000001",
    firstPublicAt: "2026-02-01",
    detail: "LongTermDebt",
    ...overrides,
  };
}

const withheld = row({ status: "withheld", value: null, reason: "incomplete-composite-series" });

describe("SEC value ledger diff", () => {
  test("reports nothing for identical ledgers", () => {
    const ledger = [row(), row({ metric: "ratio.roic", period: "2025-12-31", value: 0.2 })];
    expect(diffLedgers(ledger, structuredClone(ledger))).toEqual([]);
    expect(formatLedgerDiff([])).toBe(
      "Ledger diff: 0 transitions (0 cutoff changed, 0 value changed, 0 withheld→published, 0 published→withheld, 0 reason changed, 0 provenance changed, 0 row added, 0 row removed)\n",
    );
  });

  test.each([
    ["value changed", row(), row({ value: 120 })],
    ["value changed", row(), row({ unit: "EUR" })],
    ["withheld→published", withheld, row()],
    ["withheld→published", row({ status: "missing", value: null }), row()],
    ["published→withheld", row(), withheld],
    ["published→withheld", row(), row({ status: "not-meaningful", value: null, reason: "x" })],
    ["reason changed", withheld, { ...withheld, reason: "debt-held-for-sale" }],
    ["reason changed", withheld, { ...withheld, status: "missing" as const }],
    ["provenance changed", row(), row({ accession: "0000000001-26-000002" })],
    ["provenance changed", row(), row({ detail: "DebtCurrent; LongTermDebtNoncurrent" })],
    ["provenance changed", row(), row({ symbol: "RENAMED" })],
    ["provenance changed", row(), row({ currency: "EUR" })],
  ] as const)("classifies %s", (kind, before, after) => {
    expect(diffLedgers([before], [after])).toEqual([{ kind, before, after }]);
  });

  test("classifies added and removed rows by cik, metric and period", () => {
    const kept = row({ metric: "valuation.debt", period: "annual|2025-12-31" });
    const removed = row({ period: "instant|2024-12-31" });
    const added = row({ cik: "0000000002", symbol: "NEW" });
    const transitions = diffLedgers([kept, removed], [added, kept]);
    expect(transitions).toEqual([
      { kind: "row removed", before: removed },
      { kind: "row added", after: added },
    ]);
    const text = formatLedgerDiff(transitions);
    expect(text).toContain("row added (1):\n  NEW (0000000002) statement.debt instant|2025-12-31:");
    expect(text).toContain(
      "row removed (1):\n  TEST (0000000001) statement.debt instant|2024-12-31: 100 USD -> (none)",
    );
    expect(text).toEndWith("1 row added, 1 row removed)\n");
  });

  test("prints old and new values with the withhold reason", () => {
    const text = formatLedgerDiff(diffLedgers([withheld], [row()]));
    expect(text).toContain(
      "withheld→published (1):\n  TEST (0000000001) statement.debt instant|2025-12-31: withheld [withheld: incomplete-composite-series] -> 100 USD\n",
    );
  });

  test("flags a moved cutoff beside the transitions it may explain", () => {
    const cutoff = row({
      metric: "cutoff",
      period: "-",
      unit: null,
      value: "2026-10-09T23:59:59.999Z",
    });
    const moved = { ...cutoff, value: "2026-11-03T23:59:59.999Z" };
    const text = formatLedgerDiff(diffLedgers([cutoff, withheld], [moved, row()]));
    expect(text).toStartWith(
      "cutoff changed (1):\n  TEST (0000000001) cutoff -: 2026-10-09T23:59:59.999Z -> 2026-11-03T23:59:59.999Z\nwithheld→published (1):",
    );
  });

  test("prints every changed provenance field", () => {
    const text = formatLedgerDiff(diffLedgers([row()], [row({ symbol: "NEW", currency: "EUR" })]));
    expect(text).toContain(
      'provenance changed (1):\n  NEW (0000000001) statement.debt instant|2025-12-31: symbol "TEST" -> "NEW"; currency "USD" -> "EUR"\n',
    );
  });

  test.each(["Baseline", "Current"])("rejects duplicate keys in the %s ledger", (side) => {
    const duplicated = [row({ value: 1 }), row({ value: 100 })];
    const single = [row({ value: 2 })];
    expect(() =>
      side === "Baseline" ? diffLedgers(duplicated, single) : diffLedgers(single, duplicated),
    ).toThrow(`${side} ledger has duplicate row 0000000001 statement.debt instant|2025-12-31`);
  });

  test.each([
    ['{"bogus":1}'],
    [JSON.stringify({ ...row(), status: "approved" })],
    [JSON.stringify({ ...row(), value: true })],
    [JSON.stringify({ ...row(), accession: 7 })],
    [JSON.stringify({ ...row(), cik: undefined })],
  ])("rejects a malformed ledger line %s", (line) => {
    expect(() => parseLedger(`${serializeLedger([row()])}${line}\n`)).toThrow(
      `Ledger line 2 is not a ledger row: ${line}`,
    );
  });

  test("round-trips a ledger byte for byte", () => {
    const ledger = [row(), withheld];
    const text = serializeLedger(ledger);
    expect(parseLedger(text)).toEqual(ledger);
    expect(serializeLedger(parseLedger(text))).toBe(text);
  });
});

const LEDGER_SECTIONS = /^(?:financial-lens-|capital-return$|operating-ratios$)/u;
const QUOTE_ARTIFACTS = new Set(["quote", "priceHistory", "verifiedSnapshot", "fx"]);

async function ledgerAgainstRun(name: string) {
  const fixture = await loadFixture(name);
  const result = await runFixture(name, { llm: "replay" });
  try {
    const bundle = result.deepEquityEvidenceBundle;
    const statements = bundle?.derived.financialStatements;
    if (bundle === undefined || statements === undefined) {
      throw new Error(`${name} has no deep financial statements`);
    }
    const { symbol, analysisAsOf } = bundle.run;
    const ledger = () => {
      const { context } = createCollectContext(
        fixtureCommand(fixture.meta),
        createFixtureConfig(fixture.meta, result.dataDir).sourceOptions,
        new Date(analysisAsOf),
        makeReplayFetch(fixture.dataCassette, fixture.dir),
        [],
      );
      return fetchSecCompanyFactsForSymbol(context, symbol).then((facts) =>
        secValueLedgerRows({
          cik: facts.cik ?? "",
          symbol,
          statements,
          companyFacts: facts.factsPayload,
          sec: secProviderResultFromCompanyFacts(context, facts),
          asOf: analysisAsOf,
        }),
      );
    };
    const failures: string[] = [];
    const rows = await withReplaySession(
      {
        mode: fixture.state === undefined ? "offline" : "replay",
        state: fixture.state ?? { values: {} },
        indexes: new Map(),
        failures,
        offline: true,
      },
      ledger,
    );
    expect(failures).toEqual([]);
    return { rows, sections: bundle.derived.metricSections ?? [] };
  } finally {
    await result.cleanup();
  }
}

function ledgerRow(rows: readonly LedgerRow[], id: string, period: string): LedgerRow | undefined {
  return rows.find(
    (candidate) =>
      /^(ratio|capitalReturn|lens\.[^.]+)\./u.test(candidate.metric) &&
      candidate.metric.endsWith(`.${id}`) &&
      candidate.period === period,
  );
}

// Every Workbench section, transition spans included, is dated by its ledger row.
function expectWorkbenchSectionsInLedger(
  rows: readonly LedgerRow[],
  sections: readonly MetricSection[],
): readonly string[] {
  const workbenchDates = sections.flatMap(({ id }) => {
    const match =
      /^valuation-workbench-(annual|ttm)-(\d{4}-\d{2}-\d{2})-(\d{4}-\d{2}-\d{2})(?:-(\d+m))?$/u.exec(
        id,
      );
    return match === null
      ? []
      : [`${match[1]}|${match[2]}${match[4] === undefined ? "" : `|${match[4]}`} ${match[3]}`];
  });
  expect(workbenchDates).toHaveLength(
    sections.filter(({ id }) => /^valuation-workbench-(annual|ttm)-/u.test(id)).length,
  );
  expect(workbenchDates.length).toBeGreaterThan(0);
  expect(
    rows
      .filter(({ metric }) => metric === "valuation.publicAt")
      .map(({ period, firstPublicAt }) => `${period} ${firstPublicAt}`),
  ).toEqual(expect.arrayContaining(workbenchDates));
  return workbenchDates;
}

type Pinned = Readonly<Record<string, number>>;

function expectLedgerMatchesRun(
  rows: readonly LedgerRow[],
  sections: readonly MetricSection[],
  pinned: Pinned,
): void {
  const compared = sections
    .filter((section) => LEDGER_SECTIONS.test(section.id))
    .flatMap((section) =>
      section.metrics.filter(
        (metric) =>
          !metric.inputs.some(
            (input) =>
              QUOTE_ARTIFACTS.has(input.artifact) ||
              (input.artifact === "evidence" && input.category !== "sec-edgar"),
          ),
      ),
    );
  expect(compared.length).toBeGreaterThan(10);
  const disagreements = compared.flatMap((metric) => {
    const ledger = ledgerRow(rows, metric.id, metric.periodEnd ?? "latest");
    const run = metric.status === "value" ? metric.value : metric.status;
    const recorded = ledger?.status === "published" ? ledger.value : (ledger?.status ?? "absent");
    return run === recorded ? [] : [{ id: metric.id, run, ledger: recorded }];
  });
  expect(disagreements).toEqual([]);
  expectWorkbenchSectionsInLedger(rows, sections);
  for (const [metric, value] of Object.entries(pinned)) {
    const published = rows.find(
      (candidate) => candidate.metric === metric && candidate.status === "published",
    );
    expect(published?.value).toBeCloseTo(value, 6);
  }
}

describe("SEC value ledger matches the run's metric chain", () => {
  test.each([
    ["equity-aapl-deep", { "lens.Financial Strength.netDebt": 40_000_000_000 }],
    [
      "equity-earnings-release-deep",
      {
        "lens.Financial Strength.netDebt": 23_389_000_000,
        "lens.Financial Strength.currentRatio": 1.023_199_8,
        "lens.Financial Strength.debtToEquity": 0.714_683_3,
        "capitalReturn.sbcLatestFy": 13_789_000_000,
        "ratio.roic": 0.968_398_2,
      },
    ],
    ["equity-amd-deep", { "ratio.roic": 0.052_421_635 }],
  ] as const)(
    "%s",
    async (name, pinned) => {
      const { rows, sections } = await ledgerAgainstRun(name);
      expectLedgerMatchesRun(rows, sections, pinned);
    },
    60_000,
  );
});

// Brief runs collect statements through collectFinancialStatements, the sweep's own collector.
describe("SEC sweep collection matches a replayed brief run", () => {
  test.each([
    [
      "clfd-zero-debt",
      { "lens.Financial Strength.debt": 0, "lens.Financial Strength.netDebt": -101_223_000 },
    ],
    ["ebay-extension-investments", { "lens.Financial Strength.netDebt": 4_758_000_000 }],
  ] as const)(
    "%s",
    async (name, pinned: Pinned) => {
      const fixture = await loadFixture(name);
      const run = await replayedRunOutput(name);
      const command = fixtureCommand(fixture.meta);
      if (!("symbol" in command)) {
        throw new Error(`${name} is not an instrument run`);
      }
      const failures: string[] = [];
      const collected = await withReplaySession(
        {
          mode: fixture.state === undefined ? "offline" : "replay",
          state: fixture.state ?? { values: {} },
          indexes: new Map(),
          failures,
          offline: true,
        },
        async () => {
          const dataDir = await mkdtemp(join(tmpdir(), "sec-ledger-collect-"));
          try {
            const { context } = createCollectContext(
              command,
              createFixtureConfig(fixture.meta, dataDir).sourceOptions,
              new Date(fixture.meta.now),
              makeReplayFetch(fixture.dataCassette, fixture.dir),
              fixture.meta.retryDelaysMs ?? [],
            );
            return await collectLedgerInputs(context, command.symbol);
          } finally {
            await rm(dataDir, { recursive: true, force: true });
          }
        },
      );
      expect(failures).toEqual([]);
      const { statements } = collected;
      if (statements === undefined || collected.facts.cik === undefined) {
        throw new Error(`${name} collected no statements`);
      }
      expect(JSON.parse(JSON.stringify(statements))).toEqual(
        run.normalized["financial-statements.json"],
      );
      const rows = secValueLedgerRows({
        cik: collected.facts.cik,
        symbol: command.symbol,
        statements,
        companyFacts: collected.facts.factsPayload,
        sec: collected.sec,
        asOf: collected.asOf,
      });
      const { extras } = run.report as { extras?: { metricSections?: readonly MetricSection[] } };
      expectLedgerMatchesRun(rows, extras?.metricSections ?? [], pinned);
    },
    60_000,
  );
});

function annualFact(val: number, filed: string, start: string, end = "2023-12-31") {
  return {
    val,
    form: "10-K",
    fp: "FY",
    filed,
    start,
    end,
    accn: `${filed}-10-K`,
  };
}

test("a fiscal-year transition section matches its own ledger row", async () => {
  const facts = {
    facts: {
      "us-gaap": {
        Revenues: {
          units: {
            USD: [
              annualFact(80, "2024-02-15", "2023-03-01"),
              annualFact(95, "2024-03-15", "2023-01-01"),
              annualFact(120, "2025-02-15", "2024-01-01", "2024-12-31"),
            ],
          },
        },
      },
    },
  };
  const statements = deriveFinancialStatements(facts, {
    symbol: "TEST",
    generatedAt: "2026-06-15T00:00:00.000Z",
    analysisAsOf: "2026-06-15T00:00:00.000Z",
    sourceId: "extended-sec-edgar-test-fundamentals",
  });
  const { metricSections } = await collectValuationWorkbench({
    generatedAt: "2026-06-15T00:00:00.000Z",
    symbol: "TEST",
    financialStatements: statements,
    priceHistory: [],
    quoteCurrency: "USD",
  });
  const rows = secValueLedgerRows({
    cik: "0000000000",
    symbol: "TEST",
    statements,
    companyFacts: facts,
    sec: { items: [], gaps: [], rawSnapshots: [] } as unknown as SecProviderResult,
    asOf: "2026-06-15",
  });

  expect(expectWorkbenchSectionsInLedger(rows, metricSections)).toEqual(
    expect.arrayContaining(["annual|2023-12-31|10m 2024-02-15", "annual|2023-12-31 2024-03-15"]),
  );
});
