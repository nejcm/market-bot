import type { InstrumentIdentity, MarketBenchmark, MarketSnapshot } from "../domain/types";
import {
  sanitizeModelInputField,
  type ModelInputSanitizationAggregateEntry,
} from "./model-input-sanitizer";

function rebuildIdentity(
  identity: InstrumentIdentity,
  displayName: string | undefined,
  exchange: string | undefined,
): InstrumentIdentity {
  const { displayName: _displayName, exchange: _exchange, ...rest } = identity;
  return {
    ...rest,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(exchange !== undefined ? { exchange } : {}),
  };
}

function rebuildBenchmark(
  benchmark: MarketBenchmark,
  name: string | undefined,
  sector: string | undefined,
): MarketBenchmark {
  const { name: _name, sector: _sector, ...rest } = benchmark;
  return {
    ...rest,
    ...(name !== undefined ? { name } : {}),
    ...(sector !== undefined ? { sector } : {}),
  };
}

export function sanitizeInstrumentIdentityMetadata(
  identity: InstrumentIdentity,
  provider: string,
): {
  readonly identity: InstrumentIdentity;
  readonly entries: readonly ModelInputSanitizationAggregateEntry[];
} {
  const displayName =
    identity.displayName === undefined
      ? undefined
      : sanitizeModelInputField(identity.displayName, {
          provider,
          ingress: "instrument-identity",
          profile: "short-metadata",
          fieldRole: "title",
        });
  const exchange =
    identity.exchange === undefined
      ? undefined
      : sanitizeModelInputField(identity.exchange, {
          provider,
          ingress: "instrument-identity",
          profile: "short-metadata",
          fieldRole: "publisher",
        });
  return {
    identity: rebuildIdentity(identity, displayName?.text, exchange?.text),
    entries: [displayName, exchange].flatMap((result) =>
      result === undefined ? [] : [result.entry],
    ),
  };
}

export function sanitizeMarketSnapshotMetadata(
  snapshot: MarketSnapshot,
  provider: string,
): {
  readonly snapshot: MarketSnapshot;
  readonly entries: readonly ModelInputSanitizationAggregateEntry[];
} {
  const entries: ModelInputSanitizationAggregateEntry[] = [];
  function clean(value: string | undefined, fieldRole: "title" | "publisher"): string | undefined {
    if (value === undefined) {
      return undefined;
    }
    const result = sanitizeModelInputField(value, {
      provider,
      ingress: "market-snapshot",
      profile: "short-metadata",
      fieldRole,
    });
    entries.push(result.entry);
    return result.text;
  }
  const name = clean(snapshot.name, "title");
  const displayName = clean(snapshot.identity?.displayName, "title");
  const exchange = clean(snapshot.identity?.exchange, "publisher");
  const benchmarkName = clean(snapshot.benchmark?.name, "title");
  const benchmarkSector = clean(snapshot.benchmark?.sector, "publisher");
  const identity =
    snapshot.identity === undefined
      ? undefined
      : rebuildIdentity(snapshot.identity, displayName, exchange);
  const benchmark =
    snapshot.benchmark === undefined
      ? undefined
      : rebuildBenchmark(snapshot.benchmark, benchmarkName, benchmarkSector);
  const { name: _name, identity: _identity, benchmark: _benchmark, ...snapshotRest } = snapshot;
  return {
    snapshot: {
      ...snapshotRest,
      ...(name !== undefined ? { name } : {}),
      ...(identity !== undefined ? { identity } : {}),
      ...(benchmark !== undefined ? { benchmark } : {}),
    },
    entries,
  };
}
