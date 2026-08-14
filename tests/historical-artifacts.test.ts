import { describe, expect, test } from "bun:test";
import { readValuationWorkbenchArtifact } from "../src/sources/extended-evidence/valuation-workbench-contract";

describe("frozen historical artifacts", () => {
  test("reads a pre-0008 valuation workbench with a retired suppression reason", async () => {
    // This real on-disk artifact is outside fixtures/runs/**/golden-output by design. Never regenerate it.
    const artifact: unknown = await Bun.file(
      new URL("fixtures/artifacts/valuation-workbench-bns-pre-0008.json", import.meta.url),
    ).json();

    expect(JSON.stringify(artifact).match(/quote-reporting-currency-mismatch/gu)).toHaveLength(9);
    expect(readValuationWorkbenchArtifact(artifact)).toBeDefined();
  });

  test("reads a valuation workbench with a retired price-selection rule", async () => {
    // This real on-disk artifact is outside fixtures/runs/**/golden-output by design. Never regenerate it.
    // The rule string it carries was retired in 6f45873, unrelated to plan 0008.
    const artifact: unknown = await Bun.file(
      new URL(
        "fixtures/artifacts/valuation-workbench-aapl-retired-price-rule.json",
        import.meta.url,
      ),
    ).json();

    expect(
      JSON.stringify(artifact).match(/first verified close on or after publicAt/gu),
    ).toHaveLength(1);
    expect(readValuationWorkbenchArtifact(artifact)).toBeDefined();
  });
});
