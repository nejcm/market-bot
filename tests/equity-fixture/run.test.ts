import { afterEach, describe, expect, test } from "bun:test";
import { parseArgs } from "../../src/cli/args";
import type { ModelRequest } from "../../src/model/types";
import {
  assertComprehensiveAnalysisPath,
  assertCurrencyConvertedValuation,
  assertDepositoryEnterpriseValueAbsent,
  assertEstimatedEarningsSuppressionPath,
  assertInvariants,
  assertNbisUnsupportedInputs,
  factForms,
  factTaxonomies,
} from "../support/run-fixtures/assertions";
import { readGoldenOutput, scrubbedRunArtifacts } from "../support/run-fixtures/artifacts";
import { diffGolden, formatGoldenMismatch } from "../support/run-fixtures/golden-diff";
import { loadFixture, runFixture, type RunFixtureResult } from "../support/run-fixtures";
import { makeReplayProvider } from "../support/run-fixtures/llm-cassette";
import { violatesResearchOnly } from "../../src/domain/research-language";
import { validateResearchReport } from "../../src/report/schema";
import { deriveFundamentalHistoryFromFinancialStatements } from "../../src/sources/extended-evidence/fundamental-history-canonical";
import { addFinancialLensEvidence } from "../../src/sources/extended-evidence/financial-lens";
import { withCanonicalFinancialLensInputs } from "../../src/sources/extended-evidence/financial-lens-canonical";

const FIXTURES = [
  "equity-aapl-brief",
  "equity-aapl-deep",
  "equity-earnings-release-deep",
  "equity-nbis-deep",
  "equity-fpi-quarterly",
  "equity-fpi-ifrs-semiannual",
  "equity-analysis-comprehensive",
  "equity-analysis-estimated-suppressed",
  "equity-web-fallback-deep",
  "equity-depository-deep",
] as const;

const EXPECTED_COMPLETENESS_GRADES = {
  "equity-aapl-brief": ["blocked", "limited"],
  "equity-aapl-deep": ["complete", "limited"],
  "equity-earnings-release-deep": ["complete", "limited"],
  "equity-nbis-deep": ["partial", "limited"],
  "equity-fpi-quarterly": ["complete", "limited"],
  "equity-fpi-ifrs-semiannual": ["complete", "limited"],
  "equity-analysis-comprehensive": ["complete", "substantial"],
  "equity-analysis-estimated-suppressed": ["complete", "limited"],
  "equity-web-fallback-deep": ["complete", "substantial"],
  "equity-depository-deep": ["partial", "limited"],
} as const;

const CAPTURE_EARNINGS_FIXTURES = new Set<string>([
  "equity-analysis-comprehensive",
  "equity-analysis-estimated-suppressed",
]);

const runResults: RunFixtureResult[] = [];

afterEach(async () => {
  await Promise.all(runResults.splice(0).map((result) => result.cleanup()));
});

