import type { Source, SourceGap } from "../../domain/types";
import { sourceGap } from "../../domain/source-gaps";
import { isRecord, readString } from "../../guards";
import { secRequestInit } from "./sec-edgar";
import type { FinancialStatementsArtifact } from "./financial-statements-contract";
import {
  buildFinancialTablePacket,
  financialTablePacketCells,
} from "./untagged-financial-table-packet";
import type {
  FinancialTablePacket,
  FinancialTableSourceLocator,
} from "./untagged-financial-tables-contract";
import { isFetchTextResult, type RawSourceSnapshot, type SourceRequestExecutor } from "../types";

const MAX_FILING_CANDIDATES = 6;
const MAX_DOCUMENT_CANDIDATES = 4;

interface FilingCandidate {
  readonly accessionNumber: string;
  readonly filedAt: string;
  readonly reportDate: string;
  readonly primaryDocument: string;
  readonly form: "6-K" | "6-K/A";
}

interface FilingDocument {
  readonly name: string;
  readonly url: string;
  readonly description: string;
  readonly type: string;
  readonly score: number;
}

export interface UntaggedFinancialExhibit {
  readonly filing: FilingCandidate;
  readonly packet: FinancialTablePacket;
  readonly source: Source;
}

export interface CollectUntaggedFinancialExhibitResult {
  readonly exhibit?: UntaggedFinancialExhibit;
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly gaps: readonly SourceGap[];
}

export interface CollectUntaggedFinancialExhibitInput {
  readonly symbol: string;
  readonly fetchedAt: string;
  readonly request: SourceRequestExecutor;
  readonly secUserAgent?: string;
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly financialStatements: FinancialStatementsArtifact;
}

