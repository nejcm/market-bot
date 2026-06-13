import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { compactOversizedRawSnapshots } from "../src/sources/raw-snapshots";
import type { RawSourceSnapshot } from "../src/sources/types";

describe("compactOversizedRawSnapshots", () => {
  test("preserves small raw snapshots", () => {
    const snapshot: RawSourceSnapshot = {
      id: "raw-1",
      adapter: "adapter",
      fetchedAt: "2026-06-01T00:00:00.000Z",
      payload: { ok: true },
    };

    expect(compactOversizedRawSnapshots([snapshot], 1024)).toEqual([snapshot]);
  });

  test("compacts oversized payloads with digest and structural summary", () => {
    const payload = {
      results: Array.from({ length: 5 }, (_, index) => ({ index, name: "x".repeat(8) })),
    };
    const serialized = JSON.stringify(payload);
    const [compacted] = compactOversizedRawSnapshots(
      [
        {
          id: "raw-big",
          adapter: "listed-universe",
          fetchedAt: "2026-06-01T00:00:00.000Z",
          payload,
        },
      ],
      10,
    );

    expect(compacted).toBeDefined();
    if (compacted === undefined) {
      throw new Error("Expected compacted snapshot");
    }
    expect(compacted).toMatchObject({
      id: "raw-big",
      adapter: "listed-universe",
      fetchedAt: "2026-06-01T00:00:00.000Z",
      payloadCompacted: true,
      payloadBytes: Buffer.byteLength(serialized),
      payloadSha256: createHash("sha256").update(serialized).digest("hex"),
    });
    expect(compacted.payload).toMatchObject({
      compacted: true,
      topLevelType: "object",
      topLevelKeys: ["results"],
      objectFieldTypes: { results: "array" },
    });
  });
});
