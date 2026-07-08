import {
  isInstrumentJobType,
  researchReportEvidenceQuality,
  type KeyFinding,
  type Prediction,
  type ResearchReport,
  type Scenario,
} from "../domain/types";
import { renderClaimForMeasurableAs } from "../forecast/observable";
import { RESEARCH_ONLY_NOTE } from "./schema";
import {
  readAlphaSearchLeads,
  readAlphaSearchProfileCoverage,
  readAlphaSearchRejectedCandidates,
} from "../alpha-search/report-extras";
import { isRecord } from "../sources/guards";

const RESEARCH_ONLY_ALPHA_SEARCH_NOTE =
  "Research-only note: This alpha-search report is for market research only and does not provide investment advice, trade recommendations, position sizing, execution instructions, or portfolio changes.";

function sourceRefs(sourceIds: readonly string[]): string {
  return sourceIds.map((sourceId) => `[${markdownText(sourceId)}]`).join(" ");
}

function markdownText(value: string): string {
  return value.replaceAll(/[\\[\]()*_#|<>]/gu, (char) => {
    if (char === "<") {
      return "&lt;";
    }
    if (char === ">") {
      return "&gt;";
    }
    return `${String.fromCodePoint(92)}${char}`;
  });
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function knownSourceIds(report: ResearchReport, sourceIds: unknown): readonly string[] {
  const known = new Set(report.sources.map((source) => source.id));
  return readStringArray(sourceIds).filter((sourceId) => known.has(sourceId));
}

function collectReportSourceIds(report: ResearchReport): ReadonlySet<string> {
  const ids = new Set<string>();
  const add = (sourceIds: readonly string[]) => {
    for (const sourceId of sourceIds) {
      ids.add(sourceId);
    }
  };
  [report.keyFindings, report.bullCase, report.bearCase, report.risks, report.catalysts].forEach(
    (items) => items.forEach((item) => add(item.sourceIds)),
  );
  report.scenarios.forEach((scenario) => add(scenario.sourceIds));
  report.predictions.forEach((prediction) => add(prediction.sourceIds));
  report.extendedEvidence?.items.forEach((item) => add(item.sourceIds));
  readAlphaSearchLeads(report.extras).forEach((lead) => add(lead.sourceIds));
  readAlphaSearchRejectedCandidates(report.extras).forEach((candidate) => add(candidate.sourceIds));

  const historical = report.extras?.historicalContext;
  if (isRecord(historical)) {
    add(knownSourceIds(report, historical.sourceIds));
    if (Array.isArray(historical.items)) {
      historical.items.forEach((item) => {
        if (isRecord(item)) {
          add(knownSourceIds(report, item.sourceIds));
        }
      });
    }
  }
  const spotlights = report.extras?.spotlights;
  if (isRecord(spotlights) && Array.isArray(spotlights.items)) {
    spotlights.items.forEach((item) => {
      if (isRecord(item)) {
        add(knownSourceIds(report, item.sourceIds));
      }
    });
  }
  const framework = report.extras?.businessFramework;
  if (isRecord(framework)) {
    add(knownSourceIds(report, framework.sourceIds));
    if (Array.isArray(framework.sections)) {
      framework.sections.forEach((section) => {
        if (isRecord(section)) {
          add(knownSourceIds(report, section.sourceIds));
        }
      });
    }
  }
  const profile = report.extras?.webSubjectProfile;
  if (isRecord(profile)) {
    add(knownSourceIds(report, profile.sourceIds));
    if (isRecord(profile.questions)) {
      Object.values(profile.questions).forEach((question) => {
        if (isRecord(question)) {
          add(knownSourceIds(report, question.sourceIds));
        }
      });
    }
    for (const key of ["recentMaterialEvents", "factLedger"] as const) {
      const facts = profile[key];
      if (Array.isArray(facts)) {
        facts.forEach((fact) => {
          if (isRecord(fact)) {
            add(knownSourceIds(report, fact.sourceIds));
          }
        });
      }
    }
  }

  return ids;
}

function sourceInventoryLine(
  report: ResearchReport,
  uncitedCount: number,
  citedIds: ReadonlySet<string>,
): string {
  const counts = new Map<string, number>();
  report.sources
    .filter((source) => !citedIds.has(source.id))
    .forEach((source) => {
      const key = `${source.provider ?? "unknown"}/${source.kind}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
  const inventory = [...counts.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `${markdownText(key)}:${String(count)}`)
    .join(", ");
  return `- ${String(uncitedCount)} uncited normalized source(s) omitted from markdown (${inventory}). Full source arrays remain in report.json and console files.`;
}

function renderSources(report: ResearchReport): string {
  if (report.sources.length === 0) {
    return "- No sources.";
  }

  const citedIds = collectReportSourceIds(report);
  const citedSources = report.sources.filter((source) => citedIds.has(source.id));
  const uncitedCount = report.sources.length - citedSources.length;
  const rows = citedSources.map(
    (source) => `- [${markdownText(source.id)}] ${markdownText(source.title)}`,
  );
  if (uncitedCount > 0) {
    rows.push(sourceInventoryLine(report, uncitedCount, citedIds));
  }
  return rows.length === 0 ? sourceInventoryLine(report, uncitedCount, citedIds) : rows.join("\n");
}

function renderFindings(title: string, findings: readonly KeyFinding[]): string {
  if (findings.length === 0) {
    return `## ${title}\n\n- No sourced items.\n`;
  }

  return `## ${title}\n\n${findings.map((finding) => `- ${finding.text} ${sourceRefs(finding.sourceIds)}`).join("\n")}\n`;
}

function renderScenarios(scenarios: readonly Scenario[]): string {
  if (scenarios.length === 0) {
    return "## Scenarios\n\n- No sourced scenarios.\n";
  }

  return `## Scenarios\n\n${scenarios.map((scenario) => `- **${scenario.name}:** ${scenario.description} ${sourceRefs(scenario.sourceIds)}`).join("\n")}\n`;
}

function renderPredictions(predictions: readonly Prediction[]): string {
  if (predictions.length === 0) {
    return "";
  }

  const rows = predictions
    .map((pred) => {
      const pct = `${String(Math.round(pred.probability * 100))}%`;
      const refs = pred.sourceIds.length > 0 ? ` ${sourceRefs(pred.sourceIds)}` : "";
      const claim = renderClaimForMeasurableAs(pred.measurableAs, pred.claim) ?? pred.claim;
      return `- [${pct}] (${pred.horizonTradingDays}d) ${claim}${refs}`;
    })
    .join("\n");

  return `## Predictions\n\n${rows}\n`;
}

function renderExtendedEvidence(report: ResearchReport): string {
  if (!isInstrumentJobType(report.jobType)) {
    return "";
  }
  if (report.extendedEvidence === undefined) {
    return "";
  }
  const { items } = report.extendedEvidence;
  if (items.length === 0) {
    return "## Extended Evidence\n\n- No extended evidence items.\n";
  }
  const rows = items
    .map((item) => {
      const refs = sourceRefs(item.sourceIds);
      return `- **${markdownText(item.title)}:** ${markdownText(item.summary)}${refs === "" ? "" : ` ${refs}`}`;
    })
    .join("\n");
  return `## Extended Evidence\n\n${rows}\n`;
}

function renderHistoricalContext(report: ResearchReport): string {
  const extra = report.extras?.historicalContext;
  if (!isRecord(extra)) {
    return "";
  }
  const lines: string[] = [];
  if (typeof extra.summary === "string" && extra.summary !== "") {
    const refs = sourceRefs(knownSourceIds(report, extra.sourceIds));
    lines.push(`${markdownText(extra.summary)}${refs === "" ? "" : ` ${refs}`}`);
  }
  if (Array.isArray(extra.items)) {
    for (const item of extra.items) {
      if (!isRecord(item) || typeof item.text !== "string") {
        continue;
      }
      const refs = sourceRefs(knownSourceIds(report, item.sourceIds));
      if (refs === "") {
        continue;
      }
      lines.push(`- ${markdownText(item.text)} ${refs}`);
    }
  }
  if (Array.isArray(extra.gaps)) {
    for (const gap of extra.gaps) {
      if (typeof gap === "string" && gap !== "") {
        lines.push(`- ${markdownText(gap)}`);
      }
    }
  }
  return lines.length === 0 ? "" : `## Historical Context\n\n${lines.join("\n")}\n`;
}

function renderSpotlights(report: ResearchReport): string {
  const extra = report.extras?.spotlights;
  if (!isRecord(extra) || !Array.isArray(extra.items)) {
    return "";
  }
  const allowedResearchSymbols =
    report.jobType === "research" &&
    isRecord(report.extras?.depthProfile) &&
    Array.isArray(report.extras.depthProfile.predictionSubjects)
      ? new Set(
          report.extras.depthProfile.predictionSubjects.flatMap((subject) =>
            typeof subject === "string" ? [subject.toUpperCase()] : [],
          ),
        )
      : undefined;
  const rows = extra.items.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const { symbol, rationale: rawRationale, text, sourceIds } = item;
    if (typeof symbol !== "string") {
      return [];
    }
    let rationale = "";
    if (typeof rawRationale === "string") {
      rationale = rawRationale;
    } else if (typeof text === "string") {
      rationale = text;
    }
    const refs = sourceRefs(knownSourceIds(report, sourceIds));
    if (allowedResearchSymbols !== undefined && !allowedResearchSymbols.has(symbol.toUpperCase())) {
      return [];
    }
    if (rationale === "" || refs === "") {
      return [];
    }
    return [`- **${markdownText(symbol)}:** ${markdownText(rationale)} ${refs}`];
  });
  return rows.length === 0 ? "" : `## Market Spotlights\n\n${rows.join("\n")}\n`;
}

function readNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function deltaRegimeLine(delta: Record<string, unknown>): string {
  const current =
    typeof delta.currentRegime === "string" ? delta.currentRegime : "insufficient-data";
  const prior = typeof delta.priorRegime === "string" ? delta.priorRegime : undefined;
  if (delta.regimeChanged === true && prior !== undefined) {
    const flipped = readStringArray(delta.flippedDrivers);
    const suffix = flipped.length === 0 ? "" : ` (flipped drivers: ${flipped.join(", ")})`;
    return `Regime: ${markdownText(prior)} → ${markdownText(current)}${suffix}.`;
  }
  return `Regime: ${markdownText(current)} (unchanged since last run).`;
}

function deltaMoverLine(delta: Record<string, unknown>): string {
  const entered = readStringArray(delta.moversEntered).map((symbol) => markdownText(symbol));
  const exited = readStringArray(delta.moversExited).map((symbol) => markdownText(symbol));
  if (entered.length === 0 && exited.length === 0) {
    return "Ranked mover set unchanged since last run.";
  }
  return `Movers entered: ${entered.length === 0 ? "none" : entered.join(", ")}; exited: ${exited.length === 0 ? "none" : exited.join(", ")}.`;
}

function deltaResolvedLines(delta: Record<string, unknown>): readonly string[] {
  const resolved = Array.isArray(delta.resolvedSince) ? delta.resolvedSince : [];
  const rows = resolved.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const { claim, runId, outcome } = item;
    const probability = readNumberField(item, "probability");
    if (
      typeof claim !== "string" ||
      typeof runId !== "string" ||
      (outcome !== "hit" && outcome !== "miss") ||
      probability === undefined
    ) {
      return [];
    }
    const pct = String(Math.round(probability * 100));
    return [`- [${outcome}] p=${pct}% ${markdownText(claim)} (run ${markdownText(runId)})`];
  });
  return rows.length === 0 ? [] : ["", "Predictions resolved since last run:", ...rows];
}

