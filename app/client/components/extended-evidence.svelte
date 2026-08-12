<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ExtendedEvidenceItemView } from "../../report-artifact-view";
  import { valuationMetricTiles } from "../view-model";

  interface Props {
    readonly items: readonly ExtendedEvidenceItemView[];
    readonly sectionKey: string;
    readonly citeChips: Snippet<[readonly string[]]>;
    readonly sectionHeading: Snippet<[string]>;
    readonly bindSection: (key: string) => (el: HTMLElement) => void;
  }

  let { items, sectionKey, citeChips, sectionHeading, bindSection }: Props = $props();
</script>

<section {@attach bindSection(sectionKey)} class="mt-8.5 scroll-mt-5">
  {@render sectionHeading("Extended evidence")}
  <div class="mt-3.5 grid gap-3 sm:grid-cols-2">
    {#each items as item}
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
