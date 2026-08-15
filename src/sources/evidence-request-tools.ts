import { isInstrumentCommand, type InstrumentCommand } from "../cli/args";
import type {
  EvidenceRequestToolName,
  ExtendedEvidenceItem,
  InstrumentIdentity,
  Source,
  SourceGap,
} from "../domain/types";
import { sourceGap } from "../domain/source-gaps";
import { isUsListing } from "./instrument-capability";
import {
  findSecTicker,
  secRequestInit,
  type SecCompanyFactsResult,
} from "./extended-evidence/sec-edgar";
import { filingBaseUrl, filingDocuments } from "./extended-evidence/sec-archive";
import { SEC_FILING_TEXT_MAX_RESPONSE_BYTES } from "./source-request";
import {
  aggregateModelInputSanitization,
  type ModelInputSanitizationAggregateEntry,
} from "./model-input-sanitizer";
import {
  isFetchJsonResult,
  isFetchTextResult,
  type CollectContext,
  type FetchTextResult,
  type RawSourceSnapshot,
} from "./types";
import {
  emptyOutput,
  unsupportedInstrumentGap,
  type EvidenceRequestToolOutput,
} from "./evidence-request-output";
import {
  byFilingRecency,
  detectForeignPrivateIssuerForms,
  filingUrl,
  isEarningsRelease,
  selectCurrentQuarterlyFiling,
  selectLatestFilingByForm,
  selectRecentCurrentReports,
  selectRecentEarningsSixKs,
  type SecFiling,
} from "./sec-filing-selection";
import { hasSubstantiveResultsContent, normalizeFilingText } from "./sec-filing-text";
import {
  buildSecFilingMetadataOnlyItem,
  buildSecFilingSourceItem,
  secPacketGap,
  secSanitizationGap,
  secSectionOmissionGap,
  type EarningsReleaseProvenance,
} from "./sec-filing-item";
import { collectTradierIvTermStructure } from "./tradier-iv-term-structure";

export type { EvidenceRequestToolOutput } from "./evidence-request-output";
export type { SecFilingForm } from "./sec-filing-selection";
export { hasSubstantiveResultsContent, normalizeFilingText } from "./sec-filing-text";

export const EVIDENCE_REQUEST_TOOL_UNITS: Record<EvidenceRequestToolName, number> = {
  sec_latest_filing: 5,
  tradier_iv_term_structure: 5,
};

export function availableEvidenceRequestTools(
  ctx: CollectContext,
  identity?: InstrumentIdentity,
): readonly EvidenceRequestToolName[] {
  if (!isInstrumentCommand(ctx.command) || ctx.command.assetClass !== "equity") {
    return [];
  }
  if (!isUsListing(ctx.command.symbol, identity)) {
    return [];
  }
  // SEC latest filing is retrieved deterministically (see runEvidenceRequestLoop);
  // Only optional tools remain at model discretion.
  return ctx.tradierApiToken !== undefined ? ["tradier_iv_term_structure"] : [];
}

export async function executeEvidenceRequestTool(
  tool: EvidenceRequestToolName,
  ctx: CollectContext,
): Promise<EvidenceRequestToolOutput> {
  if (tool === "sec_latest_filing") {
    return collectSecFilingEvidence(ctx);
  }
  return collectTradierIvTermStructure(ctx);
}

function secTextRequestInit(userAgent: string | undefined): RequestInit | undefined {
  return userAgent === undefined ? undefined : { headers: { "user-agent": userAgent } };
}

async function fetchFilingText(
  ctx: CollectContext,
  filing: SecFiling,
  cik: string,
): Promise<{ result: FetchTextResult | SourceGap; url: string }> {
  const url = filingUrl(cik, filing);
  const result = await ctx.request.text({
    url,
    adapter: "sec-filing-text",
    // SEC filing text is the one adapter whose payload legitimately exceeds the global
    // Response-byte default (see SEC_FILING_TEXT_MAX_RESPONSE_BYTES and the A2 remediation
    // Plan) — sec.gov gzips, so content-length reports the compressed size while
    // `response.body` yields decompressed bytes several times larger.
    maxResponseBytes: SEC_FILING_TEXT_MAX_RESPONSE_BYTES,
    init: secTextRequestInit(ctx.secUserAgent),
  });
  return { result, url };
}

