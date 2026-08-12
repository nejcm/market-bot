<script lang="ts">
  import type { Snippet } from "svelte";
  import type { RunSummary } from "../../types";
  import type { ReportDetail } from "../app-settings";
  import type { RunWorkspaceEquityPresentationView } from "../run-workspace-view";

  interface Props {
    readonly summary: RunSummary;
    readonly displayName: string;
    readonly presentation: RunWorkspaceEquityPresentationView;
    readonly reportDetail: ReportDetail;
    readonly peerSupportability?: string | undefined;
    /* The KPI strip belongs to the report sheet; other tabs carry the title
       row alone. */
    readonly showMetrics?: boolean;
    readonly citeChips: Snippet<[readonly string[]]>;
    readonly bindSection: (key: string) => (el: HTMLElement) => void;
    readonly onOpenInstrument: (assetClass: string, symbol: string) => void;
  }

  let {
    summary,
    displayName,
    presentation,
    reportDetail,
    peerSupportability,
    showMetrics = true,
    citeChips,
    bindSection,
    onOpenInstrument,
  }: Props = $props();

  const defaultView = $derived(presentation.defaultView);
  const price = $derived(defaultView.pricePerformance);

  const eyebrow = $derived(
    [
      (summary.assetClass ?? summary.jobType ?? "run").toUpperCase(),
      summary.symbol,
      defaultView.financialTrends?.rows.at(-1)?.period,
      defaultView.financialTrends?.reportingCurrency ?? price.quoteCurrency,
    ]
      .filter((part): part is string => part !== undefined && part !== "")
      .join(" · "),
  );

  /* The KPI strip carries the dated multiples the reader scans first; the dated
     basis for each stays in "Detailed equity metrics" below. */
  const kpiCells = $derived(
    reportDetail === "advanced"
      ? [
          ...presentation.advanced.keyDatedMetrics.metrics,
          ...presentation.advanced.keyDatedMetrics.foldedYahooMetrics,
        ].filter((metric) => metric.state === "available" && metric.value !== undefined)
      : [],
  );

  /* Pick the column count that leaves the fewest empty cells in the last row,
     so the strip never ends in a half-filled row. The valuation cell is +1. */
  const kpiColumns = $derived.by(() => {
    const total = kpiCells.length + 1;
    if (total <= 6) {
      return total;
    }
    const empty = (columns: number) => (columns - (total % columns)) % columns;
    return [6, 5, 4, 3].reduce((best, columns) => (empty(columns) < empty(best) ? columns : best));
  });

  /* The valuation cell closes the strip, so it absorbs whatever slots the last
     row would otherwise leave blank — at the narrow three-column layout too. */
  const tailSpan = (columns: number) =>
    ((columns - ((kpiCells.length + 1) % columns)) % columns) + 1;
  const kpiTailSpan = $derived(tailSpan(kpiColumns));
  const kpiTailSpanNarrow = $derived(tailSpan(3));
</script>

<!-- verdict bar -->
<div
  {@attach bindSection("equityOverview")}
  class="flex scroll-mt-24 flex-wrap items-end gap-x-7 gap-y-4 px-4 sm:px-7 pb-4.5 pt-5.5 {showMetrics
    ? 'border-b border-border'
    : ''}"
>
  <!-- The name owns the first line on narrow viewports; price and the stat
       cluster wrap beneath it instead of squeezing it to a column. -->
  <div class="flex w-full min-w-0 flex-col gap-1.5 lg:w-auto lg:flex-1">
    <div class="font-mono text-[11px] tracking-[0.14em] text-muted-foreground">{eyebrow}</div>
    <div class="flex flex-wrap items-baseline gap-3">
      <h1 class="font-serif text-[34px] font-semibold leading-none text-foreground">
        {displayName}
      </h1>
      {#if summary.assetClass !== undefined && summary.symbol !== undefined}
        <button
          class="border border-[#bcd7d8] bg-accent px-1.5 py-0.5 font-mono text-[11px] text-primary transition hover:border-[#9fc2c8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          type="button"
          onclick={() => onOpenInstrument(summary.assetClass ?? "", summary.symbol ?? "")}
        >
          {summary.assetClass}:{summary.symbol}
        </button>
      {/if}
    </div>
  </div>
  <div class="flex w-full flex-col gap-1 text-left lg:w-auto lg:text-right">
    <div class="font-mono text-[28px] font-medium leading-none text-foreground">
      {price.price ?? "Unavailable"}
    </div>
    <div
      class="font-mono text-xs {price.changeDirection === 'positive'
        ? 'text-[#2f7a4d]'
        : price.changeDirection === 'negative'
          ? 'text-[#a8382f]'
          : 'text-muted-foreground'}"
    >
      {price.change24h ?? "24h unavailable"} · last session
    </div>
  </div>
  <div class="hidden h-11 w-px bg-border lg:block"></div>
  {#each [{ value: summary.confidence ?? "—", label: "Evidence quality" }, { value: String(summary.sourceCount), label: "Sources" }, { value: String(summary.availableFiles.length), label: "Files" }] as stat}
    <div class="flex flex-col gap-1">
      <div class="font-mono text-[13px] text-foreground">{stat.value}</div>
      <div class="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        {stat.label}
      </div>
    </div>
  {/each}
</div>

{#if showMetrics}
  <!-- KPI strip -->
  <div
    class="grid grid-cols-2 border-b border-border bg-secondary sm:grid-cols-3 lg:[grid-template-columns:repeat(var(--kpi-columns),minmax(0,1fr))]"
    style="--kpi-columns:{kpiColumns}"
  >
    {#each kpiCells as metric}
      <div class="flex flex-col gap-1.25 border-b border-r border-[#e4e0d6] px-4.5 py-3.5">
        <div class="text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
          {metric.label}
        </div>
        <!-- The dated basis and source chips for each metric stay in
             "Detailed equity metrics" so the strip reads as one line of numbers. -->
        <div class="font-mono text-[17px] text-foreground">{metric.value}</div>
      </div>
    {/each}
    <!-- The position label and the "context only, not a target price"
         disclosure stay as the cell tooltip so the strip keeps one row height;
         the peer implied range section spells both out. -->
    <div
      class="col-span-2 flex flex-col gap-1.25 border-b border-[#e4e0d6] bg-[#fbf4e4] px-4.5 py-3.5 sm:col-[span_var(--kpi-tail-span-narrow)] lg:col-[span_var(--kpi-tail-span)]"
      style="--kpi-tail-span:{kpiTailSpan}; --kpi-tail-span-narrow:{kpiTailSpanNarrow}"
      title={defaultView.valuationContext.disclosure}
    >
      <div class="text-[9px] uppercase tracking-[0.14em] text-[#a86b1f]">
        {defaultView.valuationContext.label}
      </div>
      <div class="font-mono text-[13px] text-[#a86b1f]">
        {peerSupportability ?? defaultView.valuationContext.display}
      </div>
      <!-- Peer ranges cite every comparable, so the chip list scrolls instead of
           pushing the strip out of proportion. -->
      <div class="max-h-9 overflow-y-auto">
        {@render citeChips(defaultView.valuationContext.sourceIds)}
      </div>
    </div>
  </div>
{/if}
