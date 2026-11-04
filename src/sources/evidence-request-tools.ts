import { isInstrumentCommand, type InstrumentCommand } from "../cli/args";
import type { ExtendedEvidenceItem } from "../domain/evidence";
import type { EvidenceRequestToolName } from "../domain/gather-audit";
import type { InstrumentIdentity } from "../domain/instrument";
import type { Source, SourceGap, SourceGapCause } from "../domain/sources";
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
  isResultsFiling,
  recentSixKs,
  selectCurrentQuarterlyFiling,
  selectLatestFilingByForm,
  selectRecentCurrentReports,
  selectOriginalPeriodicFiling,
  selectRecentSixKs,
  type SecFiling,
} from "./sec-filing-selection";
import {
  hasSubstantiveResultsContent,
  normalizeFilingText,
  sixKResultsCoverRank,
} from "./sec-filing-text";
import {
  buildSecFilingMetadataOnlyItem,
  buildSecFilingSourceItem,
  secPacketGap,
  secSanitizationGap,
  secSectionOmissionGap,
  type EarningsReleaseProvenance,
} from "./sec-filing-item";
import {
  EXTENSION_CAPEX_CHECKED_KEY,
  FACE_LINE_PREFIX,
  secBalanceSheetFaceMetrics,
} from "./sec-segment-facts";
import {
  DA_CALC_READ_KEY,
  schemaCalculation,
  secContinuingInvestingCalcMetrics,
  secDepreciationCalcMetrics,
  extensionSchema,
  summationParents,
  xbrlSchemaHref,
} from "./sec-calculation-linkbase";
import { faceHasNoBorrowingRow } from "./extended-evidence/sec-debt";
import { parseXbrlInstance, type XbrlInstance } from "./sec-xbrl-instance";
import {
  UNCLASSIFIED_CREDIT,
  ZERO_BORROWINGS_CURRENCY_KEY,
  ZERO_BORROWINGS_PROOF_KEY,
  ZERO_BORROWINGS_REJECT_KEY,
  metaLinksTags,
  zeroBorrowingsInstanceProof,
} from "./sec-zero-borrowings-proof";
import {
  EXTENSION_INVESTMENTS_SOURCE_INFIX,
  EXTENSION_SHORT_TERM_INVESTMENTS_PREFIX,
  EXTENSION_SHORT_TERM_INVESTMENTS_PROOF_PREFIX,
  extensionShortTermInvestmentsProof,
} from "./sec-extension-investments-proof";
import { collectTradierIvTermStructure } from "./tradier-iv-term-structure";

export type { EvidenceRequestToolOutput } from "./evidence-request-output";
export type { SecFilingForm } from "./sec-filing-selection";
export { hasSubstantiveResultsContent, normalizeFilingText } from "./sec-filing-text";

const SEC_6K_COVER_SCAN_LIMIT = 12;

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

interface FilingTextFetch {
  readonly result: FetchTextResult | SourceGap;
  readonly url: string;
}

