<script lang="ts">
  import type { Snippet } from "svelte";
  import type { RunSummary } from "../../types";
  import type { ReportDetail } from "../app-settings";
  import { formatDate, type SnapshotView } from "../view-model";
  import type { SourceView } from "../../report-artifact-view";
  import type {
    RunWorkspaceCaseKey,
    RunWorkspaceCaseSection,
    RunWorkspaceEquityPresentationView,
    RunWorkspaceTableOfContentsEntry,
  } from "../run-workspace-view";
  import type { FinancialLensPosture } from "../../../src/sources/extended-evidence/financial-lens";
  import MarketSnapshot from "./market-snapshot.svelte";

  interface Props {
    readonly summary: RunSummary;
    readonly displayName: string;
    readonly presentation: RunWorkspaceEquityPresentationView;
    readonly reportDetail: ReportDetail;
    readonly caseSections: readonly RunWorkspaceCaseSection[];
    readonly sourceItems: readonly SourceView[];
    readonly snapshot?: SnapshotView;
    readonly snapshotTradingViewUrl?: string;
    readonly forecastHorizons: readonly number[];
    readonly peerSupportability?: string;
    readonly tocEntries: readonly RunWorkspaceTableOfContentsEntry[];
    readonly citeChips: Snippet<[readonly string[]]>;
    readonly bindSection: (key: string) => (el: HTMLElement) => void;
    readonly onScrollToSection: (key: string) => void;
    readonly onOpenInstrument: (assetClass: string, symbol: string) => void;
    // Report sections that belong inside the sheet, so the section nav stays
    // sticky over them.
    readonly children?: Snippet;
  }

  let {
    summary,
    displayName,
    presentation,
    reportDetail,
    caseSections,
    sourceItems,
    snapshot,
    snapshotTradingViewUrl,
    forecastHorizons,
    peerSupportability,
    tocEntries,
    citeChips,
    bindSection,
    onScrollToSection,
    onOpenInstrument,
    children,
  }: Props = $props();

  const CASE_TONES: Readonly<Record<RunWorkspaceCaseKey, string>> = {
    bullCase: "#2f7a4d",
    bearCase: "#a8382f",
    catalysts: "#14707a",
    risks: "#a86b1f",
  };
  const POSTURE_TONES: Readonly<Record<FinancialLensPosture, string>> = {
    "criteria-supported": "#2f7a4d",
    "criteria-mixed": "#a86b1f",
    "criteria-not-supported": "#a8382f",
    "insufficient-data": "#8b8579",
  };
  const SOURCE_KIND_LABELS: Readonly<Record<string, string>> = {
    "market-data": "Market data",
    news: "News",
    model: "Model",
    "extended-evidence": "Filings & fundamentals",
    "market-context": "Market context",
    discussion: "Discussion",
    reference: "Reference",
    web: "Web",
  };

  const isAdvanced = $derived(reportDetail === "advanced");
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

  // The KPI strip carries the dated multiples the reader scans first; the dated
  // basis for each stays in "Detailed equity metrics" below.
  const kpiCells = $derived(
    isAdvanced
      ? [
          ...presentation.advanced.keyDatedMetrics.metrics,
          ...presentation.advanced.keyDatedMetrics.foldedYahooMetrics,
        ].filter((metric) => metric.state === "available" && metric.value !== undefined)
      : [],
  );

  // Pick the column count that leaves the fewest empty cells in the last row,
  // so the strip never ends in a half-filled row. The valuation cell is +1.
  const kpiColumns = $derived.by(() => {
    const total = kpiCells.length + 1;
    if (total <= 6) {
      return total;
    }
    const empty = (columns: number) => (columns - (total % columns)) % columns;
    return [6, 5, 4, 3].reduce((best, columns) => (empty(columns) < empty(best) ? columns : best));
  });

  // The valuation cell closes the strip, so it absorbs whatever slots the last
  // row would otherwise leave blank.
  const kpiTailSpan = $derived(
    ((kpiColumns - ((kpiCells.length + 1) % kpiColumns)) % kpiColumns) + 1,
  );

  const coverageRows = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const source of sourceItems) {
      const kind = source.kind ?? "reference";
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([kind, count]) => ({
        label: SOURCE_KIND_LABELS[kind] ?? `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`,
        count,
      }))
      .toSorted((left, right) => right.count - left.count);
  });

  // Chevrons page the section strip; holding the pointer over one keeps it
  // scrolling until the edge, where the button disables itself.
  const NUDGE_PX = 110;
  const HOLD_INTERVAL_MS = 280;
  let navEl: HTMLElement | undefined = undefined;
  let atStart = $state(true);
  let atEnd = $state(false);
  let scrollTimer: ReturnType<typeof setInterval> | undefined = undefined;

  function updateEdges(): void {
    if (navEl === undefined) {
      return;
    }
    atStart = navEl.scrollLeft <= 1;
    atEnd = navEl.scrollLeft + navEl.clientWidth >= navEl.scrollWidth - 1;
  }

  function nudge(direction: number): void {
    navEl?.scrollBy({ left: direction * NUDGE_PX, behavior: "smooth" });
    updateEdges();
  }

  function stopScroll(): void {
    if (scrollTimer !== undefined) {
      clearInterval(scrollTimer);
      scrollTimer = undefined;
    }
  }

  function startScroll(direction: number): void {
    stopScroll();
    scrollTimer = setInterval(() => nudge(direction), HOLD_INTERVAL_MS);
  }

  $effect(() => stopScroll);

  const railCases = $derived(
    caseSections.map((section) => ({
      ...section,
      tone: CASE_TONES[section.key],
      sourceCount: new Set(section.items.flatMap((item) => item.sourceIds)).size,
    })),
  );
