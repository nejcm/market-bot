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
    <ol class="mt-3.5 divide-y divide-[#efe5cf] border border-[#e9ddc2] border-l-2 border-l-[#d9a95a] bg-[#fbf6ea]">
      {#each materialGaps as gap, index}
        <li class="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-3.5 px-4 py-2.75">
          <span class="font-mono text-[10.5px] text-[#b89a5e]">{String(index + 1).padStart(2, "0")}</span>
          <div class="font-serif text-sm leading-[1.55] text-[#4a4334]">{gap}</div>
        </li>
      {/each}
    </ol>
  {/if}
</section>