async function fetchFilingText(
  ctx: CollectContext,
  filing: SecFiling,
  cik: string,
): Promise<FilingTextFetch> {
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
    message: `SEC ${filing.form === "6-K" ? "results 6-K" : "Item 2.02 8-K"} ${filing.accessionNumber} for ${symbol} yielded no substantive earnings-release content (${exhibitState}; ${primaryState})`,
    provider: "sec-edgar",
    capability: "evidence-request",
    cause: "provider-data-missing",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

const DA_CALC_ADAPTERS = new Set(["sec-xbrl-schema", "sec-calculation-linkbase"]);

interface FetchedDocument {
  readonly url: string;
  readonly adapter: string;
  readonly rawSnapshot: RawSourceSnapshot;
}

interface CalculationLinkbaseFetch {
  readonly xml?: string;
  readonly xmlUrl?: string;
  readonly schema?: { readonly url: string; readonly xml: string };
  readonly ambiguous?: true;
  readonly documents: readonly FetchedDocument[];
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly gaps: readonly SourceGap[];
}

// `href` resolved against the document that names it, only when it stays a file of the filing's accession folder.
function accessionDocumentUrl(href: string, documentUrl: string): string | undefined {
  const url = URL.parse(href, documentUrl);
  const folder = documentUrl.slice(0, documentUrl.lastIndexOf("/") + 1);
  const name = url?.href.startsWith(folder) === true ? url.href.slice(folder.length) : "";
  return url !== null && url.username === "" && url.password === "" && /^[^/?#]+$/u.test(name)
    ? url.href
    : undefined;
}

// A calculation linkbase sits in the filing's schema (inline DTS) or a `_cal.xml` the schema references.
async function fetchCalculationLinkbase(
  ctx: CollectContext,
  schemaHref: string | undefined,
  documentUrl: string,
): Promise<CalculationLinkbaseFetch> {
  const schemaUrl =
    schemaHref === undefined ? undefined : accessionDocumentUrl(schemaHref, documentUrl);
  if (schemaUrl === undefined) {
    return { documents: [], rawSnapshots: [], gaps: [] };
  }
  const init = secTextRequestInit(ctx.secUserAgent);
  const schema = await ctx.request.text({ url: schemaUrl, adapter: "sec-xbrl-schema", init });
  if (!isFetchTextResult(schema)) {
    return { documents: [], rawSnapshots: [], gaps: [schema] };
  }
  const schemaRead = { url: schemaUrl, xml: schema.payload };
  const schemaDocument = {
    url: schemaUrl,
    adapter: "sec-xbrl-schema",
    rawSnapshot: schema.rawSnapshot,
  };
  const { hrefs, embedded } = schemaCalculation(schema.payload);
  if (hrefs.length > 1 || (hrefs.length === 1 && embedded)) {
    return {
      ambiguous: true,
      documents: [schemaDocument],
      rawSnapshots: [schema.rawSnapshot],
      gaps: [],
    };
  }
  const calcHref = hrefs[0];
  const calcUrl = calcHref === undefined ? undefined : accessionDocumentUrl(calcHref, schemaUrl);
  if (calcUrl === undefined) {
    return {
      xml: schema.payload,
      xmlUrl: schemaUrl,
      schema: schemaRead,
      documents: [schemaDocument],
      rawSnapshots: [schema.rawSnapshot],
      gaps: [],
    };
  }
  const calc = await ctx.request.text({ url: calcUrl, adapter: "sec-calculation-linkbase", init });
  return isFetchTextResult(calc)
    ? {
        xml: calc.payload,
        xmlUrl: calcUrl,
        schema: schemaRead,
        documents: [
          schemaDocument,
          { url: calcUrl, adapter: "sec-calculation-linkbase", rawSnapshot: calc.rawSnapshot },
        ],
        rawSnapshots: [schema.rawSnapshot, calc.rawSnapshot],
        gaps: [],
      }
    : { documents: [schemaDocument], rawSnapshots: [schema.rawSnapshot], gaps: [calc] };
}

async function fetchDepreciationCalc(
  ctx: CollectContext,
  filing: SecFiling,
  cik: string,
  html: string,
): Promise<{
  readonly metrics: Record<string, number | string>;
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly gaps: readonly SourceGap[];
}> {
  if (filing.form !== "10-K") {
    return { metrics: {}, rawSnapshots: [], gaps: [] };
  }
  const { xml, xmlUrl, schema, ambiguous, rawSnapshots, gaps } = await fetchCalculationLinkbase(
    ctx,
    xbrlSchemaHref(html),
    `${filingBaseUrl(String(Number(cik)), filing.accessionNumber)}/${filing.primaryDocument}`,
  );
  return {
    metrics:
      gaps.length > 0
        ? { [DA_CALC_READ_KEY]: "fetch-failed" }
        : ambiguous === true
          ? { [DA_CALC_READ_KEY]: "conflict" }
          : xml === undefined
            ? {}
            : {
                ...secDepreciationCalcMetrics(xml),
                ...(xmlUrl === undefined || schema === undefined
                  ? {}
                  : secContinuingInvestingCalcMetrics(xml, xmlUrl, schema)),
              },
    rawSnapshots,
    gaps,
  };
}

interface ZeroBorrowingsFetch {
  readonly metrics: Record<string, string>;
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly sources: readonly Source[];
  readonly gaps: readonly SourceGap[];
}

const rejectZeroBorrowings = (
  code: string,
  rawSnapshots: readonly RawSourceSnapshot[] = [],
  gaps: readonly SourceGap[] = [],
): ZeroBorrowingsFetch => ({
  metrics: { [ZERO_BORROWINGS_REJECT_KEY]: code },
  rawSnapshots,
  sources: [],
  gaps,
});

const ZERO_PROOF_DOCUMENTS: Readonly<Record<string, readonly [suffix: string, title: string]>> = {
  "sec-xbrl-instance": ["xbrl-instance", "XBRL instance"],
  "sec-metalinks": ["metalinks", "MetaLinks"],
  "sec-xbrl-schema": ["xbrl-schema", "XBRL extension schema"],
  "sec-calculation-linkbase": ["calculation-linkbase", "calculation linkbase"],
};

async function fetchXbrlInstance(
  ctx: CollectContext,
  filing: SecFiling,
  cik: string,
  instanceFile: string,
): Promise<{ readonly url: string; readonly instance: FetchTextResult | SourceGap }> {
  const url = `${filingBaseUrl(String(Number(cik)), filing.accessionNumber)}/${instanceFile}`;
  const instance = await ctx.request.text({
    url,
    adapter: "sec-xbrl-instance",
    maxResponseBytes: SEC_FILING_TEXT_MAX_RESPONSE_BYTES,
    init: secTextRequestInit(ctx.secUserAgent),
  });
  return { url, instance };
}

// Only a footed face with no borrowing row asks for the XBRL instance, MetaLinks and, for an unlisted credit
// Fact, the calculation linkbase; every failure is a rejection code beside its adapter's Source Gap.
async function fetchZeroBorrowingsProof(
  ctx: CollectContext,
  filing: SecFiling,
  cik: string,
  item: { readonly source: Source; readonly metrics: ExtendedEvidenceItem["metrics"] },
): Promise<ZeroBorrowingsFetch> {
  const instanceFile = filing.primaryDocument.replace(/\.htm$/u, "_htm.xml");
  if (
    filing.reportDate === undefined ||
    !faceHasNoBorrowingRow(item.metrics) ||
    instanceFile === filing.primaryDocument
  ) {
    return { metrics: {}, rawSnapshots: [], sources: [], gaps: [] };
  }
  if (ctx.taggedZeroDebtDisabled === true) {
    return rejectZeroBorrowings("tagged-zero debt disabled");
  }
  const baseUrl = filingBaseUrl(String(Number(cik)), filing.accessionNumber);
  const init = secTextRequestInit(ctx.secUserAgent);
  const { url, instance } = await fetchXbrlInstance(ctx, filing, cik, instanceFile);
  if (!isFetchTextResult(instance)) {
    return rejectZeroBorrowings("instance-fetch-failed:sec-xbrl-instance", [], [instance]);
  }
  const metaLinksUrl = `${baseUrl}/MetaLinks.json`;
  const metaLinks = await ctx.request.json({
    url: metaLinksUrl,
    adapter: "sec-metalinks",
    maxResponseBytes: SEC_FILING_TEXT_MAX_RESPONSE_BYTES,
    init,
  });
  if (!isFetchJsonResult(metaLinks)) {
    return rejectZeroBorrowings(
      "instance-fetch-failed:sec-metalinks",
      [instance.rawSnapshot],
      [metaLinks],
    );
  }
  const documents: FetchedDocument[] = [
    { url, adapter: "sec-xbrl-instance", rawSnapshot: instance.rawSnapshot },
    { url: metaLinksUrl, adapter: "sec-metalinks", rawSnapshot: metaLinks.rawSnapshot },
  ];
  const rawSnapshots = documents.map(({ rawSnapshot }) => rawSnapshot);
  const tags = metaLinksTags(metaLinks.payload, filing.primaryDocument);
  if (tags === undefined) {
    return rejectZeroBorrowings("metalinks-unreadable", rawSnapshots);
  }
  let parsed: XbrlInstance;
  try {
    parsed = parseXbrlInstance(instance.payload);
  } catch {
    return rejectZeroBorrowings("instance-unreadable", rawSnapshots);
  }
  const scope = { periodEnd: filing.reportDate, file: instanceFile, cik };
  let proof = zeroBorrowingsInstanceProof(parsed, tags, undefined, scope);
  if ("reject" in proof && proof.reject.startsWith(UNCLASSIFIED_CREDIT)) {
    if (parsed.calculationLinkbaseRefs.length > 0) {
      return rejectZeroBorrowings("calculation-linkbase-ambiguous", rawSnapshots);
    }
    const calc = await fetchCalculationLinkbase(
      ctx,
      parsed.schemaRefs.length === 1 ? parsed.schemaRefs[0] : undefined,
      url,
    );
    const calcSnapshots = [...rawSnapshots, ...calc.rawSnapshots];
    if (calc.ambiguous === true) {
      return rejectZeroBorrowings("calculation-linkbase-ambiguous", calcSnapshots);
    }
    if (
      calc.gaps.length > 0 ||
      calc.xml === undefined ||
      calc.xmlUrl === undefined ||
      calc.schema === undefined
    ) {
      return rejectZeroBorrowings(
        `instance-fetch-failed:${calc.gaps[0]?.source ?? "sec-xbrl-schema"}`,
        calcSnapshots,
        calc.gaps,
      );
    }
    try {
      const schema = extensionSchema(calc.schema.url, calc.schema.xml);
      proof = zeroBorrowingsInstanceProof(
        parsed,
        tags,
        {
          extensionNamespace: schema.namespace,
          parents: summationParents(calc.xml, calc.xmlUrl, schema),
        },
        scope,
      );
    } catch {
      return rejectZeroBorrowings("calculation-linkbase-unreadable", calcSnapshots);
    }
    documents.push(...calc.documents);
    rawSnapshots.push(...calc.rawSnapshots);
  }
  if ("reject" in proof) {
    return rejectZeroBorrowings(proof.reject, rawSnapshots);
  }
  const { snippet: _snippet, ...filingSource } = item.source;
  return {
    metrics: {
      [ZERO_BORROWINGS_PROOF_KEY]: proof.proof,
      [ZERO_BORROWINGS_CURRENCY_KEY]: proof.currency,
    },
    rawSnapshots,
    sources: documents.map(({ url: documentUrl, adapter, rawSnapshot }) => {
      const [suffix, title] = ZERO_PROOF_DOCUMENTS[adapter]!;
      return {
        ...filingSource,
        id: `${item.source.id}-${suffix}`,
        title: `${item.source.title} ${title}`,
        url: documentUrl,
        rawRef: rawSnapshot.id,
        summary: `${filing.form} ${filing.accessionNumber} ${title} ${documentUrl.slice(documentUrl.lastIndexOf("/") + 1)}: evidence for tagged zero borrowings at ${filing.reportDate}.`,
      };
    }),
    gaps: [],
  };
}

// A typed balance-sheet location member naming an issuer concept; the strict instance read decides the rest.
const LOCATED_EXTENSION_LINE =
  /typedMember\s+dimension="us-gaap:StatementOfFinancialPositionLocationBalanceAxis"\s*>\s*<[\w-]+:QName\.domain>\s*(?!us-gaap:|srt:|dei:)[\w-]+:\w+/u;

interface ExtensionInvestmentsFetch {
  readonly metrics: Record<string, number | string>;
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly sources: readonly Source[];
  readonly gaps: readonly SourceGap[];
}

function extensionInvestmentsGap(
  symbol: string,
  filing: SecFiling,
  rejects: readonly string[],
  cause: SourceGapCause,
): SourceGap {
  return sourceGap({
    source: "sec-edgar",
    message: `${symbol} short-term investments on an issuer-extension balance-sheet line in ${filing.form} ${filing.accessionNumber} not proven from its XBRL instance (${rejects.join("; ")})`,
    provider: "sec-edgar",
    capability: "evidence-request",
    cause,
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

// Only a filing that locates investments on an extension line asks for its XBRL instance and calculation linkbase.
async function fetchExtensionInvestmentsProof(
  ctx: CollectContext,
  filing: SecFiling,
  cik: string,
  html: string,
  source: Source,
): Promise<ExtensionInvestmentsFetch> {
  const instanceFile = filing.primaryDocument.replace(/\.htm$/u, "_htm.xml");
  const none = { metrics: {}, rawSnapshots: [], sources: [], gaps: [] };
  if (
    !isInstrumentCommand(ctx.command) ||
    (filing.form !== "10-K" && filing.form !== "10-Q") ||
    instanceFile === filing.primaryDocument ||
    !LOCATED_EXTENSION_LINE.test(html)
  ) {
    return none;
  }
  const { symbol } = ctx.command;
  const fail = (
    reject: string,
    cause: SourceGapCause,
    rawSnapshots: readonly RawSourceSnapshot[] = [],
    gaps: readonly SourceGap[] = [],
  ): ExtensionInvestmentsFetch => ({
    ...none,
    rawSnapshots,
    gaps: [...gaps, extensionInvestmentsGap(symbol, filing, [reject], cause)],
  });
  if (ctx.extensionShortTermInvestmentsDisabled === true) {
    return fail("extension short-term investments disabled", "suppressed-by-design");
  }
  const { url, instance } = await fetchXbrlInstance(ctx, filing, cik, instanceFile);
  if (!isFetchTextResult(instance)) {
    return fail("instance-fetch-failed:sec-xbrl-instance", "fetch-failed", [], [instance]);
  }
  let parsed: XbrlInstance;
  try {
    parsed = parseXbrlInstance(instance.payload);
  } catch {
    return fail("instance-unreadable", "malformed-response", [instance.rawSnapshot]);
  }
  if (parsed.calculationLinkbaseRefs.length > 0 || parsed.schemaRefs.length !== 1) {
    return fail("calculation-linkbase-ambiguous", "provider-data-missing", [instance.rawSnapshot]);
  }
  const calc = await fetchCalculationLinkbase(ctx, parsed.schemaRefs[0], url);
  const rawSnapshots = [instance.rawSnapshot, ...calc.rawSnapshots];
  if (calc.ambiguous === true) {
    return fail("calculation-linkbase-ambiguous", "provider-data-missing", rawSnapshots);
  }
  if (calc.xml === undefined || calc.xmlUrl === undefined || calc.schema === undefined) {
    return fail(
      `instance-fetch-failed:${calc.gaps[0]?.source ?? "sec-calculation-linkbase"}`,
      calc.gaps.length > 0 ? "fetch-failed" : "provider-data-missing",
      rawSnapshots,
      calc.gaps,
    );
  }
  let proof: ReturnType<typeof extensionShortTermInvestmentsProof>;
  try {
    const schema = extensionSchema(calc.schema.url, calc.schema.xml);
    proof = extensionShortTermInvestmentsProof(
      parsed,
      {
        extensionNamespace: schema.namespace,
        parents: summationParents(calc.xml, calc.xmlUrl, schema),
      },
      { file: instanceFile, cik },
    );
  } catch {
    return fail("calculation-linkbase-unreadable", "malformed-response", rawSnapshots);
  }
  if ("reject" in proof) {
    return fail(proof.reject, "provider-data-missing", rawSnapshots);
  }
  const documents: readonly FetchedDocument[] = [
    { url, adapter: "sec-xbrl-instance", rawSnapshot: instance.rawSnapshot },
    ...calc.documents,
  ];
  const { snippet: _snippet, ...filingSource } = source;
  const sources =
    proof.proved.length === 0
      ? []
      : documents.map(({ url: documentUrl, adapter, rawSnapshot }) => {
          const [suffix, title] = ZERO_PROOF_DOCUMENTS[adapter]!;
          return {
            ...filingSource,
            id: `${source.id}${EXTENSION_INVESTMENTS_SOURCE_INFIX}${suffix}`,
            title: `${source.title} ${title}`,
            url: documentUrl,
            rawRef: rawSnapshot.id,
            summary: `${filing.form} ${filing.accessionNumber} ${title} ${documentUrl.slice(documentUrl.lastIndexOf("/") + 1)}: evidence for short-term investments on an issuer-extension balance-sheet line.`,
          };
        });
  return {
    metrics: Object.fromEntries(
      proof.proved.flatMap(
        ({ periodEnd, concept, value, currency, assetsCurrent, proof: text }) => [
          [
            `${EXTENSION_SHORT_TERM_INVESTMENTS_PREFIX}${periodEnd}|${currency}|${concept}|${String(assetsCurrent)}`,
            value,
          ],
          [`${EXTENSION_SHORT_TERM_INVESTMENTS_PROOF_PREFIX}${periodEnd}`, text],
        ],
      ),
    ),
    rawSnapshots,
    sources,
    gaps:
      proof.rejected.length === 0
        ? []
        : [
            extensionInvestmentsGap(
              symbol,
              filing,
              proof.rejected.map(({ periodEnd, reject }) => `${periodEnd}: ${reject}`),
              "provider-data-missing",
            ),
          ],
  };
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
  // EX-99.1 is the press release, so filename scoring would otherwise rank an "earnings slides"
  // EX-99.2 first. `filingDocuments` demotes an EX-99.1 whose index wording says commentary.
  const documents = filingDocuments(index.payload, baseUrl, filing.primaryDocument, true);
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

interface SixKCoverScan {
  readonly covers: ReadonlyMap<string, FilingTextFetch>;
  readonly matchedAccessions: readonly string[];
  readonly resultsSixK?: SecFiling;
}

// 6-Ks carry no item codes, so results are found by reading covers newest-first. Same-date
// Siblings are still read after a match so the press release can beat the statements filing.
async function scanSixKCovers(
  ctx: CollectContext,
  candidates: readonly SecFiling[],
  cik: string,
): Promise<SixKCoverScan> {
  const covers = new Map<string, FilingTextFetch>();
  const matchedAccessions: string[] = [];
  let best: { readonly filing: SecFiling; readonly rank: number } | undefined = undefined;
  for (const filing of candidates.slice(0, SEC_6K_COVER_SCAN_LIMIT)) {
    if (best !== undefined && (best.rank === 0 || filing.filingDate !== best.filing.filingDate)) {
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    const cover = await fetchFilingText(ctx, filing, cik);
    covers.set(filing.accessionNumber, cover);
    const rank = isFetchTextResult(cover.result)
      ? sixKResultsCoverRank(normalizeFilingText(cover.result.payload))
      : undefined;
    if (rank !== undefined) {
      matchedAccessions.push(filing.accessionNumber);
    }
    if (rank !== undefined && (best === undefined || rank < best.rank)) {
      best = { filing, rank };
    }
  }
  return {
    covers,
    matchedAccessions,
    ...(best === undefined ? {} : { resultsSixK: best.filing }),
  };
}

function noResultsSixKMessage(symbol: string, scanned: number, candidates: number): string {
  if (scanned < candidates) {
    return `No results 6-K for ${symbol} among the newest ${String(scanned)} of ${String(candidates)} 6-K covers in the 120-day window; older covers were not read and 6-K text is recency-selected`;
  }
  if (candidates === 1) {
    return `No results 6-K for ${symbol} in the only 6-K cover in the 120-day window; 6-K text is recency-selected`;
  }
  return `No results 6-K for ${symbol} among the ${String(candidates)} 6-K covers in the 120-day window; 6-K text is recency-selected`;
}

function noResultsSixKGap(symbol: string, scanned: number, candidates: number): SourceGap {
  return sourceGap({
    source: "sec-edgar",
    message: noResultsSixKMessage(symbol, scanned, candidates),
    provider: "sec-edgar",
    capability: "evidence-request",
    cause: "provider-data-missing",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

async function collectSecFiling(
  ctx: CollectContext,
  command: InstrumentCommand,
  match: { cik: string; ticker: string; name?: string },
  filing: SecFiling,
  resultsFiling: boolean,
  submissionsRawSnapshot?: RawSourceSnapshot,
  prefetchedText?: FilingTextFetch,
): Promise<{
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly sources: readonly Source[];
  readonly items: readonly ExtendedEvidenceItem[];
  readonly gaps: readonly SourceGap[];
  readonly investmentGaps?: readonly SourceGap[];
  readonly sanitizationEntries: readonly ModelInputSanitizationAggregateEntry[];
  readonly droppedItemCount: number;
}> {
  const { result, url } = prefetchedText ?? (await fetchFilingText(ctx, filing, match.cik));
  const primary = isFetchTextResult(result) ? result : undefined;
  const primaryFetchGaps: readonly SourceGap[] = isFetchTextResult(result) ? [] : [result];
  // A failed primary fetch does not rule out the exhibit: index and EX-99 are separate documents,
  // And for an Item 2.02 the exhibit is where the results actually are.
  const exhibit = resultsFiling
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
  const calc = await fetchDepreciationCalc(ctx, filing, match.cik, selected.payload);
  const zero = await fetchZeroBorrowingsProof(ctx, filing, match.cik, {
    source: built.source,
    metrics: built.item.metrics,
  });
  const investments = await fetchExtensionInvestmentsProof(
    ctx,
    filing,
    match.cik,
    selected.payload,
    built.source,
  );
  return {
    rawSnapshots: [
      ...rawSnapshots,
      ...calc.rawSnapshots,
      ...zero.rawSnapshots,
      ...investments.rawSnapshots,
    ],
    sources: [built.source, ...zero.sources, ...investments.sources],
    items: [
      {
        ...built.item,
        sourceIds: [
          ...built.item.sourceIds,
          ...zero.sources.map(({ id }) => id),
          ...investments.sources.map(({ id }) => id),
        ],
        metrics: {
          ...built.item.metrics,
          ...calc.metrics,
          ...zero.metrics,
          ...investments.metrics,
        },
      },
    ],
    gaps: [
      ...primaryFetchGaps,
      ...exhibitGaps,
      ...omissionGaps,
      ...calc.gaps,
      ...zero.gaps,
      ...investments.gaps,
    ],
    investmentGaps: investments.gaps,
    sanitizationEntries: built.sanitizationEntries,
    droppedItemCount: 0,
  };
}

export async function collectSecPeriodicFilingItems(
  ctx: CollectContext,
  companyFacts: SecCompanyFactsResult,
): Promise<EvidenceRequestToolOutput> {
  const { command } = ctx;
  if (
    !isInstrumentCommand(command) ||
    companyFacts.cik === undefined ||
    companyFacts.submissionsPayload === undefined
  ) {
    return emptyOutput([]);
  }
  const match = { cik: companyFacts.cik, ticker: companyFacts.symbol };
  const tenK = selectLatestFilingByForm(companyFacts.submissionsPayload, "10-K");
  const tenQ = selectCurrentQuarterlyFiling(companyFacts.submissionsPayload, tenK);
  const results = await Promise.all(
    [tenK, tenQ].flatMap((filing) =>
      filing === undefined ? [] : [collectSecFiling(ctx, command, match, filing, false)],
    ),
  );
  // Filing prose stays out of prompts: the source keeps provenance only.
  return {
    rawSnapshots: results.flatMap((result) => result.rawSnapshots),
    sources: results.flatMap((result) =>
      result.sources.map(({ snippet: _snippet, ...source }) => source),
    ),
    items: results.flatMap((result) => result.items),
    gaps: results.flatMap((result) =>
      result.items.some(({ metrics }) => metrics?.[EXTENSION_CAPEX_CHECKED_KEY] === "true")
        ? result.gaps.filter(
            (gap) => DA_CALC_ADAPTERS.has(gap.source) || result.investmentGaps?.includes(gap),
          )
        : result.gaps,
    ),
  };
}

export const DEBT_FACE_FETCH_CAP = 4;

// Historical balance-sheet faces for debt instants withheld only for want of face proof.
export async function collectSecDebtFaceFilings(
  ctx: CollectContext,
  companyFacts: Pick<SecCompanyFactsResult, "cik" | "symbol" | "submissionsPayload">,
  instants: readonly { readonly periodEnd: string; readonly accessionNumber: string }[],
): Promise<EvidenceRequestToolOutput> {
  const { command } = ctx;
  const { cik } = companyFacts;
  if (!isInstrumentCommand(command) || cik === undefined) {
    return emptyOutput([]);
  }
  const reads = await Promise.all(
    instants.slice(0, DEBT_FACE_FETCH_CAP).map(async (instant) => {
      const filing = selectOriginalPeriodicFiling(
        companyFacts.submissionsPayload,
        instant.accessionNumber,
        instant.periodEnd,
      );
      if (filing === undefined) {
        return { instant, outcome: "no original 10-K/10-Q in the submissions index" } as const;
      }
      const { result, url } = await fetchFilingText(ctx, filing, cik);
      if (!isFetchTextResult(result)) {
        return { instant, outcome: "fetch failed" } as const;
      }
      const face = secBalanceSheetFaceMetrics(result.payload, filing.reportDate);
      if (!Object.keys(face).some((key) => key.startsWith(FACE_LINE_PREFIX))) {
        return { instant, outcome: "no footed balance-sheet face", result } as const;
      }
      const { source, item } = buildSecFilingMetadataOnlyItem(
        command,
        { cik, ticker: companyFacts.symbol },
        filing,
        url,
        result.rawSnapshot.fetchedAt,
        result.rawSnapshot.id,
      );
      const id = `${source.id}-face-${filing.accessionNumber}`;
      const summary = `${filing.form} filed ${filing.filingDate} for period ${instant.periodEnd}: balance-sheet face read for debt proof.`;
      const faceSource = { ...source, id, summary };
      const zero = await fetchZeroBorrowingsProof(ctx, filing, cik, {
        source: faceSource,
        metrics: face,
      });
      return {
        instant,
        result,
        zero,
        source: faceSource,
        item: {
          ...item,
          summary,
          sourceIds: [id, ...zero.sources.map(({ id: proofId }) => proofId)],
          metrics: { ...item.metrics, ...face, ...zero.metrics },
        },
      } as const;
    }),
  );
  const unread = new Map<string, string[]>();
  for (const read of reads) {
    if ("outcome" in read) {
      unread.set(read.outcome, [...(unread.get(read.outcome) ?? []), read.instant.periodEnd]);
    }
  }
  const capped = instants.slice(DEBT_FACE_FETCH_CAP).map(({ periodEnd }) => periodEnd);
  if (capped.length > 0) {
    unread.set(`past the ${String(DEBT_FACE_FETCH_CAP)}-filing cap per run`, capped);
  }
  return {
    rawSnapshots: reads.flatMap((entry) => [
      ...(entry.result === undefined ? [] : [entry.result.rawSnapshot]),
      ...("zero" in entry ? entry.zero.rawSnapshots : []),
    ]),
    sources: reads.flatMap((entry) => [
      ...(entry.source === undefined ? [] : [entry.source]),
      ...("zero" in entry ? entry.zero.sources : []),
    ]),
    items: reads.flatMap((entry) => (entry.item === undefined ? [] : [entry.item])),
    gaps: [
      ...reads.flatMap((entry) => ("zero" in entry ? entry.zero.gaps : [])),
      ...(unread.size === 0
        ? []
        : [
            sourceGap({
              source: "sec-edgar",
              message: `${command.symbol} debt stays withheld where no filing balance-sheet face proved it (${[...unread].map(([reason, periods]) => `${reason}: ${periods.join(", ")}`).join("; ")})`,
              provider: "sec-edgar",
              capability: "evidence-request",
              cause: unread.has("fetch failed")
                ? "fetch-failed"
                : capped.length > 0
                  ? "suppressed-by-design"
                  : "provider-data-missing",
              evidenceQualityImpact: "extended-evidence-cap",
            }),
          ]),
    ],
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
  const sixKCandidates =
    tenK === undefined && tenQ === undefined ? recentSixKs(submissionsPayload, ctx.fetchedAt) : [];
  const sixKScan = await scanSixKCovers(ctx, sixKCandidates, match.cik);
  const sixKs = selectRecentSixKs(sixKCandidates, sixKScan.resultsSixK);

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
  for (const [accessionNumber, cover] of sixKScan.covers) {
    if (sixKs.some((filing) => filing.accessionNumber === accessionNumber)) {
      continue;
    }
    if (isFetchTextResult(cover.result)) {
      rawSnapshots.push(cover.result.rawSnapshot);
    } else {
      gaps.push({ ...cover.result, message: `${cover.result.message} (6-K results-cover scan)` });
    }
  }
  if (sixKCandidates.length > 0 && sixKScan.resultsSixK === undefined) {
    gaps.push(noResultsSixKGap(command.symbol, sixKScan.covers.size, sixKCandidates.length));
  }
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
        : [
            collectSecFiling(
              ctx,
              command,
              match,
              filing,
              isResultsFiling(filing, sixKScan.resultsSixK),
              submissionsRawSnapshot,
              sixKScan.covers.get(filing.accessionNumber),
            ),
          ],
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
    ...(sixKScan.matchedAccessions.length > 0
      ? { resultsCoverAccessions: sixKScan.matchedAccessions }
      : {}),
  };
}
