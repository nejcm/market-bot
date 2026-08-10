// Generic helpers for the SEC EDGAR archive layout, shared by every path that has to walk a
// Filing's document index (FPI untagged financial tables, 8-K earnings-release exhibits).

const MAX_DOCUMENT_CANDIDATES = 4;

export interface FilingDocument {
  readonly name: string;
  readonly url: string;
  readonly description: string;
  readonly type: string;
  readonly score: number;
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

export function filingBaseUrl(cik: string, accessionNumber: string): string {
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

function isSecArchiveDocumentUrl(url: URL): boolean {
  return url.hostname === "www.sec.gov" && url.pathname.startsWith("/Archives/edgar/data/");
}

export function filingDocuments(
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
      const linkedUrl = URL.parse(href, "https://www.sec.gov");
      const documentUrl = URL.parse(name, `${baseUrl}/`);
      if (
        linkedUrl === null ||
        documentUrl === null ||
        !isSecArchiveDocumentUrl(linkedUrl) ||
        !isSecArchiveDocumentUrl(documentUrl)
      ) {
        return [];
      }
      const description = cells[1] ?? "";
      return [
        {
          name,
          url: documentUrl.href,
          description,
          type,
          score: documentScore(name, description, type),
        },
      ];
    })
    .toSorted((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, MAX_DOCUMENT_CANDIDATES);
}
