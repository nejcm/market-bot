import { expect, test } from "bun:test";
import { buildWebSubjectProfileEvidence } from "../src/web-evidence/web-subject-profile";
import { assembleResearchReport, type ModelReportPayload } from "../src/research/report-assembly";
import { synthesizeReportUntilValid } from "../src/research/final-synthesis";
import {
  evaluateMetricSection,
  type MetricDefinition,
} from "../src/sources/extended-evidence/metric-engine";
import { renderMarkdownReport } from "../src/report/markdown";
import { buildReportSearchEntries } from "../src/report-search-entries";
import { buildRunChatContext } from "../app/chat-context";
import { buildRunWorkspaceView } from "../app/client/run-workspace-view";
import {
  collectedSources,
  marketSnapshot,
  newsSource,
  researchReport,
  verifiedMarketSnapshot,
} from "./support/fixtures";
import { researchContext } from "./support/research-context-helpers";
import {
  metricReferenceEvidence,
  withoutRestatedMetricValues,
} from "../src/research/prompts/metric-references";
import { referenceMetricSections } from "../src/research/metric-references";
import { verifiedSnapshotSource } from "../src/research/verified-snapshot-contract";
import { addFinancialLensEvidence } from "../src/sources/extended-evidence/financial-lens";
import { formatMetricValue } from "../src/sources/extended-evidence/value-format";

const command = {
  jobType: "equity",
  assetClass: "equity",
  symbol: "AAPL",
  depth: "brief",
} as const;
const context = researchContext(command);
const definitions: readonly MetricDefinition[] = [
  {
    id: "margin",
    label: "Margin",
    unit: "ratio-percent",
    basis: "FY",
    compute: () => ({ status: "value", value: 0.125, inputs: [] }),
  },
  {
    id: "cash",
    label: "Cash",
    unit: "currency",
    basis: "FY",
    compute: () => ({ status: "value", value: 1_000_000, currency: "EUR", inputs: [] }),
  },
  {
    id: "ratio",
    label: "Coverage",
    unit: "ratio",
    basis: "FY",
    compute: () => ({ status: "value", value: 2.5, inputs: [] }),
  },
  {
    id: "dps",
    label: "DPS",
    unit: "currency-per-share",
    basis: "FY",
    compute: () => ({ status: "value", value: 0.25, currency: "GBP", inputs: [] }),
  },
  {
    id: "missing",
    label: "Absent",
    unit: "number",
    basis: "FY",
    compute: () => ({ status: "missing", reason: "no filed input" }),
  },
  {
    id: "meaningless",
    label: "Unavailable ratio",
    unit: "ratio",
    basis: "FY",
    compute: () => ({ status: "not-meaningful", reason: "zero denominator" }),
  },
  {
    id: "inapplicable",
    label: "Inapplicable",
    unit: "ratio",
    basis: "FY",
    applicable: () => "inapplicable",
    compute: () => ({ status: "missing", reason: "not reached" }),
  },
];
const { section } = evaluateMetricSection(
  "operating-ratios",
  "Operating Ratios",
  definitions.map((definition) => ({
    ...definition,
    compute: (ctx) => ({
      ...definition.compute(ctx),
      inputs: [
        { label: "Quote", value: 1, artifact: "quote", unit: "USD", sourceIds: ["metric-source"] },
      ],
    }),
  })),
  { symbol: "AAPL" },
);
const sources = [
  newsSource({ id: "market-aapl", kind: "market-data" }),
  newsSource({ id: "metric-source", kind: "market-data" }),
];

