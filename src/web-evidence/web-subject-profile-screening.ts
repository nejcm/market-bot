import { violatesResearchOnly } from "../domain/research-language";
import type { SourceGap } from "../domain/sources";
import type { MetricSection } from "../sources/extended-evidence/metric-engine";
import { GEOGRAPHIC_REVENUE_SECTION_ID } from "../sources/extended-evidence/geographic-revenue";
import {
  isWebSubjectProfileWithheldAnswer,
  WEB_SUBJECT_PROFILE_SHARE_MISMATCH_ANSWER_NOTICE,
  WEB_SUBJECT_PROFILE_SHARE_MISMATCH_MARKER,
  WEB_SUBJECT_PROFILE_SHARE_MISMATCH_SUBJECT_SUMMARY_NOTICE,
  WEB_SUBJECT_PROFILE_WEB_FIGURE_ANSWER_NOTICE,
  WEB_SUBJECT_PROFILE_WEB_FIGURE_MARKER,
  WEB_SUBJECT_PROFILE_WEB_FIGURE_SUBJECT_SUMMARY_NOTICE,
  WEB_SUBJECT_PROFILE_WITHHELD_ANSWER_NOTICE,
  WEB_SUBJECT_PROFILE_WITHHELD_MARKER,
  WEB_SUBJECT_PROFILE_WITHHELD_SUBJECT_SUMMARY_NOTICE,
  type WebSubjectProfileAnswer,
  type WebSubjectProfileArtifact,
  type WebSubjectProfileFact,
  type WebSubjectProfileOpenGap,
  isUnreadableOpenGapsNotice,
} from "./contract";
import { pruneSentences } from "../research/report-integrity-audit";
import {
  droppedFigureQuoteText,
  failedFigureQuotes,
  unverifiedWebFigure,
  webFigureGapText,
  type WebSourceTexts,
} from "../research/web-figure-verification";
import type { WebFigureFailure } from "../domain/report";
import {
  EMPTY_ANSWER,
  type ScreenableProfileFields,
  otherGap,
  profileSourceIds,
  profileGap,
} from "./web-subject-profile-parse";

const SHARE_BULLET = /^\s*(?:[-*•]\s*)?\[?([^\]\n:]+?)\]?:\s*([-+−]?\d+(?:\.\d+)?)%/u;
const SHARE_LABEL = / share of revenue$/u;
const SHARE_NAME_ALIASES: Readonly<Record<string, string>> = {
  us: "united states",
  "u.s.": "united states",
  usa: "united states",
  "u.s.a.": "united states",
  "europe, middle east and africa": "emea",
  "europe, middle east, and africa": "emea",
  apac: "asia pacific",
  "asia-pacific": "asia pacific",
};
const SHARE_TAIL =
  /^\s*(?:(?:of (?:total |net )?revenue|of sales|revenue share)(?:\s+(?:in fiscal (?:year )?\d{4}|in FY\s?\d{4}|for the (?:three|six|nine|twelve) months ended [A-Z][a-z]+ \d{1,2}, \d{4}))?)?\s*\.?\s*(?:\[[^\]]+\]\s*)*$/u;
const SHARE_TOLERANCE_POINTS = 0.5;

type RevenueShares = ReadonlyMap<string, readonly number[]>;

export function revenueShares(sections: readonly MetricSection[] | undefined): RevenueShares {
  const shares = new Map<string, number[]>();
  for (const metric of sections?.find(({ id }) => id === GEOGRAPHIC_REVENUE_SECTION_ID)?.metrics ??
    []) {
    if (
      metric.status === "value" &&
      typeof metric.value === "number" &&
      SHARE_LABEL.test(metric.label)
    ) {
      const name = metric.label.replace(SHARE_LABEL, "").toLowerCase();
      shares.set(name, [...(shares.get(name) ?? []), metric.value * 100]);
    }
  }
  return shares;
}

