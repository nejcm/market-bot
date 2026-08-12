<script lang="ts">
  import type { Snippet } from "svelte";
  import type {
    RunWorkspaceEquitySnapshotFinancialLensDrivers,
    RunWorkspaceEquitySnapshotKeyMetrics,
    RunWorkspaceEquitySnapshotMiniCharts,
  } from "../run-workspace-view";
  import SparklineBars from "./sparkline-bars.svelte";

  interface Props {
    readonly keyDatedMetrics: RunWorkspaceEquitySnapshotKeyMetrics;
    readonly miniCharts: RunWorkspaceEquitySnapshotMiniCharts;
    readonly financialLensDrivers: RunWorkspaceEquitySnapshotFinancialLensDrivers;
    readonly sectionKey: string;
    readonly citeChips: Snippet<[readonly string[]]>;
    readonly bindSection: (key: string) => (el: HTMLElement) => void;
  }

  let {
    keyDatedMetrics,
    miniCharts,
    financialLensDrivers,
    sectionKey,
    citeChips,
    bindSection,
  }: Props = $props();
</script>

<section {@attach bindSection(sectionKey)} class="mt-5 scroll-mt-5">
  <div class="border-b border-[#cfe0e3] pb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-primary">
    Detailed equity metrics
  </div>
  <div class="mt-3 rounded-lg border border-border bg-card px-3.5 py-3">
    <div class="text-[10px] font-semibold uppercase tracking-wider text-[#5c6066]">
      {keyDatedMetrics.label}
    </div>
    <div class="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
      {#each [...keyDatedMetrics.metrics, ...keyDatedMetrics.foldedYahooMetrics] as metric}
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
      {miniCharts.label}
    </div>
    <div class="mt-2 grid grid-cols-2 gap-2 xl:grid-cols-4">
      {#each miniCharts.charts as chart}
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
      {financialLensDrivers.label}
    </div>
    <div class="mt-2 grid gap-2 sm:grid-cols-3">
      <div class="rounded border border-border bg-secondary px-2.5 py-2">
        <div class="text-[9px] font-semibold uppercase tracking-wider">
          {financialLensDrivers.postures.label}
        </div>
        <div class="mt-2 space-y-1.5">
          {#each financialLensDrivers.postures.items as posture}
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
      {#each [financialLensDrivers.bullCase, financialLensDrivers.bearCase] as driverCard}
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