test("compact metric catalog preserves values, units, periods, statuses and citations through defaults", () => {
  const dated = evaluateMetricSection(
    "dated",
    "Dated metrics",
    definitions.map((definition, index) => ({
      ...definition,
      compute: (ctx) => ({
        ...definition.compute(ctx),
        ...(index === 0 ? { periodEnd: "2026-03-31", periodMonths: 12 } : {}),
      }),
    })),
    { symbol: "AAPL" },
  ).section;
  for (const produced of [
    section,
    dated,
    { ...section, metrics: [] },
    { ...section, metrics: section.metrics.slice(0, 1) },
  ]) {
    const catalog = metricReferenceEvidence([produced]).metricReferences as {
      defaults?: Record<string, unknown>;
      metrics: Record<string, unknown>[];
    }[];
    expect(catalog[0]!.metrics).toHaveLength(produced.metrics.length);
    for (const [index, row] of catalog[0]!.metrics.entries()) {
      const {
        id,
        inputs: _inputs,
        reason: _reason,
        cause: _cause,
        value,
        ...preserved
      } = produced.metrics[index]!;
      expect({ ...catalog[0]!.defaults, ...row }).toEqual({
        ...preserved,
        reference: `<<metric:${produced.id}.${id}>>`,
        ...(preserved.status === "value"
          ? { value: formatMetricValue(value, preserved.unit, preserved.currency) }
          : {}),
      });
      expect(row).not.toHaveProperty("inputs");
      expect(row).not.toHaveProperty("reason");
      expect(row).not.toHaveProperty("id");
    }
  }
});

function input(payload: ModelReportPayload, metricSections = [section]) {
  return {
    runId: "metric-test",
    generatedAt: "2026-06-01T00:00:00.000Z",
    command,
    payload: { ...researchReport({ predictions: [] }), ...payload },
    predResult: { predictions: [], errors: [] },
    collectedSources: collectedSources({ metricSections }),
    depthProfile: context.depthProfile,
    context,
    sources,
  };
}

test("assembly formats repeated metric references, merges citations, and publishes resolved prose to readers", () => {
  const report = assembleResearchReport(
    input({
      keyFindings: [
        {
          text: "FY margin <<metric:operating-ratios.margin>>; cash <<metric:operating-ratios.cash>>; coverage <<metric:operating-ratios.ratio>>; DPS <<metric:operating-ratios.dps>>; margin <<metric:operating-ratios.margin>>.",
          sourceIds: ["market-aapl", "metric-source"],
        },
      ],
      scenarios: [
        {
          name: "Base",
          description: "FY margin remains <<metric:operating-ratios.margin>>.",
          sourceIds: [],
        },
      ],
      extras: {
        earningsSetup: {
          expectationBar: [
            { text: "FY margin <<metric:operating-ratios.margin>>.", sourceIds: [] },
          ],
        },
      },
    }),
  );
  expect(report.keyFindings[0]).toEqual({
    text: "FY margin 12.5%; cash €1.0M; coverage 2.50x; DPS £0.25; margin 12.5%.",
    sourceIds: ["market-aapl", "metric-source"],
  });
  expect(report.scenarios[0]?.sourceIds).toEqual(["metric-source"]);
  expect(report.scenarios[0]?.description).toContain("12.5%");
  expect(JSON.stringify(report)).not.toContain("<<metric:");
  const markdown = renderMarkdownReport(report);
  expect(markdown).toContain("FY margin 12.5%");
  expect(markdown).not.toContain("<<metric:");
  const entry = buildReportSearchEntries(report, [], "console").find(
    ({ section: reportSection }) => reportSection === "keyFindings",
  );
  expect(entry?.text).toContain("12.5%");
  expect(entry?.sourceIds).toContain("metric-source");
  const detail = {
    summary: {
      runId: report.runId,
      findingCount: 1,
      predictionCount: 0,
      sourceCount: 2,
      dataGapCount: 0,
      hasScore: false,
      availableFiles: [],
    },
    report: { ...report },
    markdown,
  };
  expect(buildRunChatContext(detail)).toContain("FY margin 12.5%");
  const workspace = JSON.stringify(buildRunWorkspaceView(detail));
  expect(workspace).toContain("FY margin 12.5%");
  expect(workspace).not.toContain("<<metric:");
});

test("references allow dots in a Valuation Workbench section's publication timestamp", () => {
  const dated = { ...section, id: "valuation-workbench-fy-2025-12-31-2026-02-01T00:00:00.000Z" };
  const report = assembleResearchReport(
    input({ keyFindings: [{ text: `Margin <<metric:${dated.id}.margin>>.`, sourceIds: [] }] }, [
      dated,
    ]),
  );
  expect(report.keyFindings[0]?.text).toBe("Margin 12.5%.");
});