function contradictsRevenueShare(answer: string, shares: RevenueShares): boolean {
  return answer.split("\n").some((line) => {
    const [match, rawName, percent] = SHARE_BULLET.exec(line) ?? [];
    const rest = line.slice(match?.length ?? 0);
    if (!SHARE_TAIL.test(rest)) {
      return false;
    }
    const name = rawName?.trim().toLowerCase() ?? "";
    const known = shares.get(name) ?? shares.get(SHARE_NAME_ALIASES[name] ?? name);
    const value = Number(percent?.replace("−", "-"));
    return (
      known !== undefined &&
      known.every((share) => Math.abs(share - value) > SHARE_TOLERANCE_POINTS)
    );
  });
}

interface ScreenedProfileFields extends ScreenableProfileFields {
  readonly withheldGaps: readonly SourceGap[];
}

export function assertCodeAssembledProfileText(text: string, origin: string): string {
  const violation = violatesResearchOnly(text);
  if (violation !== null) {
    throw new Error(
      `Web Subject Profile ${origin} is code-assembled and must not carry research-only wording: "${violation.match}"`,
    );
  }
  return text;
}

function withheldCountSummary(
  noun: string,
  withheldCount: number,
  totalCount: number,
  marker = WEB_SUBJECT_PROFILE_WITHHELD_MARKER,
): string {
  return (
    `Web Subject Profile: ${String(withheldCount)} of ${String(totalCount)} ${noun} ` +
    `${marker}; the original wording stays in the run's raw stage output.`
  );
}

function screenRequiredAnswer(
  answer: WebSubjectProfileAnswer,
  notice: string,
  origin: string,
  shares: RevenueShares,
  mismatchNotice: string,
): {
  readonly answer: WebSubjectProfileAnswer;
  readonly withheld: boolean;
  readonly shareMismatch?: true;
} {
  if (answer.answer === "") {
    return { answer, withheld: false };
  }
  if (answer.answer.includes(WEB_SUBJECT_PROFILE_SHARE_MISMATCH_MARKER)) {
    return { answer, withheld: true, shareMismatch: true };
  }
  if (answer.answer.includes(WEB_SUBJECT_PROFILE_WEB_FIGURE_MARKER)) {
    return { answer, withheld: false };
  }
  if (
    violatesResearchOnly(answer.answer) === null &&
    contradictsRevenueShare(answer.answer, shares)
  ) {
    return {
      answer: {
        answer: assertCodeAssembledProfileText(mismatchNotice, origin),
        sourceIds: answer.sourceIds,
      },
      withheld: true,
      shareMismatch: true,
    };
  }
  if (violatesResearchOnly(answer.answer) !== null) {
    if (answer.sourceIds.length === 0) {
      return { answer: EMPTY_ANSWER, withheld: true };
    }
    return {
      answer: {
        answer: assertCodeAssembledProfileText(notice, origin),
        sourceIds: answer.sourceIds,
      },
      withheld: true,
    };
  }
  if (isWebSubjectProfileWithheldAnswer(answer.answer)) {
    return { answer, withheld: true };
  }
  return { answer, withheld: false };
}

function screenModelQuestions(
  questions: Readonly<Record<string, WebSubjectProfileAnswer>>,
  shares: RevenueShares,
): {
  readonly questions: Readonly<Record<string, WebSubjectProfileAnswer>>;
  readonly withheldCount: number;
  readonly mismatchCount: number;
  readonly totalCount: number;
} {
  const entries = Object.entries(questions);
  let withheldCount = 0;
  let mismatchCount = 0;
  const next: [string, WebSubjectProfileAnswer][] = [];
  for (const [key, answer] of entries) {
    const screened = screenRequiredAnswer(
      answer,
      WEB_SUBJECT_PROFILE_WITHHELD_ANSWER_NOTICE,
      "withheld-answer notice",
      shares,
      WEB_SUBJECT_PROFILE_SHARE_MISMATCH_ANSWER_NOTICE,
    );
    if (screened.shareMismatch === true) {
      mismatchCount += 1;
    } else if (screened.withheld) {
      withheldCount += 1;
    }
    next.push([key, screened.answer]);
  }
  return {
    questions: withheldCount + mismatchCount === 0 ? questions : Object.fromEntries(next),
    withheldCount,
    mismatchCount,
    totalCount: entries.length,
  };
}

