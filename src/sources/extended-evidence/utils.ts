import { isRecord, readNumber, readString } from "../../guards";

export interface ArtifactObservationDrop {
  readonly reason: string;
  readonly count: number;
}

export interface ArtifactReadDiagnostics {
  readonly droppedObservationCount: number;
  readonly drops: readonly ArtifactObservationDrop[];
}

export type ReadArtifact<T> = T & { readonly readDiagnostics?: ArtifactReadDiagnostics };

const EMPTY_ARTIFACT_READ_DIAGNOSTICS: ArtifactReadDiagnostics = {
  droppedObservationCount: 0,
  drops: [],
};

export function readArtifactReadDiagnostics(
  value: Readonly<Record<string, unknown>>,
): ArtifactReadDiagnostics | undefined {
  if (value.readDiagnostics === undefined) {
    return EMPTY_ARTIFACT_READ_DIAGNOSTICS;
  }
  if (
    !isRecord(value.readDiagnostics) ||
    !Number.isInteger(value.readDiagnostics.droppedObservationCount) ||
    (value.readDiagnostics.droppedObservationCount as number) < 0 ||
    !Array.isArray(value.readDiagnostics.drops)
  ) {
    return undefined;
  }
  const drops = value.readDiagnostics.drops.filter(
    (drop): drop is ArtifactObservationDrop =>
      isRecord(drop) &&
      typeof drop.reason === "string" &&
      drop.reason.length > 0 &&
      Number.isInteger(drop.count) &&
      (drop.count as number) > 0,
  );
  if (
    drops.length !== value.readDiagnostics.drops.length ||
    drops.reduce((sum, drop) => sum + drop.count, 0) !==
      value.readDiagnostics.droppedObservationCount
  ) {
    return undefined;
  }
  return {
    droppedObservationCount: value.readDiagnostics.droppedObservationCount as number,
    drops,
  };
}

export function readArtifactObservations<T>(
  values: readonly unknown[],
  reason: string,
  read: (value: unknown) => T | undefined,
): { readonly observations: readonly T[]; readonly drops: readonly ArtifactObservationDrop[] } {
  const observations = values.flatMap((value) => {
    const observation = read(value);
    return observation === undefined ? [] : [observation];
  });
  const count = values.length - observations.length;
  return { observations, drops: count === 0 ? [] : [{ reason, count }] };
}

export function withArtifactReadDiagnostics<T extends object>(
  artifact: T,
  previous: ArtifactReadDiagnostics,
  drops: readonly ArtifactObservationDrop[],
): ReadArtifact<T> {
  const combined = [...previous.drops];
  for (const drop of drops) {
    const index = combined.findIndex((entry) => entry.reason === drop.reason);
    if (index === -1) {
      combined.push(drop);
    } else {
      combined[index] = { reason: drop.reason, count: combined[index]!.count + drop.count };
    }
  }
  return {
    ...artifact,
    readDiagnostics: {
      droppedObservationCount:
        previous.droppedObservationCount + drops.reduce((sum, drop) => sum + drop.count, 0),
      drops: combined,
    },
  };
}

export function encodeQuery(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

export function daysFrom(fetchedAt: string, days: number): string {
  const date = new Date(fetchedAt);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function latestNumber(
  values: readonly unknown[],
  keys: readonly string[],
): number | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (!isRecord(value)) {
      continue;
    }
    for (const key of keys) {
      const n = readNumber(value, key);
      if (n !== undefined) {
        return n;
      }
      const s = readString(value, key);
      if (s !== undefined) {
        const parsed = Number(s);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }
  }
  return undefined;
}

export function readArray(value: unknown, key: string): readonly unknown[] {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : [];
}
