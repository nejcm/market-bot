import { describe, expect, test } from "bun:test";
import {
  ADAPTER_FRESHNESS,
  adapterFreshnessBudget,
  type SourceAdapter,
} from "../src/sources/adapter-freshness";

function substringRuleBudget(adapter: string): "live" | "news" | "reference" {
  if (
    adapter.includes("news") ||
    adapter === "apewisdom" ||
    adapter.startsWith("exa-search") ||
    adapter.includes("social")
  ) {
    return "news";
  }
  if (
    adapter.startsWith("sec-") ||
    adapter.startsWith("fred") ||
    adapter.startsWith("nasdaq-") ||
    adapter.startsWith("cboe-") ||
    adapter.startsWith("exa-contents") ||
    adapter.startsWith("glassnode") ||
    adapter.includes("expirations") ||
    adapter.includes("events")
  ) {
    return "reference";
  }
  return "live";
}

describe("adapter freshness budgets", () => {
  test.each(Object.keys(ADAPTER_FRESHNESS))(
    "%s keeps the budget the substring rules gave it",
    (adapter) => {
      expect(adapterFreshnessBudget(adapter)).toBe(substringRuleBudget(adapter));
    },
  );

  test.each(["s-1", "f-1", "8-k", "6-k", "10-k"])(
    "SEC current-feed adapter for form %s stays on the reference budget",
    (form) => {
      const adapter: SourceAdapter = `sec-alpha-search-current-${form}`;
      expect(adapterFreshnessBudget(adapter)).toBe("reference");
      expect(adapterFreshnessBudget(adapter)).toBe(substringRuleBudget(adapter));
    },
  );

  test.each(["test-adapter", "constructor", "__proto__", "toString", "", "vendor-news-feed"])(
    "unlisted adapter %p falls back to the live budget",
    (adapter) => {
      expect(adapterFreshnessBudget(adapter)).toBe("live");
    },
  );

  test("an unlisted adapter name does not typecheck", () => {
    // @ts-expect-error every adapter needs a freshness budget entry
    const adapter: SourceAdapter = "vendor-news-feed";
    expect(adapterFreshnessBudget(adapter)).toBe("live");
  });
});
