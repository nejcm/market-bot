<script lang="ts">
  import {
    formatDateMinute,
    runCountsLabel,
    runLabel,
    type DashboardMetrics,
    type RunCompareCard,
    type RunTrendPoint,
  } from "../view-model";
  import type { RunSummary } from "../../types";
  import RunTrendChart from "./run-trend-chart.svelte";

  interface Props {
    readonly metrics: DashboardMetrics;
    readonly trend: readonly RunTrendPoint[];
    readonly recentRuns: readonly RunSummary[];
    readonly compareCards: readonly RunCompareCard[];
    readonly loadingRuns: boolean;
    readonly onOpenRun: (runId: string) => void;
    readonly onOpenInstrument: (assetClass: string, symbol: string) => void;
  }

  let {
    metrics,
    trend,
    recentRuns,
    compareCards,
    loadingRuns,
    onOpenRun,
    onOpenInstrument,
  }: Props = $props();

  const metricCards = $derived([
    {
      label: "Runs on disk",
      value: String(metrics.totalRuns),
      sub: `${String(metrics.scoredRuns)} scored`,
    },
    {
      label: "Forecasts",
      value: String(metrics.totalForecasts),
      sub: "observable, resolvable from price data",
    },
    {
      label: "Sources cited",
      value: String(metrics.totalSources),
      sub: `${String(metrics.equityRuns)} equity · ${String(metrics.cryptoRuns)} crypto runs`,
    },
    {
      label: "Open data gaps",
      value: String(metrics.totalDataGaps),
      sub: "shown, not hidden",
    },
  ]);
  const subtitle = $derived(
    `${String(metrics.totalRuns)} runs on disk · last run ${formatDateMinute(recentRuns[0]?.generatedAt)}`,
  );
</script>

<div data-screen-label="Dashboard">
  <div class="flex items-baseline justify-between">
    <h1 class="text-xl font-semibold tracking-tight">Dashboard</h1>
    <span class="font-mono text-[11px] text-muted-foreground">{subtitle}</span>
  </div>

  <div class="mt-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
    {#each metricCards as card}
      <div class="rounded-lg border border-border bg-card px-4 py-3.5">
        <div class="font-mono text-2xl font-medium text-foreground">{card.value}</div>
        <div class="mt-1 text-[11px] uppercase tracking-wider text-muted-foreground">
          {card.label}
        </div>
        <div class="mt-1.5 text-xs text-[#5c6066]">{card.sub}</div>
      </div>
    {/each}
  </div>

  <div class="mt-3.5 rounded-lg border border-border bg-card px-4.5 py-4">
    <div class="flex items-baseline justify-between">
      <span class="text-xs font-semibold">Runs per day</span>
      <span class="font-mono text-[10.5px] text-muted-foreground">recent dated runs</span>
    </div>
    <RunTrendChart points={trend} />
  </div>

  {#if compareCards.length > 0}
    <div class="mt-7 flex items-baseline justify-between">
      <h2 class="text-sm font-semibold">Run card compare</h2>
      <span class="text-xs text-muted-foreground">analytics.json</span>
    </div>
    <div class="mt-3 overflow-hidden rounded-lg border border-border bg-card">
      <div class="overflow-x-auto">
        <div class="min-w-180">
          <div
            class="grid grid-cols-[minmax(0,1.3fr)_84px_112px_118px_118px] gap-3 border-b border-border bg-secondary px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground"
          >
            <div>Run</div>
            <div>Forecasts</div>
            <div>Shortfall</div>
            <div>Calibration</div>
            <div>Snapshot</div>
          </div>
          {#each compareCards as card}
            <button
              class="grid w-full grid-cols-[minmax(0,1.3fr)_84px_112px_118px_118px] items-center gap-3 border-b border-[#f0ede7] px-4 py-2.75 text-left transition last:border-b-0 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              type="button"
              onclick={() => onOpenRun(card.runId)}
        >
              <span class="min-w-0">
                <span class="block truncate text-[12.5px] font-semibold text-foreground">
                  {card.label}
                </span>
                <span class="mt-0.5 block font-mono text-[10px] text-[#a8acb1]">
                  {card.generatedAt}
                </span>
              </span>
              <span
                class="font-mono text-[11px] {card.targetMet ? 'text-primary' : 'text-[#8a6116]'}"
              >
                {card.forecasts}
              </span>
              <span class="truncate font-mono text-[10.5px] text-[#5c6066]"
                >{card.shortfall}</span
              >
              <span class="truncate font-mono text-[10.5px] text-[#5c6066]"
                >{card.calibration}</span
              >
              <span class="truncate font-mono text-[10.5px] text-[#5c6066]">
                {card.snapshotFreshness}
              </span>
            </button>
          {/each}
        </div>
      </div>
    </div>
  {/if}

  <div class="mt-7 flex items-baseline justify-between">
    <h2 class="text-sm font-semibold">Recent runs</h2>
    <span class="text-xs text-muted-foreground">click a card or use j / k</span>
  </div>

  {#if loadingRuns}
    <div class="mt-3 rounded-lg border border-border bg-card p-5 text-sm text-muted-foreground">
      Loading recent runs…
    </div>
  {:else if recentRuns.length === 0}
    <div
      class="mt-3 rounded-lg border border-dashed border-input p-9 text-center text-sm text-muted-foreground"
    >
      No stored runs yet. Queue a job to produce the first run.
    </div>
  {:else}
    <div class="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {#each recentRuns as run}
        <div
          class="block w-full rounded-lg border border-border bg-card px-4 py-3.5 text-left transition hover:border-[#b9c9cc] hover:shadow-[0_1px_4px_rgba(26,28,30,0.06)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <span class="flex items-baseline justify-between gap-2">
            <button
              class="truncate text-left text-[13px] font-semibold text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              type="button"
              onclick={() => onOpenRun(run.runId)}
            >
              {runLabel(run)}
            </button>
            <span class="shrink-0 font-mono text-[10px] text-muted-foreground">
              {formatDateMinute(run.generatedAt)}
            </span>
          </span>
          {#if run.assetClass !== undefined && run.symbol !== undefined}
            <button
              class="mt-2 rounded border border-[#cfe0e3] bg-accent px-1.75 py-0.5 font-mono text-[10px] text-primary hover:border-[#9fc2c8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              type="button"
              onclick={() => onOpenInstrument(run.assetClass ?? "", run.symbol ?? "")}
            >
              {run.assetClass}:{run.symbol}
            </button>
          {/if}
          <span class="mt-2 block font-mono text-[10.5px] text-[#5c6066]">
            {runCountsLabel(run)} · {run.sourceCount} src
          </span>
          <span class="mt-1.5 block truncate font-mono text-[10px] text-[#a8acb1]">
            {run.runId}
          </span>
        </div>
      {/each}
    </div>
  {/if}
</div>