// Market Update Delta — deterministic "what changed since the last comparable run".
// Pure render of report.extras.marketUpdateDelta; market-update jobs only. Research-only.
function renderMarketUpdateDelta(report: ResearchReport): string {
  if (
    report.jobType !== "market-overview" &&
    report.jobType !== "daily" &&
    report.jobType !== "weekly"
  ) {
    return "";
  }
  const delta = report.extras?.marketUpdateDelta;
  if (!isRecord(delta)) {
    return "";
  }
  const bucket = reportMarketUpdateBucket(report);
  const heading = `## What Changed Since Last ${bucket} Market Overview`;
  if (delta.hasBaseline !== true) {
    return `${heading}\n\nNo prior comparable market-overview run to compare — this is the first.\n`;
  }
  const lines = [deltaRegimeLine(delta), deltaMoverLine(delta), ...deltaResolvedLines(delta)];
  return `${heading}\n\n${lines.join("\n")}\n`;
}

function reportMarketUpdateBucket(report: ResearchReport): string {
  if (typeof report.extras?.marketUpdateHorizonBucket === "string") {
    return report.extras.marketUpdateHorizonBucket;
  }
  return report.jobType === "weekly" ? "11-15d" : "1-5d";
}

function renderAlphaSearchCoverage(report: ResearchReport): string {
  const coverage = readAlphaSearchProfileCoverage(report.extras);
  if (coverage === undefined) {
    return "";
  }
  return [
    "## Profile Coverage",
    "",
    `Displayed leads: ${String(coverage.displayedLeadCount)}`,
    `Candidate profiles with fundamentals: ${String(coverage.candidateProfilesWithFundamentals)}`,
    `Fundamental gaps: ${String(coverage.fundamentalGapCount)}`,
    `Unmapped SEC filings: ${String(coverage.unmappedSecFilingCount)} pre-ticker filing(s) disclosed separately, not mapped-lead enrichment failures.`,
    "",
  ].join("\n");
}

