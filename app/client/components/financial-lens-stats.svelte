<script lang="ts">
  import type { RunWorkspaceFinancialLensGroup } from "../run-workspace-view";
  import type { FinancialLensStatTone } from "../view-model";

  interface Props {
    readonly groups: readonly RunWorkspaceFinancialLensGroup[];
    readonly sectionKey: string;
    readonly bindSection: (key: string) => (el: HTMLElement) => void;
  }

  let { groups, sectionKey, bindSection }: Props = $props();

  const FINANCIAL_LENS_TILE_CLASSES: Record<FinancialLensStatTone, string> = {
    strong: "bg-[#dff2e7]",
    healthy: "bg-[#e1f0f2]",
    watch: "bg-[#f7ebcd]",
    weak: "bg-[#f2dfdc]",
    neutral: "bg-secondary",
  };
  const FINANCIAL_LENS_VALUE_CLASSES: Record<FinancialLensStatTone, string> = {
    strong: "text-[#0F7E48]",
    healthy: "text-primary",
    watch: "text-[#8a6116]",
    weak: "text-[#9B0F06]",
    neutral: "text-foreground",
  };
</script>

<section {@attach bindSection(sectionKey)} class="mt-5 scroll-mt-5">
  <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-[#cfe0e3] pb-2">
    <span class="text-[11px] font-semibold uppercase tracking-[0.09em] text-primary">
      Financial Lens stats
    </span>
    <span class="font-mono text-[10px] text-[#8a8f96]"> normalized evidence metrics </span>
  </div>
  <div class="mt-3 space-y-4">
    {#each groups as group}
      <div>
        <div class="flex items-baseline justify-between gap-2">
          <div class="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#353a40]">
            {group.lens}
          </div>
          <div class="font-mono text-[10px] text-[#737980]">
            {group.posture.replaceAll("-", " ")}
          </div>
        </div>
        <div class="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
          {#each group.tiles as tile}
            <div class="px-3 py-2.5 rounded-lg {FINANCIAL_LENS_TILE_CLASSES[tile.tone]}">
              <div class="flex items-start justify-between gap-2">
                <div class="font-mono text-[16px] font-semibold {FINANCIAL_LENS_VALUE_CLASSES[tile.tone]}">
                  {tile.value}
                </div>
                {#if tile.assessment !== undefined}
                  <span
                    class="rounded border border-current uppercase font-medium px-1 py-px font-mono text-[10px] leading-tight {FINANCIAL_LENS_VALUE_CLASSES[
                      tile.tone
                    ]}"
                  >
                    {tile.assessment}
                  </span>
                {/if}
              </div>
              <div class="mt-1 text-[10px] uppercase tracking-wider text-[#5c6066]">
                {tile.label}
              </div>
              {#if tile.caption !== undefined}
                <div class="mt-1 font-mono text-[9px] leading-snug text-[#8a8f96]">
                  {tile.caption}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/each}
  </div>
</section>
