import type { InstrumentCommand } from "../cli/args";
import type { ExtendedEvidenceItem, InstrumentIdentity, Source, SourceGap } from "../domain/types";
import { collectSecFilingEvidence, type EvidenceRequestToolOutput } from "./evidence-request-tools";
import {
  collectSec,
  fetchSecCompanyFactsForSymbol,
  secProviderResultFromCompanyFacts,
  type SecCompanyFactsResult,
  type SecSicClassification,
} from "./extended-evidence/sec-edgar";
import type { ProviderResult } from "./extended-evidence/common";
import { isUsListing } from "./instrument-capability";
import type { CollectContext, RawSourceSnapshot } from "./types";

export interface SecFilingPacket {
  readonly form: "10-K" | "10-Q" | "8-K" | "6-K";
  readonly filingDate: string;
  readonly reportDate?: string;
  readonly accessionNumber: string;
  readonly primaryDocument: string;
  readonly source: Source;
  readonly item: ExtendedEvidenceItem;
  readonly rawSnapshot?: RawSourceSnapshot;
}

export interface SecTargetPacket {
  readonly symbol: string;
  readonly status: "available" | "failed" | "unsupported";
  readonly cik?: string;
  readonly identity?: InstrumentIdentity;
  readonly cikMapping?: {
    readonly ticker: string;
    readonly cik: string;
    readonly name?: string;
    readonly payload: unknown;
    readonly rawSnapshot: RawSourceSnapshot;
  };
  readonly companyFacts?: {
    readonly payload: unknown;
    readonly sourceId: string;
    readonly sourceUrl?: string;
    readonly fetchedAt?: string;
  };
  readonly submissions?: {
    readonly payload: unknown;
    readonly sourceId: string;
    readonly sourceUrl?: string;
    readonly fetchedAt?: string;
    readonly sic?: SecSicClassification;
  };
  readonly latest10K?: SecFilingPacket;
  readonly newer10Q?: SecFilingPacket;
  readonly recent8Ks: readonly SecFilingPacket[];
  readonly recent6Ks: readonly SecFilingPacket[];
  readonly companyFactsResult?: SecCompanyFactsResult;
  readonly providerResult: ProviderResult;
  readonly filingEvidence: EvidenceRequestToolOutput;
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly gaps: readonly SourceGap[];
}

const EMPTY_FILING_EVIDENCE: EvidenceRequestToolOutput = {
  rawSnapshots: [],
  sources: [],
  items: [],
  gaps: [],
};

export async function collectSecTargetPacketBase(
  ctx: CollectContext,
  command: InstrumentCommand,
): Promise<SecTargetPacket> {
  if (!isUsListing(command.symbol, ctx.instrumentIdentity)) {
    const providerResult = await collectSec(ctx);
    return {
      symbol: command.symbol.toUpperCase(),
      status: "unsupported",
      recent8Ks: [],
      recent6Ks: [],
      providerResult,
      filingEvidence: EMPTY_FILING_EVIDENCE,
      rawSnapshots: providerResult.rawSnapshots,
      gaps: providerResult.gaps,
    };
  }

  const companyFactsResult = await fetchSecCompanyFactsForSymbol(ctx, command.symbol);
  const providerResult = secProviderResultFromCompanyFacts(ctx, companyFactsResult);
  const tickerSnapshot = companyFactsResult.rawSnapshots.find(
    (snapshot) => snapshot.adapter === "sec-tickers",
  );
  const status =
    companyFactsResult.cik !== undefined &&
    companyFactsResult.factsPayload !== undefined &&
    companyFactsResult.submissionsPayload !== undefined
      ? "available"
      : "failed";
  return {
    symbol: command.symbol.toUpperCase(),
    status,
    ...(companyFactsResult.cik !== undefined ? { cik: companyFactsResult.cik } : {}),
    ...(companyFactsResult.identity !== undefined ? { identity: companyFactsResult.identity } : {}),
    ...(tickerSnapshot !== undefined && companyFactsResult.cik !== undefined
      ? {
          cikMapping: {
            ticker: companyFactsResult.symbol,
            cik: companyFactsResult.cik,
            ...(companyFactsResult.identity?.displayName !== undefined
              ? { name: companyFactsResult.identity.displayName }
              : {}),
            payload: tickerSnapshot.payload,
            rawSnapshot: tickerSnapshot,
          },
        }
      : {}),
    ...(companyFactsResult.factsPayload !== undefined && companyFactsResult.sourceId !== undefined
      ? {
          companyFacts: {
            payload: companyFactsResult.factsPayload,
            sourceId: companyFactsResult.sourceId,
            ...(companyFactsResult.sourceUrl !== undefined
              ? { sourceUrl: companyFactsResult.sourceUrl }
              : {}),
            ...(companyFactsResult.fetchedAt !== undefined
              ? { fetchedAt: companyFactsResult.fetchedAt }
              : {}),
          },
        }
      : {}),
    ...(companyFactsResult.submissionsPayload !== undefined &&
    companyFactsResult.submissionsSourceId !== undefined
      ? {
          submissions: {
            payload: companyFactsResult.submissionsPayload,
            sourceId: companyFactsResult.submissionsSourceId,
            ...(companyFactsResult.submissionsUrl !== undefined
              ? { sourceUrl: companyFactsResult.submissionsUrl }
              : {}),
            ...(companyFactsResult.submissionsFetchedAt !== undefined
              ? { fetchedAt: companyFactsResult.submissionsFetchedAt }
              : {}),
            ...(companyFactsResult.sicClassification !== undefined
              ? { sic: companyFactsResult.sicClassification }
              : {}),
          },
        }
      : {}),
    recent8Ks: [],
    recent6Ks: [],
    companyFactsResult,
    providerResult,
    filingEvidence: EMPTY_FILING_EVIDENCE,
    rawSnapshots: companyFactsResult.rawSnapshots,
    gaps: providerResult.gaps,
  };
}

