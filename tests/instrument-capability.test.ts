import { describe, expect, test } from "bun:test";
import { isUsListing } from "../src/sources/instrument-capability";

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
