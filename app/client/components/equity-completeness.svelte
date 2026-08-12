<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    completenessReasonCodeLabel,
    type RunWorkspaceEquityPresentationView,
  } from "../run-workspace-view";
  import { COMPLETENESS_STATUS_CLASSES } from "../run-workspace-completeness";

  interface Props {
    readonly completeness: NonNullable<
      RunWorkspaceEquityPresentationView["advanced"]["completeness"]
    >;
    readonly sectionKey: string;
    readonly citeChips: Snippet<[readonly string[]]>;
    readonly bindSection: (key: string) => (el: HTMLElement) => void;
  }

  let { completeness, sectionKey, citeChips, bindSection }: Props = $props();
</script>

<section {@attach bindSection(sectionKey)} class="mt-5 scroll-mt-5">
  <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-[#cfe0e3] pb-2">
    <span class="text-[11px] font-semibold uppercase tracking-[0.09em] text-primary">
      Completeness diagnostics
    </span>
    <span class="font-mono text-[10px] text-[#8a8f96]">
      as of {completeness.asOf}
    </span>
  </div>
  <div class="mt-3 flex flex-wrap gap-2 font-mono text-[10px]">
    <span class="rounded border border-border bg-secondary px-2 py-1 text-foreground">
      coverage · {completeness.coverageLevel}
    </span>
  </div>
  <div class="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
    {#each completeness.dimensions as dimension}
      <div class="rounded-lg border border-border bg-card px-3 py-2.5">
        <div class="flex items-start justify-between gap-2">
          <div class="text-[10px] font-semibold uppercase tracking-wider text-[#5c6066]">
            {dimension.label}
          </div>
          <span class="rounded border px-1.5 py-0.5 font-mono text-[9px] {COMPLETENESS_STATUS_CLASSES[dimension.status]}">
            {dimension.status.replaceAll("-", " ")}
          </span>
        </div>
        {#if dimension.reasonCodes.length > 0}
          <div class="mt-2 space-y-0.5 text-[10px] leading-snug text-muted-foreground">
            {#each dimension.reasonCodes as reason}
              <div>{completenessReasonCodeLabel(reason)}</div>
            {/each}
          </div>
        {/if}
        <div class="mt-2 font-mono text-[9px] leading-snug text-[#8a8f96]">
          {dimension.asOf}
        </div>
        {#if dimension.sourceIds.length > 0}
          <div class="mt-1 flex flex-wrap gap-y-1">
            {@render citeChips(dimension.sourceIds)}
          </div>
        {/if}
      </div>
    {/each}
  </div>
</section>