test.each([
  "<<Metric:operating-ratios.margin>>",
  "<< METRIC: operating-ratios.margin >>",
  "<<\nMeTrIc :\toperating-ratios.margin\n>>",
])("resolves case and whitespace variant %s with canonical citations", (token) => {
  const report = assembleResearchReport(
    input({ keyFindings: [{ text: `FY margin ${token}.`, sourceIds: [] }] }),
  );
  expect(report.keyFindings[0]).toEqual({ text: "FY margin 12.5%.", sourceIds: ["metric-source"] });
  for (const payload of [
    { summary: token },
    { dataGaps: [token] },
    { predictions: [{ reasoning: token }] },
    { keyFindings: [{ text: "Margin", sourceIds: [], other: token }] },
  ]) {
    expect(() => assembleResearchReport(input(payload))).toThrow(/Metric reference/iu);
  }
});

test.each(["<< METRIC:unknown.margin>>", "<<\nMetric:operating-ratios.margin>"])(
  "rejects unknown and malformed variant %s",
  (token) => {
    expect(() =>
      assembleResearchReport(input({ keyFindings: [{ text: token, sourceIds: [] }] })),
    ).toThrow(/Metric reference/iu);
  },
);

test.each([
  "<<metric:operating-ratios.margin",
  "<<metric:operating-ratios.margin}",
  "<<metric:operating-ratios.<margin>>",
  "{{metric:operating-ratios.margin}}",
  "{{ METRIC : operating-ratios.margin }}",
  "{{\nMeTrIc\t:operating-ratios.margin}",
])("rejects malformed or legacy token %s across authored surfaces", (token) => {
  expect(() =>
    assembleResearchReport(input({ keyFindings: [{ text: token, sourceIds: [] }] })),
  ).toThrow("Malformed metric reference");
  for (const payload of [
    { summary: token },
    { dataGaps: [token] },
    { predictions: [{ reasoning: token }] },
    { extras: { notes: { nested: [token] } } },
  ]) {
    expect(() => assembleResearchReport(input(payload))).toThrow(/Metric reference/iu);
  }
});

test.each([
  { reference: "foo", sectionId: "fo", metricId: "foo" },
  { reference: ".foo", sectionId: "", metricId: "foo" },
  { reference: "foo.", sectionId: "foo", metricId: "" },
])(
  "rejects invalid separators in $reference even with colliding IDs",
  ({ reference, sectionId, metricId }) => {
    const collision = {
      ...section,
      id: sectionId,
      metrics: [{ ...section.metrics[0]!, id: metricId }],
    };
    expect(() =>
      assembleResearchReport(
        input({ keyFindings: [{ text: `<<metric:${reference}>>`, sourceIds: [] }] }, [collision]),
      ),
    ).toThrow(/Malformed metric reference/u);
  },
);

test.each([
  "unknown.margin",
  "operating-ratios.unknown",
  "operating-ratios.missing",
  "operating-ratios.meaningless",
  "operating-ratios.inapplicable",
  "operating-ratios.margin>broken",
])("rejects invalid or unavailable reference %s", (reference) => {
  expect(() =>
    assembleResearchReport(
      input({ keyFindings: [{ text: `FY <<metric:${reference}>>.`, sourceIds: [] }] }),
    ),
  ).toThrow(/Metric reference|Malformed metric reference/u);
});

