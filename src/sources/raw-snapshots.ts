import { createHash } from "node:crypto";
import type { RawSourceSnapshot } from "./types";

export const RAW_SNAPSHOT_COMPACTION_THRESHOLD_BYTES = 1024 * 1024;

interface CompactRawPayloadSummary {
  readonly compacted: true;
  readonly originalPayloadBytes: number;
  readonly payloadSha256: string;
  readonly topLevelType: string;
  readonly topLevelKeys?: readonly string[];
  readonly arrayLength?: number;
  readonly objectFieldTypes?: Readonly<Record<string, string>>;
  readonly arrayItemTypes?: readonly string[];
}

function valueType(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function objectFieldTypes(value: Record<string, unknown>): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 50)
      .map(([key, item]) => [key, valueType(item)]),
  );
}

function compactPayloadSummary(
  payload: unknown,
  payloadBytes: number,
  payloadSha256: string,
): CompactRawPayloadSummary {
  if (Array.isArray(payload)) {
    return {
      compacted: true,
      originalPayloadBytes: payloadBytes,
      payloadSha256,
      topLevelType: "array",
      arrayLength: payload.length,
      arrayItemTypes: [...new Set(payload.slice(0, 50).map(valueType))],
    };
  }
  if (payload !== null && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    return {
      compacted: true,
      originalPayloadBytes: payloadBytes,
      payloadSha256,
      topLevelType: "object",
      topLevelKeys: Object.keys(record).slice(0, 100),
      objectFieldTypes: objectFieldTypes(record),
    };
  }
  return {
    compacted: true,
    originalPayloadBytes: payloadBytes,
    payloadSha256,
    topLevelType: valueType(payload),
  };
}

function payloadJson(payload: unknown): string {
  return JSON.stringify(payload) ?? "null";
}

export function compactOversizedRawSnapshots(
  snapshots: readonly RawSourceSnapshot[],
  thresholdBytes = RAW_SNAPSHOT_COMPACTION_THRESHOLD_BYTES,
): readonly RawSourceSnapshot[] {
  return snapshots.map((snapshot) => {
    const serialized = payloadJson(snapshot.payload);
    const payloadBytes = Buffer.byteLength(serialized);
    if (payloadBytes <= thresholdBytes) {
      return snapshot;
    }
    const payloadSha256 = createHash("sha256").update(serialized).digest("hex");
    return {
      id: snapshot.id,
      adapter: snapshot.adapter,
      fetchedAt: snapshot.fetchedAt,
      payload: compactPayloadSummary(snapshot.payload, payloadBytes, payloadSha256),
      payloadCompacted: true,
      payloadBytes,
      payloadSha256,
    };
  });
}
