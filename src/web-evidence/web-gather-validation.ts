import { isInstrumentCommand, type ResearchCommand } from "../cli/args";
import type { WebGatherSubject } from "../sources/web-gather-emit";
import type { CollectedSources } from "../sources/types";
import { COMMON_COMPANY_SUFFIXES, normalizeTerm, THEME_STOPWORDS } from "./web-gather-coverage";

export function subjectTermsForRun(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  subject: WebGatherSubject,
): readonly string[] {
  if (command.jobType === "research") {
    const resolved = collectedSources.resolvedSubject;
    if (resolved?.subjectKey !== undefined) {
      return [
        ...new Set(
          [resolved.subjectKey, resolved.displayName, ...(resolved.aliases ?? [])].flatMap((term) =>
            term === undefined ? [] : significantSubjectTerms(term),
          ),
        ),
      ];
    }
    return significantSubjectTerms(command.subject);
  }
  if (!isInstrumentCommand(command)) {
    return [];
  }
  const displayName =
    collectedSources.resolvedInstrumentIdentity?.displayName ??
    collectedSources.marketSnapshots.find(
      (snapshot) => snapshot.symbol.toUpperCase() === command.symbol.toUpperCase(),
    )?.name;
  let labelTerms: readonly string[] = [];
  if (displayName !== undefined) {
    labelTerms =
      subject.subjectKind === "company"
        ? companyTerms(displayName)
        : significantSubjectTerms(displayName);
  }
  const terms = [command.symbol, ...labelTerms];
  return [...new Set(terms.map((term) => normalizeTerm(term)).filter((term) => term !== ""))];
}

export function subjectLabelForRun(
  command: ResearchCommand,
  collectedSources: CollectedSources,
): string | undefined {
  if (command.jobType === "research") {
    return collectedSources.resolvedSubject?.subjectKey ?? command.subjectKey ?? command.subject;
  }
  if (!isInstrumentCommand(command)) {
    return undefined;
  }
  return (
    collectedSources.resolvedInstrumentIdentity?.displayName ??
    collectedSources.marketSnapshots.find(
      (snapshot) => snapshot.symbol.toUpperCase() === command.symbol.toUpperCase(),
    )?.name
  );
}

function companyTerms(name: string): readonly string[] {
  const normalized = normalizeTerm(name);
  const significant = normalized
    .split(" ")
    .filter((token) => token.length > 1 && !COMMON_COMPANY_SUFFIXES.has(token));
  return [normalized, significant.join(" "), significant[0] ?? ""].filter((term) => term !== "");
}

function significantSubjectTerms(subject: string): readonly string[] {
  const normalized = normalizeTerm(subject);
  const significant = normalized
    .split(" ")
    .filter((token) => token.length > 1 && !THEME_STOPWORDS.has(token));
  return [normalized, ...significant].filter((term) => term !== "");
}

// Shared by both audit-assembly sites (the generic json-tool loop and the deep-equity batch
// Path) so a rejected-by-execution entry (an Exa call that failed outright, as opposed to one