function screenModelFacts(
  facts: readonly WebSubjectProfileFact[],
  fieldLabel: string,
  origin: string,
  shares: RevenueShares,
): {
  readonly facts: readonly WebSubjectProfileFact[];
  readonly withheldGaps: readonly SourceGap[];
} {
  if (facts.length === 0) {
    return { facts, withheldGaps: [] };
  }
  const kept: WebSubjectProfileFact[] = [];
  const withheld: WebSubjectProfileFact[] = [];
  const mismatched: WebSubjectProfileFact[] = [];
  const preexistingNotices: WebSubjectProfileFact[] = [];
  for (const fact of facts) {
    if (violatesResearchOnly(fact.claim) !== null) {
      withheld.push(fact);
    } else if (contradictsRevenueShare(fact.claim, shares)) {
      mismatched.push(fact);
    } else if (isWebSubjectProfileWithheldAnswer(fact.claim)) {
      preexistingNotices.push(fact);
      kept.push(fact);
    } else {
      kept.push(fact);
    }
  }
  if (withheld.length === 0 && mismatched.length === 0 && preexistingNotices.length === 0) {
    return { facts, withheldGaps: [] };
  }
  const gaps: SourceGap[] = [];
  if (preexistingNotices[0] !== undefined) {
    gaps.push(
      profileGap(
        assertCodeAssembledProfileText(preexistingNotices[0].claim, origin),
        "validation-failed",
      ),
    );
  }
  const considered = facts.length - preexistingNotices.length;
  const summaries = (
    [
      [withheld, WEB_SUBJECT_PROFILE_WITHHELD_MARKER],
      [mismatched, WEB_SUBJECT_PROFILE_SHARE_MISMATCH_MARKER],
    ] as const
  ).flatMap(([group, marker]) =>
    group.length === 0
      ? []
      : [
          {
            claim: assertCodeAssembledProfileText(
              withheldCountSummary(fieldLabel, group.length, considered, marker),
              origin,
            ),
            sourceIds: [...new Set(group.flatMap((fact) => fact.sourceIds))].toSorted(),
          },
        ],
  );
  return {
    facts: [...kept, ...summaries],
    withheldGaps: [
      ...gaps,
      ...summaries.map(({ claim }) => profileGap(claim, "validation-failed")),
    ],
  };
}

function screenModelOpenGaps(gaps: readonly WebSubjectProfileOpenGap[]): {
  readonly kept: readonly WebSubjectProfileOpenGap[];
  readonly withheldCount: number;
  readonly preexistingNotices: readonly WebSubjectProfileOpenGap[];
} {
  const preexistingNotices: WebSubjectProfileOpenGap[] = [];
  const kept: WebSubjectProfileOpenGap[] = [];
  let withheldCount = 0;
  for (const gap of gaps) {
    if (violatesResearchOnly(gap.text) !== null) {
      withheldCount += 1;
    } else if (isWebSubjectProfileWithheldAnswer(gap.text)) {
      preexistingNotices.push(gap);
    } else {
      kept.push(gap);
    }
  }
  return { kept, withheldCount, preexistingNotices };
}

