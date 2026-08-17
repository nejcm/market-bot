<script lang="ts">
  import type { Snippet } from "svelte";
  import type { RunWorkspaceAnalystEstimateDistribution, BindSection, RunWorkspaceSectionKey } from "../run-workspace-view";

  interface Props {
    readonly distributions: readonly RunWorkspaceAnalystEstimateDistribution[];
    readonly sectionKey: RunWorkspaceSectionKey;
    readonly citeChips: Snippet<[readonly string[]]>;
    readonly sectionHeading: Snippet<[string]>;
    readonly bindSection: BindSection;
  }

  let { distributions, sectionKey, citeChips, sectionHeading, bindSection }: Props = $props();
</script>

<section {@attach bindSection(sectionKey)} class="mt-8.5 scroll-mt-5">
  {@render sectionHeading("Analyst estimate distributions")}
  <div class="mt-3.5 grid gap-3">
    {#each distributions as distribution}
      <div class="rounded-lg border border-border bg-card px-4 py-3.5">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <div class="text-[12.5px] font-semibold text-foreground">
            {distribution.title}
          </div>
          {#if distribution.period !== undefined}
            <div class="font-mono text-[10px] text-muted-foreground">
              {distribution.period}
            </div>
          {/if}
        </div>
        <div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {#each [
            ["Mean", distribution.mean],
            ["Median", distribution.median],
            ["High", distribution.high],
            ["Low", distribution.low],
            ["Count", distribution.count],
          ] as metric}
            <div class="rounded-md border border-border bg-secondary px-2.5 py-2">
              <div class="font-mono text-[12px] font-medium text-foreground">
                {metric[1]}
              </div>
              <div class="mt-0.5 text-[9.5px] uppercase tracking-wider text-muted-foreground">
                {metric[0]}
              </div>
            </div>
          {/each}
        </div>
        {@render citeChips(distribution.sourceIds)}
      </div>
    {/each}
  </div>
</section>
