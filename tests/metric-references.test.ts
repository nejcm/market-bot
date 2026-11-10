import { describe, expect, test } from "bun:test";
import type { EvidenceQualityAssessment } from "../src/domain/evidence";
import { finalizeSynthesis } from "../src/research/finalize-synthesis";
import { readReport } from "../src/run-artifact-report-reader";
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
import {
  assertNoUnresolvedMetricReferences,
  catalogFigureHints,
  citeMetricReferences,
  referenceMetricSections,
} from "../src/research/metric-references";
import { verifiedSnapshotSource } from "../src/sources/verified-snapshot-contract";
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

// The resolver's spans for `values` rendered in order into a claim's text.
function rendered(text: string, ...values: readonly string[]) {
  let from = 0;
  return values.map((value) => {
    const start = text.indexOf(value, from);
    from = start + value.length;
    return { field: "text", start, text: value };
  });
}

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
    renderedMetrics: rendered(
      "FY margin 12.5%; cash €1.0M; coverage 2.50x; DPS £0.25; margin 12.5%.",
      "12.5%",
      "€1.0M",
      "2.50x",
      "£0.25",
      "12.5%",
    ),
  });
  expect(report.scenarios[0]?.sourceIds).toEqual(["metric-source"]);
  expect(report.scenarios[0]?.description).toContain("12.5%");
  expect(JSON.stringify(report)).not.toContain("<<metric:");
  const markdown = renderMarkdownReport(report);
  expect(markdown).toContain("FY margin 12.5%");
  expect(markdown).not.toContain("<<metric:");
  const entry = buildReportSearchEntries(report, [], [], "console").find(
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

test("marks only the ids a metric reference added, not ids the claim already cited", () => {
  const claim = (sourceIds: readonly string[]) =>
    assembleResearchReport(
      input({
        keyFindings: [{ text: "FY margin <<metric:operating-ratios.margin>>.", sourceIds }],
      }),
    ).keyFindings[0];
  expect(claim(["metric-source"])).toEqual({
    text: "FY margin 12.5%.",
    sourceIds: ["metric-source"],
    renderedMetrics: rendered("FY margin 12.5%.", "12.5%"),
  });
});

test.each([
  "<<Metric:operating-ratios.margin>>",
  "<< METRIC: operating-ratios.margin >>",
  "<<\nMeTrIc :\toperating-ratios.margin\n>>",
])("resolves case and whitespace variant %s with canonical citations", (token) => {
  const report = assembleResearchReport(
    input({ keyFindings: [{ text: `FY margin ${token}.`, sourceIds: [] }] }),
  );
  expect(report.keyFindings[0]).toEqual({
    text: "FY margin 12.5%.",
    sourceIds: ["metric-source"],
    metricSourceIds: ["metric-source"],
    renderedMetrics: rendered("FY margin 12.5%.", "12.5%"),
  });
  for (const payload of [
    { summary: token },
    { dataGaps: [token] },
    { predictions: [{ reasoning: token }] },
    { keyFindings: [{ text: "Margin", sourceIds: [], other: token }] },
  ]) {
    expect(() => assembleResearchReport(input(payload))).toThrow(/Metric reference/iu);
  }
});

test.each([
  ["bare string array", { extras: { foo: ["a", "b", "<<metric:x.y>>"] } }, "extras.foo[2]"],
  [
    "nested object",
    { keyFindings: [{ text: "Margin", sourceIds: [], note: { body: "<<metric:x.y>>" } }] },
    "keyFindings[0].note.body",
  ],
  ["top-level field", { summary: "<<metric:x.y>>" }, "summary"],
])("names the field path of an unresolved token in a %s", (_shape, overrides, path) => {
  expect(() =>
    assertNoUnresolvedMetricReferences(researchReport(overrides), collectedSources()),
  ).toThrow(
    `Unresolved metric reference in assembled report at ${path}; remove it or use a supported cited narrative claim`,
  );
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
  "<<operating-ratios.unknown>>",
  "<<business framework growth>>",
  "FY <<financial-lens-growth.revenueDeltaPercent|period>> growth",
  "<<operating-ratios.<margin>>",
  "<<financial-lens-growth.<revenueDeltaPercent>|period>>",
  "Margin <<operating-ratios.margin",
  "Margin operating-ratios.margin>> stray",
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
    metricSourceIds: ["metric-source"],
    renderedMetrics: rendered("FY margin 12.5%.", "12.5%"),
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
      subjectSummary: { answer: "Devices and services.", sourceIds: [profileSource.id] },
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
    collectedSources: {
      ...assembly.collectedSources,
      // Parse rejects tokens in model output; a reused digest can still carry one.
      webSubjectProfile: {
        ...produced.artifact!,
        subjectSummary: { answer: `The source quotes ${token}.`, sourceIds: [profileSource.id] },
      },
    },
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

test("prefixes an exact catalog id missing only metric: and validates it like any reference (CRWV run 44ca936f)", () => {
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
            text: "Margin <<operating-ratios.margin|period>>; cash << operating-ratios.cash >>.",
            sourceIds: [],
          },
        ],
      },
      [dated],
    ),
  );
  expect(report.keyFindings[0]).toEqual({
    text: "Margin 12.5% (6-month period ending 2026-03-31); cash €1.0M.",
    sourceIds: ["metric-source"],
    metricSourceIds: ["metric-source"],
    renderedMetrics: rendered(
      "Margin 12.5% (6-month period ending 2026-03-31); cash €1.0M.",
      "12.5% (6-month period ending 2026-03-31)",
      "€1.0M",
    ),
  });
  for (const [token, error] of [
    ["<<operating-ratios.missing>>", "unknown, unavailable, or unciteable"],
    ["<<operating-ratios.cash|period>>", "unsupported format"],
    ["<<Operating-Ratios.margin>>", "Malformed metric reference <<Operating-Ratios.margin>>"],
    ["<<ratios.margin>>", "Malformed metric reference <<ratios.margin>>"],
  ] as const) {
    expect(() =>
      assembleResearchReport(input({ keyFindings: [{ text: token, sourceIds: [] }] }, [dated])),
    ).toThrow(error);
  }
  expect(() => assembleResearchReport(input({ summary: "<<operating-ratios.margin>>" }))).toThrow(
    "require a cited narrative claim",
  );
});

