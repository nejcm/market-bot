<script lang="ts">
  import { Skeleton } from "$lib/components/ui/skeleton";
  import type { RunDetail } from "../../types";
  import {
    formatDate,
    jsonBlock,
    runLabel,
    formatShortfallGap,
    valuationMetricTiles,
    type FinancialLensStatTone,
  } from "../view-model";
  import {
    buildRunWorkspaceView,
    completenessReasonCodeLabel,
    type RunWorkspaceCaseKey,
  } from "../run-workspace-view";
  import { DATA_SEGMENTS, TABS, type DataSegment, type Tab } from "./console-types";
  import PriceSnapshotChart from "./price-snapshot-chart.svelte";
  import SparklineBars from "./sparkline-bars.svelte";
  import RangeBar from "./range-bar.svelte";
  import RunChat from "./run-chat.svelte";
  import ObservableForecasts from "./observable-forecasts.svelte";
  import WebSubjectProfile from "./web-subject-profile.svelte";
  import BusinessFramework from "./business-framework.svelte";

  interface Props {
    readonly activeTab: Tab;
    readonly detail: RunDetail | null;
    readonly loadingDetail: boolean;
    readonly selectedFile: string;
    readonly fileContent: string;
    readonly highlightSourceId: string;
    readonly onTabChange: (tab: Tab) => void;
    readonly onLoadFile: (path: string) => void;
    readonly onGoHome: () => void;
    readonly onHighlightSource: (sourceId: string) => void;
    readonly onOpenInstrument: (assetClass: string, symbol: string) => void;
  }

  let {
    activeTab,
    detail,
    loadingDetail,
    selectedFile,
    fileContent,
    highlightSourceId,
    onTabChange,
    onLoadFile,
    onGoHome,
    onHighlightSource,
    onOpenInstrument,
  }: Props = $props();

  interface CitePopover {
    readonly id: string;
    readonly title: string;
    readonly kind: string;
    readonly provider: string;
    readonly x: number;
    readonly y: number;
  }

  const POPOVER_WIDTH = 290;
  const POPOVER_MARGIN = 150;

  let dataSegment = $state<DataSegment>("analytics");
  let cite = $state<CitePopover | null>(null);
  const sectionEls: Partial<Record<string, HTMLElement>> = {};

  const workspace = $derived(detail === null ? undefined : buildRunWorkspaceView(detail));
  const equityPresentation = $derived(workspace?.equityPresentation);
  const reportSummary = $derived(
    equityPresentation?.advanced.reportSummary ?? workspace?.report.summary ?? "",
  );
  const reportSummarySectionKey = $derived(
    equityPresentation === undefined ? "summary" : "advancedSummary",
  );
  const reportFindingsSectionKey = $derived(
    equityPresentation === undefined ? "findings" : "advancedFindings",
  );
  const reportMarkdown = $derived(workspace?.report.markdown);
  const findingItems = $derived(workspace?.report.findings ?? []);
  const scenarioItems = $derived(workspace?.report.scenarios ?? []);
  const forecastItems = $derived(workspace?.forecasts.items ?? []);
  const groupedForecastItems = $derived(workspace?.forecasts.groups ?? []);
  const forecastStats = $derived(
    workspace?.forecasts.stats ?? {
      total: 0,
      resolved: 0,
      hits: 0,
      misses: 0,
      voided: 0,
      pending: 0,
    },
  );
  const forecastHorizons = $derived(workspace?.forecasts.horizons ?? []);
  const sourceItems = $derived(workspace?.sources.items ?? []);
  const splitGaps = $derived(
    workspace?.gaps ?? { shortfalls: [], otherGaps: [], triagedGaps: [] },
  );
  const advancedTriagedGaps = $derived(
    equityPresentation === undefined
      ? splitGaps.triagedGaps
      : splitGaps.triagedGaps.filter((gap) => gap.triage === "diagnostic"),
  );
  const extendedEvidence = $derived(workspace?.evidence.extendedItems ?? []);
  const businessFramework = $derived(workspace?.evidence.businessFramework);
  const webSubjectProfile = $derived(workspace?.evidence.webSubjectProfile);
  const financialLensGroups = $derived(workspace?.report.financialLensGroups ?? []);
  const fundamentalHistory = $derived(workspace?.fundamentalHistory);
  const valuationWorkbench = $derived(workspace?.valuationWorkbench);
  const reverseDcf = $derived(workspace?.reverseDcf);
  const appendixCompleteness = $derived(equityPresentation?.advanced.completeness);
  const peerImpliedRange = $derived(workspace?.peerImpliedRange);
  const targetHealth = $derived(workspace?.forecasts.targetHealth);
  const historicalAudit = $derived(workspace?.evidence.historicalContext);
  const showForecastsSection = $derived(workspace?.forecasts.visible ?? false);
  const showGapsSection = $derived(workspace?.gaps.visible ?? false);
  const snapshot = $derived(workspace?.snapshot?.value);
  const snapshotTradingViewUrl = $derived(workspace?.snapshot?.tradingViewUrl);

  const CASE_STYLES: Readonly<Record<RunWorkspaceCaseKey, { readonly edge: string; readonly fg: string }>> = {
    bullCase: { edge: "#0F9D58", fg: "#0F9D58" },
    bearCase: { edge: "#9B0F06", fg: "#9B0F06" },
    risks: { edge: "#c4b389", fg: "#8a6116" },
    catalysts: { edge: "#9fc2c8", fg: "#166e7d" },
  };

  const caseSections = $derived(
    (workspace?.report.cases ?? []).map((section) => ({
      ...section,
      ...CASE_STYLES[section.key],
    })),
  );
  const defaultCaseSections = $derived(
    caseSections.filter((section) => section.key === "catalysts" || section.key === "risks"),
  );
  const advancedCaseSections = $derived(
    equityPresentation === undefined
      ? caseSections
      : caseSections.filter((section) => section.key === "bullCase" || section.key === "bearCase"),
  );

  const tocEntries = $derived(workspace?.tableOfContents ?? []);

  const TAB_LABELS: Record<Tab, string> = {
    report: "Report",
    sources: "Sources",
    data: "Data",
    files: "Files",
    chat: "Chat",
  };
  const SEGMENT_LABELS: Record<DataSegment, string> = {
    analytics: "Analytics",
    trace: "Trace",
    score: "Score",
    missAutopsy: "Miss autopsy",
  };

  const FINANCIAL_LENS_TILE_CLASSES: Record<FinancialLensStatTone, string> = {
    strong: "bg-[#dff2e7]",
    healthy: "bg-[#e1f0f2]",
    watch: "bg-[#f7ebcd]",
    weak: "bg-[#f2dfdc]",
    neutral: "bg-secondary",
  };
  const COMPLETENESS_STATUS_CLASSES: Record<string, string> = {
    complete: "border-[#b9ddc7] bg-[#e9f6ee] text-[#17653a]",
    partial: "border-[#d9c89a] bg-[#f8f1df] text-[#8a6116]",
    blocked: "border-[#dfb9b5] bg-[#faecea] text-[#8c2720]",
    "not-applicable": "border-border bg-secondary text-muted-foreground",
    "not-assessed": "border-[#b8c3cf] bg-[#eef2f6] text-[#46576a]",
  };
  const FINANCIAL_LENS_VALUE_CLASSES: Record<FinancialLensStatTone, string> = {
    strong: "text-[#0F7E48]",
    healthy: "text-primary",
    watch: "text-[#8a6116]",
    weak: "text-[#9B0F06]",
    neutral: "text-foreground",
  };

  const dataContent = $derived.by(() => {
    if (detail === null) {
      return "Not available";
    }

    return jsonBlock(detail[dataSegment]);
  });

  function bindSection(key: string): (el: HTMLElement) => void {
    return (el) => {
      sectionEls[key] = el;
    };
  }

  function scrollToSection(key: string): void {
    sectionEls[key]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function showCite(event: MouseEvent, sourceId: string): void {
    const source = sourceItems.find((item) => item.id === sourceId);
    cite = {
      id: sourceId,
      title: source?.title ?? "Unknown source",
      kind: source?.kind ?? "?",
      provider: source?.provider ?? "?",
      x: Math.min(event.clientX + 14, globalThis.innerWidth - POPOVER_WIDTH - 20),
      y: Math.min(event.clientY + 18, globalThis.innerHeight - POPOVER_MARGIN),
    };
  }

  function openSource(sourceId: string): void {
    cite = null;
    onHighlightSource(sourceId);
    onTabChange("sources");
  }
</script>

{#snippet citeChips(sourceIds: readonly string[])}
  {#each sourceIds as sourceId}
    <button
      class="mr-0.75 inline-block rounded border border-[#cfe0e3] bg-accent px-1.5 align-[2px] font-mono text-[10px] text-primary transition hover:border-[#9fc2c8] hover:bg-[#dcebee] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      type="button"
      onmouseenter={(event) => showCite(event, sourceId)}
      onmouseleave={() => (cite = null)}
      onclick={() => openSource(sourceId)}
    >
      {sourceId}
    </button>
  {/each}
{/snippet}

{#snippet sectionHeading(label: string)}
  <div class="border-b border-border pb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
    {label}
  </div>
{/snippet}

{#if loadingDetail}
  <div class="space-y-4" data-screen-label="Run loading">
    <Skeleton class="h-8 w-72" />
    <Skeleton class="h-5 w-96" />
    <Skeleton class="h-40 w-full max-w-180" />
    <Skeleton class="h-64 w-full max-w-180" />
  </div>
{:else if detail === null}
  <div class="rounded-lg border border-dashed border-input p-9 text-center text-sm text-muted-foreground">
    Select a run to inspect the research artifact.
  </div>
{:else}
  <div data-screen-label="Run workspace">
    <div class="font-mono text-[11px] text-muted-foreground">
      <button
        class="text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        type="button"
        onclick={onGoHome}
      >
        runs
      </button>
      / {detail.summary.runId}
    </div>

    <div class="mt-2.5 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-[21px] font-semibold tracking-tight">
          {runLabel(detail.summary)}
        </h1>
        <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#5c6066]">
          <span>{formatDate(detail.summary.generatedAt)}</span>
          {#if detail.summary.assetClass !== undefined && detail.summary.symbol !== undefined}
            <button
              class="rounded border border-[#cfe0e3] bg-accent px-1.75 py-0.5 font-mono text-[10px] text-primary hover:border-[#9fc2c8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              type="button"
              onclick={() => onOpenInstrument(detail.summary.assetClass ?? "", detail.summary.symbol ?? "")}
            >
              {detail.summary.assetClass}:{detail.summary.symbol}
            </button>
          {/if}
        </div>
      </div>
      <div class="flex flex-wrap items-end justify-end gap-5.5">
        {#each [{ value: detail.summary.confidence ?? "—", label: "Evidence Quality" }, { value: String(detail.summary.sourceCount), label: "Sources" }, { value: String(detail.summary.availableFiles.length), label: "Files" }] as stat}
          <div class="text-right">
            <div class="font-mono text-[17px] font-medium">{stat.value}</div>
            <div class="mt-0.5 text-[10.5px] uppercase tracking-wider text-muted-foreground">
              {stat.label}
            </div>
          </div>
        {/each}
      </div>
    </div>

    <div class="mt-5 flex gap-0.5 border-b border-border" role="tablist">
      {#each TABS as tab}
        <button
          class="-mb-px border-b-2 px-3.5 pb-2.5 pt-2 text-[13px] transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {activeTab ===
          tab
            ? 'border-primary font-semibold text-foreground'
            : 'border-transparent font-normal text-muted-foreground'}"
          type="button"
          role="tab"
          aria-selected={activeTab === tab}
          onclick={() => onTabChange(tab)}
        >
          {TAB_LABELS[tab]}
        </button>
      {/each}
    </div>

    {#if activeTab === "report"}
      <div class="mt-6 grid gap-11 xl:grid-cols-[minmax(0,820px)_200px]">
        <article class="min-w-0">
          {#if equityPresentation !== undefined}
            <section {@attach bindSection("equityOverview")} class="mb-6 scroll-mt-5">
              <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-[#cfe0e3] pb-2">
                <span class="text-[11px] font-semibold uppercase tracking-[0.09em] text-primary">
                  Equity snapshot
                </span>
                <span class="font-mono text-[10px] text-[#8a8f96]"> numbers and dates first </span>
              </div>
              <div class="mt-3 grid gap-3 sm:grid-cols-2">
                <div class="rounded-lg border border-border bg-card px-3.5 py-3">
                  <div class="text-[10px] font-semibold uppercase tracking-wider text-[#5c6066]">
                    {equityPresentation.defaultView.pricePerformance.label}
                  </div>
                  <div class="mt-2 flex items-baseline gap-2 font-mono">
                    <span class="text-[18px] font-semibold">
                      {equityPresentation.defaultView.pricePerformance.price ?? "Unavailable"}
                    </span>
                    <span
                      class="text-[12px] font-medium {equityPresentation.defaultView.pricePerformance
                        .changeDirection === 'positive'
                        ? 'text-[#0F9D58]'
                        : equityPresentation.defaultView.pricePerformance.changeDirection === 'negative'
                          ? 'text-[#9B0F06]'
                          : 'text-muted-foreground'}"
                    >
                      {equityPresentation.defaultView.pricePerformance.change24h ?? "24h unavailable"}
                    </span>
                  </div>
                  <div class="mt-1 font-mono text-[9px] text-[#8a8f96]">
                    {#if equityPresentation.defaultView.pricePerformance.priceAsOf !== undefined}
                      {equityPresentation.defaultView.pricePerformance.priceAsOf.kind === "quote-time"
                        ? "Quote time"
                        : "Fetch time"} · {equityPresentation.defaultView.pricePerformance.priceAsOf.instant}
                    {:else}
                      Price time unavailable
                    {/if}
                  </div>
                  {@render citeChips(equityPresentation.defaultView.pricePerformance.sourceIds)}
                </div>
                <div class="rounded-lg border border-border bg-card px-3.5 py-3">
                  <div class="text-[10px] font-semibold uppercase tracking-wider text-[#5c6066]">
                    {equityPresentation.defaultView.valuationContext.label}
                  </div>
                  <div class="mt-2 font-mono text-[13px] font-medium">
                    {equityPresentation.defaultView.valuationContext.display}
                  </div>
                  {#if equityPresentation.defaultView.valuationContext.positionLabel !== undefined}
                    <div class="mt-1 text-[10px] text-primary">
                      {equityPresentation.defaultView.valuationContext.positionLabel}
                    </div>
                  {/if}
                  <div class="mt-1 text-[9px] leading-snug text-muted-foreground">
                    {equityPresentation.defaultView.valuationContext.disclosure}
                  </div>
                  {@render citeChips(equityPresentation.defaultView.valuationContext.sourceIds)}
                </div>
              </div>
            </section>

            <div
              {@attach bindSection("summary")}
              class="scroll-mt-5 font-serif text-[16.5px] leading-[1.65] text-[#2a2d30]"
            >
              {equityPresentation.defaultView.companySummary.text}
              {@render citeChips(equityPresentation.defaultView.companySummary.sourceIds)}
            </div>

            {#if equityPresentation.defaultView.financialTrends !== undefined}
              <section {@attach bindSection("financialTrends")} class="mt-8.5 scroll-mt-5">
                <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-2">
                  <span class="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
                    Financial trends
                  </span>
                  <span class="font-mono text-[10px] text-[#8a8f96]">
                    {equityPresentation.defaultView.financialTrends.reportingCurrency ?? "currency unavailable"}
                    · FCF proxy
                  </span>
                </div>
                <div class="mt-3 overflow-x-auto rounded-lg border border-border">
                  <table class="w-full min-w-[650px] border-collapse text-left">
                    <thead class="bg-secondary text-[9px] uppercase tracking-wider text-muted-foreground">
                      <tr>
                        {#each equityPresentation.defaultView.financialTrends.columns as column, index}
                          <th class="px-2.5 py-2 font-semibold {index === 0 ? '' : 'text-right'}">
                            {column}
                          </th>
                        {/each}
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-border font-mono text-[10px]">
                      {#each equityPresentation.defaultView.financialTrends.rows as row}
                        <tr>
                          <td class="px-2.5 py-2">{row.period}</td>
                          <td class="px-2.5 py-2 text-right">{row.revenue}</td>
                          <td class="px-2.5 py-2 text-right">{row.netIncome}</td>
                          <td class="px-2.5 py-2 text-right">{row.operatingMargin}</td>
                          <td class="px-2.5 py-2 text-right">{row.freeCashFlow}</td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
                {@render citeChips(equityPresentation.defaultView.financialTrends.sourceIds)}
              </section>
            {/if}

            {#if equityPresentation.defaultView.findings.length > 0}
              <section {@attach bindSection("findings")} class="mt-8.5 scroll-mt-5">
                {@render sectionHeading("Key findings")}
                {#each equityPresentation.defaultView.findings as item, index}
                  <div class="flex gap-3.5 border-b border-[#f0ede7] py-3.5">
                    <span class="shrink-0 pt-0.75 font-mono text-xs text-[#a8acb1]">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div class="min-w-0">
                      <span class="font-serif text-[15.5px] leading-[1.6] text-[#1f2225]">
                        {item.text}
                      </span>
                      {@render citeChips(item.sourceIds)}
                    </div>
                  </div>
                {/each}
              </section>
            {/if}

            {#if defaultCaseSections.length > 0}
              <div {@attach bindSection("cases")} class="mt-8.5 grid scroll-mt-5 gap-3.5 sm:grid-cols-2">
                {#each defaultCaseSections as section}
                  <div
                    class="rounded-lg border border-border bg-card px-4.5 py-4"
                    style="border-top: 3px solid {section.edge}"
                  >
                    <div class="text-xs font-semibold uppercase tracking-wider" style="color: {section.fg}">
                      {section.title}
                    </div>
                    <div class="mt-3 flex flex-col gap-3">
                      {#each section.items as item}
                        <div class="min-w-0">
                          <span class="font-serif text-sm leading-[1.55] text-[#2a2d30]">
                            {item.text}
                          </span>
                          {@render citeChips(item.sourceIds)}
                        </div>
                      {/each}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}

            {#if equityPresentation.defaultView.earningsConsensus.items.length > 0}
              <section {@attach bindSection("earningsConsensus")} class="mt-8.5 scroll-mt-5">
                {@render sectionHeading("Upcoming earnings & consensus")}
                <div class="mt-3 grid gap-2 sm:grid-cols-2">
                  {#each equityPresentation.defaultView.earningsConsensus.items as item}
                    <div class="rounded-lg border border-border bg-card px-3.5 py-3">
                      <div class="text-[10px] font-semibold uppercase tracking-wider text-[#5c6066]">
                        {item.label}
                      </div>
                      <div class="mt-1.5 font-mono text-[12px]">{item.value}</div>
                      {@render citeChips(item.sourceIds)}
                    </div>
                  {/each}
                </div>
              </section>
            {/if}

            <section {@attach bindSection("gaps")} class="mt-8.5 scroll-mt-5">
              <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-[#e9ddc2] pb-2">
                <span class="text-[11px] font-semibold uppercase tracking-[0.09em] text-[#8a6116]">
                  Coverage & material gaps
                </span>
                {#if equityPresentation.defaultView.financialCoreStatus !== undefined}
                  <div class="flex flex-wrap gap-2">
                    <span
                      class="rounded border px-2 py-1 font-mono text-[10px] {COMPLETENESS_STATUS_CLASSES[
                        equityPresentation.defaultView.financialCoreStatus
                      ]}"
                    >
                      financial core · {equityPresentation.defaultView.financialCoreStatus}
                    </span>
                  </div>
                {/if}
              </div>
              {#if equityPresentation.defaultView.materialGaps.length === 0}
                <div class="mt-3 text-sm text-muted-foreground">No material gaps identified.</div>
              {:else}
                <div class="mt-3.5 flex flex-col gap-2.5">
                  {#each equityPresentation.defaultView.materialGaps as gap}
                    <div class="flex gap-3 rounded-lg border border-dashed border-[#d9c89a] bg-[#fbf6ea] px-4 py-3">
                      <span class="h-fit shrink-0 rounded border border-[#d9c89a] bg-[#f5ecd6] px-1.5 py-px font-mono text-[10px] text-[#8a6116]">
                        MATERIAL
                      </span>
                      <div class="font-serif text-sm leading-[1.55] text-[#4a4334]">{gap}</div>
                    </div>
                  {/each}
                </div>
              {/if}
            </section>
          {/if}

          <details
            {@attach bindSection("advanced")}
            class={equityPresentation === undefined ? "contents" : "mt-9 block scroll-mt-5"}
            open={equityPresentation === undefined}
          >
            <summary
              class={equityPresentation === undefined
                ? "hidden"
                : "cursor-pointer border-y border-border py-3 text-[11px] font-semibold text-muted-foreground"}
            >
              <span class="tracking-[0.09em]">Advanced</span>
              <span class="ml-2 font-normal text-[#8a8f96]">
                Detailed diagnostics, assumptions, and supporting evidence
              </span>
            </summary>
            <div class={equityPresentation === undefined ? "contents" : "pb-2 pt-1"}>
            {#if reportSummary !== ""}
              <div
                {@attach bindSection(reportSummarySectionKey)}
                class="scroll-mt-5 font-serif text-[16.5px] leading-[1.65] text-[#2a2d30]"
            >
              {reportSummary}
            </div>
          {/if}

          {#if appendixCompleteness !== undefined}
            <section {@attach bindSection("equityCompleteness")} class="mt-5 scroll-mt-5">
              <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-[#cfe0e3] pb-2">
                <span class="text-[11px] font-semibold uppercase tracking-[0.09em] text-primary">
                  Completeness diagnostics
                </span>
                <span class="font-mono text-[10px] text-[#8a8f96]">
                  as of {appendixCompleteness.asOf}
                </span>
              </div>
              <div class="mt-3 flex flex-wrap gap-2 font-mono text-[10px]">
                <span class="rounded border border-border bg-secondary px-2 py-1 text-foreground">
                  coverage · {appendixCompleteness.coverageLevel}
                </span>
              </div>
              <div class="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {#each appendixCompleteness.dimensions as dimension}
                  <div class="rounded-lg border border-border bg-card px-3 py-2.5">
                    <div class="flex items-start justify-between gap-2">
                      <div class="text-[10px] font-semibold uppercase tracking-wider text-[#5c6066]">
                        {dimension.label}
                      </div>
                      <span class="rounded border px-1.5 py-0.5 font-mono text-[9px] {COMPLETENESS_STATUS_CLASSES[dimension.status]}">
                        {dimension.status.replaceAll("-", " ")}
                      </span>
                    </div>
                    {#if dimension.reasonCodes.length > 0}
                      <div class="mt-2 space-y-0.5 text-[10px] leading-snug text-muted-foreground">
                        {#each dimension.reasonCodes as reason}
                          <div>{completenessReasonCodeLabel(reason)}</div>
                        {/each}
                      </div>
                    {/if}
                    <div class="mt-2 font-mono text-[9px] leading-snug text-[#8a8f96]">
                      {dimension.asOf}
                    </div>
                    {#if dimension.sourceIds.length > 0}
                      <div class="mt-1 flex flex-wrap gap-y-1">
                        {@render citeChips(dimension.sourceIds)}
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            </section>
          {/if}

          {#if equityPresentation !== undefined}
            <section class="mt-5">
              <div class="border-b border-[#cfe0e3] pb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-primary">
                Detailed equity metrics
              </div>
              <div class="mt-3 rounded-lg border border-border bg-card px-3.5 py-3">
                <div class="text-[10px] font-semibold uppercase tracking-wider text-[#5c6066]">
                  {equityPresentation.advanced.keyDatedMetrics.label}
                </div>
                <div class="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
                  {#each [...equityPresentation.advanced.keyDatedMetrics.metrics, ...equityPresentation.advanced.keyDatedMetrics.foldedYahooMetrics] as metric}
                    <div class="rounded border border-border bg-secondary px-2.5 py-2">
                      <div class="font-mono text-[13px] font-semibold">{metric.value ?? "Unavailable"}</div>
                      <div class="mt-0.5 text-[9px] font-semibold uppercase tracking-wider text-[#5c6066]">
                        {metric.label}
                      </div>
                      <div class="mt-1 font-mono text-[8px] text-[#8a8f96]">
                        {metric.dateBasis ?? "Date unavailable"}
                      </div>
                      {@render citeChips(metric.sourceIds)}
                    </div>
                  {/each}
                </div>
              </div>
              <div class="mt-3 rounded-lg border border-border bg-card px-3.5 py-3">
                <div class="text-[10px] font-semibold uppercase tracking-wider text-[#5c6066]">
                  {equityPresentation.advanced.miniCharts.label}
                </div>
                <div class="mt-2 grid grid-cols-2 gap-2 xl:grid-cols-4">
                  {#each equityPresentation.advanced.miniCharts.charts as chart}
                    <div class="rounded border border-border bg-secondary px-2.5 py-2">
                      <div class="text-[9px] font-semibold uppercase tracking-wider">{chart.label}</div>
                      {#if chart.geometry === undefined}
                        <div class="mt-3 text-xs text-muted-foreground">Unavailable</div>
                      {:else}
                        <div class="mt-1 font-mono text-[12px] font-semibold">{chart.value}</div>
                        <SparklineBars geometry={chart.geometry} label={`${chart.label} history`} />
                        <div class="font-mono text-[8px] text-[#8a8f96]">{chart.period}</div>
                        {@render citeChips(chart.sourceIds)}
                      {/if}
                    </div>
                  {/each}
                </div>
              </div>
              <div class="mt-3 rounded-lg border border-border bg-card px-3.5 py-3">
                <div class="text-[10px] font-semibold uppercase tracking-wider text-[#5c6066]">
                  {equityPresentation.advanced.financialLensDrivers.label}
                </div>
                <div class="mt-2 grid gap-2 sm:grid-cols-3">
                  <div class="rounded border border-border bg-secondary px-2.5 py-2">
                    <div class="text-[9px] font-semibold uppercase tracking-wider">
                      {equityPresentation.advanced.financialLensDrivers.postures.label}
                    </div>
                    <div class="mt-2 space-y-1.5">
                      {#each equityPresentation.advanced.financialLensDrivers.postures.items as posture}
                        <div>
                          <span class="text-[10px] font-medium">{posture.lens}</span>
                          <span class="font-mono text-[9px] text-muted-foreground">
                            · {posture.postureLabel}
                          </span>
                          {@render citeChips(posture.sourceIds)}
                        </div>
                      {/each}
                    </div>
                  </div>
                  {#each [equityPresentation.advanced.financialLensDrivers.bullCase, equityPresentation.advanced.financialLensDrivers.bearCase] as driverCard}
                    <div class="rounded border border-border bg-secondary px-2.5 py-2">
                      <div class="text-[9px] font-semibold uppercase tracking-wider">
                        {driverCard.label}
                      </div>
                      <div class="mt-2 space-y-2">
                        {#each driverCard.items as item}
                          <div class="font-serif text-[12px] leading-snug">
                            {item.text}
                            {@render citeChips(item.sourceIds)}
                          </div>
                        {/each}
                      </div>
                    </div>
                  {/each}
                </div>
              </div>
            </section>
          {/if}

          {#if financialLensGroups.length > 0}
            <section {@attach bindSection("financialLensStats")} class="mt-5 scroll-mt-5">
              <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-[#cfe0e3] pb-2">
                <span class="text-[11px] font-semibold uppercase tracking-[0.09em] text-primary">
                  Financial Lens stats
                </span>
                <span class="font-mono text-[10px] text-[#8a8f96]"> normalized evidence metrics </span>
              </div>
              <div class="mt-3 space-y-4">
                {#each financialLensGroups as group}
                  <div>
                    <div class="flex items-baseline justify-between gap-2">
                      <div class="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#353a40]">
                        {group.lens}
                      </div>
                      <div class="font-mono text-[10px] text-[#737980]">
                        {group.posture.replaceAll("-", " ")}
                      </div>
                    </div>
                    <div class="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                      {#each group.tiles as tile}
                        <div class="px-3 py-2.5 rounded-lg {FINANCIAL_LENS_TILE_CLASSES[tile.tone]}">
                          <div class="flex items-start justify-between gap-2">
                            <div class="font-mono text-[16px] font-semibold {FINANCIAL_LENS_VALUE_CLASSES[tile.tone]}">
                              {tile.value}
                            </div>
                            {#if tile.assessment !== undefined}
                              <span
                                class="rounded border border-current uppercase font-medium px-1 py-px font-mono text-[10px] leading-tight {FINANCIAL_LENS_VALUE_CLASSES[
                                  tile.tone
                                ]}"
                              >
                                {tile.assessment}
                              </span>
                            {/if}
                          </div>
                          <div class="mt-1 text-[10px] uppercase tracking-wider text-[#5c6066]">
                            {tile.label}
                          </div>
                          {#if tile.caption !== undefined}
                            <div class="mt-1 font-mono text-[9px] leading-snug text-[#8a8f96]">
                              {tile.caption}
                            </div>
                          {/if}
                        </div>
                      {/each}
                    </div>
                  </div>
                {/each}
              </div>
            </section>
          {/if}

          {#if fundamentalHistory !== undefined}
            <section {@attach bindSection("fundamentalHistory")} class="mt-8.5 scroll-mt-5">
              <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-2">
                <span class="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
                  Fundamental history
                </span>
                <span class="font-mono text-[10px] text-[#8a8f96]"> normalized SEC fiscal history </span>
              </div>
              <div class="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {#each fundamentalHistory.cards as card}
                  <div class="rounded-lg border border-border bg-card px-3.5 py-3">
                    <div class="flex items-start justify-between gap-3">
                      <div>
                        <div class="text-[10px] font-semibold uppercase tracking-wider text-[#5c6066]">
                          {card.label}
                        </div>
                        <div class="mt-1 font-mono text-[17px] font-semibold text-foreground">
                          {card.value}
                        </div>
                      </div>
                      {#if card.trendLabel !== undefined}
                        <div class="text-right font-mono text-[10px] text-primary">
                          {card.trendLabel}
                        </div>
                      {/if}
                    </div>
                    <div class="mt-1 font-mono text-[9px] text-[#737980]">
                      {card.valuePeriod}
                    </div>
                    <div class="mt-2">
                      <SparklineBars geometry={card.geometry} label={`${card.label} annual history`} />
                    </div>
                    <div class="mt-1 font-mono text-[9px] leading-snug text-[#8a8f96]">
                      {card.periodRange}
                    </div>
                    <div class="mt-0.5 font-mono text-[9px] leading-snug text-[#8a8f96]">
                      {card.sourceCaption}
                    </div>
                    {#if card.disclosure !== undefined}
                      <div class="mt-1 text-[9px] leading-snug text-[#8a6116]">
                        {card.disclosure}
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            </section>
          {/if}

          {#if equityPresentation?.advanced.balanceSheetHistory !== undefined}
            <section class="mt-8.5">
              <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-2">
                <span class="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
                  Balance sheet & share count
                </span>
                <span class="font-mono text-[10px] text-[#8a8f96]">
                  {equityPresentation.advanced.balanceSheetHistory.reportingCurrency ?? "currency unavailable"}
                </span>
              </div>
              <div class="mt-3 overflow-x-auto rounded-lg border border-border">
                <table class="w-full min-w-[580px] border-collapse text-left">
                  <thead class="bg-secondary text-[9px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th class="px-2.5 py-2 font-semibold">Period</th>
                      <th class="px-2.5 py-2 text-right font-semibold">Cash</th>
                      <th class="px-2.5 py-2 text-right font-semibold">Debt</th>
                      <th class="px-2.5 py-2 text-right font-semibold">Diluted shares</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-border font-mono text-[10px]">
                    {#each equityPresentation.advanced.balanceSheetHistory.rows as row}
                      <tr>
                        <td class="px-2.5 py-2">{row.period}</td>
                        <td class="px-2.5 py-2 text-right">{row.cash}</td>
                        <td class="px-2.5 py-2 text-right">{row.debt}</td>
                        <td class="px-2.5 py-2 text-right">{row.dilutedShares}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
              {@render citeChips(equityPresentation.advanced.balanceSheetHistory.sourceIds)}
            </section>
          {/if}

          {#if valuationWorkbench !== undefined}
            <section {@attach bindSection("valuationWorkbench")} class="mt-8.5 scroll-mt-5">
              <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-2">
                <span class="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
                  Valuation workbench
                </span>
                <span class="font-mono text-[10px] text-[#8a8f96]">
                  {valuationWorkbench.reportingCurrency} reporting · {valuationWorkbench.quoteCurrency} quote
                </span>
              </div>
              <div class="mt-2 text-[10px] leading-snug text-muted-foreground">
                {valuationWorkbench.priceSelectionRule}. {valuationWorkbench.trailingDisclosure}.
              </div>
              {#if valuationWorkbench.rows.length > 0}
                <div class="mt-3 overflow-x-auto rounded-lg border border-border">
                  <table class="w-full min-w-[700px] border-collapse text-left">
                    <thead class="bg-secondary text-[9px] uppercase tracking-wider text-muted-foreground">
                      <tr>
                        <th class="px-2.5 py-2 font-semibold">Basis</th>
                        <th class="px-2.5 py-2 font-semibold">Period</th>
                        <th class="px-2.5 py-2 font-semibold">Public</th>
                        <th class="px-2.5 py-2 font-semibold">Eligible close</th>
                        <th class="px-2.5 py-2 text-right font-semibold">P/E</th>
                        <th class="px-2.5 py-2 text-right font-semibold">P/S</th>
                        <th class="px-2.5 py-2 text-right font-semibold">EV/revenue</th>
                        <th class="px-2.5 py-2 text-right font-semibold">P/FCF</th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-border font-mono text-[10px]">
                      {#each valuationWorkbench.rows as row}
                        <tr>
                          <td class="px-2.5 py-2">{row.basis}</td>
                          <td class="px-2.5 py-2">{row.periodEnd}</td>
                          <td class="px-2.5 py-2">{row.publicAt}</td>
                          <td class="px-2.5 py-2">{row.price}</td>
                          {#each [row.priceToEarnings, row.priceToSales, row.enterpriseValueToRevenue, row.priceToFreeCashFlow] as metric}
                            <td
                              class="px-2.5 py-2 text-right {metric.status === 'populated'
                                ? 'text-foreground'
                                : metric.status === 'not-meaningful'
                                  ? 'text-[#8a6116]'
                                  : 'text-muted-foreground'}"
                              title={metric.detail}
                            >
                              {metric.display}
                            </td>
                          {/each}
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {:else}
                <div class="mt-3 rounded-lg border border-border bg-secondary px-4 py-3 text-sm text-muted-foreground">
                  Historical multiples suppressed: {valuationWorkbench.suppressionReasons.join("; ") || "no compatible inputs"}.
                </div>
              {/if}
              <div class="mt-4 flex flex-wrap items-baseline justify-between gap-2">
                <div class="text-[10px] font-semibold uppercase tracking-wider text-[#5c6066]">
                  Peer table
                </div>
                <div class="font-mono text-[10px] text-primary">
                  supportability · {valuationWorkbench.peerSupportability}
                </div>
              </div>
              {#if valuationWorkbench.peerRows.length > 0}
                <div class="mt-2 overflow-x-auto rounded-lg border border-border">
                  <table class="w-full min-w-[620px] border-collapse text-left">
                    <thead class="bg-secondary text-[9px] uppercase tracking-wider text-muted-foreground">
                      <tr>
                        <th class="px-2.5 py-2 font-semibold">Symbol</th>
                        <th class="px-2.5 py-2 font-semibold">Role</th>
                        <th class="px-2.5 py-2 font-semibold">Screen</th>
                        <th class="px-2.5 py-2 text-right font-semibold">EV/revenue</th>
                        <th class="px-2.5 py-2 font-semibold">Currency</th>
                        <th class="px-2.5 py-2 font-semibold">Input dates</th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-border font-mono text-[10px]">
                      {#each valuationWorkbench.peerRows as row}
                        <tr>
                          <td class="px-2.5 py-2 font-semibold">{row.symbol}</td>
                          <td class="px-2.5 py-2">{row.role}</td>
                          <td class="px-2.5 py-2">{row.status}</td>
                          <td class="px-2.5 py-2 text-right">{row.multiple}</td>
                          <td class="px-2.5 py-2">{row.currency}</td>
                          <td class="px-2.5 py-2">{row.inputDates}</td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {:else if valuationWorkbench.peerSuppression !== undefined}
                <div class="mt-2 rounded-lg border border-border bg-secondary px-4 py-3 text-sm text-muted-foreground">
                  {valuationWorkbench.peerSuppression}
                </div>
              {/if}
              {#if valuationWorkbench.excludedPeerRows.length > 0}
                <div class="mt-4 text-[10px] font-semibold uppercase tracking-wider text-[#5c6066]">
                  Excluded-peer diagnostics
                </div>
                <div class="mt-2 space-y-2">
                  {#each valuationWorkbench.excludedPeerRows as peer}
                    <div class="rounded-lg border border-dashed border-border bg-secondary px-3 py-2 text-[10px]">
                      <span class="font-mono font-semibold">{peer.symbol}</span>
                      · {peer.role} · {peer.reason}
                      {@render citeChips(peer.sourceIds)}
                    </div>
                  {/each}
                </div>
              {/if}
            </section>
          {/if}

          {#if reverseDcf !== undefined}
            <section {@attach bindSection("reverseDcf")} class="mt-8.5 scroll-mt-5">
              <div class="border-b border-border pb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
                Reverse DCF input sensitivity
              </div>
              {#if reverseDcf.status === "suppressed"}
                <div class="mt-3 rounded-lg border border-border bg-secondary px-4 py-3 text-sm text-muted-foreground">
                  Suppressed: {reverseDcf.message}
                </div>
              {:else}
                <div class="mt-3 grid gap-2 text-[10px] text-muted-foreground sm:grid-cols-3">
                  <div>
                    <span class="font-semibold text-foreground">Starting FCF</span><br />
                    <span class="font-mono">{reverseDcf.startingFcf}</span><br />
                    {reverseDcf.startingFcfDates}
                  </div>
                  <div>
                    <span class="font-semibold text-foreground">Enterprise value</span><br />
                    <span class="font-mono">{reverseDcf.enterpriseValue}</span><br />
                    {reverseDcf.enterpriseValueDate}
                  </div>
                  <div>
                    <span class="font-semibold text-foreground">Horizon</span><br />
                    <span class="font-mono">{reverseDcf.horizonYears} years</span>
                  </div>
                </div>
                <div class="mt-3 text-[10px] leading-snug text-muted-foreground">
                  Each cell is the five-year FCF growth input that reconciles the row discount rate and column terminal growth assumption.
                </div>
                <div class="mt-3 overflow-x-auto rounded-lg border border-border">
                  <table class="w-full min-w-[560px] border-collapse text-right">
                    <thead class="bg-secondary text-[9px] uppercase tracking-wider text-muted-foreground">
                      <tr>
                        <th class="px-2.5 py-2 text-left font-semibold">Discount rate</th>
                        {#each reverseDcf.terminalGrowthRatesPct as rate}
                          <th class="px-2.5 py-2 font-semibold">{rate}% terminal</th>
                        {/each}
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-border font-mono text-[10px]">
                      {#each reverseDcf.rows as row}
                        <tr>
                          <td class="px-2.5 py-2 text-left font-semibold">{row.discountRatePct}%</td>
                          {#each row.cells as cell}
                            <td class="px-2.5 py-2">{cell}</td>
                          {/each}
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {/if}
            </section>
          {/if}

          {#if peerImpliedRange !== undefined}
            <section {@attach bindSection("peerImpliedRange")} class="mt-8.5 scroll-mt-5">
              {#if peerImpliedRange.status === "suppressed"}
                <div class="rounded-lg border border-border bg-secondary px-4 py-3.5">
                  <div class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {peerImpliedRange.label}
                  </div>
                  <div class="mt-1.5 text-sm text-muted-foreground">
                    {peerImpliedRange.message}
                  </div>
                </div>
              {:else}
                <div class="rounded-lg border border-border bg-card px-4 py-3.5">
                  <div class="flex flex-wrap items-baseline justify-between gap-2">
                    <div class="text-[10px] font-semibold uppercase tracking-wider text-[#5c6066]">
                      {peerImpliedRange.label}
                    </div>
                    <div class="font-mono text-[10px] text-primary">
                      {peerImpliedRange.positionLabel}
                    </div>
                  </div>
                  <div class="mt-2.5">
                    <RangeBar
                      geometry={peerImpliedRange.geometry}
                      label={peerImpliedRange.label}
                      lowLabel={peerImpliedRange.lowLabel}
                      midLabel={peerImpliedRange.midLabel}
                      highLabel={peerImpliedRange.highLabel}
                      currentLabel={peerImpliedRange.currentLabel}
                    />
                  </div>
                  <div class="mt-2 font-mono text-[9px] leading-relaxed text-[#737980]">
                    {peerImpliedRange.methodDisclosure}
                  </div>
                  <div class="mt-0.5 font-mono text-[9px] leading-relaxed text-[#8a8f96]">
                    {peerImpliedRange.boundaryDisclosure}
                  </div>
                </div>
              {/if}
            </section>
          {/if}

          {#if equityPresentation === undefined && findingItems.length > 0}
            <section {@attach bindSection(reportFindingsSectionKey)} class="mt-8.5 scroll-mt-5">
              {@render sectionHeading("Key findings")}
              {#each findingItems as item, index}
                <div class="flex gap-3.5 border-b border-[#f0ede7] py-3.5">
                  <span class="shrink-0 pt-0.75 font-mono text-xs text-[#a8acb1]">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div class="min-w-0">
                    <span class="font-serif text-[15.5px] leading-[1.6] text-[#1f2225]">
                      {item.text}
                    </span>
                    {@render citeChips(item.sourceIds)}
                  </div>
                </div>
              {/each}
            </section>
          {/if}

          {#if advancedCaseSections.length > 0}
            <div
              {@attach bindSection("advancedCases")}
              class="mt-8.5 grid scroll-mt-5 gap-3.5 sm:grid-cols-2"
            >
              {#each advancedCaseSections as section}
                <div
                  class="rounded-lg border border-border bg-card px-4.5 py-4"
                  style="border-top: 3px solid {section.edge}"
                >
                  <div class="text-xs font-semibold uppercase tracking-wider" style="color: {section.fg}">
                    {section.title}
                  </div>
                  <div class="mt-3 flex flex-col gap-3">
                    {#each section.items as item}
                      <div class="min-w-0">
                        <span class="font-serif text-sm leading-[1.55] text-[#2a2d30]">
                          {item.text}
                        </span>
                        {@render citeChips(item.sourceIds)}
                      </div>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          {/if}

          {#if scenarioItems.length > 0}
            <section {@attach bindSection("scenarios")} class="mt-8.5 scroll-mt-5">
              {@render sectionHeading("Scenarios")}
              <div class="mt-3.5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {#each scenarioItems as scenario}
                  <div class="rounded-lg border border-border bg-card px-4 py-3.5">
                    <div class="text-[12.5px] font-semibold text-foreground">
                      {scenario.name}
                    </div>
                    <div class="mt-2 font-serif text-[13px] leading-[1.55] text-[#45494e]">
                      {scenario.description}
                    </div>
                    {@render citeChips(scenario.sourceIds)}
                  </div>
                {/each}
              </div>
            </section>
          {/if}

          {#if snapshot !== undefined}
            <section {@attach bindSection("snapshot")} class="mt-8.5 scroll-mt-5">
              <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-2">
                <span class="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
                  Market snapshot · {snapshot.symbol}
                </span>
                <span class="flex flex-wrap items-center gap-2 font-mono text-[10px] text-[#a8acb1]">
                  <span>
                    artifact closes{snapshot.latestSessionDate === undefined
                      ? ""
                      : ` · last session ${snapshot.latestSessionDate}`}
                  </span>
                  {#if snapshotTradingViewUrl !== undefined}
                    <a
                      class="rounded border border-[#cfe0e3] bg-accent px-1.75 py-0.5 text-primary hover:border-[#9fc2c8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      href={snapshotTradingViewUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      TradingView
                    </a>
                  {/if}
                </span>
              </div>
              <PriceSnapshotChart {snapshot} horizons={forecastHorizons} />
            </section>
          {/if}

          {#if historicalAudit !== undefined}
            <section {@attach bindSection("history")} class="mt-8.5 scroll-mt-5">
              <div class="flex items-baseline justify-between border-b border-border pb-2">
                <span class="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
                  Historical context audit
                </span>
                <span class="font-mono text-[10px] text-[#a8acb1]"> trace.json selection counts </span>
              </div>
              <div class="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {#each [["Scanned", historicalAudit.scannedRunCount], ["Candidates", historicalAudit.candidateRunCount], ["Selected", historicalAudit.selectedRunCount], ["Recent", historicalAudit.recentSelectedCount], ["Anchors", historicalAudit.anchorSelectedCount], ["Same symbol", historicalAudit.sameSymbolSelectedCount], ["Spotlight", historicalAudit.spotlightSymbolSelectedCount], ["Same subject", historicalAudit.sameSubjectSelectedCount], ["Same horizon", historicalAudit.sameHorizonSelectedCount], ["Cross horizon", historicalAudit.crossHorizonSelectedCount], ["Resolved miss runs", historicalAudit.resolvedMissRunCount], ["Miss-correction", historicalAudit.missCorrectionSelectedCount], ["Gaps", historicalAudit.gapCount]] as row}
                  <div class="rounded-md border border-border bg-secondary px-3 py-2">
                    <div class="font-mono text-[15px] font-medium text-foreground">
                      {row[1]}
                    </div>
                    <div class="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                      {row[0]}
                    </div>
                  </div>
                {/each}
              </div>
            </section>
          {/if}

          {#if webSubjectProfile !== undefined}
            <WebSubjectProfile profile={webSubjectProfile} {citeChips} {bindSection} />
          {/if}

          {#if businessFramework !== undefined}
            <BusinessFramework framework={businessFramework} {citeChips} {bindSection} />
          {/if}

          {#if (equityPresentation?.advanced.analystEstimateDistributions.length ?? 0) > 0}
            <section class="mt-8.5">
              {@render sectionHeading("Analyst estimate distributions")}
              <div class="mt-3.5 grid gap-3">
                {#each equityPresentation?.advanced.analystEstimateDistributions ?? [] as distribution}
                  <div class="rounded-lg border border-border bg-card px-4 py-3.5">
                    <div class="flex flex-wrap items-baseline justify-between gap-2">
                      <div class="text-[12.5px] font-semibold text-foreground">
                        {distribution.title}
                      </div>
                      {#if distribution.period !== undefined}
                        <div class="font-mono text-[10px] text-muted-foreground">
                          {distribution.period}
                        </div>
                      {/if}
                    </div>
                    <div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
                      {#each [
                        ["Mean", distribution.mean],
                        ["Median", distribution.median],
                        ["High", distribution.high],
                        ["Low", distribution.low],
                        ["Count", distribution.count],
                      ] as metric}
                        <div class="rounded-md border border-border bg-secondary px-2.5 py-2">
                          <div class="font-mono text-[12px] font-medium text-foreground">
                            {metric[1]}
                          </div>
                          <div class="mt-0.5 text-[9.5px] uppercase tracking-wider text-muted-foreground">
                            {metric[0]}
                          </div>
                        </div>
                      {/each}
                    </div>
                    {@render citeChips(distribution.sourceIds)}
                  </div>
                {/each}
              </div>
            </section>
          {/if}

          {#if extendedEvidence.length > 0}
            <section {@attach bindSection("extendedEvidence")} class="mt-8.5 scroll-mt-5">
              {@render sectionHeading("Extended evidence")}
              <div class="mt-3.5 grid gap-3 sm:grid-cols-2">
                {#each extendedEvidence as item}
                  {@const metricTiles = item.category === "valuation" ? valuationMetricTiles(item.metrics) : []}
                  <div class="rounded-lg border border-border bg-card px-4 py-3.5">
                    <div class="flex flex-wrap items-center gap-2">
                      <span
                        class="rounded border border-border bg-secondary px-1.75 py-0.5 font-mono text-[10px] text-[#5c6066]"
                      >
                        {item.category}
                      </span>
                      <div class="text-[12.5px] font-semibold text-foreground">
                        {item.title}
                      </div>
                    </div>
                    <div class="mt-2 font-serif text-[13px] leading-[1.55] text-[#45494e]">
                      {item.summary}
                    </div>
                    {#if metricTiles.length > 0}
                      <div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {#each metricTiles as tile}
                          <div class="rounded-md border border-border bg-secondary px-2.5 py-2">
                            <div class="font-mono text-[12px] font-medium text-foreground">
                              {tile.value}
                            </div>
                            <div class="mt-0.5 text-[9.5px] uppercase tracking-wider text-muted-foreground">
                              {tile.label}
                            </div>
                          </div>
                        {/each}
                      </div>
                    {/if}
                    {@render citeChips(item.sourceIds)}
                  </div>
                {/each}
              </div>
            </section>
          {/if}

          {#if showForecastsSection}
            <ObservableForecasts
              {forecastItems}
              {groupedForecastItems}
              {forecastStats}
              {targetHealth}
              assetClass={detail.summary.assetClass ?? ""}
              {citeChips}
              {bindSection}
              {onOpenInstrument}
            />
          {/if}

          {#if showGapsSection}
            <section {@attach bindSection("diagnosticGaps")} class="mt-8.5 scroll-mt-5">
              {#if splitGaps.shortfalls.length > 0}
                <div
                  class="border-b border-[#e9ddc2] pb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-[#8a6116]"
                >
                  Prediction shortfall
                </div>
                <div class="mt-3.5 flex flex-col gap-2.5">
                  {#each splitGaps.shortfalls as gap}
                    <div class="flex gap-3 rounded-lg border border-dashed border-[#d9c89a] bg-[#fbf6ea] px-4 py-3">
                      <span
                        class="h-fit shrink-0 rounded border border-[#d9c89a] bg-[#f5ecd6] px-1.5 py-px font-mono text-[10px] text-[#8a6116]"
                      >
                        SHORTFALL
                      </span>
                      <div class="font-serif text-sm leading-[1.55] text-[#4a4334]">
                        {formatShortfallGap(gap)}
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}

              {#if advancedTriagedGaps.length > 0}
                <div
                  class="border-b border-[#e9ddc2] pb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-[#8a6116] {splitGaps
                    .shortfalls.length > 0
                    ? 'mt-8'
                    : ''}"
                >
                  Data gaps · what we could not verify
                </div>
                <div class="mt-3.5 flex flex-col gap-2.5">
                  {#each advancedTriagedGaps as gap}
                    <div class="flex gap-3 rounded-lg border border-dashed border-[#d9c89a] bg-[#fbf6ea] px-4 py-3">
                      <span
                        class="h-fit shrink-0 rounded border border-[#d9c89a] bg-[#f5ecd6] px-1.5 py-px font-mono text-[10px] text-[#8a6116]"
                      >
                        {gap.triage}
                      </span>
                      <div class="font-serif text-sm leading-[1.55] text-[#4a4334]">
                        {gap.text}
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            </section>
          {/if}

          {#if reportMarkdown !== undefined}
            <section class="mt-8.5">
              {@render sectionHeading("Raw markdown")}
              <pre
                class="mt-3.5 max-h-130 overflow-auto rounded-lg bg-[#16181a] p-4.5 font-mono text-xs leading-relaxed text-[#c7cdd4]">{reportMarkdown}</pre>
            </section>
          {/if}
            </div>
          </details>
        </article>

        <aside class="sticky top-6 hidden h-fit pt-1 xl:block">
          <div class="font-mono text-[10px] tracking-[0.08em] text-[#a8acb1]">ON THIS PAGE</div>
          <div class="mt-2.5 flex flex-col gap-0.5 border-l border-border">
            {#each tocEntries as entry}
              <button
                class="-ml-px border-l-2 border-transparent py-1 pl-3 text-left text-xs text-[#5c6066] transition hover:border-[#9fc2c8] hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                type="button"
                onclick={() => scrollToSection(entry.key)}
              >
                {entry.label}
              </button>
            {/each}
          </div>
          <div class="mt-5.5 border-t border-border pt-3.5 text-[11.5px] text-[#5c6066]">
            Every claim carries its source IDs. Hover a chip to preview; click to open Sources.
          </div>
        </aside>
      </div>
    {:else if activeTab === "sources"}
      <div class="mt-6 overflow-hidden rounded-lg border border-border bg-card">
        <div class="overflow-x-auto">
          <div class="min-w-160">
            <div
              class="grid grid-cols-[170px_minmax(0,1fr)_110px_130px_70px] gap-3.5 border-b border-border bg-secondary px-4.5 py-2.5 font-mono text-[10px] tracking-[0.08em] text-muted-foreground"
            >
              <div>ID</div>
              <div>TITLE</div>
              <div>KIND</div>
              <div>PROVIDER</div>
              <div>LINK</div>
            </div>
            {#if sourceItems.length === 0}
              <div class="px-4.5 py-6 text-sm text-muted-foreground">This run cites no normalized sources.</div>
            {/if}
            {#each sourceItems as source}
              <div
                {@attach (el) => {
                  if (highlightSourceId === source.id) {
                    el.scrollIntoView({ block: "center" });
                  }
                }}
                class="grid grid-cols-[170px_minmax(0,1fr)_110px_130px_70px] items-center gap-3.5 border-b border-[#f0ede7] px-4.5 py-2.75 {highlightSourceId ===
                source.id
                  ? 'bg-accent'
                  : 'bg-transparent'}"
              >
                <div class="truncate font-mono text-[11.5px] font-medium text-primary" title={source.id}>
                  {source.id}
                </div>
                <div class="truncate text-[12.5px] text-[#1f2225]" title={source.title}>
                  {source.title}
                </div>
                <div>
                  <span
                    class="rounded border border-border bg-secondary px-1.75 py-0.5 font-mono text-[10px] text-[#5c6066]"
                  >
                    {source.kind ?? "source"}
                  </span>
                </div>
                <div class="truncate text-xs text-[#5c6066]">
                  {source.provider ?? ""}
                </div>
                <div>
                  {#if source.url !== undefined}
                    <a
                      class="font-mono text-[11px] text-primary hover:underline"
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      open ↗
                    </a>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </div>
      </div>
    {:else if activeTab === "data"}
      <div class="mt-6">
        <div class="inline-flex overflow-hidden rounded-md border border-border bg-card">
          {#each DATA_SEGMENTS as segment}
            <button
              class="border-r border-[#f0ede7] px-4 py-1.5 text-xs font-medium transition last:border-r-0 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {dataSegment ===
              segment
                ? 'bg-sidebar text-white'
                : 'bg-transparent text-[#5c6066]'}"
              type="button"
              onclick={() => (dataSegment = segment)}
            >
              {SEGMENT_LABELS[segment]}
            </button>
          {/each}
        </div>
        <div class="mt-3 overflow-x-auto rounded-lg bg-[#16181a] px-5 py-4.5">
          <pre class="font-mono text-xs leading-relaxed text-[#c7cdd4]">{dataContent}</pre>
        </div>
      </div>
    {:else if activeTab === "files"}
      <div class="mt-6 grid items-start gap-3.5 lg:grid-cols-[250px_minmax(0,1fr)]">
        <div class="overflow-hidden rounded-lg border border-border bg-card">
          {#if detail.summary.availableFiles.length === 0}
            <div class="px-3.5 py-5 text-sm text-muted-foreground">No files on disk.</div>
          {/if}
          {#each detail.summary.availableFiles as file}
            <button
              class="block w-full border-b border-[#f0ede7] px-3.5 py-2.25 text-left transition last:border-b-0 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {selectedFile ===
              file
                ? 'bg-accent'
                : 'bg-transparent'}"
              type="button"
              onclick={() => onLoadFile(file)}
            >
              <span
                class="block truncate font-mono text-[11.5px] {selectedFile === file
                  ? 'text-primary'
                  : 'text-[#45494e]'}"
              >
                {file}
              </span>
            </button>
          {/each}
        </div>
        {#if selectedFile === ""}
          <div
            class="flex min-h-80 items-center justify-center rounded-lg border border-dashed border-input text-[13px] text-muted-foreground"
          >
            Select a file to view its contents
          </div>
        {:else}
          <div class="min-h-80 overflow-x-auto rounded-lg bg-[#16181a] px-5 py-4.5">
            <div class="mb-3 font-mono text-[10.5px] text-[#6e757d]">
              runs/{detail.summary.runId}/{selectedFile}
            </div>
            <pre class="font-mono text-xs leading-relaxed text-[#c7cdd4]">{fileContent}</pre>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Kept mounted across tab switches so the conversation is not reset. -->
    <div class={activeTab === "chat" ? "" : "hidden"}>
      <RunChat runId={detail.summary.runId} />
    </div>
  </div>

  {#if cite !== null}
    <div
      class="pointer-events-none fixed z-50 w-72 rounded-lg border border-input bg-popover px-3.75 py-3 shadow-[0_6px_24px_rgba(26,28,30,0.14)]"
      style="left: {cite.x}px; top: {cite.y}px"
      role="tooltip"
    >
      <div class="flex items-center gap-2">
        <span class="rounded border border-[#cfe0e3] bg-accent px-1.5 font-mono text-[10px] text-primary">
          {cite.id}
        </span>
        <span class="font-mono text-[10px] text-muted-foreground">
          {cite.kind} · {cite.provider}
        </span>
      </div>
      <div class="mt-2 text-[12.5px] font-medium leading-snug text-popover-foreground">
        {cite.title}
      </div>
      <div class="mt-2 text-[11px] text-muted-foreground">Click chip to open in Sources</div>
    </div>
  {/if}
{/if}
