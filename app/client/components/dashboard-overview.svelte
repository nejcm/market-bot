<script lang="ts">
  import {
    formatDateMinute,
    runCountsLabel,
    runLabel,
    type DashboardMetrics,
    type RunTrendPoint,
  } from "../view-model";
  import type { RunSummary } from "../../types";
  import RunTrendChart from "./run-trend-chart.svelte";

  interface Props {
    readonly metrics: DashboardMetrics;
    readonly trend: readonly RunTrendPoint[];
    readonly recentRuns: readonly RunSummary[];
    readonly loadingRuns: boolean;
    readonly onOpenRun: (runId: string) => void;
  }

  let { metrics, trend, recentRuns, loadingRuns, onOpenRun }: Props = $props();

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
        <button
          class="block w-full rounded-lg border border-border bg-card px-4 py-3.5 text-left transition hover:border-[#b9c9cc] hover:shadow-[0_1px_4px_rgba(26,28,30,0.06)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          type="button"
          onclick={() => onOpenRun(run.runId)}
        >
          <span class="flex items-baseline justify-between gap-2">
            <span class="truncate text-[13px] font-semibold text-foreground">{runLabel(run)}</span>
            <span class="shrink-0 font-mono text-[10px] text-muted-foreground">
              {formatDateMinute(run.generatedAt)}
            </span>
          </span>
          <span class="mt-2 block font-mono text-[10.5px] text-[#5c6066]">
            {runCountsLabel(run)} · {run.sourceCount} src
          </span>
          <span class="mt-1.5 block truncate font-mono text-[10px] text-[#a8acb1]">
            {run.runId}
          </span>
        </button>
      {/each}
    </div>
  {/if}
</div>