function secEarningsExhibitGap(
  symbol: string,
  filing: SecFiling,
  exhibitState: string,
  primaryState: string,
): SourceGap {
  return sourceGap({
    source: "sec-edgar",
    message: `SEC Item 2.02 8-K ${filing.accessionNumber} for ${symbol} yielded no substantive earnings-release content (${exhibitState}; ${primaryState})`,
    provider: "sec-edgar",
    capability: "evidence-request",
    cause: "provider-data-missing",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

interface EarningsExhibitResolution {
  readonly text?: FetchTextResult;
  readonly url?: string;
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly gaps: readonly SourceGap[];
}

// The results of an Item 2.02 current report live in its EX-99 press release, not the cover
// Document. Walks the bounded EX-99 candidates sequentially, matching the SEC archive rate-limit
// Discipline the untagged-exhibit path already follows.
async function resolveEarningsReleaseExhibit(
  ctx: CollectContext,
  filing: SecFiling,
  cik: string,
): Promise<EarningsExhibitResolution> {
  const baseUrl = filingBaseUrl(String(Number(cik)), filing.accessionNumber);
  const init = secTextRequestInit(ctx.secUserAgent);
  const index = await ctx.request.text({
    url: `${baseUrl}/${filing.accessionNumber}-index.html`,
    adapter: "sec-filing-index",
    init,
  });
  if (!isFetchTextResult(index)) {
    return { rawSnapshots: [], gaps: [index] };
  }
  const documents = filingDocuments(index.payload, baseUrl, filing.primaryDocument);
  if (documents.length === 0) {
    return { rawSnapshots: [index.rawSnapshot], gaps: [] };
  }
  const rawSnapshots = [index.rawSnapshot];
  let firstFetchGap: SourceGap | undefined = undefined;
  let attemptedCandidateCount = 0;
  let firstResolved: { readonly text: FetchTextResult; readonly url: string } | undefined =
    undefined;
  let selected: { readonly text: FetchTextResult; readonly url: string } | undefined = undefined;
  for (const document of documents) {
    attemptedCandidateCount += 1;
    // eslint-disable-next-line no-await-in-loop
    const exhibit = await ctx.request.text({
      url: document.url,
      adapter: "sec-earnings-release-exhibit",
      maxResponseBytes: SEC_FILING_TEXT_MAX_RESPONSE_BYTES,
      init,
    });
    if (!isFetchTextResult(exhibit)) {
      firstFetchGap ??= exhibit;
      continue;
    }
    rawSnapshots.push(exhibit.rawSnapshot);
    firstResolved ??= { text: exhibit, url: document.url };
    if (hasSubstantiveResultsContent(normalizeFilingText(exhibit.payload))) {
      selected = { text: exhibit, url: document.url };
      break;
    }
  }
  const gaps =
    firstFetchGap === undefined
      ? []
      : [
          {
            ...firstFetchGap,
            message: `${firstFetchGap.message} (${String(attemptedCandidateCount)} EX-99 candidates attempted)`,
          },
        ];
  return {
    ...(selected ?? firstResolved),
    rawSnapshots,
    gaps,
  };
}

function earningsReleaseProvenance(
  exhibit: EarningsExhibitResolution | undefined,
  document: EarningsReleaseProvenance["earningsReleaseDocument"],
  exhibitSubstantive: boolean,
): EarningsReleaseProvenance | undefined {
  if (exhibit === undefined) {
    return undefined;
  }
  let resolved: EarningsReleaseProvenance["earningsReleaseExhibit"] = "unresolved";
  if (exhibit.text !== undefined) {
    resolved = exhibitSubstantive ? "substantive" : "not-substantive";
  }
  return { earningsReleaseDocument: document, earningsReleaseExhibit: resolved };
}

async function collectSecFiling(
  ctx: CollectContext,
  command: InstrumentCommand,
  match: { cik: string; ticker: string; name?: string },
  filing: SecFiling,
  submissionsRawSnapshot?: RawSourceSnapshot,
): Promise<{
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly sources: readonly Source[];
  readonly items: readonly ExtendedEvidenceItem[];
  readonly gaps: readonly SourceGap[];
  readonly sanitizationEntries: readonly ModelInputSanitizationAggregateEntry[];
  readonly droppedItemCount: number;
}> {
  const { result, url } = await fetchFilingText(ctx, filing, match.cik);
  const primary = isFetchTextResult(result) ? result : undefined;
  const primaryFetchGaps: readonly SourceGap[] = isFetchTextResult(result) ? [] : [result];
  // A failed primary fetch does not rule out the exhibit: index and EX-99 are separate documents,
  // And for an Item 2.02 the exhibit is where the results actually are.
  const exhibit = isEarningsRelease(filing)
    ? await resolveEarningsReleaseExhibit(ctx, filing, match.cik)
    : undefined;
  const exhibitSubstantive =
    exhibit?.text !== undefined &&
    hasSubstantiveResultsContent(normalizeFilingText(exhibit.text.payload));
  const primarySubstantive =
    primary !== undefined && hasSubstantiveResultsContent(normalizeFilingText(primary.payload));
  // The exhibit wins unless it is a non-results document (a conference-call notice, say) and the
  // Cover document does report results.
  const useExhibit =
    exhibit?.text !== undefined &&
    (exhibitSubstantive || !primarySubstantive || primary === undefined);
  const selected = useExhibit ? exhibit.text : primary;
  const selectedUrl = useExhibit ? (exhibit.url ?? url) : url;
  const rawSnapshots = [
    ...(primary === undefined ? [] : [primary.rawSnapshot]),
    ...(exhibit?.rawSnapshots ?? []),
  ];
  const exhibitGaps: readonly SourceGap[] =
    exhibit === undefined
      ? []
      : [
          ...exhibit.gaps,
          ...(exhibitSubstantive || primarySubstantive
            ? []
            : [
                secEarningsExhibitGap(
                  command.symbol,
                  filing,
                  exhibit.text === undefined
                    ? "no EX-99 exhibit resolved"
                    : "the resolved EX-99 exhibit reports no results",
                  primary === undefined
                    ? "no primary document text"
                    : "the primary document reports no results",
                ),
              ]),
        ];
  if (selected === undefined) {
    // No filing text at all. The fetch produced no raw snapshot (e.g. the byte-limit guard throws
    // Before any snapshot is captured), so the honest replayable provenance for this metadata-only
    // Item is the sec-submissions snapshot the form/filingDate/accessionNumber/primaryDocument were
    // Themselves read from (ADR 0004: evidence must remain replayable through raw snapshots).
    const metadataOnly = buildSecFilingMetadataOnlyItem(
      command,
      match,
      filing,
      url,
      submissionsRawSnapshot?.fetchedAt ?? ctx.fetchedAt,
      submissionsRawSnapshot?.id,
      earningsReleaseProvenance(exhibit, "none", exhibitSubstantive),
    );
    return {
      rawSnapshots,
      sources: [metadataOnly.source],
      items: [metadataOnly.item],
      gaps: [...primaryFetchGaps, ...exhibitGaps],
      sanitizationEntries: metadataOnly.sanitizationEntries,
      droppedItemCount: 0,
    };
  }
  const built = buildSecFilingSourceItem(
    command,
    match,
    filing,
    selectedUrl,
    selected,
    ctx.earningsEventDate,
    earningsReleaseProvenance(exhibit, useExhibit ? "exhibit" : "primary", exhibitSubstantive),
  );
  if (built.kind === "missing") {
    const metadataOnly = buildSecFilingMetadataOnlyItem(
      command,
      match,
      filing,
      selectedUrl,
      selected.rawSnapshot.fetchedAt,
      selected.rawSnapshot.id,
      earningsReleaseProvenance(exhibit, "none", exhibitSubstantive),
    );
    return {
      rawSnapshots,
      sources: [metadataOnly.source],
      items: [metadataOnly.item],
      gaps: [...primaryFetchGaps, ...exhibitGaps, secPacketGap(command.symbol, filing.form)],
      sanitizationEntries: metadataOnly.sanitizationEntries,
      droppedItemCount: 0,
    };
  }
  if (built.kind === "dropped") {
    const metadataOnly = buildSecFilingMetadataOnlyItem(
      command,
      match,
      filing,
      selectedUrl,
      selected.rawSnapshot.fetchedAt,
      selected.rawSnapshot.id,
      earningsReleaseProvenance(exhibit, "none", exhibitSubstantive),
    );
    return {
      rawSnapshots,
      sources: [metadataOnly.source],
      items: [metadataOnly.item],
      gaps: [...primaryFetchGaps, ...exhibitGaps],
      sanitizationEntries: [...built.sanitizationEntries, ...metadataOnly.sanitizationEntries],
      droppedItemCount: 1,
    };
  }
  const omissionGaps =
    built.misses.length === 0
      ? []
      : [
          secSectionOmissionGap(
            command.symbol,
            filing.form,
            built.misses,
            built.sectionCount - built.misses.length,
            built.sectionCount,
            built.normalizedChars,
            built.responseBytes,
          ),
        ];
  return {
    rawSnapshots,
    sources: [built.source],
    items: [built.item],
    gaps: [...primaryFetchGaps, ...exhibitGaps, ...omissionGaps],
    sanitizationEntries: built.sanitizationEntries,
    droppedItemCount: 0,
  };
}

export async function collectSecFilingEvidence(
  ctx: CollectContext,
  companyFacts?: SecCompanyFactsResult,
): Promise<EvidenceRequestToolOutput> {
  const { command } = ctx;
  if (!isInstrumentCommand(command)) {
    return emptyOutput([
      sourceGap({
        source: "sec-edgar",
        message: "SEC filing requests require ticker runs",
        provider: "sec-edgar",
        capability: "evidence-request",
        cause: "unsupported-coverage",
        evidenceQualityImpact: "extended-evidence-cap",
      }),
    ]);
  }
  if (!isUsListing(command.symbol, ctx.instrumentIdentity)) {
    return emptyOutput([unsupportedInstrumentGap("sec-edgar", "SEC EDGAR", command.symbol)]);
  }
  const prefetchedMatch =
    companyFacts?.cik === undefined
      ? undefined
      : {
          cik: companyFacts.cik,
          ticker: companyFacts.symbol,
          ...(companyFacts.identity?.displayName !== undefined
            ? { name: companyFacts.identity.displayName }
            : {}),
        };
  const prefetchedSubmissions = companyFacts?.submissionsPayload;
  let match = prefetchedMatch;
  let submissionsPayload = prefetchedSubmissions;
  let sharedRawSnapshots: readonly RawSourceSnapshot[] = [];
  if (match === undefined || submissionsPayload === undefined) {
    const tickersUrl = "https://www.sec.gov/files/company_tickers.json";
    const tickers = await ctx.request.json({
      url: tickersUrl,
      adapter: "sec-tickers",
      init: secRequestInit(ctx.secUserAgent),
    });
    if (!isFetchJsonResult(tickers)) {
      return emptyOutput([tickers]);
    }
    match = findSecTicker(tickers.payload, command.symbol);
    if (match === undefined) {
      return emptyOutput(
        [
          sourceGap({
            source: "sec-edgar",
            message: `No SEC CIK match for ${command.symbol}`,
            provider: "sec-edgar",
            capability: "evidence-request",
            cause: "unsupported-coverage",
            evidenceQualityImpact: "extended-evidence-cap",
          }),
        ],
        [tickers.rawSnapshot],
      );
    }
    const submissionsUrl = `https://data.sec.gov/submissions/CIK${match.cik}.json`;
    const submissions = await ctx.request.json({
      url: submissionsUrl,
      adapter: "sec-submissions",
      init: secRequestInit(ctx.secUserAgent),
    });
    if (!isFetchJsonResult(submissions)) {
      return emptyOutput([submissions], [tickers.rawSnapshot]);
    }
    submissionsPayload = submissions.payload;
    sharedRawSnapshots = [tickers.rawSnapshot, submissions.rawSnapshot];
  }
  const submissionsRawSnapshot =
    sharedRawSnapshots.find((snapshot) => snapshot.adapter === "sec-submissions") ??
    companyFacts?.rawSnapshots.find((snapshot) => snapshot.adapter === "sec-submissions");

  const tenK = selectLatestFilingByForm(submissionsPayload, "10-K");
  const tenQ = selectCurrentQuarterlyFiling(submissionsPayload, tenK);
  const fpiForms = detectForeignPrivateIssuerForms(submissionsPayload);
  const fpiAnnual =
    tenK === undefined && tenQ === undefined
      ? [
          selectLatestFilingByForm(submissionsPayload, "20-F"),
          selectLatestFilingByForm(submissionsPayload, "40-F"),
        ]
          .filter((filing): filing is SecFiling => filing !== undefined)
          .toSorted(byFilingRecency)[0]
      : undefined;
  const sixKs =
    tenK === undefined && tenQ === undefined
      ? selectRecentEarningsSixKs(submissionsPayload, ctx.fetchedAt)
      : [];

  if (tenK === undefined && tenQ === undefined && fpiAnnual === undefined && sixKs.length === 0) {
    return emptyOutput(
      [
        sourceGap({
          source: "sec-edgar",
          message:
            fpiForms.length > 0
              ? `${command.symbol} files as a foreign private issuer (${fpiForms.join(", ")}); no eligible recent 6-K filing was available and annual-report section parsing remains unsupported`
              : `No SEC 10-K or 10-Q filing found for ${command.symbol}`,
          provider: "sec-edgar",
          capability: "evidence-request",
          cause: fpiForms.length > 0 ? "unsupported-coverage" : "provider-data-missing",
          evidenceQualityImpact: "core-cap",
        }),
      ],
      sharedRawSnapshots,
    );
  }

  const sources: Source[] = [];
  const items: ExtendedEvidenceItem[] = [];
  const gaps: SourceGap[] =
    tenK === undefined && tenQ === undefined
      ? [
          sourceGap({
            source: "sec-edgar",
            message:
              sixKs.length > 0
                ? `${command.symbol} files as a foreign private issuer (${fpiForms.join(", ")}); recent 6-K text is attempted, while annual-report section parsing remains unsupported`
                : `${command.symbol} files as a foreign private issuer (${fpiForms.join(", ")}); annual filing metadata is retained, no eligible recent 6-K filing was available, and annual-report section parsing remains unsupported`,
            provider: "sec-edgar",
            capability: "evidence-request",
            cause: "unsupported-coverage",
            evidenceQualityImpact: "core-cap",
          }),
        ]
      : [];
  const rawSnapshots: RawSourceSnapshot[] = [...sharedRawSnapshots];
  const sanitizationEntries: ModelInputSanitizationAggregateEntry[] = [];
  let droppedItemCount = 0;

  if (fpiAnnual !== undefined) {
    const metadataOnly = buildSecFilingMetadataOnlyItem(
      command,
      match,
      fpiAnnual,
      filingUrl(match.cik, fpiAnnual),
      submissionsRawSnapshot?.fetchedAt ?? ctx.fetchedAt,
      submissionsRawSnapshot?.id,
    );
    sources.push(metadataOnly.source);
    items.push(metadataOnly.item);
    sanitizationEntries.push(...metadataOnly.sanitizationEntries);
  }

  const [newestPeriodicFilingDate] = [tenK?.filingDate, tenQ?.filingDate]
    .filter((date): date is string => date !== undefined)
    .toSorted((left, right) => right.localeCompare(left));
  const eightKs =
    newestPeriodicFilingDate === undefined
      ? []
      : selectRecentCurrentReports(submissionsPayload, newestPeriodicFilingDate, ctx.fetchedAt);

  const filingResults = await Promise.all(
    [tenK, tenQ, ...eightKs, ...sixKs].flatMap((filing) =>
      filing === undefined
        ? []
        : [collectSecFiling(ctx, command, match, filing, submissionsRawSnapshot)],
    ),
  );
  for (const result of filingResults) {
    rawSnapshots.push(...result.rawSnapshots);
    sources.push(...result.sources);
    items.push(...result.items);
    gaps.push(...result.gaps);
    sanitizationEntries.push(...result.sanitizationEntries);
    droppedItemCount += result.droppedItemCount;
  }
  // When the latest 10-K is present but metadata lists no 10-Q after it, quarterly coverage is not-applicable (not a missing gap): the issuer has not filed an interim report since its annual.
  // A missing annual 10-K is an explicit core-cap gap even when a 10-Q exists.
  if (tenK === undefined && tenQ !== undefined) {
    gaps.push(
      sourceGap({
        source: "sec-edgar",
        message: `No SEC 10-K filing found for ${command.symbol}; only quarterly 10-Q available`,
        provider: "sec-edgar",
        capability: "evidence-request",
        cause: "provider-data-missing",
        evidenceQualityImpact: "core-cap",
      }),
    );
  }
  if (droppedItemCount > 0) {
    gaps.push(secSanitizationGap(command.symbol, droppedItemCount));
  }

  return {
    rawSnapshots,
    sources,
    items,
    gaps,
    modelInputSanitization: aggregateModelInputSanitization(sanitizationEntries),
  };
}