function renderCatalystCalendar(report: ResearchReport): string {
  const calendar = report.extras?.catalystCalendar;
  if (!isRecord(calendar) || !Array.isArray(calendar.items) || calendar.items.length === 0) {
    return "";
  }
  const rows = calendar.items.flatMap((item) => {
    if (!isRecord(item) || typeof item.label !== "string") {
      return [];
    }
    const date = typeof item.date === "string" ? `${item.date}: ` : "";
    const status = typeof item.sourceStatus === "string" ? ` (${item.sourceStatus})` : "";
    const sourceIds = Array.isArray(item.sourceIds)
      ? item.sourceIds.filter((sourceId): sourceId is string => typeof sourceId === "string")
      : [];
    return [`- ${date}${markdownText(item.label)}${status}${sourceRefs(sourceIds)}`];
  });
  return rows.length === 0 ? "" : ["## Catalyst Calendar", "", ...rows, ""].join("\n");
}

function socialDriverText(lead: {
  readonly socialRank?: number;
  readonly socialMomentumScore?: number;
  readonly mentions?: number;
  readonly upvotes?: number;
  readonly mentionDelta24h?: number;
  readonly rankImprovement?: number;
  readonly upvotesPerMention?: number;
}): string {
  if (
    lead.socialRank === undefined ||
    lead.socialMomentumScore === undefined ||
    lead.mentions === undefined ||
    lead.upvotes === undefined
  ) {
    return "";
  }
  const drivers = [
    `rank ${String(lead.socialRank)}`,
    `score ${String(lead.socialMomentumScore)}`,
    `${String(lead.mentions)} mention(s)`,
    `${String(lead.upvotes)} upvote(s)`,
    ...(lead.mentionDelta24h !== undefined
      ? [`24h mention delta ${String(lead.mentionDelta24h)}`]
      : []),
    ...(lead.rankImprovement !== undefined
      ? [`rank improvement ${String(lead.rankImprovement)}`]
      : []),
    ...(lead.upvotesPerMention !== undefined
      ? [`upvotes/mention ${String(lead.upvotesPerMention)}`]
      : []),
  ];
  return `Social ${drivers.join(", ")}; `;
}