</script>

{#snippet railHeading(label: string, tone: string, meta: string)}
  <div class="mb-3 flex items-baseline justify-between gap-2">
    <div class="text-[10px] font-semibold uppercase tracking-[0.16em]" style="color: {tone}">
      {label}
    </div>
    {#if meta !== ""}
      <div class="font-mono text-[10px] text-[#a09a8d]">{meta}</div>
    {/if}
  </div>
{/snippet}

{#snippet columnHeading(label: string, meta: string)}
  <div class="mb-3.5 flex flex-wrap items-baseline justify-between gap-2">
    <div class="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
      {label}
    </div>
    {#if meta !== ""}
      <div class="font-mono text-[10px] text-[#a09a8d]">{meta}</div>
    {/if}
  </div>
{/snippet}

<div class="ledger-sheet border border-border bg-card shadow-[0_1px_0_#e4e0d6]">
  <!-- verdict bar -->
  <div
    {@attach bindSection("equityOverview")}
    class="flex scroll-mt-24 flex-wrap items-end gap-x-7 gap-y-4 border-b border-border px-7 pb-4.5 pt-5.5"
  >
    <div class="flex min-w-0 flex-1 flex-col gap-1.5">
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
    <div class="flex flex-col gap-1 text-right">
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
    <div class="hidden h-11 w-px bg-border sm:block"></div>
    {#each [{ value: summary.confidence ?? "—", label: "Evidence quality" }, { value: String(summary.sourceCount), label: "Sources" }, { value: String(summary.availableFiles.length), label: "Files" }] as stat}
      <div class="flex flex-col gap-1">
        <div class="font-mono text-[13px] text-foreground">{stat.value}</div>
        <div class="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          {stat.label}
        </div>
      </div>
    {/each}
  </div>

  <!-- KPI strip -->
  <div
    class="grid grid-cols-2 border-b border-border bg-secondary sm:[grid-template-columns:repeat(var(--kpi-columns),minmax(0,1fr))]"
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
      class="flex flex-col gap-1.25 border-b border-[#e4e0d6] bg-[#fbf4e4] px-4.5 py-3.5 sm:[grid-column:span_var(--kpi-tail-span)]"
      style="--kpi-tail-span:{kpiTailSpan}"
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

  <!-- section navigation -->
  <div class="sticky top-11 z-20 flex items-stretch border-b border-border bg-card">
    <button
      class="shrink-0 px-3 font-mono text-sm text-[#6f6b62] transition hover:bg-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-25 disabled:hover:bg-transparent"
      type="button"
      aria-label="Scroll sections left"
      disabled={atStart}
      onclick={() => nudge(-1)}
      onmouseenter={() => startScroll(-1)}
      onmouseleave={stopScroll}
    >
      ‹
    </button>
    <aside
      {@attach (el) => {
        navEl = el;
        updateEdges();
      }}
      class="flex flex-1 items-center gap-x-1 overflow-x-auto px-2"
      aria-label="On this page"
      onscroll={updateEdges}
    >
      {#each tocEntries as entry}
        <button
          class="shrink-0 px-2 py-3 font-mono text-[10px] uppercase tracking-[0.08em] text-[#6f6b62] transition hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          type="button"
          onclick={() => onScrollToSection(entry.key)}
        >
          {entry.label}
        </button>
      {/each}
    </aside>
    <button
      class="shrink-0 px-3 font-mono text-sm text-[#6f6b62] transition hover:bg-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-25 disabled:hover:bg-transparent"
      type="button"
      aria-label="Scroll sections right"
      disabled={atEnd}
      onclick={() => nudge(1)}
      onmouseenter={() => startScroll(1)}
      onmouseleave={stopScroll}
    >
      ›
    </button>
  </div>

  <div class="grid xl:grid-cols-[minmax(0,1fr)_372px]">
    <!-- left column -->
    <div class="min-w-0 border-border xl:border-r">
      <section
        {@attach bindSection("summary")}
        class="scroll-mt-24 border-b border-[#e4e0d6] px-7 pb-5.5 pt-6.5"
      >
        {@render columnHeading("Company summary", "")}
        <div class="font-serif text-[19px] leading-[1.5] text-[#26241f]">
          {defaultView.companySummary.text}
          {@render citeChips(defaultView.companySummary.sourceIds)}
        </div>
      </section>

      {#if defaultView.financialTrends !== undefined}
        <section
          {@attach bindSection("financialTrends")}
          class="scroll-mt-24 border-b border-[#e4e0d6] px-7 pb-5 pt-6"
        >
          {@render columnHeading(
            "Financial trends",
            `${defaultView.financialTrends.reportingCurrency ?? "currency unavailable"} · FCF proxy`,
          )}
          <div class="overflow-x-auto">
            <table class="w-full min-w-125 border-collapse font-mono text-[12.5px]">
              <thead>
                <tr>
                  {#each defaultView.financialTrends.columns as column, index}
                    <th
                      class="border-b border-[#cfcabd] pb-2 font-sans text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground {index ===
                      0
                        ? 'text-left'
                        : 'text-right'}"
                    >
                      {column}
                    </th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each defaultView.financialTrends.rows as row, index}
                  {@const isLatest = index === (defaultView.financialTrends?.rows.length ?? 0) - 1}
                  <tr class={isLatest ? "font-bold text-foreground" : "text-[#26241f]"}>
                    <td
                      class="py-2.25 {isLatest
                        ? ''
                        : 'border-b border-[#e9e5db] text-[#6f6b62]'}"
                    >
                      {row.period}
                    </td>
                    {#each [row.revenue, row.netIncome, row.operatingMargin, row.freeCashFlow] as cell}
                      <td
                        class="py-2.25 text-right {isLatest ? '' : 'border-b border-[#e9e5db]'}"
                      >
                        {cell}
                      </td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {@render citeChips(defaultView.financialTrends.sourceIds)}
        </section>
      {/if}

      {#if defaultView.findings.length > 0}
        <section
          {@attach bindSection("findings")}
          class="scroll-mt-24 border-b border-[#e4e0d6] px-7 pb-5.5 pt-6"
        >
          {@render columnHeading("Key findings", "")}
          <div class="flex flex-col gap-3.5">
            {#each defaultView.findings as item, index}
              <div
                class="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-3.5 {index === 0
                  ? ''
                  : 'border-t border-[#e9e5db] pt-3.5'}"
              >
                <span class="font-mono text-[11px] text-[#b3ada0]">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div class="min-w-0">
                  <span class="font-serif text-[15.5px] leading-[1.5] text-[#26241f]">
                    {item.text}
                  </span>
                  {@render citeChips(item.sourceIds)}
                </div>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      {#if snapshot !== undefined}
        <div class="scroll-mt-24 px-7 pb-6 pt-3">
          <MarketSnapshot
            {snapshot}
            {...(snapshotTradingViewUrl === undefined ? {} : { snapshotTradingViewUrl })}
            {forecastHorizons}
            sectionKey="snapshot"
            {bindSection}
          />
        </div>
      {/if}
    </div>

    <!-- right rail -->
    <div class="bg-secondary">
      {#if isAdvanced}
        <div class="border-b border-[#e4e0d6] px-5.5 pb-4.5 pt-5.5">
          {@render railHeading(
            presentation.advanced.financialLensDrivers.postures.label,
            "#8b8579",
            "",
          )}
          <div class="flex flex-col gap-2.5">
            {#each presentation.advanced.financialLensDrivers.postures.items as posture}
              <div>
                <div class="flex items-center justify-between gap-2.5">
                  <span class="font-serif text-sm text-[#26241f]">{posture.lens}</span>
                  <span
                    class="font-mono text-[10px]"
                    style="color: {POSTURE_TONES[posture.posture]}"
                  >
                    {posture.postureLabel.toLowerCase()}
                  </span>
                </div>
                <div
                  class="mt-1.5 h-0.75"
                  style="background: {POSTURE_TONES[posture.posture]}"
                  aria-hidden="true"
                ></div>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      {#if railCases.length > 0}
        <div {@attach bindSection("cases")} class="scroll-mt-24">
          {#each railCases as section}
            <div class="border-b border-[#e4e0d6] px-5.5 pb-4.5 pt-5.5">
              {@render railHeading(
                section.title,
                section.tone,
                `${String(section.items.length)} claims · ${String(section.sourceCount)} src`,
              )}
              <div class="flex flex-col gap-2.5">
                {#each section.items as item}
                  <div
                    class="border-l-2 pl-3 font-serif text-[14.5px] leading-[1.5] text-[#26241f]"
                    style="border-color: {section.tone}"
                  >
                    {item.text}
                    {@render citeChips(item.sourceIds)}
                  </div>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      {/if}

      <div class="px-5.5 pb-6 pt-5.5">
        {@render railHeading("Evidence coverage", "#8b8579", "")}
        <div class="flex flex-col gap-2 font-mono text-[11px] text-[#6f6b62]">
          {#each coverageRows as row}
            <div class="flex justify-between gap-3">
              <span>{row.label}</span>
              <span class="text-foreground">{row.count}</span>
            </div>
          {/each}
          <div class="flex justify-between gap-3 border-t border-[#dfdbd1] pt-2">
            <span>Material gaps</span>
            <span class={defaultView.materialGaps.length === 0 ? "text-foreground" : "text-[#a86b1f]"}>
              {defaultView.materialGaps.length}
            </span>
          </div>
          {#if defaultView.financialCoreStatus !== undefined}
            <div class="flex justify-between gap-3">
              <span>Financial core</span>
              <span class="text-foreground">{defaultView.financialCoreStatus}</span>
            </div>
          {/if}
        </div>
      </div>
    </div>
  </div>

  {#if children !== undefined}
    <div class="border-t border-border px-7 pb-7 pt-6">
      {@render children()}
    </div>
  {/if}

  <!-- Colophon: run and quote provenance closes the sheet instead of crowding
       the verdict bar. -->
  <div
    class="border-t border-border bg-secondary px-7 py-2.5 font-mono text-[10px] text-[#a09a8d]"
  >
    run {formatDate(summary.generatedAt)} ·
    {#if price.priceAsOf !== undefined}
      {price.priceAsOf.kind === "quote-time" ? "Quote time" : "Fetch time"} · {price.priceAsOf
        .instant}
    {:else}
      Price time unavailable
    {/if}
    {@render citeChips(price.sourceIds)}
  </div>
</div>
