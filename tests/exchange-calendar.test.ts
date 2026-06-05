import { describe, expect, test } from "bun:test";
import { isExchangeHoliday, isExchangeTradingDay } from "../src/scoring/exchange-calendar";

function utc(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

describe("isExchangeHoliday", () => {
  test("recognizes the 2026 NYSE holiday slate", () => {
    const holidays2026: readonly [string, string][] = [
      ["2026-01-01", "New Year's Day"],
      ["2026-01-19", "Martin Luther King Jr. Day"],
      ["2026-02-16", "Washington's Birthday"],
      ["2026-04-03", "Good Friday"],
      ["2026-05-25", "Memorial Day"],
      ["2026-06-19", "Juneteenth"],
      ["2026-07-03", "Independence Day (observed Friday)"],
      ["2026-09-07", "Labor Day"],
      ["2026-11-26", "Thanksgiving Day"],
      ["2026-12-25", "Christmas Day"],
    ];
    for (const [day, label] of holidays2026) {
      expect(isExchangeHoliday(utc(day)), label).toBe(true);
    }
  });

  test("ordinary weekdays are not holidays", () => {
    expect(isExchangeHoliday(utc("2026-01-02"))).toBe(false);
    expect(isExchangeHoliday(utc("2026-07-06"))).toBe(false);
  });

  test("observes Saturday holidays on the prior Friday", () => {
    // Independence Day 2026 falls on Saturday, so 2026-07-04 is not itself a closure.
    // The observed closure shifts to Friday 2026-07-03 instead.
    expect(isExchangeHoliday(utc("2026-07-04"))).toBe(false);
    expect(isExchangeHoliday(utc("2026-07-03"))).toBe(true);
    // Christmas 2027 falls on Saturday and is observed the prior Friday.
    expect(isExchangeHoliday(utc("2027-12-24"))).toBe(true);
  });

  test("observes Sunday New Year on the following Monday but not Saturday New Year", () => {
    // Jan 1 2023 is Sunday, observed Monday Jan 2.
    expect(isExchangeHoliday(utc("2023-01-02"))).toBe(true);
    // Jan 1 2022 is Saturday, and the NYSE does not close the prior Friday.
    expect(isExchangeHoliday(utc("2021-12-31"))).toBe(false);
  });

  test("excludes Juneteenth before it became a federal holiday", () => {
    expect(isExchangeHoliday(utc("2021-06-18"))).toBe(false);
    expect(isExchangeHoliday(utc("2022-06-20"))).toBe(true);
  });

  test("tracks Good Friday across years via the Easter computus", () => {
    expect(isExchangeHoliday(utc("2025-04-18"))).toBe(true);
    expect(isExchangeHoliday(utc("2027-03-26"))).toBe(true);
  });
});

describe("isExchangeTradingDay", () => {
  test("weekends are never trading days", () => {
    expect(isExchangeTradingDay(utc("2026-07-04"))).toBe(false);
    expect(isExchangeTradingDay(utc("2026-07-05"))).toBe(false);
  });

  test("holidays that fall on weekdays are not trading days", () => {
    expect(isExchangeTradingDay(utc("2026-07-03"))).toBe(false);
    expect(isExchangeTradingDay(utc("2026-12-25"))).toBe(false);
  });

  test("open weekdays are trading days", () => {
    expect(isExchangeTradingDay(utc("2026-07-02"))).toBe(true);
    expect(isExchangeTradingDay(utc("2026-07-06"))).toBe(true);
  });
});
