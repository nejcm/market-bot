import { describe, expect, test } from "bun:test";
import type { InstrumentIdentity } from "../src/domain/types";
import {
  hasNonUsSuffix,
  isInternationalIdentity,
  isUsListing,
} from "../src/sources/instrument-capability";

describe("isUsListing", () => {
  test("classifies US symbols without a suffix as US", () => {
    expect(isUsListing("AAPL")).toBe(true);
    expect(isUsListing("MSFT")).toBe(true);
  });

  test("treats US share-class dots as US (not a non-US suffix)", () => {
    expect(isUsListing("BRK.B")).toBe(true);
    expect(isUsListing("HEI.A")).toBe(true);
  });

  test("classifies LSE and other international suffixed symbols as non-US", () => {
    expect(isUsListing("RR.L")).toBe(false);
    expect(isUsListing("VOD.L")).toBe(false);
    expect(isUsListing("RY.TO")).toBe(false);
    expect(isUsListing("AIR.PA")).toBe(false);
    expect(isUsListing("SAP.DE")).toBe(false);
    expect(isUsListing("0700.HK")).toBe(false);
    expect(isUsListing("7203.T")).toBe(false);
  });

  test("covers suffixes that the prior capability set was missing (Copenhagen/Singapore/Taiwan)", () => {
    // These were classified international by run-health validation but US by the capability
    // Gate before the predicates were unified — they must now agree (non-US).
    expect(isUsListing("NOVO-B.CO")).toBe(false);
    expect(isUsListing("D05.SI")).toBe(false);
    expect(isUsListing("2330.TW")).toBe(false);
  });

  test("uses a non-USD quote currency as the primary non-US signal (no suffix needed)", () => {
    expect(isUsListing("VOD", { quoteCurrency: "GBp" })).toBe(false);
    expect(isUsListing("SAP", { quoteCurrency: "EUR" })).toBe(false);
    // USD quote currency does not by itself force a US classification away from a non-US suffix.
    expect(isUsListing("AAPL", { quoteCurrency: "USD" })).toBe(true);
  });

  test("uses a non-US exchange name from identity when present", () => {
    expect(isUsListing("VOD", { exchange: "London Stock Exchange" })).toBe(false);
    expect(isUsListing("RY", { exchange: "Toronto Stock Exchange" })).toBe(false);
  });

  test("treats an unrecognized exchange as US (conservative default)", () => {
    expect(isUsListing("AAPL", { exchange: "Nasdaq Global Select" })).toBe(true);
    expect(isUsListing("UNKNOWN", { exchange: "Some New Venue" })).toBe(true);
  });

  test("defaults to US when neither exchange nor a non-US suffix is present", () => {
    expect(isUsListing("UNKNOWN")).toBe(true);
  });
});

describe("hasNonUsSuffix", () => {
  test("matches known non-US suffixes case-insensitively and ignores share-class dots", () => {
    expect(hasNonUsSuffix("RR.L")).toBe(true);
    expect(hasNonUsSuffix("rr.l")).toBe(true);
    expect(hasNonUsSuffix("BRK.B")).toBe(false);
    expect(hasNonUsSuffix("AAPL")).toBe(false);
  });
});

describe("isInternationalIdentity", () => {
  test("treats a non-USD quote currency as international", () => {
    expect(isInternationalIdentity({ quoteCurrency: "GBp" })).toBe(true);
    expect(isInternationalIdentity({ quoteCurrency: "USD" })).toBe(false);
  });

  test("aggressively treats any non-US exchange as international (unlike the capability gate)", () => {
    expect(isInternationalIdentity({ exchange: "London Stock Exchange" })).toBe(true);
    expect(isInternationalIdentity({ exchange: "Some New Venue" })).toBe(true);
    expect(isInternationalIdentity({ exchange: "NASDAQ" })).toBe(false);
  });

  test("is not international when identity is absent or carries no signal", () => {
    const absent: InstrumentIdentity | undefined = undefined;
    expect(isInternationalIdentity(absent)).toBe(false);
    expect(isInternationalIdentity({})).toBe(false);
  });
});