function normalizedText(value: string): string {
  return value
    .replaceAll(/&#(\d+);/gu, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replaceAll(/&nbsp;/giu, " ")
    .replaceAll(/&amp;/giu, "&")
    .replaceAll(/<[^>]*>/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function submissionPayload(snapshots: readonly RawSourceSnapshot[]): unknown {
  return snapshots.find((snapshot) => snapshot.adapter === "sec-submissions")?.payload;
}

function latestAnnualEnd(artifact: FinancialStatementsArtifact): string | undefined {
  return artifact.statements.incomeStatement.revenue.annual.at(-1)?.periodEnd;
}

function filingCandidates(
  payload: unknown,
  annualEnd: string | undefined,
  cutoff: string,
): readonly FilingCandidate[] {
  if (!isRecord(payload) || !isRecord(payload.filings) || !isRecord(payload.filings.recent)) {
    return [];
  }
  const { recent } = payload.filings;
  const forms = Array.isArray(recent.form) ? recent.form : [];
  const filed = Array.isArray(recent.filingDate) ? recent.filingDate : [];
  const reports = Array.isArray(recent.reportDate) ? recent.reportDate : [];
  const accessions = Array.isArray(recent.accessionNumber) ? recent.accessionNumber : [];
  const primaryDocuments = Array.isArray(recent.primaryDocument) ? recent.primaryDocument : [];
  return forms
    .flatMap((value, index): readonly FilingCandidate[] => {
      const form = value === "6-K" || value === "6-K/A" ? value : undefined;
      const filedAt = filed[index];
      const reportDate = reports[index];
      const accessionNumber = accessions[index];
      const primaryDocument = primaryDocuments[index];
      if (
        form === undefined ||
        typeof filedAt !== "string" ||
        typeof reportDate !== "string" ||
        typeof accessionNumber !== "string" ||
        typeof primaryDocument !== "string" ||
        filedAt > cutoff ||
        (annualEnd !== undefined && reportDate <= annualEnd)
      ) {
        return [];
      }
      const periodSignal =
        reportDate !== filedAt ||
        /(?:quarter|q[1-4]|20\d{4}(?:03|06|09|12)\d{2})/iu.test(primaryDocument);
      return periodSignal ? [{ accessionNumber, filedAt, reportDate, primaryDocument, form }] : [];
    })
    .toSorted(
      (left, right) =>
        right.reportDate.localeCompare(left.reportDate) ||
        right.filedAt.localeCompare(left.filedAt) ||
        right.accessionNumber.localeCompare(left.accessionNumber),
    )
    .slice(0, MAX_FILING_CANDIDATES);
}

function cikFromSubmission(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const text = readString(payload, "cik");
  if (text !== undefined) {
    return text.replace(/^0+/u, "");
  }
  return typeof payload.cik === "number" && Number.isSafeInteger(payload.cik)
    ? String(payload.cik)
    : undefined;
}

function filingBaseUrl(cik: string, accessionNumber: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionNumber.replaceAll("-", "")}`;
}

function documentScore(name: string, description: string, type: string): number {
  const text = `${name} ${description}`.toLowerCase();
  let score = /^EX-99/iu.test(type) ? 3 : 0;
  if (/financial|statement/iu.test(text)) {
    score += 20;
  }
  if (/earnings|results|interim|quarter/iu.test(text)) {
    score += 10;
  }
  return score;
}

function filingDocuments(
  html: string,
  baseUrl: string,
  primaryDocument: string,
): readonly FilingDocument[] {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)]
    .flatMap((rowMatch): readonly FilingDocument[] => {
      const row = rowMatch[1] ?? "";
      const href = row.match(/href=["']([^"']+)["']/iu)?.[1];
      const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/giu)].map((match) =>
        normalizedText(match[1] ?? ""),
      );
      const { 2: name, 3: type } = cells;
      if (
        href === undefined ||
        name === undefined ||
        type === undefined ||
        name === primaryDocument ||
        !/\.html?$/iu.test(name) ||
        !/^EX-99/iu.test(type)
      ) {
        return [];
      }
      const url = new URL(href, "https://www.sec.gov");
      if (url.hostname !== "www.sec.gov" || !url.pathname.startsWith("/Archives/edgar/data/")) {
        return [];
      }
      const description = cells[1] ?? "";
      return [
        {
          name,
          url: url.href,
          description,
          type,
          score: documentScore(name, description, type),
        },
      ];
    })
    .toSorted((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, MAX_DOCUMENT_CANDIDATES)
    .map((document) => ({ ...document, url: new URL(document.name, `${baseUrl}/`).href }));
}

function packetScore(packet: FinancialTablePacket): number {
  const text = financialTablePacketCells(packet)
    .map((cell) => cell.text)
    .join(" ")
    .toLowerCase();
  const required = [
    "total assets",
    "total liabilities",
    "total shareholders",
    "revenue",
    "operating activities",
  ];
  return required.filter((term) => text.includes(term)).length * 100 + packet.tables.length;
}

function extractionGap(
  symbol: string,
  message: string,
  cause:
    | "fetch-failed"
    | "provider-data-missing"
    | "unsupported-coverage" = "provider-data-missing",
): SourceGap {
  return sourceGap({
    source: "sec-untagged-financials",
    message,
    symbol,
    provider: "sec-edgar",
    capability: "extended-evidence",
    cause,
    evidenceQualityImpact: "no-cap",
  });
}

export async function collectUntaggedFinancialExhibit(
  input: CollectUntaggedFinancialExhibitInput,
): Promise<CollectUntaggedFinancialExhibitResult> {
  const submissions = submissionPayload(input.rawSnapshots);
  const cik = cikFromSubmission(submissions);
  const candidates = filingCandidates(
    submissions,
    latestAnnualEnd(input.financialStatements),
    input.fetchedAt.slice(0, 10),
  );
  if (cik === undefined || candidates.length === 0) {
    return {
      rawSnapshots: [],
      gaps: [
        extractionGap(
          input.symbol,
          `No bounded financial 6-K candidate could be identified for ${input.symbol}`,
        ),
      ],
    };
  }
  const requestInit = secRequestInit(input.secUserAgent);
  const collectedSnapshots: RawSourceSnapshot[] = [];
  const requestGaps: SourceGap[] = [];
  const packets: { readonly filing: FilingCandidate; readonly packet: FinancialTablePacket }[] = [];

  for (const filing of candidates) {
    const baseUrl = filingBaseUrl(cik, filing.accessionNumber);
    const indexUrl = `${baseUrl}/${filing.accessionNumber}-index.html`;
    // SEC archive requests stay sequential to respect the public endpoint's rate limits.
    // eslint-disable-next-line no-await-in-loop
    const index = await input.request.text({
      url: indexUrl,
      adapter: "sec-filing-index",
      ...(requestInit !== undefined ? { init: requestInit } : {}),
    });
    if (!isFetchTextResult(index)) {
      requestGaps.push(index);
      continue;
    }
    collectedSnapshots.push(index.rawSnapshot);
    const documents = filingDocuments(index.payload, baseUrl, filing.primaryDocument);
    for (const document of documents) {
      // eslint-disable-next-line no-await-in-loop
      const response = await input.request.text({
        url: document.url,
        adapter: "sec-untagged-financial-exhibit",
        ...(requestInit !== undefined ? { init: requestInit } : {}),
      });
      if (!isFetchTextResult(response)) {
        requestGaps.push(response);
        continue;
      }
      collectedSnapshots.push(response.rawSnapshot);
      const source: Omit<FinancialTableSourceLocator, "sha256"> = {
        url: document.url,
        accessionNumber: filing.accessionNumber,
        documentName: document.name,
        filedAt: filing.filedAt,
        form: filing.form,
      };
      // Packet hashing is kept in the same bounded sequential request loop.
      // eslint-disable-next-line no-await-in-loop
      const packet = await buildFinancialTablePacket(response.payload, source);
      packets.push({
        filing,
        packet,
      });
    }
    if (packets.some(({ packet }) => packetScore(packet) >= 500)) {
      break;
    }
  }

  const [selected] = packets
    .filter(({ packet }) => packet.unsupportedReason === undefined)
    .toSorted((left, right) => packetScore(right.packet) - packetScore(left.packet));
  if (selected === undefined) {
    const [firstPacket] = packets;
    const unsupported = firstPacket?.packet.unsupportedReason;
    return {
      rawSnapshots: collectedSnapshots,
      gaps: [
        ...requestGaps,
        extractionGap(
          input.symbol,
          unsupported === undefined
            ? `No supported SEC HTML financial table exhibit was available for ${input.symbol}`
            : `SEC financial exhibit layout is unsupported for ${input.symbol}: ${unsupported}`,
          unsupported === undefined ? "provider-data-missing" : "unsupported-coverage",
        ),
      ],
    };
  }
  const sourceId = `sec-untagged-financial-${input.symbol.toLowerCase()}-${selected.filing.accessionNumber.replaceAll("-", "")}`;
  return {
    exhibit: {
      filing: selected.filing,
      packet: selected.packet,
      source: {
        id: sourceId,
        title: `${input.symbol.toUpperCase()} untagged interim financial statements`,
        url: selected.packet.source.url,
        publisher: "SEC EDGAR",
        fetchedAt: input.fetchedAt,
        kind: "extended-evidence",
        assetClass: "equity",
        symbol: input.symbol.toUpperCase(),
        provider: "sec-edgar",
        providerArticleId: selected.filing.accessionNumber,
        summary: `Untagged ${selected.filing.form} financial table exhibit filed ${selected.filing.filedAt} for period ${selected.filing.reportDate}.`,
      },
    },
    rawSnapshots: collectedSnapshots,
    gaps: requestGaps,
  };
}
