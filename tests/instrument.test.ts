import { describe, expect, test } from "bun:test";
import { createInstrument, instrumentKey } from "../src/domain/instrument";

describe("instrument", () => {
  test("keeps symbol plus asset class as the compatibility key", () => {
    const equity = createInstrument("coin", "equity");
    const crypto = createInstrument("coin", "crypto");

    expect(instrumentKey(equity)).toBe("equity:COIN");
    expect(instrumentKey(crypto)).toBe("crypto:COIN");
  });

  test("rejects invalid symbols", () => {
    expect(() => createInstrument("../secret", "equity")).toThrow("Symbol");
  });
});
