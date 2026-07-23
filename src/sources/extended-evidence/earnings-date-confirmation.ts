import type { InstrumentIdentity, Source } from "../../domain/types";
import { isRecord, readString, stringArrayValue } from "../../guards";
import type { CollectedSources, EarningsSetupCollected, RawSourceSnapshot } from "../types";

export type EarningsDateConfirmationSourceType =
  | "issuer-ir-event"
  | "issuer-press-release"
  | "sec-8-k"
  | "sec-6-k";

export interface EarningsDateConfirmation {
  readonly sourceId: string;
  readonly sourceType: EarningsDateConfirmationSourceType;
  readonly sourceUrl: string;
  readonly evidenceSpan: string;
  readonly issuerIdentity: {
    readonly symbol: string;
    readonly matchedBy: "official-host" | "sec-ticker-alias" | "source-text";
  };
  readonly confirmedAt: string;
}

interface OfficialIssuerIdentity {
  readonly symbol: string;
  readonly names: readonly string[];
  readonly hosts: ReadonlySet<string>;
}

interface ConfirmationCandidate {
  readonly source: Source;
  readonly sourceType: EarningsDateConfirmationSourceType;
  readonly evidenceSpan: string;
  readonly matchedBy: EarningsDateConfirmation["issuerIdentity"]["matchedBy"];
}

const LEGAL_SUFFIX_PATTERN =
  /\b(?:incorporated|inc|corporation|corp|company|co|limited|ltd|plc|n\.v|nv|s\.a|sa|se)\b/giu;
const FUTURE_ANNOUNCEMENT_PATTERN =
  /\b(?:will|scheduled\s+to|expects?\s+to|plans?\s+to|intends?\s+to|is\s+set\s+to|to\s+be\s+(?:announced|released|reported))\b/iu;
const EARNINGS_SUBJECT_PATTERN =
  /\b(?:earnings|financial\s+results|quarterly\s+results|annual\s+results|results\s+for\s+(?:the\s+)?(?:first|second|third|fourth|fiscal|quarter|year))\b/iu;
const MAX_EVIDENCE_SPAN_CHARS = 600;

function normalizedHost(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return undefined;
  }
}

function hostMatches(candidate: string, official: string): boolean {
  return candidate === official || candidate.endsWith(`.${official}`);
}

function normalizedName(value: string): string {
  return value
    .normalize("NFKC")
    .replaceAll(LEGAL_SUFFIX_PATTERN, " ")
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function submissionsIdentity(
  snapshots: readonly RawSourceSnapshot[],
  symbol: string,
  fallbackIdentity: InstrumentIdentity | undefined,
): OfficialIssuerIdentity {
  const target = symbol.toUpperCase();
  const names = new Set<string>();
  const hosts = new Set<string>();
  if (fallbackIdentity?.displayName !== undefined) {
    names.add(fallbackIdentity.displayName);
  }

  for (const snapshot of snapshots) {
    if (!snapshot.adapter.startsWith("sec-submissions") || !isRecord(snapshot.payload)) {
      continue;
    }
    const tickers = stringArrayValue(snapshot.payload.tickers).map((ticker) =>
      ticker.toUpperCase(),
    );
    if (!tickers.includes(target)) {
      continue;
    }
    const name = readString(snapshot.payload, "name");
    if (name !== undefined) {
      names.add(name);
    }
    for (const key of ["website", "investorWebsite"] as const) {
      const value = readString(snapshot.payload, key);
      const host = value === undefined ? undefined : normalizedHost(value);
      if (host !== undefined) {
        hosts.add(host);
      }
    }
  }
  return { symbol: target, names: [...names], hosts };
}

function dateLabels(date: string): readonly string[] {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) {
    return [date];
  }
  const monthLong = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(
    parsed,
  );
  const monthShort = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(
    parsed,
  );
  const day = String(parsed.getUTCDate());
  const year = String(parsed.getUTCFullYear());
  return [
    date,
    `${monthLong} ${day}, ${year}`,
    `${monthShort} ${day}, ${year}`,
    `${day} ${monthLong} ${year}`,
  ];
}

export function retainedEvidenceSpanForEarningsDate(
  text: string,
  date: string,
): string | undefined {
  const lower = text.toLowerCase();
  for (const label of dateLabels(date)) {
    let offset = lower.indexOf(label.toLowerCase());
    while (offset >= 0) {
      const before = text.slice(Math.max(0, offset - MAX_EVIDENCE_SPAN_CHARS), offset);
      const boundary = Math.max(before.lastIndexOf("."), before.lastIndexOf("\n"));
      const start = Math.max(0, offset - before.length + boundary + 1);
      const endCandidates = [text.indexOf(".", offset + label.length), text.indexOf("\n", offset)];
      const [end] = endCandidates
        .filter((candidate) => candidate >= 0)
        .toSorted((left, right) => left - right);
      const span = text
        .slice(
          start,
          Math.min(end === undefined ? text.length : end + 1, start + MAX_EVIDENCE_SPAN_CHARS),
        )
        .replaceAll(/\s+/gu, " ")
        .trim();
      if (FUTURE_ANNOUNCEMENT_PATTERN.test(span) && EARNINGS_SUBJECT_PATTERN.test(span)) {
        return span;
      }
      offset = lower.indexOf(label.toLowerCase(), offset + label.length);
    }
  }
  return undefined;
}

function sourceText(source: Source): string {
  return [source.title, source.publisher, source.summary, source.snippet]
    .filter((value): value is string => value !== undefined)
    .join("\n");
}

function sourceHasTickerAlias(source: Source, symbol: string): boolean {
  return (
    source.symbol?.toUpperCase() === symbol &&
    source.identity?.aliases?.some(
      (alias) => alias.idKind === "ticker" && alias.value.toUpperCase() === symbol,
    ) === true
  );
}