export async function finalizeSecTargetPacket(
  ctx: CollectContext,
  packet: SecTargetPacket,
): Promise<SecTargetPacket> {
  if (
    packet.status !== "available" ||
    packet.companyFactsResult === undefined ||
    ctx.secUserAgent === undefined
  ) {
    return packet;
  }
  const filingEvidence = await collectSecFilingEvidence(ctx, packet.companyFactsResult);
  const filings = filingPackets(filingEvidence);
  const latest10K = filings.find((filing) => filing.form === "10-K");
  const newer10Q = filings.find((filing) => filing.form === "10-Q");
  return {
    ...packet,
    ...(latest10K !== undefined ? { latest10K } : {}),
    ...(newer10Q !== undefined ? { newer10Q } : {}),
    recent8Ks: filings.filter((filing) => filing.form === "8-K"),
    recent6Ks: filings.filter((filing) => filing.form === "6-K"),
    filingEvidence,
    rawSnapshots: [...packet.rawSnapshots, ...filingEvidence.rawSnapshots],
    gaps: [...packet.gaps, ...filingEvidence.gaps],
  };
}

function filingPackets(evidence: EvidenceRequestToolOutput): readonly SecFilingPacket[] {
  const sources = new Map(evidence.sources.map((source) => [source.id, source]));
  const snapshots = new Map(evidence.rawSnapshots.map((snapshot) => [snapshot.id, snapshot]));
  return evidence.items.flatMap((item): readonly SecFilingPacket[] => {
    const form = item.metrics?.form;
    const filingDate = item.metrics?.filingDate;
    const accessionNumber = item.metrics?.accessionNumber;
    const primaryDocument = item.metrics?.primaryDocument;
    const [sourceId] = item.sourceIds;
    const source = sourceId === undefined ? undefined : sources.get(sourceId);
    if (
      (form !== "10-K" && form !== "10-Q" && form !== "8-K" && form !== "6-K") ||
      typeof filingDate !== "string" ||
      typeof accessionNumber !== "string" ||
      typeof primaryDocument !== "string" ||
      source === undefined
    ) {
      return [];
    }
    const reportDate = item.metrics?.reportDate;
    const rawSnapshot = source.rawRef === undefined ? undefined : snapshots.get(source.rawRef);
    return [
      {
        form,
        filingDate,
        ...(typeof reportDate === "string" ? { reportDate } : {}),
        accessionNumber,
        primaryDocument,
        source,
        item,
        ...(rawSnapshot !== undefined ? { rawSnapshot } : {}),
      },
    ];
  });
}