test("rejects unciteable or unformattable values and references outside cited narrative", () => {
  for (const metric of [{ sourceIds: [] }, { value: Number.NaN }, { value: "" }]) {
    const changed = { ...section, metrics: [{ ...section.metrics[0]!, ...metric }] };
    expect(() =>
      assembleResearchReport(
        input(
          { keyFindings: [{ text: "FY <<metric:operating-ratios.margin>>.", sourceIds: [] }] },
          [changed],
        ),
      ),
    ).toThrow("unciteable");
  }
  for (const payload of [
    { summary: "Margin <<metric:operating-ratios.margin>>." },
    { dataGaps: ["Margin <<metric:operating-ratios.margin>>."] },
    { predictions: [{ reasoning: "Margin <<metric:operating-ratios.margin>>." }] },
  ]) {
    expect(() => assembleResearchReport(input(payload))).toThrow("require a cited narrative claim");
  }
  expect(() =>
    assembleResearchReport(
      input({
        keyFindings: [
          { text: "Buy the dip at <<metric:operating-ratios.margin>>.", sourceIds: [] },
        ],
      }),
    ),
  ).toThrow("trade-action language");
  expect(() =>
    assembleResearchReport(
      input(
        { keyFindings: [{ text: "Margin <<metric:operating-ratios.margin>>", sourceIds: [] }] },
        [],
      ),
    ),
  ).toThrow("unknown");
});

test.each([
  { draft: "FY margin <<metric:operating-ratios.unknown>>.", error: "Metric reference" },
  { draft: "FY margin <<\nMETRIC:operating-ratios.unknown>>.", error: "Metric reference" },
  { draft: "A <<metric:operating-ratios.margin>> gap remains.", error: "trade-action language" },
  { draft: "FY margin <<metric:operating-ratios.margin|period>>.", error: "unsupported format" },
  { draft: "FY margin <<metric:operating-ratios.margin|percent>>.", error: "unsupported format" },
])("repairs rejected metric prose: $draft", async ({ draft, error }) => {
  const assembly = input({});
  let calls = 0;
  const result = await synthesizeReportUntilValid({
    ...assembly,
    knownSourceIds: new Set(sources.map(({ id }) => id)),
    priorStages: [],
    maxPredictionReprompts: 0,
    runFinalSynthesis: async (_prior, reprompt) => {
      calls += 1;
      if (calls === 2) {
        expect(reprompt?.reportValidationErrors?.join(" ")).toContain(error);
      }
      return {
        stage: "final-synthesis",
        tokenEstimate: 0,
        content: JSON.stringify({
          ...assembly.payload,
          keyFindings: [
            {
              text: calls === 1 ? draft : "FY margin <<metric:operating-ratios.margin>>.",
              sourceIds: [],
            },
          ],
        }),
      };
    },
  });
  expect(calls).toBe(2);
  expect(result.report.keyFindings[0]).toEqual({
    text: "FY margin 12.5%.",
    sourceIds: ["metric-source"],
  });
});

test("assembly preserves literal metric tokens in quoted Sources and Extended Evidence", () => {
  const token = "<<\nMeTrIc\t:operating-ratios.margin>>";
  const assembly = input({});
  const quotedSource = newsSource({
    id: "quoted-source",
    title: token,
    summary: token,
    snippet: token,
  });
  const extendedEvidence = {
    items: [
      {
        category: "sec-edgar" as const,
        title: token,
        summary: token,
        sourceIds: [quotedSource.id],
        observedAt: quotedSource.fetchedAt,
      },
    ],
    gaps: [],
  };
  const report = assembleResearchReport({
    ...assembly,
    sources: [...sources, quotedSource],
    collectedSources: { ...assembly.collectedSources, extendedEvidence },
  });
  expect(report.sources.find(({ id }) => id === quotedSource.id)).toEqual(quotedSource);
  expect(report.extendedEvidence).toEqual(extendedEvidence);
});