function textMatchesIssuer(text: string, identity: OfficialIssuerIdentity): boolean {
  if (
    new RegExp(`\\b${identity.symbol.replaceAll(/[^A-Z0-9]/gu, String.raw`\$&`)}\\b`, "iu").test(
      text,
    )
  ) {
    return true;
  }
  const normalizedText = normalizedName(text);
  return identity.names.some((name) => {
    const normalized = normalizedName(name);
    return normalized.length >= 4 && normalizedText.includes(normalized);
  });
}

function isFutureDate(date: string, analysisAsOf: string, source: Source): boolean {
  const sourceDate = source.fetchedAt.slice(0, 10);
  return date > analysisAsOf.slice(0, 10) && date > sourceDate;
}

function secSourceType(source: Source): "sec-8-k" | "sec-6-k" | undefined {
  const host = source.url === undefined ? undefined : normalizedHost(source.url);
  if (source.provider !== "sec-edgar" || (host !== "sec.gov" && host !== "www.sec.gov")) {
    return undefined;
  }
  if (/\b8-K\b/iu.test(source.title)) {
    return "sec-8-k";
  }
  return /\b6-K\b/iu.test(source.title) ? "sec-6-k" : undefined;
}

function issuerSourceType(source: Source): "issuer-ir-event" | "issuer-press-release" {
  const text = `${source.title} ${source.url ?? ""}`;
  return /\b(?:press|release|newsroom|news-release)\b/iu.test(text)
    ? "issuer-press-release"
    : "issuer-ir-event";
}

function confirmationCandidate(input: {
  readonly source: Source;
  readonly eventDate: string;
  readonly analysisAsOf: string;
  readonly identity: OfficialIssuerIdentity;
}): ConfirmationCandidate | undefined {
  const { source, identity } = input;
  if (
    source.id.trim() === "" ||
    source.url === undefined ||
    source.symbol?.toUpperCase() !== identity.symbol
  ) {
    return undefined;
  }
  if (!isFutureDate(input.eventDate, input.analysisAsOf, source)) {
    return undefined;
  }
  const text = sourceText(source);
  const evidenceSpan = retainedEvidenceSpanForEarningsDate(text, input.eventDate);
  if (evidenceSpan === undefined) {
    return undefined;
  }

  const secType = secSourceType(source);
  if (secType !== undefined && sourceHasTickerAlias(source, identity.symbol)) {
    return { source, sourceType: secType, evidenceSpan, matchedBy: "sec-ticker-alias" };
  }

  const host = normalizedHost(source.url);
  if (
    host !== undefined &&
    [...identity.hosts].some((officialHost) => hostMatches(host, officialHost))
  ) {
    return {
      source,
      sourceType: issuerSourceType(source),
      evidenceSpan,
      matchedBy: "official-host",
    };
  }
  if (textMatchesIssuer(evidenceSpan, identity) && source.kind === "extended-evidence") {
    return undefined;
  }
  return undefined;
}

export function confirmEarningsDateFromIssuerSources(input: {
  readonly setup: EarningsSetupCollected | undefined;
  readonly sources: readonly Source[];
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly instrumentIdentity?: InstrumentIdentity;
  readonly analysisAsOf: string;
}): EarningsSetupCollected | undefined {
  const { setup } = input;
  if (setup === undefined || setup.event.eventDateStatus === "issuer-confirmed") {
    return setup;
  }
  const identity = submissionsIdentity(
    input.rawSnapshots,
    setup.event.symbol,
    input.instrumentIdentity,
  );
  const [candidate] = input.sources
    .flatMap((source) => {
      const match = confirmationCandidate({
        source,
        eventDate: setup.event.date,
        analysisAsOf: input.analysisAsOf,
        identity,
      });
      return match === undefined ? [] : [match];
    })
    .toSorted(
      (left, right) =>
        left.sourceType.localeCompare(right.sourceType) ||
        left.source.id.localeCompare(right.source.id),
    );
  if (candidate === undefined || candidate.source.url === undefined) {
    return setup;
  }
  const confirmation: EarningsDateConfirmation = {
    sourceId: candidate.source.id,
    sourceType: candidate.sourceType,
    sourceUrl: candidate.source.url,
    evidenceSpan: candidate.evidenceSpan,
    issuerIdentity: { symbol: identity.symbol, matchedBy: candidate.matchedBy },
    confirmedAt: candidate.source.fetchedAt,
  };
  const { dateStatus: _legacyDateStatus, ...event } = setup.event;
  return {
    ...setup,
    event: {
      ...event,
      eventDateStatus: "issuer-confirmed",
      sourceIds: [...new Set([...event.sourceIds, candidate.source.id])],
      dateConfirmation: confirmation,
    },
  };
}

export function applyIssuerEarningsDateConfirmation(input: {
  readonly collectedSources: CollectedSources;
  readonly analysisAsOf: string;
}): CollectedSources {
  const earningsSetup = confirmEarningsDateFromIssuerSources({
    setup: input.collectedSources.earningsSetup,
    sources: [...input.collectedSources.extendedSources, ...input.collectedSources.newsSources],
    rawSnapshots: input.collectedSources.rawSnapshots,
    ...(input.collectedSources.resolvedInstrumentIdentity !== undefined
      ? { instrumentIdentity: input.collectedSources.resolvedInstrumentIdentity }
      : {}),
    analysisAsOf: input.analysisAsOf,
  });
  return earningsSetup === input.collectedSources.earningsSetup
    ? input.collectedSources
    : { ...input.collectedSources, ...(earningsSetup !== undefined ? { earningsSetup } : {}) };
}
