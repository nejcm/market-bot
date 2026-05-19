import { describe, expect, test } from "bun:test";
import { createInstrument, instrumentKey } from "../src/domain/instrument";

describe("instrument", () => {
  test("uses symbol plus asset class identity", () => {
    const equity = createInstrument("coin", "equity");
    const crypto = createInstrument("coin", "crypto");

    expect(instrumentKey(equity)).toBe("equity:COIN");
    expect(instrumentKey(crypto)).toBe("crypto:COIN");
  });

  test("rejects invalid symbols", () => {
    expect(() => createInstrument("../secret", "equity")).toThrow("Symbol");
  });
});
