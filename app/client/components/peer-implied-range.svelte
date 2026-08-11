<script lang="ts">
  import type { RunWorkspacePeerImpliedRangeView } from "../run-workspace-view";
  import RangeBar from "./range-bar.svelte";

  interface Props {
    readonly range: RunWorkspacePeerImpliedRangeView;
    readonly sectionKey: string;
    readonly bindSection: (key: string) => (el: HTMLElement) => void;
  }

  let { range: peerImpliedRange, sectionKey, bindSection }: Props = $props();
</script>

<section {@attach bindSection(sectionKey)} class="mt-8.5 scroll-mt-5">
  {#if peerImpliedRange.status === "suppressed"}
    <div class="rounded-lg border border-border bg-secondary px-4 py-3.5">
      <div class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {peerImpliedRange.label}
      </div>
      <div class="mt-1.5 text-sm text-muted-foreground">
        {peerImpliedRange.message}
      </div>
    </div>
  {:else}
    <div class="rounded-lg border border-border bg-card px-4 py-3.5">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <div class="text-[10px] font-semibold uppercase tracking-wider text-[#5c6066]">
          {peerImpliedRange.label}
        </div>
        <div class="font-mono text-[10px] text-primary">
          {peerImpliedRange.positionLabel}
        </div>
      </div>
      <div class="mt-2.5">
        <RangeBar
          geometry={peerImpliedRange.geometry}
          label={peerImpliedRange.label}
          lowLabel={peerImpliedRange.lowLabel}
          midLabel={peerImpliedRange.midLabel}
          highLabel={peerImpliedRange.highLabel}
          currentLabel={peerImpliedRange.currentLabel}
        />
      </div>
      <div class="mt-2 font-mono text-[9px] leading-relaxed text-[#737980]">
        {peerImpliedRange.methodDisclosure}
      </div>
      <div class="mt-0.5 font-mono text-[9px] leading-relaxed text-[#8a8f96]">
        {peerImpliedRange.boundaryDisclosure}
      </div>
    </div>
  {/if}
</section>
