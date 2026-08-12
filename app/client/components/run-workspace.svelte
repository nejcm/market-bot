<script lang="ts">
  import { Skeleton } from "$lib/components/ui/skeleton";
  import type { RunDetail } from "../../types";
  import type { ReportDetail } from "../app-settings";
  import { formatDate, jsonBlock, runLabel } from "../view-model";
  import { buildRunWorkspaceView } from "../run-workspace-view";
  import { DATA_SEGMENTS, TABS, type DataSegment, type Tab } from "./console-types";
  import RunChat from "./run-chat.svelte";
  import ObservableForecasts from "./observable-forecasts.svelte";
  import WebSubjectProfile from "./web-subject-profile.svelte";
  import BusinessFramework from "./business-framework.svelte";
  import CaseCards from "./case-cards.svelte";
  import CoverageGapsAdvanced from "./coverage-gaps-advanced.svelte";
  import CoverageGapsSimple from "./coverage-gaps-simple.svelte";
  import EquityLedger from "./equity-ledger.svelte";
  import EquityCompleteness from "./equity-completeness.svelte";
  import EquityMetrics from "./equity-metrics.svelte";
  import FinancialLensStats from "./financial-lens-stats.svelte";
  import FundamentalHistory from "./fundamental-history.svelte";
  import BalanceSheetHistory from "./balance-sheet-history.svelte";
  import ValuationWorkbench from "./valuation-workbench.svelte";
  import ReverseDcf from "./reverse-dcf.svelte";
  import PeerImpliedRange from "./peer-implied-range.svelte";
  import MarketSnapshot from "./market-snapshot.svelte";
  import AnalystEstimateDistributions from "./analyst-estimate-distributions.svelte";
  import ExtendedEvidence from "./extended-evidence.svelte";

  interface Props {
    readonly activeTab: Tab;
    readonly reportDetail?: ReportDetail;
    readonly showSources?: boolean;
    readonly detail: RunDetail | null;
    readonly loadingDetail: boolean;
    readonly selectedFile: string;
    readonly fileContent: string;
    readonly highlightSourceId: string;
    readonly onTabChange: (tab: Tab) => void;
    readonly onReportDetailChange?: (value: ReportDetail) => void;
    readonly onShowSourcesChange?: (value: boolean) => void;
    readonly onLoadFile: (path: string) => void;
    readonly onGoHome: () => void;
    readonly onHighlightSource: (sourceId: string) => void;
    readonly onOpenInstrument: (assetClass: string, symbol: string) => void;
  }

  let {
    activeTab,
    reportDetail = "simple",
    showSources = false,
    detail,
    loadingDetail,
    selectedFile,
    fileContent,
    highlightSourceId,
    onTabChange,
    onReportDetailChange = () => {},
    onShowSourcesChange = () => {},
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
  // The equity ledger carries its own verdict bar, so the shared run header
  // would repeat the same name, price and counts directly above it.
  const showRunHeader = $derived(equityPresentation === undefined || activeTab !== "report");
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

  const caseSections = $derived(workspace?.report.cases ?? []);
  const defaultCaseSections = $derived(
    caseSections.filter((section) => section.key === "catalysts" || section.key === "risks"),
  );
  const readerCaseSections = $derived(
    reportDetail === "advanced"
      ? ["risks", "catalysts", "bullCase", "bearCase"].flatMap((key) =>
          caseSections.filter((section) => section.key === key),
        )
      : defaultCaseSections,
  );

  const tocEntries = $derived(
    (workspace?.tableOfContents ?? []).filter(
      (entry) => reportDetail === "advanced" || !entry.advancedOnly,
    ),
  );

  // The ledger nav is one horizontal strip, so it carries the sections a reader
  // jumps between; the long tail stays reachable by scrolling the report.
  const LEDGER_NAV_KEYS: ReadonlySet<string> = new Set([
    "equityOverview",
    "summary",
    "financialTrends",
    "findings",
    "cases",
    "earningsConsensus",
    "snapshot",
    "advancedSummary",
    "equityCompleteness",
    "equityMetrics",
    "financialLensStats",
    "fundamentalHistory",
    "valuationWorkbench",
    "forecasts",
    "gaps",
  ]);
  const ledgerNavEntries = $derived(
    tocEntries.filter((entry) => LEDGER_NAV_KEYS.has(entry.key)).slice(0, 15),
  );

  // The control only governs the Report tab, so it stays out of the tab row on
  // the others; the wrapper collapses with it to leave their layout untouched.
  const showReportDetailToggle = $derived(equityPresentation !== undefined && activeTab === "report");

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

{#snippet switchToggle(
  label: string,
  offLabel: string,
  onLabel: string,
  checked: boolean,
  onToggle: (next: boolean) => void,
)}
  <div class="flex items-center gap-2.5" role="group" aria-label={label}>
    <span
      class="font-mono text-[10px] uppercase tracking-[0.12em] {checked
        ? 'text-muted-foreground'
        : 'text-foreground'}"
    >
      {offLabel}
    </span>
    <button
      class="relative h-4 w-7.5 border border-input bg-secondary transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label="{onLabel} toggle"
      onclick={() => onToggle(!checked)}
    >
      <span
        class="absolute top-0.5 h-2.5 w-2.5 bg-primary transition-all {checked
          ? 'left-4'
          : 'left-0.5'}"
      ></span>
    </button>
    <span
      class="font-mono text-[10px] uppercase tracking-[0.12em] {checked
        ? 'text-foreground'
        : 'text-muted-foreground'}"
    >
      {onLabel}
    </span>
  </div>
{/snippet}