test("names the dated ids a dateless reference stands for (0097.KL run 62ba6299)", () => {
  const periods = ["2026-09-30", "2025-09-30"];
  const dated = {
    ...section,
    metrics: section.metrics
      .slice(0, 2)
      .map((metric, index) => ({ ...metric, id: `margin-quarter-${periods[index]!}` })),
  };
  const run = (token: string) => () =>
    assembleResearchReport(input({ keyFindings: [{ text: token, sourceIds: [] }] }, [dated]));

  expect(run("<<metric:operating-ratios.margin-quarter|period>>")).toThrow(
    "is unknown, unavailable, or unciteable; it names no metric, but these do: <<metric:operating-ratios.margin-quarter-2026-09-30>>, <<metric:operating-ratios.margin-quarter-2025-09-30>>",
  );
  expect(run("<<metric:operating-ratios.missing>>")).toThrow(
    /unciteable; remove it or use an available metric reference$/u,
  );
});

test("prefixes an exact Valuation Workbench id whose section embeds a timestamp", () => {
  const workbench = {
    ...section,
    id: "valuation-workbench-fy-2025-12-31-2026-02-01T00:00:00.000Z",
  };
  const report = assembleResearchReport(
    input({ keyFindings: [{ text: `Margin <<${workbench.id}.margin>>.`, sourceIds: [] }] }, [
      workbench,
    ]),
  );
  expect(report.keyFindings[0]?.text).toBe("Margin 12.5%.");
  expect(() =>
    assembleResearchReport(
      input(
        { keyFindings: [{ text: `<<valuation-workbench-fy-2025-12-31.margin>>`, sourceIds: [] }] },
        [workbench],
      ),
    ),
  ).toThrow("Malformed metric reference <<valuation-workbench-fy-2025-12-31.margin>>");
});

