<script lang="ts">
  import { COMPLETENESS_STATUS_CLASSES } from "../run-workspace-completeness";
  import type { RunWorkspaceEquityPresentationView, BindSection, RunWorkspaceSectionKey } from "../run-workspace-view";

  interface Props {
    readonly materialGaps: readonly string[];
    readonly financialCoreStatus: RunWorkspaceEquityPresentationView["defaultView"]["financialCoreStatus"];
    readonly sectionKey: RunWorkspaceSectionKey;
    readonly bindSection: BindSection;
  }

  let { materialGaps, financialCoreStatus, sectionKey, bindSection }: Props = $props();
</script>

<section {@attach bindSection(sectionKey)} class="mt-8.5 scroll-mt-5">
  <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-[#e9ddc2] pb-2">
    <span class="text-[11px] font-semibold uppercase tracking-[0.09em] text-[#8a6116]">
      Coverage & material gaps
    </span>
    {#if financialCoreStatus !== undefined}
      <div class="flex flex-wrap gap-2">
        <span
          class="rounded border px-2 py-1 font-mono text-[10px] {COMPLETENESS_STATUS_CLASSES[
            financialCoreStatus
          ]}"
        >
          financial core · {financialCoreStatus}
        </span>
      </div>
    {/if}
  </div>
  {#if materialGaps.length === 0}
    <div class="mt-3 text-sm text-muted-foreground">No material gaps identified.</div>
  {:else}
    <div class="mt-3.5 flex flex-col gap-2.5">
      {#each materialGaps as gap}
        <div class="flex gap-3 rounded-lg border border-dashed border-[#d9c89a] bg-[#fbf6ea] px-4 py-3">
          <span class="h-fit shrink-0 rounded border border-[#d9c89a] bg-[#f5ecd6] px-1.5 py-px font-mono text-[10px] text-[#8a6116]">
            MATERIAL
          </span>
          <div class="min-w-0 font-serif text-sm leading-[1.55] text-[#4a4334]">{gap}</div>
        </div>
      {/each}
    </div>
  {/if}
</section>
