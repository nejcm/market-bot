import { describe, expect, test } from "bun:test";
import { daysBetween, roundedDaysAfter } from "../src/config/shared";

describe("daysBetween", () => {
  test("returns the signed fractional span from start to end", () => {
    expect(daysBetween("2025-01-01", "2025-12-31")).toBe(364);
    expect(daysBetween("2025-12-31", "2025-01-01")).toBe(-364);
    expect(daysBetween("2025-01-01T00:00:00Z", "2025-01-01T12:00:00Z")).toBe(0.5);
  });

  test("returns zero for the same day", () => {
    expect(daysBetween("2025-06-30", "2025-06-30")).toBe(0);
  });

  test("returns undefined when either date does not parse", () => {
    expect(daysBetween("not-a-date", "2025-06-30")).toBeUndefined();
    expect(daysBetween("2025-06-30", "")).toBeUndefined();
  });
});

describe("roundedDaysAfter", () => {
  test("rounds the signed span from earlier to later", () => {
    expect(roundedDaysAfter("2025-01-11", "2025-01-01")).toBe(10);
    expect(roundedDaysAfter("2025-01-01", "2025-01-11")).toBe(-10);
    expect(roundedDaysAfter("2025-01-01T13:00:00Z", "2025-01-01")).toBe(1);
  });

  test("passes NaN through when a date does not parse", () => {
    expect(roundedDaysAfter("not-a-date", "2025-01-01")).toBeNaN();
  });
});
