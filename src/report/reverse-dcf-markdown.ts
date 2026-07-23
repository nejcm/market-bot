import type { ReverseDcfArtifact } from "../sources/extended-evidence/reverse-dcf";

function formatAmount(value: number, currency: string): string {
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value)} ${currency}`;
}

function renderComputed(artifact: Extract<ReverseDcfArtifact, { status: "computed" }>): string {
  const { assumptions } = artifact;
  const headers = assumptions.terminalGrowthRatesPct
    .map((rate) => `${rate.toFixed(0)}%`)
    .join(" | ");
  const separator = assumptions.terminalGrowthRatesPct.map(() => "---:").join(" | ");
  const rows = artifact.grid.rows
    .map((row) => {
      const cells = row.cells
        .map((cell) =>
          cell.status === "solved"
            ? `${cell.solvedFiveYearFcfGrowthPct.toFixed(2)}%`
            : "not solved",
        )
        .join(" | ");
      return `| ${row.discountRatePct.toFixed(0)}% | ${cells} |`;
    })
    .join("\n");

  return [
    "\n\n## Reverse DCF Input Sensitivity",
    "",
    "The cells report the five-year FCF growth input that reconciles each disclosed discount-rate and terminal-growth assumption pair.",
    "",
    "### Assumptions",
    "",
    `- Starting FCF: ${formatAmount(assumptions.startingFcf.value, assumptions.startingFcf.currency)}; period ended ${assumptions.startingFcf.periodEnd}; public ${assumptions.startingFcf.publicAt}.`,
    `- Enterprise value: ${formatAmount(assumptions.enterpriseValue.value, assumptions.enterpriseValue.currency)}; observed ${assumptions.enterpriseValue.observedAt}.`,
    `- Horizon: ${assumptions.horizonYears} years.`,
    `- Discount rates: ${assumptions.discountRatesPct[0]}%–${assumptions.discountRatesPct.at(-1)}%.`,
    `- Terminal growth rates: ${assumptions.terminalGrowthRatesPct[0]}%–${assumptions.terminalGrowthRatesPct.at(-1)}%.`,
    "",
    "### Solved Five-Year FCF Growth Grid",
    "",
    `| Discount rate \\ Terminal growth | ${headers} |`,
    `| ---: | ${separator} |`,
    rows,
  ].join("\n");
}

export function renderReverseDcfMarkdown(artifact: ReverseDcfArtifact | undefined): string {
  if (artifact === undefined) {
    return "";
  }
  if (artifact.status === "suppressed") {
    return [
      "\n\n## Reverse DCF Input Sensitivity",
      "",
      `Suppressed (${artifact.reason}): ${artifact.detail}`,
    ].join("\n");
  }
  return renderComputed(artifact);
}
