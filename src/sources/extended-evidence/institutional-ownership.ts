import { isInstrumentCommand } from "../../cli/args";
import { sourceGap, sourceGapStatusCode } from "../../domain/source-gaps";
import type { Source, SourceGap } from "../../domain/types";
import { isRecord, readNumber } from "../../guards";
import { isUsListing } from "../instrument-capability";
import { isFetchJsonResult, type CollectContext, type RawSourceSnapshot } from "../types";
import { collectedItem, evidenceSource, type CollectedItem, type ProviderResult } from "./common";
import { encodeQuery, readArray } from "./utils";

export interface InstitutionalHolderMetrics {
  readonly provider: "finnhub";
  readonly holderCount: number;
  readonly reportedShares?: number;
  readonly reportedOwnershipPercent?: number;
  readonly sourceIds: readonly string[];
  readonly observedAt: string;
}

export interface InsiderTransactionMetrics {
  readonly provider: "finnhub";
  readonly transactionCount: number;
  readonly purchaseCount: number;
  readonly saleCount: number;
  readonly netShareChange?: number;
  readonly sourceIds: readonly string[];
  readonly observedAt: string;
}

export interface InstitutionalOwnershipArtifact {
  readonly version: 1;
  readonly generatedAt: string;
  readonly symbol: string;
  readonly institutionalHolders?: InstitutionalHolderMetrics;
  readonly insiderTransactions?: InsiderTransactionMetrics;
}

export interface InstitutionalOwnershipSignal {
  readonly status: "available" | "forbidden" | "missing-credential";
  readonly sourceIds: readonly string[];
}

export interface InstitutionalOwnershipProviderResult extends ProviderResult {
  readonly artifact?: InstitutionalOwnershipArtifact;
  readonly signal: InstitutionalOwnershipSignal;
}

interface RouteDefinition {
  readonly adapter: string;
  readonly endpoint: string;
  readonly label: string;
  readonly sourceSuffix: "institutional" | "insider-transactions";
}

const INSTITUTIONAL_ROUTE: RouteDefinition = {
  adapter: "finnhub-institutional-ownership",
  endpoint: "/stock/ownership",
  label: "institutional ownership",
  sourceSuffix: "institutional",
};

const INSIDER_ROUTE: RouteDefinition = {
  adapter: "finnhub-insider-transactions",
  endpoint: "/stock/insider-transactions",
  label: "insider transactions",
  sourceSuffix: "insider-transactions",
};

const ROUTES: readonly RouteDefinition[] = [INSTITUTIONAL_ROUTE, INSIDER_ROUTE];
const ROUTE_ADAPTERS = new Set(ROUTES.map((route) => route.adapter));

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = readNumber(record, key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function sum(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0);
}

export function parseInstitutionalHolderMetrics(payload: unknown): {
  readonly holderCount: number;
  readonly reportedShares?: number;
  readonly reportedOwnershipPercent?: number;
} {
  const rows = Array.isArray(payload) ? payload : readArray(payload, "ownership");
  const holdings = rows.filter((row) => isRecord(row));
  const reportedShares = sum(
    holdings.flatMap((holding) => {
      const value = firstNumber(holding, ["share", "shares"]);
      return value === undefined ? [] : [value];
    }),
  );
  const reportedOwnershipPercent = sum(
    holdings.flatMap((holding) => {
      const value = firstNumber(holding, [
        "ownership",
        "ownershipPercent",
        "percentHeld",
        "portfolioPercent",
      ]);
      return value === undefined ? [] : [value];
    }),
  );
  return {
    holderCount: holdings.length,
    ...(reportedShares !== undefined ? { reportedShares } : {}),
    ...(reportedOwnershipPercent !== undefined ? { reportedOwnershipPercent } : {}),
  };
}

export function parseInsiderTransactionMetrics(payload: unknown): {
  readonly transactionCount: number;
  readonly purchaseCount: number;
  readonly saleCount: number;
  readonly netShareChange?: number;
} {
  const rows = Array.isArray(payload) ? payload : readArray(payload, "data");
  const transactions = rows.filter((row) => isRecord(row));
  const changes = transactions.flatMap((transaction) => {
    const value = firstNumber(transaction, ["change", "shareChange"]);
    return value === undefined ? [] : [value];
  });
  const netShareChange = sum(changes);
  return {
    transactionCount: transactions.length,
    purchaseCount: changes.filter((change) => change > 0).length,
    saleCount: changes.filter((change) => change < 0).length,
    ...(netShareChange !== undefined ? { netShareChange } : {}),
  };
}

