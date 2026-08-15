import { isInstrumentJobType, type ResearchReport } from "../domain/types";
import { isRecord } from "../guards";
import {
  readBusinessFrameworkExtra,
  readWebSubjectProfileExtra,
  webSubjectProfileQuestionKeys,
  type WebSubjectProfileAnswerValue,
  type WebSubjectProfileExtraValue,
  type WebSubjectProfileFactValue,
} from "./report-extras-contract";
import type { WebSubjectProfileQuestionKey } from "../web-evidence/contract";
import { citedSourceIds, markdownText, readStringArray, sourceRefs } from "./markdown-primitives";

export function renderBusinessFramework(report: ResearchReport): string {
  if (!isInstrumentJobType(report.jobType)) {
    return "";
  }
  const framework = readBusinessFrameworkExtra(report.extras?.businessFramework);
  // A framework without a `sections` array has no section to render — distinct
  // From one whose sections parsed to none, which still gets the header.
  if (framework?.sections === undefined) {
    return "";
  }
  const rows = framework.sections.flatMap((section) => {
    const { name } = section;
    // A nameless section is unrenderable, but its sources are still cited by
    // CollectReportSourceIds — which is why the reader keeps the row.
    if (name === undefined) {
      return [];
    }
    // Render policy, not parsing: the equity reader already covers these three.
    if (
      report.jobType === "equity" &&
      report.assetClass === "equity" &&
      ["business", "phase", "growth"].includes(name.trim().toLowerCase())
    ) {
      return [];
    }
    const posture =
      name !== "Phase" && section.posture !== undefined
        ? ` (${markdownText(section.posture)})`
        : "";
    const text = section.text ?? section.summary ?? "";
    if (text === "") {
      return [];
    }
    const refs = sourceRefs(citedSourceIds(report, section));
    return [
      `- **${markdownText(name)}**${posture}: ${markdownText(text)}${refs === "" ? "" : ` ${refs}`}`,
    ];
  });
  // Render policy: gap codes are dropped, only the text is shown.
  const gaps = framework.gaps.map(
    (gap) => `- ${markdownText(typeof gap === "string" ? gap : gap.text)}`,
  );
  return [
    "## Business Framework",
    "",
    `Phase: ${markdownText(framework.phase ?? "insufficient-data")}`,
    "",
    ...rows,
    ...(gaps.length > 0 ? ["", "### Framework Data Gaps", "", ...gaps] : []),
    "",
  ].join("\n");
}

