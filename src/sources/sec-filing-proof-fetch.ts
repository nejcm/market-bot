import { isInstrumentCommand } from "../cli/job-registry";
import type { ExtendedEvidenceItem } from "../domain/evidence";
import type { Source, SourceGap, SourceGapCause } from "../domain/sources";
import { sourceGap } from "../domain/source-gaps";
import { filingBaseUrl } from "./extended-evidence/sec-archive";
import { SEC_FILING_TEXT_MAX_RESPONSE_BYTES } from "./source-request";
import {
  isFetchJsonResult,
  isFetchTextResult,
  type CollectContext,
  type FetchTextResult,
  type RawSourceSnapshot,
} from "./types";
import { type SecFiling } from "./sec-filing-selection";
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
import { parseXbrlInstance } from "./sec-xbrl-instance";
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

export function secTextRequestInit(userAgent: string | undefined): RequestInit | undefined {
  return userAgent === undefined ? undefined : { headers: { "user-agent": userAgent } };
}

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
// Shares one read per resolved schema URL across a filing's D&A, capex, zero-debt and investments proofs.
export type LinkbaseReads = Map<string, Promise<CalculationLinkbaseFetch>>;

async function fetchCalculationLinkbase(
  ctx: CollectContext,
  schemaHref: string | undefined,
  documentUrl: string,
  reads: LinkbaseReads = new Map(),
): Promise<CalculationLinkbaseFetch> {
  const schemaUrl =
    schemaHref === undefined ? undefined : accessionDocumentUrl(schemaHref, documentUrl);
  if (schemaUrl === undefined) {
    return { documents: [], rawSnapshots: [], gaps: [] };
  }
  const read = reads.get(schemaUrl) ?? readCalculationLinkbase(ctx, schemaUrl);
  reads.set(schemaUrl, read);
  return read;
}

async function readCalculationLinkbase(
  ctx: CollectContext,
  schemaUrl: string,
): Promise<CalculationLinkbaseFetch> {
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

export async function fetchDepreciationCalc(
  ctx: CollectContext,
  filing: SecFiling,
  cik: string,
  html: string,
  reads: LinkbaseReads,
): Promise<{
  readonly metrics: Record<string, number | string>;
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly gaps: readonly SourceGap[];
}> {
  if (filing.form !== "10-K" && filing.form !== "10-Q") {
    return { metrics: {}, rawSnapshots: [], gaps: [] };
  }
  const calc = await fetchCalculationLinkbase(
    ctx,
    xbrlSchemaHref(html),
    `${filingBaseUrl(String(Number(cik)), filing.accessionNumber)}/${filing.primaryDocument}`,
    reads,
  );
  return {
    metrics: calculationProofMetrics(calc),
    rawSnapshots: calc.rawSnapshots,
    gaps: calc.gaps,
  };
}

function calculationProofMetrics({
  xml,
  xmlUrl,
  schema,
  ambiguous,
  gaps,
}: CalculationLinkbaseFetch): Record<string, number | string> {
  return gaps.length > 0
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
          };
}

interface ZeroBorrowingsFetch {
  readonly metrics: Record<string, number | string>;
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly sources: readonly Source[];
  readonly gaps: readonly SourceGap[];
}

const rejectZeroBorrowings = (
  code: string,
  rawSnapshots: readonly RawSourceSnapshot[] = [],
  gaps: readonly SourceGap[] = [],
  calcMetrics: Record<string, number | string> = {},
): ZeroBorrowingsFetch => ({
  metrics: { ...calcMetrics, [ZERO_BORROWINGS_REJECT_KEY]: code },
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
export async function fetchZeroBorrowingsProof(
  ctx: CollectContext,
  filing: SecFiling,
  cik: string,
  item: { readonly source: Source; readonly metrics: ExtendedEvidenceItem["metrics"] },
  reads?: LinkbaseReads,
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
  const parsed = attempt(() => parseXbrlInstance(instance.payload));
  if (parsed === undefined) {
    return rejectZeroBorrowings("instance-unreadable", rawSnapshots);
  }
  const scope = { periodEnd: filing.reportDate, file: instanceFile, cik };
  let proof = zeroBorrowingsInstanceProof(parsed, tags, undefined, scope);
  let calcMetrics: Record<string, number | string> = {};
  if ("reject" in proof && proof.reject.startsWith(UNCLASSIFIED_CREDIT)) {
    if (parsed.calculationLinkbaseRefs.length > 0) {
      return rejectZeroBorrowings("calculation-linkbase-ambiguous", rawSnapshots);
    }
    const calc = await fetchCalculationLinkbase(
      ctx,
      parsed.schemaRefs.length === 1 ? parsed.schemaRefs[0] : undefined,
      url,
      reads,
    );
    // An older filing's only linkbase read: its capex and D&A proofs ride along at no extra request.
    calcMetrics = calculationProofMetrics(calc);
    const calcSnapshots = [...rawSnapshots, ...calc.rawSnapshots];
    if (calc.ambiguous === true) {
      return rejectZeroBorrowings("calculation-linkbase-ambiguous", calcSnapshots, [], calcMetrics);
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
        calcMetrics,
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
      return rejectZeroBorrowings(
        "calculation-linkbase-unreadable",
        calcSnapshots,
        [],
        calcMetrics,
      );
    }
    documents.push(...calc.documents);
    rawSnapshots.push(...calc.rawSnapshots);
  }
  if ("reject" in proof) {
    return rejectZeroBorrowings(proof.reject, rawSnapshots, [], calcMetrics);
  }
  const { snippet: _snippet, ...filingSource } = item.source;
  return {
    metrics: {
      ...calcMetrics,
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
export async function fetchExtensionInvestmentsProof(
  ctx: CollectContext,
  filing: SecFiling,
  cik: string,
  html: string,
  source: Source,
  reads: LinkbaseReads,
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
  const parsed = attempt(() => parseXbrlInstance(instance.payload));
  if (parsed === undefined) {
    return fail("instance-unreadable", "malformed-response", [instance.rawSnapshot]);
  }
  if (parsed.calculationLinkbaseRefs.length > 0 || parsed.schemaRefs.length !== 1) {
    return fail("calculation-linkbase-ambiguous", "provider-data-missing", [instance.rawSnapshot]);
  }
  const calc = await fetchCalculationLinkbase(ctx, parsed.schemaRefs[0], url, reads);
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
  const { schema: calcSchema, xml: calcXml, xmlUrl: calcXmlUrl } = calc;
  const proof = attempt(() => {
    const schema = extensionSchema(calcSchema.url, calcSchema.xml);
    return extensionShortTermInvestmentsProof(
      parsed,
      {
        extensionNamespace: schema.namespace,
        parents: summationParents(calcXml, calcXmlUrl, schema),
      },
      { file: instanceFile, cik },
    );
  });
  if (proof === undefined) {
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

function attempt<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