function routeSourceId(symbol: string, route: RouteDefinition): string {
  return `extended-finnhub-ownership-${symbol.toLowerCase()}-${route.sourceSuffix}`;
}

function routeSource(context: CollectContext, route: RouteDefinition, observedAt: string): Source {
  if (!isInstrumentCommand(context.command)) {
    throw new Error("Institutional ownership evidence requires an instrument command");
  }
  return evidenceSource(
    routeSourceId(context.command.symbol, route),
    `${context.command.symbol} external ${route.label} context`,
    "finnhub",
    context.command,
    observedAt,
  );
}

function normalizeGap(gap: SourceGap): SourceGap {
  if (sourceGapStatusCode(gap.message) !== "403") {
    return gap;
  }
  const route = ROUTES.find((candidate) => candidate.adapter === gap.source);
  return sourceGap({
    source: gap.source,
    message: `Finnhub ${route?.label ?? "ownership"} endpoint is unavailable for the configured token (status 403)`,
    provider: "finnhub",
    capability: "extended-evidence",
    cause: "unsupported-coverage",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

function unavailableGaps(
  cause: "missing-credential" | "unsupported-coverage",
  message: (route: RouteDefinition) => string,
): readonly SourceGap[] {
  return ROUTES.map((route) =>
    sourceGap({
      source: route.adapter,
      message: message(route),
      provider: "finnhub",
      capability: "extended-evidence",
      cause,
      evidenceQualityImpact: "extended-evidence-cap",
    }),
  );
}

function signalFrom(
  artifact: InstitutionalOwnershipArtifact | undefined,
  gaps: readonly SourceGap[],
): InstitutionalOwnershipSignal {
  const ownershipGaps = gaps.filter((gap) => ROUTE_ADAPTERS.has(gap.source));
  if (ownershipGaps.some((gap) => gap.cause === "missing-credential")) {
    return { status: "missing-credential", sourceIds: [] };
  }
  if (
    ownershipGaps.some(
      (gap) => gap.cause === "unsupported-coverage" && sourceGapStatusCode(gap.message) === "403",
    )
  ) {
    return { status: "forbidden", sourceIds: [] };
  }
  return {
    status: "available",
    sourceIds: [
      ...(artifact?.institutionalHolders?.sourceIds ?? []),
      ...(artifact?.insiderTransactions?.sourceIds ?? []),
    ],
  };
}

export function deriveInstitutionalOwnership(
  symbol: string,
  generatedAt: string,
  rawSnapshots: readonly RawSourceSnapshot[],
  gaps: readonly SourceGap[],
): {
  readonly artifact?: InstitutionalOwnershipArtifact;
  readonly signal: InstitutionalOwnershipSignal;
} {
  const snapshots = new Map(
    rawSnapshots
      .filter((snapshot) => ROUTE_ADAPTERS.has(snapshot.adapter))
      .map((snapshot) => [snapshot.adapter, snapshot]),
  );
  const institutionalSnapshot = snapshots.get(INSTITUTIONAL_ROUTE.adapter);
  const insiderSnapshot = snapshots.get(INSIDER_ROUTE.adapter);
  const institutionalHolders =
    institutionalSnapshot === undefined
      ? undefined
      : {
          provider: "finnhub" as const,
          ...parseInstitutionalHolderMetrics(institutionalSnapshot.payload),
          sourceIds: [routeSourceId(symbol, INSTITUTIONAL_ROUTE)],
          observedAt: institutionalSnapshot.fetchedAt,
        };
  const insiderTransactions =
    insiderSnapshot === undefined
      ? undefined
      : {
          provider: "finnhub" as const,
          ...parseInsiderTransactionMetrics(insiderSnapshot.payload),
          sourceIds: [routeSourceId(symbol, INSIDER_ROUTE)],
          observedAt: insiderSnapshot.fetchedAt,
        };
  const artifact =
    snapshots.size === 0
      ? undefined
      : {
          version: 1 as const,
          generatedAt,
          symbol,
          ...(institutionalHolders !== undefined ? { institutionalHolders } : {}),
          ...(insiderTransactions !== undefined ? { insiderTransactions } : {}),
        };
  return { ...(artifact !== undefined ? { artifact } : {}), signal: signalFrom(artifact, gaps) };
}

function evidenceItems(
  context: CollectContext,
  artifact: InstitutionalOwnershipArtifact | undefined,
): readonly CollectedItem[] {
  if (artifact === undefined || !isInstrumentCommand(context.command)) {
    return [];
  }
  const institutional =
    artifact.institutionalHolders === undefined
      ? []
      : [
          collectedItem(
            "institutional-ownership",
            `${context.command.symbol} external institutional ownership context`,
            "External institutional ownership data from Finnhub (context only, not market-bot authored).",
            routeSource(context, INSTITUTIONAL_ROUTE, artifact.institutionalHolders.observedAt),
            {
              provider: "finnhub",
              holderCount: artifact.institutionalHolders.holderCount,
              ...(artifact.institutionalHolders.reportedShares !== undefined
                ? { reportedShares: artifact.institutionalHolders.reportedShares }
                : {}),
              ...(artifact.institutionalHolders.reportedOwnershipPercent !== undefined
                ? {
                    reportedOwnershipPercent:
                      artifact.institutionalHolders.reportedOwnershipPercent,
                  }
                : {}),
            },
          ),
        ];
  const insider =
    artifact.insiderTransactions === undefined
      ? []
      : [
          collectedItem(
            "institutional-ownership",
            `${context.command.symbol} external insider transaction context`,
            "External insider transaction data from Finnhub (context only, not market-bot authored).",
            routeSource(context, INSIDER_ROUTE, artifact.insiderTransactions.observedAt),
            {
              provider: "finnhub",
              transactionCount: artifact.insiderTransactions.transactionCount,
              purchaseCount: artifact.insiderTransactions.purchaseCount,
              saleCount: artifact.insiderTransactions.saleCount,
              ...(artifact.insiderTransactions.netShareChange !== undefined
                ? { netShareChange: artifact.insiderTransactions.netShareChange }
                : {}),
            },
          ),
        ];
  return [...institutional, ...insider];
}

export async function collectInstitutionalOwnership(
  context: CollectContext,
): Promise<InstitutionalOwnershipProviderResult> {
  const { command } = context;
  if (
    !isInstrumentCommand(command) ||
    command.assetClass !== "equity" ||
    command.depth !== "deep"
  ) {
    return {
      rawSnapshots: [],
      items: [],
      gaps: [],
      signal: { status: "available", sourceIds: [] },
    };
  }
  if (!isUsListing(command.symbol, context.instrumentIdentity)) {
    const gaps = unavailableGaps(
      "unsupported-coverage",
      (route) => `Finnhub ${route.label} endpoint does not support ${command.symbol}`,
    );
    return {
      rawSnapshots: [],
      items: [],
      gaps,
      signal: { status: "available", sourceIds: [] },
    };
  }
  if (context.finnhubApiToken === undefined) {
    const gaps = unavailableGaps(
      "missing-credential",
      (route) => `MARKET_BOT_FINNHUB_API_TOKEN is not set for the Finnhub ${route.label} endpoint`,
    );
    return {
      rawSnapshots: [],
      items: [],
      gaps,
      signal: { status: "missing-credential", sourceIds: [] },
    };
  }

  const results = await Promise.all(
    ROUTES.map((route) =>
      context.request.json({
        url: `https://finnhub.io/api/v1${route.endpoint}?${encodeQuery({
          symbol: command.symbol,
          token: context.finnhubApiToken as string,
        })}`,
        adapter: route.adapter,
      }),
    ),
  );
  const fetched = results.filter((result) => isFetchJsonResult(result));
  const gaps = results
    .filter((result): result is SourceGap => !isFetchJsonResult(result))
    .map((gap) => normalizeGap(gap));
  const derived = deriveInstitutionalOwnership(
    command.symbol,
    context.fetchedAt,
    fetched.map((result) => result.rawSnapshot),
    gaps,
  );
  return {
    rawSnapshots: fetched.map((result) => result.rawSnapshot),
    items: evidenceItems(context, derived.artifact),
    gaps,
    ...(derived.artifact !== undefined ? { artifact: derived.artifact } : {}),
    signal: derived.signal,
  };
}