function renderAlphaSearchReport(report: ResearchReport): string {
  const gaps =
    report.dataGaps.length === 0
      ? "- No material gaps identified."
      : report.dataGaps.map((gap) => `- ${markdownText(gap)}`).join("\n");
  const sources = renderSources(report);
  const leads = readAlphaSearchLeads(report.extras);
  const rejected = readAlphaSearchRejectedCandidates(report.extras);
  const coverage = renderAlphaSearchCoverage(report);
  const leadRows =
    leads.length === 0
      ? "- No Yahoo-validated research leads."
      : leads
          .map((lead) => {
            const name = lead.name === undefined ? "" : ` (${markdownText(lead.name)})`;
            const social = socialDriverText(lead);
            const sec =
              lead.recentSecFilings === undefined || lead.recentSecFilings.length === 0
                ? ""
                : `SEC filings ${lead.recentSecFilings.map((filing) => `${markdownText(filing.form)} ${markdownText(filing.filingDate)}`).join(", ")}; `;
            return `- **${markdownText(lead.symbol)}${name}:** Sources ${lead.discoverySources.map(markdownText).join(", ")}; ${social}${sec}Yahoo listed stock on ${markdownText(lead.exchange)}, $${String(lead.price)}, volume ${String(lead.volume)}, market cap ${String(lead.marketCap)}. ${sourceRefs(lead.sourceIds)}`;
          })
          .join("\n");
  const rejectedRows =
    rejected.length === 0
      ? "- No rejected candidates."
      : rejected
          .map(
            (candidate) =>
              `- **${markdownText(candidate.symbol)}:** Sources ${candidate.discoverySources.map(markdownText).join(", ")}${candidate.socialRank === undefined || candidate.socialMomentumScore === undefined ? "" : `; Social rank ${String(candidate.socialRank)}, score ${String(candidate.socialMomentumScore)}`}; ${markdownText(candidate.reason)}. ${sourceRefs(candidate.sourceIds)}`,
          )
          .join("\n");

  return [
    `# ${report.assetClass} Alpha Search Report`,
    "",
    RESEARCH_ONLY_ALPHA_SEARCH_NOTE,
    "",
    `Generated: ${report.generatedAt}`,
    `Evidence Quality: ${researchReportEvidenceQuality(report)}`,
    "",
    "## Summary",
    "",
    report.summary,
    "",
    "## Research Leads",
    "",
    leadRows,
    "",
    "## Rejected Candidates",
    "",
    rejectedRows,
    "",
    ...(coverage === "" ? [] : [coverage]),
    "## Data Gaps",
    "",
    gaps,
    "",
    "## Sources",
    "",
    sources,
    "",
  ].join("\n");
}

function renderBusinessFramework(report: ResearchReport): string {
  if (!isInstrumentJobType(report.jobType)) {
    return "";
  }
  const framework = report.extras?.businessFramework;
  if (!isRecord(framework) || !Array.isArray(framework.sections)) {
    return "";
  }
  const phase = typeof framework.phase === "string" ? framework.phase : "insufficient-data";
  const rows = framework.sections.flatMap((section) => {
    if (!isRecord(section) || typeof section.name !== "string") {
      return [];
    }
    const posture =
      section.name !== "Phase" && typeof section.posture === "string"
        ? ` (${markdownText(section.posture)})`
        : "";
    let text = "";
    const { text: sectionText, summary } = section;
    if (typeof sectionText === "string") {
      text = sectionText;
    } else if (typeof summary === "string") {
      text = summary;
    }
    if (text === "") {
      return [];
    }
    const refs = sourceRefs(knownSourceIds(report, section.sourceIds));
    return [
      `- **${markdownText(section.name)}**${posture}: ${markdownText(text)}${refs === "" ? "" : ` ${refs}`}`,
    ];
  });
  const gaps = readFrameworkGapTexts(framework.gaps).map((gap) => `- ${markdownText(gap)}`);
  return [
    "## Business Framework",
    "",
    `Phase: ${markdownText(phase)}`,
    "",
    ...rows,
    ...(gaps.length > 0 ? ["", "### Framework Data Gaps", "", ...gaps] : []),
    "",
  ].join("\n");
}

function readFrameworkGapTexts(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((gap) => {
    if (typeof gap === "string") {
      return [gap];
    }
    return isRecord(gap) && typeof gap.text === "string" ? [gap.text] : [];
  });
}