{#snippet citeChips(sourceIds: readonly string[])}
  {#if showSources}
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
  {/if}
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
    <!-- One sticky chrome row: the run path on the left, the tabs on the right.
         Its fixed height is what the ledger's section nav sticks beneath. -->
    <div class="sticky top-0 z-30 flex h-11 items-center justify-between gap-4 bg-background">
      <div class="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
        <button
          class="text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          type="button"
          onclick={onGoHome}
        >
          runs
        </button>
        / {detail.summary.runId}
      </div>
      <div
        class="flex shrink-0 items-center gap-0.5 rounded-full border border-border bg-secondary p-0.75"
        role="tablist"
      >
        {#each TABS as tab}
          <button
            class="rounded-full px-3.5 py-1 text-[12.5px] transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {activeTab ===
            tab
              ? 'bg-foreground font-semibold text-background'
              : 'font-normal text-muted-foreground'}"
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            onclick={() => onTabChange(tab)}
          >
            {TAB_LABELS[tab]}
          </button>
        {/each}
      </div>
    </div>

    {#if activeTab === "report"}
      <div class="mt-3 flex flex-wrap items-center justify-end gap-x-7 gap-y-1">
        {#if showReportDetailToggle}
          {@render switchToggle(
            "Report detail",
            "Simple",
            "Advanced",
            reportDetail === "advanced",
            (next) => onReportDetailChange(next ? "advanced" : "simple"),
          )}
        {/if}
        {@render switchToggle("Source chips", "Sources off", "Sources on", showSources, onShowSourcesChange)}
      </div>
    {/if}

    {#if showRunHeader}
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
    {/if}


    {#if activeTab === "report"}
      <div
        class={equityPresentation === undefined
          ? "mt-6 grid gap-11 xl:grid-cols-[minmax(0,820px)_200px]"
          : "mt-6"}
      >
          <article class="min-w-0">
            {#if equityPresentation !== undefined}
              <EquityLedger
                summary={detail.summary}
                displayName={workspace?.equityHeader?.displayName ?? runLabel(detail.summary)}
                presentation={equityPresentation}
                {reportDetail}
                caseSections={readerCaseSections}
                {sourceItems}
                {snapshot}
                {snapshotTradingViewUrl}
                {forecastHorizons}
                peerSupportability={valuationWorkbench?.peerSupportability}
                tocEntries={ledgerNavEntries}
                {citeChips}
                {bindSection}
                onScrollToSection={scrollToSection}
                {onOpenInstrument}
              >
                {#if equityPresentation.defaultView.earningsConsensus.items.length > 0}
                  <section {@attach bindSection("earningsConsensus")} class="scroll-mt-24">
                    {@render sectionHeading("Upcoming earnings & consensus")}
                    <div class="mt-3 grid gap-2 sm:grid-cols-2">
                      {#each equityPresentation.defaultView.earningsConsensus.items as item}
                        <div class="border border-border bg-secondary px-3.5 py-3">
                          <div
                            class="text-[10px] font-semibold uppercase tracking-wider text-[#5c6066]"
                          >
                            {item.label}
                          </div>
                          <div class="mt-1.5 font-mono text-[12px]">{item.value}</div>
                          {@render citeChips(item.sourceIds)}
                        </div>
                      {/each}
                    </div>
                  </section>
                {/if}

                {#if reportDetail === "advanced"}
                  {@render reportBody()}
                {/if}
              </EquityLedger>

            <!-- Coverage gaps and the raw markdown stay outside the sheet. -->
            {#if reportDetail === "simple"}
              <div class="ledger-extras mt-7 border border-border bg-card px-7 pb-7 pt-1 shadow-[0_1px_0_#e4e0d6]">
                <CoverageGapsSimple
                  materialGaps={equityPresentation.defaultView.materialGaps}
                  financialCoreStatus={equityPresentation.defaultView.financialCoreStatus}
                  sectionKey="gaps"
                  {bindSection}
                />
              </div>
            {:else}
              <div class="ledger-extras mt-7 border border-border bg-card px-7 pb-7 pt-6 shadow-[0_1px_0_#e4e0d6]">
                {@render reportTail()}
              </div>
            {/if}
          {:else}
            {@render reportBody()}
            {@render reportTail()}
          {/if}
        </article>

          {#snippet reportBody()}
            {#if reportSummary !== ""}
              {#if equityPresentation !== undefined}
                {@render sectionHeading("Report summary")}
              {/if}
              <div
                {@attach bindSection(reportSummarySectionKey)}
                class="scroll-mt-5 font-serif text-[16.5px] leading-[1.65] text-[#2a2d30]"
            >
              {reportSummary}
            </div>
          {/if}

          {#if appendixCompleteness !== undefined}
            <EquityCompleteness
              completeness={appendixCompleteness}
              sectionKey="equityCompleteness"
              {citeChips}
              {bindSection}
            />
          {/if}

          {#if equityPresentation !== undefined}
            <EquityMetrics
              keyDatedMetrics={equityPresentation.advanced.keyDatedMetrics}
              miniCharts={equityPresentation.advanced.miniCharts}
              financialLensDrivers={equityPresentation.advanced.financialLensDrivers}
              sectionKey="equityMetrics"
              {citeChips}
              {bindSection}
            />
          {/if}

          {#if financialLensGroups.length > 0}
            <FinancialLensStats
              groups={financialLensGroups}
              sectionKey="financialLensStats"
              {bindSection}
            />
          {/if}

          {#if fundamentalHistory !== undefined}
            <FundamentalHistory
              history={fundamentalHistory}
              sectionKey="fundamentalHistory"
              {bindSection}
            />
          {/if}

          {#if equityPresentation?.advanced.balanceSheetHistory !== undefined}
            <BalanceSheetHistory
              history={equityPresentation.advanced.balanceSheetHistory}
              sectionKey="balanceSheetHistory"
              {citeChips}
              {bindSection}
            />
          {/if}

          {#if valuationWorkbench !== undefined}
            <ValuationWorkbench
              workbench={valuationWorkbench}
              excludedPeerRows={valuationWorkbench.excludedPeerRows}
              sectionKey="valuationWorkbench"
              {citeChips}
              {bindSection}
            />
          {/if}

          {#if reverseDcf !== undefined}
            <ReverseDcf {reverseDcf} sectionKey="reverseDcf" {bindSection} />
          {/if}

          {#if peerImpliedRange !== undefined}
            <PeerImpliedRange range={peerImpliedRange} sectionKey="peerImpliedRange" {bindSection} />
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

          {#if equityPresentation === undefined && caseSections.length > 0}
            <CaseCards
              items={caseSections}
              sectionKey="advancedCases"
              {citeChips}
              {bindSection}
            />
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

          {#if snapshot !== undefined && equityPresentation === undefined}
            <MarketSnapshot
              {snapshot}
              {snapshotTradingViewUrl}
              {forecastHorizons}
              sectionKey="snapshot"
              {bindSection}
            />
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
            <AnalystEstimateDistributions
              distributions={equityPresentation?.advanced.analystEstimateDistributions ?? []}
              sectionKey="analystEstimateDistributions"
              {citeChips}
              {sectionHeading}
              {bindSection}
            />
          {/if}

          {#if extendedEvidence.length > 0}
            <ExtendedEvidence
              items={extendedEvidence}
              sectionKey="extendedEvidence"
              {citeChips}
              {sectionHeading}
              {bindSection}
            />
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

          {/snippet}

          {#snippet reportTail()}
          {#if equityPresentation !== undefined || showGapsSection}
            <CoverageGapsAdvanced
              gaps={splitGaps}
              uppercaseTriage={equityPresentation !== undefined}
              financialCoreStatus={equityPresentation?.defaultView.financialCoreStatus}
              sectionKey="gaps"
              {bindSection}
            />
          {/if}

          {#if reportMarkdown !== undefined}
            <section {@attach bindSection("rawMarkdown")} class="mt-8.5 scroll-mt-5">
              {@render sectionHeading("Raw markdown")}
              <pre
                class="mt-3.5 max-h-130 overflow-auto rounded-lg bg-[#16181a] p-4.5 font-mono text-xs leading-relaxed text-[#c7cdd4]">{reportMarkdown}</pre>
            </section>
          {/if}
          {/snippet}

        {#if equityPresentation === undefined}
        <aside class="sticky top-6 hidden h-fit pt-1 xl:block">
          <div class="font-mono text-[10px] tracking-[0.08em] text-[#a8acb1]">ON THIS PAGE</div>
          <div class="mt-2.5 flex flex-col gap-0.5 border-l border-border">
            {#each tocEntries as entry, index}
              {#if reportDetail === "advanced" && entry.advancedOnly && tocEntries.findIndex((candidate) => candidate.advancedOnly) === index}
                <div class="mx-3 my-1 border-t border-border" aria-hidden="true"></div>
              {/if}
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
        {/if}
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
