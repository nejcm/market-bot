import type { InstrumentIdentity } from "../../domain/instrument";
import { sourceGap } from "../../domain/source-gaps";
import type { Source } from "../../domain/sources";
import { isRecord, readString, stringArrayValue } from "../../guards";
import type { CollectedSources, EarningsSetupCollected, RawSourceSnapshot } from "../types";

type EarningsDateConfirmationSourceType =
  | "issuer-ir-event"
  | "issuer-press-release"
  | "sec-8-k"
  | "sec-6-k"
  | "official-exchange";

export interface EarningsDateConfirmation {
  readonly sourceId: string;
  readonly sourceType: EarningsDateConfirmationSourceType;
  readonly sourceUrl: string;
  readonly evidenceSpan: string;
  readonly issuerIdentity: {
    readonly symbol: string;
    readonly matchedBy:
      | "official-host"
      | "sec-ticker-alias"
      | "source-ticker-alias"
      | "source-text";
  };
  readonly confirmedAt: string;
}

interface OfficialIssuerIdentity {
  readonly symbol: string;
  readonly names: readonly string[];
  readonly hosts: ReadonlySet<string>;
  readonly ciks: ReadonlySet<number>;
  readonly filedDomains?: ReadonlySet<string>;
}

interface ConfirmationCandidate {
  readonly source: Source;
  readonly sourceType: EarningsDateConfirmationSourceType;
  readonly evidenceSpan: string;
  readonly matchedBy: EarningsDateConfirmation["issuerIdentity"]["matchedBy"];
  readonly eventDateStatus: "issuer-confirmed" | "exchange-confirmed";
}

const LEGAL_SUFFIX_PATTERN =
  /\b(?:incorporated|inc|corporation|corp|company|co|limited|ltd|plc|n\.v|nv|s\.a|sa|se)\b/giu;
const FUTURE_ANNOUNCEMENT_PATTERN =
  /\b(?:will|scheduled\s+to|expects?\s+to|plans?\s+to|intends?\s+to|is\s+set\s+to|to\s+be\s+(?:announced|released|reported))\b/iu;
const EARNINGS_SUBJECT_PATTERN =
  /\b(?:earnings|financial\s+results|quarterly\s+results|annual\s+results|results\s+for\s+(?:the\s+)?(?:first|second|third|fourth|fiscal|quarter|year))\b/iu;