const WEB_SUBJECT_PROFILE_LABELS: Record<string, readonly [string, string][]> = {
  company: [
    ["whatItDoes", "What It Does"],
    ["howItMakesMoney", "How It Makes Money"],
    ["customers", "Customers"],
    ["geography", "Geography"],
    ["purchaseRecurrence", "Purchase Recurrence"],
    ["pricingPower", "Pricing Power"],
    ["recessionCyclicality", "Recession Cyclicality"],
    ["managementTrackRecord", "Management Track Record"],
    ["capitalAllocation", "Capital Allocation"],
    ["companyKpis", "Company-specific KPIs"],
    ["riskFactors", "Disclosed Risk Factors"],
  ],
  "crypto-asset": [
    ["whatItDoes", "What It Does"],
    ["valueAccrual", "Value Accrual"],
    ["supplyIssuance", "Supply And Issuance"],
    ["usageAdoption", "Usage And Adoption"],
    ["governanceBuilders", "Governance And Builders"],
    ["competitionMoat", "Competition And Moat"],
    ["keyRisks", "Key Risks"],
  ],
  theme: [
    ["whatItIs", "What It Is"],
    ["whyNow", "Why Now"],
    ["beneficiaries", "Beneficiaries"],
    ["headwinds", "Headwinds"],
    ["keyDebates", "Key Debates"],
    ["howItPlaysOut", "How It Plays Out"],
  ],
};

function filingBasisEntry(metrics: Readonly<Record<string, number | string>>): string | undefined {
  const { form } = metrics;
  if (form !== "10-K" && form !== "10-Q") {
    return undefined;
  }
  const filingDate = typeof metrics.filingDate === "string" ? metrics.filingDate : undefined;
  const reportDate = typeof metrics.reportDate === "string" ? metrics.reportDate : undefined;
  if (form === "10-K") {
    const filed = filingDate !== undefined ? ` filed ${filingDate}` : "";
    const period = reportDate !== undefined ? ` (period ${reportDate})` : "";
    return `10-K${filed}${period}`;
  }
  if (reportDate !== undefined) {
    return `10-Q for period ${reportDate}`;
  }
  return filingDate !== undefined ? `10-Q filed ${filingDate}` : "10-Q";
}

const PROFILE_NON_ANSWER_RE =
  /(^|\b)(not\s+(disclosed|quantified|available|provided|broken\s+out)|undisclosed|no\s+(disclosure|quantified\s+disclosure)|does\s+not\s+disclose|is\s+not\s+broken\s+out|are\s+not\s+broken\s+out)\b/iu;

function substantiveAnswerSourceIds(value: unknown): readonly string[] {
  if (!isRecord(value) || typeof value.answer !== "string") {
    return [];
  }
  const answer = value.answer.trim();
  return answer === "" || PROFILE_NON_ANSWER_RE.test(answer)
    ? []
    : readStringArray(value.sourceIds);
}

function profileAnswerSourceIds(profile: Record<string, unknown>): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const sourceId of substantiveAnswerSourceIds(profile.subjectSummary)) {
    ids.add(sourceId);
  }
  const questions = isRecord(profile.questions) ? profile.questions : {};
  for (const question of Object.values(questions)) {
    for (const sourceId of substantiveAnswerSourceIds(question)) {
      ids.add(sourceId);
    }
  }
  return ids;
}

// Renders the SEC filing basis/verification line for company profiles from the
// 10-K/10-Q filing items actually cited by the accepted profile, plus a
// Disclosure when only the annual 10-K is cited.
function companyFilingBasisLine(
  report: ResearchReport,
  profile: Record<string, unknown>,
): string | undefined {
  const citedSourceIds = profileAnswerSourceIds(profile);
  if (citedSourceIds.size === 0) {
    return undefined;
  }
  const items = (report.extendedEvidence?.items ?? []).filter(
    (item) =>
      item.category === "sec-edgar" &&
      item.sourceIds.some((sourceId) => citedSourceIds.has(sourceId)),
  );
  const entries = items.flatMap((item) =>
    item.metrics !== undefined ? [filingBasisEntry(item.metrics)] : [],
  );
  const forms = new Set(
    items.flatMap((item) => {
      const form = item.metrics?.form;
      return form === "10-K" || form === "10-Q" ? [form] : [];
    }),
  );
  const parts = entries.filter((entry): entry is string => entry !== undefined);
  if (parts.length === 0) {
    return undefined;
  }
  const disclosure =
    forms.has("10-K") && !forms.has("10-Q") ? " Current-year 10-Q unavailable." : "";
  return `**Basis:** ${parts.join("; ")}.${disclosure}`;
}

