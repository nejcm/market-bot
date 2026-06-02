import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJson } from "../artifacts";
import { isRecord } from "../sources/guards";
import type { RawSourceSnapshot } from "../sources/types";

const MS_PER_HOUR = 60 * 60 * 1000;

function isRawSnapshot(value: unknown): value is RawSourceSnapshot {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.adapter === "string" &&
    typeof value.fetchedAt === "string" &&
    "payload" in value
  );
}

function isExpired(snapshot: RawSourceSnapshot, now: Date, retentionHours: number): boolean {
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  if (!Number.isFinite(fetchedAt)) {
    return true;
  }

  return now.getTime() - fetchedAt > retentionHours * MS_PER_HOUR;
}

function redactSnapshot(snapshot: RawSourceSnapshot): RawSourceSnapshot {
  return {
    ...snapshot,
    payload: {
      redacted: true,
      reason: "Reddit raw text retention window expired",
    },
  };
}

async function readSnapshots(path: string): Promise<readonly RawSourceSnapshot[] | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!Array.isArray(parsed)) {
      return undefined;
    }

    return parsed.filter((value): value is RawSourceSnapshot => isRawSnapshot(value));
  } catch {
    return undefined;
  }
}

async function redactRunSnapshots(options: {
  readonly snapshotsPath: string;
  readonly retentionHours: number;
  readonly now: Date;
}): Promise<number> {
  const snapshots = await readSnapshots(options.snapshotsPath);
  if (snapshots === undefined) {
    return 0;
  }

  let redactedCount = 0;
  const redacted = snapshots.map((snapshot) => {
    if (
      snapshot.adapter !== "reddit" ||
      (isRecord(snapshot.payload) && snapshot.payload.redacted === true) ||
      !isExpired(snapshot, options.now, options.retentionHours)
    ) {
      return snapshot;
    }

    redactedCount += 1;
    return redactSnapshot(snapshot);
  });

  if (redactedCount > 0) {
    await writeJson(options.snapshotsPath, redacted);
  }

  return redactedCount;
}

export async function redactExpiredRedditRawSnapshots(options: {
  readonly dataDir: string;
  readonly retentionHours: number;
  readonly now: Date;
}): Promise<number> {
  const runEntries = await readdir(options.dataDir, { withFileTypes: true }).catch(() => []);
  const counts = await Promise.all(
    runEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        redactRunSnapshots({
          snapshotsPath: join(options.dataDir, entry.name, "raw", "snapshots.json"),
          retentionHours: options.retentionHours,
          now: options.now,
        }),
      ),
  );

  return counts.reduce((total, count) => total + count, 0);
}