test("names summary residue and every claim token in the same error", () => {
  const run = () =>
    assembleResearchReport(
      input({
        summary: "Stray >> in summary.",
        keyFindings: [
          { text: "<<unknown.a>> and <<metric:unknown.b>>", sourceIds: [] },
          { text: "<<operating-ratios.margin|abs>>", sourceIds: [] },
        ],
      }),
    );
  for (const part of [
    "summary, dataGaps and predictions cannot contain them",
    "Malformed metric reference <<unknown.a>> in text",
    "Metric reference <<metric:unknown.b>> is unknown",
    "Metric reference <<operating-ratios.margin|abs>> has an unsupported format",
  ]) {
    expect(run).toThrow(part);
  }
});

test("names the model's own token, not its prefixed form, and a summary reference once", () => {
  const message = (payload: ModelReportPayload) => {
    try {
      assembleResearchReport(input(payload));
    } catch (error) {
      return String(error);
    }
    throw new Error("expected a rejection");
  };
  expect(
    message({ keyFindings: [{ text: "<<operating-ratios.margin|abs>>", sourceIds: [] }] }),
  ).not.toContain("<<metric:operating-ratios.margin|abs>>");
  const summary = message({
    summary: "Margin <<metric:operating-ratios.margin>>",
    keyFindings: [{ text: "<<unknown.a>>", sourceIds: [] }],
  });
  expect(summary.match(/summary/gu)).toHaveLength(1);
  expect(summary).toContain("Malformed metric reference <<unknown.a>> in text");
});

test("names every invalid metric reference in one error", () => {
  const run = () =>
    assembleResearchReport(
      input({
        keyFindings: [
          {
            text: "<<financial-lens-growth.revenueDeltaPercent|period>> and <<metric:unknown.x>>",
            sourceIds: [],
          },
          { text: "Margin <<operating-ratios.margin|abs>> and stray >>", sourceIds: [] },
        ],
        risks: [{ text: "<<business framework growth>>", sourceIds: [] }],
      }),
    );
  for (const part of [
    "Malformed metric reference <<financial-lens-growth.revenueDeltaPercent|period>> in text",
    "Metric reference <<metric:unknown.x>> is unknown",
    "Metric reference <<operating-ratios.margin|abs>> has an unsupported format",
    "Malformed metric reference >> in text",
    "Malformed metric reference <<business framework growth>> in text",
  ]) {
    expect(run).toThrow(part);
  }
});

test("repairs a non-catalog unprefixed placeholder instead of publishing or guessing it", async () => {
  const assembly = input({});
  const reprompts: string[] = [];
  const result = await synthesizeReportUntilValid({
    ...assembly,
    knownSourceIds: new Set(sources.map(({ id }) => id)),
    priorStages: [],
    maxPredictionReprompts: 0,
    runFinalSynthesis: async (_prior, reprompt) => {
      reprompts.push(reprompt?.reportValidationErrors?.join(" ") ?? "");
      const text =
        reprompts.length === 1
          ? "Margin <<operating-ratios.marginal|period>>."
          : "Margin <<metric:operating-ratios.margin>>.";
      return {
        stage: "final-synthesis",
        tokenEstimate: 0,
        content: JSON.stringify({ ...assembly.payload, keyFindings: [{ text, sourceIds: [] }] }),
      };
    },
  });
  expect(reprompts[1]).toContain(
    "Malformed metric reference <<operating-ratios.marginal|period>> in text; write it as <<metric:section.metric>>",
  );
  expect(result.report.keyFindings[0]?.text).toBe("Margin 12.5%.");
});

function claims(...texts: readonly string[]): ModelReportPayload {
  return {
    ...researchReport({ predictions: [] }),
    keyFindings: texts.map((text) => ({ text, sourceIds: [] })),
  };
}

