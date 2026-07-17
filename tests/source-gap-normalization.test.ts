import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceGap } from "../src/domain/source-gaps";
import { normalizeCanonicalSourceGaps } from "../src/research/source-gap-normalization";
import { loadRunArtifact } from "../src/run-artifacts";
import { collectedSources, researchReport } from "./support/fixtures";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("source gap normalization", () => {
  test("dedupes top-level, extended evidence, and market context gaps", () => {
    const first = sourceGap({
      source: "sec-edgar",
      message: "Missing SEC company facts: grossProfit",
      cause: "provider-data-missing",
      evidenceQualityImpact: "extended-evidence-cap",
    });
    const duplicate = sourceGap({
      source: "sec-edgar",
      message: " Missing SEC   company facts: grossProfit ",
      cause: "validation-failed",
      evidenceQualityImpact: "core-cap",
    });
    const distinct = sourceGap({
      source: "sec-edgar",
      message: "Missing comparable SEC company facts for YoY deltas: capex",
      cause: "provider-data-missing",
      evidenceQualityImpact: "extended-evidence-cap",
    });
    const marketGap = sourceGap({
      source: "fred-market-context",
      message: "missing DGS10",
      capability: "market-context",
    });

    const normalized = normalizeCanonicalSourceGaps(
      collectedSources({
        sourceGaps: [first, duplicate, distinct],
        extendedEvidence: {
          instrument: { symbol: "AAPL", assetClass: "equity" },
          items: [],
          gaps: [first, duplicate, distinct],
        },
        marketContext: {
          assetClass: "equity",
          items: [],
          gaps: [marketGap, { ...marketGap, message: " missing   DGS10 " }],
        },
      }),
    );

    expect(normalized.sourceGaps).toEqual([first, distinct]);
    expect(normalized.extendedEvidence?.gaps).toEqual([first, distinct]);
    expect(normalized.marketContext?.gaps).toEqual([marketGap]);
  });

  test("consolidates nested SEC company-fact gaps at the canonical boundary", () => {
    const subset = sourceGap({
      source: "sec-edgar",
      message: "Missing SEC company facts: grossProfit",
      cause: "provider-data-missing",
      evidenceQualityImpact: "extended-evidence-cap",
    });
    const superset = sourceGap({
      source: "sec-edgar",
      message: "Missing SEC company facts: grossProfit, capex",
      cause: "provider-data-missing",
      evidenceQualityImpact: "extended-evidence-cap",
    });

    const normalized = normalizeCanonicalSourceGaps(
      collectedSources({
        sourceGaps: [subset, superset],
        extendedEvidence: {
          instrument: { symbol: "AAPL", assetClass: "equity" },
          items: [],
          gaps: [subset, superset],
        },
      }),
    );

    const consolidated = { ...superset };
    expect(normalized.sourceGaps).toEqual([consolidated]);
    expect(normalized.extendedEvidence?.gaps).toEqual([consolidated]);
  });

  test("preserves source gap symbol through artifact write and read", async () => {
    const runDir = join(
      tmpdir(),
      `market-bot-source-gap-normalization-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    tmpDirs.push(runDir);
    const gap = sourceGap({ source: "sec-edgar", message: "missing", symbol: "AAPL" });
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "report.json"),
      `${JSON.stringify(
        researchReport({
          runId: "source-gap-symbol-round-trip",
          extendedEvidence: {
            instrument: { symbol: "AAPL", assetClass: "equity" },
            items: [],
            gaps: [gap],
          },
        }),
        null,
        2,
      )}\n`,
      "utf8",
    );

    const { artifact } = await loadRunArtifact(runDir);

    expect(artifact?.report.extendedEvidence?.gaps).toEqual([gap]);
  });
});