const MAX_EVIDENCE_SPAN_CHARS = 600;
// Hand-verified fallback for issuers whose SEC submissions omit website fields (ADR 0004).
const ISSUER_IR_HOSTS_BY_CIK: ReadonlyMap<number, string> = new Map([[2488, "ir.amd.com"]]);
const SEC_FILING_TEXT_ADAPTERS = ["sec-earnings-release-exhibit", "sec-filing-text"] as const;
// ASCII-only token bounded by whitespace or ASCII punctuation, so no Unicode char ends a host early.
const FILED_WWW_HOST_PATTERN =
  /(?<=^|[\s!-,/:-@[-`{-~])[Ww]{3}\.([A-Za-z0-9.-]+)(?=$|[\s!-,/:-@[-`{-~])/gu;
const SEC_ARCHIVE_CIK_PATH = /^\/Archives\/edgar\/data\/([0-9]+)\//u;
// Other subdomains (community.*, forums) can carry third-party text.
const ISSUER_SITE_SUBDOMAINS: ReadonlySet<string> = new Set([
  "ir",
  "investor",
  "investors",
  "media",
  "news",
  "newsroom",
  "press",
]);
const OFFICIAL_EXCHANGE_DISCLOSURE_PATHS = [
  { host: "asx.com.au", path: /^\/asxpdf\//u },
  { host: "londonstockexchange.com", path: /^\/news-article\//u },
  { host: "nasdaq.com", path: /^\/press-release\//u },
] as const;
const EXCHANGE_MARKET_DATA_PATH =
  /\/(?:earnings-calendar|market-activity|market-data|quote|quotes|stock|stocks|symbol|symbols)(?:\/|$)/iu;

export type OfficialExchangeUrlAssessment =
  | { readonly eligible: true }
  | {
      readonly eligible: false;
      readonly reason:
        | "invalid-url"
        | "not-official-exchange-host"
        | "exchange-market-data-path"
        | "not-direct-exchange-disclosure-path";
    };

function parsedUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

export function assessOfficialExchangeDisclosureUrl(url: string): OfficialExchangeUrlAssessment {
  const parsed = parsedUrl(url);
  if (parsed === undefined) {
    return { eligible: false, reason: "invalid-url" };
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./u, "");
  const exchangeRules = OFFICIAL_EXCHANGE_DISCLOSURE_PATHS.filter((rule) =>
    hostMatches(host, rule.host),
  );
  if (exchangeRules.length === 0) {
    return { eligible: false, reason: "not-official-exchange-host" };
  }
  if (EXCHANGE_MARKET_DATA_PATH.test(parsed.pathname)) {
    return { eligible: false, reason: "exchange-market-data-path" };
  }
  return exchangeRules.some((rule) => rule.path.test(parsed.pathname))
    ? { eligible: true }
    : { eligible: false, reason: "not-direct-exchange-disclosure-path" };
}

function normalizedHost(value: string): string | undefined {
  return parsedUrl(value)
    ?.hostname.toLowerCase()
    .replace(/^www\./u, "");
}

function hostMatches(candidate: string, official: string): boolean {
  return candidate === official || candidate.endsWith(`.${official}`);
}

function onFiledIssuerSite(host: string, domain: string): boolean {
  return (
    host === domain ||
    (host.endsWith(`.${domain}`) && ISSUER_SITE_SUBDOMAINS.has(host.slice(0, -domain.length - 1)))
  );
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

function secCik(value: unknown): number | undefined {
  if (typeof value === "string") {
    return /^[0-9]+$/u.test(value) ? Number(value) : undefined;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function submissionsIdentity(
  snapshots: readonly RawSourceSnapshot[],
  symbol: string,
  fallbackIdentity: InstrumentIdentity | undefined,
): OfficialIssuerIdentity {
  const target = symbol.toUpperCase();
  const names = new Set<string>();
  const hosts = new Set<string>();
  const ciks = new Set<number>();
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
    const cik = secCik(snapshot.payload.cik);
    if (cik !== undefined) {
      ciks.add(cik);
    }
    for (const key of ["website", "investorWebsite"] as const) {
      const value = readString(snapshot.payload, key);
      const host = value === undefined ? undefined : normalizedHost(value);
      if (host !== undefined) {
        hosts.add(host);
      }
    }
  }
  if (hosts.size === 0) {
    for (const cik of ciks) {
      const host = ISSUER_IR_HOSTS_BY_CIK.get(cik);
      if (host !== undefined) {
        hosts.add(host);
      }
    }
  }
  return { symbol: target, names: [...names], hosts, ciks };
}

function issuerFilingText(
  source: Source,
  identity: OfficialIssuerIdentity,
  snapshots: readonly RawSourceSnapshot[],
): string | undefined {
  const url = source.url === undefined ? undefined : parsedUrl(source.url);
  const cik = url === undefined ? undefined : SEC_ARCHIVE_CIK_PATH.exec(url.pathname)?.[1];
  if (
    url?.protocol !== "https:" ||
    url.hostname !== "www.sec.gov" ||
    cik === undefined ||
    !identity.ciks.has(Number(cik)) ||
    source.provider !== "sec-edgar" ||
    !sourceHasTickerAlias(source, identity.symbol)
  ) {
    return undefined;
  }
  // Raw ids are fetch-time stamps, so a shared id cannot say which filing the text is.
  const snapshot = snapshots.find((candidate) => candidate.id === source.rawRef);
  return snapshot !== undefined &&
    snapshots.findLast((candidate) => candidate.id === source.rawRef) === snapshot &&
    typeof snapshot.payload === "string" &&
    snapshot.cacheStatus !== "stale-fallback" &&
    snapshot.payloadCompacted !== true &&
    SEC_FILING_TEXT_ADAPTERS.some((adapter) => snapshot.adapter.startsWith(adapter))
    ? snapshot.payload
    : undefined;
}

// Only `<ticker|full name>.<letters>` counts; anything else is ambiguous without a suffix list.
function filedIssuerDomains(
  identity: OfficialIssuerIdentity,
  sources: readonly Source[],
  snapshots: readonly RawSourceSnapshot[],
): ReadonlySet<string> {
  const labels = new Set(identity.names.map((name) => normalizedName(name).replaceAll(" ", "")));
  if (identity.symbol.length >= 3) {
    labels.add(identity.symbol.toLowerCase());
  }
  const domains = new Set<string>();
  for (const source of sources) {
    const text = issuerFilingText(source, identity, snapshots) ?? "";
    for (const [, host = ""] of text.matchAll(FILED_WWW_HOST_PATTERN)) {
      const [label, tld, ...rest] = host.toLowerCase().replace(/\.+$/u, "").split(".");
      if (
        rest.length === 0 &&
        label !== undefined &&
        labels.has(label) &&
        /^(?:com|net|org|[a-z]{2})$/u.test(tld ?? "")
      ) {
        domains.add(`${label}.${tld}`);
      }
    }
  }
  return domains;
}

export function dateLabels(date: string): readonly string[] {
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
    `${monthShort}. ${day}, ${year}`,
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

function textMatchesIssuerName(text: string, identity: OfficialIssuerIdentity): boolean {
  const normalizedText = normalizedName(text);
  return identity.names.some((name) => {
    const normalized = normalizedName(name);
    return normalized.length >= 4 && normalizedText.includes(normalized);
  });
}

function textMatchesSymbolWithIssuerContext(
  text: string,
  identity: OfficialIssuerIdentity,
): boolean {
  const escapedSymbol = identity.symbol.replaceAll(/[^A-Z0-9]/gu, String.raw`\$&`);
  return (
    new RegExp(`\\b${escapedSymbol}\\b`, "iu").test(text) &&
    /\b(?:issuer|listed|shares?|stock|symbol|ticker)\b/iu.test(text)
  );
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
    (source.symbol !== undefined && source.symbol.toUpperCase() !== identity.symbol)
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
    return {
      source,
      sourceType: secType,
      evidenceSpan,
      matchedBy: "sec-ticker-alias",
      eventDateStatus: "issuer-confirmed",
    };
  }

  const host = normalizedHost(source.url);
  if (
    host !== undefined &&
    parsedUrl(source.url)?.protocol === "https:" &&
    ([...identity.hosts].some((officialHost) => hostMatches(host, officialHost)) ||
      [...(identity.filedDomains ?? [])].some((domain) => onFiledIssuerSite(host, domain)))
  ) {
    return {
      source,
      sourceType: issuerSourceType(source),
      evidenceSpan,
      matchedBy: "official-host",
      eventDateStatus: "issuer-confirmed",
    };
  }
  if (
    host !== undefined &&
    source.symbol?.toUpperCase() === identity.symbol &&
    assessOfficialExchangeDisclosureUrl(source.url).eligible &&
    (textMatchesIssuerName(text, identity) || textMatchesSymbolWithIssuerContext(text, identity))
  ) {
    return {
      source,
      sourceType: "official-exchange",
      evidenceSpan,
      matchedBy: sourceHasTickerAlias(source, identity.symbol)
        ? "source-ticker-alias"
        : "source-text",
      eventDateStatus: "exchange-confirmed",
    };
  }
  return undefined;
}

export function confirmEarningsDateFromOfficialSources(input: {
  readonly setup: EarningsSetupCollected | undefined;
  readonly sources: readonly Source[];
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly instrumentIdentity?: InstrumentIdentity;
  readonly analysisAsOf: string;
}): EarningsSetupCollected | undefined {
  const { setup } = input;
  if (
    setup === undefined ||
    setup.event.eventDateStatus === "issuer-confirmed" ||
    setup.event.eventDateStatus === "exchange-confirmed"
  ) {
    return setup;
  }
  const submitted = submissionsIdentity(
    input.rawSnapshots,
    setup.event.symbol,
    input.instrumentIdentity,
  );
  const identity = {
    ...submitted,
    filedDomains: filedIssuerDomains(submitted, input.sources, input.rawSnapshots),
  };
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
      eventDateStatus: candidate.eventDateStatus,
      confirmedBy: { sourceId: candidate.source.id, sourceType: candidate.sourceType },
      sourceIds: [...new Set([...event.sourceIds, candidate.source.id])],
      dateConfirmation: confirmation,
    },
  };
}

export interface EarningsDateConflict {
  readonly date: string;
  readonly sourceId: string;
}

const MONTH_NUMBERS: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const ANNOUNCED_MONTH_PATTERN =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

const ANNOUNCED_DATE_PATTERN = new RegExp(
  String.raw`\b(?:(?<isoYear>\d{4})-(?<isoMonth>\d{2})-(?<isoDay>\d{2})|(?<monthName>${ANNOUNCED_MONTH_PATTERN})\.?\s+(?<monthDay>\d{1,2})(?:st|nd|rd|th)?,?\s+(?<monthYear>\d{4})|(?<dayNumber>\d{1,2})(?:st|nd|rd|th)?\s+(?<dayMonth>${ANNOUNCED_MONTH_PATTERN})\.?,?\s+(?<dayYear>\d{4}))\b`,
  "giu",
);

function monthNumber(name: string | undefined): number | undefined {
  return name === undefined ? undefined : MONTH_NUMBERS[name.toLowerCase()];
}

function announcedDate(match: RegExpExecArray): string | undefined {
  const groups = match.groups ?? {};
  const year = Number(groups.isoYear ?? groups.monthYear ?? groups.dayYear);
  const month =
    groups.isoMonth !== undefined
      ? Number(groups.isoMonth)
      : monthNumber(groups.monthName ?? groups.dayMonth);
  const day = Number(groups.isoDay ?? groups.monthDay ?? groups.dayNumber);
  if (month === undefined || month < 1 || month > 12) {
    return undefined;
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isFinite(probe.getTime()) ||
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return undefined;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

interface AnnouncedDateCandidate {
  readonly date: string;
  readonly index: number;
  readonly length: number;
}

function announcedDateCandidates(text: string): readonly AnnouncedDateCandidate[] {
  const candidates: AnnouncedDateCandidate[] = [];
  for (const match of text.matchAll(ANNOUNCED_DATE_PATTERN)) {
    const date = announcedDate(match);
    if (date !== undefined) {
      candidates.push({ date, index: match.index, length: match[0].length });
    }
  }
  return candidates;
}

const REPORTING_DATE_ANCHOR_PATTERN = /\b(?:on|for)\s+(?:[A-Za-z]+[,\s]+)?$/iu;
// Official confirmation keeps "scheduled to"; conflict detection also accepts "scheduled for".
const SCHEDULED_FOR_PATTERN = /\bscheduled\s+for\b/iu;
// Only the date a conference-call clause schedules is rejected; newlines end the clause.
const CONFERENCE_CALL_SCHEDULE_PATTERN =
  /\bconference call\b[^,.!?\n]*\b(?:scheduled|planned|set|expected|rescheduled)?\s*(?:for|to|on)\s+(?:[A-Za-z]+[,\s]+)?$/iu;
const SUPERSEDED_EXPECTATION_PATTERN =
  /\b(?:previously|originally|formerly|no longer)\b|\b(?:was|were|had been)\s+(?:expected|scheduled|anticipated|planned|set)\b/iu;
const SENTENCE_BOUNDARY_PATTERN = /[.!?]\s+(?=[A-Z"“])/gu;
const MAX_CONFLICT_DATE_DISTANCE_DAYS = 30;

function daysBetween(left: string, right: string): number {
  return Math.round((Date.parse(left) - Date.parse(right)) / 86_400_000);
}

function announcementSpan(text: string, offset: number, length: number): string {
  const before = text.slice(0, offset);
  let start = Math.max(0, before.lastIndexOf("\n") + 1);
  for (const match of before.matchAll(SENTENCE_BOUNDARY_PATTERN)) {
    start = Math.max(start, (match.index ?? 0) + match[0].length);
  }
  const end = text.indexOf(".", offset + length);
  return text
    .slice(start, Math.min(end === -1 ? text.length : end + 1, start + MAX_EVIDENCE_SPAN_CHARS))
    .replaceAll(/\s+/gu, " ")
    .trim();
}

// Same-day announcements count: an event after the close is still upcoming on its own day.
function upcomingAnnouncementDate(date: string, analysisAsOf: string, source: Source): boolean {
  const day = analysisAsOf.slice(0, 10);
  return date >= day && date >= source.fetchedAt.slice(0, 10);
}

// Shortcut: best-effort gates (sentence-local identity, on/for anchor, ±30 days, calendar-day upcomingness); upgrade when false/missed gaps from co-mentioned issuers, "ending on" clauses, delayed events, or elapsed same-day releases matter.
function conflictingEarningsDate(input: {
  readonly source: Source;
  readonly providerDate: string;
  readonly identity: OfficialIssuerIdentity;
  readonly analysisAsOf: string;
}): EarningsDateConflict | undefined {
  const { source, identity } = input;
  if (
    source.id.trim() === "" ||
    (source.symbol !== undefined && source.symbol.toUpperCase() !== identity.symbol)
  ) {
    return undefined;
  }
  const text = sourceText(source);
  const validated: EarningsDateConflict[] = [];
  for (const { date, index, length } of announcedDateCandidates(text)) {
    if (
      validated.some((candidate) => candidate.date === date) ||
      !upcomingAnnouncementDate(date, input.analysisAsOf, source)
    ) {
      continue;
    }
    const before = text.slice(0, index);
    if (
      !REPORTING_DATE_ANCHOR_PATTERN.test(before) ||
      CONFERENCE_CALL_SCHEDULE_PATTERN.test(before)
    ) {
      continue;
    }
    const span = announcementSpan(text, index, length);
    if (!EARNINGS_SUBJECT_PATTERN.test(span)) {
      continue;
    }
    if (
      !textMatchesIssuerName(span, identity) &&
      !textMatchesSymbolWithIssuerContext(span, identity)
    ) {
      continue;
    }
    if (date === input.providerDate) {
      if (SUPERSEDED_EXPECTATION_PATTERN.test(span)) {
        continue;
      }
      return undefined;
    }
    if (
      (!FUTURE_ANNOUNCEMENT_PATTERN.test(span) && !SCHEDULED_FOR_PATTERN.test(span)) ||
      Math.abs(daysBetween(date, input.providerDate)) > MAX_CONFLICT_DATE_DISTANCE_DAYS
    ) {
      continue;
    }
    validated.push({ date, sourceId: source.id });
  }
  return validated[0];
}

export function findEarningsDateConflict(input: {
  readonly setup: EarningsSetupCollected | undefined;
  readonly sources: readonly Source[];
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly instrumentIdentity?: InstrumentIdentity;
  readonly analysisAsOf: string;
}): EarningsDateConflict | undefined {
  const { setup } = input;
  if (setup === undefined) {
    return undefined;
  }
  const identity = submissionsIdentity(
    input.rawSnapshots,
    setup.event.symbol,
    input.instrumentIdentity,
  );
  const [candidate] = input.sources
    .flatMap((source) => {
      const conflict = conflictingEarningsDate({
        source,
        providerDate: setup.event.date,
        identity,
        analysisAsOf: input.analysisAsOf,
      });
      return conflict === undefined ? [] : [conflict];
    })
    .toSorted(
      (left, right) =>
        left.date.localeCompare(right.date) || left.sourceId.localeCompare(right.sourceId),
    );
  return candidate;
}

export function applyEarningsDateConflict(input: {
  readonly collectedSources: CollectedSources;
  readonly analysisAsOf: string;
}): CollectedSources {
  const setup = input.collectedSources.earningsSetup;
  if (setup === undefined) {
    return input.collectedSources;
  }
  const conflict = findEarningsDateConflict({
    setup,
    sources: [...input.collectedSources.extendedSources, ...input.collectedSources.newsSources],
    rawSnapshots: input.collectedSources.rawSnapshots,
    ...(input.collectedSources.resolvedInstrumentIdentity !== undefined
      ? { instrumentIdentity: input.collectedSources.resolvedInstrumentIdentity }
      : {}),
    analysisAsOf: input.analysisAsOf,
  });
  if (conflict === undefined) {
    return input.collectedSources;
  }
  return {
    ...input.collectedSources,
    earningsSetup: { ...setup, event: { ...setup.event, dateConflict: conflict } },
    sourceGaps: [
      ...input.collectedSources.sourceGaps,
      sourceGap({
        source: "earnings-setup",
        message: `Earnings date conflict for ${setup.event.symbol}: the Earnings Setup date ${setup.event.date} differs from the earnings date ${conflict.date} announced by source ${conflict.sourceId}`,
        symbol: setup.event.symbol,
        provider: "market-bot",
        capability: "extended-evidence",
        cause: "provider-data-missing",
        evidenceQualityImpact: "no-cap",
      }),
    ],
  };
}

export function applyOfficialEarningsDateConfirmation(input: {
  readonly collectedSources: CollectedSources;
  readonly analysisAsOf: string;
}): CollectedSources {
  const earningsSetup = confirmEarningsDateFromOfficialSources({
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
