import { describe, expect, test } from "bun:test";
import { readCapitalOwnershipArtifact } from "../src/sources/extended-evidence/capital-ownership";
import { readFinancialStatementsArtifact } from "../src/sources/extended-evidence/financial-statements-contract";
import { readReverseDcfArtifact } from "../src/sources/extended-evidence/reverse-dcf";
import { parseFinancialTableMappingOutput } from "../src/sources/extended-evidence/untagged-financial-table-validation";
import { readValuationWorkbenchArtifact } from "../src/sources/extended-evidence/valuation-workbench-contract";

describe("frozen historical artifacts", () => {
  test("reads capital ownership version 1", async () => {
    const artifact: unknown = await Bun.file(
      new URL("fixtures/artifacts/capital-ownership-aapl-readable-v1.json", import.meta.url),
    ).json();

    expect(readCapitalOwnershipArtifact(artifact)).toBeDefined();
  });

  test("reads financial statements version 1", async () => {
    const artifact: unknown = await Bun.file(
      new URL("fixtures/artifacts/financial-statements-asts-readable-v1.json", import.meta.url),
    ).json();

    expect(readFinancialStatementsArtifact(artifact)).toBeDefined();
  });

  test("reads reverse DCF version 1", async () => {
    const artifact: unknown = await Bun.file(
      new URL("fixtures/artifacts/reverse-dcf-aapl-readable-v1.json", import.meta.url),
    ).json();

    expect(readReverseDcfArtifact(artifact)).toBeDefined();
  });

  test("reads financial table mapping version 1", async () => {
    const content = await Bun.file(
      new URL("fixtures/artifacts/financial-table-mapping-nbis-readable-v1.json", import.meta.url),
    ).text();

    expect(parseFinancialTableMappingOutput(content)).toHaveProperty("mapping");
  });

  test("reads a pre-0008 valuation workbench with a retired suppression reason", async () => {
    // This real on-disk artifact is outside fixtures/runs/**/golden-output by design. Never regenerate it.
    const artifact: unknown = await Bun.file(
      new URL("fixtures/artifacts/valuation-workbench-bns-pre-0008.json", import.meta.url),
    ).json();

    expect(JSON.stringify(artifact).match(/quote-reporting-currency-mismatch/gu)).toHaveLength(9);
    expect(readValuationWorkbenchArtifact(artifact)).toBeDefined();
  });

  test("reads valuation workbench version 1 with a retired price-selection rule", async () => {
    // This real on-disk artifact is outside fixtures/runs/**/golden-output by design. Never regenerate it.
    // The rule string it carries was retired in 6f45873, unrelated to plan 0008.
    const artifact: unknown = await Bun.file(
      new URL(
        "fixtures/artifacts/valuation-workbench-aapl-retired-price-rule.json",
        import.meta.url,
      ),
    ).json();

    expect(artifact).toMatchObject({ version: 1 });
    expect(
      JSON.stringify(artifact).match(/first verified close on or after publicAt/gu),
    ).toHaveLength(1);
    expect(readValuationWorkbenchArtifact(artifact)).toBeDefined();
  });
});