function renderWebSubjectProfile(report: ResearchReport): string {
  if (!isInstrumentJobType(report.jobType) && report.jobType !== "research") {
    return "";
  }
  const profile = report.extras?.webSubjectProfile;
  if (!isRecord(profile) || !isRecord(profile.questions)) {
    return "";
  }
  const { questions } = profile;
  const subjectKind = typeof profile.subjectKind === "string" ? profile.subjectKind : "company";
  const labels =
    WEB_SUBJECT_PROFILE_LABELS[subjectKind] ?? WEB_SUBJECT_PROFILE_LABELS.company ?? [];
  const subjectSummary = isRecord(profile.subjectSummary) ? profile.subjectSummary : undefined;
  const summary =
    subjectSummary !== undefined && typeof subjectSummary.answer === "string"
      ? [
          `${markdownText(subjectSummary.answer)}${sourceRefs(
            knownSourceIds(report, subjectSummary.sourceIds),
          )}`,
        ]
      : [];
  const rows = labels.flatMap(([key, label]) => {
    const answer = questions[key];
    if (!isRecord(answer) || typeof answer.answer !== "string" || answer.answer === "") {
      return [];
    }
    const refs = sourceRefs(knownSourceIds(report, answer.sourceIds));
    return [`- **${label}:** ${markdownText(answer.answer)}${refs === "" ? "" : ` ${refs}`}`];
  });
  const events = Array.isArray(profile.recentMaterialEvents)
    ? profile.recentMaterialEvents.flatMap((event) => {
        if (!isRecord(event) || typeof event.claim !== "string") {
          return [];
        }
        const refs = sourceRefs(knownSourceIds(report, event.sourceIds));
        return [`- ${markdownText(event.claim)}${refs === "" ? "" : ` ${refs}`}`];
      })
    : [];
  const facts = Array.isArray(profile.factLedger)
    ? profile.factLedger.flatMap((fact) => {
        if (!isRecord(fact) || typeof fact.claim !== "string") {
          return [];
        }
        const refs = sourceRefs(knownSourceIds(report, fact.sourceIds));
        return [`- ${markdownText(fact.claim)}${refs === "" ? "" : ` ${refs}`}`];
      })
    : [];
  const gaps = readStringArray(profile.openGaps).map((gap) => `- ${markdownText(gap)}`);
  if (rows.length === 0 && events.length === 0 && facts.length === 0 && gaps.length === 0) {
    return "";
  }
  const basis = subjectKind === "company" ? companyFilingBasisLine(report, profile) : undefined;
  return [
    "## Web Subject Profile",
    "",
    ...summary,
    ...(summary.length > 0 ? [""] : []),
    ...(basis !== undefined ? [basis, ""] : []),
    ...rows,
    ...(events.length > 0 ? ["", "### Recent Material Events", "", ...events] : []),
    ...(facts.length > 0 ? ["", "### Fact Ledger", "", ...facts] : []),
    ...(gaps.length > 0 ? ["", "### Profile Gaps", "", ...gaps] : []),
    "",
  ].join("\n");
}

