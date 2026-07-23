<script lang="ts">
  import { Skeleton } from "$lib/components/ui/skeleton";
  import type { RunDetail } from "../../types";
  import {
    formatClose,
    formatDate,
    formatDateMinute,
    jsonBlock,
    runLabel,
    formatShortfallGap,
    valuationMetricTiles,
    type FinancialLensStatTone,
  } from "../view-model";
  import { buildRunWorkspaceView, type RunWorkspaceCaseKey } from "../run-workspace-view";
  import { DATA_SEGMENTS, TABS, type DataSegment, type Tab } from "./console-types";
  import PriceSnapshotChart from "./price-snapshot-chart.svelte";
  import SparklineBars from "./sparkline-bars.svelte";
  import RangeBar from "./range-bar.svelte";
  import RunChat from "./run-chat.svelte";

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
  const reportSummary = $derived(workspace?.report.summary ?? "");
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
  const splitGaps = $derived(workspace?.gaps ?? { shortfalls: [], otherGaps: [] });
  const extendedEvidence = $derived(workspace?.evidence.extendedItems ?? []);
  const businessFramework = $derived(workspace?.evidence.businessFramework);
  const webSubjectProfile = $derived(workspace?.evidence.webSubjectProfile);
  const financialLensGroups = $derived(workspace?.report.financialLensGroups ?? []);
  const fundamentalHistory = $derived(workspace?.fundamentalHistory);
  const valuationWorkbench = $derived(workspace?.valuationWorkbench);
  const equityCompleteness = $derived(workspace?.equityCompleteness);
  const peerImpliedRange = $derived(workspace?.peerImpliedRange);
  const equityHeader = $derived(workspace?.equityHeader);
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

  const DISAGREEMENT_BADGE_CLASSES: Record<string, string> = {
    low: "border-[#cfe0e3] bg-accent text-primary",
    medium: "border-[#d9c89a] bg-[#f5ecd6] text-[#8a6116]",
    high: "border-[#b8bdc3] bg-[#eef0f2] text-[#3f454b]",
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
  };
  const FINANCIAL_LENS_VALUE_CLASSES: Record<FinancialLensStatTone, string> = {
    strong: "text-[#0F7E48]",
    healthy: "text-primary",
    watch: "text-[#8a6116]",
    weak: "text-[#9B0F06]",
    neutral: "text-foreground",
  };

  function percent(value: number): string {
    return `${String(Math.round(value * 100))}%`;
  }

  function spreadPoints(value: number): string {
    return `${String(Math.round(value * 100))}pp`;
  }

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

  function subjectSymbols(subject: string | undefined): readonly string[] {
    if (subject === undefined) {
      return [];
    }
    return subject
      .split(":")
      .map((part) => part.trim().toUpperCase())
      .filter((part) => /^[A-Z0-9._-]+$/u.test(part));
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

    {#if equityHeader !== undefined && equityHeader.financials.length > 0}
      <div class="mt-4 grid grid-cols-2 gap-2 border-y border-border py-3 sm:grid-cols-3 xl:grid-cols-5">
        <div class="min-w-0 px-2 first:pl-0 last:pr-0">
          <div class="flex items-baseline gap-2 font-mono">
            <span class="text-[15px] font-medium">{equityHeader.price}</span>
            <span
              class="text-[12px] font-medium {equityHeader.changeDirection === 'positive'
                ? 'text-[#0F9D58]'
                : equityHeader.changeDirection === 'negative'
                  ? 'text-[#9B0F06]'
                  : 'text-muted-foreground'}"
            >
              {equityHeader.dailyChange}
            </span>
          </div>
          <div class="mt-0.5 text-[11px] uppercase tracking-wider text-[#5c6066]">
            Price · {equityHeader.quoteCurrency}
          </div>
          <div class="mt-1 font-mono text-[10px] leading-snug text-[#8a8f96]">
            {equityHeader.asOf}
          </div>
        </div>
        {#each equityHeader.financials as financial}
          <div class="min-w-0 px-2 first:pl-0 last:pr-0">
            <div class="font-mono text-[15px] font-medium">{financial.value}</div>
            <div class="mt-0.5 text-[11px] uppercase tracking-wider text-[#5c6066]">
              {financial.label}
            </div>
            <div class="mt-1 font-mono text-[10px] leading-snug text-[#8a8f96]">
              {financial.caption}
            </div>
          </div>
        {/each}
      </div>
    {/if}

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
          {#if reportSummary !== ""}
            <div
              {@attach bindSection("summary")}
              class="scroll-mt-5 font-serif text-[16.5px] leading-[1.65] text-[#2a2d30]"
            >
              {reportSummary}
            </div>
          {/if}

          {#if equityCompleteness !== undefined}
            <section {@attach bindSection("equityCompleteness")} class="mt-5 scroll-mt-5">
              <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-[#cfe0e3] pb-2">
                <span class="text-[11px] font-semibold uppercase tracking-[0.09em] text-primary">
                  Analysis completeness
                </span>
                <span class="font-mono text-[10px] text-[#8a8f96]">
                  as of {equityCompleteness.asOf}
                </span>
              </div>
              <div class="mt-3 flex flex-wrap gap-2 font-mono text-[10px]">
                <span class="rounded border px-2 py-1 {COMPLETENESS_STATUS_CLASSES[equityCompleteness.financialCoreStatus]}">
                  financial core · {equityCompleteness.financialCoreStatus}
                </span>
                <span class="rounded border border-border bg-secondary px-2 py-1 text-foreground">
                  coverage · {equityCompleteness.coverageLevel}
                </span>
              </div>
              <div class="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {#each equityCompleteness.dimensions as dimension}
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
                          <div>{reason.replaceAll("-", " ")}</div>
                        {/each}
                      </div>
                    {/if}
                    <div class="mt-2 font-mono text-[9px] leading-snug text-[#8a8f96]">
                      {dimension.asOf}
                      {#if dimension.sourceIds.length > 0}
                        · {dimension.sourceIds.join(", ")}
                      {/if}
                    </div>
                  </div>
                {/each}
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

          {#if findingItems.length > 0}
            <section {@attach bindSection("findings")} class="mt-8.5 scroll-mt-5">
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

          {#if caseSections.length > 0}
            <div {@attach bindSection("cases")} class="mt-8.5 grid scroll-mt-5 gap-3.5 sm:grid-cols-2">
              {#each caseSections as section}
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
            <section {@attach bindSection("webSubjectProfile")} class="mt-8.5 scroll-mt-5">
              <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-[#d9c89a] pb-2">
                <span class="text-[11px] font-semibold uppercase tracking-[0.09em] text-[#8a6116]">
                  Web Subject Profile
                </span>
                <span class="font-mono text-[10px] text-[#8a8f96]">
                  low-trust web evidence
                  {#if webSubjectProfile.generatedAt !== undefined}
                    · {formatDateMinute(webSubjectProfile.generatedAt)}
                  {/if}
                </span>
              </div>
              {#if webSubjectProfile.subjectLabel !== undefined}
                <div class="mt-3 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                  {webSubjectProfile.subjectLabel}
                </div>
              {/if}
              {#if webSubjectProfile.subjectSummary !== undefined}
                <div
                  class="mt-3 rounded-lg border border-[#e9ddc2] bg-[#fbf6ea] px-4 py-3 text-[13px] leading-[1.55] text-[#4a4334]"
                >
                  {webSubjectProfile.subjectSummary.answer}
                  {@render citeChips(webSubjectProfile.subjectSummary.sourceIds)}
                </div>
              {/if}
              <div class="mt-3.5 grid gap-3 sm:grid-cols-2">
                {#each webSubjectProfile.questions as question}
                  <div class="rounded-lg border border-border bg-card px-4 py-3.5">
                    <div class="text-[12.5px] font-semibold text-foreground">
                      {question.label}
                    </div>
                    <div class="mt-2 font-serif text-[13px] leading-[1.55] text-[#45494e]">
                      {question.answer}
                    </div>
                    {@render citeChips(question.sourceIds)}
                  </div>
                {/each}
              </div>
              {#if webSubjectProfile.recentMaterialEvents.length > 0}
                <div class="mt-4">
                  <div class="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[#8a6116]">
                    Recent material events
                  </div>
                  <div class="mt-2 space-y-2">
                    {#each webSubjectProfile.recentMaterialEvents as event}
                      <div
                        class="rounded-lg border border-[#e9ddc2] bg-[#fbf6ea] px-4 py-2.5 text-[12.5px] text-[#4a4334]"
                      >
                        {event.claim}
                        {@render citeChips(event.sourceIds)}
                      </div>
                    {/each}
                  </div>
                </div>
              {/if}
              {#if webSubjectProfile.factLedger.length > 0}
                <div class="mt-4">
                  <div class="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[#8a6116]">
                    Fact ledger
                  </div>
                  <div class="mt-2 space-y-2">
                    {#each webSubjectProfile.factLedger as fact}
                      <div class="rounded-lg border border-border bg-card px-4 py-2.5 text-[12.5px] text-[#45494e]">
                        {fact.claim}
                        {@render citeChips(fact.sourceIds)}
                      </div>
                    {/each}
                  </div>
                </div>
              {/if}
              {#if webSubjectProfile.openGaps.length > 0}
                <div class="mt-3 rounded-lg border border-dashed border-[#d9c89a] bg-[#fbf6ea] px-4 py-3">
                  <div class="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[#8a6116]">
                    Profile gaps
                  </div>
                  <div class="space-y-1 text-[12.5px] text-[#5c6066]">
                    {#each webSubjectProfile.openGaps as gap}
                      <div>{gap}</div>
                    {/each}
                  </div>
                </div>
              {/if}
            </section>
          {/if}

          {#if businessFramework !== undefined}
            <section {@attach bindSection("businessFramework")} class="mt-8.5 scroll-mt-5">
              <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-[#cfe0e3] pb-2">
                <span class="text-[11px] font-semibold uppercase tracking-[0.09em] text-primary">
                  Business framework
                </span>
                <span class="font-mono text-[10px] text-[#8a8f96]">
                  phase · {businessFramework.phase}
                </span>
              </div>
              <div class="mt-3.5 grid gap-3 sm:grid-cols-2">
                {#each businessFramework.sections as section}
                  <div class="rounded-lg border border-border bg-card px-4 py-3.5">
                    <div class="flex flex-wrap items-center gap-2">
                      {#if section.name !== "Phase"}
                        <span
                          class="rounded border border-[#cfe0e3] bg-accent px-1.75 py-0.5 font-mono text-[10px] text-primary"
                        >
                          {section.posture.replaceAll("-", " ")}
                        </span>
                      {/if}
                      <div class="text-[12.5px] font-semibold text-foreground">
                        {section.name}
                      </div>
                    </div>
                    <div class="mt-2 font-serif text-[13px] leading-[1.55] text-[#45494e]">
                      {section.text ?? section.summary}
                    </div>
                    {#if section.metrics.length > 0}
                      <div class="mt-3 grid grid-cols-2 gap-2">
                        {#each section.metrics.slice(0, 4) as metric}
                          <div class="rounded-md border border-border bg-secondary px-2.5 py-2">
                            <div class="font-mono text-[12px] font-medium text-foreground">
                              {metric.value}
                            </div>
                            <div class="mt-0.5 text-[9.5px] uppercase tracking-wider text-muted-foreground">
                              {metric.label}
                            </div>
                          </div>
                        {/each}
                      </div>
                    {/if}
                    {@render citeChips(section.sourceIds)}
                    {#if section.gaps.length > 0}
                      <div class="mt-2 space-y-1 font-mono text-[10px] leading-normal text-[#8a6116]">
                        {#each section.gaps as gap}
                          <div>{gap}</div>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
              {#if businessFramework.gaps.length > 0}
                <div class="mt-3 rounded-lg border border-dashed border-[#d9c89a] bg-[#fbf6ea] px-4 py-3">
                  <div class="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[#8a6116]">
                    Framework data gaps
                  </div>
                  <div class="space-y-1 text-[12.5px] text-[#5c6066]">
                    {#each businessFramework.gaps as gap}
                      <div>{gap}</div>
                    {/each}
                  </div>
                </div>
              {/if}
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
            <section {@attach bindSection("forecasts")} class="mt-8.5 scroll-mt-5">
              <div class="flex items-baseline justify-between border-b border-border pb-2">
                <div class="flex items-center gap-2">
                  <span class="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
                    Observable forecasts
                  </span>
                  {#if targetHealth !== undefined && !targetHealth.targetMet}
                    <span
                      class="rounded border border-[#d9c89a] bg-[#f5ecd6] px-1.5 py-px font-mono text-[10px] text-[#8a6116]"
                    >
                      BELOW TARGET
                    </span>
                  {/if}
                </div>
                <span class="font-mono text-[10px] text-[#a8acb1]">
                  {#if targetHealth !== undefined}
                    {targetHealth.count} / {targetHealth.target} target ·
                  {/if}
                  {#if forecastStats.resolved > 0}
                    scored {forecastStats.resolved}/{forecastStats.total} ·
                    {forecastStats.hits} event true · {forecastStats.misses} event false ·
                    {#if forecastStats.voided > 0}
                      {forecastStats.voided} voided ·
                    {/if}
                  {/if}
                  td = trading days
                </span>
              </div>
              {#if forecastItems.length === 0}
                <div class="py-4 text-sm text-muted-foreground">No forecasts emitted for this run.</div>
              {/if}
              {#each groupedForecastItems as group}
                {#if group.antecedent !== undefined}
                  <div
                    class="border-b border-[#f0ede7] bg-[#fbfaf7] px-2 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-[#5c6066]"
                  >
                    If {group.antecedent}
                  </div>
                {/if}
                {#each group.forecasts as forecast}
                  <div
                    class="grid items-center gap-2 border-b border-[#f0ede7] py-3 sm:grid-cols-[minmax(0,1fr)_110px_130px_64px_132px] sm:gap-4"
                  >
                    <div class="font-serif text-sm leading-normal text-[#1f2225]">
                      {forecast.claim}
                      {@render citeChips(forecast.sourceIds)}
                      {#if forecast.score?.resolved === true && forecast.score.close0 !== undefined && forecast.score.closeN !== undefined}
                        <span class="mt-1 block font-mono text-[10.5px] text-[#8a8f96]">
                          close {formatClose(forecast.score.close0)} → {formatClose(forecast.score.closeN)}
                          {#if forecast.score.changePct !== undefined}
                            ({forecast.score.changePct > 0 ? "+" : ""}{forecast.score.changePct.toFixed(1)}%)
                          {/if}
                          {#if forecast.score.observedAt !== undefined}
                            · observed {formatDateMinute(forecast.score.observedAt)}
                          {/if}
                        </span>
                      {/if}
                      {#if forecast.missAutopsy !== undefined}
                        <span class="mt-1 block text-[11.5px] leading-normal text-[#5c6066]">
                          Autopsy: {forecast.missAutopsy.rationale}
                        </span>
                      {/if}
                    </div>
                    <div>
                      {#if forecast.kind !== undefined}
                        <span
                          class="rounded border border-border bg-secondary px-1.75 py-0.5 font-mono text-[10px] text-[#5c6066]"
                        >
                          {forecast.kind}
                        </span>
                      {/if}
                      <div class="mt-1 flex flex-wrap gap-1">
                        {#each subjectSymbols(forecast.subject) as symbol}
                          <button
                            class="rounded border border-[#cfe0e3] bg-accent px-1.5 py-0.5 font-mono text-[9.5px] text-primary hover:border-[#9fc2c8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            type="button"
                            onclick={() => onOpenInstrument(detail.summary.assetClass ?? "", symbol)}
                          >
                            {symbol}
                          </button>
                        {/each}
                      </div>
                    </div>
                    <div class="flex items-center gap-2">
                      {#if forecast.probability !== undefined}
                        {@const pct = Math.round(forecast.probability * 100)}
                        <div class="h-1 flex-1 rounded-sm bg-[#f0ede7]">
                          <div class="h-1 rounded-sm bg-[#4ba3b2]" style="width: {pct}%"></div>
                        </div>
                        <span class="w-8.5 text-right font-mono text-xs font-medium">{pct}%</span>
                      {/if}
                    </div>
                    <div class="text-left font-mono text-[11.5px] text-[#5c6066] sm:text-right">
                      {forecast.horizonTradingDays === undefined ? "" : `${forecast.horizonTradingDays} td`}
                    </div>
                    <div class="flex flex-wrap gap-1.5 sm:justify-end">
                      {#if forecast.score?.outcome === "hit"}
                        <span
                          class="rounded border border-[#9fc2c8] bg-[#e7f1f3] px-1.75 py-0.5 font-mono text-[10px] text-[#166e7d]"
                        >
                          EVENT TRUE
                        </span>
                      {:else if forecast.score?.outcome === "miss"}
                        <span
                          class="rounded border border-border bg-secondary px-1.75 py-0.5 font-mono text-[10px] text-[#5c6066]"
                        >
                          EVENT FALSE
                        </span>
                      {:else if forecast.score?.status === "voided"}
                        <span
                          class="rounded border border-[#d9c89a] bg-[#fbf6ea] px-1.75 py-0.5 font-mono text-[10px] text-[#8a6116]"
                          title={forecast.score?.pendingReason ?? "condition unmet"}
                        >
                          VOIDED
                        </span>
                      {:else if forecast.score?.status === "active-pending"}
                        <span
                          class="rounded border border-dashed border-[#9fc2c8] px-1.75 py-0.5 font-mono text-[10px] text-[#166e7d]"
                          title={forecast.score?.pendingReason ?? "condition met; consequent pending"}
                        >
                          ACTIVE
                        </span>
                      {:else if forecast.score?.status === "pending-condition"}
                        <span
                          class="rounded border border-dashed border-[#c9c4ba] px-1.75 py-0.5 font-mono text-[10px] text-[#8a8f96]"
                          title={forecast.score?.pendingReason ?? "condition pending"}
                        >
                          CONDITION PENDING
                        </span>
                      {:else if forecast.score?.status === "abandoned"}
                        <span
                          class="rounded border border-[#d9c89a] bg-[#fbf6ea] px-1.75 py-0.5 font-mono text-[10px] text-[#8a6116]"
                          title={forecast.score?.pendingReason ?? "scoring abandoned"}
                        >
                          ABANDONED
                        </span>
                      {:else}
                        <span
                          class="rounded border border-dashed border-[#c9c4ba] px-1.75 py-0.5 font-mono text-[10px] text-[#8a8f96]"
                          title={forecast.score?.pendingReason ?? "not yet scored"}
                        >
                          PENDING
                        </span>
                      {/if}
                      {#if forecast.forecastDisagreement !== undefined}
                        <span
                          class="rounded border px-1.75 py-0.5 font-mono text-[10px] {DISAGREEMENT_BADGE_CLASSES[
                            forecast.forecastDisagreement.band
                          ]}"
                          title="Forecast Disagreement: {forecast.forecastDisagreement.band} spread; mean {percent(
                            forecast.forecastDisagreement.meanProbability,
                          )}; spread {spreadPoints(forecast.forecastDisagreement.probabilitySpread)}; {forecast
                            .forecastDisagreement.participantCount} model probabilities"
                        >
                          FD {forecast.forecastDisagreement.band.toUpperCase()}
                          {spreadPoints(forecast.forecastDisagreement.probabilitySpread)}
                        </span>
                      {/if}
                      {#if forecast.missAutopsy !== undefined}
                        <span
                          class="rounded border border-[#d9c89a] bg-[#fbf6ea] px-1.75 py-0.5 font-mono text-[10px] text-[#8a6116]"
                          title={forecast.missAutopsy.supportingSignals.join("; ") || forecast.missAutopsy.rationale}
                        >
                          AUTOPSY {forecast.missAutopsy.cause}
                        </span>
                      {/if}
                    </div>
                  </div>
                {/each}
              {/each}
            </section>
          {/if}

          {#if showGapsSection}
            <section {@attach bindSection("gaps")} class="mt-8.5 scroll-mt-5">
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

              {#if splitGaps.otherGaps.length > 0}
                <div
                  class="border-b border-[#e9ddc2] pb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-[#8a6116] {splitGaps
                    .shortfalls.length > 0
                    ? 'mt-8'
                    : ''}"
                >
                  Data gaps · what we could not verify
                </div>
                <div class="mt-3.5 flex flex-col gap-2.5">
                  {#each splitGaps.otherGaps as gap}
                    <div class="flex gap-3 rounded-lg border border-dashed border-[#d9c89a] bg-[#fbf6ea] px-4 py-3">
                      <span
                        class="h-fit shrink-0 rounded border border-[#d9c89a] bg-[#f5ecd6] px-1.5 py-px font-mono text-[10px] text-[#8a6116]"
                      >
                        GAP
                      </span>
                      <div class="font-serif text-sm leading-[1.55] text-[#4a4334]">
                        {gap}
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