test("collected profile digest preserves literal metric tokens on the first synthesis call", async () => {
  const assembly = input({});
  const token = "<<\nMeTrIc\t:operating-ratios.margin>>";
  const profileSource = newsSource({ id: "profile-source", kind: "web" });
  const produced = buildWebSubjectProfileEvidence({
    command,
    subject: { subjectKind: "company", subjectId: "AAPL", symbol: "AAPL", assetClass: "equity" },
    generatedAt: assembly.generatedAt,
    runId: assembly.runId,
    modelContent: JSON.stringify({
      subjectSummary: { answer: `The source quotes ${token}.`, sourceIds: [profileSource.id] },
      questions: Object.fromEntries(
        [
          "whatItDoes",
          "howItMakesMoney",
          "customers",
          "geography",
          "purchaseRecurrence",
          "pricingPower",
          "recessionCyclicality",
          "managementTrackRecord",
          "capitalAllocation",
          "companyKpis",
          "riskFactors",
        ].map((key) => [key, { answer: "Devices and services.", sourceIds: [profileSource.id] }]),
      ),
      recentMaterialEvents: [],
      factLedger: [{ claim: "Devices and services.", sourceIds: [profileSource.id] }],
      openGaps: [],
    }),
    webSources: [profileSource],
    extendedEvidence: undefined,
  });
  expect(produced.artifact).toBeDefined();
  let calls = 0;
  const result = await synthesizeReportUntilValid({
    ...assembly,
    sources: [...sources, profileSource],
    collectedSources: { ...assembly.collectedSources, webSubjectProfile: produced.artifact! },
    knownSourceIds: new Set([...sources, profileSource].map(({ id }) => id)),
    priorStages: [],
    maxPredictionReprompts: 0,
    runFinalSynthesis: async () => {
      calls += 1;
      return {
        stage: "final-synthesis",
        tokenEstimate: 0,
        content: JSON.stringify(assembly.payload),
      };
    },
  });
  expect(calls).toBe(1);
  expect(result.report.extras?.webSubjectProfile).toMatchObject({
    subjectSummary: { answer: `The source quotes ${token}.`, sourceIds: [profileSource.id] },
  });
});

test.each(["notes", "webSubjectProfile"])(
  "repairs unresolved tokens in unsupported extras.%s",
  async (key) => {
    const assembly = input({});
    let calls = 0;
    const result = await synthesizeReportUntilValid({
      ...assembly,
      knownSourceIds: new Set(sources.map(({ id }) => id)),
      priorStages: [],
      maxPredictionReprompts: 0,
      runFinalSynthesis: async (_prior, reprompt) => {
        calls += 1;
        if (calls === 2) {
          expect(reprompt?.reportValidationErrors?.join(" ")).toContain(
            "Unresolved metric reference",
          );
        }
        return {
          stage: "final-synthesis",
          tokenEstimate: 0,
          content: JSON.stringify({
            ...assembly.payload,
            extras: {
              [key]: {
                nested: [calls === 1 ? "<<\nMeTrIc\t:operating-ratios.margin>>" : "Filed margin."],
              },
            },
          }),
        };
      },
    });
    expect(calls).toBe(2);
    expect(result.report.extras?.[key]).toEqual({ nested: ["Filed margin."] });
  },
);

test("|period renders the metric's period label and rejects metrics without one", () => {
  const dated = {
    ...section,
    metrics: section.metrics.map((metric, index) =>
      index === 0 ? { ...metric, periodEnd: "2026-03-31", periodMonths: 6 } : metric,
    ),
  };
  const report = assembleResearchReport(
    input(
      {
        keyFindings: [
          {
            text: "Margin <<metric:operating-ratios.margin|period>>; again << METRIC: operating-ratios.margin | PERIOD >>.",
            sourceIds: [],
          },
        ],
      },
      [dated],
    ),
  );
  expect(report.keyFindings[0]).toEqual({
    text: "Margin 12.5% (as of 2026-03-31); again 12.5% (as of 2026-03-31).",
    sourceIds: ["metric-source"],
  });
  for (const token of [
    "<<metric:operating-ratios.cash|period>>",
    "<<metric:operating-ratios.margin|abs>>",
  ]) {
    expect(() =>
      assembleResearchReport(input({ keyFindings: [{ text: token, sourceIds: [] }] }, [dated])),
    ).toThrow("unsupported format");
  }
  for (const token of [
    "<<metric:operating-ratios.margin|>>",
    "<<metric:operating-ratios.margin|period|period>>",
  ]) {
    expect(() =>
      assembleResearchReport(input({ keyFindings: [{ text: token, sourceIds: [] }] }, [dated])),
    ).toThrow("Malformed metric reference");
  }
});