export function screenProfileFields(
  profile: ScreenableProfileFields,
  shares: RevenueShares,
  webTexts: WebSourceTexts,
): ScreenedProfileFields {
  const subjectSummary = screenRequiredAnswer(
    profile.subjectSummary,
    WEB_SUBJECT_PROFILE_WITHHELD_SUBJECT_SUMMARY_NOTICE,
    "withheld-summary notice",
    shares,
    WEB_SUBJECT_PROFILE_SHARE_MISMATCH_SUBJECT_SUMMARY_NOTICE,
  );
  const questions = screenModelQuestions(profile.questions, shares);
  const events = screenModelFacts(
    profile.recentMaterialEvents,
    "recent material events",
    "withheld-events summary",
    shares,
  );
  const ledger = screenModelFacts(
    profile.factLedger,
    "fact-ledger claims",
    "withheld-facts summary",
    shares,
  );
  const openGaps = screenModelOpenGaps(profile.openGaps);
  const withheldGaps: SourceGap[] = [];
  if (subjectSummary.withheld) {
    withheldGaps.push(
      profileGap(
        assertCodeAssembledProfileText(
          subjectSummary.shareMismatch === true
            ? WEB_SUBJECT_PROFILE_SHARE_MISMATCH_SUBJECT_SUMMARY_NOTICE
            : WEB_SUBJECT_PROFILE_WITHHELD_SUBJECT_SUMMARY_NOTICE,
          "withheld-summary gap",
        ),
        "validation-failed",
      ),
    );
  }
  if (questions.withheldCount > 0) {
    withheldGaps.push(
      profileGap(
        assertCodeAssembledProfileText(
          withheldCountSummary("question answers", questions.withheldCount, questions.totalCount),
          "withheld-questions summary",
        ),
        "validation-failed",
      ),
    );
  }
  if (questions.mismatchCount > 0) {
    withheldGaps.push(
      profileGap(
        assertCodeAssembledProfileText(
          withheldCountSummary(
            "question answers",
            questions.mismatchCount,
            questions.totalCount,
            WEB_SUBJECT_PROFILE_SHARE_MISMATCH_MARKER,
          ),
          "withheld-questions summary",
        ),
        "validation-failed",
      ),
    );
  }
  if (events.withheldGaps.length > 0) {
    withheldGaps.push(...events.withheldGaps);
  }
  if (ledger.withheldGaps.length > 0) {
    withheldGaps.push(...ledger.withheldGaps);
  }
  const withheldOpenGapsNotice =
    openGaps.withheldCount === 0
      ? undefined
      : assertCodeAssembledProfileText(
          withheldCountSummary(
            "declared open gaps",
            openGaps.withheldCount,
            openGaps.kept.filter((gap) => !isUnreadableOpenGapsNotice(gap.text)).length +
              openGaps.withheldCount,
          ),
          "withheld-gaps summary",
        );
  if (withheldOpenGapsNotice !== undefined) {
    withheldGaps.push(profileGap(withheldOpenGapsNotice, "validation-failed"));
  }
  if (openGaps.preexistingNotices[0] !== undefined) {
    withheldGaps.push(
      profileGap(
        assertCodeAssembledProfileText(
          openGaps.preexistingNotices[0].text,
          "withheld-gaps summary",
        ),
        "validation-failed",
      ),
    );
  }
  const figures = screenWebFigures(
    {
      subjectSummary: subjectSummary.answer,
      questions: questions.questions,
      recentMaterialEvents: events.facts,
      factLedger: ledger.facts,
    },
    webTexts,
  );
  withheldGaps.push(...figures.withheldGaps);
  return {
    subjectSummary: figures.subjectSummary,
    questions: figures.questions,
    recentMaterialEvents: figures.recentMaterialEvents,
    factLedger: figures.factLedger,
    openGaps:
      withheldOpenGapsNotice === undefined
        ? profile.openGaps
        : [...openGaps.kept, ...openGaps.preexistingNotices, otherGap(withheldOpenGapsNotice)],
    withheldGaps,
  };
}

type WebFigureFields = Omit<ScreenableProfileFields, "openGaps">;

