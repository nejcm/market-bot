<script lang="ts">
  import type { Snippet } from "svelte";
  import type { MetricSectionView } from "../view-model-metric-sections";
  import type { BindSection } from "../run-workspace-view";

  interface Props {
    readonly sections: readonly MetricSectionView[];
    readonly citeChips: Snippet<[readonly string[]]>;
    readonly bindSection: BindSection;
  }

  let { sections, citeChips, bindSection }: Props = $props();
</script>

<section {@attach bindSection("metricSections")} class="mt-8.5 scroll-mt-5">
  <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-[#cfe0e3] pb-2">
    <h2 class="text-[11px] font-semibold uppercase tracking-[0.09em] text-primary">
      Metric sections
    </h2>
    <span class="font-mono text-[10px] text-[#8a8f96]">deterministic · filed data</span>
  </div>
  {#each sections as section}
    <h3 class="mt-3.5 text-[12.5px] font-semibold text-foreground">{section.title}</h3>
    <ul class="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {#each section.metrics as metric}
        <li class="rounded-md border border-border bg-secondary px-2.5 py-2">
          <div class="text-[9.5px] uppercase tracking-wider text-muted-foreground">
            {metric.label}
          </div>
          {#if metric.value !== undefined}
            <div class="mt-0.5 font-mono text-[12px] font-medium text-foreground">
              {metric.value}
            </div>
            {#if metric.periodEnd !== undefined}
              <div class="mt-1 font-mono text-[10px] text-[#8a8f96]">FY ending {metric.periodEnd}</div>
            {/if}
            {#if metric.basis !== undefined}
              <div class="mt-1 text-[11px] leading-normal text-[#5c6066]">{metric.basis}</div>
            {/if}
            {@render citeChips(metric.sourceIds)}
          {:else}
            <div class="mt-0.5 font-mono text-[12px] text-[#8a6116]">
              {metric.status === "value" ? "not available" : metric.status.replaceAll("-", " ")}
            </div>
            <div class="mt-1 font-mono text-[10px] leading-normal text-[#8a6116]">
              {metric.reason}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/each}
</section>