test("market-session references resolve verified snapshot values with its citation", () => {
  const snapshot = verifiedMarketSnapshot();
  const withSnapshot = (payload: ModelReportPayload) => ({
    ...input(payload),
    sources: [...sources, verifiedSnapshotSource(snapshot)],
    collectedSources: collectedSources({
      metricSections: [section],
      verifiedMarketSnapshot: snapshot,
    }),
  });
  const report = assembleResearchReport(
    withSnapshot({
      keyFindings: [
        {
          text: "Close <<metric:market-session.close>> vs <<metric:market-session.previousClose>> (<<metric:market-session.sessionChangePercent>>), RSI14 <<metric:market-session.rsi14|period>>.",
          sourceIds: [],
        },
      ],
    }),
  );
  expect(report.keyFindings[0]).toEqual({
    text: "Close 108.00 vs 105.00 (2.9%), RSI14 55.00 (as of 2026-05-18).",
    sourceIds: ["verified-snapshot-AAPL"],
  });
  expect(() =>
    assembleResearchReport(
      withSnapshot({
        keyFindings: [{ text: "SMA200 <<metric:market-session.sma200>>.", sourceIds: [] }],
      }),
    ),
  ).toThrow("unknown");
  expect(() =>
    assembleResearchReport(
      input({ keyFindings: [{ text: "Close <<metric:market-session.close>>.", sourceIds: [] }] }),
    ),
  ).toThrow("unknown");
});

const session = (overrides: Parameters<typeof collectedSources>[0]) =>
  referenceMetricSections(collectedSources(overrides)).find(({ id }) => id === "market-session");

test("market-session catalog: currency from price history, single bar, unverified session, no snapshot", () => {
  expect(session({})).toBeUndefined();
  expect(referenceMetricSections(collectedSources({}))).toEqual([]);
  const priced = session({
    verifiedMarketSnapshot: verifiedMarketSnapshot({ latestSessionStatus: "unverified" }),
    priceHistory: [
      {
        symbol: "AAPL",
        sourceId: "price-history-AAPL",
        currency: "EUR",
        priceMode: "split-adjusted-close",
        bars: [],
      },
    ],
  })!;
  const close = priced.metrics.find(({ id }) => id === "close")!;
  expect(formatMetricValue(close.value, close.unit, close.currency)).toBe("€108.00");
  expect(close.basis).toContain("latest session unverified");
  expect(priced.metrics.map(({ id }) => id)).not.toContain("sma200");
  const single = session({
    verifiedMarketSnapshot: verifiedMarketSnapshot({
      recentCloses: [{ date: "2026-05-18", close: 108 }],
    }),
  })!;
  expect(single.metrics.map(({ id }) => id)).not.toContain("previousClose");
  expect(single.metrics.map(({ id }) => id)).not.toContain("sessionChangePercent");
});

test("prompt evidence keeps nonmigrated summary prose while stripping migrated values", () => {
  const produced = addFinancialLensEvidence(
    command,
    [marketSnapshot()],
    undefined,
    verifiedMarketSnapshot(),
    "2026-06-01T00:00:00.000Z",
  );
  const evidence = produced.extendedEvidence!;
  const item = evidence.items.find(({ category }) => category === "financial-lens")!;
  const momentum = produced.artifact!.lenses.find(({ name }) => name === "Momentum")!;
  const latest = momentum.metrics.find(({ key }) => key === "latestClose")!;
  const migrated = {
    ...section,
    id: "financial-lens-momentum",
    metrics: [
      {
        ...section.metrics[0]!,
        id: latest.key,
        label: latest.label,
        value: latest.value,
        unit: latest.unit,
        ...(latest.currency !== undefined ? { currency: latest.currency } : {}),
      },
    ],
  };
  const projected = withoutRestatedMetricValues(evidence, [migrated]);
  const { summary } = projected.items[0]!;
  expect(summary).toContain("Momentum criteria-");
  expect(summary).toContain("SMA50");
  expect(summary).not.toBe(item.summary);
  expect(projected.items[0]!.metrics).not.toHaveProperty(latest.key);
  expect(projected.items[0]!.metrics?.sma50).toBe(item.metrics?.sma50);
  expect(withoutRestatedMetricValues(evidence, []).items).toBe(evidence.items);
});