describe("catalog figure hints", () => {
  test("names the reference for a typed unit-bearing catalog value, and only at a figure boundary", () => {
    expect(
      catalogFigureHints(
        claims(
          "Margin held at 12.5%, cash €1.0M.",
          "Coverage 2.50x; 112.5% and -12.5% and 12.55%.",
        ),
        [section],
      ),
    ).toEqual([
      'Catalog figure hint: keyFindings[0].text types "12.5%", which equals the catalog value of <<metric:operating-ratios.margin>>; if that metric is the figure meant, write the reference in place of the typed number, otherwise keep the text',
      'Catalog figure hint: keyFindings[0].text types "€1.0M", which equals the catalog value of <<metric:operating-ratios.cash>>; if that metric is the figure meant, write the reference in place of the typed number, otherwise keep the text',
      'Catalog figure hint: keyFindings[1].text types "2.50x", which equals the catalog value of <<metric:operating-ratios.ratio>>; if that metric is the figure meant, write the reference in place of the typed number, otherwise keep the text',
    ]);
  });

  test("ignores unitless values, years, and figures already written as references", () => {
    const margin = section.metrics.find(({ id }) => id === "margin");
    if (margin?.status !== "value") {
      throw new Error("fixture margin must have a value");
    }
    const oscillators = {
      id: "oscillators",
      title: "Oscillators",
      metrics: [
        { ...margin, id: "rsi14", unit: "number" as const, value: 43.74 },
        { ...margin, id: "year", unit: "number" as const, value: 2025 },
      ],
    };
    expect(
      catalogFigureHints(
        claims("In 2025 RSI was 43.74 and margin <<metric:operating-ratios.margin>>."),
        [section, oscillators],
      ),
    ).toEqual([]);
  });

  test("lists every candidate when a typed value equals more than one catalog id", () => {
    expect(
      catalogFigureHints(claims("Margin was 12.5%."), [section, { ...section, id: "peer-ratios" }]),
    ).toEqual([
      'Catalog figure hint: keyFindings[0].text types "12.5%", which equals the catalog value of more than one metric, so the match is ambiguous: <<metric:operating-ratios.margin>>, <<metric:peer-ratios.margin>>; if one of them is the figure meant, write that reference in place of the typed number, otherwise keep the text',
    ]);
  });

  const synthesize = async (drafts: readonly string[]) => {
    const assembly = input({});
    const reprompts: (readonly string[] | undefined)[] = [];
    const result = await synthesizeReportUntilValid({
      ...assembly,
      knownSourceIds: new Set(sources.map(({ id }) => id)),
      priorStages: [],
      maxPredictionReprompts: 0,
      runFinalSynthesis: async (_prior, reprompt) => {
        reprompts.push(reprompt?.reportValidationErrors);
        const text = drafts[Math.min(reprompts.length, drafts.length) - 1] ?? "";
        return {
          stage: "final-synthesis",
          tokenEstimate: 0,
          content: JSON.stringify({
            ...assembly.payload,
            keyFindings: [{ text, sourceIds: ["metric-source"] }],
          }),
        };
      },
    });
    return { result, reprompts };
  };

  test("a hint alone never costs a repair call", async () => {
    const { result, reprompts } = await synthesize(["FY margin was 12.5%."]);
    expect(reprompts).toEqual([undefined]);
    expect(result.reportValidationErrors).toEqual([]);
    expect(result.stageOutputs.map(({ repromptReason }) => repromptReason)).toEqual([undefined]);
  });

  test("the prediction follow-up after a report repair hints only the latest draft", async () => {
    const assembly = input({});
    const drafts = [
      { text: "Cash €1.0M; coverage <<metric:operating-ratios.unknown>>.", predictions: [] },
      {
        text: "Cash <<metric:operating-ratios.cash>>; FY margin was 12.5%.",
        predictions: [{ id: "bad", measurableAs: "nonsense" }],
      },
      { text: "Cash <<metric:operating-ratios.cash>>.", predictions: [] },
    ];
    const reprompts: (readonly string[] | undefined)[] = [];
    const result = await synthesizeReportUntilValid({
      ...assembly,
      knownSourceIds: new Set(sources.map(({ id }) => id)),
      priorStages: [],
      maxPredictionReprompts: 0,
      runFinalSynthesis: async (_prior, reprompt) => {
        reprompts.push(reprompt?.reportValidationErrors);
        const draft = drafts[reprompts.length - 1] ?? drafts[2];
        return {
          stage: "final-synthesis",
          tokenEstimate: 0,
          content: JSON.stringify({
            ...assembly.payload,
            predictions: draft?.predictions,
            keyFindings: [{ text: draft?.text, sourceIds: ["metric-source"] }],
          }),
        };
      },
    });
    const hints = (index: number) =>
      (reprompts[index] ?? []).filter((line) => line.startsWith("Catalog figure hint:"));
    expect(reprompts).toHaveLength(3);
    expect(hints(1).map((line) => line.includes('"€1.0M"'))).toEqual([true]);
    expect(hints(2)).toHaveLength(1);
    expect(hints(2)[0]).toContain('types "12.5%"');
    expect(result.stageOutputs[2]?.repromptReason?.catalogFigureHints).toBe(1);
  });

  test("a repair owed anyway carries the hint after the errors and records its count", async () => {
    const { result, reprompts } = await synthesize([
      "FY margin was 12.5%; coverage <<metric:operating-ratios.unknown>>.",
      "FY margin was <<metric:operating-ratios.margin>>.",
    ]);
    const hint =
      'Catalog figure hint: keyFindings[0].text types "12.5%", which equals the catalog value of <<metric:operating-ratios.margin>>; if that metric is the figure meant, write the reference in place of the typed number, otherwise keep the text';
    expect(reprompts).toHaveLength(2);
    expect(reprompts[1]?.at(-1)).toBe(hint);
    expect(reprompts[1]?.[0]).toContain("Metric reference <<metric:operating-ratios.unknown>>");
    expect(result.stageOutputs[1]?.repromptReason?.catalogFigureHints).toBe(1);
    expect(result.reportValidationErrors).not.toContain(hint);
    expect(result.report.keyFindings[0]?.text).toBe("FY margin was 12.5%.");
  });
});

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
    text: "Margin 12.5% (6-month period ending 2026-03-31); again 12.5% (6-month period ending 2026-03-31).",
    sourceIds: ["metric-source"],
    metricSourceIds: ["metric-source"],
    renderedMetrics: rendered(
      "Margin 12.5% (6-month period ending 2026-03-31); again 12.5% (6-month period ending 2026-03-31).",
      "12.5% (6-month period ending 2026-03-31)",
      "12.5% (6-month period ending 2026-03-31)",
    ),
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