// Title Case labels are markdown-specific; only the key order is shared, via
// The contract's webSubjectProfileQuestionKeys. Exhaustiveness is compiler-enforced.
const WEB_SUBJECT_PROFILE_LABELS: Readonly<Record<WebSubjectProfileQuestionKey, string>> = {
  whatItDoes: "What It Does",
  howItMakesMoney: "How It Makes Money",
  customers: "Customers",
  geography: "Geography",
  purchaseRecurrence: "Purchase Recurrence",
  pricingPower: "Pricing Power",
  recessionCyclicality: "Recession Cyclicality",
  managementTrackRecord: "Management Track Record",
  capitalAllocation: "Capital Allocation",
  companyKpis: "Company-specific KPIs",
  riskFactors: "Disclosed Risk Factors",
  valueAccrual: "Value Accrual",
  supplyIssuance: "Supply And Issuance",
  usageAdoption: "Usage And Adoption",
  governanceBuilders: "Governance And Builders",
  competitionMoat: "Competition And Moat",
  keyRisks: "Key Risks",
  whatItIs: "What It Is",
  whyNow: "Why Now",
  beneficiaries: "Beneficiaries",
  headwinds: "Headwinds",
  keyDebates: "Key Debates",
  howItPlaysOut: "How It Plays Out",
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

function substantiveAnswerSourceIds(
  value: WebSubjectProfileAnswerValue | undefined,
): readonly string[] {
  const answer = value?.answer?.trim() ?? "";
  if (answer === "" || PROFILE_NON_ANSWER_RE.test(answer) || value?.sourceIdsComplete !== true) {
    return [];
  }
  return value.sourceIds;
}

function profileAnswerSourceIds(profile: WebSubjectProfileExtraValue): ReadonlySet<string> {
  return new Set([
    ...substantiveAnswerSourceIds(profile.subjectSummary),
    ...Object.values(profile.questions ?? {}).flatMap((question) =>
      substantiveAnswerSourceIds(question),
    ),
  ]);
}

// Renders the SEC filing basis/verification line for company profiles from the
// 10-K/10-Q filing items actually cited by the accepted profile, plus a
// Disclosure when only the annual 10-K is cited.
function companyFilingBasisLine(
  report: ResearchReport,
  profile: WebSubjectProfileExtraValue,
): string | undefined {
  const answerSourceIds = profileAnswerSourceIds(profile);
  if (answerSourceIds.size === 0) {
    return undefined;
  }
  const items = (report.extendedEvidence?.items ?? []).filter(
    (item) =>
      item.category === "sec-edgar" &&
      item.sourceIds.some((sourceId) => answerSourceIds.has(sourceId)),
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

export function renderWebSubjectProfile(report: ResearchReport): string {
  if (!isInstrumentJobType(report.jobType) && report.jobType !== "research") {
    return "";
  }
  const profile = readWebSubjectProfileExtra(report.extras?.webSubjectProfile);
  // No `questions` record at all means no profile section, unlike an empty one.
  if (profile?.questions === undefined) {
    return "";
  }
  const { questions, subjectSummary } = profile;
  const subjectKind = profile.subjectKind ?? "company";
  // The wrapper falls back to the company key order for unknown kinds, so
  // Identity against the company order == "company or unknown kind".
  const questionKeys = webSubjectProfileQuestionKeys(subjectKind);
  const usesCompanyLabels = questionKeys === webSubjectProfileQuestionKeys("company");
  const trimEquityReaderDuplicates =
    report.jobType === "equity" && report.assetClass === "equity" && usesCompanyLabels;
  // Empty answers are suppressed here and per question below.
  const summary =
    !trimEquityReaderDuplicates &&
    subjectSummary?.answer !== undefined &&
    subjectSummary.answer !== ""
      ? [
          `${markdownText(subjectSummary.answer)}${sourceRefs(
            citedSourceIds(report, subjectSummary),
          )}`,
        ]
      : [];
  const rows = questionKeys.flatMap((key) => {
    const answer = questions[key];
    if (answer?.answer === undefined || answer.answer === "") {
      return [];
    }
    const refs = sourceRefs(citedSourceIds(report, answer));
    return [
      `- **${WEB_SUBJECT_PROFILE_LABELS[key]}:** ${markdownText(answer.answer)}${refs === "" ? "" : ` ${refs}`}`,
    ];
  });
  const factRows = (rowsIn: readonly WebSubjectProfileFactValue[]): readonly string[] =>
    rowsIn.flatMap((row) => {
      if (row.claim === undefined) {
        return [];
      }
      const refs = sourceRefs(citedSourceIds(report, row));
      return [`- ${markdownText(row.claim)}${refs === "" ? "" : ` ${refs}`}`];
    });
  const events = factRows(profile.recentMaterialEvents);
  const facts = trimEquityReaderDuplicates ? [] : factRows(profile.factLedger);
  const gaps = (profile.openGapsComplete ? profile.openGaps : []).map(
    (gap) => `- ${markdownText(gap)}`,
  );
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

export function renderEarningsSetup(report: ResearchReport): string {
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
  const eventDateStatus = event.eventDateStatus ?? event.dateStatus;
  const isProviderEstimated = eventDateStatus === "provider-estimated";
  const confirmationSourceId =
    isRecord(event.dateConfirmation) && typeof event.dateConfirmation.sourceId === "string"
      ? event.dateConfirmation.sourceId
      : undefined;
  let certaintyLabel = "";
  if (isProviderEstimated) {
    certaintyLabel = " — date provider-estimated (Finnhub), unconfirmed";
  } else if (eventDateStatus === "issuer-confirmed") {
    certaintyLabel = ` — date issuer-confirmed${confirmationSourceId === undefined ? "" : ` [${markdownText(confirmationSourceId)}]`}`;
  } else if (eventDateStatus === "exchange-confirmed") {
    certaintyLabel = ` — date exchange-confirmed${confirmationSourceId === undefined ? "" : ` [${markdownText(confirmationSourceId)}]`}`;
  }
  const lines = [
    "## Earnings Setup",
    "",
    `**Event:** ${markdownText(symbol)} earnings on ${date} (timing: ${timing})${certaintyLabel}`,
  ];

  if (typeof event.epsEstimate === "number") {
    lines.push(
      `**EPS estimate:** ${String(event.epsEstimate)} — single-provider snapshot (Finnhub)`,
    );
  }
  if (typeof event.revenueEstimate === "number") {
    lines.push(
      `**Revenue estimate:** ${event.revenueEstimate.toLocaleString("en-US")} — single-provider snapshot (Finnhub)`,
    );
  }

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