function renderEarningsSetup(report: ResearchReport): string {
  if (!isInstrumentJobType(report.jobType)) {
    return "";
  }
  const setup = report.extras?.earningsSetup;
  if (!isRecord(setup) || !isRecord(setup.event)) {
    return "";
  }
  const { event } = setup;
  const symbol = typeof event.symbol === "string" ? event.symbol : "";
  const date = typeof event.date === "string" ? event.date : "";
  const timing = typeof event.timing === "string" ? event.timing : "unknown";
  const lines = [
    "## Earnings Setup",
    "",
    `**Event:** ${markdownText(symbol)} earnings on ${date} (timing: ${timing})`,
  ];

  if (isRecord(setup.impliedMove)) {
    const move = setup.impliedMove;
    const pct =
      typeof move.impliedMovePct === "number" ? (move.impliedMovePct * 100).toFixed(1) : "?";
    const strike = typeof move.strike === "number" ? String(move.strike) : "?";
    const expiration = typeof move.expiration === "string" ? move.expiration : "?";
    lines.push(`**Implied move:** ±${pct}% (ATM strike ${strike}, expiration ${expiration})`);
  }

  const sectionNames = {
    expectationBar: "Expectation Bar",
    qualityLandmines: "Quality Landmines",
    guidanceCredibility: "Guidance Credibility",
  } as const;
  for (const key of ["expectationBar", "qualityLandmines", "guidanceCredibility"] as const) {
    const sectionName = sectionNames[key];
    const bullets = (setup as Record<string, unknown>)[key];
    if (!Array.isArray(bullets) || bullets.length === 0) {
      continue;
    }
    lines.push("", `### ${sectionName}`, "");
    for (const bullet of bullets) {
      if (isRecord(bullet) && typeof bullet.text === "string") {
        const sids = Array.isArray(bullet.sourceIds)
          ? bullet.sourceIds.filter((sid): sid is string => typeof sid === "string")
          : [];
        lines.push(`- ${markdownText(bullet.text)}${sourceRefs(sids)}`);
      }
    }
  }

  const gaps = readStringArray(setup.gaps);
  if (gaps.length > 0) {
    lines.push("", "### Earnings Setup Gaps", "");
    for (const gap of gaps) {
      lines.push(`- ${markdownText(gap)}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

const EXTENDED_EVIDENCE_SECTION_RENDERERS: readonly ((report: ResearchReport) => string)[] = [
  renderBusinessFramework,
  renderWebSubjectProfile,
  renderExtendedEvidence,
  renderEarningsSetup,
];

function renderExtendedEvidenceSections(report: ResearchReport): readonly string[] {
  return EXTENDED_EVIDENCE_SECTION_RENDERERS.map((render) => render(report));
}

function reportTitle(report: ResearchReport): string {
  if (isInstrumentJobType(report.jobType)) {
    return `${report.symbol} ${report.assetClass} Research View`;
  }
  if (report.jobType === "research") {
    return `${report.assetClass} Thematic Research View`;
  }
  return `${report.assetClass} Market Overview`;
}

export function renderMarkdownReport(report: ResearchReport): string {
  if (report.jobType === "alpha-search") {
    return renderAlphaSearchReport(report);
  }

  const title = reportTitle(report);
  const gaps =
    report.dataGaps.length === 0
      ? "- No material gaps identified."
      : report.dataGaps.map((gap) => `- ${markdownText(gap)}`).join("\n");
  const sources = renderSources(report);

  return [
    `# ${title}`,
    "",
    RESEARCH_ONLY_NOTE,
    "",
    `Generated: ${report.generatedAt}`,
    `Evidence Quality: ${researchReportEvidenceQuality(report)}`,
    ...(report.reportIntegrity !== undefined
      ? [`Report Integrity: ${report.reportIntegrity}`]
      : []),
    ...(report.researchQuality !== undefined
      ? [`Research Quality: ${report.researchQuality}`]
      : []),
    "",
    "## Summary",
    "",
    report.summary,
    "",
    renderMarketUpdateDelta(report),
    renderFindings("Key Findings", report.keyFindings),
    renderFindings("Bull Case", report.bullCase),
    renderFindings("Bear Case", report.bearCase),
    renderFindings("Risks", report.risks),
    renderFindings("Catalysts", report.catalysts),
    renderCatalystCalendar(report),
    renderScenarios(report.scenarios),
    ...renderExtendedEvidenceSections(report),
    renderHistoricalContext(report),
    renderSpotlights(report),
    renderPredictions(report.predictions),
    "## Data Gaps",
    "",
    gaps,
    "",
    "## Sources",
    "",
    sources,
    "",
  ].join("\n");
}
