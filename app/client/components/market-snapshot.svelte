<script lang="ts">
  import type { SnapshotView } from "../view-model";
  import type { RunWorkspaceSectionKey } from "../run-workspace-view";
  import PriceSnapshotChart from "./price-snapshot-chart.svelte";

  interface Props {
    readonly snapshot: SnapshotView;
    readonly snapshotTradingViewUrl?: string | undefined;
    readonly forecastHorizons: readonly number[];
    readonly sectionKey: RunWorkspaceSectionKey;
    readonly bindSection: (key: RunWorkspaceSectionKey) => (el: HTMLElement) => void;
  }

  let {
    snapshot,
    snapshotTradingViewUrl,
    forecastHorizons,
    sectionKey,
    bindSection,
  }: Props = $props();
</script>

<section {@attach bindSection(sectionKey)} class="mt-8.5 scroll-mt-5">
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
