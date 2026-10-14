<script lang="ts">
  import type { RunTrendPoint } from "../view-model";

  interface Props {
    readonly points: readonly RunTrendPoint[];
  }

  let { points }: Props = $props();

  let chartWidth = $state(0);

  const maxRuns = $derived(Math.max(1, ...points.map((point) => point.runs)));
  const labelStep = $derived(Math.max(1, Math.ceil((points.length * 44) / Math.max(1, chartWidth))));
</script>

{#if points.length === 0}
  <div class="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
    No dated runs yet.
  </div>
{:else}
  <div class="mt-3 flex h-[220px] flex-col" role="img" aria-label="Runs per day" bind:clientWidth={chartWidth}>
    <div
      class="relative flex min-h-0 flex-1 items-end gap-1.5 border-b border-border pt-6 sm:gap-2"
    >
      <div class="pointer-events-none absolute inset-x-0 top-6 border-t border-border/40"></div>
      <div class="pointer-events-none absolute inset-x-0 top-[calc(50%+12px)] border-t border-border/60"></div>
      {#each points as point, index}
        {@const isLatest = index === points.length - 1}
        <div
          class="group relative flex h-full min-w-0 flex-1 flex-col items-center justify-end"
          title="{point.runs} runs on {point.date}"
        >
          <div
            class="relative w-full max-w-12 rounded-t-[3px] transition-colors {isLatest
              ? 'bg-[#4ba3b2]'
              : 'bg-[#d7e6e8] group-hover:bg-[#bcd7db]'}"
            style:height="{Math.max(1, (point.runs / maxRuns) * 100)}%"
          >
            <span
              class="absolute inset-x-0 -top-5 text-center font-mono text-[10.5px] {isLatest
                ? 'text-foreground'
                : 'text-muted-foreground'}">{point.runs}</span
            >
          </div>
        </div>
      {/each}
    </div>
    <div class="flex gap-1.5 pt-2 sm:gap-2">
      {#each points as point, index}
        <span class="min-w-0 flex-1 overflow-visible whitespace-nowrap text-center font-mono text-[10px] text-muted-foreground"
          >{(points.length - 1 - index) % labelStep === 0 ? point.date.slice(5) : ""}</span
        >
      {/each}
    </div>
  </div>
{/if}