test("change metrics render signed with what they change over (HLIT 10-Q, H1 2026 run b8d04fa2)", () => {
  const { section: growth } = evaluateMetricSection(
    "financial-lens-growth",
    "Growth",
    [
      [48.523_248_504_039_67, "revenueDeltaPercent"],
      [-43.4, "netIncomeDeltaPercent"],
    ].map(
      ([value, id]): MetricDefinition => ({
        id: String(id),
        label: "YoY",
        unit: "whole-percent",
        basis: "YoY",
        change: { over: "YoY" },
        compute: () => ({
          status: "value",
          value: Number(value),
          periodEnd: "2026-07-03",
          periodMonths: 6,
          inputs: [
            {
              label: "revenue",
              value: 1,
              artifact: "statements",
              unit: "USD",
              sourceIds: ["metric-source"],
            },
          ],
        }),
      }),
    ),
    { symbol: "HLIT" },
  );
  const report = assembleResearchReport(
    input(
      {
        keyFindings: [
          {
            text: "Revenue was <<metric:financial-lens-growth.revenueDeltaPercent|period>>; net income <<metric:financial-lens-growth.netIncomeDeltaPercent>>.",
            sourceIds: [],
          },
        ],
      },
      [growth],
    ),
  );
  expect(report.keyFindings[0]!.text).toBe(
    "Revenue was +48.5% YoY (6-month period ending 2026-07-03); net income -43.4% YoY.",
  );
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
    text: "Close 108.00 vs 105.00 (+2.9% vs prior close), RSI14 55.00 (as of 2026-05-18).",
    sourceIds: ["verified-snapshot-AAPL"],
    metricSourceIds: ["verified-snapshot-AAPL"],
    renderedMetrics: rendered(
      "Close 108.00 vs 105.00 (+2.9% vs prior close), RSI14 55.00 (as of 2026-05-18).",
      "108.00",
      "105.00",
      "+2.9% vs prior close",
      "55.00 (as of 2026-05-18)",
    ),
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

test("market-session previousClose|period dates the prior session (run 7912637b)", () => {
  const snapshot = verifiedMarketSnapshot({
    symbol: "AMD",
    latestSessionDate: "2026-10-19",
    ohlcv: {
      date: "2026-10-19",
      open: 551.78,
      high: 554.41,
      low: 535.67,
      close: 538.05,
      volume: 1,
    },
    recentCloses: [
      { date: "2026-10-16", close: 528.75 },
      { date: "2026-10-19", close: 538.05 },
    ],
  });
  const report = assembleResearchReport({
    ...input({
      keyFindings: [
        {
          text: "Prior <<metric:market-session.previousClose|period>>, close <<metric:market-session.close|period>>.",
          sourceIds: [],
        },
      ],
    }),
    sources: [...sources, verifiedSnapshotSource(snapshot)],
    collectedSources: collectedSources({
      verifiedMarketSnapshot: snapshot,
      priceHistory: [
        {
          symbol: "AMD",
          sourceId: "price-history-AMD",
          currency: "USD",
          priceMode: "split-adjusted-close",
          bars: [],
        },
      ],
    }),
  });
  expect(report.keyFindings[0]?.text).toBe(
    "Prior $528.75 (as of 2026-10-16), close $538.05 (as of 2026-10-19).",
  );
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

describe("metric references through finalization", () => {
  const snapshot = verifiedMarketSnapshot();
  const web = newsSource({
    id: "web-aapl",
    kind: "web",
    url: "https://example.com/aapl-results",
    snippet:
      "Apple said services revenue rose to a record in the quarter, and its operating margin was 12.5% for the period. Its cash balance was €1.0M at period end.",
  });
  const finalSources = [...sources, verifiedSnapshotSource(snapshot), web];
  const collected = collectedSources({
    metricSections: [section],
    verifiedMarketSnapshot: snapshot,
  });
  const assessment: EvidenceQualityAssessment = {
    version: 1,
    rubricVersion: 3,
    label: "high",
    checks: [],
    limitingReasons: [],
    advisoryReasons: [],
  };
  const assembled = (keyFindings: ModelReportPayload["keyFindings"]) =>
    assembleResearchReport({
      ...input({ keyFindings }),
      sources: finalSources,
      collectedSources: collected,
    });
  const finalized = (keyFindings: ModelReportPayload["keyFindings"]) =>
    finalizeSynthesis(
      {
        report: assembled(keyFindings),
        sourceGaps: [],
        stageOutputs: [],
        predictionRetryErrors: [],
        predictionTrimWarnings: [],
        predictionErrors: [],
        reportValidationErrors: [],
        relocatedGapClaims: [],
      },
      collected,
      assessment,
      async () => ({ labels: new Map(), warnings: [] }),
    );

  test("keeps a market-session value beside a web citation", async () => {
    const result = await finalized([
      {
        text: "Shares closed at <<metric:market-session.close>> after the results.",
        sourceIds: [web.id],
      },
    ]);
    expect(result.integrityAudit.pruned).toEqual([]);
    expect(result.report.keyFindings[0]?.text).toBe("Shares closed at 108.00 after the results.");
  });

  test("exempts only the occurrence code rendered, never a typed copy of its value", async () => {
    const margin = "<<metric:operating-ratios.margin>>";
    const marginQuote = {
      sourceId: web.id,
      quote: "its operating margin was 12.5% for the period",
    };
    const prunedFigures = async (claim: object) =>
      (await finalized([claim])).integrityAudit.pruned.map(({ webFigure }) => webFigure?.figure);
    expect(await prunedFigures({ text: `Margin was ${margin}.`, sourceIds: [web.id] })).toEqual([]);
    expect(
      await prunedFigures({
        text: `Margin was ${margin}; backlog grew 12.5%.`,
        sourceIds: [web.id],
      }),
    ).toEqual(["12.5%"]);
    expect(
      await prunedFigures({
        text: `Backlog changed -12.5%; margin was ${margin}.`,
        sourceIds: [web.id],
        figureQuotes: [marginQuote],
      }),
    ).toEqual(["-12.5%"]);
  });

  test("a rendered value typed text touches is ambiguous, even beside a valid quote", async () => {
    const quotes = [
      { sourceId: web.id, quote: "its operating margin was 12.5% for the period" },
      { sourceId: web.id, quote: "Its cash balance was €1.0M at period end" },
    ];
    const pruned = async (text: string) =>
      (
        await finalized([{ text, sourceIds: [web.id], figureQuotes: quotes }])
      ).integrityAudit.pruned.map(({ webFigure }) => [webFigure?.reason, webFigure?.figure]);
    const margin = "<<metric:operating-ratios.margin>>";
    const cash = "<<metric:operating-ratios.cash>>";
    for (const [text, figure] of [
      [`Margin was -${margin}.`, "12.5%"],
      [`Margin was -**${margin}**.`, "12.5%"],
      [`Cash was ${cash} bn.`, "€1.0M"],
      [`Cash was ${cash}  bn.`, "€1.0M"],
      [`Cash was ${cash}\nbn.`, "€1.0M"],
      [`Cash was USD  ${cash}.`, "€1.0M"],
      [`Cash was USD\n${cash}.`, "€1.0M"],
      [`Cash was USD ${cash}.`, "€1.0M"],
      [`DPS was <<metric:operating-ratios.dps>> million.`, "£0.25"],
      [`Margin ranged 10-${margin}.`, "12.5%"],
      [`Margin ranged from 10 to ${margin}.`, "12.5%"],
    ]) {
      expect(await pruned(text!)).toEqual([["figure-ambiguous", figure]]);
    }
    expect(await pruned(`Margin was ${margin}; cash was ${cash}.`)).toEqual([]);
    expect(await pruned(`Margin was ${margin} (-1.2pp).`)).toEqual([
      ["figure-not-in-quote", "-1.2pp"],
    ]);
  });

  test("ignores draft-supplied rendered metrics and metric source ids", async () => {
    const forged = {
      text: "Backlog grew 900%.",
      sourceIds: [web.id],
      metricSourceIds: [web.id],
      renderedMetrics: [{ field: "text", start: 13, text: "900%" }],
    };
    const result = await finalized([forged]);
    expect(result.integrityAudit.pruned.map(({ webFigure }) => webFigure?.figure)).toEqual([
      "900%",
    ]);
    const stripped = citeMetricReferences(
      {
        ...input({}).payload,
        keyFindings: [forged],
        scenarios: [{ name: "Up", description: "Backlog grew 900%.", ...forged }],
        extras: { businessFramework: { sections: [{ id: "moat", ...forged }] } },
      },
      [section],
    );
    expect(JSON.stringify(stripped)).not.toMatch(/renderedMetrics|metricSourceIds/u);
  });

  test("a finalized report keeps claim provenance through the artifact reader", async () => {
    const { report } = await finalized([
      {
        text: "Margin was <<metric:operating-ratios.margin>>.",
        sourceIds: [web.id],
        figureQuotes: [{ sourceId: web.id, quote: "services revenue rose to a record" }],
      },
    ]);
    expect(report.keyFindings[0]).toMatchObject({
      metricSourceIds: ["metric-source"],
      renderedMetrics: [{ field: "text", start: 11, text: "12.5%" }],
    });
    expect(readReport(JSON.parse(JSON.stringify(report)))?.keyFindings).toEqual(report.keyFindings);
  });
});
