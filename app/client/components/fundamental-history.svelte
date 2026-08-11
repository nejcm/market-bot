<script lang="ts">
  import type { RunWorkspaceFundamentalHistoryView } from "../run-workspace-view";
  import SparklineBars from "./sparkline-bars.svelte";

  interface Props {
    readonly history: RunWorkspaceFundamentalHistoryView;
    readonly sectionKey: string;
    readonly bindSection: (key: string) => (el: HTMLElement) => void;
  }

  let { history, sectionKey, bindSection }: Props = $props();
</script>

<section {@attach bindSection(sectionKey)} class="mt-8.5 scroll-mt-5">
  <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-2">
    <span class="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
      Fundamental history
    </span>
    <span class="font-mono text-[10px] text-[#8a8f96]"> normalized SEC fiscal history </span>
  </div>
  <div class="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
    {#each history.cards as card}
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
