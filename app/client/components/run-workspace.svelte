<script lang="ts">
  import { Skeleton } from "$lib/components/ui/skeleton";
  import type { RunDetail } from "../../types";
  import {
    extendedEvidenceItems,
    forecastRollup,
    forecastGroups,
    formatClose,
    formatDate,
    formatDateMinute,
    horizonMarkers,
    jsonBlock,
    predictionTargetHealth,
    runLabel,
    scenarios,
    scoredForecasts,
    sources,
    formatShortfallGap,
    splitDataGaps,
    stringArray,
    textItems,
    valuationMetricTiles,
    type SnapshotView,
  } from "../view-model";
  import { DATA_SEGMENTS, TABS, type DataSegment, type Tab } from "./console-types";
  import PriceSnapshotChart from "./price-snapshot-chart.svelte";

  interface Props {
    readonly activeTab: Tab;
    readonly detail: RunDetail | null;
    readonly snapshot: SnapshotView | null;
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
    snapshot,
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

  const report = $derived(detail?.report);
  const reportSummary = $derived(typeof report?.summary === "string" ? report.summary : "");
  const findingItems = $derived(textItems(report, "keyFindings"));
  const scenarioItems = $derived(scenarios(report));
  const forecastItems = $derived(scoredForecasts(report, detail?.score, detail?.missAutopsy));
  const groupedForecastItems = $derived(forecastGroups(forecastItems));
  const forecastStats = $derived(forecastRollup(forecastItems));
  const forecastHorizons = $derived(horizonMarkers(forecastItems));
  const sourceItems = $derived(sources(report));
  const gapItems = $derived(stringArray(report, "dataGaps"));
  const splitGaps = $derived(splitDataGaps(gapItems));
  const extendedEvidence = $derived(extendedEvidenceItems(report));
  const targetHealth = $derived(predictionTargetHealth(detail?.analytics, report));
  const showForecastsSection = $derived(
    forecastItems.length > 0 || splitGaps.shortfalls.length > 0 || targetHealth !== undefined,
  );

  const CASE_STYLES = [
    { key: "bullCase", title: "Bull case", edge: "#4ba3b2", fg: "#166e7d" },
    { key: "bearCase", title: "Bear case", edge: "#8a8f96", fg: "#5c6066" },
    { key: "risks", title: "Risks", edge: "#c4b389", fg: "#8a6116" },
    { key: "catalysts", title: "Catalysts", edge: "#9fc2c8", fg: "#166e7d" },
  ] as const;

  const caseSections = $derived(
    CASE_STYLES.map((style) => ({ ...style, items: textItems(report, style.key) })).filter(
      (section) => section.items.length > 0,
    ),
  );

  const tocEntries = $derived(
    [
      ["summary", "Summary", reportSummary !== ""],
      ["findings", "Key findings", findingItems.length > 0],
      ["cases", "Cases & risks", caseSections.length > 0],
      ["scenarios", "Scenarios", scenarioItems.length > 0],
      ["snapshot", "Market snapshot", snapshot !== null],
      ["extendedEvidence", "Extended evidence", extendedEvidence.length > 0],
      ["forecasts", "Forecasts", showForecastsSection],
      ["gaps", "Data gaps", splitGaps.otherGaps.length > 0 || splitGaps.shortfalls.length > 0],
    ] as const,
  );

  const TAB_LABELS: Record<Tab, string> = {
    report: "Report",
    sources: "Sources",
    data: "Data",
    files: "Files",
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
  <div
    class="border-b border-border pb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground"
  >
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
  <div
    class="rounded-lg border border-dashed border-input p-9 text-center text-sm text-muted-foreground"
  >
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
        <h1 class="text-[21px] font-semibold tracking-tight">{runLabel(detail.summary)}</h1>
        <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#5c6066]">
          <span>{formatDate(detail.summary.generatedAt)}</span>
          {#if detail.summary.assetClass !== undefined && detail.summary.symbol !== undefined}
            <button
              class="rounded border border-[#cfe0e3] bg-accent px-1.75 py-0.5 font-mono text-[10px] text-primary hover:border-[#9fc2c8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              type="button"
              onclick={() =>
                onOpenInstrument(detail.summary.assetClass ?? "", detail.summary.symbol ?? "")}
            >
              {detail.summary.assetClass}:{detail.summary.symbol}
            </button>
          {/if}
        </div>
      </div>
      <div class="flex gap-5.5">
        {#each [
          { value: detail.summary.confidence ?? "—", label: "Confidence" },
          { value: String(detail.summary.sourceCount), label: "Sources" },
          { value: String(detail.summary.availableFiles.length), label: "Files" },
        ] as stat}
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
      <div class="mt-6 grid gap-11 xl:grid-cols-[minmax(0,720px)_200px]">
        <article class="min-w-0">
          {#if reportSummary !== ""}
            <div
              {@attach bindSection("summary")}
              class="scroll-mt-5 font-serif text-[16.5px] leading-[1.65] text-[#2a2d30]"
            >
              {reportSummary}
            </div>
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
            <div
              {@attach bindSection("cases")}
              class="mt-8.5 grid scroll-mt-5 gap-3.5 sm:grid-cols-2"
            >
              {#each caseSections as section}
                <div
                  class="rounded-lg border border-border bg-card px-4.5 py-4"
                  style="border-top: 2px solid {section.edge}"
                >
                  <div
                    class="text-xs font-semibold uppercase tracking-wider"
                    style="color: {section.fg}"
                  >
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
                    <div class="text-[12.5px] font-semibold text-foreground">{scenario.name}</div>
                    <div class="mt-2 font-serif text-[13px] leading-[1.55] text-[#45494e]">
                      {scenario.description}
                    </div>
                    {@render citeChips(scenario.sourceIds)}
                  </div>
                {/each}
              </div>
            </section>
          {/if}

          {#if snapshot !== null}
            <section {@attach bindSection("snapshot")} class="mt-8.5 scroll-mt-5">
              <div class="flex items-baseline justify-between border-b border-border pb-2">
                <span
                  class="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground"
                >
                  Market snapshot · {snapshot.symbol}
                </span>
                <span class="font-mono text-[10px] text-[#a8acb1]">
                  recent closes{snapshot.latestSessionDate === undefined
                    ? ""
                    : ` · last session ${snapshot.latestSessionDate}`} · ticks mark forecast horizons
                </span>
              </div>
              <PriceSnapshotChart {snapshot} horizons={forecastHorizons} />
            </section>
          {/if}

          {#if extendedEvidence.length > 0}
            <section {@attach bindSection("extendedEvidence")} class="mt-8.5 scroll-mt-5">
              {@render sectionHeading("Extended evidence")}
              <div class="mt-3.5 grid gap-3 sm:grid-cols-2">
                {#each extendedEvidence as item}
                  {@const metricTiles =
                    item.category === "valuation" ? valuationMetricTiles(item.metrics) : []}
                  <div class="rounded-lg border border-border bg-card px-4 py-3.5">
                    <div class="flex flex-wrap items-center gap-2">
                      <span
                        class="rounded border border-border bg-secondary px-1.75 py-0.5 font-mono text-[10px] text-[#5c6066]"
                      >
                        {item.category}
                      </span>
                      <div class="text-[12.5px] font-semibold text-foreground">{item.title}</div>
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
                            <div
                              class="mt-0.5 text-[9.5px] uppercase tracking-wider text-muted-foreground"
                            >
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
                  <span
                    class="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground"
                  >
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
                <div class="py-4 text-sm text-muted-foreground">
                  No forecasts emitted for this run.
                </div>
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
                  <div class="font-serif text-sm leading-[1.5] text-[#1f2225]">
                    {forecast.claim}
                    {@render citeChips(forecast.sourceIds)}
                    {#if forecast.score?.resolved === true && forecast.score.close0 !== undefined && forecast.score.closeN !== undefined}
                      <span class="mt-1 block font-mono text-[10.5px] text-[#8a8f96]">
                        close {formatClose(forecast.score.close0)} → {formatClose(
                          forecast.score.closeN,
                        )}
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
                          onclick={() =>
                            onOpenInstrument(detail.summary.assetClass ?? "", symbol)}
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
                    {forecast.horizonTradingDays === undefined
                      ? ""
                      : `${forecast.horizonTradingDays} td`}
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
                        )}; spread {spreadPoints(
                          forecast.forecastDisagreement.probabilitySpread,
                        )}; {forecast.forecastDisagreement.participantCount} model probabilities"
                      >
                        FD {forecast.forecastDisagreement.band.toUpperCase()} {spreadPoints(
                          forecast.forecastDisagreement.probabilitySpread,
                        )}
                      </span>
                    {/if}
                    {#if forecast.missAutopsy !== undefined}
                      <span
                        class="rounded border border-[#d9c89a] bg-[#fbf6ea] px-1.75 py-0.5 font-mono text-[10px] text-[#8a6116]"
                        title={forecast.missAutopsy.supportingSignals.join("; ") ||
                          forecast.missAutopsy.rationale}
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

          {#if splitGaps.shortfalls.length > 0 || splitGaps.otherGaps.length > 0}
            <section {@attach bindSection("gaps")} class="mt-8.5 scroll-mt-5">
              {#if splitGaps.shortfalls.length > 0}
                <div
                  class="border-b border-[#e9ddc2] pb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-[#8a6116]"
                >
                  Prediction shortfall
                </div>
                <div class="mt-3.5 flex flex-col gap-2.5">
                  {#each splitGaps.shortfalls as gap}
                    <div
                      class="flex gap-3 rounded-lg border border-dashed border-[#d9c89a] bg-[#fbf6ea] px-4 py-3"
                    >
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
                  class="border-b border-[#e9ddc2] pb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-[#8a6116] {splitGaps.shortfalls.length >
                  0
                    ? 'mt-8'
                    : ''}"
                >
                  Data gaps · what we could not verify
                </div>
                <div class="mt-3.5 flex flex-col gap-2.5">
                  {#each splitGaps.otherGaps as gap}
                    <div
                      class="flex gap-3 rounded-lg border border-dashed border-[#d9c89a] bg-[#fbf6ea] px-4 py-3"
                    >
                      <span
                        class="h-fit shrink-0 rounded border border-[#d9c89a] bg-[#f5ecd6] px-1.5 py-px font-mono text-[10px] text-[#8a6116]"
                      >
                        GAP
                      </span>
                      <div class="font-serif text-sm leading-[1.55] text-[#4a4334]">{gap}</div>
                    </div>
                  {/each}
                </div>
              {/if}
            </section>
          {/if}

          {#if detail.markdown !== undefined}
            <section class="mt-8.5">
              {@render sectionHeading("Raw markdown")}
              <pre
                class="mt-3.5 max-h-130 overflow-auto rounded-lg bg-[#16181a] p-4.5 font-mono text-xs leading-relaxed text-[#c7cdd4]">{detail.markdown}</pre>
            </section>
          {/if}
        </article>

        <aside class="sticky top-6 hidden h-fit pt-1 xl:block">
          <div class="font-mono text-[10px] tracking-[0.08em] text-[#a8acb1]">ON THIS PAGE</div>
          <div class="mt-2.5 flex flex-col gap-0.5 border-l border-border">
            {#each tocEntries as [key, label, available]}
              {#if available}
                <button
                  class="-ml-px border-l-2 border-transparent py-1 pl-3 text-left text-xs text-[#5c6066] transition hover:border-[#9fc2c8] hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  type="button"
                  onclick={() => scrollToSection(key)}
                >
                  {label}
                </button>
              {/if}
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
              <div class="px-4.5 py-6 text-sm text-muted-foreground">
                This run cites no normalized sources.
              </div>
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
                <div
                  class="truncate font-mono text-[11.5px] font-medium text-primary"
                  title={source.id}
                >
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
                <div class="truncate text-xs text-[#5c6066]">{source.provider ?? ""}</div>
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
    {:else}
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
  </div>

  {#if cite !== null}
    <div
      class="pointer-events-none fixed z-50 w-72 rounded-lg border border-input bg-popover px-3.75 py-3 shadow-[0_6px_24px_rgba(26,28,30,0.14)]"
      style="left: {cite.x}px; top: {cite.y}px"
      role="tooltip"
    >
      <div class="flex items-center gap-2">
        <span
          class="rounded border border-[#cfe0e3] bg-accent px-1.5 font-mono text-[10px] text-primary"
        >
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