describe("static equity run fixtures", () => {
  for (const name of FIXTURES) {
    test(`${name} replays through the real equity pipeline`, async () => {
      const fixture = await loadFixture(name);
      const modelRequests: ModelRequest[] = [];
      const modelOutputs: string[] = [];
      const replayProvider = makeReplayProvider(fixture.llmCassette);
      const result = await runFixture(name, {
        llm: "replay",
        ...(CAPTURE_EARNINGS_FIXTURES.has(name)
          ? {
              provider: {
                name: replayProvider.name,
                generate: async (request: ModelRequest) => {
                  modelRequests.push(request);
                  const response = await replayProvider.generate(request);
                  modelOutputs.push(response.content);
                  return response;
                },
              },
            }
          : {}),
      });
      runResults.push(result);
      const golden = await readGoldenOutput(name);

      await assertInvariants(result, fixture.meta);
      expect([
        result.report.equityAnalysisCompleteness?.financialCoreStatus,
        result.report.equityAnalysisCompleteness?.coverageLevel,
      ]).toEqual([...EXPECTED_COMPLETENESS_GRADES[name]]);
      if (name === "equity-nbis-deep") {
        expect(factTaxonomies(result)).toContain("us-gaap");
        expect(factForms(result).has("20-F")).toBe(true);
        await assertNbisUnsupportedInputs();
      }
      if (name === "equity-depository-deep") {
        assertDepositoryEnterpriseValueAbsent(result);
        assertCurrencyConvertedValuation(result);
      }
      if (name === "equity-fpi-quarterly") {
        expect(factTaxonomies(result)).toEqual(["us-gaap"]);
        expect([...factForms(result)]).toEqual(expect.arrayContaining(["20-F", "6-K"]));
      }
      if (name === "equity-fpi-ifrs-semiannual") {
        expect(factTaxonomies(result)).toEqual(["ifrs-full"]);
        expect([...factForms(result)]).toEqual(expect.arrayContaining(["20-F", "6-K"]));
      }
      if (name === "equity-analysis-comprehensive") {
        assertComprehensiveAnalysisPath(result, modelRequests);
      }
      if (name === "equity-analysis-estimated-suppressed") {
        assertEstimatedEarningsSuppressionPath(result, modelRequests, modelOutputs);
      }
      if (fixture.meta.argv.includes("--deep")) {
        expect(result.deepEquityEvidenceBundle).toMatchObject({
          schemaVersion: 1,
          run: { symbol: expect.any(String), analysisAsOf: fixture.meta.now },
          evidence: {
            marketSnapshots: expect.any(Array),
            supplementalMarketSnapshots: expect.any(Array),
            newsSources: expect.any(Array),
            extendedSources: expect.any(Array),
          },
          derived: expect.any(Object),
          governance: {
            sourceGaps: expect.any(Array),
            sourcePlan: expect.any(Object),
            evidenceLanes: expect.any(Object),
            sourceLedger: expect.any(Object),
          },
          context: { historicalContext: expect.any(Object) },
        });
        expect(JSON.stringify(result.deepEquityEvidenceBundle)).not.toContain("rawSnapshots");
        const financialStatements = result.deepEquityEvidenceBundle?.derived.financialStatements;
        if (financialStatements !== undefined) {
          const fundamentalHistory = result.deepEquityEvidenceBundle?.derived.fundamentalHistory;
          if (fundamentalHistory !== undefined) {
            expect(fundamentalHistory).toEqual(
              deriveFundamentalHistoryFromFinancialStatements(financialStatements),
            );
          }
          const command = parseArgs(fixture.meta.argv);
          if (command.jobType !== "equity") {
            throw new Error(`${name} financial statements require an equity command`);
          }
          const recomputedFinancialLenses = addFinancialLensEvidence(
            command,
            result.collectedSources.marketSnapshots,
            withCanonicalFinancialLensInputs(
              result.collectedSources.extendedEvidence,
              financialStatements,
            ),
            result.collectedSources.verifiedMarketSnapshot,
            financialStatements.generatedAt,
            result.collectedSources.subsequentFinancing,
          ).artifact;
          expect(
            result.deepEquityEvidenceBundle?.derived.financialLenses,
            "[B11] financial lenses must rederive from canonical statement inputs",
          ).toEqual(recomputedFinancialLenses);
        }
      }
      const scrubbed = await scrubbedRunArtifacts(result.artifacts.runDir);
      try {
        expect(scrubbed).toEqual(golden);
      } catch (error) {
        throw new Error(formatGoldenMismatch(name, diffGolden(golden, scrubbed)), {
          cause: error,
        });
      }
    });
  }

  test("deep equity markdown partitions the reader block from preserved appendix detail", async () => {
    const name = "equity-analysis-comprehensive";
    const result = await runFixture(name, { llm: "replay" });
    runResults.push(result);

    const marker = "\n## Appendix\n";
    expect(result.markdown.match(/## Appendix/gu)).toHaveLength(1);
    const [reader, appendix] = result.markdown.split(marker);
    expect(reader).toBeDefined();
    expect(appendix).toBeDefined();

    const readerHeadings = [
      "## What the Company Does",
      "## Price and Market Date",
      "## Financial Trends",
      "## Valuation Context",
      "## Catalysts",
      "## Key Findings",
      "## Risks",
      "## Upcoming Earnings and Consensus",
      "## Material Data Gaps",
    ];
    let previous = -1;
    for (const heading of readerHeadings) {
      const index = reader!.indexOf(heading);
      expect(index, heading).toBeGreaterThan(previous);
      previous = index;
      expect(appendix, heading).not.toContain(heading);
    }

    const appendixOnly = [
      "\n### Balance Sheet and Share Count\n",
      "\n### Business Framework\n",
      "\n### Analyst Estimate Distributions\n",
      "\n### External Analyst Estimate Context\n",
      "\n### External Ownership Context\n",
      "\n### Earnings Setup\n",
      "\n### Historical Context\n",
      "\n### Scenarios\n",
      "\n### Predictions\n",
      "\n### Diagnostic Data Gaps\n",
      "\n### Valuation Workbench\n",
      "DELL | secondary | excluded",
      "\n### Reverse DCF Input Sensitivity\n",
    ];
    for (const fragment of appendixOnly) {
      expect(reader, fragment).not.toContain(fragment);
      expect(appendix, fragment).toContain(fragment);
    }
    expect(reader).not.toMatch(
      /\b(?:criteria-(?:supported|mixed|not-supported)|insufficient-data)\b/u,
    );
    expect(reader).toContain("- No cited plain-language company description is available.");
    expect(reader).toContain("Period | Revenue | Net income | Operating margin | FCF");
    expect(reader).toMatch(/^FY ending \d{4}-\d{2}-\d{2} \(filed \d{4}-\d{2}-\d{2}\) \| -?[\d]/mu);
    expect(reader).not.toContain("history is unavailable");
    expect(appendix).toContain("Period | Cash | Debt | Diluted shares");
    expect(appendix).toContain("Interim ending 2026-03-31 (filed 2026-05-01) | 60.0B | 100.0B | —");
    expect(reader).not.toContain("Cash");
    expect(reader).not.toContain("Debt");
    expect(reader).not.toContain("Diluted shares");
    expect(reader).toContain("this is valuation context, not a target price.");
    expect(reader).toContain(
      "this is valuation context, not a target price. [market-yahoo-equity-aapl]",
    );
    expect(reader).toContain(
      "**EPS consensus:** 1.72 (single-provider snapshot) [extended-finnhub-events-aapl]",
    );
    expect(reader).toContain(
      "**Revenue consensus:** 98.0B (single-provider snapshot) [extended-finnhub-events-aapl]",
    );
    expect(reader).toContain("**Material:** emitted 2 of 5");
    expect(appendix).not.toContain("predictionShortfall:");
    expect(reader).not.toContain("fred-macro:");
    expect(appendix).not.toContain("fred-macro:");
    expect(appendix).not.toContain("**Diagnostic:** sec-edgar: Missing SEC company facts");
    expect(appendix).toMatch(
      /\d+ diagnostic data gaps; see the Research Console Advanced view or report\.json for details\./u,
    );
    expect(reader).not.toContain("marketaux-news:");
    expect(appendix).not.toContain("marketaux-news:");
    expect(reader).not.toContain("- **Median:**");
    expect(appendix).toContain("- **Median:**");
    for (const title of [
      "AAPL external EPS estimate consensus",
      "AAPL external revenue estimate consensus",
      "AAPL external EBITDA estimate consensus",
    ]) {
      expect(appendix!).toContain(`#### ${title}`);
    }
    expect(appendix!.match(/Mean \| Median \| High \| Low \| Count/gu)).toHaveLength(3);
    expect(appendix).not.toMatch(/^## /mu);
    expect(appendix).not.toContain("### Extended Evidence");
    expect(appendix).not.toContain("#### Fact Ledger");
    expect(appendix).not.toContain("- **Business** (criteria-supported):");
    expect(appendix).not.toContain("- **Phase**:");
    expect(appendix).not.toContain("- **Growth** (criteria-supported):");
    expect(appendix).toContain("- **Moat** (criteria-supported):");
    expect(appendix).toContain("- **Management** (insufficient-data):");
    expect(appendix).toContain("- **Risk** (criteria-supported):");
    expect(appendix).toContain("- **Valuation** (criteria-supported):");
    expect(
      appendix!.match(/^\| (?:8|9|10|11|12|13|14|15|16)% \|(?: \d+\.\d{2}% \|){5}$/gmu),
    ).toHaveLength(9);

    const preservedReportContent = [
      result.report.summary,
      ...result.report.keyFindings.map((item) => item.text),
      ...result.report.bullCase.map((item) => item.text),
      ...result.report.bearCase.map((item) => item.text),
      ...result.report.risks.map((item) => item.text),
      ...result.report.catalysts.map((item) => item.text),
      ...result.report.scenarios.map((item) => item.description),
    ];
    for (const fragment of preservedReportContent) {
      expect(result.markdown, fragment).toContain(fragment);
    }
    expect(
      violatesResearchOnly(reader!.slice(reader!.indexOf("## What the Company Does"))),
    ).toBeNull();

    const framework = result.report.extras?.businessFramework;
    expect(framework).toBeObject();
    if (
      framework === null ||
      typeof framework !== "object" ||
      !("sections" in framework) ||
      !Array.isArray(framework.sections)
    ) {
      throw new Error("Fixture business framework is unavailable");
    }
    const invalidReport = {
      ...result.report,
      extras: {
        ...result.report.extras,
        businessFramework: {
          ...framework,
          sections: framework.sections.map((section, index) =>
            index === 0 && section !== null && typeof section === "object"
              ? { ...section, sourceIds: ["missing-appendix-source"] }
              : section,
          ),
        },
      },
    };
    expect(() => validateResearchReport(invalidReport)).toThrow(
      "Business Framework sections[0] (Business) cites unknown source ID: missing-appendix-source",
    );
  });
});
