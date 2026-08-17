<script lang="ts">
  import { COMPLETENESS_STATUS_CLASSES } from "../run-workspace-completeness";
  import type {
    RunWorkspaceEquityPresentationView,
    RunWorkspaceGapsView,
    BindSection,
    RunWorkspaceSectionKey,
  } from "../run-workspace-view";

  interface Props {
    readonly gaps: Pick<RunWorkspaceGapsView, "shortfalls" | "triagedGaps">;
    readonly uppercaseTriage: boolean;
    readonly financialCoreStatus: RunWorkspaceEquityPresentationView["defaultView"]["financialCoreStatus"];
    readonly sectionKey: RunWorkspaceSectionKey;
    readonly bindSection: BindSection;
  }

  let { gaps, uppercaseTriage, financialCoreStatus, sectionKey, bindSection }: Props = $props();
</script>

<section {@attach bindSection(sectionKey)} class="mt-8.5 scroll-mt-5">
  {#if uppercaseTriage}
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
    {#if !gaps.triagedGaps.some((gap) => gap.triage === "material")}
      <div class="mt-3 text-sm text-muted-foreground">No material gaps identified.</div>
    {/if}
  {/if}

  {#if gaps.shortfalls.length > 0}
    <div
      class="border-b border-[#e9ddc2] pb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-[#8a6116]"
    >
      Prediction shortfall
    </div>
    <div class="mt-3.5 flex flex-col gap-2.5">
      {#each gaps.shortfalls as gap}
        <div class="flex gap-3 rounded-lg border border-dashed border-[#d9c89a] bg-[#fbf6ea] px-4 py-3">
          <span
            class="h-fit shrink-0 rounded border border-[#d9c89a] bg-[#f5ecd6] px-1.5 py-px font-mono text-[10px] text-[#8a6116]"
          >
            SHORTFALL
          </span>
          <div class="min-w-0 font-serif text-sm leading-[1.55] text-[#4a4334]">
            {gap}
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if gaps.triagedGaps.length > 0}
    <div
      class="border-b border-[#e9ddc2] pb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-[#8a6116] {gaps
        .shortfalls.length > 0
        ? 'mt-8'
        : ''}"
    >
      Data gaps · what we could not verify
    </div>
    <div class="mt-3.5 flex flex-col gap-2.5">
      {#each gaps.triagedGaps as gap}
        <div class="flex gap-3 rounded-lg border border-dashed border-[#d9c89a] bg-[#fbf6ea] px-4 py-3">
          <span
            class="h-fit shrink-0 rounded border border-[#d9c89a] bg-[#f5ecd6] px-1.5 py-px font-mono text-[10px] text-[#8a6116]"
          >
            {uppercaseTriage ? gap.triage.toUpperCase() : gap.triage}
          </span>
          <div class="min-w-0 font-serif text-sm leading-[1.55] text-[#4a4334]">
            {gap.text}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</section>
