import { describe, expect, test } from "bun:test";
import { isNewsRelevant } from "../src/sources/news-relevance";
import type { Source } from "../src/domain/types";
import type { NewsRelevanceTarget } from "../src/sources/types";

function source(overrides: Partial<Source> = {}): Source {
  return {
    id: "news-1",
    kind: "news",
    title: "",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    assetClass: "equity",
    ...overrides,
  };
}

function target(overrides: Partial<NewsRelevanceTarget> = {}): NewsRelevanceTarget {
  return { symbol: "AAPL", ...overrides };
}

describe("isNewsRelevant", () => {
  test("returns false when targets is empty", () => {
    const src = source({ symbol: "AAPL", title: "Apple stock surges" });
    expect(isNewsRelevant(src, [])).toBe(false);
  });

  test("returns true on exact symbol match from source.symbol", () => {
    const src = source({ symbol: "AAPL" });
    expect(isNewsRelevant(src, [target({ symbol: "AAPL" })])).toBe(true);
  });

  test("symbol match is case-insensitive (source uppercase, target lowercase)", () => {
    const src = source({ symbol: "aapl" });
    expect(isNewsRelevant(src, [target({ symbol: "AAPL" })])).toBe(true);
  });

  test("returns true when ticker appears as $TICKER token in title", () => {
    const src = source({ title: "$AAPL rallies on strong earnings" });
    expect(isNewsRelevant(src, [target({ symbol: "AAPL" })])).toBe(true);
  });

  test("returns true when ticker appears as ALL-CAPS token in title", () => {
    const src = source({ title: "AAPL closes at new high" });
    expect(isNewsRelevant(src, [target({ symbol: "AAPL" })])).toBe(true);
  });

  test("returns true on lowercase symbol mention when allowLowercaseSymbolMention is set", () => {
    const src = source({ title: "why aapl is the best tech bet" });
    expect(
      isNewsRelevant(src, [target({ symbol: "AAPL", allowLowercaseSymbolMention: true })]),
    ).toBe(true);
  });

  test("returns false on lowercase symbol mention when allowLowercaseSymbolMention is not set", () => {
    const src = source({ title: "why aapl is the best tech bet" });
    expect(isNewsRelevant(src, [target({ symbol: "AAPL" })])).toBe(false);
  });

  test("returns true on company-name term match", () => {
    const src = source({ title: "Apple supplier sees record orders" });
    expect(isNewsRelevant(src, [target({ symbol: "AAPL", name: "Apple Inc." })])).toBe(true);
  });

  test("ignores company suffix terms in name matching", () => {
    // "inc" is a suffix term — matching only "Apple" (>=4 chars, not suffix)
    const src = source({ title: "Apple supplier confirms deal" });
    expect(isNewsRelevant(src, [target({ symbol: "NVDA", name: "Apple Inc." })])).toBe(true);
  });

  test("rejects generic topic terms — broad headline does not match specific target", () => {
    // "stocks" is in GENERIC_TOPIC_TERMS; "market" also
    const src = source({ title: "Stocks rally as market shrugs off inflation data" });
    expect(isNewsRelevant(src, [target({ symbol: "AAPL", name: "Apple Inc." })])).toBe(false);
  });

  test("subject-defining word (not in GENERIC_TOPIC_TERMS) is retained", () => {
    // "small" and "caps" are not generic — they define the theme subject
    const src = source({ title: "Small caps lead broad market rally" });
    expect(isNewsRelevant(src, [target({ symbol: "IWM", name: "small caps" })])).toBe(true);
  });

  test("returns true when any target matches, even if another does not", () => {
    const src = source({ symbol: "TSLA" });
    expect(isNewsRelevant(src, [target({ symbol: "AAPL" }), target({ symbol: "TSLA" })])).toBe(
      true,
    );
  });

  test("returns false when no target matches at all", () => {
    const src = source({ title: "Nvidia posts blowout quarter" });
    expect(isNewsRelevant(src, [target({ symbol: "AAPL", name: "Apple Inc." })])).toBe(false);
  });
});