// ADR 0006: answers lose failing sentences (all of them → notice); facts drop with a count notice.
function screenWebFigures(
  fields: WebFigureFields,
  webTexts: WebSourceTexts,
): WebFigureFields & { readonly withheldGaps: readonly SourceGap[] } {
  const withheldGaps: SourceGap[] = [];
  const failureGap = (location: string, failure: WebFigureFailure): void => {
    withheldGaps.push(profileGap(webFigureGapText(location, failure), "validation-failed"));
  };
  const withProvenQuotes = <T extends WebSubjectProfileAnswer | WebSubjectProfileFact>(
    value: T,
    location: string,
  ): T => {
    const failed = failedFigureQuotes(value, webTexts);
    for (const quote of failed) {
      withheldGaps.push(profileGap(droppedFigureQuoteText(location, quote), "validation-failed"));
    }
    return failed.length === 0 || value.figureQuotes === undefined
      ? value
      : {
          ...value,
          figureQuotes: value.figureQuotes.filter(
            (quote) =>
              !failed.some(
                (row) =>
                  row.sourceId === quote.sourceId &&
                  row.quote === quote.quote &&
                  row.unitQuote === quote.unitQuote,
              ),
          ),
        };
  };
  const answer = (
    original: WebSubjectProfileAnswer,
    location: string,
    notice: string,
  ): WebSubjectProfileAnswer => {
    const value = withProvenQuotes(original, location);
    if (value.answer.includes(WEB_SUBJECT_PROFILE_WEB_FIGURE_MARKER)) {
      withheldGaps.push(profileGap(value.answer, "validation-failed"));
      return value;
    }
    if (value.answer === "" || isWebSubjectProfileWithheldAnswer(value.answer)) {
      return value;
    }
    const { kept, pruned } = pruneSentences(value.answer, (sentence) => {
      const failure = unverifiedWebFigure({ ...original, text: sentence }, webTexts);
      if (failure !== undefined) {
        failureGap(location, failure);
      }
      return failure !== undefined;
    });
    if (pruned.length === 0) {
      return value;
    }
    return kept === ""
      ? { answer: assertCodeAssembledProfileText(notice, location), sourceIds: value.sourceIds }
      : { ...value, answer: kept };
  };
  const facts = (
    rows: readonly WebSubjectProfileFact[],
    location: string,
    fieldLabel: string,
  ): readonly WebSubjectProfileFact[] => {
    const failed: WebSubjectProfileFact[] = [];
    const kept = rows.flatMap((fact, index) => {
      if (isWebSubjectProfileWithheldAnswer(fact.claim)) {
        return [fact];
      }
      const failure = unverifiedWebFigure({ ...fact, text: fact.claim }, webTexts);
      if (failure !== undefined) {
        failureGap(`${location}[${String(index)}]`, failure);
        failed.push(fact);
        return [];
      }
      return [withProvenQuotes(fact, `${location}[${String(index)}]`)];
    });
    if (failed.length === 0) {
      return kept;
    }
    const considered = rows.filter((fact) => !isWebSubjectProfileWithheldAnswer(fact.claim)).length;
    return [
      ...kept,
      {
        claim: assertCodeAssembledProfileText(
          withheldCountSummary(
            fieldLabel,
            failed.length,
            considered,
            WEB_SUBJECT_PROFILE_WEB_FIGURE_MARKER,
          ),
          `${location} web-figure summary`,
        ),
        sourceIds: [...new Set(failed.flatMap((fact) => fact.sourceIds))].toSorted(),
      },
    ];
  };
  return {
    subjectSummary: answer(
      fields.subjectSummary,
      "webSubjectProfile.subjectSummary",
      WEB_SUBJECT_PROFILE_WEB_FIGURE_SUBJECT_SUMMARY_NOTICE,
    ),
    questions: Object.fromEntries(
      Object.entries(fields.questions).map(([key, value]) => [
        key,
        answer(
          value,
          `webSubjectProfile.questions.${key}`,
          WEB_SUBJECT_PROFILE_WEB_FIGURE_ANSWER_NOTICE,
        ),
      ]),
    ),
    recentMaterialEvents: facts(
      fields.recentMaterialEvents,
      "webSubjectProfile.recentMaterialEvents",
      "recent material events",
    ),
    factLedger: facts(fields.factLedger, "webSubjectProfile.factLedger", "fact-ledger claims"),
    withheldGaps,
  };
}

export function applyScreenedFields(
  artifact: WebSubjectProfileArtifact,
  screened: ScreenableProfileFields,
): WebSubjectProfileArtifact {
  return {
    ...artifact,
    subjectSummary: screened.subjectSummary,
    questions: screened.questions,
    recentMaterialEvents: screened.recentMaterialEvents,
    factLedger: screened.factLedger,
    openGaps: screened.openGaps,
    sourceIds: profileSourceIds(screened),
  } as WebSubjectProfileArtifact;
}
